import { en } from './en';
import type { Language, Messages } from './types';
import { zh } from './zh';

export type { Language, Messages } from './types';
export { LANGUAGES } from './types';

const CATALOGS: Record<Language, Messages> = { zh, en };

export function messagesFor(language: Language): Messages {
  return CATALOGS[language];
}

/** 浏览器语言猜测，仅在用户没有存过偏好时使用。 */
export function detectLanguage(): Language {
  if (typeof navigator === 'undefined') return 'zh';
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
