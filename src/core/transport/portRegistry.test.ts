import { beforeEach, describe, expect, it } from 'vitest';
import { asSerialPort, FakeSerialPort } from '../../../tests/fakeSerialPort';
import {
  __resetPortRegistryForTests,
  describePort,
  describePorts,
  identityBase,
  portByStableKey,
  portKey,
} from './portRegistry';

describe('portRegistry', () => {
  beforeEach(() => {
    __resetPortRegistryForTests();
  });

  it('同一个端口对象永远得到同一个 key', () => {
    const port = asSerialPort(new FakeSerialPort());
    expect(portKey(port)).toBe(portKey(port));
  });

  it('不同端口得到不同 key', () => {
    const a = asSerialPort(new FakeSerialPort());
    const b = asSerialPort(new FakeSerialPort());
    expect(portKey(a)).not.toBe(portKey(b));
  });

  /**
   * 缺陷 D1 的核心：原型用 getPorts() 返回数组的下标当端口身份。
   * 设备插拔后顺序变化，下拉框里选中的还是同一项，实际打开的却是另一台设备。
   */
  it('端口枚举顺序变化时 key 不受影响', () => {
    const a = asSerialPort(new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 }));
    const b = asSerialPort(new FakeSerialPort({ usbVendorId: 0x0403, usbProductId: 0x6001 }));

    const firstEnumeration = [a, b];
    const keysBefore = firstEnumeration.map(portKey);

    // 拔掉再插回，浏览器换了个顺序返回同样这两个端口
    const secondEnumeration = [b, a];
    const keysAfter = secondEnumeration.map(portKey);

    expect(keysAfter).toEqual([keysBefore[1], keysBefore[0]]);
    // 关键：a 的身份始终是 a，不会因为下标从 0 变成 1 就指向另一台设备
    expect(portKey(a)).toBe(keysBefore[0]);
  });

  it('可以按 key 反查端口对象', () => {
    const port = asSerialPort(new FakeSerialPort());
    const key = portKey(port);
    expect(portByStableKey(key)).toBe(port);
    expect(portByStableKey('port-does-not-exist')).toBeUndefined();
  });

  /**
   * getInfo() 只给 VID/PID，拿不到 COM 口名和设备友好名称，
   * 所以「显示得更完整」能做的就是把这两个数字翻译成芯片名。
   */
  it('认识的芯片显示芯片型号并保留原始 VID:PID', () => {
    const port = asSerialPort(new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 }));
    const descriptor = describePort(port);
    expect(descriptor.label).toBe('#1 CH340 (1A86:7523)');
    expect(descriptor.chip).toBe('CH340');
    expect(descriptor.vendor).toBe('WCH 沁恒');
    expect(descriptor.usbVendorId).toBe(0x1a86);
    expect(descriptor.usbProductId).toBe(0x7523);
  });

  it('只认识厂商时退而显示厂商名', () => {
    const port = asSerialPort(new FakeSerialPort({ usbVendorId: 0x0403, usbProductId: 0x9999 }));
    const descriptor = describePort(port);
    expect(descriptor.label).toBe('#1 FTDI (0403:9999)');
    expect(descriptor.chip).toBeNull();
    expect(descriptor.vendor).toBe('FTDI');
  });

  it('厂商与芯片都不认识时只给原始 ID，不做猜测', () => {
    const port = asSerialPort(new FakeSerialPort({ usbVendorId: 0xabcd, usbProductId: 0x1234 }));
    const descriptor = describePort(port);
    expect(descriptor.label).toBe('#1 USB ABCD:1234');
    expect(descriptor.chip).toBeNull();
    expect(descriptor.vendor).toBeNull();
  });

  it('蓝牙串口有独立标签', () => {
    const port = asSerialPort(new FakeSerialPort({ bluetoothServiceClassId: '1101' }));
    expect(describePort(port).label).toBe('#1 Bluetooth');
  });

  it('没有任何标识信息时退化为通用标签', () => {
    const descriptor = describePort(asSerialPort(new FakeSerialPort()));
    expect(descriptor.label).toBe('#1 Serial');
    expect(descriptor.usbVendorId).toBeUndefined();
  });

  it('多个端口按授权先后编号，便于区分同型号适配器', () => {
    const first = describePort(
      asSerialPort(new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 })),
    );
    const second = describePort(
      asSerialPort(new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 })),
    );
    expect(first.label).toBe('#1 CH340 (1A86:7523)');
    expect(second.label).toBe('#2 CH340 (1A86:7523)');
    expect(first.key).not.toBe(second.key);
  });

  /** 已授权但被拔掉的端口仍会留在列表里，必须能标注出来。 */
  it('报告设备是否物理在位', () => {
    const fake = new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
    expect(describePort(asSerialPort(fake)).connected).toBe(true);

    fake.connected = false;
    expect(describePort(asSerialPort(fake)).connected).toBe(false);
  });

  it('getInfo 抛错时不影响端口可用性', () => {
    const fake = new FakeSerialPort({ usbVendorId: 1, usbProductId: 2 });
    fake.infoThrows = true;
    const descriptor = describePort(asSerialPort(fake));
    expect(descriptor.key).toBe('port-1');
    expect(descriptor.label).toBe('#1 Serial');
  });

  it('identityBase 按可用信息取前缀', () => {
    expect(identityBase({ usbVendorId: 0x1a86, usbProductId: 0x7523 })).toBe('usb:1A86:7523');
    expect(identityBase({ bluetoothServiceClassId: '1101' })).toBe('bt:1101');
    // 虚拟串口（com0com 之类）不是 USB 设备，getInfo() 返回空对象
    expect(identityBase({})).toBe('serial');
  });

  /**
   * 这条对应一个真实反馈：本机两个虚拟串口 COM1 / COM2，给其中一个起了备注，
   * 另一个也跟着显示成同一个名字。
   *
   * 原因是虚拟口没有任何 USB 信息，identity 前缀都是 `serial`，两个口塌缩成
   * 同一个键。加上出现序号后它们才各自独立。
   */
  it('两个都没有 USB 信息的虚拟串口获得各自独立的 identity', () => {
    const ports = [new FakeSerialPort(), new FakeSerialPort()].map(asSerialPort);
    const [first, second] = describePorts(ports);

    expect(first!.identity).toBe('serial#0');
    expect(second!.identity).toBe('serial#1');
    expect(first!.identity).not.toBe(second!.identity);
  });

  it('两个同型号适配器同样各自独立', () => {
    const ports = [
      new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
      new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    ].map(asSerialPort);
    const [first, second] = describePorts(ports);

    expect(first!.identity).toBe('usb:1A86:7523#0');
    expect(second!.identity).toBe('usb:1A86:7523#1');
  });

  it('不同型号的端口各自从 0 开始编号，互不影响', () => {
    const ports = [
      new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
      new FakeSerialPort({ usbVendorId: 0x0403, usbProductId: 0x6001 }),
      new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    ].map(asSerialPort);
    const identities = describePorts(ports).map((port) => port.identity);

    expect(identities).toEqual(['usb:1A86:7523#0', 'usb:0403:6001#0', 'usb:1A86:7523#1']);
  });

  it('describePorts 保留每个端口的标签与在位状态', () => {
    const unplugged = new FakeSerialPort({ usbVendorId: 0x0403, usbProductId: 0x6001 });
    unplugged.connected = false;
    const described = describePorts([
      asSerialPort(new FakeSerialPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 })),
      asSerialPort(unplugged),
    ]);

    expect(described[0]!.label).toBe('#1 CH340 (1A86:7523)');
    expect(described[0]!.connected).toBe(true);
    expect(described[1]!.label).toBe('#2 FT232R (0403:6001)');
    expect(described[1]!.connected).toBe(false);
  });

  it('describePort 多次调用返回同一个 key', () => {
    const port = asSerialPort(new FakeSerialPort());
    expect(describePort(port).key).toBe(describePort(port).key);
  });
});
