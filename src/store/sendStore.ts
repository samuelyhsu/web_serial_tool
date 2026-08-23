import { create } from 'zustand';
import type { ChecksumId } from '@/core/checksum';
import type { HexParseError } from '@/core/codec/hex';
import { useConnectionStore } from './connectionStore';
import { useLogStore } from './logStore';
import { buildFrame, convertPayload, type EolKey, type PayloadMode } from './payload';
import { SINGLE_TASK, useTasksStore } from './tasksStore';

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
  payload: 'AT+VER?',
  mode: 'text',
  // 默认都不追加任何东西：不该在用户没要求时擅自改动报文
  eol: 'none',
  checksum: 'none',
  intervalMs: 1000,
  parseError: null,
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
    useTasksStore.getState().updateInterval(SINGLE_TASK, clamped);
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
    tasks.start(SINGLE_TASK, {
      intervalMs: get().intervalMs,
      // 每次触发都读最新内容，用户循环期间改报文即时生效
      run: () => get().sendOnce(),
    });
  },
}));
