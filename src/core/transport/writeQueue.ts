import { TransportError } from './errors';

/**
 * 串行化写队列 + 背压闸门。
 *
 * 原型里单条循环、每条预设的循环、顺序循环可以同时调 `writer.write()`（缺陷 D10）：
 * 既没有队列也没有上限，10ms 周期撞上 9600 波特率时写队列会无限膨胀，界面随之卡死。
 * 这里把所有写入串成一条 promise 链，并对「已排队未写出」的字节数设上限，
 * 超限直接拒绝本次写入，让上层把它变成一条可见的告警而不是静默积压。
 */
export const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

export class WriteQueue {
  #tail: Promise<void> = Promise.resolve();
  #pendingBytes = 0;

  constructor(
    private readonly sink: (data: Uint8Array) => Promise<void>,
    readonly highWaterMark: number = DEFAULT_HIGH_WATER_MARK,
  ) {}

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  enqueue(data: Uint8Array): Promise<void> {
    if (this.#pendingBytes + data.length > this.highWaterMark) {
      return Promise.reject(
        new TransportError(
          'backpressure',
          `Write queue is full (${this.#pendingBytes}/${this.highWaterMark} bytes pending)`,
        ),
      );
    }

    this.#pendingBytes += data.length;
    const task = this.#tail.then(() => this.sink(data));
    // 链上某一次失败不能让后续写入永久卡住
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task.finally(() => {
      this.#pendingBytes -= data.length;
    });
  }

  /** 等待队列排空（失败也视为完成）。 */
  async drain(): Promise<void> {
    await this.#tail;
  }

  reset(): void {
    this.#tail = Promise.resolve();
    this.#pendingBytes = 0;
  }
}
