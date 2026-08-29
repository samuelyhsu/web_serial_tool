// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { StreamingUtf8Decoder } from '@/core/codec/text';
import { SerialSession } from '@/core/session/serialSession';
import type { ConnectionOptions } from '@/core/transport/types';
import { NodeSerialTransport, type NodePortHandle } from './nodeSerialTransport';
import { openNodePort } from './serialPortBinding';

/**
 * 真实串口回环测试。
 *
 * 需要一对能互通的串口（虚拟串口对如 com0com / HHD Bridge，或两个 USB 转串口用
 * 交叉线对接），通过环境变量显式开启：
 *
 * ```bash
 * SERIAL_LOOPBACK_PORTS=COM1,COM2 npm run test:hardware
 * ```
 *
 * **不做自动探测**是有意的：自动去开机器上的串口，很可能打断别人正在调试的设备。
 * 这类测试的启用必须是一个明确的动作。
 *
 * 它覆盖的是前面几档全都覆盖不到的东西：真实驱动的分块时序、真实波特率下的背压、
 * 操作系统层面的端口占用与释放。README 的人工验收清单里有好几条就是被它接管的。
 */

const PORTS = (process.env.SERIAL_LOOPBACK_PORTS ?? '').split(',').filter(Boolean);
const [RX_PATH, TX_PATH] = PORTS;
const enabled = PORTS.length === 2;

function options(baudRate = 115200): ConnectionOptions {
  return { baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Link {
  session: SerialSession<string>;
  transport: NodeSerialTransport;
  /** 收到的帧，按分帧规则切好。 */
  frames: Uint8Array[];
  notices: string[];
  close: () => Promise<void>;
}

/** 接收侧：走我们自己的整条栈（传输层 → 会话 → 分帧）。 */
async function openLink(path: string, baudRate = 115200): Promise<Link> {
  const transport = new NodeSerialTransport(path, openNodePort);
  const frames: Uint8Array[] = [];
  const notices: string[] = [];

  const session = new SerialSession<string>({
    createTransport: () => transport,
    resolvePort: (key) => Promise.resolve(key),
    describeConfig: () => path,
  });
  session.setHandlers({
    onFrame: (direction, bytes) => {
      if (direction === 'rx') frames.push(bytes);
    },
    onNotice: (notice) => notices.push(notice.code),
    onThroughput: () => undefined,
    onStateChange: () => undefined,
  });

  await session.open(path, path, options(baudRate));
  return { session, transport, frames, notices, close: () => session.close() };
}

/** 发送侧：一个朴素的对端，不参与被测逻辑。 */
async function openPeer(path: string, baudRate = 115200): Promise<NodePortHandle> {
  return openNodePort(path, options(baudRate));
}

function write(peer: NodePortHandle, data: Uint8Array | string): Promise<void> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Promise((resolve, reject) => {
    peer.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  // 驱动释放端口需要一点时间，下一个用例才不会撞上 Access denied
  await wait(100);
});

describe.skipIf(!enabled)('真实串口回环', () => {
  it('发出去的字节对端真的收得到', async () => {
    const link = await openLink(RX_PATH!);
    const peer = await openPeer(TX_PATH!);
    cleanup.push(link.close, () => new Promise((r) => peer.close(() => r())));

    await write(peer, 'hello');
    await wait(200);

    const received = Buffer.concat(link.frames.map((frame) => Buffer.from(frame))).toString();
    expect(received).toBe('hello');
  });

  /**
   * 中文被驱动切在多字节字符中间时不能乱码。
   * 这条在假传输层上测过，但真实驱动的切分点是它自己决定的 —— 值得在真机上再确认一次。
   */
  it('跨块到达的 UTF-8 中文能正确还原', async () => {
    const link = await openLink(RX_PATH!);
    const peer = await openPeer(TX_PATH!);
    cleanup.push(link.close, () => new Promise((r) => peer.close(() => r())));

    const text = '温度25.5℃，湿度60%，状态正常';
    const bytes = new TextEncoder().encode(text);
    // 故意切在一个汉字中间
    await write(peer, bytes.slice(0, 5));
    await wait(50);
    await write(peer, bytes.slice(5));
    await wait(300);

    const decoder = new StreamingUtf8Decoder();
    const decoded = link.frames.map((frame) => decoder.decode(frame)).join('');
    expect(decoded).toBe(text);
  });

  /**
   * 空闲分帧靠的是「多久没来数据算一帧结束」，而真实驱动什么时候交付数据由它自己决定。
   * 这是假定时器永远替代不了的一条。
   */
  it('空闲分帧：中间停顿会切成两帧，连着发则并成一帧', async () => {
    const link = await openLink(RX_PATH!);
    const peer = await openPeer(TX_PATH!);
    cleanup.push(link.close, () => new Promise((r) => peer.close(() => r())));
    link.session.setFraming({ mode: 'idle', idleMs: 60 });

    await write(peer, 'AAA');
    await wait(200); // 远超空闲阈值
    await write(peer, 'BBB');
    await wait(300);

    const texts = link.frames.map((frame) => Buffer.from(frame).toString());
    expect(texts).toEqual(['AAA', 'BBB']);
  });

  it('按行分帧：换行处切开，行尾保留', async () => {
    const link = await openLink(RX_PATH!);
    const peer = await openPeer(TX_PATH!);
    cleanup.push(link.close, () => new Promise((r) => peer.close(() => r())));
    link.session.setFraming({ mode: 'line' });

    await write(peer, 'first\r\nsec');
    await wait(150);
    await write(peer, 'ond\nthird');
    await wait(300);

    const texts = link.frames.map((frame) => Buffer.from(frame).toString());
    // 最后一行没有换行符，还留在缓冲里
    expect(texts).toEqual(['first\r\n', 'second\n']);
  });

  /**
   * 背压：波特率压到 9600，写得比线路快得多，队列会涨到上限后拒绝本次写入。
   *
   * 这条**依赖驱动真的按波特率限速**。不少虚拟串口对（本机这对 HHD Bridge 就是）
   * 无论设成多少波特率都瞬间收下全部数据 —— 那种口上永远撞不到背压，
   * 硬测只会得到一条假绿。所以先花一次写入探一下，不限速就跳过并说明原因。
   *
   * 顺带记一笔：Node 侧的 `pendingBytes` 量的是**我们自己队列里**积压的字节。
   * 驱动把数据收进操作系统缓冲就回调，所以真正的线路拥塞要等操作系统缓冲也满了
   * 才会传导过来。浏览器那侧靠 WritableStream 的背压信号，更贴近线路实际。
   */
  it('写得比线路快时触发背压，而不是无限积压', async (ctx) => {
    const probe = await openPeer(RX_PATH!, 9600);
    const sample = new Uint8Array(2048).fill(0x55);
    const started = Date.now();
    await write(probe, sample);
    const elapsed = Date.now() - started;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await wait(100);

    // 2048 字节 @9600 理论上要 2 秒出头，快得离谱就说明这对口不限速
    if (elapsed < 300) {
      ctx.skip();
      return;
    }

    const link = await openLink(RX_PATH!, 9600);
    cleanup.push(link.close);

    const chunk = new Uint8Array(1024).fill(0x55);
    let rejected: unknown = null;
    // 高水位是 64KB，用远超它的量去撞
    for (let i = 0; i < 200 && rejected === null; i += 1) {
      link.session.send(chunk).catch((error: unknown) => {
        rejected ??= error;
      });
      await wait(0);
    }
    await wait(100);

    expect(rejected).not.toBeNull();
    expect(String(rejected)).toMatch(/queue is full/i);
  });

  it('高速接收：8KB 数据完整且顺序不乱', async () => {
    const link = await openLink(RX_PATH!);
    const peer = await openPeer(TX_PATH!);
    cleanup.push(link.close, () => new Promise((r) => peer.close(() => r())));

    const payload = new Uint8Array(8 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff;

    await write(peer, payload);
    // 8KB @115200 大约 700ms，留足余量
    await wait(2500);

    const received = Buffer.concat(link.frames.map((frame) => Buffer.from(frame)));
    expect(received.length).toBe(payload.length);
    expect(Buffer.from(payload).equals(received)).toBe(true);
  });

  /**
   * 关闭之后端口必须真的还给操作系统。
   * 这正是集成测试抓到的那个 bug 的最小复现：dispose 只断引用不关传输层时，
   * 这里会拿到 Access denied。
   */
  it('关闭后端口立刻可以再打开', async () => {
    const first = await openLink(RX_PATH!);
    await first.close();

    const second = await openLink(RX_PATH!);
    cleanup.push(second.close);
    expect(second.transport.state).toBe('open');
  });

  it('dispose 同样会把端口还回去', async () => {
    const first = await openLink(RX_PATH!);
    first.session.dispose();
    await wait(200);

    const second = await openLink(RX_PATH!);
    cleanup.push(second.close);
    expect(second.transport.state).toBe('open');
  });

  it('同一个端口不能被打开两次 —— 操作系统层面的独占', async () => {
    const link = await openLink(RX_PATH!);
    cleanup.push(link.close);

    await expect(openLink(RX_PATH!)).rejects.toThrow(/denied|busy|failed/i);
  });
});
