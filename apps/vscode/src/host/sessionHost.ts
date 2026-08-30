import { RingBuffer } from '@/core/buffer/ringBuffer';
import { TaskScheduler } from '@/core/scheduler/taskScheduler';
import { SerialSession, type SessionState } from '@/core/session/serialSession';
import { TransportError } from '@/core/transport/errors';
import type { PortDescriptor } from '@/core/transport/portDescriptor';
import type { ConnectionOptions, Transport } from '@/core/transport/types';
import {
  FRAME_BATCH_MS,
  type FramePayload,
  type HostEvent,
  type RequestBody,
} from '../shared/protocol';
import type { PortLeases } from './portLeases';
import type { PortWatcher } from './portWatcher';

/**
 * 一个面板背后的一切：串口会话、日志环形缓冲、周期发送。
 *
 * **它活在宿主进程，不在 webview 里**，这是整个架构的支点。VS Code 的 webview
 * 一旦被隐藏就会被销毁：会话若放在 webview，用户切去看一眼代码回来就会发现
 * 串口断了、心跳停了、日志空了。放在宿主之后，面板只是一个可以随时重建的视图，
 * 重建时用 snapshot() 把历史回放回去即可。
 *
 * 多面板不需要在协议里编址：每个 WebviewPanel 有自己独立的 postMessage 通道，
 * 宿主拿 `Map<WebviewPanel, SessionHost>` 关联，一个 SessionHost 只服务一个面板。
 */

/** 与 Web 版 logStore 一致的日志容量。 */
export const LOG_CAPACITY = 5000;

export interface SessionHostDeps {
  /** 面板 id，同时是占用表里的持有者标识。 */
  id: string;
  leases: PortLeases;
  watcher: PortWatcher;
  /** 按设备路径建传输层。注入进来，测试里换成 FakeTransport。 */
  createTransport: (path: string) => Transport;
  /** 把消息发给这个面板自己的 webview。 */
  post: (message: HostEvent) => void;
  /** 打开浏览器/编辑器的端口选择器，返回用户选中的端口。 */
  pickPort: () => Promise<PortDescriptor | undefined>;
  readPrefs: () => Record<string, unknown>;
  writePref: (key: string, value: unknown) => void;
  language: string;
  defaultOptions: ConnectionOptions;
  now?: () => number;
}

export class SessionHost {
  readonly #session: SerialSession<string>;
  readonly #ring = new RingBuffer<FramePayload>(LOG_CAPACITY);
  readonly #scheduler = new TaskScheduler();
  /** 攒批中的帧。1 Mbps 下每帧一条 postMessage 会把消息通道打满。 */
  #pending: FramePayload[] = [];
  /**
   * 每个周期任务要发的帧，以及它发到第几条了。
   *
   * 内容单独放在这张表里、而不是闭进任务的执行体，是为了「循环期间改报文即时生效」：
   * 换内容只是改这里一个值，不必停掉再重启任务 —— 重启会把节拍打回原点，
   * 用户改一个字节就多发一帧。
   */
  readonly #taskFrames = new Map<string, { frames: Uint8Array[]; cursor: number }>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #unwatch: (() => void) | null = null;
  #unlease: (() => void) | null = null;

  #selectedPortKey: string | null = null;
  #options: ConnectionOptions;
  #autoReconnect = true;
  #state: SessionState = 'closed';
  #openedAt = 0;

  constructor(private readonly deps: SessionHostDeps) {
    this.#options = deps.defaultOptions;

    this.#session = new SerialSession<string>({
      createTransport: (path) => deps.createTransport(path),
      // 重连时按设备路径重新解析。路径还在列表里才算这台设备回来了 ——
      // 拔掉后 COM3 会从枚举里消失，此时不该傻等一个不存在的口
      resolvePort: (portKey) =>
        Promise.resolve(
          this.deps.watcher.current().some((port) => port.key === portKey) ? portKey : undefined,
        ),
      describeConfig: (options) => this.#describeConfig(options),
    });

    this.#session.setHandlers({
      onFrame: (direction, bytes) => this.#pushFrame(direction, bytes),
      onThroughput: (direction, byteCount) =>
        deps.post({ kind: 'event', type: 'throughput', direction, byteCount }),
      onNotice: (notice) => {
        this.#flush(); // 通知是对操作的反馈，不该排在攒批的帧后面
        deps.post({ kind: 'event', type: 'notice', notice });
      },
      onStateChange: (state) => this.#onStateChange(state),
    });

    this.#unwatch = deps.watcher.subscribe((ports) => {
      deps.post({
        kind: 'event',
        type: 'ports',
        ports: [...ports],
        holders: deps.leases.holders(),
      });
    });

    this.#unlease = deps.leases.subscribe((holders) => {
      deps.post({
        kind: 'event',
        type: 'ports',
        ports: [...deps.watcher.current()],
        holders,
      });
    });
  }

  /** 面板刚建好、或被隐藏后重建时，用它把状态与历史一次性交回去。 */
  snapshot(): HostEvent {
    this.#flush();
    return {
      kind: 'event',
      type: 'snapshot',
      ports: [...this.deps.watcher.current()],
      holders: this.deps.leases.holders(),
      selectedPortKey: this.#selectedPortKey,
      options: this.#options,
      autoReconnect: this.#autoReconnect,
      state: this.#state,
      openedAt: this.#openedAt,
      pendingBytes: this.pendingBytes,
      frames: this.#ring.toArray(),
      runningTasks: this.#scheduler.runningIds(),
      prefs: this.deps.readPrefs(),
      language: this.deps.language,
    };
  }

  get id(): string {
    return this.deps.id;
  }

  get portKey(): string | null {
    return this.#selectedPortKey;
  }

  get state(): SessionState {
    return this.#state;
  }

  /** 写队列的积压字节数。界面靠它显示背压，值在这一侧，只能捎回去。 */
  get pendingBytes(): number {
    return this.#session.pendingBytes;
  }

  /**
   * 连 / 断，用**本面板自己当前的参数**。
   *
   * 命令面板与快捷键走这里，而不是自己拼一条 `session.open` —— 那条路径手里没有参数，
   * 只能塞一份默认值进来，于是用户在界面上调好的波特率被静默换成 115200；
   * 更糟的是 `#options` 也跟着被写坏，面板下次重建时回放的还是这份错的。
   * 把参数留在唯一知道它的人手里，这个缺陷就没有入口了。
   */
  async toggle(): Promise<'opened' | 'closed' | 'no-port'> {
    if (this.#state !== 'closed') {
      await this.#close();
      return 'closed';
    }
    const portKey = this.#selectedPortKey;
    if (portKey === null) return 'no-port';
    await this.#open(portKey, this.#options);
    return 'opened';
  }

  async handle(body: RequestBody): Promise<unknown> {
    switch (body.method) {
      case 'ready':
        this.deps.post(this.snapshot());
        return undefined;

      case 'ports.refresh':
        await this.deps.watcher.refresh();
        return undefined;

      case 'ports.pick': {
        const port = await this.deps.pickPort();
        if (port) this.#select(port.key);
        return port ?? null;
      }

      case 'session.open':
        return this.#open(body.portKey, body.options);

      case 'session.close':
        await this.#close();
        return undefined;

      case 'session.send':
        await this.#session.send(body.bytes);
        return undefined;

      case 'session.setFraming':
        this.#session.setFraming(body.framing);
        return undefined;

      case 'session.setReconnect':
        this.#autoReconnect = body.enabled;
        this.#session.setReconnectSettings({ enabled: body.enabled });
        return undefined;

      case 'prefs.write':
        this.deps.writePref(body.key, body.value);
        return undefined;

      case 'tasks.start':
        this.#startTask(body.taskId, body.frames, body.intervalMs);
        return undefined;

      case 'tasks.update':
        this.#updateTask(body.taskId, body.frames, body.intervalMs);
        return undefined;

      case 'tasks.stop':
        this.#scheduler.stop(body.taskId);
        this.#taskFrames.delete(body.taskId);
        this.#postTasks();
        return undefined;

      case 'tasks.stopAll':
        this.#stopAllTasks();
        return undefined;
    }
  }

  dispose(): void {
    this.#scheduler.stopAll();
    this.#taskFrames.clear();
    this.#unwatch?.();
    this.#unlease?.();
    this.#unwatch = null;
    this.#unlease = null;
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    this.#session.dispose();
    this.deps.leases.release(this.deps.id);
  }

  async #open(portKey: string, options: ConnectionOptions): Promise<void> {
    // 权威占用表说了算：本工具的另一个面板正开着这个口时，连试都不必试。
    // 外部程序（PuTTY 之类）占用的口这里看不见，仍然只能靠 open() 失败兜底。
    if (!this.deps.leases.acquire(portKey, this.deps.id)) {
      this.deps.post({ kind: 'event', type: 'notice', notice: { code: 'port-busy' } });
      throw new TransportError('invalid-state', `${portKey} is held by another panel`);
    }

    // 顺序要紧：先落参数再广播。反过来的话 #select 发出的 `selected` 带的是**上一次**
    // 的参数，界面照着它显示就与实际打开的对不上；而且同一个口换个波特率重开时
    // #select 还会因为 portKey 没变直接短路，界面连这一条都收不到
    this.#selectedPortKey = portKey;
    this.#options = options;
    this.#postSelected();
    this.#session.setReconnectSettings({ enabled: this.#autoReconnect });

    try {
      await this.#session.open(portKey, portKey, options);
      this.#openedAt = this.#now();
    } catch (error) {
      // 打开失败就把占用还回去，否则这个口会被一次失败的尝试锁死
      this.deps.leases.release(this.deps.id);
      this.#openedAt = 0;
      throw error;
    }
  }

  async #close(): Promise<void> {
    this.#stopAllTasks();
    await this.#session.close();
    this.#openedAt = 0;
  }

  #onStateChange(state: SessionState): void {
    this.#state = state;

    // 链路不再可用时周期发送必须跟着停，否则会持续刷「串口未打开」
    if (state === 'closed' || state === 'reconnecting') {
      this.#stopAllTasks();
    }
    // 'reconnecting' 期间端口仍归本面板所有（马上要重连回去），只有真正关闭才放手
    if (state === 'closed') {
      this.#openedAt = 0;
      this.deps.leases.release(this.deps.id);
      // 刚放掉的口应该立刻在别的面板里变成可选，不必等下一次轮询
      void this.deps.watcher.refresh();
    }

    this.deps.post({
      kind: 'event',
      type: 'state',
      state,
      openedAt: this.#openedAt,
      // 关闭时队列已排空，这条顺带把界面上的积压读数清零
      pendingBytes: this.pendingBytes,
    });
  }

  #startTask(taskId: string, frames: Uint8Array[], intervalMs: number): void {
    // 允许以空列表启动：报文当前解析不通过时，浏览器版也是「循环转着但不发东西」，
    // 等用户把内容改对了再开始发。这里靠 update() 补上内容达到同样效果。
    this.#taskFrames.set(taskId, { frames, cursor: 0 });

    this.#scheduler.start(taskId, {
      intervalMs,
      run: () => this.#runTask(taskId),
      onError: () => {
        // 发送失败已经由 session 通过 write-error 通知写进日志了，这里不再重复
      },
    });
    this.#postTasks();
  }

  /**
   * 发下一帧。
   *
   * 单条循环是长度 1 的列表，取模之后永远是同一帧；顺序循环则每拍前进一条。
   * 一种形状覆盖两种用法，宿主这边不必知道调用方是哪一种。
   */
  #runTask(taskId: string): Promise<void> {
    const state = this.#taskFrames.get(taskId);
    if (!state || state.frames.length === 0) return Promise.resolve();
    const frame = state.frames[state.cursor % state.frames.length]!;
    state.cursor += 1;
    return this.#session.send(frame);
  }

  /** 改运行中任务的内容或周期。任务没在跑时什么都不做。 */
  #updateTask(taskId: string, frames?: Uint8Array[], intervalMs?: number): void {
    if (!this.#scheduler.isRunning(taskId)) return;
    if (frames !== undefined) {
      const state = this.#taskFrames.get(taskId);
      // 保留 cursor：顺序循环期间增删预设不该让它跳回第一条
      this.#taskFrames.set(taskId, { frames, cursor: state?.cursor ?? 0 });
    }
    if (intervalMs !== undefined) this.#scheduler.updateInterval(taskId, intervalMs);
  }

  #stopAllTasks(): void {
    this.#scheduler.stopAll();
    this.#taskFrames.clear();
    this.#postTasks();
  }

  #postTasks(): void {
    this.deps.post({ kind: 'event', type: 'tasks', running: this.#scheduler.runningIds() });
  }

  #select(portKey: string | null): void {
    if (this.#selectedPortKey === portKey) return;
    this.#selectedPortKey = portKey;
    this.#postSelected();
  }

  /** 把当前的选中端口与参数告诉界面。命令面板那条路径不经过界面，只能靠它同步。 */
  #postSelected(): void {
    this.deps.post({
      kind: 'event',
      type: 'selected',
      portKey: this.#selectedPortKey,
      options: this.#options,
      autoReconnect: this.#autoReconnect,
    });
  }

  #pushFrame(direction: FramePayload['direction'], bytes: Uint8Array): void {
    const frame: FramePayload = { direction, at: this.#now(), bytes };
    this.#ring.push(frame);
    this.#pending.push(frame);
    this.#flushTimer ??= setTimeout(() => this.#flush(), FRAME_BATCH_MS);
  }

  #flush(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#pending.length === 0) return;
    const items = this.#pending;
    this.#pending = [];
    this.deps.post({
      kind: 'event',
      type: 'frames',
      items,
      pendingBytes: this.pendingBytes,
    });
  }

  #describeConfig(options: ConnectionOptions): string {
    const parity = options.parity === 'none' ? 'N' : options.parity === 'even' ? 'E' : 'O';
    const label =
      this.deps.watcher.current().find((port) => port.key === this.#selectedPortKey)?.label ??
      this.#selectedPortKey ??
      '—';
    return `${label} @ ${options.baudRate} ${options.dataBits}${parity}${options.stopBits}`;
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
