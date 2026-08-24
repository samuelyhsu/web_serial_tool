import { create } from 'zustand';
import { detectLanguage, LANGUAGES, type Language } from '@/i18n';
import { pickBoolean, pickEnum, saveSoon } from '@/lib/persist';
import { readStored, readStoredEnum, readStoredJson, writeStored } from '@/lib/storage';
import type { LogView } from './logStore';

export type Theme = 'dark' | 'light';
const THEMES: readonly Theme[] = ['dark', 'light'];
const VIEWS: readonly LogView[] = ['text', 'hex'];

/** 接收区的显示偏好。语言与主题各自独立成键，沿用既有的存储格式。 */
const VIEW_PREFS_KEY = 'viewPrefs';

interface ViewPrefs {
  view: LogView;
  showTimestamp: boolean;
  autoScroll: boolean;
  showTx: boolean;
  onlyMatch: boolean;
}

const DEFAULT_VIEW_PREFS: ViewPrefs = {
  view: 'text',
  showTimestamp: true,
  autoScroll: true,
  showTx: true,
  onlyMatch: false,
};

function loadViewPrefs(): ViewPrefs {
  const raw = readStoredJson<unknown>(VIEW_PREFS_KEY, null);
  return {
    view: pickEnum(raw, 'view', VIEWS, DEFAULT_VIEW_PREFS.view),
    showTimestamp: pickBoolean(raw, 'showTimestamp', DEFAULT_VIEW_PREFS.showTimestamp),
    autoScroll: pickBoolean(raw, 'autoScroll', DEFAULT_VIEW_PREFS.autoScroll),
    showTx: pickBoolean(raw, 'showTx', DEFAULT_VIEW_PREFS.showTx),
    onlyMatch: pickBoolean(raw, 'onlyMatch', DEFAULT_VIEW_PREFS.onlyMatch),
  };
}

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
  ...loadViewPrefs(),
  // filter 有意不持久化：日志本身是内存态、刷新后为空，
  // 恢复一个针对空日志的过滤词只会制造「怎么什么都没有」的困惑
  filter: '',

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

useUiStore.subscribe(({ view, showTimestamp, autoScroll, showTx, onlyMatch }) => {
  saveSoon(VIEW_PREFS_KEY, { view, showTimestamp, autoScroll, showTx, onlyMatch });
});

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    // 部分环境（如老旧 WebView）没有 matchMedia
    return 'dark';
  }
}
