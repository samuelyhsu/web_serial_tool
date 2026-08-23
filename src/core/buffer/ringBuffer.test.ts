import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer';

describe('RingBuffer', () => {
  it('未满时按插入顺序保存', () => {
    const ring = new RingBuffer<number>(4);
    ring.push(1);
    ring.push(2);
    expect(ring.size).toBe(2);
    expect(ring.toArray()).toEqual([1, 2]);
  });

  it('超出容量时淘汰最旧的一项，顺序仍然正确', () => {
    const ring = new RingBuffer<number>(3);
    for (const value of [1, 2, 3, 4, 5]) ring.push(value);
    expect(ring.size).toBe(3);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.at(0)).toBe(3);
    expect(ring.at(2)).toBe(5);
  });

  it('recent 返回最新的 n 项且保持时间顺序', () => {
    const ring = new RingBuffer<number>(5);
    for (const value of [1, 2, 3, 4, 5, 6, 7]) ring.push(value);
    expect(ring.recent(3)).toEqual([5, 6, 7]);
    expect(ring.recent(99)).toEqual([3, 4, 5, 6, 7]);
  });

  it('越界访问返回 undefined', () => {
    const ring = new RingBuffer<number>(2);
    ring.push(1);
    expect(ring.at(-1)).toBeUndefined();
    expect(ring.at(1)).toBeUndefined();
  });

  it('clear 后恢复空态并可继续写入', () => {
    const ring = new RingBuffer<number>(2);
    ring.push(1);
    ring.push(2);
    ring.clear();
    expect(ring.size).toBe(0);
    ring.push(9);
    expect(ring.toArray()).toEqual([9]);
  });

  it('容量非法时构造抛错', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(1.5)).toThrow(RangeError);
  });
});
