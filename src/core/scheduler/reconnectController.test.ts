import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconnectController, type ReconnectOptions } from './reconnectController';

function makeOptions(overrides: Partial<ReconnectOptions> = {}): ReconnectOptions {
  return {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 8000,
    jitterRatio: 0.2,
    random: () => 0.5, // 固定抖动系数为 1，让延时可预测
    attempt: () => Promise.resolve(),
    ...overrides,
  };
}

describe('ReconnectController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 缺陷 D13：原型是固定 1400ms 重试 5 次，没有退避也没有抖动。 */
  it('延时按 2 的幂次增长并在 maxDelayMs 处封顶', () => {
    const controller = new ReconnectController(makeOptions({ maxDelayMs: 2000 }));
    expect(controller.delayFor(1)).toBe(500);
    expect(controller.delayFor(2)).toBe(1000);
    expect(controller.delayFor(3)).toBe(2000);
    expect(controller.delayFor(4)).toBe(2000);
  });

  it('抖动让实际延时落在 ±jitterRatio 区间内', () => {
    const low = new ReconnectController(makeOptions({ random: () => 0 }));
    const high = new ReconnectController(makeOptions({ random: () => 1 }));
    expect(low.delayFor(1)).toBe(400); // 500 * 0.8
    expect(high.delayFor(1)).toBe(600); // 500 * 1.2
  });

  it('第一次尝试就成功时停止重连并回调 onSuccess', async () => {
    const attempt = vi.fn(() => Promise.resolve());
    const onSuccess = vi.fn();
    const controller = new ReconnectController(makeOptions({ attempt, onSuccess }));

    controller.start();
    expect(controller.active).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(1);
    expect(controller.active).toBe(false);
  });

  it('失败后按退避继续尝试，成功即止', async () => {
    const attempt = vi
      .fn<(n: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(undefined);
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    const controller = new ReconnectController(makeOptions({ attempt, onFailure, onSuccess }));

    controller.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith(2);
  });

  it('达到 maxAttempts 后放弃并回调 onGiveUp', async () => {
    const attempt = vi.fn(() => Promise.reject(new Error('nope')));
    const onGiveUp = vi.fn();
    const controller = new ReconnectController(makeOptions({ attempt, onGiveUp, maxAttempts: 3 }));

    controller.start();
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000);

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onGiveUp).toHaveBeenCalledWith(3);
    expect(controller.active).toBe(false);
  });

  it('onScheduled 报告每次尝试的序号与延时，供 UI 显示进度', async () => {
    const onScheduled = vi.fn();
    const attempt = vi.fn(() => Promise.reject(new Error('nope')));
    const controller = new ReconnectController(makeOptions({ attempt, onScheduled }));

    controller.start();
    await vi.advanceTimersByTimeAsync(500 + 1000);

    expect(onScheduled).toHaveBeenNthCalledWith(1, 1, 500);
    expect(onScheduled).toHaveBeenNthCalledWith(2, 2, 1000);
  });

  it('cancel 后不再发起任何尝试', async () => {
    const attempt = vi.fn(() => Promise.resolve());
    const controller = new ReconnectController(makeOptions({ attempt }));

    controller.start();
    controller.cancel();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(attempt).not.toHaveBeenCalled();
    expect(controller.active).toBe(false);
  });

  it('尝试在途时 cancel，其结果不会再触发回调', async () => {
    let release: (() => void) | null = null;
    const onSuccess = vi.fn();
    const controller = new ReconnectController(
      makeOptions({
        onSuccess,
        attempt: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      }),
    );

    controller.start();
    await vi.advanceTimersByTimeAsync(500);
    controller.cancel();
    release!();
    await vi.advanceTimersByTimeAsync(0);

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('重复 start 不会并发出两条重连链', async () => {
    const attempt = vi.fn(() => Promise.reject(new Error('nope')));
    const controller = new ReconnectController(makeOptions({ attempt }));

    controller.start();
    controller.start();
    await vi.advanceTimersByTimeAsync(500);

    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
