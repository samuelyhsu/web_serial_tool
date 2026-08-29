import type { FramingConfig } from '@/core/framing/frameAssembler';
import type { ConnectionOptions } from '@/core/transport/types';
import type { HostEvent, HostMessage, HostRequest, RequestBody } from '../shared/protocol';

/**
 * webview 这一侧的会话客户端。
 *
 * 它对界面暴露的方法，与浏览器版里 `SerialSession` 暴露给 store 的那套形状一致
 * （open / close / send / setFraming / setReconnectSettings…），差别只是方法体
 * 变成了一次 RPC。connectionStore 因此只需要换掉注入点，不必重写。
 *
 * 真正的会话活在宿主进程里：面板被隐藏时 webview 会被销毁，而串口不会断。
 * 界面重建后靠 `snapshot` 事件把状态和历史日志一次性拿回来。
 */

export interface SessionClientHandlers {
  onSnapshot: (event: Extract<HostEvent, { type: 'snapshot' }>) => void;
  onPorts: (event: Extract<HostEvent, { type: 'ports' }>) => void;
  onFrames: (event: Extract<HostEvent, { type: 'frames' }>) => void;
  onThroughput: (event: Extract<HostEvent, { type: 'throughput' }>) => void;
  onNotice: (event: Extract<HostEvent, { type: 'notice' }>) => void;
  onState: (event: Extract<HostEvent, { type: 'state' }>) => void;
  onSelected: (event: Extract<HostEvent, { type: 'selected' }>) => void;
  onTasks: (event: Extract<HostEvent, { type: 'tasks' }>) => void;
  onOpenPort: (event: Extract<HostEvent, { type: 'openPort' }>) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** 宿主报回来的错误，保留 kind 以便界面区分「被占用」与其他失败。 */
export class HostError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

export class SessionClient {
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #handlers: Partial<SessionClientHandlers> = {};

  constructor(private readonly post: (message: HostRequest) => void) {}

  setHandlers(handlers: Partial<SessionClientHandlers>): void {
    this.#handlers = handlers;
  }

  /** 由 window 的 message 事件驱动。 */
  receive(message: HostMessage): void {
    if (message.kind === 'response') {
      const pending = this.#pending.get(message.id);
      if (!pending) return; // 迟到的应答（面板重建过）：丢掉即可
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new HostError(message.error.kind, message.error.message));
      else pending.resolve(message.result);
      return;
    }

    switch (message.type) {
      case 'snapshot':
        // 面板重建后所有在途请求都不会再有应答了，先把它们了结掉，
        // 否则界面上会留下几个永远不 resolve 的 promise
        this.#rejectAll('panel reloaded');
        this.#handlers.onSnapshot?.(message);
        break;
      case 'ports':
        this.#handlers.onPorts?.(message);
        break;
      case 'frames':
        this.#handlers.onFrames?.(message);
        break;
      case 'throughput':
        this.#handlers.onThroughput?.(message);
        break;
      case 'notice':
        this.#handlers.onNotice?.(message);
        break;
      case 'state':
        this.#handlers.onState?.(message);
        break;
      case 'selected':
        this.#handlers.onSelected?.(message);
        break;
      case 'tasks':
        this.#handlers.onTasks?.(message);
        break;
      case 'openPort':
        this.#handlers.onOpenPort?.(message);
        break;
    }
  }

  /* ---------------- 与 SerialSession 同形的那部分 ---------------- */

  open(portKey: string, options: ConnectionOptions): Promise<void> {
    return this.#call({ method: 'session.open', portKey, options }).then(() => undefined);
  }

  close(): Promise<void> {
    return this.#call({ method: 'session.close' }).then(() => undefined);
  }

  send(bytes: Uint8Array): Promise<void> {
    return this.#call({ method: 'session.send', bytes }).then(() => undefined);
  }

  setFraming(framing: Partial<FramingConfig>): void {
    void this.#call({ method: 'session.setFraming', framing }).catch(() => undefined);
  }

  setReconnectSettings(settings: { enabled: boolean }): void {
    void this.#call({ method: 'session.setReconnect', enabled: settings.enabled }).catch(
      () => undefined,
    );
  }

  /* ---------------- 端口与偏好 ---------------- */

  /** 告诉宿主「界面起来了，可以发快照了」。 */
  ready(): Promise<void> {
    return this.#call({ method: 'ready' }).then(() => undefined);
  }

  refreshPorts(): Promise<void> {
    return this.#call({ method: 'ports.refresh' }).then(() => undefined);
  }

  /** 打开宿主的端口选择器。用户取消时返回 null。 */
  pickPort(): Promise<unknown> {
    return this.#call({ method: 'ports.pick' });
  }

  writePref(key: string, value: unknown): void {
    void this.#call({ method: 'prefs.write', key, value }).catch(() => undefined);
  }

  /* ---------------- 周期发送（在宿主进程里跑） ---------------- */

  startTask(taskId: string, frames: Uint8Array[], intervalMs: number): Promise<void> {
    return this.#call({ method: 'tasks.start', taskId, frames, intervalMs }).then(() => undefined);
  }

  updateTask(taskId: string, patch: { frames?: Uint8Array[]; intervalMs?: number }): Promise<void> {
    return this.#call({ method: 'tasks.update', taskId, ...patch }).then(() => undefined);
  }

  stopTask(taskId: string): Promise<void> {
    return this.#call({ method: 'tasks.stop', taskId }).then(() => undefined);
  }

  stopAllTasks(): Promise<void> {
    return this.#call({ method: 'tasks.stopAll' }).then(() => undefined);
  }

  #call(body: RequestBody): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.post({ kind: 'request', id, body });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #rejectAll(reason: string): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new HostError('aborted', reason));
    }
    this.#pending.clear();
  }
}
