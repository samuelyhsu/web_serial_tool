/**
 * 周期发送任务调度器。
 *
 * 替换原型的 `this.timers[key] = setInterval(...)`（.dc.html:815/847/904），修掉三个问题：
 *  - D11 重入堆积：setInterval 不管上一次有没有发完，到点就再发一次。这里加 busy 闸门，
 *    上一次未完成就跳过本 tick 并回调 onSkip，由 UI 提示「跟不上」。
 *  - D11 周期漂移：setInterval 的实际间隔会被主线程阻塞拖长且误差累积。这里用绝对时间轴
 *    重排 setTimeout，长时间运行不跑偏；落后太多时直接跳到下一个未来时刻，不做补发风暴。
 *  - D12 命名空间混用：原型把重连退避定时器和周期发送塞进同一个 map，点「全部停止」会把
 *    重连一起干掉。重连现在归 ReconnectController 管，这里只管周期发送。
 */

export interface PeriodicTaskSpec {
  intervalMs: number;
  run: () => void | Promise<void>;
  /** 默认 true：启动时立即发一次，与原型行为一致。 */
  runImmediately?: boolean;
  /** 上一次还没发完导致本次被跳过时触发。 */
  onSkip?: () => void;
  onError?: (error: unknown) => void;
}

interface TaskState {
  spec: PeriodicTaskSpec;
  timer: ReturnType<typeof setTimeout> | null;
  nextAt: number;
  busy: boolean;
  cancelled: boolean;
}

export class TaskScheduler {
  readonly #tasks = new Map<string, TaskState>();

  get runningCount(): number {
    return this.#tasks.size;
  }

  runningIds(): string[] {
    return [...this.#tasks.keys()];
  }

  isRunning(id: string): boolean {
    return this.#tasks.has(id);
  }

  start(id: string, spec: PeriodicTaskSpec): void {
    this.stop(id);
    const state: TaskState = {
      spec,
      timer: null,
      nextAt: Date.now(),
      busy: false,
      cancelled: false,
    };
    this.#tasks.set(id, state);

    if (spec.runImmediately !== false) void this.#invoke(state);
    this.#schedule(state);
  }

  /** 改周期，不打断已在运行的任务；下一次触发即生效。 */
  updateInterval(id: string, intervalMs: number): void {
    const state = this.#tasks.get(id);
    if (state) state.spec.intervalMs = Math.max(1, intervalMs);
  }

  stop(id: string): void {
    const state = this.#tasks.get(id);
    if (!state) return;
    state.cancelled = true;
    if (state.timer !== null) clearTimeout(state.timer);
    this.#tasks.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.#tasks.keys()]) this.stop(id);
  }

  #schedule(state: TaskState): void {
    if (state.cancelled) return;
    const now = Date.now();
    const interval = Math.max(1, state.spec.intervalMs);
    // 绝对时间轴：不累积误差；但落后超过一个周期时直接对齐到未来，避免补发风暴
    state.nextAt = Math.max(now, state.nextAt + interval);
    state.timer = setTimeout(() => {
      if (state.cancelled) return;
      this.#schedule(state); // 先排下一次，周期不受 run() 耗时影响
      void this.#invoke(state);
    }, state.nextAt - now);
  }

  async #invoke(state: TaskState): Promise<void> {
    if (state.cancelled) return;
    if (state.busy) {
      state.spec.onSkip?.();
      return;
    }
    state.busy = true;
    try {
      await state.spec.run();
    } catch (error) {
      state.spec.onError?.(error);
    } finally {
      state.busy = false;
    }
  }
}
