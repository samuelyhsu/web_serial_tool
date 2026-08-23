import { describe, expect, it } from 'vitest';
import { decodeUtf8, encodeUtf8, isLosslessUtf8, StreamingUtf8Decoder } from './text';

describe('encodeUtf8 / decodeUtf8', () => {
  it('ASCII 原样编码', () => {
    expect([...encodeUtf8('AT+VER?')]).toEqual([0x41, 0x54, 0x2b, 0x56, 0x45, 0x52, 0x3f]);
  });

  it('中文按三字节 UTF-8 编码', () => {
    expect([...encodeUtf8('温度')]).toEqual([0xe6, 0xb8, 0xa9, 0xe5, 0xba, 0xa6]);
  });

  /**
   * 缺陷 D2 的回归测试：原型手写的编码器只处理到 3 字节序列，
   * U+1F600 这类增补平面字符会被编成错误的字节。
   */
  it('emoji（增补平面）编码为正确的四字节序列', () => {
    expect([...encodeUtf8('\u{1F600}')]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('任意文本编解码往返一致', () => {
    for (const text of [
      '',
      'hello',
      '温湿度 24.6C',
      '\u{1F600}\u{1F680}',
      'a\u{4E2D}b\u{1F4A1}c',
    ]) {
      expect(decodeUtf8(encodeUtf8(text))).toBe(text);
    }
  });

  it('空串编码为空字节序列', () => {
    expect(encodeUtf8('').length).toBe(0);
  });
});

describe('StreamingUtf8Decoder', () => {
  /**
   * 缺陷 D4 相关：一个汉字占 3 字节，很容易被串口分帧从中间切开。
   * 逐帧独立解码会得到两个替换字符，流式解码器则能正确跨帧还原。
   */
  it('跨帧还原被切开的多字节字符', () => {
    const bytes = encodeUtf8('温度');
    const decoder = new StreamingUtf8Decoder();
    const first = decoder.decode(bytes.slice(0, 2));
    const second = decoder.decode(bytes.slice(2));
    expect(first + second).toBe('温度');
  });

  it('对照组：不使用流式解码时会产生替换字符', () => {
    const bytes = encodeUtf8('温度');
    expect(decodeUtf8(bytes.slice(0, 2))).toContain('�');
  });

  it('reset 后丢弃滞留的半个字符', () => {
    const bytes = encodeUtf8('温');
    const decoder = new StreamingUtf8Decoder();
    decoder.decode(bytes.slice(0, 2));
    decoder.reset();
    expect(decoder.decode(encodeUtf8('A'))).toBe('A');
  });

  it('flush 把滞留的不完整字节吐成替换字符', () => {
    const decoder = new StreamingUtf8Decoder();
    decoder.decode(encodeUtf8('温').slice(0, 2));
    expect(decoder.flush()).toBe('�');
  });
});

describe('isLosslessUtf8', () => {
  it('合法 UTF-8 判为可无损还原', () => {
    expect(isLosslessUtf8(encodeUtf8('AT+VER?\r\n'))).toBe(true);
    expect(isLosslessUtf8(encodeUtf8('温度 \u{1F600}'))).toBe(true);
  });

  /** 缺陷 D3：原型把这种二进制帧转成 ASCII 时会把每个不可打印字节变成 "."，切回去数据就没了。 */
  it('二进制 Modbus 帧判为不可无损还原', () => {
    expect(isLosslessUtf8(Uint8Array.of(0x01, 0x03, 0x00, 0x00, 0x00, 0x02, 0xc4, 0x0b))).toBe(
      false,
    );
  });

  it('孤立的 UTF-8 续字节判为不可无损还原', () => {
    expect(isLosslessUtf8(Uint8Array.of(0xb8, 0xa9))).toBe(false);
  });

  it('空字节序列视为可无损还原', () => {
    expect(isLosslessUtf8(new Uint8Array(0))).toBe(true);
  });
});
