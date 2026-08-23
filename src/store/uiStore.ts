import { create } from 'zustand';
import { detectLanguage, LANGUAGES, type Language } from '@/i18n';
import { readStored, readStoredEnum, writeStored } from '@/lib/storage';
import type { LogView } from './logStore';

export type Theme = 'dark' | 'light';
const THEMES: readonly Theme[] = ['dark', 'light'];

interface UiState {
  language: Language;
  theme: Theme;
  view: LogView;
  showTimestamp: boolean;
  autoScroll: boolean;
  showTx: boolean;
  filter: string;
  onlyMatch: boolean;

  toggleLanguage: () => void;
  toggleTheme: () => void;
  setView: (view: LogView) => void;
  setShowTimestamp: (value: boolean) => void;
  setAutoScroll: (value: boolean) => void;
  setShowTx: (value: boolean) => void;
  setFilter: (value: string) => void;
  setOnlyMatch: (value: boolean) => void;
}

function initialLanguage(): Language {
  return readStored('lang') === null ? detectLanguage() : readStoredEnum('lang', LANGUAGES, 'zh');
}

export const useUiStore = create<UiState>()((set) => ({
  language: initialLanguage(),
  // 没存过偏好时跟随系统，而不是硬性锁定深色
  theme: readStored('theme') === null ? systemTheme() : readStoredEnum('theme', THEMES, 'dark'),
  view: 'text',
  showTimestamp: true,
  autoScroll: true,
  showTx: true,
  filter: '',
  onlyMatch: false,

  toggleLanguage: () =>
    set((state) => {
      const language: Language = state.language === 'zh' ? 'en' : 'zh';
      writeStored('lang', language);
      return { language };
    }),

  toggleTheme: () =>
    set((state) => {
      const theme: Theme = state.theme === 'dark' ? 'light' : 'dark';
      writeStored('theme', theme);
      return { theme };
    }),

  setView: (view) => set({ view }),
  setShowTimestamp: (showTimestamp) => set({ showTimestamp }),
  setAutoScroll: (autoScroll) => set({ autoScroll }),
  setShowTx: (showTx) => set({ showTx }),
  setFilter: (filter) => set({ filter }),
  setOnlyMatch: (onlyMatch) => set({ onlyMatch }),
}));

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    // 部分环境（如老旧 WebView）没有 matchMedia
    return 'dark';
  }
}
