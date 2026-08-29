/**
 * 端口描述与命名 —— 浏览器端与桌面端共用的部分。
 *
 * 与 portRegistry.ts（浏览器）/ nodePortRegistry.ts（桌面）分开放，是因为那两者
 * 能拿到的信息差别很大，而「VID/PID 怎么翻译成人话」「identity 前缀怎么算」
 * 两边完全一致。这个文件不认识任何一种运行环境的端口对象类型。
 */
import type { PortInfoLike } from './types';
import { chipName, hex16, vendorName } from './usbNames';

export interface PortDescriptor {
  /** 会话内稳定标识，跨多次 getPorts() 不变；但页面刷新后会重新分配。 */
  key: string;
  /**
   * 跨会话稳定的设备标识，用于持久化用户备注。
   *
   * 形如 `usb:1A86:7523#0` / `serial#1`：前半段来自 VID:PID（或蓝牙服务 UUID），
   * 后半段是同前缀端口中的出现序号。
   *
   * 加序号是必须的：浏览器不提供序列号（WICG/serial#175），而虚拟串口连 VID/PID
   * 都没有 —— 只用前半段的话，两个虚拟口、或两个同型号适配器会塌缩成同一个
   * identity，共用同一条备注。序号按 getPorts() 的返回顺序分配。
   */
  identity: string;
  /** 授权先后顺序，用于区分两个同型号适配器。 */
  ordinal: number;
  /** 完整的人类可读标签，如 "#1 CH340 (1A86:7523)"。 */
  label: string;
  /** 芯片型号，查不到为 null。 */
  chip: string | null;
  /** 厂商名，查不到为 null。 */
  vendor: string | null;
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: number | string;
  /** 设备当前是否物理在位。已授权但被拔掉的端口仍会留在列表里。 */
  connected: boolean;
}

/** 端口的可读命名，与运行环境无关：桌面端和浏览器端共用这一套。 */
export interface PortNaming {
  name: string;
  chip: string | null;
  vendor: string | null;
}

/**
 * 把 VID/PID 翻译成「芯片名 / 厂商名」。
 *
 * 能拿到的信息只有这两个数字，所谓「更完整的显示」就是把它们查成人话，
 * 同时保留原始 VID:PID 以便用户与设备管理器核对。查不到就只给原始 ID，不做猜测。
 */
export function describeName(info: PortInfoLike): PortNaming {
  const { usbVendorId: vid, usbProductId: pid } = info;
  const chip = vid !== undefined && pid !== undefined ? chipName(vid, pid) : null;
  const vendor = vid !== undefined ? vendorName(vid) : null;

  let name: string;
  if (vid !== undefined && pid !== undefined) {
    const identity = `${hex16(vid)}:${hex16(pid)}`;
    // 芯片名最有用；只认得厂商时退而求其次
    name = chip ? `${chip} (${identity})` : vendor ? `${vendor} (${identity})` : `USB ${identity}`;
  } else if (info.bluetoothServiceClassId !== undefined) {
    name = 'Bluetooth';
  } else {
    name = 'Serial';
  }
  return { name, chip, vendor };
}

/**
 * identity 的前缀部分。刷新页面后 key 会变，它不会。
 *
 * 虚拟串口没有任何 USB 信息，只能落到通用前缀 `serial`，靠出现序号区分 ——
 * 这是浏览器所能提供的信息上限。
 */
export function identityBase(info: PortInfoLike): string {
  if (info.usbVendorId !== undefined && info.usbProductId !== undefined) {
    return `usb:${hex16(info.usbVendorId)}:${hex16(info.usbProductId)}`;
  }
  if (info.bluetoothServiceClassId !== undefined) {
    return `bt:${String(info.bluetoothServiceClassId)}`;
  }
  return 'serial';
}
