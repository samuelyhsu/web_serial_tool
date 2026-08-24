import { create } from 'zustand';
import { SerialSession, type SessionState } from '@/core/session/serialSession';
import { TransportError } from '@/core/transport/errors';
import { describePorts, portKey, type PortDescriptor } from '@/core/transport/portRegistry';
import type { ConnectionOptions, Parity } from '@/core/transport/types';
import { isWebSerialSupported, WebSerialTransport } from '@/core/transport/webSerialTransport';
import { pickBoolean, pickEnum, pickInt, saveSoon } from '@/lib/persist';
import { readStored, readStoredJson, writeStored } from '@/lib/storage';
import { useLogStore } from './logStore';
import { portDisplayLabel, usePortAliasStore } from './portAliasStore';
import { useTasksStore } from './tasksStore';

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

const supported = isWebSerialSupported();

/** 串口参数与自动重连开关。端口选择另存一键，因为它的生命周期不同。 */
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

/** 记住用户选中的那台设备，刷新页面后自动恢复。 */
const SELECTED_PORT_KEY = 'selectedPort';

/** 重连时按稳定 key 重新解析端口对象（缺陷 D1）。 */
async function resolvePort(key: string): Promise<SerialPort | undefined> {
  if (!supported) return undefined;
  const ports = await navigator.serial.getPorts();
  return ports.find((port) => portKey(port) === key);
}

function parityLetter(parity: Parity): string {
  return parity === 'none' ? 'N' : parity === 'even' ? 'E' : 'O';
}

function describeConfig(options: ConnectionOptions): string {
  const label = useConnectionStore.getState().selectedPortLabel();
  return `${label} @ ${options.baudRate} ${options.dataBits}${parityLetter(options.parity)}${options.stopBits}`;
}

const session = new SerialSession({
  createTransport: (port) => new WebSerialTransport(port),
  resolvePort,
  describeConfig,
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

  isOpen: () => boolean;
  selectedPortLabel: () => string;
  refreshPorts: () => Promise<void>;
  /** 打开浏览器端口选择器；成功返回被选中端口的描述，取消/失败则抛出。 */
  requestPort: () => Promise<PortDescriptor>;
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

  isOpen: () => get().sessionState === 'open',

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
    const ports = describePorts(await navigator.serial.getPorts());
    set((state) => {
      // 已经选中的端口还在，就保持不动
      if (ports.some((port) => port.key === state.selectedPortKey)) return { ports };
      // 否则按上次记住的设备标识恢复；恢复不了就不选 —— 单端口语义下
      // 随便挑一个可能是完全不相干的设备，不如让用户显式选一次
      const remembered = readStored(SELECTED_PORT_KEY);
      const match = remembered ? ports.find((port) => port.identity === remembered) : undefined;
      return { ports, selectedPortKey: match?.key ?? null };
    });
  },

  requestPort: async () => {
    if (!supported) throw new TransportError('unsupported', 'Web Serial is not available');
    const port = await navigator.serial.requestPort();
    await get().refreshPorts();

    const key = portKey(port);
    set({ selectedPortKey: key });
    const descriptor = get().ports.find((item) => item.key === key);
    // 记住这台设备，下次打开页面直接恢复
    if (descriptor) writeStored(SELECTED_PORT_KEY, descriptor.identity);
    return descriptor ?? describePorts([port])[0]!;
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
      set({ openedAt: 0 });
      return;
    }

    const key = state.selectedPortKey;
    if (!key) return;
    const port = await resolvePort(key);
    if (!port) {
      await get().refreshPorts();
      return;
    }

    session.setReconnectSettings({ enabled: state.autoReconnect });
    try {
      await session.open(port, key, state.options);
      set({ openedAt: Date.now() });
    } catch {
      // 失败原因已经由 session 通过 open-failed 通知写进日志了
      set({ openedAt: 0 });
    }
  },

  send: (bytes) => session.send(bytes),

  pendingBytes: () => session.pendingBytes,
}));

/**
 * 订阅设备插拔事件，保持端口列表新鲜。
 * 返回取消订阅函数，由 App 在卸载时调用。
 */
useConnectionStore.subscribe(({ options, autoReconnect }) => {
  saveSoon(SETTINGS_KEY, { ...options, autoReconnect });
});

/** 还原出来的自动重连开关要同步给会话，否则存的是关、实际仍会重连。 */
session.setReconnectSettings({ enabled: useConnectionStore.getState().autoReconnect });

export function watchPortChanges(): () => void {
  if (!supported) return () => undefined;

  const refresh = (): void => {
    void useConnectionStore.getState().refreshPorts();
  };
  navigator.serial.addEventListener('connect', refresh);
  navigator.serial.addEventListener('disconnect', refresh);
  return () => {
    navigator.serial.removeEventListener('connect', refresh);
    navigator.serial.removeEventListener('disconnect', refresh);
  };
}

/** 仅供 App 卸载时释放会话资源。 */
export function disposeSession(): void {
  session.dispose();
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
  });
}
