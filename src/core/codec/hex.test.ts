import { describe, expect, it } from 'vitest';
import { formatByte, formatHex, formatWord, HexParseException, parseHex, tryParseHex } from './hex';

function bytesOf(input: string): number[] {
  const result = tryParseHex(input);
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return [...result.bytes];
}

describe('tryParseHex', () => {
  it('接受空格分隔的写法', () => {
    expect(bytesOf('01 03 00 00 00 02')).toEqual([1, 3, 0, 0, 0, 2]);
  });

  it('接受连写、逗号、分号、冒号分隔', () => {
    expect(bytesOf('AABBCC')).toEqual([0xaa, 0xbb, 0xcc]);
    expect(bytesOf('AA,BB;CC:DD')).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it('接受 0x 前缀，且只在 token 开头生效', () => {
    expect(bytesOf('0xAA 0XBB CC')).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('单个数字视为高位补零', () => {
    expect(bytesOf('1 2 3')).toEqual([1, 2, 3]);
  });

  it('大小写混写等价', () => {
    expect(bytesOf('aAbBcC')).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('空串与纯分隔符解析为空字节序列', () => {
    expect(bytesOf('')).toEqual([]);
    expect(bytesOf('   ,, ;; ')).toEqual([]);
  });

  it('非法字符被报告出来，而不是像原型那样静默丢弃', () => {
    const result = tryParseHex('AA GG BB');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'invalid-char', char: 'G', index: 3 });
  });

  it('原型会把 "F0 x" 里的 x 连同前一个 0 一起吞掉，这里明确报错', () => {
    const result = tryParseHex('F0 x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-char');
  });

  it('奇数位的多字符 token 报 odd-length，而不是补零猜测', () => {
    const result = tryParseHex('AABBC');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'odd-length', token: 'AABBC' });
  });
});

describe('parseHex', () => {
  it('失败时抛出带结构化 detail 的异常', () => {
    expect(() => parseHex('ZZ')).toThrow(HexParseException);
    try {
      parseHex('ZZ');
    } catch (error) {
      expect((error as HexParseException).detail.kind).toBe('invalid-char');
    }
  });
});

describe('formatHex', () => {
  it('输出两位大写、空格分隔', () => {
    expect(formatHex(Uint8Array.of(0x01, 0xab, 0x00))).toBe('01 AB 00');
  });

  it('支持自定义分隔符与空输入', () => {
    expect(formatHex(Uint8Array.of(0xde, 0xad), '')).toBe('DEAD');
    expect(formatHex(new Uint8Array(0))).toBe('');
  });

  it('与解析互为逆运算', () => {
    const original = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...parseHex(formatHex(original))]).toEqual([...original]);
  });

  it('formatByte / formatWord 按位宽补零', () => {
    expect(formatByte(0x5)).toBe('05');
    expect(formatWord(0xbc4)).toBe('0BC4');
  });
});
