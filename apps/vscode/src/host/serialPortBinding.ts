import { SerialPort } from 'serialport';
import type { NodePortInfo } from '@/core/transport/nodePortRegistry';
import type { ConnectionOptions } from '@/core/transport/types';
import type { NodePortHandle, OpenNodePort } from './nodeSerialTransport';

/**
 * `serialport` 这个原生模块的唯一接触点。
 *
 * 单独成文件是有意的：`nodeSerialTransport.ts` 因此不 import 任何原生模块，
 * 可以在没有硬件、甚至没装 serialport 的环境里跑单元测试；而这个文件被
 * extension.ts 用动态 import 懒加载，原生模块在某些平台/架构上加载失败时
 * （@serialport/bindings-cpp 缺少对应预编译产物是这类扩展最高频的用户投诉）
 * 能被捕获成一条可操作的提示，而不是让整个扩展白屏。
 */

/**
 * 设备被拔出时 serialport 的 'close' 事件会带一个 `disconnected: true` 的错误对象；
 * 主动关闭则不带参数。这两者必须分清 —— 前者要触发重连，后者不能。
 */
function isDisconnect(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'disconnected' in error &&
    (error as { disconnected?: unknown }).disconnected === true
  );
}

function wrap(port: SerialPort): NodePortHandle {
  return {
    onData: (listener) => {
      // Buffer 常常只是一块池化内存的视图，直接持有会把整块池子一起 retain。
      // 复制一份的代价远小于「每帧几字节、实际吃掉整块池子」的内存放大。
      port.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk)));
    },
    onError: (listener) => {
      port.on('error', listener);
    },
    onClose: (listener) => {
      port.on('close', (error?: unknown) => listener({ disconnected: isDisconnect(error) }));
    },
    write: (data, callback) => {
      port.write(Buffer.from(data), callback);
    },
    close: (callback) => {
      // 设备已经拔了的话端口早就不是 open 了，再调 close 只会拿到一个意料之中的错误
      if (!port.isOpen) {
        callback();
        return;
      }
      port.close(callback);
    },
    dispose: () => {
      port.removeAllListeners();
    },
  };
}

export const openNodePort: OpenNodePort = (path, options: ConnectionOptions) =>
  new Promise<NodePortHandle>((resolve, reject) => {
    const port = new SerialPort({
      path,
      baudRate: options.baudRate,
      dataBits: options.dataBits,
      stopBits: options.stopBits,
      parity: options.parity,
      // Web Serial 的 flowControl: 'hardware' 对应 RTS/CTS
      rtscts: options.flowControl === 'hardware',
      // 自己控制打开时机，才能把失败准确地报回调用方
      autoOpen: false,
    });

    port.open((error) => {
      if (error) reject(error);
      else resolve(wrap(port));
    });
  });

export async function listNodePorts(): Promise<NodePortInfo[]> {
  const ports = await SerialPort.list();
  return ports.map((port) => ({
    path: port.path,
    manufacturer: port.manufacturer,
    serialNumber: port.serialNumber,
    vendorId: port.vendorId,
    productId: port.productId,
  }));
}
