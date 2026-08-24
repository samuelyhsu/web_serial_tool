import { create } from 'zustand';
import { DEFAULT_IDLE_FRAME_MS, type FrameMode } from '@/core/framing/frameAssembler';
import { detectLanguage, LANGUAGES, type Language } from '@/i18n';
import { isRecord, pickBoolean, pickEnum, pickInt, saveSoon } from '@/lib/persist';
import { readStored, readStoredEnum, readStoredJson, writeStored } from '@/lib/storage';
import type { LogView } from './logStore';

export type Theme = 'dark' | 'light';
const THEMES: readonly Theme[] = ['dark', 'light'];
const VIEWS: readonly LogView[] = ['text', 'hex'];
/** 下拉框里的顺序：从「完全不处理」到「处理得最多」。 */
export const FRAME_MODES: readonly FrameMode[] = ['raw', 'idle', 'line'];

/**
 * 空闲分帧的取值上限。
 *
 * 只用来挡手滑（例如把 10 打成 100000 后界面看起来像卡死了）。1 秒的静默在串口上
 * 已经是「对方肯定说完了」的量级，再大没有实际意义。
 */
export const IDLE_FRAME_MS_MAX = 1000;

export function isValidIdleFrameMs(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= IDLE_FRAME_MS_MAX;
}

/** 接收区的显示偏好。语言与主题各自独立成键，沿用既有的存储格式。 */
const VIEW_PREFS_KEY = 'viewPrefs';

interface ViewPrefs {
  view: LogView;
  showTimestamp: boolean;
  autoScroll: boolean;
  showTx: boolean;
  onlyMatch: boolean;
  /** 当前分帧方式。三者互斥，用一个枚举表达，界面上就只有一个控件在管它。 */
  frameMode: FrameMode;
  /** 空闲分帧的静默时长，仅 frameMode 为 idle 时有意义。 */
  idleFrameMs: number;
}

const DEFAULT_VIEW_PREFS: ViewPrefs = {
  view: 'text',
  showTimestamp: true,
  autoScroll: true,
  showTx: true,
  onlyMatch: false,
  frameMode: 'idle',
  idleFrameMs: DEFAULT_IDLE_FRAME_MS,
};

function loadViewPrefs(): ViewPrefs {
  const raw = readStoredJson<unknown>(VIEW_PREFS_KEY, null);
  const idleFrameMs = pickInt(
    raw,
    'idleFrameMs',
    DEFAULT_VIEW_PREFS.idleFrameMs,
    isValidIdleFrameMs,
  );
  return {
    view: pickEnum(raw, 'view', VIEWS, DEFAULT_VIEW_PREFS.view),
    showTimestamp: pickBoolean(raw, 'showTimestamp', DEFAULT_VIEW_PREFS.showTimestamp),
    autoScroll: pickBoolean(raw, 'autoScroll', DEFAULT_VIEW_PREFS.autoScroll),
    showTx: pickBoolean(raw, 'showTx', DEFAULT_VIEW_PREFS.showTx),
    onlyMatch: pickBoolean(raw, 'onlyMatch', DEFAULT_VIEW_PREFS.onlyMatch),
    frameMode: loadFrameMode(raw, idleFrameMs),
    idleFrameMs,
  };
}

/**
 * 读取分帧方式。
 *
 * 分帧最初是用「空闲毫秒数 + 按换行的布尔开关」两个控件表达的，0 表示原样。
 * 那种排布看不出当前到底哪个在生效，改成了单选的下拉框，模式也随之变成一个显式枚举。
 * 这里认存量里的旧字段，免得升级后大家的设置被悄悄重置。
 */
function loadFrameMode(raw: unknown, idleFrameMs: number): FrameMode {
  if (isRecord(raw) && raw.frameMode === undefined) {
    if (raw.lineFraming === true) return 'line';
    if (typeof raw.idleFrameMs === 'number') return idleFrameMs > 0 ? 'idle' : 'raw';
  }
  return pickEnum(raw, 'frameMode', FRAME_MODES, DEFAULT_VIEW_PREFS.frameMode);
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
  frameMode: FrameMode;
  idleFrameMs: number;

  toggleLanguage: () => void;
  toggleTheme: () => void;
  setView: (view: LogView) => void;
  setShowTimestamp: (value: boolean) => void;
  setAutoScroll: (value: boolean) => void;
  setShowTx: (value: boolean) => void;
  setFilter: (value: string) => void;
  setOnlyMatch: (value: boolean) => void;
  setFrameMode: (mode: FrameMode) => void;
  setIdleFrameMs: (value: number) => void;
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

  setFrameMode: (frameMode) => set({ frameMode }),

  setIdleFrameMs: (value) => {
    const idleFrameMs = isValidIdleFrameMs(value)
      ? value
      : Math.min(IDLE_FRAME_MS_MAX, Math.max(0, Math.round(value) || 0));
    // 填 0 就是「不分帧」。同步把模式切成原样，下拉框显示的和实际生效的才不会打架 ——
    // 「看不出当前哪个在生效」正是这套控件上一版的毛病。
    set(idleFrameMs === 0 ? { idleFrameMs, frameMode: 'raw' } : { idleFrameMs });
  },
}));

useUiStore.subscribe(
  ({ view, showTimestamp, autoScroll, showTx, onlyMatch, frameMode, idleFrameMs }) => {
    saveSoon(VIEW_PREFS_KEY, {
      view,
      showTimestamp,
      autoScroll,
      showTx,
      onlyMatch,
      frameMode,
      idleFrameMs,
    });
  },
);

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    // 部分环境（如老旧 WebView）没有 matchMedia
    return 'dark';
  }
}
