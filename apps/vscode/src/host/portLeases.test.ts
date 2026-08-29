import { describe, expect, it, vi } from 'vitest';
import { PortLeases } from './portLeases';

describe('PortLeases（宿主侧权威占用表）', () => {
  it('先到先得，第二个面板拿不到同一个口', () => {
    const leases = new PortLeases();

    expect(leases.acquire('COM3', 'panel-1')).toBe(true);
    expect(leases.acquire('COM3', 'panel-2')).toBe(false);
    expect(leases.holderOf('COM3')).toBe('panel-1');
  });

  it('自己重复登记不算冲突 —— 重连路径会反复调它', () => {
    const leases = new PortLeases();
    leases.acquire('COM3', 'panel-1');

    expect(leases.acquire('COM3', 'panel-1')).toBe(true);
  });

  it('不同端口互不影响，这正是多面板各连一口的前提', () => {
    const leases = new PortLeases();

    expect(leases.acquire('COM3', 'panel-1')).toBe(true);
    expect(leases.acquire('COM4', 'panel-2')).toBe(true);
    expect(leases.holders()).toEqual({ COM3: 'panel-1', COM4: 'panel-2' });
  });

  /**
   * 按持有者释放，而不是按路径：面板关闭时调用方手里只有面板 id。
   * 要求它再回忆「当时开的是哪个口」，就是把同一件事记两处，迟早漏掉一处。
   */
  it('按持有者释放，会把它占的所有口一起放掉', () => {
    const leases = new PortLeases();
    leases.acquire('COM3', 'panel-1');
    leases.acquire('COM4', 'panel-1');
    leases.acquire('COM5', 'panel-2');

    leases.release('panel-1');

    expect(leases.holders()).toEqual({ COM5: 'panel-2' });
  });

  it('释放后别的面板就能拿到了', () => {
    const leases = new PortLeases();
    leases.acquire('COM3', 'panel-1');
    leases.release('panel-1');

    expect(leases.acquire('COM3', 'panel-2')).toBe(true);
  });

  it('占用变化会通知订阅者，界面据此给出「已被占用」标注', () => {
    const leases = new PortLeases();
    const seen: Record<string, string>[] = [];
    leases.subscribe((holders) => seen.push({ ...holders }));

    leases.acquire('COM3', 'panel-1');
    leases.release('panel-1');

    expect(seen).toEqual([{ COM3: 'panel-1' }, {}]);
  });

  it('没有实际变化时不惊动订阅者', () => {
    const leases = new PortLeases();
    const listener = vi.fn();
    leases.subscribe(listener);

    leases.acquire('COM3', 'panel-1');
    leases.acquire('COM3', 'panel-1'); // 重复登记
    leases.acquire('COM3', 'panel-2'); // 被拒
    leases.release('panel-9'); // 没占过任何口

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('取消订阅后不再收到通知', () => {
    const leases = new PortLeases();
    const listener = vi.fn();
    const unsubscribe = leases.subscribe(listener);

    unsubscribe();
    leases.acquire('COM3', 'panel-1');

    expect(listener).not.toHaveBeenCalled();
  });
});
