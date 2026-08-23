import { TransportError } from './errors';
import type {
  CloseReason,
  ConnectionOptions,
  Transport,
  TransportEvents,
  TransportState,
} from './types';
import { WriteQueue } from './writeQueue';

/** 浏览器是否提供 Web Serial（需 Chromium 系 + HTTPS 或 localhost 的安全上下文）。 */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Web Serial 之上的 Transport 实现 —— 整个 core 层唯一接触浏览器 API 的地方。
 *
 * 相对原型修掉两个真实的生命周期缺陷：
 *  - D5：原型的 `while (this.reading && p.readable)` 在流以 done 结束但 readable 尚未
 *    置空时会疯狂重取 reader 空转。这里 done 即退出，只有「流出错但端口仍在」这一种
 *    情况才重取 reader —— 那正是 Chromium 官方文档给出的奇偶/帧错误恢复姿势。
 *    https://developer.chrome.com/docs/capabilities/serial
 *  - D6：原型 cancel() 之后不等读循环结束就 port.close()，且错误全被空 catch 吞掉。
 *    这里 close() 幂等，必须 await 读循环真正退出、写队列排空后才关端口，关闭失败会抛。
 */
export class WebSerialTransport implements Transport {
  #state: TransportState = 'closed';
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #readTask: Promise<void> | null = null;
  /** 在途的打开流程。close() 必须先等它走完，否则会与它竞争（见 close()）。 */
  #openTask: Promise<void> | null = null;
  /** 在途的关闭流程。本地 close() 与读循环发现掉线共用，保证端口只关一次。 */
  #closeTask: Promise<void> | null = null;
  #handlers = new Set<Partial<TransportEvents>>();
  #queue: WriteQueue;

  constructor(
    private readonly port: SerialPort,
    highWaterMark?: number,
  ) {
    this.#queue = new WriteQueue(async (data) => {
      const writer = this.#writer;
      if (!writer) throw new TransportError('invalid-state', 'Port is not open for writing');
      await writer.write(data);
    }, highWaterMark);
  }

  get state(): TransportState {
    return this.#state;
  }

  get pendingBytes(): number {
    return this.#queue.pendingBytes;
  }

  subscribe(handlers: Partial<TransportEvents>): () => void {
    this.#handlers.add(handlers);
    return () => this.#handlers.delete(handlers);
  }

  async open(options: ConnectionOptions): Promise<void> {
    if (this.#state !== 'closed') {
      throw new TransportError('invalid-state', `Cannot open a port in "${this.#state}" state`);
    }
    this.#state = 'opening';

    // 登记在途的打开流程，好让并发的 close() 能等它结束再动手
    const task = this.#openPort(options);
    this.#openTask = task;
    try {
      await task;
    } finally {
      if (this.#openTask === task) this.#openTask = null;
    }
  }

  async #openPort(options: ConnectionOptions): Promise<void> {
    try {
      await this.port.open({
        baudRate: options.baudRate,
        dataBits: options.dataBits,
        stopBits: options.stopBits,
        parity: options.parity,
        flowControl: options.flowControl,
        bufferSize: options.bufferSize ?? 8192,
      });
    } catch (error) {
      this.#state = 'closed';
      throw TransportError.from(error, 'open-failed', 'Failed to open port');
    }

    const writable = this.port.writable;
    if (!writable) {
      this.#state = 'closed';
      await this.port.close().catch(() => undefined);
      throw new TransportError('no-writable', 'Port opened without a writable stream');
    }

    this.#writer = writable.getWriter();
    this.#queue.reset();
    this.#state = 'open';
    this.#readTask = this.#readLoop();
  }

  async close(): Promise<void> {
    // 打开还在途中：必须先等它走完再拆，不能与它并行。
    // 并行拆卸一定会输给 open() 的后半段 —— 它无条件把状态写回 'open' 并启动读循环，
    // 于是端口物理上还开着，上层却以为已经关了：这条链路再没有引用能关掉它，
    // 端口被独占到刷新页面为止。
    if (this.#state === 'opening') {
      await this.#openTask?.catch(() => undefined);
    }
    if (this.#state === 'closed') return; // 打开失败，它自己已经收好尾了
    // 已有关闭流程在跑（本地 close 或读循环发现掉线）：共享同一次，端口只关一次
    if (this.#closeTask) return this.#closeTask;
    return this.#shutdown('local');
  }

  /**
   * 唯一的关闭出口：本地 close() 与「读循环发现设备掉线」两条路径共用。
   * 登记成 #closeTask，任何并发的 close() 都会汇流到同一次拆卸上。
   */
  #shutdown(reason: CloseReason): Promise<void> {
    // 同步把状态推到 'closing'，并发的 close() 才不会误判成「还开着」
    const task = (async () => {
      this.#state = 'closing';
      await this.#teardown();
      this.#state = 'closed';
      this.#emitClose(reason);
    })();
    this.#closeTask = task;
    return task.finally(() => {
      if (this.#closeTask === task) this.#closeTask = null;
    });
  }

  write(data: Uint8Array): Promise<void> {
    if (this.#state !== 'open') {
      return Promise.reject(new TransportError('invalid-state', 'Port is not open'));
    }
    return this.#queue.enqueue(data);
  }

  /**
   * 释放 reader / writer 并关闭端口。close() 与「设备掉线」两条路径共用。
   * 关键顺序：先让读循环退出 → 再排空写队列 → 最后 port.close()，
   * 任何一步都不能在流仍被锁定时去关端口。
   */
  async #teardown(): Promise<void> {
    try {
      await this.#reader?.cancel();
    } catch {
      // 流已进入 error 状态时 cancel 会抛；此时读循环自己会退出，忽略无碍
    }

    try {
      await this.#readTask;
    } catch {
      // 读循环内部的异常已经通过 onError 上报过了
    }
    this.#readTask = null;

    // 排空后再放锁：仍有 write 在途时 releaseLock() 会抛
    await this.#queue.drain();
    const writer = this.#writer;
    this.#writer = null;
    if (writer) {
      try {
        writer.releaseLock();
      } catch {
        // 设备被拔出时可写流已进入 error 状态，锁随流一起失效；
        // 真正需要用户知道的是下面 port.close() 失败，这里不必再刷一条噪音
      }
    }
    this.#queue.reset();

    try {
      await this.port.close();
    } catch (error) {
      // 关闭失败必须让用户看见：端口没真正释放，下次打开会失败
      this.#emitError(TransportError.from(error, 'close-failed', 'Failed to close port'));
    }
  }

  async #readLoop(): Promise<void> {
    while (this.#state === 'open' && this.port.readable) {
      const readable = this.port.readable;
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = readable.getReader();
      } catch (error) {
        this.#emitError(TransportError.from(error, 'read', 'Failed to lock readable stream'));
        break;
      }
      this.#reader = reader;

      let streamEnded = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            streamEnded = true;
            break;
          }
          if (value && value.byteLength > 0) this.#emitData(value);
        }
      } catch (error) {
        // 奇偶/帧错误会让当前流进入 error 状态。释放锁后 port.readable 会是一个新流，
        // 可以继续读；设备被拔出时 port.readable 变成 null，外层 while 自然退出。
        if (this.#state === 'open') {
          this.#emitError(TransportError.from(error, 'read', 'Read error'));
        }
      } finally {
        this.#reader = null;
        try {
          reader.releaseLock();
        } catch {
          // 流已 error 时 releaseLock 会抛，此时锁已随流一起失效，无需处理
        }
      }

      if (streamEnded) break;
    }

    // 走到这里且状态仍是 open，说明不是我们主动关的 —— 设备掉线了
    if (this.#state === 'open') {
      this.#readTask = null; // 避免 teardown 里 await 自己
      await this.#shutdown('remote');
    }
  }

  #emitData(chunk: Uint8Array): void {
    for (const handler of this.#handlers) handler.onData?.(chunk);
  }

  #emitError(error: TransportError): void {
    for (const handler of this.#handlers) handler.onError?.(error);
  }

  #emitClose(reason: CloseReason): void {
    for (const handler of this.#handlers) handler.onClose?.(reason);
  }
}
