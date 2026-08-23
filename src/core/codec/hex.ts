/**
 * HEX 文本 ⇄ 字节数组。
 *
 * 原型用 `str.replace(/0x/gi,' ').match(/[0-9a-f]{1,2}/gi)` 解析，非法字符被静默丢弃
 * （"GG" 解析成空、"AABBC" 解析成 AA BB 0C），用户看不到任何提示。这里改为显式的
 * 结果类型：解析失败返回可翻译的结构化错误，由 UI 决定怎么呈现。
 *
 * 接受的写法（每个 token 独立处理）：
 *   "AA BB CC" / "AABBCC" / "0xAA 0xBB" / "AA,BB;CC" / "1 2 3"（单个数字视为高位补 0）
 */

/** 分隔符：空白、逗号、分号、冒号、连字符、下划线 */
const SEPARATORS = new Set([' ', '\t', '\n', '\r', '\f', '\v', ',', ';', ':', '-', '_']);

export type HexParseError =
  { kind: 'invalid-char'; char: string; index: number } | { kind: 'odd-length'; token: string };

export type HexParseResult = { ok: true; bytes: Uint8Array } | { ok: false; error: HexParseError };

export class HexParseException extends Error {
  constructor(readonly detail: HexParseError) {
    super(
      detail.kind === 'invalid-char'
        ? `Invalid hex character ${JSON.stringify(detail.char)} at index ${detail.index}`
        : `Hex token ${JSON.stringify(detail.token)} has an odd number of digits`,
    );
    this.name = 'HexParseException';
  }
}

function hexValue(char: string): number | null {
  const code = char.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30; // 0-9
  if (code >= 0x41 && code <= 0x46) return code - 0x37; // A-F
  if (code >= 0x61 && code <= 0x66) return code - 0x57; // a-f
  return null;
}

/** 宽松解析：失败时返回结构化错误而不是抛异常，便于输入框边打字边提示。 */
export function tryParseHex(input: string): HexParseResult {
  const bytes: number[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    if (SEPARATORS.has(ch)) {
      i += 1;
      continue;
    }

    // 逐个 token 处理，这样 "F0 x" 里的 x 会被正确报错，
    // 而不是像原型那样把全局的 "0x" 一律删掉后产生错误的字节流。
    const start = i;
    let token = '';
    while (i < input.length && !SEPARATORS.has(input[i]!)) {
      token += input[i]!;
      i += 1;
    }

    let digits = token;
    let offset = start;
    if (/^0[xX]/.test(digits)) {
      digits = digits.slice(2);
      offset += 2;
    }
    if (digits.length === 0) continue;

    for (let k = 0; k < digits.length; k += 1) {
      if (hexValue(digits[k]!) === null) {
        return { ok: false, error: { kind: 'invalid-char', char: digits[k]!, index: offset + k } };
      }
    }

    if (digits.length === 1) {
      bytes.push(hexValue(digits)!);
      continue;
    }
    if (digits.length % 2 !== 0) {
      return { ok: false, error: { kind: 'odd-length', token } };
    }
    for (let k = 0; k < digits.length; k += 2) {
      bytes.push((hexValue(digits[k]!)! << 4) | hexValue(digits[k + 1]!)!);
    }
  }

  return { ok: true, bytes: Uint8Array.from(bytes) };
}

/** 严格解析：失败抛 {@link HexParseException}。 */
export function parseHex(input: string): Uint8Array {
  const result = tryParseHex(input);
  if (!result.ok) throw new HexParseException(result.error);
  return result.bytes;
}

/** 字节 → 大写 HEX 文本，默认空格分隔。 */
export function formatHex(bytes: Uint8Array, separator = ' '): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    if (i > 0) out += separator;
    out += bytes[i]!.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** 单字节 → 两位大写 HEX，用于校验和展示。 */
export function formatByte(value: number): string {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/** 16 位值 → 四位大写 HEX。 */
export function formatWord(value: number): string {
  return (value & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}
