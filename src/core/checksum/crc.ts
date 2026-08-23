/**
 * 通用 CRC 引擎（Rocksoft 参数化模型）。
 *
 * 用一份参数（width / poly / init / refin / refout / xorout）描述任意 CRC 变体，
 * 新增算法只需往表里加一行。参数与自校验用的 check 值全部取自 CRC RevEng 目录，
 * 不凭记忆填写：https://reveng.sourceforge.io/crc-catalogue/all.htm
 *
 * 实现按位计算而非查表：本工具的载荷都是几十到几百字节，按位足够快，
 * 而且代码短到可以一眼看懂对不对 —— 查表法还得先证明表生成是对的。
 */

export interface CrcSpec {
  readonly width: 8 | 16 | 32;
  readonly poly: number;
  readonly init: number;
  readonly refIn: boolean;
  readonly refOut: boolean;
  readonly xorOut: number;
  /** RevEng 目录里的 check 值：字符串 "123456789" 的计算结果，用于自校验。 */
  readonly check: number;
}

/** 按位反转一个 width 位宽的值。 */
export function reflect(value: number, width: number): number {
  let out = 0;
  for (let i = 0; i < width; i += 1) {
    out = ((out << 1) | ((value >>> i) & 1)) >>> 0;
  }
  return out >>> 0;
}

export function crc(bytes: Uint8Array, spec: CrcSpec): number {
  const { width, poly, init, refIn, refOut, xorOut } = spec;
  // 32 位要绕开 JS 位运算的有符号语义，统一用 >>> 0 归一化
  const mask = width === 32 ? 0xffffffff : (1 << width) - 1;
  const topBit = width === 32 ? 0x80000000 : 1 << (width - 1);

  let register = init >>> 0;
  for (const raw of bytes) {
    const byte = refIn ? reflect(raw, 8) : raw;
    register = ((register ^ (byte << (width - 8))) & mask) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      register =
        (register & topBit) !== 0
          ? (((register << 1) ^ poly) & mask) >>> 0
          : ((register << 1) & mask) >>> 0;
    }
  }

  if (refOut) register = reflect(register, width);
  return ((register ^ xorOut) & mask) >>> 0;
}
