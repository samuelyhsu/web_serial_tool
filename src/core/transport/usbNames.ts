/**
 * USB 厂商 / 芯片名对照表。
 *
 * Web Serial 的 `SerialPort.getInfo()` 只给 usbVendorId 和 usbProductId
 * （https://wicg.github.io/serial/#dom-serialportinfo），拿不到 COM 口名，也拿不到
 * 设备友好名称 —— 那些只存在于浏览器自己的端口选择器里，页面无权读取。
 *
 * 所以「让端口下拉框显示得更完整」唯一可做的，就是把这两个数字翻译成人能认的名字。
 * 下面只收录了广泛使用、身份明确的条目；查不到就退回显示原始的 VID:PID，
 * 不做任何猜测。缺哪个设备直接往表里加一行即可。
 */

const VENDORS: Readonly<Record<number, string>> = {
  0x0403: 'FTDI',
  0x045b: 'Renesas',
  0x0483: 'STMicroelectronics',
  0x04d8: 'Microchip',
  0x067b: 'Prolific',
  0x0d28: 'ARM mbed',
  0x10c4: 'Silicon Labs',
  0x1209: 'pid.codes',
  0x1366: 'SEGGER',
  0x16c0: 'Teensy',
  0x1a86: 'WCH 沁恒',
  0x1b4f: 'SparkFun',
  0x1fc9: 'NXP',
  0x2341: 'Arduino',
  0x2886: 'Seeed Studio',
  0x2a03: 'Arduino',
  0x2e8a: 'Raspberry Pi',
  0x303a: 'Espressif',
  0x239a: 'Adafruit',
};

/** 键为 (vid << 16) | pid。 */
const CHIPS: Readonly<Record<number, string>> = {
  0x04036001: 'FT232R',
  0x04036010: 'FT2232',
  0x04036014: 'FT232H',
  0x04036015: 'FT231X',
  0x067b2303: 'PL2303',
  0x10c4ea60: 'CP2102',
  0x1a865523: 'CH341',
  0x1a867523: 'CH340',
  0x2e8a0005: 'Raspberry Pi Pico',
};

export function vendorName(usbVendorId: number): string | null {
  return VENDORS[usbVendorId] ?? null;
}

export function chipName(usbVendorId: number, usbProductId: number): string | null {
  return CHIPS[(usbVendorId << 16) | usbProductId] ?? null;
}

export function hex16(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}
