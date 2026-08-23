import type { TransportError } from './errors';

export type Parity = 'none' | 'even' | 'odd';
export type FlowControl = 'none' | 'hardware';
export type TransportState = 'closed' | 'opening' | 'open' | 'closing';
/** local = 本地主动关闭；remote = 对端/设备消失；error = 因错误终止 */
export type CloseReason = 'local' | 'remote' | 'error';

export interface ConnectionOptions {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: Parity;
  flowControl: FlowControl;
  bufferSize?: number;
}

export interface TransportEvents {
  onData: (chunk: Uint8Array) => void;
  onError: (error: TransportError) => void;
  onClose: (reason: CloseReason) => void;
}

export interface Transport {
  readonly state: TransportState;
  /** 已进入写队列但尚未真正写出的字节数，背压的观测点（缺陷 D10）。 */
  readonly pendingBytes: number;
  open(options: ConnectionOptions): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  /** 返回取消订阅函数。 */
  subscribe(handlers: Partial<TransportEvents>): () => void;
}
