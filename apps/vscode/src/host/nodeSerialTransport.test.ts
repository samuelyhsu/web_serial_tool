import { describe, expect, it, vi } from 'vitest';
import type { ConnectionOptions } from '@/core/transport/types';
import { NodeSerialTransport, type NodePortHandle } from './nodeSerialTransport';

const OPTIONS: ConnectionOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

/**
 * 假端口：把 serialport 的事件与回调模型压缩成测试能精确驱动的形状。
 * 真实原生模块和硬件都不参与，因此「打开 → 收发 → 掉线 → 关闭」可以跑成确定性测试。
 */
class FakeNodePort implements NodePortHandle {
  dataListener: ((chunk: Uint8Array) => void) | null = null;
  errorListener: ((error: Error) => void) | null = null;
  closeListener: ((info: { disconnected: boolean }) => void) | null = null;

  readonly written: Uint8Array[] = [];
  closeCalls = 0;
  disposed = false;
  /** 让下一次 write 失败。 */
  failWrite: Error | null = null;
  /** 让 close 回调报错，模拟「端口没能真正释放」。 */
  failClose: Error | null = null;

  onData = (listener: (chunk: Uint8Array) => void): void => {
    this.dataListener = listener;
  };

  onError = (listener: (error: Error) => void): void => {
    this.errorListener = listener;
  };

  onClose = (listener: (info: { disconnected: boolean }) => void): void => {
    this.closeListener = listener;
  };

  write = (data: Uint8Array, callback: (error?: Error | null) => void): void => {
    const failure = this.failWrite;
    this.failWrite = null;
    if (failure) {
      queueMicrotask(() => callback(failure));
      return;
    }
    this.written.push(data);
    queueMicrotask(() => callback(null));
  };

  close = (callback: (error?: Error | null) => void): void => {
    this.closeCalls += 1;
    queueMicrotask(() => callback(this.failClose));
  };

  dispose = (): void => {
    this.disposed = true;
    this.dataListener = null;
    this.errorListener = null;
    this.closeListener = null;
  };

  /** 模拟设备被拔出：serialport 会带 disconnected 标记发 close 事件。 */
  unplug(): void {
    this.closeListener?.({ disconnected: true });
  }
}

interface Harness {
  transport: NodeSerialTransport;
  port: FakeNodePort;
  chunks: Uint8Array[];
  closes: string[];
  errors: string[];
}

function makeHarness(options: { failOpen?: Error } = {}): Harness {
  const port = new FakeNodePort();
  const chunks: Uint8Array[] = [];
  const closes: string[] = [];
  const errors: string[] = [];

  const transport = new NodeSerialTransport('COM3', () => {
    if (options.failOpen) return Promise.reject(options.failOpen);
    return Promise.resolve(port);
  });

  transport.subscribe({
    onData: (chunk) => chunks.push(chunk),
    onClose: (reason) => closes.push(reason),
    onError: (error) => errors.push(error.kind),
  });

  return { transport, port, chunks, closes, errors };
}

describe('NodeSerialTransport', () => {
  it('打开后进入 open，收到的数据原样上报', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);

    expect(h.transport.state).toBe('open');
    h.port.dataListener?.(new Uint8Array([1, 2, 3]));
    expect(h.chunks).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it('空数据块不上报，免得日志里堆出一串空帧', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);

    h.port.dataListener?.(new Uint8Array(0));
    expect(h.chunks).toEqual([]);
  });

  it('打开失败时回到 closed 并抛 open-failed', async () => {
    const h = makeHarness({ failOpen: new Error('Access denied') });

    await expect(h.transport.open(OPTIONS)).rejects.toThrow(/Access denied/);
    expect(h.transport.state).toBe('closed');
  });

  it('未打开时写入直接拒绝，而不是排队等一个永远不来的端口', async () => {
    const h = makeHarness();
    await expect(h.transport.write(new Uint8Array([1]))).rejects.toThrow(/not open/i);
  });

  it('写入按顺序落到端口上', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);

    await h.transport.write(new Uint8Array([1]));
    await h.transport.write(new Uint8Array([2]));
    expect(h.port.written).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
  });

  it('写入失败会抛出，且不会卡住后续写入', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);

    h.port.failWrite = new Error('device gone');
    await expect(h.transport.write(new Uint8Array([1]))).rejects.toThrow(/device gone/);
    await expect(h.transport.write(new Uint8Array([2]))).resolves.toBeUndefined();
  });

  it('积压超过上限时拒绝本次写入（缺陷 D10 的背压闸门）', async () => {
    const port = new FakeNodePort();
    // 写入永不回调，用来把队列堵住
    port.write = () => undefined;
    const transport = new NodeSerialTransport('COM3', () => Promise.resolve(port), 8);
    await transport.open(OPTIONS);

    void transport.write(new Uint8Array(8));
    await expect(transport.write(new Uint8Array(1))).rejects.toThrow(/queue is full/i);
    expect(transport.pendingBytes).toBe(8);
  });

  it('主动关闭走 local，并真正把端口还回去', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);
    await h.transport.close();

    expect(h.transport.state).toBe('closed');
    expect(h.closes).toEqual(['local']);
    expect(h.port.closeCalls).toBe(1);
  });

  /**
   * 拆卸时必须先解监听：close() 自己会触发 'close' 事件，
   * 不先摘掉的话会绕回 shutdown 再来一遍，用户会看到两条「串口已关闭」。
   */
  it('关闭过程中端口自己发出的 close 事件不会引发第二次拆卸', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);

    const listener = h.port.closeListener;
    await h.transport.close();
    listener?.({ disconnected: false });

    expect(h.closes).toEqual(['local']);
    expect(h.port.closeCalls).toBe(1);
  });

  it('close() 幂等，并发调用汇流到同一次拆卸', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);

    await Promise.all([h.transport.close(), h.transport.close(), h.transport.close()]);

    expect(h.closes).toEqual(['local']);
    expect(h.port.closeCalls).toBe(1);
  });

  it('设备被拔出时走 remote —— 上层据此决定要不要重连', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);

    h.port.unplug();
    await vi.waitFor(() => expect(h.transport.state).toBe('closed'));
    expect(h.closes).toEqual(['remote']);
  });

  it('端口自己出错但没掉线时走 error', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);

    h.port.closeListener?.({ disconnected: false });
    await vi.waitFor(() => expect(h.transport.state).toBe('closed'));
    expect(h.closes).toEqual(['error']);
  });

  it('打开期间的端口错误上报为 read 错误，但不拆链路', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);

    h.port.errorListener?.(new Error('parity error'));
    expect(h.errors).toEqual(['read']);
    expect(h.transport.state).toBe('open');
  });

  /**
   * 打开一个串口要几百毫秒。用户恰好在这期间点了关闭时，若两条路径并行，
   * 打开流程的后半段会把状态写回 open —— 端口物理上开着、上层却以为已经关了，
   * 从此没有任何引用能关掉它。
   */
  it('打开途中被关闭时不并行拆卸，开出来的口立刻还回去', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port = new FakeNodePort();
    const transport = new NodeSerialTransport('COM3', async () => {
      await gate;
      return port;
    });

    const opening = transport.open(OPTIONS);
    const closing = transport.close();
    release();
    await Promise.all([opening, closing]);

    expect(transport.state).toBe('closed');
    expect(port.closeCalls).toBe(1);
    expect(port.disposed).toBe(true);
  });

  it('关闭失败必须让用户看见 —— 端口没释放，下次打开会失败', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);
    h.port.failClose = new Error('busy');

    await h.transport.close();
    expect(h.errors).toEqual(['close-failed']);
  });

  it('已经关闭后再 close 不做任何事', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);
    await h.transport.close();
    await h.transport.close();

    expect(h.port.closeCalls).toBe(1);
    expect(h.closes).toEqual(['local']);
  });

  it('打开中的端口不能重复打开', async () => {
    const h = makeHarness();
    await h.transport.open(OPTIONS);
    await expect(h.transport.open(OPTIONS)).rejects.toThrow(/Cannot open/);
  });
});
