/**
 * 固定容量环形缓冲。
 *
 * 原型的日志是普通数组 + `log.splice(0, log.length - 2000)`，每次溢出都要搬移整个数组。
 * 环形缓冲把写入和淘汰都变成 O(1)，高频接收时不再产生数组churn（缺陷 D9）。
 */
export class RingBuffer<T> {
  readonly capacity: number;
  #items: (T | undefined)[];
  #start = 0;
  #size = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('RingBuffer capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.#items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  push(item: T): void {
    if (this.#size < this.capacity) {
      this.#items[(this.#start + this.#size) % this.capacity] = item;
      this.#size += 1;
      return;
    }
    // 满了：覆盖最旧的一项，起点前移
    this.#items[this.#start] = item;
    this.#start = (this.#start + 1) % this.capacity;
  }

  /** 按时间顺序取第 i 项，0 = 最旧。 */
  at(index: number): T | undefined {
    if (index < 0 || index >= this.#size) return undefined;
    return this.#items[(this.#start + index) % this.capacity];
  }

  /** 最新的 count 项，按时间顺序返回。不复制整个缓冲。 */
  recent(count: number): T[] {
    const n = Math.min(count, this.#size);
    const out: T[] = new Array<T>(n);
    const offset = this.#size - n;
    for (let i = 0; i < n; i += 1) {
      out[i] = this.#items[(this.#start + offset + i) % this.capacity]!;
    }
    return out;
  }

  toArray(): T[] {
    return this.recent(this.#size);
  }

  clear(): void {
    this.#items = new Array<T | undefined>(this.capacity);
    this.#start = 0;
    this.#size = 0;
  }
}
