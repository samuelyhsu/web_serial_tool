/**
 * 断线重连：指数退避 + 抖动。
 *
 * 原型是固定 1400ms 重试 5 次（.dc.html:586-609，缺陷 D13），且退避定时器和周期发送
 * 共用一个 map（缺陷 D12）。这里独立成一个控制器，「全部停止周期发送」不会误杀重连。
 */

export interface ReconnectOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 抖动比例 0~1：实际延时 = delay * (1 ± jitterRatio * rand)，避免多端同时重连。 */
  jitterRatio: number;
  /** 执行一次重连尝试；成功即 resolve，失败抛异常。 */
  attempt: (attemptNumber: number) => Promise<void>;
  onScheduled?: (attemptNumber: number, delayMs: number) => void;
  onSuccess?: (attemptNumber: number) => void;
  onFailure?: (attemptNumber: number, error: unknown) => void;
  onGiveUp?: (attempts: number) => void;
  /** 注入随机源，便于测试中固定抖动。 */
  random?: () => number;
}

export class ReconnectController {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #active = false;
  #generation = 0;

  constructor(private readonly options: ReconnectOptions) {}

  get active(): boolean {
    return this.#active;
  }

  get attemptNumber(): number {
    return this.#attempt;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#attempt = 0;
    this.#generation += 1;
    this.#scheduleNext(this.#generation);
  }

  cancel(): void {
    this.#active = false;
    this.#generation += 1; // 让在途回调失效
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** 第 n 次尝试前的等待时长（n 从 1 开始），已含抖动。 */
  delayFor(attemptNumber: number): number {
    const { baseDelayMs, maxDelayMs, jitterRatio } = this.options;
    const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** (attemptNumber - 1));
    const rand = (this.options.random ?? Math.random)();
    const jitter = 1 + (rand * 2 - 1) * jitterRatio;
    return Math.max(0, Math.round(raw * jitter));
  }

  #scheduleNext(generation: number): void {
    if (!this.#active || generation !== this.#generation) return;

    this.#attempt += 1;
    const attemptNumber = this.#attempt;

    if (attemptNumber > this.options.maxAttempts) {
      this.#active = false;
      this.options.onGiveUp?.(this.options.maxAttempts);
      return;
    }

    const delay = this.delayFor(attemptNumber);
    this.options.onScheduled?.(attemptNumber, delay);

    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#active || generation !== this.#generation) return;
      this.options
        .attempt(attemptNumber)
        .then(() => {
          if (!this.#active || generation !== this.#generation) return;
          this.#active = false;
          this.options.onSuccess?.(attemptNumber);
        })
        .catch((error: unknown) => {
          if (!this.#active || generation !== this.#generation) return;
          this.options.onFailure?.(attemptNumber, error);
          this.#scheduleNext(generation);
        });
    }, delay);
  }
}
