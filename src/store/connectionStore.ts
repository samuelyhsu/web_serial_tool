import { create } from 'zustand';
import { resolveFraming } from '@/core/framing/frameAssembler';
import type { SessionState } from '@/core/session/serialSession';
import type { PortDescriptor } from '@/core/transport/portDescriptor';
import type { ConnectionOptions, Parity } from '@/core/transport/types';
import { isRecord, pickBoolean, pickEnum, pickInt, saveSoon } from '@/lib/persist';
import type { LeaseHolders } from '@/lib/portLease';
import { readLayered, readStoredJson, storageKey, writeLayered } from '@/lib/storage';
import { platform } from './platform';
import { useLogStore } from './logStore';
import { portDisplayLabel, usePortAliasStore } from './portAliasStore';
import { useTasksStore } from './tasksStore';
import { useUiStore } from './uiStore';

/**
 * 波特率候选值。覆盖从传统低速到各类 USB-serial 芯片的高速档：
 *  - 110~115200：传统 UART 标准档，Windows `mode` 命令枚举的也是这些
 *  - 31250：MIDI
 *  - 250000 / 500000 / 1000000：DMX512、3D 打印机（Marlin）、Dynamixel 舵机
 *  - 76800 / 153600：部分工业与 GPS 模块
 *  - 921600 及以上：CH340（2M）、CP2102N（3M）、FT232R（3M）等
 *
 * 这只是下拉建议，不是限制 —— 输入框接受任意值，具体能不能开由驱动决定。
 */
export const BAUD_RATES = [
  110, 300, 600, 1200, 2400, 4800, 7200, 9600, 14400, 19200, 28800, 31250, 38400, 56000, 57600,
  76800, 115200, 128000, 153600, 230400, 250000, 256000, 460800, 500000, 576000, 921600, 1000000,
  1152000, 1500000, 2000000, 2500000, 3000000,
] as const;

/**
 * 自定义波特率的合法区间。
 *
 * 规范里 `baudRate` 是 unsigned long 且必须大于 0；上限设得很宽松（FT232H 可达 12M），
 * 只用来挡明显的手滑输入。设备究竟支持不支持，交给 port.open() 去报错。
 */
export const BAUD_RATE_MIN = 1;
export const BAUD_RATE_MAX = 20_000_000;

export function isValidBaudRate(value: number): boolean {
  return Number.isInteger(value) && value >= BAUD_RATE_MIN && value <= BAUD_RATE_MAX;
}

export const DEFAULT_OPTIONS: ConnectionOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

/**
 * 运行环境。浏览器与 VS Code webview 的差异全部收在它后面（见 platform.ts），
 * 这个 store 因此既不认识 navigator.serial，也不认识扩展宿主。
 */
const env = platform();
const session = env.session;
const leases = env.leases;
const supported = env.supported;

/**
 * 串口参数与自动重连开关。端口选择另存一键，因为它的生命周期不同。
 *
 * 这一份是**全局默认**：新设备第一次连、或页面还没选端口时用它当初值，
 * 顺带兼容多页面之前的存量数据。真正生效的是下面按设备存的那份。
 */
const SETTINGS_KEY = 'connectionSettings';
const PARITIES: readonly Parity[] = ['none', 'even', 'odd'];
const FLOW_CONTROLS: readonly ConnectionOptions['flowControl'][] = ['none', 'hardware'];

/**
 * 从 localStorage 还原串口参数。
 *
 * 逐字段校验：波特率走 isValidBaudRate（自定义值本来就允许，只挡明显手滑），
 * 其余字段限定在规范允许的取值里。任何一项不认识就退回默认，不让存量数据
 * 变成一个 open() 必然失败的配置。
 */
function loadOptions(raw: unknown): ConnectionOptions {
  return {
    baudRate: pickInt(raw, 'baudRate', DEFAULT_OPTIONS.baudRate, isValidBaudRate),
    dataBits: pickInt(raw, 'dataBits', DEFAULT_OPTIONS.dataBits, (v) => v === 7 || v === 8) as
      7 | 8,
    stopBits: pickInt(raw, 'stopBits', DEFAULT_OPTIONS.stopBits, (v) => v === 1 || v === 2) as
      1 | 2,
    parity: pickEnum(raw, 'parity', PARITIES, DEFAULT_OPTIONS.parity),
    flowControl: pickEnum(raw, 'flowControl', FLOW_CONTROLS, DEFAULT_OPTIONS.flowControl),
  };
}

const storedSettings = readStoredJson<unknown>(SETTINGS_KEY, null);

/**
 * 按设备存的串口参数：`{ "usb:1A86:7523#0": { baudRate: 115200, ... } }`。
 *
 * 这样做有两层好处，一层比一层重要：
 *  - 每台设备记住自己的参数。插 CH340 自动回到 115200、插调试器自动回到 921600，
 *    比全局共用一份符合直觉。
 *  - 同时开多个页面各连一个端口时，它们写的是不同的键，天然不会互相覆盖 ——
 *    否则 A 页把波特率改成 9600，B 页一保存就把 A 页的设置整个盖掉。
 */
const PORT_SETTINGS_KEY = 'portSettings';

function loadProfiles(): Record<string, unknown> {
  const raw = readStoredJson<unknown>(PORT_SETTINGS_KEY, {});
  return isRecord(raw) ? raw : {};
}

let portProfiles = loadProfiles();

interface PortProfile {
  options: ConnectionOptions;
  autoReconnect: boolean;
}

function profileOf(identity: string | undefined): PortProfile | null {
  if (identity === undefined) return null;
  const raw = portProfiles[identity];
  if (!isRecord(raw)) return null;
  return { options: loadOptions(raw), autoReconnect: pickBoolean(raw, 'autoReconnect', true) };
}

/**
 * 切到某个端口时要写进 store 的那部分状态：连同该设备的参数存档一起套用。
 * 没有存档就只改选中项，沿用当前参数 —— 那正是「上一台设备用得好好的配置」。
 */
function selection(port: PortDescriptor | undefined): {
  selectedPortKey: string | null;
  options?: ConnectionOptions;
  autoReconnect?: boolean;
} {
  return { selectedPortKey: port?.key ?? null, ...(profileOf(port?.identity) ?? {}) };
}

/**
 * 记住用户选中的那台设备，刷新页面后自动恢复。
 *
 * 分层存储（见 storage.ts）：本页面选过就用本页面的 —— 多个页面各连一个端口时，
 * 它们必须各记各的，否则刷新一下就会一起跳回同一台设备。从没选过端口的新页面
 * 则继承「最后一次用的设备」，免得每开一个页面都要重新选一遍。
 */
const SELECTED_PORT_KEY = 'selectedPort';

function parityLetter(parity: Parity): string {
  return parity === 'none' ? 'N' : parity === 'even' ? 'E' : 'O';
}

// 配置摘要由 store 提供：只有它知道端口当前的显示名（含用户备注）
session.setConfigDescriber((options) => {
  const label = useConnectionStore.getState().selectedPortLabel();
  return `${label} @ ${options.baudRate} ${options.dataBits}${parityLetter(options.parity)}${options.stopBits}`;
});

session.setHandlers({
  onFrame: (direction, bytes) => useLogStore.getState().appendFrame(direction, bytes),
  onThroughput: (direction, byteCount) =>
    useLogStore.getState().addThroughput(direction, byteCount),
  onNotice: (notice) => useLogStore.getState().appendNotice(notice),
  onStateChange: (sessionState) => {
    useConnectionStore.setState({ sessionState });
    // 链路一旦不再可用，所有周期发送必须跟着停 —— 否则会持续刷「串口未打开」
    if (sessionState === 'closed' || sessionState === 'reconnecting') {
      useTasksStore.getState().stopAll();
    }
    // 'reconnecting' 期间端口仍归本页面所有（马上就要重连回去），
    // 只有真正关闭才向其他页面放手
    if (sessionState === 'closed') leases.release();
  },
});

interface ConnectionState {
  supported: boolean;
  ports: readonly PortDescriptor[];
  selectedPortKey: string | null;
  options: ConnectionOptions;
  autoReconnect: boolean;
  sessionState: SessionState;
  /** 端口打开的时刻，用于运行时长统计；关闭时为 0。 */
  openedAt: number;
  /** 被本工具其他页面占用的设备：identity → 占用者 id。 */
  portHolders: LeaseHolders;

  isOpen: () => boolean;
  /** 当前选中的端口是否正被其他页面占用。 */
  busyElsewhere: () => boolean;
  selectedPortLabel: () => string;
  refreshPorts: () => Promise<void>;
  /** 打开浏览器端口选择器；成功返回被选中端口的描述，取消/失败则抛出。 */
  requestPort: () => Promise<PortDescriptor>;
  /**
   * 按 key 选中一个已知端口，并套用它自己的参数存档。
   *
   * 与 requestPort 的区别是不弹选择器 —— 供已经拿到端口列表的调用方使用
   * （VS Code 活动栏里的端口视图点一下就是走这条路）。
   */
  selectPort: (key: string) => void;
  selectedPort: () => PortDescriptor | undefined;
  setOptions: (patch: Partial<ConnectionOptions>) => void;
  setAutoReconnect: (value: boolean) => void;
  toggleConnection: () => Promise<void>;
  send: (bytes: Uint8Array) => Promise<void>;
  pendingBytes: () => number;
}

export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  supported,
  ports: [],
  selectedPortKey: null,
  options: loadOptions(storedSettings),
  autoReconnect: pickBoolean(storedSettings, 'autoReconnect', true),
  sessionState: 'closed',
  openedAt: 0,
  portHolders: leases.holders(),

  isOpen: () => get().sessionState === 'open',

  busyElsewhere: () => {
    const port = get().selectedPort();
    return port !== undefined && get().portHolders[port.identity] !== undefined;
  },

  selectedPort: () => {
    const { ports, selectedPortKey } = get();
    return ports.find((item) => item.key === selectedPortKey);
  },

  selectedPortLabel: () => {
    const port = get().selectedPort();
    // 带上用户备注：状态栏和「串口已打开 …」通知里显示自定义名字更有用
    return port ? portDisplayLabel(port, usePortAliasStore.getState().aliases) : '—';
  },

  refreshPorts: async () => {
    if (!supported) return;
    const ports = await env.listPorts();
    set((state) => {
      // 已经选中的端口还在，就保持不动
      if (ports.some((port) => port.key === state.selectedPortKey)) return { ports };
      // 否则按上次记住的设备标识恢复；恢复不了就不选 —— 单端口语义下
      // 随便挑一个可能是完全不相干的设备，不如让用户显式选一次
      const remembered = readLayered(SELECTED_PORT_KEY);
      const match = remembered ? ports.find((port) => port.identity === remembered) : undefined;
      return { ports, ...selection(match) };
    });
    // 选中项可能换了设备，自动重连开关随之而来，必须同步给会话
    session.setReconnectSettings({ enabled: get().autoReconnect });
  },

  requestPort: async () => {
    const picked = await env.requestPort();
    await get().refreshPorts();

    // 刷新后列表里的那份才是权威的（identity 的出现序号要整表一起算）
    const descriptor = get().ports.find((item) => item.key === picked.key) ?? picked;
    // 换设备时连同它自己的参数存档一起套用
    set(selection(descriptor));
    session.setReconnectSettings({ enabled: get().autoReconnect });
    // 记住这台设备，下次打开页面直接恢复（本页面优先，同时更新全局那份）
    writeLayered(SELECTED_PORT_KEY, descriptor.identity);
    return descriptor;
  },

  selectPort: (key) => {
    const descriptor = get().ports.find((item) => item.key === key);
    if (!descriptor) return;
    set(selection(descriptor));
    session.setReconnectSettings({ enabled: get().autoReconnect });
    writeLayered(SELECTED_PORT_KEY, descriptor.identity);
  },

  setOptions: (patch) => set((state) => ({ options: { ...state.options, ...patch } })),

  setAutoReconnect: (autoReconnect) => {
    set({ autoReconnect });
    session.setReconnectSettings({ enabled: autoReconnect });
  },

  toggleConnection: async () => {
    const state = get();

    if (state.sessionState !== 'closed') {
      useTasksStore.getState().stopAll();
      await session.close();
      leases.release();
      set({ openedAt: 0 });
      return;
    }

    const key = state.selectedPortKey;
    if (!key) return;

    // 本工具的另一个页面正开着这个口。不拦的话用户只会看到一句
    // 「Failed to open serial port」，根本不知道该去哪把它关掉。
    // 外部程序（PuTTY、Arduino IDE）占用的口这里看不见，仍然只能靠 open() 失败兜底。
    const descriptor = state.selectedPort();
    if (descriptor && state.portHolders[descriptor.identity] !== undefined) {
      useLogStore.getState().appendNotice({ code: 'port-busy' });
      return;
    }

    session.setReconnectSettings({ enabled: state.autoReconnect });
    try {
      await session.open(key, state.options);
      // 打开成功才登记占用：失败的尝试不该把端口标成被自己占着
      if (descriptor) leases.claim(descriptor.identity);
      set({ openedAt: Date.now() });
    } catch {
      // 失败原因已经由 session 通过 open-failed 通知写进日志了。
      // 端口可能已经不在列表里（拔掉 / 撤销授权），顺手刷新一次
      set({ openedAt: 0 });
      void get().refreshPorts();
    }
  },

  send: (bytes) => session.send(bytes),

  pendingBytes: () => session.pendingBytes,
}));

useConnectionStore.subscribe(({ options, autoReconnect, ports, selectedPortKey }) => {
  const profile = { ...options, autoReconnect };
  // 全局那份只是「最近一次用的参数」，给新设备和新页面当初值
  saveSoon(SETTINGS_KEY, profile);

  // 设备那份才是主角。多个页面各连一个端口时，它们写的是不同的键，
  // 因此谁也盖不掉谁 —— 这是多页面能各自记住参数的关键。
  const identity = ports.find((port) => port.key === selectedPortKey)?.identity;
  if (identity !== undefined) {
    portProfiles = { ...portProfiles, [identity]: profile };
    saveSoon(PORT_SETTINGS_KEY, portProfiles);
  }
});

/**
 * 跨页面同步设备参数表与占用情况。
 *
 * 参数表是整张 map 一次性写入的：若 A 页存了新设备的参数，B 页内存里仍是旧 map，
 * B 页下一次写入就会把它整体覆盖回去（与 portAliasStore 中同样的理由）。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== storageKey(PORT_SETTINGS_KEY)) return;
    portProfiles = loadProfiles();
  });
}

leases.subscribe((portHolders) => {
  useConnectionStore.setState({ portHolders });
});

/** 还原出来的自动重连开关要同步给会话，否则存的是关、实际仍会重连。 */
session.setReconnectSettings({ enabled: useConnectionStore.getState().autoReconnect });

/**
 * 把接收区的分帧选择推给会话。
 *
 * 分帧配置放在 uiStore 里 —— 它是接收区的显示选择，而且「换行分帧是否生效」取决于
 * 当前是不是 TXT 视图，视图本身也在那边。会话这侧只需订阅结果。
 */
function syncFraming(): void {
  const { frameMode, idleFrameMs, view } = useUiStore.getState();
  session.setFraming(
    resolveFraming({ mode: frameMode, idleMs: idleFrameMs, textView: view === 'text' }),
  );
}

useUiStore.subscribe(syncFraming);
syncFraming(); // 还原出来的偏好要立刻生效，不能等用户先动一下控件

/**
 * 订阅设备插拔事件，保持端口列表新鲜。
 * 返回取消订阅函数，由 App 在卸载时调用。
 */
export function watchPortChanges(): () => void {
  if (!supported) return () => undefined;

  const refresh = (): void => {
    void useConnectionStore.getState().refreshPorts();
    // 插拔往往意味着别的页面也在动端口，顺手把占用表重建一次，
    // 同时清掉「页面崩溃来不及放手」留下的陈旧条目
    leases.refresh();
  };
  leases.refresh();
  return env.watchPorts(refresh);
}

/** 仅供 App 卸载时释放会话资源。 */
export function disposeSession(): void {
  session.dispose();
  leases.release();
}

/**
 * 热更新前释放串口。
 *
 * 本模块在模块作用域持有 SerialSession 单例。改动任何一个 store 文件都会让整条依赖链
 * 重新执行，于是新模块创建出一个新的 session，而旧 session 仍持有端口的读写锁 ——
 * 端口被孤儿会话占着，新界面既显示未连接又打不开，看起来就像热更新失效了。
 * 这里在模块被替换前把端口真正关掉。生产构建里 import.meta.hot 为 undefined，整段被剔除。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useTasksStore.getState().stopAll();
    void session.close();
    // 旧模块的广播通道也要关掉，否则每次热更新都会多出一个幽灵占用者
    leases.dispose();
  });
}
