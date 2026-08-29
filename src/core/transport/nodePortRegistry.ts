import { describeName, identityBase, type PortDescriptor } from './portDescriptor';
import type { PortInfoLike } from './types';

/**
 * 桌面端（Node + serialport）的端口描述。
 *
 * 与浏览器那套（portRegistry.ts）并列而不是共用，因为两者能拿到的信息差别很大：
 *
 *  - **key**：浏览器只能靠 WeakMap 给端口对象分配运行时 id，刷新即失效；
 *    桌面端直接就是设备路径（`COM3` / `/dev/ttyUSB0`），本来就是打开设备用的东西。
 *  - **identity**：浏览器拿不到序列号（WICG/serial#175），只能用 `VID:PID#出现序号`
 *    凑合，两个同型号适配器换个顺序插就会串味；桌面端有真实序列号，
 *    `usb:VID:PID:序列号` 是真正跨会话、跨插拔稳定的身份。
 *  - **label**：浏览器没有端口名，只能显示 `#1 CH340`；桌面端有 `COM3`，
 *    与设备管理器里看到的完全一致。
 *
 * 命名（VID/PID → 芯片名 / 厂商名）两侧共用 describeName()。
 */

/** `SerialPort.list()` 返回的条目里我们用得上的部分。 */
export interface NodePortInfo {
  path: string;
  manufacturer?: string | undefined;
  serialNumber?: string | undefined;
  /** serialport 给的是不带 0x 的十六进制字符串，如 `1a86`；个别平台会带 `0x`。 */
  vendorId?: string | undefined;
  productId?: string | undefined;
}

/** 把 serialport 的十六进制字符串转成数字；转不出来就当没有。 */
function parseHexId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.replace(/^0x/i, ''), 16);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function toPortInfo(port: NodePortInfo): PortInfoLike {
  return {
    usbVendorId: parseHexId(port.vendorId),
    usbProductId: parseHexId(port.productId),
    serialNumber: port.serialNumber,
    path: port.path,
  };
}

/**
 * 设备身份，按可靠程度依次降级：
 *
 *  1. `usb:1A86:7523:SN0123` —— 有序列号。换个 USB 口、换台机器都认得出来。
 *  2. `usb:1A86:7523#0` —— 没有序列号（很多廉价 CH340 就是如此），
 *     退回与浏览器端相同的「出现序号」方案。
 *  3. `path:COM5` —— 连 VID/PID 都没有的虚拟串口（com0com、socat 之类）。
 *     路径就是它最稳定的身份了。
 */
function identityOf(info: PortInfoLike, path: string, occurrence: number): string {
  const base = identityBase(info);
  if (base === 'serial') return `path:${path}`;
  if (info.serialNumber !== undefined && info.serialNumber !== '') {
    return `${base}:${info.serialNumber}`;
  }
  return `${base}#${occurrence}`;
}

/**
 * 描述整个端口列表。
 *
 * 必须整表一起算：没有序列号时 identity 要在「前缀相同的端口」之间分配出现序号，
 * 单看一个端口是算不出来的。
 */
export function describeNodePorts(ports: readonly NodePortInfo[]): PortDescriptor[] {
  const seen = new Map<string, number>();

  return ports.map((port, index) => {
    const info = toPortInfo(port);
    const base = identityBase(info);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);

    const { name, chip, vendor } = describeName(info);
    // 认不出芯片和厂商时 name 只是个「Serial」，挂在路径后面纯属噪音
    const label = name === 'Serial' ? port.path : `${port.path} · ${name}`;

    return {
      key: port.path,
      identity: identityOf(info, port.path, occurrence),
      ordinal: index + 1,
      label,
      chip,
      // 查不到厂商时退回驱动报上来的 manufacturer，聊胜于无
      vendor: vendor ?? port.manufacturer ?? null,
      // list() 只返回当前在位的端口，能列出来就是插着的
      connected: true,
      ...(info.usbVendorId !== undefined ? { usbVendorId: info.usbVendorId } : {}),
      ...(info.usbProductId !== undefined ? { usbProductId: info.usbProductId } : {}),
    };
  });
}
