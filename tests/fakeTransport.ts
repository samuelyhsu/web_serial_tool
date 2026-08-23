import { TransportError } from '@/core/transport/errors';
import type {
  CloseReason,
  ConnectionOptions,
  Transport,
  TransportEvents,
  TransportState,
} from '@/core/transport/types';

/**
 * 测试替身：实现与 WebSerialTransport 完全相同的 Transport 接口。
 *
 * 它让「打开 → 收帧 → 掉线 → 退避重连 → 恢复」这条最容易出错、又最难在真机上复现的
 * 链路可以在 CI 里跑成确定性测试。注意它只存在于 tests/ 下，不会被打进产物。
 */
export class FakeTransport implements Transport {
  state: TransportState = 'closed';
  pendingBytes = 0;

  readonly written: Uint8Array[] = [];
  readonly openCalls: ConnectionOptions[] = [];
  /** 设为非 null 时，下一次 open() 会以该错误失败（用于测试重连的失败分支）。 */
  failNextOpen: Error | null = null;

  readonly #handlers = new Set<Partial<TransportEvents>>();
  #openGate: Promise<void> | null = null;
  /** 配合 blockOpen()：调用后 open() 才继续。 */
  releaseOpen: () => void = () => undefined;

  /** 让下一次 open() 挂起，模拟驱动打开端口需要时间。 */
  blockOpen(): void {
    this.#openGate = new Promise<void>((resolve) => {
      this.releaseOpen = resolve;
    });
  }

  async open(options: ConnectionOptions): Promise<void> {
    if (this.#openGate) {
      const gate = this.#openGate;
      this.#openGate = null;
      await gate;
    }
    if (this.failNextOpen) {
      const error = this.failNextOpen;
      this.failNextOpen = null;
      this.state = 'closed';
      return Promise.reject(error);
    }
    this.openCalls.push(options);
    this.state = 'open';
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve();
    this.state = 'closed';
    this.#emit((h) => h.onClose?.('local'));
    return Promise.resolve();
  }

  write(data: Uint8Array): Promise<void> {
    if (this.state !== 'open') {
      return Promise.reject(new TransportError('invalid-state', 'Port is not open'));
    }
    this.written.push(data);
    return Promise.resolve();
  }

  subscribe(handlers: Partial<TransportEvents>): () => void {
    this.#handlers.add(handlers);
    return () => this.#handlers.delete(handlers);
  }

  /* ---------- 测试驱动接口 ---------- */

  /** 模拟设备发来一段数据。 */
  emitData(bytes: Uint8Array | number[]): void {
    const chunk = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.#emit((h) => h.onData?.(chunk));
  }

  emitError(error: TransportError): void {
    this.#emit((h) => h.onError?.(error));
  }

  /** 模拟设备被拔出：非本地原因的关闭。 */
  emitUnplug(reason: CloseReason = 'remote'): void {
    this.state = 'closed';
    this.#emit((h) => h.onClose?.(reason));
  }

  /** 拒绝写入（模拟背压）。 */
  rejectWritesWith(error: TransportError): void {
    this.write = () => Promise.reject(error);
  }

  #emit(fn: (handlers: Partial<TransportEvents>) => void): void {
    for (const handlers of [...this.#handlers]) fn(handlers);
  }
}

export const TEST_OPTIONS: ConnectionOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};
