import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPortLeases, type PortLeases } from './portLease';

/**
 * 占用登记是尽力而为的广播，不是锁。这里测的是「说得清的部分」：
 * 别的页面占了谁、放手了没有，以及崩溃留下的陈旧条目会不会被清掉。
 */

const open: PortLeases[] = [];

function make(name: string): PortLeases {
  const leases = createPortLeases(name);
  open.push(leases);
  return leases;
}

/**
 * BroadcastChannel 的投递是异步的：jsdom 把它排进了一个 0ms 定时器，
 * 只推进微任务队列看不到结果，必须让假时钟往前走至少 1ms。
 */
async function settle(ms = 1): Promise<void> {
  // 推两轮：jsdom 把投递排进 0ms 定时器，而「排进去」这个动作本身发生在
  // 上一轮推进结束之后，只推一轮会看到一张还没更新的表。
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(1);
}

afterEach(() => {
  for (const leases of open.splice(0)) leases.dispose();
  vi.useRealTimers();
});

describe('跨页面端口占用登记', () => {
  it('一个页面认领后，另一个页面看得见', async () => {
    vi.useFakeTimers();
    const a = make('t1');
    const b = make('t1');

    a.claim('usb:1A86:7523#0');
    await settle();

    expect(b.holders()['usb:1A86:7523#0']).toBeDefined();
    // 自己认领的不算「被别人占用」，否则本页面会把自己拦在门外
    expect(a.holders()).toEqual({});
  });

  it('放手后占用随之消失', async () => {
    vi.useFakeTimers();
    const a = make('t2');
    const b = make('t2');

    a.claim('usb:1A86:7523#0');
    await settle();
    a.release();
    await settle();

    expect(b.holders()).toEqual({});
  });

  it('订阅者能收到变化', async () => {
    vi.useFakeTimers();
    const a = make('t3');
    const b = make('t3');
    const seen: string[][] = [];
    b.subscribe((holders) => seen.push(Object.keys(holders)));

    a.claim('serial#0');
    await settle();

    expect(seen).toEqual([['serial#0']]);
  });

  it('refresh 清掉「页面崩溃来不及放手」留下的陈旧条目', async () => {
    vi.useFakeTimers();
    const a = make('t4');
    const b = make('t4');

    a.claim('usb:0403:6001#0');
    await settle();
    expect(Object.keys(b.holders())).toHaveLength(1);

    // 模拟 A 页面被强杀：通道直接关掉，没有发出 release
    a.dispose();
    open.splice(open.indexOf(a), 1);

    b.refresh();
    await settle(400);

    // 没人应答那条 query，占用表重建后就空了
    expect(b.holders()).toEqual({});
  });

  it('还活着的页面会应答 refresh，占用不会被误清', async () => {
    vi.useFakeTimers();
    const a = make('t5');
    const b = make('t5');

    a.claim('usb:0403:6001#0');
    await settle();

    b.refresh();
    await settle(400);

    expect(Object.keys(b.holders())).toEqual(['usb:0403:6001#0']);
  });

  it('环境里没有 BroadcastChannel 时退化成「什么都不知道」，不抛错', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const leases = createPortLeases('t6');

    expect(leases.holders()).toEqual({});
    expect(() => {
      leases.claim('x');
      leases.refresh();
      leases.release();
      leases.dispose();
    }).not.toThrow();

    vi.unstubAllGlobals();
  });
});
