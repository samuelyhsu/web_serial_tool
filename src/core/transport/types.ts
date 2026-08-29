import type { TransportError } from './errors';

export type Parity = 'none' | 'even' | 'odd';
export type FlowControl = 'none' | 'hardware';
export type TransportState = 'closed' | 'opening' | 'open' | 'closing';
/** local = 本地主动关闭；remote = 对端/设备消失；error = 因错误终止 */
export type CloseReason = 'local' | 'remote' | 'error';

/**
 * 端口信息的最小公共形状。
 *
 * core 只依赖这个结构，两侧各自填自己能拿到的字段：
 *  - 浏览器（Web Serial）只给 VID/PID —— 序列号至今拿不到（WICG/serial#175）；
 *  - 桌面（Node + serialport）还能给出序列号与设备路径，因此设备身份可以做得更稳。
 *
 * `SerialPortInfo` 在结构上是它的子类型，所以既有调用方一行都不用改。
 */
export interface PortInfoLike {
  usbVendorId?: number | undefined;
  usbProductId?: number | undefined;
  bluetoothServiceClassId?: number | string | undefined;
  /** 桌面端才有：设备序列号，跨会话稳定，是最可靠的设备身份。 */
  serialNumber?: string | undefined;
  /** 桌面端才有：`COM3` / `/dev/ttyUSB0`。 */
  path?: string | undefined;
}

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
