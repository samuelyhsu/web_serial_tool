import { describe, expect, it, vi } from 'vitest';
import { TransportError } from './errors';
import { WriteQueue } from './writeQueue';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让所有已排队的微任务跑完（setTimeout(0) 会排在全部微任务之后）。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WriteQueue', () => {
  /**
   * 缺陷 D10 的核心：原型里单条循环、每条预设的循环、顺序循环可以同时调 writer.write()，
   * 既无排队也无上限。
   */
  it('并发入队的写入按顺序串行执行', async () => {
    const order: number[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let index = 0;

    const queue = new WriteQueue(async (data) => {
      const gate = gates[index++]!;
      await gate.promise;
      order.push(data[0]!);
    });

    const all = Promise.all([
      queue.enqueue(Uint8Array.of(1)),
      queue.enqueue(Uint8Array.of(2)),
      queue.enqueue(Uint8Array.of(3)),
    ]);

    // 逐个放行：后一个 sink 必须等前一个真正完成才被调用
    await flushMicrotasks();
    expect(index).toBe(1);

    gates[0]!.resolve();
    await flushMicrotasks();
    expect(index).toBe(2);

    gates[1]!.resolve();
    await flushMicrotasks();
    expect(index).toBe(3);

    gates[2]!.resolve();
    await all;

    expect(order).toEqual([1, 2, 3]);
  });

  it('pendingBytes 反映排队中的字节数，完成后归零', async () => {
    const gate = deferred<void>();
    const queue = new WriteQueue(async () => {
      await gate.promise;
    });

    const task = queue.enqueue(new Uint8Array(100));
    expect(queue.pendingBytes).toBe(100);

    gate.resolve();
    await task;
    expect(queue.pendingBytes).toBe(0);
  });

  it('超过高水位线时拒绝写入，而不是让队列无限膨胀', async () => {
    const gate = deferred<void>();
    const sink = vi.fn(async () => {
      await gate.promise;
    });
    const queue = new WriteQueue(sink, 128);

    const first = queue.enqueue(new Uint8Array(100));
    await expect(queue.enqueue(new Uint8Array(100))).rejects.toBeInstanceOf(TransportError);
    await expect(queue.enqueue(new Uint8Array(100))).rejects.toMatchObject({
      kind: 'backpressure',
    });

    // 被拒的写入不应进入 sink
    expect(sink).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;

    // 排空后又能继续写
    await expect(queue.enqueue(new Uint8Array(100))).resolves.toBeUndefined();
  });

  it('恰好等于高水位线的写入被接受', async () => {
    const queue = new WriteQueue(() => Promise.resolve(), 64);
    await expect(queue.enqueue(new Uint8Array(64))).resolves.toBeUndefined();
  });

  it('某次写入失败不会让后续写入永久卡死', async () => {
    let call = 0;
    const queue = new WriteQueue((data) => {
      call += 1;
      return call === 1 ? Promise.reject(new Error('device gone')) : Promise.resolve(void data);
    });

    await expect(queue.enqueue(Uint8Array.of(1))).rejects.toThrow('device gone');
    await expect(queue.enqueue(Uint8Array.of(2))).resolves.toBeUndefined();
    expect(queue.pendingBytes).toBe(0);
  });

  it('drain 等待队列排空', async () => {
    const gate = deferred<void>();
    const queue = new WriteQueue(async () => {
      await gate.promise;
    });

    const task = queue.enqueue(new Uint8Array(10));
    let drained = false;
    const drain = queue.drain().then(() => {
      drained = true;
    });

    expect(drained).toBe(false);
    gate.resolve();
    await task;
    await drain;
    expect(drained).toBe(true);
  });

  it('reset 清空计数', async () => {
    const queue = new WriteQueue(() => Promise.resolve());
    await queue.enqueue(new Uint8Array(10));
    queue.reset();
    expect(queue.pendingBytes).toBe(0);
  });
});
