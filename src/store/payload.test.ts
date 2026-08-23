import { describe, expect, it } from 'vitest';
import { formatHex } from '@/core/codec/hex';
import { buildFrame, convertPayload, payloadToBytes } from './payload';

function bytes(result: ReturnType<typeof payloadToBytes>): number[] {
  if (!result.ok) throw new Error('expected ok');
  return [...result.bytes];
}

describe('payloadToBytes', () => {
  it('文本模式按 UTF-8 编码', () => {
    expect(bytes(payloadToBytes('AT', 'text'))).toEqual([0x41, 0x54]);
    expect(bytes(payloadToBytes('温', 'text'))).toEqual([0xe6, 0xb8, 0xa9]);
  });

  it('HEX 模式解析失败时回结构化错误', () => {
    const result = payloadToBytes('ZZ', 'hex');
    expect(result.ok).toBe(false);
  });
});

describe('convertPayload', () => {
  it('文本 → HEX 永远无损', () => {
    expect(convertPayload('AT+VER?', 'text', 'hex')).toEqual({
      ok: true,
      data: '41 54 2B 56 45 52 3F',
    });
  });

  it('合法 UTF-8 的 HEX 可以转回文本', () => {
    expect(convertPayload('41 54', 'hex', 'text')).toEqual({ ok: true, data: 'AT' });
    expect(convertPayload(formatHex(new TextEncoder().encode('温度')), 'hex', 'text')).toEqual({
      ok: true,
      data: '温度',
    });
  });

  /**
   * 缺陷 D3 的回归测试：原型会把这个 Modbus 帧的不可打印字节全变成 "."，
   * 用户再切回 HEX 时数据已经毁了。
   */
  it('二进制报文拒绝转成文本，而不是静默丢数据', () => {
    expect(convertPayload('01 03 00 00 00 02 C4 0B', 'hex', 'text')).toEqual({
      ok: false,
      reason: 'lossy',
    });
  });

  it('HEX 本身格式非法时报 parse 错误', () => {
    const result = convertPayload('QQ', 'hex', 'text');
    expect(result).toMatchObject({ ok: false, reason: 'parse' });
  });

  it('同模式转换原样返回', () => {
    expect(convertPayload('anything', 'text', 'text')).toEqual({ ok: true, data: 'anything' });
  });

  it('文本 → HEX → 文本 往返一致（含 emoji）', () => {
    const original = 'hi 温度 \u{1F600}';
    const toHex = convertPayload(original, 'text', 'hex');
    expect(toHex.ok).toBe(true);
    if (!toHex.ok) return;
    expect(convertPayload(toHex.data, 'hex', 'text')).toEqual({ ok: true, data: original });
  });
});

describe('buildFrame', () => {
  it('文本模式追加结束符', () => {
    expect(bytes(buildFrame('AT', 'text', 'crlf'))).toEqual([0x41, 0x54, 0x0d, 0x0a]);
    expect(bytes(buildFrame('AT', 'text', 'lf'))).toEqual([0x41, 0x54, 0x0a]);
    expect(bytes(buildFrame('AT', 'text', 'cr'))).toEqual([0x41, 0x54, 0x0d]);
    expect(bytes(buildFrame('AT', 'text', 'none'))).toEqual([0x41, 0x54]);
  });

  it('HEX 模式不追加结束符', () => {
    expect(bytes(buildFrame('01 02', 'hex', 'crlf'))).toEqual([1, 2]);
  });

  it('HEX 非法时不产出字节', () => {
    expect(buildFrame('XY', 'hex', 'none').ok).toBe(false);
  });
});
