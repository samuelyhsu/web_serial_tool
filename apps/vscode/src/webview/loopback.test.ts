import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '../../../../tests/fakeTransport';
import type { NodePortInfo } from '@/core/transport/nodePortRegistry';
import type { ConnectionOptions } from '@/core/transport/types';
import { PortLeases } from '../host/portLeases';
import { PortWatcher } from '../host/portWatcher';
import { handleRequest } from '../host/rpc';
import { SessionHost } from '../host/sessionHost';
import type * as connectionModule from '@/store/connectionStore';
import type * as logModule from '@/store/logStore';
import type * as presetModule from '@/store/presetStore';
import type * as sendModule from '@/store/sendStore';
import type * as tasksModule from '@/store/tasksStore';
import type { HostEvent, HostRequest } from '../shared/protocol';
import type { VsCodeApi } from './vscodePlatform';

/**
 * 回环测试：把 webview 侧的 store 与宿主侧的会话**直接对接**跑一遍。
 *
 * 在此之前两侧各测各的，中间那段协议是盲区 —— 而真正逃出去的 bug 恰恰藏在接缝里：
 * 周期任务的调用点漏传了 frames，于是任务退化成在 webview 里跑，面板一隐藏就停。
 * 两侧的单元测试当时**全是绿的**，因为各自都没错，错的是没人把它们接起来看过。
 *
 * 这里唯一被替换掉的是最底下的串口（FakeTransport）和 VS Code 的消息通道，
 * 中间的 store → 客户端 → 协议 → 宿主 → 会话 → 分帧 全是真代码。
 */

const OPTIONS: ConnectionOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

const PORTS: NodePortInfo[] = [
  { path: 'COM3', vendorId: '1a86', productId: '7523', serialNumber: 'SN1' },
  { path: 'COM4', vendorId: '0403', productId: '6001', serialNumber: 'SN2' },
];

type ConnectionModule = typeof connectionModule;
type SendModule = typeof sendModule;
type PresetModule = typeof presetModule;
type TasksModule = typeof tasksModule;
type LogModule = typeof logModule;

interface Loopback {
  transports: FakeTransport[];
  /** 宿主侧的会话。用来模拟「命令面板 / 快捷键」这类不经过界面的入口。 */
  host: SessionHost;
  transport: () => FakeTransport;
  leases: PortLeases;
  connection: ConnectionModule;
  send: SendModule;
  preset: PresetModule;
  tasks: TasksModule;
  log: LogModule;
  /** 等消息在两侧之间跑完一圈。 */
  settle: () => Promise<void>;
  /**
   * 模拟面板被隐藏。
   *
   * VS Code 会把隐藏的 webview 整个销毁，它那一侧的定时器、闭包、状态全部消失。
   * 在同一个进程里没法真的销毁一个模块，但可以还原这件事的**本质**：把两侧之间的
   * 通道掐断。此后 webview 里跑的任何东西都到不了串口，而宿主里跑的照旧。
   */
  hidePanel: () => void;
}

let disposeHost: (() => void) | null = null;

async function loopback(): Promise<Loopback> {
  vi.resetModules();

  const transports: FakeTransport[] = [];
  const leases = new PortLeases();
  const watcher = new PortWatcher({ list: () => Promise.resolve(PORTS), intervalMs: 60_000 });
  await watcher.refresh();

  let host: SessionHost | null = null;
  let hidden = false;

  // 宿主 → webview：VS Code 那边是 webview.postMessage，这里就是一个 message 事件
  const post = (event: HostEvent): void => {
    if (hidden) return;
    window.dispatchEvent(new MessageEvent('message', { data: event }));
  };

  host = new SessionHost({
    id: 'panel-loopback',
    leases,
    watcher,
    createTransport: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    post,
    pickPort: () => Promise.resolve(undefined),
    readPrefs: () => ({}),
    writePref: () => undefined,
    language: 'zh',
    defaultOptions: OPTIONS,
  });
  const activeHost = host;
  disposeHost = () => {
    activeHost.dispose();
    watcher.stop();
  };

  // webview → 宿主：走的是扩展里同一段请求处理代码
  const api: VsCodeApi = {
    postMessage: (message) => {
      // 面板被隐藏后 webview 已经不存在了，它发不出任何东西
      if (hidden) return;
      void handleRequest(activeHost, message as HostRequest).then((response) => {
        window.dispatchEvent(new MessageEvent('message', { data: response }));
      });
    },
    getState: () => undefined,
    setState: (state) => state,
  };

  // 用真实的 bootstrap 装环境：`acquireVsCodeApi` 换成回环的那一头即可。
  // 初始化顺序本身就出过两次问题（store 早于 setPlatform 求值、快照早于界面到达），
  // 让测试跑真代码而不是另抄一份接线，才可能把这类问题挡在这里。
  vi.stubGlobal('acquireVsCodeApi', () => api);
  const bootstrap = await import('./bootstrap');
  const view = await import('./applySnapshot');
  bootstrap.attachView(view);

  const connection = await import('@/store/connectionStore');
  const unwatch = connection.watchPortChanges();
  const previousDispose = disposeHost;
  disposeHost = () => {
    unwatch();
    previousDispose?.();
  };

  const settle = async (): Promise<void> => {
    // 消息在两侧之间跑的是微任务，多让几轮确保跑完一圈
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  await settle();

  return {
    transports,
    host: activeHost,
    transport: () => transports[transports.length - 1]!,
    leases,
    connection,
    send: await import('@/store/sendStore'),
    preset: await import('@/store/presetStore'),
    tasks: await import('@/store/tasksStore'),
    log: await import('@/store/logStore'),
    settle,
    hidePanel: () => {
      hidden = true;
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  disposeHost?.();
  disposeHost = null;
  vi.useRealTimers();
});

describe('webview ⇄ 扩展宿主 回环', () => {
  it('界面报到后拿到端口列表', async () => {
    const app = await loopback();

    expect(app.connection.useConnectionStore.getState().ports.map((port) => port.key)).toEqual([
      'COM3',
      'COM4',
    ]);
  });

  it('打开端口这条路径能一路走到传输层，并登记占用', async () => {
    const app = await loopback();
    app.connection.useConnectionStore.getState().selectPort('COM3');

    await app.connection.useConnectionStore.getState().toggleConnection();
    await app.settle();

    expect(app.transports).toHaveLength(1);
    expect(app.transport().state).toBe('open');
    expect(app.leases.holderOf('COM3')).toBe('panel-loopback');
    expect(app.connection.useConnectionStore.getState().sessionState).toBe('open');
  });

  it('发送的字节真的落到串口上', async () => {
    const app = await loopback();
    app.connection.useConnectionStore.getState().selectPort('COM3');
    await app.connection.useConnectionStore.getState().toggleConnection();
    await app.settle();

    await app.connection.useConnectionStore.getState().send(new Uint8Array([0x41, 0x42]));
    await app.settle();

    expect(app.transport().written).toEqual([new Uint8Array([0x41, 0x42])]);
  });

  it('设备发来的数据一路回到日志里', async () => {
    const app = await loopback();
    app.connection.useConnectionStore.getState().selectPort('COM3');
    await app.connection.useConnectionStore.getState().toggleConnection();
    await app.settle();

    app.transport().emitData([0x68, 0x69]);
    await app.settle();
    // 宿主攒批 60ms 后才推过来
    await new Promise((resolve) => setTimeout(resolve, 100));
    await app.settle();
    app.log.flushPendingEntries();

    expect(app.log.allEntries().some((entry) => entry.text.includes('hi'))).toBe(true);
  });

  /**
   * 这一条是整个回环测试存在的理由。
   *
   * 周期任务必须真的跑在宿主那一侧 —— 面板被隐藏时 webview 连同定时器一起销毁，
   * 只有宿主执行的任务才能继续。调用点漏传 frames 时两侧的单元测试全绿，
   * 只有把它们接起来才看得见「循环启动了，但宿主那边什么都没发生」。
   */
  it('周期发送真的跑在宿主那一侧', async () => {
    const app = await loopback();
    app.connection.useConnectionStore.getState().selectPort('COM3');
    await app.connection.useConnectionStore.getState().toggleConnection();
    await app.settle();

    app.send.useSendStore.getState().setMode('hex');
    app.send.useSendStore.getState().setPayload('A5');
    app.send.useSendStore.getState().setIntervalMs(50);
    app.send.useSendStore.getState().toggleLoop();
    await app.settle();

    // 宿主侧的调度器在跑，webview 这边一个定时器都没有
    await new Promise((resolve) => setTimeout(resolve, 180));
    await app.settle();

    const sent = app.transport().written.filter((bytes) => bytes[0] === 0xa5);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(app.tasks.useTasksStore.getState().running).toContain(app.tasks.SINGLE_TASK);
  });

  /**
   * **这一条才是能抓住那个 bug 的用例。**
   *
   * 上面那条「周期发送真的跑在宿主那一侧」其实抓不住它：回环里两侧同在一个进程，
   * 就算任务跑在 webview，它的 send 照样能通过 RPC 把字节送到串口，测试照样绿。
   * 「跑在哪一侧」这个区别只有在 webview 被销毁时才显形 —— 所以必须先把面板隐藏掉。
   */
  it('面板被隐藏后周期发送仍在继续 —— 这是它必须跑在宿主的全部理由', async () => {
    const app = await loopback();
    app.connection.useConnectionStore.getState().selectPort('COM3');
    await app.connection.useConnectionStore.getState().toggleConnection();
    await app.settle();

    app.send.useSendStore.getState().setMode('hex');
    app.send.useSendStore.getState().setPayload('A5');
    app.send.useSendStore.getState().setIntervalMs(40);
    app.send.useSendStore.getState().toggleLoop();
    await app.settle();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 用户切到别的标签页：webview 连同它的定时器一起没了
    app.hidePanel();
    const before = app.transport().written.length;
    await new Promise((resolve) => setTimeout(resolve, 220));

    // 宿主那一侧的调度器不受影响，串口上照旧有东西出去
    expect(app.transport().written.length).toBeGreaterThan(before + 2);
  });

  it('循环期间改报文，宿主随即发的是新内容', async () => {
    const app = await loopback();
    app.connection.useConnectionStore.getState().selectPort('COM3');
    await app.connection.useConnectionStore.getState().toggleConnection();
    await app.settle();

    app.send.useSendStore.getState().setMode('hex');
    app.send.useSendStore.getState().setPayload('01');
    app.send.useSendStore.getState().setIntervalMs(50);
    app.send.useSendStore.getState().toggleLoop();
    await app.settle();
    await new Promise((resolve) => setTimeout(resolve, 80));

    app.send.useSendStore.getState().setPayload('02');
    await app.settle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await app.settle();

    expect(app.transport().written.at(-1)).toEqual(new Uint8Array([0x02]));
  });

  it('停止循环后宿主那边也真的停了', async () => {
    const app = await loopback();
    app.connection.useConnectionStore.getState().selectPort('COM3');
    await app.connection.useConnectionStore.getState().toggleConnection();
    await app.settle();

    app.send.useSendStore.getState().setIntervalMs(30);
    app.send.useSendStore.getState().toggleLoop();
    await app.settle();
    await new Promise((resolve) => setTimeout(resolve, 100));

    app.send.useSendStore.getState().toggleLoop();
    await app.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = app.transport().written.length;

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(app.transport().written).toHaveLength(settled);
  });

  it('关闭端口后占用被释放，链路也真的断了', async () => {
    const app = await loopback();
    app.connection.useConnectionStore.getState().selectPort('COM3');
    await app.connection.useConnectionStore.getState().toggleConnection();
    await app.settle();

    await app.connection.useConnectionStore.getState().toggleConnection();
    await app.settle();

    expect(app.leases.holderOf('COM3')).toBeUndefined();
    expect(app.connection.useConnectionStore.getState().sessionState).toBe('closed');
    expect(app.transport().state).toBe('closed');
  });

  /**
   * 缺陷：`selected` 事件宿主一直在发，webview 这侧却没有任何人注册处理器
   * （SessionClient 声明了 onSelected、也派发了，vscodePlatform 的 setHandlers 漏了它）。
   * 于是命令面板/快捷键触发的连接对界面完全不可见 —— 界面显示一套参数、
   * 实际以另一套开着，谁也看不出来。
   */
  it('宿主那边换了端口与参数，界面跟着变', async () => {
    const app = await loopback();
    const store = app.connection.useConnectionStore;
    store.getState().selectPort('COM3');
    await app.settle();

    // 不经过界面：命令面板那条路径直接落在宿主上
    await app.host.handle({
      method: 'session.open',
      portKey: 'COM4',
      options: { ...OPTIONS, baudRate: 9600 },
    });
    await app.settle();

    expect(store.getState().selectedPortKey).toBe('COM4');
    expect(store.getState().options.baudRate).toBe(9600);
  });

  /** 背压读数在宿主那一侧，不捎回来的话界面上永远是 0。 */
  it('写队列的积压量一路回到界面', async () => {
    const app = await loopback();
    const store = app.connection.useConnectionStore;
    store.getState().selectPort('COM3');
    await store.getState().toggleConnection();
    await app.settle();

    expect(store.getState().pendingBytes()).toBe(0);

    app.transport().pendingBytes = 128;
    app.transport().emitData(new Uint8Array([0x41]));
    await vi.waitFor(() => {
      expect(store.getState().pendingBytes()).toBe(128);
    });
  });

  it('设备掉线的通知一路回到界面', async () => {
    const app = await loopback();
    app.connection.useConnectionStore.getState().selectPort('COM3');
    await app.connection.useConnectionStore.getState().toggleConnection();
    await app.settle();
    app.connection.useConnectionStore.getState().setAutoReconnect(false);
    await app.settle();

    app.transport().emitUnplug('remote');
    await app.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.settle();

    expect(app.connection.useConnectionStore.getState().sessionState).toBe('closed');
    expect(app.log.allEntries().some((entry) => entry.notice?.code === 'connection-lost')).toBe(
      true,
    );
  });
});
