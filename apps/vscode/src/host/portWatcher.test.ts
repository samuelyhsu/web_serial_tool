import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodePortInfo } from '@/core/transport/nodePortRegistry';
import { PortWatcher } from './portWatcher';

const COM3: NodePortInfo = { path: 'COM3', vendorId: '1a86', productId: '7523' };
const COM4: NodePortInfo = { path: 'COM4', vendorId: '0403', productId: '6001' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PortWatcher（桌面端只能靠轮询发现插拔）', () => {
  it('订阅后立刻枚举一次，不必等第一拍', async () => {
    const list = vi.fn(() => Promise.resolve([COM3]));
    const watcher = new PortWatcher({ list, intervalMs: 2000 });
    const seen: string[][] = [];

    watcher.subscribe((ports) => seen.push(ports.map((port) => port.key)));
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([['COM3']]);
    watcher.stop();
  });

  it('列表没变时不惊动界面 —— 每两秒重画一次日志面板是不可接受的', async () => {
    const list = vi.fn(() => Promise.resolve([COM3]));
    const watcher = new PortWatcher({ list, intervalMs: 2000 });
    const listener = vi.fn();

    watcher.subscribe(listener);
    await vi.advanceTimersByTimeAsync(6000);

    expect(list.mock.calls.length).toBeGreaterThan(1);
    expect(listener).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('插上新设备后下一拍就通知', async () => {
    let ports: NodePortInfo[] = [COM3];
    const watcher = new PortWatcher({ list: () => Promise.resolve(ports), intervalMs: 2000 });
    const seen: string[][] = [];

    watcher.subscribe((list) => seen.push(list.map((port) => port.key)));
    await vi.advanceTimersByTimeAsync(0);

    ports = [COM3, COM4];
    await vi.advanceTimersByTimeAsync(2000);

    expect(seen).toEqual([['COM3'], ['COM3', 'COM4']]);
    watcher.stop();
  });

  it('拔掉设备同样能发现', async () => {
    let ports: NodePortInfo[] = [COM3, COM4];
    const watcher = new PortWatcher({ list: () => Promise.resolve(ports), intervalMs: 2000 });
    const seen: string[][] = [];

    watcher.subscribe((list) => seen.push(list.map((port) => port.key)));
    await vi.advanceTimersByTimeAsync(0);

    ports = [COM4];
    await vi.advanceTimersByTimeAsync(2000);

    expect(seen.at(-1)).toEqual(['COM4']);
    watcher.stop();
  });

  it('枚举失败不会让轮询停摆', async () => {
    let fail = true;
    const onError = vi.fn();
    const watcher = new PortWatcher({
      list: () =>
        fail ? Promise.reject(new Error('enumeration failed')) : Promise.resolve([COM3]),
      intervalMs: 2000,
      onError,
    });
    const listener = vi.fn();

    watcher.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalled();

    fail = false;
    await vi.advanceTimersByTimeAsync(2000);

    expect(listener).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  /** 慢速枚举（USB 集线器上挂一堆设备时很常见）不该把请求堆起来。 */
  it('上一拍还没回来就跳过这一拍', async () => {
    let release = (): void => undefined;
    const list = vi.fn(
      () =>
        new Promise<NodePortInfo[]>((resolve) => {
          release = () => resolve([COM3]);
        }),
    );
    const watcher = new PortWatcher({ list, intervalMs: 100 });

    watcher.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(500);

    expect(list).toHaveBeenCalledTimes(1);
    release();
    watcher.stop();
  });

  it('最后一个面板关掉后停止轮询 —— 没有面板时不该有后台活动', async () => {
    const list = vi.fn(() => Promise.resolve([COM3]));
    const watcher = new PortWatcher({ list, intervalMs: 100 });

    const unsubscribe = watcher.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(300);
    const callsWhileWatching = list.mock.calls.length;

    unsubscribe();
    await vi.advanceTimersByTimeAsync(1000);

    expect(list.mock.calls.length).toBe(callsWhileWatching);
  });
});
