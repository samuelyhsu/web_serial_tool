import { describe, expect, it } from 'vitest';
import { escapeControlChars } from './display';

describe('escapeControlChars', () => {
  it('把常见控制字符转义成可见形式，让帧边界肉眼可辨', () => {
    expect(escapeControlChars('OK\r\n')).toBe('OK\\r\\n');
    expect(escapeControlChars('a\tb')).toBe('a\\tb');
    expect(escapeControlChars('a\0b')).toBe('a\\0b');
  });

  it('其余控制字符用 \\xNN 表示', () => {
    expect(escapeControlChars('\x01\x1b\x7f')).toBe('\\x01\\x1B\\x7F');
  });

  /** 缺陷 D4：原型逐字节处理，中文会全部变成 "."。 */
  it('中文与 emoji 原样保留', () => {
    expect(escapeControlChars('温度 24.6C')).toBe('温度 24.6C');
    expect(escapeControlChars('\u{1F600}')).toBe('\u{1F600}');
  });

  it('可打印 ASCII 不受影响', () => {
    expect(escapeControlChars('+VER: SA-2100 FW 1.4.2')).toBe('+VER: SA-2100 FW 1.4.2');
  });

  it('替换字符保留，用户能看出这里有非法字节', () => {
    expect(escapeControlChars('A�B')).toBe('A�B');
  });

  it('空串返回空串', () => {
    expect(escapeControlChars('')).toBe('');
  });
});
