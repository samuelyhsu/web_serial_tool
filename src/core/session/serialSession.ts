import { ReconnectController } from '../scheduler/reconnectController';
import { TransportError } from '../transport/errors';
import type { ConnectionOptions, Transport } from '../transport/types';
import type { SessionNotice } from './notices';

export type SessionState = 'closed' | 'opening' | 'open' | 'reconnecting';
export type Direction = 'rx' | 'tx';

export interface SessionEvents {
  /** 一帧数据（RX 为驱动的一次交付；TX 为一次写入的整体）。 */
  onFrame: (direction: Direction, bytes: Uint8Array) => void;
  /** 链路上实际流过的字节数，用于速率统计。 */
  onThroughput: (direction: Direction, byteCount: number) => void;
  onNotice: (notice: SessionNotice) => void;
  onStateChange: (state: SessionState) => void;
}

export interface ReconnectSettings {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export const DEFAULT_RECONNECT: ReconnectSettings = {
  enabled: true,
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitterRatio: 0.2,
};

export interface SerialSessionDeps {
  /** 注入传输层工厂：生产环境是 WebSerialTransport，测试用 FakeTransport。 */
  createTransport: (port: SerialPort) => Transport;
  /**
   * 重连时按稳定 key 重新解析端口对象。由调用方（store）用 navigator.serial.getPorts()
   * 实现，core 层不碰 navigator。
   */
  resolvePort: (portKey: string) => Promise<SerialPort | undefined>;
  /** 生成端口配置摘要，用于「串口已打开 #1 @ 115200 8N1」这类通知。 */
  describeConfig: (options: ConnectionOptions) => string;
}

/**
 * 一次串口会话：把 Transport（字节流）与 ReconnectController（断线重连）编排在一起，
 * 对外只暴露「打开 / 关闭 / 发送 / 收到数据」这一层语义。
 *
 * 接收侧采用原样分块：驱动每交付一次数据就上报一帧，不缓冲、不拼接、不按分隔符切分。
 *
 * 它是纯 TS 的：不依赖 React、不碰 DOM、不认识 navigator，因此可以用 FakeTransport
 * 在 node 下把「打开→收帧→掉线→退避重连→恢复」整条链路跑成单元测试。
 */
export class SerialSession {
  #state: SessionState = 'closed';
  #transport: Transport | null = null;
  #unsubscribe: (() => void) | null = null;
  #portKey: string | null = null;
  #options: ConnectionOptions | null = null;
  #reconnect: ReconnectSettings = DEFAULT_RECONNECT;
  #reconnectController: ReconnectController | null = null;
  #handlers: Partial<SessionEvents> = {};
  /**
   * 每次 close() / dispose() 递增，让「在途的打开流程」作废。
   *
   * 打开一个串口可能耗时几百毫秒，重连尝试更是随时在跑。若用户恰好在这期间点了关闭，
   * close() 会先把链路拆掉，而那条迟到的 open() 随后仍会把状态写回 'open' ——
   * 界面显示已连接、实际却没有 transport。代际号让迟到者认出自己已被接管。
   */
  #generation = 0;

  constructor(private readonly deps: SerialSessionDeps) {}

  get state(): SessionState {
    return this.#state;
  }

  get portKey(): string | null {
    return this.#portKey;
  }

  get pendingBytes(): number {
    return this.#transport?.pendingBytes ?? 0;
  }

  setHandlers(handlers: Partial<SessionEvents>): void {
    this.#handlers = handlers;
  }

  setReconnectSettings(settings: Partial<ReconnectSettings>): void {
    this.#reconnect = { ...this.#reconnect, ...settings };
    if (!this.#reconnect.enabled) {
      this.#reconnectController?.cancel();
      if (this.#state === 'reconnecting') this.#setState('closed');
    }
  }

  async open(port: SerialPort, portKey: string, options: ConnectionOptions): Promise<void> {
    if (this.#state !== 'closed') {
      throw new TransportError('invalid-state', `Session is already ${this.#state}`);
    }
    const generation = this.#generation;
    this.#portKey = portKey;
    this.#options = options;
    this.#setState('opening');
    try {
      await this.#attach(port, options);
    } catch (error) {
      // 已被 close() 接管时不要再改状态：那会把它从 'closed' 拽回来
      if (generation === this.#generation) {
        this.#setState('closed');
        this.#notify({ code: 'open-failed', message: describeError(error) });
      }
      throw error;
    }
    // 打开途中用户点了关闭：close() 已经拆掉并关闭了这条链路，不能复活成 open
    if (generation !== this.#generation) return;
    this.#setState('open');
    this.#notify({ code: 'port-opened', config: this.deps.describeConfig(options) });
  }

  async close(): Promise<void> {
    this.#generation += 1; // 作废在途的 open()／重连尝试
    this.#reconnectController?.cancel();
    this.#reconnectController = null;
    if (this.#state === 'closed') return;

    const transport = this.#transport;
    this.#detach();
    this.#setState('closed');
    if (transport) await transport.close();
    this.#notify({ code: 'port-closed' });
  }

  /** 发送一帧。写队列满时不抛异常，而是回一条可见的背压通知（缺陷 D10）。 */
  async send(bytes: Uint8Array): Promise<void> {
    if (this.#state !== 'open' || !this.#transport) {
      this.#notify({ code: 'not-open' });
      return;
    }
    if (bytes.length === 0) return;

    const transport = this.#transport;
    try {
      await transport.write(bytes);
      this.#handlers.onFrame?.('tx', bytes);
      this.#handlers.onThroughput?.('tx', bytes.length);
    } catch (error) {
      if (error instanceof TransportError && error.kind === 'backpressure') {
        this.#notify({ code: 'write-dropped-backpressure', pendingBytes: transport.pendingBytes });
        return;
      }
      this.#notify({ code: 'write-error', message: describeError(error) });
    }
  }

  dispose(): void {
    this.#generation += 1;
    this.#reconnectController?.cancel();
    this.#reconnectController = null;
    this.#detach();
    this.#state = 'closed';
  }

  async #attach(port: SerialPort, options: ConnectionOptions): Promise<void> {
    const generation = this.#generation;
    const transport = this.deps.createTransport(port);
    const unsubscribe = transport.subscribe({
      onData: (chunk) => {
        // 原样分块：驱动每交付一次数据就是一帧，不做缓冲也不做拼接
        this.#handlers.onThroughput?.('rx', chunk.length);
        this.#handlers.onFrame?.('rx', chunk);
      },
      onError: (error) => {
        if (error.kind === 'read') {
          this.#notify({ code: 'read-error', message: error.message });
        } else if (error.kind === 'close-failed') {
          this.#notify({ code: 'write-error', message: error.message });
        }
      },
      onClose: (reason) => {
        if (reason === 'local') return; // 本地关闭由 close() 自己收尾
        this.#handleConnectionLost();
      },
    });
    this.#unsubscribe = unsubscribe;
    this.#transport = transport;
    await transport.open(options);

    // 打开期间被 close()/dispose() 接管了。此时上层已经不再持有这条链路，
    // 必须就地关掉：留一个没人管的 transport 意味着端口被独占到刷新页面为止。
    if (generation !== this.#generation) {
      unsubscribe();
      if (this.#unsubscribe === unsubscribe) this.#unsubscribe = null;
      if (this.#transport === transport) this.#transport = null;
      await transport.close().catch(() => undefined);
      throw new TransportError('invalid-state', 'Session was closed while opening');
    }
  }

  #detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#transport = null;
  }

  #handleConnectionLost(): void {
    this.#detach();
    this.#notify({ code: 'connection-lost' });

    if (!this.#reconnect.enabled || !this.#portKey || !this.#options) {
      this.#setState('closed');
      return;
    }
    this.#setState('reconnecting');
    this.#startReconnect();
  }

  #startReconnect(): void {
    const portKey = this.#portKey;
    const options = this.#options;
    if (!portKey || !options) return;

    this.#reconnectController?.cancel();
    this.#reconnectController = new ReconnectController({
      maxAttempts: this.#reconnect.maxAttempts,
      baseDelayMs: this.#reconnect.baseDelayMs,
      maxDelayMs: this.#reconnect.maxDelayMs,
      jitterRatio: this.#reconnect.jitterRatio,
      attempt: async () => {
        // 按稳定 key 重新解析端口：设备重新枚举后实例可能变，但 key 不变（缺陷 D1）
        const port = await this.deps.resolvePort(portKey);
        if (!port) throw new TransportError('open-failed', 'Port is no longer available');
        await this.#attach(port, options);
      },
      onScheduled: (attempt, delayMs) => {
        this.#notify({
          code: 'reconnect-scheduled',
          attempt,
          max: this.#reconnect.maxAttempts,
          delayMs,
        });
      },
      onSuccess: (attempt) => {
        this.#setState('open');
        this.#notify({ code: 'reconnect-succeeded', attempt });
      },
      onFailure: () => {
        this.#detach();
      },
      onGiveUp: (attempts) => {
        this.#setState('closed');
        this.#notify({ code: 'reconnect-gave-up', attempts });
      },
    });
    this.#reconnectController.start();
  }

  #setState(state: SessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#handlers.onStateChange?.(state);
  }

  #notify(notice: SessionNotice): void {
    this.#handlers.onNotice?.(notice);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
