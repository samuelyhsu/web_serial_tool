import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskScheduler } from './taskScheduler';

describe('TaskScheduler', () => {
  let scheduler: TaskScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new TaskScheduler();
  });

  afterEach(() => {
    scheduler.stopAll();
    vi.useRealTimers();
  });

  it('默认启动时立即执行一次，之后按周期执行', async () => {
    const run = vi.fn();
    scheduler.start('single', { intervalMs: 100, run });
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('runImmediately: false 时首次执行发生在一个周期之后', async () => {
    const run = vi.fn();
    scheduler.start('t', { intervalMs: 50, run, runImmediately: false });
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * 缺陷 D11 的回归测试：原型用 setInterval，上一次 write 还没完成就会再发一次，
   * 慢波特率下写请求会不断堆积。
   */
  it('上一次还没执行完时跳过本次触发，并回调 onSkip', async () => {
    let release: (() => void) | null = null;
    const started = vi.fn();
    const onSkip = vi.fn();

    scheduler.start('slow', {
      intervalMs: 10,
      onSkip,
      run: () =>
        new Promise<void>((resolve) => {
          started();
          release = resolve;
        }),
    });

    expect(started).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(35);
    expect(started).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalled();

    release!();
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toHaveBeenCalledTimes(2);
  });

  it('run 抛异常不会中断后续周期，异常经 onError 上报', async () => {
    const onError = vi.fn();
    const run = vi.fn(() => {
      throw new Error('write failed');
    });
    scheduler.start('boom', { intervalMs: 10, run, onError });

    await vi.advanceTimersByTimeAsync(30);
    expect(run.mock.calls.length).toBeGreaterThan(2);
    expect(onError).toHaveBeenCalled();
  });

  it('主线程长时间阻塞后不会补发一堆积压的 tick', async () => {
    const run = vi.fn();
    scheduler.start('t', { intervalMs: 10, run, runImmediately: false });

    // 一次性跳过 1 秒（相当于 100 个周期）：只应触发它真正排到的次数，而不是补发风暴
    await vi.advanceTimersByTimeAsync(1000);
    const callsAfterJump = run.mock.calls.length;

    await vi.advanceTimersByTimeAsync(10);
    expect(run.mock.calls.length).toBe(callsAfterJump + 1);
  });

  it('stop 只停指定任务，stopAll 停全部', async () => {
    const a = vi.fn();
    const b = vi.fn();
    scheduler.start('a', { intervalMs: 10, run: a, runImmediately: false });
    scheduler.start('b', { intervalMs: 10, run: b, runImmediately: false });
    expect(scheduler.runningCount).toBe(2);
    expect(scheduler.runningIds().sort()).toEqual(['a', 'b']);

    scheduler.stop('a');
    expect(scheduler.isRunning('a')).toBe(false);
    expect(scheduler.isRunning('b')).toBe(true);

    await vi.advanceTimersByTimeAsync(20);
    expect(a).not.toHaveBeenCalled();
    expect(b.mock.calls.length).toBeGreaterThan(0);

    scheduler.stopAll();
    expect(scheduler.runningCount).toBe(0);
  });

  it('重复 start 同一个 id 会替换而不是叠加', async () => {
    const first = vi.fn();
    const second = vi.fn();
    scheduler.start('x', { intervalMs: 10, run: first, runImmediately: false });
    scheduler.start('x', { intervalMs: 10, run: second, runImmediately: false });

    await vi.advanceTimersByTimeAsync(20);
    expect(first).not.toHaveBeenCalled();
    expect(second.mock.calls.length).toBeGreaterThan(0);
    expect(scheduler.runningCount).toBe(1);
  });

  it('updateInterval 不打断运行中的任务，新周期在下一次触发时生效', async () => {
    const run = vi.fn();
    scheduler.start('x', { intervalMs: 100, run, runImmediately: false });
    scheduler.updateInterval('x', 10);

    // 已经排好的这一次仍按旧周期 100ms 触发
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    // 之后才切到 10ms
    await vi.advanceTimersByTimeAsync(30);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('停止后已排队的定时器不再触发', async () => {
    const run = vi.fn();
    scheduler.start('x', { intervalMs: 10, run, runImmediately: false });
    scheduler.stop('x');
    await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled();
  });
});
