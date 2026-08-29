import { create } from 'zustand';
import type { HexParseError } from '@/core/codec/hex';
import { BUILTIN_PRESET_KEYS, type BuiltinPresetKey, type Messages } from '@/i18n/types';
import { saveSoon } from '@/lib/persist';
import { readStoredJson } from '@/lib/storage';
import { useConnectionStore } from './connectionStore';
import { useLogStore } from './logStore';
import { buildFrame, convertPayload, type PayloadMode } from './payload';
import { presetTask, SEQUENCE_TASK, useTasksStore } from './tasksStore';

export interface Preset {
  id: string;
  /** 内置预设的翻译键；用户改名后置 null，此后不再随语言变化（缺陷 D16）。 */
  labelKey: BuiltinPresetKey | null;
  name: string;
  data: string;
  mode: PayloadMode;
  intervalMs: number;
  inSequence: boolean;
}

export const PRESET_EXPORT_VERSION = 1;

/**
 * 预设按页组织：每页固定 10 条，共 PRESET_PAGES 页。
 *
 * 固定条数换来的是不需要新增/删除按钮，每行也就能压成密度一致的一行；
 * 分页则让总量够用而不必把几十行堆在一个滚动区里。
 * 页数不够改这里一个常量即可，界面会自动跟上。
 */
export const PRESET_PAGE_SIZE = 10;
export const PRESET_PAGES = 5;
export const PRESET_COUNT = PRESET_PAGE_SIZE * PRESET_PAGES;

let counter = 0;
const nextId = (): string => `p${++counter}`;

const BUILTINS: readonly Omit<Preset, 'id' | 'name'>[] = [
  { labelKey: 'queryVersion', data: 'AT+VER?', mode: 'text', intervalMs: 1000, inSequence: true },
  { labelKey: 'readStatus', data: 'AT+STATUS?', mode: 'text', intervalMs: 500, inSequence: true },
  {
    labelKey: 'readTempHumidity',
    data: '01 03 00 00 00 02 C4 0B',
    mode: 'hex',
    intervalMs: 1000,
    inSequence: true,
  },
  {
    labelKey: 'readVoltage',
    data: '01 04 00 10 00 01 70 0D',
    mode: 'hex',
    intervalMs: 800,
    inSequence: true,
  },
  {
    labelKey: 'heartbeat',
    data: 'AA 55 01 00 FF',
    mode: 'hex',
    intervalMs: 2000,
    inSequence: false,
  },
  {
    labelKey: 'relayOn',
    data: '01 05 00 00 FF 00 8C 3A',
    mode: 'hex',
    intervalMs: 1000,
    inSequence: false,
  },
  {
    labelKey: 'relayOff',
    data: '01 05 00 00 00 00 CD CA',
    mode: 'hex',
    intervalMs: 1000,
    inSequence: false,
  },
  { labelKey: 'outputEnable', data: 'AT+OUT=1', mode: 'text', intervalMs: 1000, inSequence: false },
  { labelKey: 'saveConfig', data: 'AT+SAVE', mode: 'text', intervalMs: 1000, inSequence: false },
  { labelKey: 'softReset', data: 'AT+RST', mode: 'text', intervalMs: 1000, inSequence: false },
];

function blankPreset(index: number): Preset {
  return {
    id: nextId(),
    labelKey: null,
    name: `#${index + 1}`,
    data: '',
    mode: 'text',
    intervalMs: 1000,
    inSequence: false,
  };
}

const PRESETS_KEY = 'presets';
/** 顺序循环的间隔单独存：它不是预设内容，不该混进导出文件的格式里。 */
const SEQUENCE_GAP_KEY = 'sequenceGapMs';
const DEFAULT_SEQUENCE_GAP_MS = 300;

function loadSequenceGap(): number {
  const raw = readStoredJson<unknown>(SEQUENCE_GAP_KEY, null);
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 10
    ? raw
    : DEFAULT_SEQUENCE_GAP_MS;
}

/** 导出与本地持久化共用同一套字段，因此两者的还原路径也完全一致。 */
function serializePresets(presets: readonly Preset[]): unknown {
  return {
    version: PRESET_EXPORT_VERSION,
    presets: presets.map((preset) => ({
      name: preset.name,
      labelKey: preset.labelKey,
      data: preset.data,
      mode: preset.mode,
      intervalMs: preset.intervalMs,
      inSequence: preset.inSequence,
    })),
  };
}

/**
 * 从 localStorage 还原预设。
 *
 * 直接复用导入用的校验器：存量数据和用户手里的 JSON 文件面对的风险是一样的
 * （旧版本字段、被手改、被别的标签页写坏），没有理由维护两套校验。
 * 校验不通过就整体退回内置示例，而不是让半截数据进到界面里。
 */
function loadPresets(): Preset[] {
  const result = validatePresetPayload(readStoredJson<unknown>(PRESETS_KEY, null));
  return result.ok ? result.presets : defaultPresets();
}

function defaultPresets(): Preset[] {
  // 前 10 条是内置示例，其余补空行凑满固定总数
  const presets: Preset[] = BUILTINS.map((preset) => ({ ...preset, id: nextId(), name: '' }));
  while (presets.length < PRESET_COUNT) presets.push(blankPreset(presets.length));
  return presets;
}

/** 内置预设显示当前语言的名字，用户改过名的显示自定义名。 */
export function presetLabel(preset: Preset, messages: Messages): string {
  return preset.labelKey ? messages.presetNames[preset.labelKey] : preset.name;
}

export type PresetIssue =
  { id: string; kind: 'lossy' } | { id: string; kind: 'parse'; error: HexParseError };

interface PresetState {
  /** 恒为 PRESET_COUNT 条，按 PRESET_PAGE_SIZE 分页展示。 */
  presets: readonly Preset[];
  /** 当前页，从 0 开始。 */
  page: number;
  /** 顺序循环两条之间的间隔。 */
  sequenceGapMs: number;
  /** 每条预设当前的问题（HEX 解析失败 / 模式切换被拒），按 id 索引。 */
  issues: Readonly<Record<string, PresetIssue>>;

  rename: (id: string, name: string) => void;
  setData: (id: string, data: string) => void;
  setInterval: (id: string, intervalMs: number) => void;
  setInSequence: (id: string, inSequence: boolean) => void;
  toggleMode: (id: string) => void;

  sendOnce: (id: string) => Promise<void>;
  toggleLoop: (id: string) => void;
  setSequenceGapMs: (gapMs: number) => void;
  toggleSequence: () => void;

  setPage: (page: number) => void;
  replaceAll: (presets: Preset[]) => void;
  exportPayload: () => string;
}

function validate(preset: Preset): PresetIssue | null {
  if (preset.mode !== 'hex') return null;
  const result = buildFrame(preset.data, 'hex', 'none');
  return result.ok ? null : { id: preset.id, kind: 'parse', error: result.error };
}

function withIssue(
  issues: Readonly<Record<string, PresetIssue>>,
  id: string,
  issue: PresetIssue | null,
): Record<string, PresetIssue> {
  const next = { ...issues };
  if (issue) next[id] = issue;
  else delete next[id];
  return next;
}

let sequenceCursor = 0;

export const usePresetStore = create<PresetState>()((set, get) => {
  const patch = (id: string, changes: Partial<Preset>): void =>
    set((state) => {
      const presets = state.presets.map((preset) =>
        preset.id === id ? { ...preset, ...changes } : preset,
      );
      const updated = presets.find((preset) => preset.id === id);
      return {
        presets,
        issues: updated ? withIssue(state.issues, id, validate(updated)) : state.issues,
      };
    });

  return {
    presets: loadPresets(),
    // page 不持久化：翻页是当下的浏览位置，不是配置
    page: 0,
    sequenceGapMs: loadSequenceGap(),
    issues: {},

    // 用户一改名就切断与内置翻译的关联，语言切换不会再覆盖他的命名
    rename: (id, name) => patch(id, { name, labelKey: null }),

    setData: (id, data) => patch(id, { data }),

    setInterval: (id, intervalMs) => {
      const clamped = Math.max(10, Math.round(intervalMs) || 10);
      patch(id, { intervalMs: clamped });
      useTasksStore.getState().update(presetTask(id), { intervalMs: clamped });
    },

    setInSequence: (id, inSequence) => patch(id, { inSequence }),

    toggleMode: (id) => {
      const preset = get().presets.find((item) => item.id === id);
      if (!preset) return;
      const target: PayloadMode = preset.mode === 'hex' ? 'text' : 'hex';
      const converted = convertPayload(preset.data, preset.mode, target);
      if (!converted.ok) {
        set((state) => ({
          issues: withIssue(
            state.issues,
            id,
            converted.reason === 'lossy'
              ? { id, kind: 'lossy' }
              : { id, kind: 'parse', error: converted.error },
          ),
        }));
        return;
      }
      patch(id, { mode: target, data: converted.data });
    },

    sendOnce: async (id) => {
      const preset = get().presets.find((item) => item.id === id);
      if (!preset) return;
      const result = buildFrame(preset.data, preset.mode, 'none');
      if (!result.ok) return;
      await useConnectionStore.getState().send(result.bytes);
    },

    toggleLoop: (id) => {
      const tasks = useTasksStore.getState();
      const taskId = presetTask(id);
      if (tasks.running.includes(taskId)) {
        tasks.stop(taskId);
        return;
      }
      if (!useConnectionStore.getState().isOpen()) {
        useLogStore.getState().appendNotice({ code: 'not-open' });
        return;
      }
      const preset = get().presets.find((item) => item.id === id);
      if (!preset) return;
      tasks.start(taskId, {
        intervalMs: preset.intervalMs,
        // 交给会话所在的那一侧执行；VS Code 里就是扩展宿主，面板隐藏也照跑
        frames: presetFrames(preset),
        run: () => get().sendOnce(id),
      });
    },

    setSequenceGapMs: (gapMs) => set({ sequenceGapMs: Math.max(10, Math.round(gapMs) || 10) }),

    toggleSequence: () => {
      const tasks = useTasksStore.getState();
      if (tasks.running.includes(SEQUENCE_TASK)) {
        tasks.stop(SEQUENCE_TASK);
        return;
      }
      if (!useConnectionStore.getState().isOpen()) {
        useLogStore.getState().appendNotice({ code: 'not-open' });
        return;
      }
      if (!get().presets.some((preset) => preset.inSequence)) return;

      sequenceCursor = 0;
      tasks.start(SEQUENCE_TASK, {
        intervalMs: get().sequenceGapMs,
        // 顺序循环也能交给宿主：把整条队列按勾选顺序交出去，它每一拍取下一条。
        // 队列在循环期间变化时由下面的订阅重新推送，游标不会跳回第一条。
        frames: sequenceFrames(get().presets),
        run: async () => {
          // 每次都取最新的勾选列表，循环期间增删预设不会错位
          const queue = get().presets.filter((preset) => preset.inSequence);
          if (queue.length === 0) return;
          const preset = queue[sequenceCursor % queue.length]!;
          sequenceCursor += 1;
          await get().sendOnce(preset.id);
        },
      });
    },

    setPage: (page) => set({ page: Math.min(PRESET_PAGES - 1, Math.max(0, page)) }),

    replaceAll: (presets) => {
      useTasksStore.getState().stopAll();
      set({ presets, issues: {} });
    },

    exportPayload: () => JSON.stringify(serializePresets(get().presets), null, 2),
  };
});

/* ---------------- 导入：显式校验（缺陷 D17） ---------------- */

export type ImportResult =
  { ok: true; presets: Preset[]; skipped: number } | { ok: false; reason: string };

/**
 * 原型只检查「是不是数组」，字段一律 `String(p.name || 'cmd')` 硬转，
 * 超过 64 条静默截断，也没有版本号（.dc.html:860-878）。
 * 这里逐条校验，非法条目跳过并计数，让用户知道导入了什么、丢了什么。
 */
export function parseImportedPresets(raw: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'JSON syntax error' };
  }
  return validatePresetPayload(parsed);
}

/** 校验已解析出来的结构。导入文件与读取 localStorage 共用。 */
export function validatePresetPayload(parsed: unknown): ImportResult {
  const items = Array.isArray(parsed)
    ? parsed // 兼容原型导出的裸数组
    : isRecord(parsed) && Array.isArray(parsed.presets)
      ? parsed.presets
      : null;

  if (!items) return { ok: false, reason: 'expected an array of presets' };
  if (items.length === 0) return { ok: false, reason: 'file contains no presets' };

  const presets: Preset[] = [];
  let skipped = 0;

  for (const item of items.slice(0, PRESET_COUNT)) {
    if (!isRecord(item) || typeof item.data !== 'string') {
      skipped += 1;
      continue;
    }
    // 旧格式用 hex: boolean，新格式用 mode: 'text' | 'hex'
    const mode: PayloadMode =
      item.mode === 'hex' || item.mode === 'text' ? item.mode : item.hex === true ? 'hex' : 'text';

    const interval = Number(item.intervalMs ?? item.interval);
    // 内置预设的名字来自翻译目录、name 字段本就是空的：labelKey 丢掉的话，
    // 导出再导入回来就全变成兜底的 'preset'。
    // 但自定义名字优先 —— 与 rename() 同一条规则：一旦有自己的名字就切断内置翻译，
    // 否则手改过的文件导入回来会被内置译名盖掉。
    const named = typeof item.name === 'string' && item.name.trim() ? item.name : null;
    const labelKey = named ? null : toBuiltinKey(item.labelKey);
    const name = named ?? (labelKey ? '' : 'preset');

    presets.push({
      id: nextId(),
      labelKey,
      name,
      data: item.data,
      mode,
      intervalMs: Number.isFinite(interval) ? Math.max(10, Math.round(interval)) : 1000,
      inSequence: item.inSequence === true || item.seq === true,
    });
  }

  if (presets.length === 0) return { ok: false, reason: 'no valid preset in file' };

  // 条数固定，不足补空行、超出截断，界面才不需要处理「行数会变」这件事
  while (presets.length < PRESET_COUNT) presets.push(blankPreset(presets.length));

  return { ok: true, presets, skipped: skipped + Math.max(0, items.length - PRESET_COUNT) };
}

/** 只认识目录里确实存在的内置键，其余一律当作用户自定义预设。 */
function toBuiltinKey(value: unknown): BuiltinPresetKey | null {
  return typeof value === 'string' && (BUILTIN_PRESET_KEYS as readonly string[]).includes(value)
    ? (value as BuiltinPresetKey)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 一条预设对应的帧。内容解析不通过时没有帧可发。 */
function presetFrames(preset: Preset): Uint8Array[] {
  const result = buildFrame(preset.data, preset.mode, 'none');
  return result.ok ? [result.bytes] : [];
}

/** 顺序循环的队列：按勾选顺序排好的多条帧。 */
function sequenceFrames(presets: readonly Preset[]): Uint8Array[] {
  return presets.filter((preset) => preset.inSequence).flatMap(presetFrames);
}

usePresetStore.subscribe(({ presets, sequenceGapMs }) => {
  saveSoon(PRESETS_KEY, serializePresets(presets));
  saveSoon(SEQUENCE_GAP_KEY, sequenceGapMs);

  // 循环期间改预设内容 / 增删队列成员要即时生效。浏览器侧靠执行体重读状态自然就有；
  // 交给宿主执行时内容在那一头，必须显式推过去。
  const tasks = useTasksStore.getState();
  tasks.update(SEQUENCE_TASK, { frames: sequenceFrames(presets) });
  for (const preset of presets) {
    tasks.update(presetTask(preset.id), { frames: presetFrames(preset) });
  }
});
