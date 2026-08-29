import { create } from 'zustand';
import { findChecksum, type ChecksumId } from '@/core/checksum';
import type { HexParseError } from '@/core/codec/hex';
import { pickEnum, pickInt, pickString, saveSoon } from '@/lib/persist';
import { readLayeredJson } from '@/lib/storage';
import { useConnectionStore } from './connectionStore';
import { useLogStore } from './logStore';
import { buildFrame, convertPayload, EOL_KEYS, type EolKey, type PayloadMode } from './payload';
import { SINGLE_TASK, useTasksStore } from './tasksStore';

const SEND_KEY = 'sendPane';
const MODES: readonly PayloadMode[] = ['text', 'hex'];

const DEFAULTS = {
  payload: 'AT+VER?',
  mode: 'text' as PayloadMode,
  // 默认都不追加任何东西：不该在用户没要求时擅自改动报文
  eol: 'none' as EolKey,
  checksum: 'none' as ChecksumId,
  intervalMs: 1000,
};

/**
 * 还原发送区。校验和的取值来自算法目录而不是固定枚举：
 * 目录里增删条目时，存量里那个已不存在的 id 会自动退回 'none'。
 */
function loadSendState(): typeof DEFAULTS {
  const raw = readLayeredJson<unknown>(SEND_KEY, null);
  const checksum = pickString(raw, 'checksum', DEFAULTS.checksum);
  return {
    payload: pickString(raw, 'payload', DEFAULTS.payload),
    mode: pickEnum(raw, 'mode', MODES, DEFAULTS.mode),
    eol: pickEnum(raw, 'eol', EOL_KEYS, DEFAULTS.eol),
    checksum: checksum === 'none' || findChecksum(checksum) ? checksum : DEFAULTS.checksum,
    intervalMs: pickInt(raw, 'intervalMs', DEFAULTS.intervalMs, (v) => v >= 10),
  };
}

const restored = loadSendState();

/** 模式切换被拒绝时的原因，由 UI 翻译成提示文案。 */
export type ModeSwitchIssue = { kind: 'lossy' } | { kind: 'parse'; error: HexParseError };

interface SendState {
  payload: string;
  mode: PayloadMode;
  eol: EolKey;
  /** HEX 模式下自动追加的校验和；'none' 表示不追加。 */
  checksum: ChecksumId;
  intervalMs: number;
  /** 当前内容在 HEX 模式下的解析错误，null 表示没问题。 */
  parseError: HexParseError | null;
  /** 最近一次模式切换被拒绝的原因；用户再次编辑即清除。 */
  modeIssue: ModeSwitchIssue | null;

  setPayload: (payload: string) => void;
  setMode: (mode: PayloadMode) => void;
  setEol: (eol: EolKey) => void;
  setChecksum: (checksum: ChecksumId) => void;
  setIntervalMs: (intervalMs: number) => void;
  frameBytes: () => Uint8Array | null;
  sendOnce: () => Promise<void>;
  toggleLoop: () => void;
}

function validate(payload: string, mode: PayloadMode): HexParseError | null {
  if (mode !== 'hex') return null;
  const result = buildFrame(payload, mode, 'none');
  return result.ok ? null : result.error;
}

export const useSendStore = create<SendState>()((set, get) => ({
  ...restored,
  // 存量内容可能在 HEX 模式下解析不通过，进来就要把错误标出来
  parseError: validate(restored.payload, restored.mode),
  modeIssue: null,

  setPayload: (payload) =>
    set((state) => ({
      payload,
      parseError: validate(payload, state.mode),
      modeIssue: null,
    })),

  setMode: (mode) => {
    const state = get();
    if (state.mode === mode) return;

    const converted = convertPayload(state.payload, state.mode, mode);
    if (!converted.ok) {
      // 缺陷 D3：不可无损还原时保持原模式，并把原因交给 UI 提示
      set({
        modeIssue:
          converted.reason === 'lossy'
            ? { kind: 'lossy' }
            : { kind: 'parse', error: converted.error },
      });
      return;
    }
    set({
      mode,
      payload: converted.data,
      parseError: validate(converted.data, mode),
      modeIssue: null,
    });
  },

  setEol: (eol) => set({ eol }),

  setChecksum: (checksum) => set({ checksum }),

  setIntervalMs: (intervalMs) => {
    const clamped = Math.max(10, Math.round(intervalMs) || 10);
    set({ intervalMs: clamped });
    useTasksStore.getState().update(SINGLE_TASK, { intervalMs: clamped });
  },

  frameBytes: () => {
    const { payload, mode, eol, checksum } = get();
    const result = buildFrame(payload, mode, eol, checksum);
    return result.ok ? result.bytes : null;
  },

  sendOnce: async () => {
    const bytes = get().frameBytes();
    if (!bytes) return;
    await useConnectionStore.getState().send(bytes);
  },

  toggleLoop: () => {
    const tasks = useTasksStore.getState();
    if (tasks.running.includes(SINGLE_TASK)) {
      tasks.stop(SINGLE_TASK);
      return;
    }
    if (!useConnectionStore.getState().isOpen()) {
      useLogStore.getState().appendNotice({ code: 'not-open' });
      return;
    }
    const bytes = get().frameBytes();
    tasks.start(SINGLE_TASK, {
      intervalMs: get().intervalMs,
      // frames 交给会话所在的那一侧执行 —— 在 VS Code 里就是扩展宿主进程，
      // 面板被隐藏时 webview 连同定时器一起销毁，只有它能让循环继续跑下去。
      // 报文当前解析不通过就先给空列表，改对了由下面的订阅补进去。
      frames: bytes ? [bytes] : [],
      // 浏览器侧的执行体：每次触发都读最新内容，循环期间改报文即时生效
      run: () => get().sendOnce(),
    });
  },
}));

useSendStore.subscribe(({ payload, mode, eol, checksum, intervalMs }) => {
  // 分层作用域：在 A 页面打字不该让 B 页面的发送框跟着变（见 storage.ts）
  saveSoon(SEND_KEY, { payload, mode, eol, checksum, intervalMs }, 'layered');

  // 循环期间改报文要即时生效。浏览器侧靠执行体重读状态自然就有；
  // 交给宿主执行时内容在那一头，必须显式推过去。
  const bytes = useSendStore.getState().frameBytes();
  useTasksStore.getState().update(SINGLE_TASK, { frames: bytes ? [bytes] : [] });
});
