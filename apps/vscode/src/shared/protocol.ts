import type { FramingConfig } from '@/core/framing/frameAssembler';
import type { SessionNotice } from '@/core/session/notices';
import type { Direction, SessionState } from '@/core/session/serialSession';
import type { PortDescriptor } from '@/core/transport/portDescriptor';
import type { ConnectionOptions } from '@/core/transport/types';

/**
 * webview 与扩展宿主之间的消息协议。
 *
 * 边界放在 SerialSession 的**语义层**（打开 / 关闭 / 发送 / 收到帧），而不是
 * Transport 的字节层，原因只有一个：**VS Code 的 webview 一旦被隐藏就会被销毁**。
 * 会话、周期发送、日志缓冲都必须活在宿主进程里，否则用户切去看一眼代码回来，
 * 串口就断了、周期任务停了、日志空了。
 *
 * 两个刻意的设计：
 *  - **不带 sessionId**。每个 WebviewPanel 有自己独立的 postMessage 通道，
 *    宿主用 `Map<WebviewPanel, SessionHost>` 关联即可。多面板不需要在协议里编址。
 *  - **帧是攒批送的**。1 Mbps 下每帧一条消息会把消息通道打满，宿主按 60ms 攒一批。
 *
 * 字节用 `Uint8Array` 直接传：VS Code 1.57+ 会在接收端正确重建 typed array 并高效传输
 * （https://code.visualstudio.com/updates/v1_57）。更老的版本会把它退化成
 * `{0:1,1:2,…}` 的 JSON 对象，几 MB 数据就能把界面卡死 —— 这也是 engines.vscode
 * 定在 ^1.75 的原因之一。
 */

/* ---------------- webview → 宿主 ---------------- */

export type RequestBody =
  /**
   * 界面报到。
   *
   * 宿主在 webview 的脚本真正跑起来之前 postMessage 是会丢的，因此快照不能在建好
   * 面板时就推过去，得等这一声。面板被隐藏后重建时脚本会重跑，于是会再报到一次。
   */
  | { method: 'ready' }
  | { method: 'ports.refresh' }
  | { method: 'ports.pick' }
  | { method: 'session.open'; portKey: string; options: ConnectionOptions }
  | { method: 'session.close' }
  | { method: 'session.send'; bytes: Uint8Array }
  | { method: 'session.setFraming'; framing: Partial<FramingConfig> }
  | { method: 'session.setReconnect'; enabled: boolean }
  | { method: 'prefs.write'; key: string; value: unknown }
  /**
   * 周期发送。它必须由宿主执行而不是 webview：面板一旦被隐藏就会被销毁，
   * 定时器随之消失 —— 而「挂个心跳跑一下午」正是这类工具最常见的用法。
   *
   * 用**帧列表**而不是单帧来表达：单条循环、单条预设循环是长度为 1 的列表，
   * 顺序循环则是按勾选顺序排好的多条，宿主每一拍取下一条。一种形状覆盖三种用法。
   */
  | { method: 'tasks.start'; taskId: string; frames: Uint8Array[]; intervalMs: number }
  /**
   * 改运行中任务的内容或周期。
   *
   * 必须能改内容：浏览器版里每一拍都重读最新报文，用户在循环期间改一个字节即时生效。
   * 换成宿主执行后若把内容冻在启动那一刻，这条行为就悄悄丢了。
   */
  | { method: 'tasks.update'; taskId: string; frames?: Uint8Array[]; intervalMs?: number }
  | { method: 'tasks.stop'; taskId: string }
  | { method: 'tasks.stopAll' };

export type RequestMethod = RequestBody['method'];

export interface HostRequest {
  kind: 'request';
  /** 应答用的序号，webview 侧自增。 */
  id: number;
  body: RequestBody;
}

/* ---------------- 宿主 → webview ---------------- */

export interface HostResponse {
  kind: 'response';
  id: number;
  /** 失败时为 null；成功时是该方法的返回值（多数方法没有返回值）。 */
  result: unknown;
  error: { kind: string; message: string } | null;
}

/** 一帧数据。宿主已经做完分帧，webview 只负责渲染。 */
export interface FramePayload {
  direction: Direction;
  /** 毫秒时间戳。Date 对象过不了结构化克隆之外的序列化，一律用数字。 */
  at: number;
  bytes: Uint8Array;
}

export type HostEvent =
  /** 面板刚建好或被重新载入时的整体快照，含回放的历史日志。 */
  | {
      kind: 'event';
      type: 'snapshot';
      ports: PortDescriptor[];
      holders: Record<string, string>;
      selectedPortKey: string | null;
      options: ConnectionOptions;
      autoReconnect: boolean;
      state: SessionState;
      openedAt: number;
      /** 写队列里已排队未写出的字节数，背压的观测点。 */
      pendingBytes: number;
      frames: FramePayload[];
      runningTasks: string[];
      prefs: Record<string, unknown>;
      language: string;
    }
  | { kind: 'event'; type: 'ports'; ports: PortDescriptor[]; holders: Record<string, string> }
  /**
   * 攒批送来的帧，顺带捎上写队列的积压量。
   *
   * 背压是这类工具最有价值的诊断信号之一（WriteQueue 存在的全部理由），
   * 但它活在宿主进程里，webview 没法自己读。搭已有的事件捎回去，不必为它单开一路消息。
   */
  | { kind: 'event'; type: 'frames'; items: FramePayload[]; pendingBytes: number }
  | { kind: 'event'; type: 'throughput'; direction: Direction; byteCount: number }
  | { kind: 'event'; type: 'notice'; notice: SessionNotice }
  | { kind: 'event'; type: 'tasks'; running: string[] }
  /**
   * 宿主要求界面选中并打开某个端口。
   *
   * 活动栏的端口视图点一下就发这个。为什么不由宿主直接开：**该设备用什么波特率**
   * 存在界面那一侧（按设备存的参数存档），选中 + 套用参数 + 打开这条路径
   * 界面上本来就有一份，让宿主再写一遍必然会两边长歪。
   */
  | { kind: 'event'; type: 'openPort'; portKey: string }
  | { kind: 'event'; type: 'state'; state: SessionState; openedAt: number; pendingBytes: number }
  | {
      kind: 'event';
      type: 'selected';
      portKey: string | null;
      options: ConnectionOptions;
      autoReconnect: boolean;
    };

export type HostMessage = HostResponse | HostEvent;

/** 帧攒批间隔，与 Web 版 logStore 的提交节奏一致。 */
export const FRAME_BATCH_MS = 60;
