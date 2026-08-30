import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '../../../../tests/fakeTransport';
import type { NodePortInfo } from '@/core/transport/nodePortRegistry';
import type { ConnectionOptions } from '@/core/transport/types';
import type { HostEvent } from '../shared/protocol';
import { PortLeases } from './portLeases';
import { PortWatcher } from './portWatcher';
import { SessionHost } from './sessionHost';

const OPTIONS: ConnectionOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

const PORTS: NodePortInfo[] = [
  { path: 'COM3', vendorId: '1a86', productId: '7523' },
  { path: 'COM4', vendorId: '0403', productId: '6001' },
];

interface Panel {
  host: SessionHost;
  events: HostEvent[];
  transports: FakeTransport[];
  transport: () => FakeTransport;
  typed: <T extends HostEvent['type']>(type: T) => Extract<HostEvent, { type: T }>[];
}

let leases: PortLeases;
let watcher: PortWatcher;
const panels: Panel[] = [];

function makePanel(id: string): Panel {
  const events: HostEvent[] = [];
  const transports: FakeTransport[] = [];

  const host = new SessionHost({
    id,
    leases,
    watcher,
    createTransport: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    post: (event) => events.push(event),
    pickPort: () => Promise.resolve(undefined),
    readPrefs: () => ({}),
    writePref: () => undefined,
    language: 'zh',
    defaultOptions: OPTIONS,
    now: () => 1_700_000_000_000,
  });

  const panel: Panel = {
    host,
    events,
    transports,
    transport: () => transports[transports.length - 1]!,
    typed: (type) =>
      events.filter((event) => event.type === type) as Extract<HostEvent, { type: typeof type }>[],
  };
  panels.push(panel);
  return panel;
}

beforeEach(async () => {
  vi.useFakeTimers();
  leases = new PortLeases();
  watcher = new PortWatcher({ list: () => Promise.resolve(PORTS), intervalMs: 60_000 });
  await watcher.refresh();
});

afterEach(() => {
  for (const panel of panels.splice(0)) panel.host.dispose();
  watcher.stop();
  vi.useRealTimers();
});

describe('SessionHost（一个面板一条会话）', () => {
  it('打开端口后登记占用', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });

    expect(leases.holderOf('COM3')).toBe('panel-1');
    expect(panel.host.state).toBe('open');
  });

  it('第二个面板开同一个口时被直接拒绝，并收到 port-busy', async () => {
    const first = makePanel('panel-1');
    const second = makePanel('panel-2');
    await first.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });

    await expect(
      second.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS }),
    ).rejects.toThrow(/another panel/);

    expect(second.typed('notice').map((event) => event.notice)).toContainEqual({
      code: 'port-busy',
    });
    // 被拒的面板不该留下任何痕迹：连传输层都不该被创建
    expect(second.transports).toHaveLength(0);
  });

  it('两个面板各开一个口互不干扰 —— 这正是多面板的目的', async () => {
    const first = makePanel('panel-1');
    const second = makePanel('panel-2');

    await first.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    await second.host.handle({ method: 'session.open', portKey: 'COM4', options: OPTIONS });

    expect(leases.holders()).toEqual({ COM3: 'panel-1', COM4: 'panel-2' });
    expect(first.host.state).toBe('open');
    expect(second.host.state).toBe('open');
  });

  it('关闭后放手，别的面板随即能开', async () => {
    const first = makePanel('panel-1');
    const second = makePanel('panel-2');

    await first.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    await first.host.handle({ method: 'session.close' });

    expect(leases.holderOf('COM3')).toBeUndefined();
    await expect(
      second.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS }),
    ).resolves.toBeUndefined();
  });

  it('打开失败时把占用还回去，不让一次失败把端口锁死', async () => {
    const panel = makePanel('panel-1');
    const failing = new FakeTransport();
    failing.failNextOpen = new Error('Access denied');
    const host = new SessionHost({
      id: 'panel-x',
      leases,
      watcher,
      createTransport: () => failing,
      post: () => undefined,
      pickPort: () => Promise.resolve(undefined),
      readPrefs: () => ({}),
      writePref: () => undefined,
      language: 'zh',
      defaultOptions: OPTIONS,
    });
    panels.push({ ...panel, host });

    await expect(
      host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS }),
    ).rejects.toThrow(/Access denied/);
    expect(leases.holderOf('COM3')).toBeUndefined();
  });

  it('面板关闭时释放占用并停掉周期发送', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    await panel.host.handle({
      method: 'tasks.start',
      taskId: 't1',
      frames: [new Uint8Array([1])],
      intervalMs: 100,
    });

    panel.host.dispose();
    panels.length = 0;

    expect(leases.holderOf('COM3')).toBeUndefined();
    const written = panel.transport().written.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(panel.transport().written).toHaveLength(written);
  });

  /**
   * 周期发送必须由宿主执行：面板被隐藏时 webview 会被销毁，
   * 定时器随之消失 —— 而「挂个心跳跑一下午」正是这类工具最常见的用法。
   */
  it('周期发送在宿主进程里跑，与面板是否可见无关', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    await panel.host.handle({
      method: 'tasks.start',
      taskId: 't1',
      frames: [new Uint8Array([0xa5])],
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(350);
    expect(panel.transport().written.length).toBeGreaterThanOrEqual(3);
    expect(panel.typed('tasks').at(-1)?.running).toEqual(['t1']);
  });

  it('顺序循环按队列轮流发，一轮完了从头开始', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    await panel.host.handle({
      method: 'tasks.start',
      taskId: 'sequence',
      frames: [new Uint8Array([1]), new Uint8Array([2])],
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(350);

    expect(panel.transport().written.slice(0, 4)).toEqual([
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([1]),
      new Uint8Array([2]),
    ]);
  });

  /**
   * 换内容只改一张表，不停任务重启 —— 重启会把节拍打回原点，
   * 用户在循环期间改一个字节就会多发一帧。
   */
  it('循环期间换内容即时生效，且不打乱节拍', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    await panel.host.handle({
      method: 'tasks.start',
      taskId: 't1',
      frames: [new Uint8Array([1])],
      intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(120);
    const before = panel.transport().written.length;

    await panel.host.handle({
      method: 'tasks.update',
      taskId: 't1',
      frames: [new Uint8Array([9])],
    });
    // 换内容这一下本身不该发出任何东西
    expect(panel.transport().written).toHaveLength(before);

    await vi.advanceTimersByTimeAsync(100);
    expect(panel.transport().written.at(-1)).toEqual(new Uint8Array([9]));
  });

  it('对没在跑的任务做 update 是空操作，不会把它凭空启动起来', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });

    await panel.host.handle({
      method: 'tasks.update',
      taskId: 'ghost',
      frames: [new Uint8Array([1])],
      intervalMs: 50,
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(panel.transport().written).toHaveLength(0);
    expect(panel.typed('tasks')).toHaveLength(0);
  });

  /** 报文解析不通过时浏览器版是「循环转着但不发东西」，宿主这边要一致。 */
  it('以空队列启动的任务照常在跑，只是不发东西；补上内容后开始发', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    await panel.host.handle({
      method: 'tasks.start',
      taskId: 't1',
      frames: [],
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(panel.transport().written).toHaveLength(0);
    expect(panel.typed('tasks').at(-1)?.running).toEqual(['t1']);

    await panel.host.handle({
      method: 'tasks.update',
      taskId: 't1',
      frames: [new Uint8Array([7])],
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(panel.transport().written.at(-1)).toEqual(new Uint8Array([7]));
  });

  it('链路断掉时周期发送跟着停，不再刷「串口未打开」', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    await panel.host.handle({
      method: 'tasks.start',
      taskId: 't1',
      frames: [new Uint8Array([1])],
      intervalMs: 100,
    });
    await panel.host.handle({ method: 'session.close' });

    expect(panel.typed('tasks').at(-1)?.running).toEqual([]);
  });

  it('帧是攒批送的，不是一帧一条消息', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });

    panel.transport().emitData([1]);
    panel.transport().emitData([2]);
    panel.transport().emitData([3]);
    expect(panel.typed('frames')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(80);
    const batches = panel.typed('frames');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.items).toHaveLength(3);
  });

  /** 面板被隐藏后会被销毁，重建时靠快照把历史交回去，用户不该看到空白日志。 */
  it('快照带上历史日志、当前状态与占用情况', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    panel.transport().emitData([0x41, 0x42]);

    const snapshot = panel.host.snapshot();
    expect(snapshot.type).toBe('snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('unreachable');

    expect(snapshot.state).toBe('open');
    expect(snapshot.selectedPortKey).toBe('COM3');
    expect(snapshot.frames).toHaveLength(1);
    expect(snapshot.frames[0]?.bytes).toEqual(new Uint8Array([0x41, 0x42]));
    expect(snapshot.holders).toEqual({ COM3: 'panel-1' });
    expect(snapshot.ports.map((port) => port.key)).toEqual(['COM3', 'COM4']);
  });

  /**
   * 快照不能在建好面板时就推：那会儿 webview 的脚本还没跑起来，消息直接丢掉。
   * 必须等界面报到。
   */
  it('界面报到后才拿到快照', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    panel.events.length = 0;

    await panel.host.handle({ method: 'ready' });

    const snapshot = panel.typed('snapshot').at(-1);
    expect(snapshot?.state).toBe('open');
    expect(snapshot?.selectedPortKey).toBe('COM3');
  });

  /**
   * 缺陷：命令面板 / 快捷键触发的连接曾经自己拼 `session.open`，手里只有默认参数，
   * 于是用户在界面上调好的波特率被静默换掉，而且 #options 也跟着被写坏。
   */
  it('命令触发的连接用面板当前的参数，不是默认值', async () => {
    const panel = makePanel('panel-1');
    const custom: ConnectionOptions = { ...OPTIONS, baudRate: 9600, parity: 'even' };

    // 界面把参数改成 9600 8E1 后打开、再关掉 —— 面板此时「记着」这份参数
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: custom });
    await panel.host.handle({ method: 'session.close' });

    // 然后走命令那条路径（它手里没有参数）
    expect(await panel.host.toggle()).toBe('opened');

    expect(panel.transport().openCalls.at(-1)).toEqual(custom);
    // 快照回放的也必须是这份，而不是默认值
    const snapshot = panel.host.snapshot();
    expect(snapshot.type === 'snapshot' && snapshot.options).toEqual(custom);
  });

  it('命令在没选端口时不瞎开，如实报告 no-port', async () => {
    const panel = makePanel('panel-1');

    expect(await panel.host.toggle()).toBe('no-port');
    expect(panel.transports).toHaveLength(0);
  });

  it('命令再按一次是断开', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });

    expect(await panel.host.toggle()).toBe('closed');
    expect(panel.transport().state).toBe('closed');
    expect(leases.holderOf('COM3')).toBeUndefined();
  });

  /**
   * 背压是这类工具最有价值的诊断信号之一（WriteQueue 存在的全部理由），
   * 但读数在宿主这一侧 —— 不捎回去的话界面上永远是 0。
   */
  it('帧事件捎上写队列的积压量', async () => {
    const panel = makePanel('panel-1');
    await panel.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });
    panel.events.length = 0;

    // 写队列里压着 64 字节还没写出去
    panel.transport().pendingBytes = 64;
    panel.transport().emitData(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(80);

    expect(panel.typed('frames').at(-1)?.pendingBytes).toBe(64);
  });

  it('面板 id 是对外可见的 —— 端口视图要靠它认出「这个口被谁占着」', () => {
    const panel = makePanel('panel-7');
    expect(panel.host.id).toBe('panel-7');
  });

  it('占用变化会推给所有面板，界面据此标注「已被占用」', async () => {
    const first = makePanel('panel-1');
    const second = makePanel('panel-2');

    await first.host.handle({ method: 'session.open', portKey: 'COM3', options: OPTIONS });

    expect(second.typed('ports').at(-1)?.holders).toEqual({ COM3: 'panel-1' });
  });
});
