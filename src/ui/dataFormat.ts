/**
 * 数据格式标签。
 *
 * TXT / HEX 是格式标识符，不是可翻译文案 —— 就像 UTF-8、JSON、CRC16 一样，
 * 中英文界面下都显示同一个词。因此它们不放进 i18n 目录：放进去只会让某天
 * 有人把 TXT 翻回「文本」，界面上就又出现两套叫法了。
 */
export const FORMAT_LABEL = {
  text: 'TXT',
  hex: 'HEX',
} as const;

export type DataFormat = keyof typeof FORMAT_LABEL;
