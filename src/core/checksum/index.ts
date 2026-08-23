import { crc, type CrcSpec } from './crc';

export { crc, reflect, type CrcSpec } from './crc';

/**
 * 串口调试常用校验和。
 *
 * CRC 部分由 crc.ts 的通用引擎驱动，参数与 check 值全部抄自 CRC RevEng 目录
 * （https://reveng.sourceforge.io/crc-catalogue/all.htm），并在测试里逐条用 check 值验证。
 */

/* ---------- 求和 / 异或 ---------- */

/** 8 位累加和。 */
export function sum8(bytes: Uint8Array): number {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xff;
  return sum;
}

/** 16 位累加和。 */
export function sum16(bytes: Uint8Array): number {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xffff;
  return sum;
}

/** 8 位异或校验（LRC）。 */
export function xor8(bytes: Uint8Array): number {
  let acc = 0;
  for (const byte of bytes) acc ^= byte;
  return acc & 0xff;
}

/** 16 位值 → 小端字节序（Modbus RTU 的 CRC 就是低字节先发）。 */
export function u16le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
}

/** 16 位值 → 大端字节序。 */
export function u16be(value: number): Uint8Array {
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

/* ---------- 兼容旧调用点的具名封装 ---------- */

export const CRC16_MODBUS: CrcSpec = {
  width: 16,
  poly: 0x8005,
  init: 0xffff,
  refIn: true,
  refOut: true,
  xorOut: 0x0000,
  check: 0x4b37,
};

export const CRC16_IBM_3740: CrcSpec = {
  width: 16,
  poly: 0x1021,
  init: 0xffff,
  refIn: false,
  refOut: false,
  xorOut: 0x0000,
  check: 0x29b1,
};

export function crc16Modbus(bytes: Uint8Array): number {
  return crc(bytes, CRC16_MODBUS);
}

/** CRC-16/IBM-3740，业界俗称 CCITT-FALSE。 */
export function crc16Ccitt(bytes: Uint8Array): number {
  return crc(bytes, CRC16_IBM_3740);
}

/* ---------- 算法目录 ---------- */

/**
 * 追加时的字节序。
 *
 * 注意这不是 CRC 定义的一部分 —— RevEng 目录只定义数值，字节序是各协议自己的约定。
 * 下面标 'le' 的都是协议明确要求低字节先发的（Modbus RTU、DNP3、USB、1-Wire、Kermit），
 * 其余按 CRC 的自然顺序（高位在前）。
 */
export type ByteOrder = 'be' | 'le';

export interface ChecksumAlgorithm {
  readonly id: string;
  /** 显示名。CRC-16/MODBUS 这类是标识符，不随界面语言变化。 */
  readonly label: string;
  /** 输出字节数。 */
  readonly bytes: 1 | 2 | 4;
  readonly byteOrder: ByteOrder;
  readonly compute: (input: Uint8Array) => number;
}

function crcAlgorithm(
  id: string,
  label: string,
  spec: CrcSpec,
  byteOrder: ByteOrder = 'be',
): ChecksumAlgorithm {
  return {
    id,
    label,
    bytes: (spec.width / 8) as 1 | 2 | 4,
    byteOrder,
    compute: (input) => crc(input, spec),
  };
}

export const CHECKSUM_ALGORITHMS: readonly ChecksumAlgorithm[] = [
  // ---- CRC-8 ----
  crcAlgorithm('crc8-smbus', 'CRC-8/SMBUS', {
    width: 8,
    poly: 0x07,
    init: 0x00,
    refIn: false,
    refOut: false,
    xorOut: 0x00,
    check: 0xf4,
  }),
  crcAlgorithm('crc8-maxim', 'CRC-8/MAXIM-DOW', {
    width: 8,
    poly: 0x31,
    init: 0x00,
    refIn: true,
    refOut: true,
    xorOut: 0x00,
    check: 0xa1,
  }),
  crcAlgorithm('crc8-rohc', 'CRC-8/ROHC', {
    width: 8,
    poly: 0x07,
    init: 0xff,
    refIn: true,
    refOut: true,
    xorOut: 0x00,
    check: 0xd0,
  }),
  crcAlgorithm('crc8-itu', 'CRC-8/I-432-1', {
    width: 8,
    poly: 0x07,
    init: 0x00,
    refIn: false,
    refOut: false,
    xorOut: 0x55,
    check: 0xa1,
  }),

  // ---- CRC-16 ----
  crcAlgorithm('crc16-modbus', 'CRC-16/MODBUS', CRC16_MODBUS, 'le'),
  crcAlgorithm('crc16-ibm3740', 'CRC-16/IBM-3740 (CCITT-FALSE)', CRC16_IBM_3740),
  crcAlgorithm('crc16-xmodem', 'CRC-16/XMODEM', {
    width: 16,
    poly: 0x1021,
    init: 0x0000,
    refIn: false,
    refOut: false,
    xorOut: 0x0000,
    check: 0x31c3,
  }),
  crcAlgorithm(
    'crc16-kermit',
    'CRC-16/KERMIT',
    {
      width: 16,
      poly: 0x1021,
      init: 0x0000,
      refIn: true,
      refOut: true,
      xorOut: 0x0000,
      check: 0x2189,
    },
    'le',
  ),
  crcAlgorithm('crc16-arc', 'CRC-16/ARC', {
    width: 16,
    poly: 0x8005,
    init: 0x0000,
    refIn: true,
    refOut: true,
    xorOut: 0x0000,
    check: 0xbb3d,
  }),
  crcAlgorithm(
    'crc16-usb',
    'CRC-16/USB',
    {
      width: 16,
      poly: 0x8005,
      init: 0xffff,
      refIn: true,
      refOut: true,
      xorOut: 0xffff,
      check: 0xb4c8,
    },
    'le',
  ),
  crcAlgorithm(
    'crc16-maxim',
    'CRC-16/MAXIM-DOW',
    {
      width: 16,
      poly: 0x8005,
      init: 0x0000,
      refIn: true,
      refOut: true,
      xorOut: 0xffff,
      check: 0x44c2,
    },
    'le',
  ),
  crcAlgorithm(
    'crc16-dnp',
    'CRC-16/DNP',
    {
      width: 16,
      poly: 0x3d65,
      init: 0x0000,
      refIn: true,
      refOut: true,
      xorOut: 0xffff,
      check: 0xea82,
    },
    'le',
  ),

  // ---- CRC-32 ----
  crcAlgorithm('crc32', 'CRC-32/ISO-HDLC', {
    width: 32,
    poly: 0x04c11db7,
    init: 0xffffffff,
    refIn: true,
    refOut: true,
    xorOut: 0xffffffff,
    check: 0xcbf43926,
  }),
  crcAlgorithm('crc32-mpeg2', 'CRC-32/MPEG-2', {
    width: 32,
    poly: 0x04c11db7,
    init: 0xffffffff,
    refIn: false,
    refOut: false,
    xorOut: 0x00000000,
    check: 0x0376e6e7,
  }),

  // ---- 求和 / 异或 ----
  { id: 'sum8', label: 'SUM8', bytes: 1, byteOrder: 'be', compute: sum8 },
  { id: 'sum16', label: 'SUM16', bytes: 2, byteOrder: 'be', compute: sum16 },
  { id: 'xor8', label: 'XOR8 (LRC)', bytes: 1, byteOrder: 'be', compute: xor8 },
];

export type ChecksumId = 'none' | (string & {});

const BY_ID = new Map(CHECKSUM_ALGORITHMS.map((item) => [item.id, item]));

export function findChecksum(id: ChecksumId): ChecksumAlgorithm | undefined {
  return id === 'none' ? undefined : BY_ID.get(id);
}

/** 计算校验和并按该算法的约定字节序展开成待追加的字节。 */
export function checksumBytes(input: Uint8Array, algorithm: ChecksumAlgorithm): Uint8Array {
  const value = algorithm.compute(input);
  const out = new Uint8Array(algorithm.bytes);
  for (let i = 0; i < algorithm.bytes; i += 1) {
    // be：高位在前；le：低位在前
    const shift = algorithm.byteOrder === 'be' ? (algorithm.bytes - 1 - i) * 8 : i * 8;
    out[i] = (value >>> shift) & 0xff;
  }
  return out;
}
