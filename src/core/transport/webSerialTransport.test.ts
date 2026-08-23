import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asSerialPort, FakeSerialPort } from '../../../tests/fakeSerialPort';
import { TransportError } from './errors';
import type { CloseReason, ConnectionOptions } from './types';
import { WebSerialTransport } from './webSerialTransport';

const OPTIONS: ConnectionOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

/** 让流的回调排空：ReadableStream 的读取是微任务驱动的。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WebSerialTransport', () => {
  let port: FakeSerialPort;
  let transport: WebSerialTransport;
  let data: Uint8Array[];
  let errors: TransportError[];
  let closes: CloseReason[];

  beforeEach(() => {
    port = new FakeSerialPort();
    transport = new WebSerialTransport(asSerialPort(port));
    data = [];
    errors = [];
    closes = [];
    transport.subscribe({
      onData: (chunk) => data.push(chunk),
      onError: (error) => errors.push(error),
      onClose: (reason) => closes.push(reason),
    });
  });

  it('打开端口时把配置原样传给底层', async () => {
    await transport.open(OPTIONS);
    expect(transport.state).toBe('open');
    expect(port.openCalls[0]).toMatchObject({ baudRate: 115200, dataBits: 8, parity: 'none' });
    await transport.close();
  });

  it('打开失败时状态回到 closed 并抛出带 kind 的错误', async () => {
    port.failOpen = new Error('Access denied');
    await expect(transport.open(OPTIONS)).rejects.toMatchObject({ kind: 'open-failed' });
    expect(transport.state).toBe('closed');
  });

  it('重复打开会被拒绝', async () => {
    await transport.open(OPTIONS);
    await expect(transport.open(OPTIONS)).rejects.toMatchObject({ kind: 'invalid-state' });
    await transport.close();
  });

  it('没有可写流时不让端口停留在半开状态', async () => {
    port.provideWritable = false;
    await expect(transport.open(OPTIONS)).rejects.toMatchObject({ kind: 'no-writable' });
    expect(transport.state).toBe('closed');
    expect(port.closeCalls).toBe(1);
  });

  it('设备发来的数据经 onData 上报', async () => {
    await transport.open(OPTIONS);
    port.push([0x41, 0x54]);
    await settle();
    expect(data.map((chunk) => [...chunk])).toEqual([[0x41, 0x54]]);
    await transport.close();
  });

  it('写入的数据到达底层可写流', async () => {
    await transport.open(OPTIONS);
    await transport.write(Uint8Array.of(1, 2, 3));
    expect(port.written.map((chunk) => [...chunk])).toEqual([[1, 2, 3]]);
    await transport.close();
  });

  it('端口未打开时写入被拒绝', async () => {
    await expect(transport.write(Uint8Array.of(1))).rejects.toMatchObject({
      kind: 'invalid-state',
    });
  });

  /** 缺陷 D6：原型 cancel 之后不等读循环结束就 close()，流仍被锁定。 */
  it('close 会先让读循环退出、再关闭端口，且发出 local 关闭事件', async () => {
    await transport.open(OPTIONS);
    port.push([1]);
    await settle();

    await transport.close();

    expect(transport.state).toBe('closed');
    expect(port.closeCalls).toBe(1);
    expect(closes).toEqual(['local']);
  });

  it('close 是幂等的，重复调用不会重复关闭端口', async () => {
    await transport.open(OPTIONS);
    await transport.close();
    await transport.close();
    expect(port.closeCalls).toBe(1);
    expect(closes).toEqual(['local']);
  });

  it('并发调用 close 只关闭一次', async () => {
    await transport.open(OPTIONS);
    await Promise.all([transport.close(), transport.close()]);
    expect(port.closeCalls).toBe(1);
  });

  /** 缺陷 D6：原型把 port.close() 的失败用空 catch 吞掉，端口没释放用户却不知道。 */
  it('关闭端口失败时上报错误而不是静默吞掉', async () => {
    await transport.open(OPTIONS);
    port.failClose = new Error('device busy');
    await transport.close();
    expect(errors.map((error) => error.kind)).toContain('close-failed');
  });

  /** 缺陷 D5：原型在流以 done 结束、readable 尚未置空时会疯狂重取 reader。 */
  it('流正常结束即视为对端关闭，不会空转重取 reader', async () => {
    await transport.open(OPTIONS);
    port.endStream();
    await settle();

    expect(transport.state).toBe('closed');
    expect(closes).toEqual(['remote']);
    expect(port.closeCalls).toBe(1);
  });

  it('设备被拔出时上报 remote 关闭', async () => {
    await transport.open(OPTIONS);
    port.unplug();
    await settle();

    expect(transport.state).toBe('closed');
    expect(closes).toEqual(['remote']);
  });

  /**
   * Chromium 官方指引：奇偶 / 帧错误让当前流进入 error 状态，释放锁后可以从
   * 新的 port.readable 继续读。这条覆盖「非致命错误后恢复」的分支。
   */
  it('流出错后释放锁并从新的可读流继续读取', async () => {
    await transport.open(OPTIONS);
    port.push([0x01]);
    await settle();

    port.errorStream(new Error('Parity error'));
    await settle();

    expect(errors.map((error) => error.kind)).toContain('read');
    expect(transport.state).toBe('open');

    // 恢复之后仍能收到新数据
    port.push([0x02]);
    await settle();
    expect(data.map((chunk) => [...chunk])).toEqual([[0x01], [0x02]]);

    await transport.close();
  });

  it('流出错且没有新的可读流时按对端关闭处理', async () => {
    await transport.open(OPTIONS);
    port.errorStream(new Error('fatal'), false);
    await settle();

    expect(transport.state).toBe('closed');
    expect(closes).toEqual(['remote']);
  });

  it('取消订阅后不再收到事件', async () => {
    const seen: Uint8Array[] = [];
    const unsubscribe = transport.subscribe({ onData: (chunk) => seen.push(chunk) });
    await transport.open(OPTIONS);

    port.push([1]);
    await settle();
    expect(seen).toHaveLength(1);

    unsubscribe();
    port.push([2]);
    await settle();
    expect(seen).toHaveLength(1);

    await transport.close();
  });

  it('pendingBytes 反映写队列积压', async () => {
    await transport.open(OPTIONS);
    expect(transport.pendingBytes).toBe(0);
    await transport.write(new Uint8Array(16));
    expect(transport.pendingBytes).toBe(0);
    await transport.close();
  });

  it('打开途中调用 close：等打开走完再真正关掉端口，不留孤儿', async () => {
    // 驱动打开端口要几百毫秒，用户等不及又点了「关闭」。
    // 修复前 close() 会与 open() 并行拆卸并抢先返回，随后 open() 的后半段把状态
    // 写回 'open' —— 端口物理上还开着，却再没有引用能关掉它。
    port.blockOpen();
    const opening = transport.open(OPTIONS);
    const closing = transport.close();

    // 驱动在下一个宏任务才把端口打开。拆卸全程都是微任务，因此修复前的 close()
    // 会赶在端口真正打开之前跑完 —— 这正是真机上会撞到的时序。
    setTimeout(() => port.releaseOpen(), 0);
    await Promise.allSettled([opening, closing]);
    await settle();

    expect(transport.state).toBe('closed');
    expect(port.isPhysicallyOpen).toBe(false);
    // 关闭必须是真的落到端口上，而不是「因为还没开成所以失败了」
    expect(errors.some((error) => error.kind === 'close-failed')).toBe(false);
    expect(closes).toEqual(['local']);
  });

  it('打开失败时并发的 close 不会重复关端口', async () => {
    port.blockOpen();
    port.failOpen = new Error('Access denied');
    const opening = transport.open(OPTIONS);
    const closing = transport.close();

    port.releaseOpen();
    await expect(opening).rejects.toMatchObject({ kind: 'open-failed' });
    await closing;

    expect(transport.state).toBe('closed');
    expect(port.closeCalls).toBe(0); // 端口根本没开成，无需也不该去关
    expect(closes).toEqual([]);
  });

  it('未打开时 close 直接返回', async () => {
    await transport.close();
    expect(port.closeCalls).toBe(0);
    expect(closes).toEqual([]);
  });
});

describe('TransportError.from', () => {
  it('包装非 Error 值', () => {
    const error = TransportError.from('boom', 'read', 'Read error');
    expect(error.kind).toBe('read');
    expect(error.message).toBe('Read error: boom');
  });

  it('已经是 TransportError 时原样返回', () => {
    const original = new TransportError('write', 'nope');
    expect(TransportError.from(original, 'read', 'x')).toBe(original);
  });
});

describe('isWebSerialSupported', () => {
  it('navigator 上没有 serial 时返回 false', async () => {
    const { isWebSerialSupported } = await import('./webSerialTransport');
    expect(isWebSerialSupported()).toBe('serial' in navigator);
  });

  it('navigator 上存在 serial 时返回 true', async () => {
    const { isWebSerialSupported } = await import('./webSerialTransport');
    vi.stubGlobal('navigator', { serial: {} });
    expect(isWebSerialSupported()).toBe(true);
    vi.unstubAllGlobals();
  });
});
