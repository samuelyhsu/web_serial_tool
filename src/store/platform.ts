import type { FramingConfig } from '@/core/framing/frameAssembler';
import type { PeriodicTaskSpec } from '@/core/scheduler/taskScheduler';
import type { SessionEvents } from '@/core/session/serialSession';
import type { PortDescriptor } from '@/core/transport/portDescriptor';
import type { ConnectionOptions } from '@/core/transport/types';
import type { LeaseHolders } from '@/lib/portLease';
import { createWebPlatform } from './webPlatform';

/**
 * 运行环境适配层。
 *
 * store 与 UI 是同一套代码，底下却有两种运行环境：
 *  - **浏览器**：会话跑在页面里，端口来自 `navigator.serial`，跨页面占用靠 BroadcastChannel；
 *  - **VS Code webview**：会话跑在**扩展宿主进程**里（面板一被隐藏 webview 就会销毁，
 *    会话放在这边的话切个标签页串口就断了），端口来自 `serialport`，占用由宿主权威仲裁。
 *
 * 差异全部收敛在这个接口后面，store 只认它。这也是「同一份 UI 服务两个运行环境」
 * 唯一不会随时间腐化的做法 —— 复制一份 store 出来，两边迟早会长歪。
 */

/** 会话。形状与 core 的 SerialSession 一致，只是端口用 key 表示、解析由平台负责。 */
export interface SessionLike {
  setHandlers: (handlers: Partial<SessionEvents>) => void;
  /**
   * 提供「#1 CH340 @ 115200 8N1」这类配置摘要。
   * 由 store 注入，因为只有它知道端口当前的显示名（含用户备注）。
   */
  setConfigDescriber: (describe: (options: ConnectionOptions) => string) => void;
  open: (portKey: string, options: ConnectionOptions) => Promise<void>;
  close: () => Promise<void>;
  send: (bytes: Uint8Array) => Promise<void>;
  setFraming: (config: Partial<FramingConfig>) => void;
  setReconnectSettings: (settings: { enabled: boolean }) => void;
  readonly pendingBytes: number;
  dispose: () => void;
}

/**
 * 周期发送。
 *
 * 浏览器里就是本页面的 TaskScheduler；VS Code 里必须跑在宿主进程 ——
 * 面板隐藏后 webview 连同定时器一起被销毁，而「挂个心跳跑一下午」正是常见用法。
 */
/**
 * 一个周期任务。
 *
 * `frames` 是这个任务要循环发的内容，按拍轮流取：单条循环、单条预设循环是长度 1，
 * 顺序循环是按勾选顺序排好的多条。**带 frames 的任务可以整个交给扩展宿主执行**，
 * 面板隐藏也照跑 —— 这是 VS Code 里唯一能让「挂个心跳跑一下午」成立的方式。
 *
 * `run` 是浏览器环境下的执行体，它每一拍重读最新状态，因此内容改动即时生效。
 * 宿主环境靠 update() 推送新的 frames 来达到同样效果。
 *
 * **frames 是必填的**，哪怕当前内容解析不通过（那就传空数组）。它曾经是可选的，
 * 于是三个调用点全都忘了传 —— 类型检查过、浏览器里一切正常，只有在 VS Code 里
 * 切个标签页才会发现循环停了。可选字段是那个 bug 唯一的入口，堵掉它比事后加测试更管用。
 */
export interface TaskSpec extends PeriodicTaskSpec {
  frames: Uint8Array[];
}

/** 改运行中任务的周期或内容。两者都可选，只改一样就只传一样。 */
export interface TaskPatch {
  intervalMs?: number;
  frames?: Uint8Array[];
}

export interface TasksLike {
  start: (id: string, spec: TaskSpec) => void;
  stop: (id: string) => void;
  stopAll: () => void;
  update: (id: string, patch: TaskPatch) => void;
  runningIds: () => string[];
  /** 运行中的任务集合发生变化时通知，UI 只读它。 */
  subscribe: (listener: (running: string[]) => void) => () => void;
}

/** 端口占用登记。浏览器里是尽力而为的广播，VS Code 里由宿主权威仲裁。 */
export interface LeasesLike {
  holders: () => LeaseHolders;
  claim: (identity: string) => void;
  release: () => void;
  refresh: () => void;
  subscribe: (listener: (holders: LeaseHolders) => void) => () => void;
  dispose: () => void;
}

export interface Platform {
  readonly kind: 'web' | 'vscode';
  /** 当前环境能不能操作串口。浏览器里等价于「有没有 Web Serial」。 */
  readonly supported: boolean;
  readonly session: SessionLike;
  readonly tasks: TasksLike;
  readonly leases: LeasesLike;
  listPorts: () => Promise<PortDescriptor[]>;
  /**
   * 让用户挑一个端口。取消时抛出 name 为 `NotFoundError` 的错误 ——
   * 与 Web Serial 的 `requestPort()` 保持一致，UI 侧不必分环境处理。
   */
  requestPort: () => Promise<PortDescriptor>;
  /** 订阅设备插拔。返回取消订阅函数。 */
  watchPorts: (onChange: () => void) => () => void;
}

let installed: Platform | null = null;

/**
 * 安装运行环境。**必须在任何 store 模块被求值之前调用**，
 * 因此 webview 入口是「先 setPlatform，再动态 import 界面」的两段式。
 * 浏览器不需要调用它：platform() 会懒装 Web 实现。
 */
export function setPlatform(next: Platform): void {
  installed = next;
}

/**
 * 取当前运行环境。没装过就懒装 Web 实现 —— 浏览器是默认场景，
 * 让它免去一道显式初始化，既有测试也就一行都不用改。
 */
export function platform(): Platform {
  installed ??= createWebPlatform();
  return installed;
}

/** 仅供测试重置。 */
export function __resetPlatformForTests(): void {
  installed = null;
}
