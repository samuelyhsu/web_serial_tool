import { checksumBytes, findChecksum, type ChecksumId } from '@/core/checksum';
import { formatHex, tryParseHex, type HexParseError } from '@/core/codec/hex';
import { decodeUtf8, encodeUtf8, isLosslessUtf8 } from '@/core/codec/text';

export type PayloadMode = 'text' | 'hex';

export type BytesResult = { ok: true; bytes: Uint8Array } | { ok: false; error: HexParseError };

export type ConvertResult =
  | { ok: true; data: string }
  | { ok: false; reason: 'lossy' }
  | { ok: false; reason: 'parse'; error: HexParseError };

export function payloadToBytes(data: string, mode: PayloadMode): BytesResult {
  if (mode === 'hex') return tryParseHex(data);
  return { ok: true, bytes: encodeUtf8(data) };
}

/**
 * 在文本与 HEX 之间转换发送内容 —— 缺陷 D3 的修复。
 *
 * 原型的转换是单向且有损的：`onTxHex` 把文本转成 HEX，`onTxAscii` 却什么都不做；
 * 预设的模式切换用 `asciiStr(toBytes(data, true))`，把每个不可打印字节变成 "."，
 * 再切回去数据就永久没了（.dc.html:803、839）。
 *
 * 这里 text→hex 永远无损；hex→text 先做往返校验，不能无损还原就拒绝转换，
 * 由 UI 提示用户，而不是悄悄毁掉他的报文。
 */
export function convertPayload(data: string, from: PayloadMode, to: PayloadMode): ConvertResult {
  if (from === to) return { ok: true, data };

  if (to === 'hex') {
    return { ok: true, data: formatHex(encodeUtf8(data)) };
  }

  const parsed = tryParseHex(data);
  if (!parsed.ok) return { ok: false, reason: 'parse', error: parsed.error };
  if (!isLosslessUtf8(parsed.bytes)) return { ok: false, reason: 'lossy' };
  return { ok: true, data: decodeUtf8(parsed.bytes) };
}

export const EOL_SEQUENCES = {
  none: '',
  crlf: '\r\n',
  lf: '\n',
  cr: '\r',
} as const;

export type EolKey = keyof typeof EOL_SEQUENCES;
export const EOL_KEYS = Object.keys(EOL_SEQUENCES) as EolKey[];

/**
 * 组装最终要写出去的字节。
 *
 * 两种模式各有自己的「帧尾」，互斥：
 *  - TXT：追加结束符（CR/LF 之类），在编码之前拼进字符串；
 *  - HEX：追加校验和，按所选算法对**载荷字节**计算，再按该算法的约定字节序展开。
 *
 * 两者默认都是「无」—— 工具不该在用户没要求时擅自往报文里塞字节。
 */
export function buildFrame(
  data: string,
  mode: PayloadMode,
  eol: EolKey,
  checksum: ChecksumId = 'none',
): BytesResult {
  if (mode === 'text') return payloadToBytes(data + EOL_SEQUENCES[eol], 'text');

  const payload = payloadToBytes(data, 'hex');
  if (!payload.ok) return payload;

  const algorithm = findChecksum(checksum);
  if (!algorithm) return payload;

  const suffix = checksumBytes(payload.bytes, algorithm);
  const merged = new Uint8Array(payload.bytes.length + suffix.length);
  merged.set(payload.bytes, 0);
  merged.set(suffix, payload.bytes.length);
  return { ok: true, bytes: merged };
}
