import { chipName, hex16, vendorName } from './usbNames';

/**
 * 端口身份登记处 —— 缺陷 D1 的修复。
 *
 * 原型用 `"real:" + 数组下标` 当端口身份（.dc.html:459-466）。`navigator.serial.getPorts()`
 * 的返回顺序随插拔变化，下标一旦错位，下拉框里选中的还是同一项，实际打开的却是另一台设备。
 *
 * Web Serial 规范里同一底层设备在同一文档中始终返回同一个 SerialPort 对象实例
 * （https://wicg.github.io/serial/#dom-serial-getports），所以用 WeakMap 以对象为键
 * 分配稳定 id 即可，且端口对象被回收时条目自动消失。
 */

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

const keyByPort = new WeakMap<SerialPort, string>();
const portByKey = new Map<string, WeakRef<SerialPort>>();
/**
 * 端口对象被回收后清掉 portByKey 里的空壳 WeakRef。
 *
 * 没有它这张 Map 只增不减：WeakRef 本身不阻止回收，但键和空壳会永久留下。
 * 回调时机由 GC 决定，因此 portByStableKey() 里还有一道即时清理兜底。
 */
const reaper = new FinalizationRegistry<string>((key) => {
  portByKey.delete(key);
});
let counter = 0;

export function portKey(port: SerialPort): string {
  const existing = keyByPort.get(port);
  if (existing !== undefined) return existing;
  counter += 1;
  const key = `port-${counter}`;
  keyByPort.set(port, key);
  portByKey.set(key, new WeakRef(port));
  reaper.register(port, key);
  return key;
}

export function portByStableKey(key: string): SerialPort | undefined {
  const entry = portByKey.get(key);
  if (entry === undefined) return undefined;
  const port = entry.deref();
  // 引用已被回收：顺手清掉空壳，不必等 FinalizationRegistry
  if (port === undefined) portByKey.delete(key);
  return port;
}

/**
 * 生成端口描述。
 *
 * 能拿到的信息只有 VID/PID（或蓝牙服务 UUID），因此「更完整的显示」= 把这两个数字
 * 翻译成芯片名 / 厂商名，同时保留原始 VID:PID 以便用户与设备管理器核对。
 */
export function describePort(port: SerialPort, occurrence = 0): PortDescriptor {
  const key = portKey(port);
  const ordinal = Number(key.slice('port-'.length));

  let info: SerialPortInfo = {};
  try {
    info = port.getInfo();
  } catch {
    // getInfo() 在极少数实现里可能抛错；拿不到 VID/PID 只影响标签好看程度，不影响可用性
  }

  const { usbVendorId: vid, usbProductId: pid } = info;
  const chip = vid !== undefined && pid !== undefined ? chipName(vid, pid) : null;
  const vendor = vid !== undefined ? vendorName(vid) : null;

  let name: string;
  if (vid !== undefined && pid !== undefined) {
    const identity = `${hex16(vid)}:${hex16(pid)}`;
    // 芯片名最有用；只认得厂商时退而求其次；都不认识就只给原始 ID，不做猜测
    name = chip ? `${chip} (${identity})` : vendor ? `${vendor} (${identity})` : `USB ${identity}`;
  } else if (info.bluetoothServiceClassId !== undefined) {
    name = 'Bluetooth';
  } else {
    name = 'Serial';
  }

  return {
    key,
    ordinal,
    identity: `${identityBase(info)}#${occurrence}`,
    label: `#${ordinal} ${name}`,
    chip,
    vendor,
    // Web Serial 的 connected 属性在较老的 Chromium 上可能缺失，缺失时按在位处理
    connected: port.connected ?? true,
    ...(vid !== undefined ? { usbVendorId: vid } : {}),
    ...(pid !== undefined ? { usbProductId: pid } : {}),
    ...(info.bluetoothServiceClassId !== undefined
      ? { bluetoothServiceClassId: info.bluetoothServiceClassId }
      : {}),
  };
}

/**
 * 描述整个端口列表。
 *
 * 必须整表一起算，因为 identity 的出现序号要在「前缀相同的端口」之间分配。
 * 虚拟串口（com0com 之类）没有 VID/PID，前缀全是 `serial`，只有靠序号才能区分。
 */
export function describePorts(ports: readonly SerialPort[]): PortDescriptor[] {
  const seen = new Map<string, number>();
  return ports.map((port) => {
    let info: SerialPortInfo = {};
    try {
      info = port.getInfo();
    } catch {
      // 与 describePort 中同样的容错：拿不到信息不影响端口可用
    }
    const base = identityBase(info);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return describePort(port, occurrence);
  });
}

/**
 * identity 的前缀部分。刷新页面后 key 会变，它不会。
 *
 * 虚拟串口没有任何 USB 信息，只能落到通用前缀 `serial`，靠出现序号区分 ——
 * 这是浏览器所能提供的信息上限。
 */
export function identityBase(info: SerialPortInfo): string {
  if (info.usbVendorId !== undefined && info.usbProductId !== undefined) {
    return `usb:${hex16(info.usbVendorId)}:${hex16(info.usbProductId)}`;
  }
  if (info.bluetoothServiceClassId !== undefined) {
    return `bt:${String(info.bluetoothServiceClassId)}`;
  }
  return 'serial';
}

/** 仅供测试重置模块级计数器。 */
export function __resetPortRegistryForTests(): void {
  counter = 0;
  portByKey.clear();
}
