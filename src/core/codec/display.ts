/**
 * 把解码后的文本渲染成日志里可见的一行。
 *
 * 语义与原型保持一致（控制字符转义成 \r \n \t，让帧边界肉眼可见），但原型是逐字节
 * 处理的，非 ASCII 一律变 "."；这里作用在已经 UTF-8 解码过的字符串上，中文 / emoji
 * 原样显示，只转义真正的控制字符 —— 缺陷 D4 的修复。
 */

const ESCAPES: Record<string, string> = {
  '\r': '\\r',
  '\n': '\\n',
  '\t': '\\t',
  '\0': '\\0',
};

export function escapeControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const mapped = ESCAPES[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0)!;
    // 其余 C0 控制字符、DEL 与 C1：用 \xNN 显示，避免不可见字符破坏日志对齐
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += '\\x' + code.toString(16).toUpperCase().padStart(2, '0');
      continue;
    }
    out += ch;
  }
  return out;
}
