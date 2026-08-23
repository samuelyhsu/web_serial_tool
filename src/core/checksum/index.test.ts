import { describe, expect, it } from 'vitest';
import {
  CHECKSUM_ALGORITHMS,
  checksumBytes,
  crc,
  crc16Ccitt,
  crc16Modbus,
  findChecksum,
  reflect,
  sum16,
  sum8,
  u16be,
  u16le,
  xor8,
  type CrcSpec,
} from './index';

const check = new TextEncoder().encode('123456789');

/** 目录里抄下来的参数，与 index.ts 中的表相互印证。 */
const SPECS: Record<string, CrcSpec | undefined> = {
  'crc8-smbus': {
    width: 8,
    poly: 0x07,
    init: 0x00,
    refIn: false,
    refOut: false,
    xorOut: 0x00,
    check: 0xf4,
  },
  'crc8-maxim': {
    width: 8,
    poly: 0x31,
    init: 0x00,
    refIn: true,
    refOut: true,
    xorOut: 0x00,
    check: 0xa1,
  },
  'crc8-rohc': {
    width: 8,
    poly: 0x07,
    init: 0xff,
    refIn: true,
    refOut: true,
    xorOut: 0x00,
    check: 0xd0,
  },
  'crc8-itu': {
    width: 8,
    poly: 0x07,
    init: 0x00,
    refIn: false,
    refOut: false,
    xorOut: 0x55,
    check: 0xa1,
  },
  'crc16-modbus': {
    width: 16,
    poly: 0x8005,
    init: 0xffff,
    refIn: true,
    refOut: true,
    xorOut: 0x0000,
    check: 0x4b37,
  },
  'crc16-ibm3740': {
    width: 16,
    poly: 0x1021,
    init: 0xffff,
    refIn: false,
    refOut: false,
    xorOut: 0x0000,
    check: 0x29b1,
  },
  'crc16-xmodem': {
    width: 16,
    poly: 0x1021,
    init: 0x0000,
    refIn: false,
    refOut: false,
    xorOut: 0x0000,
    check: 0x31c3,
  },
  'crc16-kermit': {
    width: 16,
    poly: 0x1021,
    init: 0x0000,
    refIn: true,
    refOut: true,
    xorOut: 0x0000,
    check: 0x2189,
  },
  'crc16-arc': {
    width: 16,
    poly: 0x8005,
    init: 0x0000,
    refIn: true,
    refOut: true,
    xorOut: 0x0000,
    check: 0xbb3d,
  },
  'crc16-usb': {
    width: 16,
    poly: 0x8005,
    init: 0xffff,
    refIn: true,
    refOut: true,
    xorOut: 0xffff,
    check: 0xb4c8,
  },
  'crc16-maxim': {
    width: 16,
    poly: 0x8005,
    init: 0x0000,
    refIn: true,
    refOut: true,
    xorOut: 0xffff,
    check: 0x44c2,
  },
  'crc16-dnp': {
    width: 16,
    poly: 0x3d65,
    init: 0x0000,
    refIn: true,
    refOut: true,
    xorOut: 0xffff,
    check: 0xea82,
  },
  crc32: {
    width: 32,
    poly: 0x04c11db7,
    init: 0xffffffff,
    refIn: true,
    refOut: true,
    xorOut: 0xffffffff,
    check: 0xcbf43926,
  },
  'crc32-mpeg2': {
    width: 32,
    poly: 0x04c11db7,
    init: 0xffffffff,
    refIn: false,
    refOut: false,
    xorOut: 0x00000000,
    check: 0x0376e6e7,
  },
};

/**
 * 全部用 CRC RevEng 目录的标准 check 值验证，而不是拿原型自身的输出当基准 ——
 * 否则只是把原型的行为固化下来，测不出算法本身是否正确。
 * https://reveng.sourceforge.io/crc-catalogue/16.htm
 */
describe('checksum', () => {
  it('CRC-16/MODBUS 对标准 check 串返回 0x4B37', () => {
    expect(crc16Modbus(check)).toBe(0x4b37);
  });

  it('CRC-16/IBM-3740 (CCITT-FALSE) 对标准 check 串返回 0x29B1', () => {
    expect(crc16Ccitt(check)).toBe(0x29b1);
  });

  it('对真实 Modbus RTU 请求帧算出的 CRC 与设备侧一致', () => {
    // 读保持寄存器：从站 01，功能码 03，起始 0x0000，数量 2 → CRC 0x0BC4，低字节先发
    const frame = Uint8Array.of(0x01, 0x03, 0x00, 0x00, 0x00, 0x02);
    const crc = crc16Modbus(frame);
    expect(crc).toBe(0x0bc4);
    expect([...u16le(crc)]).toEqual([0xc4, 0x0b]);
  });

  it('继电器写单线圈帧的 CRC 同样对得上', () => {
    const frame = Uint8Array.of(0x01, 0x05, 0x00, 0x00, 0xff, 0x00);
    expect([...u16le(crc16Modbus(frame))]).toEqual([0x8c, 0x3a]);
  });

  it('空输入返回各算法的初始值', () => {
    const empty = new Uint8Array(0);
    expect(crc16Modbus(empty)).toBe(0xffff);
    expect(crc16Ccitt(empty)).toBe(0xffff);
    expect(sum8(empty)).toBe(0);
    expect(xor8(empty)).toBe(0);
  });

  it('SUM8 溢出后只保留低 8 位', () => {
    expect(sum8(Uint8Array.of(0xff, 0x02))).toBe(0x01);
  });

  it('XOR8 对相同字节成对出现的输入归零', () => {
    expect(xor8(Uint8Array.of(0xa5, 0x5a, 0xa5, 0x5a))).toBe(0);
    expect(xor8(Uint8Array.of(0x0f, 0xf0))).toBe(0xff);
  });

  it('u16le / u16be 字节序相反', () => {
    expect([...u16le(0x1234)]).toEqual([0x34, 0x12]);
    expect([...u16be(0x1234)]).toEqual([0x12, 0x34]);
  });
});

/**
 * 通用 CRC 引擎的自校验。
 *
 * 目录里每个算法都带一个 check 值（字符串 "123456789" 的结果）。逐条验证既能证明
 * 引擎实现正确，也能证明表里抄下来的参数没抄错 —— 参数错了 check 值必然对不上。
 * https://reveng.sourceforge.io/crc-catalogue/all.htm
 */
describe('CRC 算法目录', () => {
  it('每个算法都能算出目录给出的 check 值', () => {
    for (const algorithm of CHECKSUM_ALGORITHMS) {
      if (!algorithm.id.startsWith('crc')) continue;
      const spec = SPECS[algorithm.id];
      expect(spec, algorithm.id).toBeDefined();
      expect(crc(check, spec!), algorithm.label).toBe(spec!.check);
    }
  });

  it('算法 id 唯一', () => {
    const ids = CHECKSUM_ALGORITHMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('覆盖 CRC-8 / CRC-16 / CRC-32 三个位宽以及求和与异或', () => {
    const widths = new Set(CHECKSUM_ALGORITHMS.map((item) => item.bytes));
    expect(widths).toEqual(new Set([1, 2, 4]));
    expect(CHECKSUM_ALGORITHMS.map((item) => item.id)).toEqual(
      expect.arrayContaining(['sum8', 'sum16', 'xor8']),
    );
  });

  it('findChecksum 按 id 查找，none 表示不追加', () => {
    expect(findChecksum('crc16-modbus')?.label).toBe('CRC-16/MODBUS');
    expect(findChecksum('none')).toBeUndefined();
    expect(findChecksum('no-such-algorithm')).toBeUndefined();
  });

  it('SUM16 累加到 16 位', () => {
    expect(sum16(Uint8Array.of(0xff, 0xff))).toBe(0x01fe);
    expect(sum16(new Uint8Array(0))).toBe(0);
  });

  it('reflect 按位宽反转', () => {
    expect(reflect(0b1, 8)).toBe(0b1000_0000);
    expect(reflect(0x1234, 16)).toBe(0x2c48);
  });
});

describe('checksumBytes 字节序', () => {
  /** Modbus RTU 规定 CRC 低字节先发，这是最容易搞错、也最容易被发现的一条。 */
  it('CRC-16/MODBUS 低字节先发', () => {
    const frame = Uint8Array.of(0x01, 0x03, 0x00, 0x00, 0x00, 0x02);
    const algorithm = findChecksum('crc16-modbus')!;
    expect([...checksumBytes(frame, algorithm)]).toEqual([0xc4, 0x0b]);
  });

  it('CRC-16/IBM-3740 高字节先发', () => {
    const algorithm = findChecksum('crc16-ibm3740')!;
    expect([...checksumBytes(check, algorithm)]).toEqual([0x29, 0xb1]);
  });

  it('CRC-32 展开成四字节，高位在前', () => {
    const algorithm = findChecksum('crc32')!;
    expect([...checksumBytes(check, algorithm)]).toEqual([0xcb, 0xf4, 0x39, 0x26]);
  });

  it('单字节算法只产出一个字节', () => {
    expect(checksumBytes(check, findChecksum('crc8-smbus')!)).toHaveLength(1);
    expect([...checksumBytes(check, findChecksum('xor8')!)]).toEqual([xor8(check)]);
  });
});
