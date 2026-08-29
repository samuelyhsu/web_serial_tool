import { describe, expect, it } from 'vitest';
import { describeNodePorts, type NodePortInfo } from './nodePortRegistry';

const ch340: NodePortInfo = {
  path: 'COM3',
  vendorId: '1a86',
  productId: '7523',
  manufacturer: 'wch.cn',
};

describe('describeNodePorts', () => {
  it('用设备路径当 key —— 桌面端本来就是拿路径打开设备的', () => {
    expect(describeNodePorts([ch340])[0]?.key).toBe('COM3');
  });

  it('标签带上真实端口名，与设备管理器里看到的一致', () => {
    expect(describeNodePorts([ch340])[0]?.label).toBe('COM3 · CH340 (1A86:7523)');
  });

  it('有序列号时用它当身份 —— 换个 USB 口插也认得出来', () => {
    const ports = describeNodePorts([{ ...ch340, serialNumber: 'SN0123' }]);
    expect(ports[0]?.identity).toBe('usb:1A86:7523:SN0123');
  });

  /**
   * 两个同型号适配器都没有序列号时，只能退回浏览器端那套「出现序号」，
   * 且必须整表一起算 —— 这正是 identity 不能按单个端口计算的原因。
   */
  it('没有序列号时退回出现序号，同型号的两个口不会塌缩成同一身份', () => {
    const ports = describeNodePorts([ch340, { ...ch340, path: 'COM4' }]);
    expect(ports.map((port) => port.identity)).toEqual(['usb:1A86:7523#0', 'usb:1A86:7523#1']);
  });

  it('序列号只对同一台设备成立，不会被出现序号搅乱', () => {
    const ports = describeNodePorts([
      { ...ch340, serialNumber: 'A' },
      { ...ch340, path: 'COM4', serialNumber: 'B' },
    ]);
    expect(ports.map((port) => port.identity)).toEqual(['usb:1A86:7523:A', 'usb:1A86:7523:B']);
  });

  it('虚拟串口没有任何 USB 信息时用路径当身份', () => {
    const ports = describeNodePorts([{ path: 'COM5' }]);
    expect(ports[0]?.identity).toBe('path:COM5');
    // 认不出型号时标签就只有路径，不该缀上一个没信息量的「Serial」
    expect(ports[0]?.label).toBe('COM5');
  });

  it('十六进制 ID 带不带 0x 前缀都认', () => {
    const ports = describeNodePorts([{ path: 'COM3', vendorId: '0x1A86', productId: '0X7523' }]);
    expect(ports[0]?.usbVendorId).toBe(0x1a86);
    expect(ports[0]?.usbProductId).toBe(0x7523);
  });

  it('查不到厂商时退回驱动报上来的 manufacturer', () => {
    const ports = describeNodePorts([{ path: 'COM9', manufacturer: '某国产驱动' }]);
    expect(ports[0]?.vendor).toBe('某国产驱动');
  });

  it('ID 是垃圾字符串时当作没有，而不是变成 NaN', () => {
    const ports = describeNodePorts([{ path: 'COM3', vendorId: 'zzz', productId: '' }]);
    expect(ports[0]?.usbVendorId).toBeUndefined();
    expect(ports[0]?.identity).toBe('path:COM3');
  });
});
