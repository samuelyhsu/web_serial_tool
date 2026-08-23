import { create } from 'zustand';
import { RingBuffer } from '@/core/buffer/ringBuffer';
import { escapeControlChars } from '@/core/codec/display';
import { formatHex } from '@/core/codec/hex';
import { StreamingUtf8Decoder } from '@/core/codec/text';
import type { SessionNotice } from '@/core/session/notices';
import type { Direction } from '@/core/session/serialSession';
import type { Language, Messages } from '@/i18n';

export type LogKind = Direction | 'sys';
export type LogView = 'text' | 'hex';

export interface LogEntry {
  readonly id: number;
  readonly kind: LogKind;
  readonly time: Date;
  readonly bytes: Uint8Array | null;
  /** 入库时算好的文本视图（缺陷 D7：不在渲染路径上重算）。 */
  readonly text: string;
  /** 系统消息保留结构化事件，切换语言时可以重新翻译。 */
  readonly notice: SessionNotice | null;
  /** HEX 视图惰性计算并缓存，只有真正切到 HEX 的条目才会付出代价。 */
  hexCache: string | null;
}

export const LOG_CAPACITY = 5000;
/** 攒批提交间隔：高波特率下把上千次 setState 压成每秒十几次。 */
const FLUSH_INTERVAL_MS = 60;

const ring = new RingBuffer<LogEntry>(LOG_CAPACITY);
const decoders: Record<Direction, StreamingUtf8Decoder> = {
  rx: new StreamingUtf8Decoder(),
  tx: new StreamingUtf8Decoder(),
};

let nextId = 1;
let pending: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let throughputWindow = 0;

export function entryHex(entry: LogEntry): string {
  if (entry.bytes === null) return '';
  entry.hexCache ??= formatHex(entry.bytes);
  return entry.hexCache;
}

export function entryBody(entry: LogEntry, view: LogView, messages: Messages): string {
  if (entry.kind === 'sys') {
    return entry.notice ? messages.notice(entry.notice) : entry.text;
  }
  return view === 'hex' ? entryHex(entry) : entry.text;
}

interface LogState {
  /** 每次提交自增，作为渲染选择器的缓存键。 */
  version: number;
  rxBytes: number;
  txBytes: number;
  rxFrames: number;
  txFrames: number;

  appendFrame: (direction: Direction, bytes: Uint8Array) => void;
  appendNotice: (notice: SessionNotice) => void;
  appendMessage: (text: string) => void;
  addThroughput: (direction: Direction, byteCount: number) => void;
  clear: () => void;
}

export const useLogStore = create<LogState>()((set) => ({
  version: 0,
  rxBytes: 0,
  txBytes: 0,
  rxFrames: 0,
  txFrames: 0,

  appendFrame: (direction, bytes) => {
    pending.push({
      id: nextId++,
      kind: direction,
      time: new Date(),
      // 环形缓冲要把这份字节留到被淘汰为止（最多 LOG_CAPACITY 条）。驱动交付的视图
      // 可能只占一块大 backing buffer 的一小段，直接持有会把整块 buffer 一起 retain：
      // 高波特率下就是「每帧几字节、实际吃掉 bufferSize」的内存放大。
      // 视图已经独占整块 buffer 时不复制，常见情况下没有额外开销。
      bytes: bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice(),
      // 流式解码放在入库时做：解码器状态跨帧连续，被切开的多字节字符才能正确还原
      text: escapeControlChars(decoders[direction].decode(bytes)),
      notice: null,
      hexCache: null,
    });
    scheduleFlush();
  },

  appendNotice: (notice) => {
    pending.push({
      id: nextId++,
      kind: 'sys',
      time: new Date(),
      bytes: null,
      text: '',
      notice,
      hexCache: null,
    });
    flushNow(); // 系统消息是对用户操作的反馈，不该等 60ms
  },

  appendMessage: (text) => {
    pending.push({
      id: nextId++,
      kind: 'sys',
      time: new Date(),
      bytes: null,
      text,
      notice: null,
      hexCache: null,
    });
    flushNow();
  },

  addThroughput: (direction, byteCount) => {
    if (direction === 'rx') throughputWindow += byteCount;
  },

  clear: () => {
    ring.clear();
    pending = [];
    decoders.rx.reset();
    decoders.tx.reset();
    throughputWindow = 0;
    set((state) => ({
      version: state.version + 1,
      rxBytes: 0,
      txBytes: 0,
      rxFrames: 0,
      txFrames: 0,
    }));
  },
}));

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_INTERVAL_MS);
}

function flushNow(): void {
  // 缺陷 D8：没有待处理数据就一次 setState 都不做，空闲时界面完全静止
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];

  let rxBytes = 0;
  let txBytes = 0;
  let rxFrames = 0;
  let txFrames = 0;
  for (const entry of batch) {
    ring.push(entry);
    if (entry.kind === 'rx') {
      rxBytes += entry.bytes?.length ?? 0;
      rxFrames += 1;
    } else if (entry.kind === 'tx') {
      txBytes += entry.bytes?.length ?? 0;
      txFrames += 1;
    }
  }

  useLogStore.setState((state) => ({
    version: state.version + 1,
    rxBytes: state.rxBytes + rxBytes,
    txBytes: state.txBytes + txBytes,
    rxFrames: state.rxFrames + rxFrames,
    txFrames: state.txFrames + txFrames,
  }));
}

/**
 * 把攒批中的条目立即提交到环形缓冲。
 *
 * 导出日志前必须调用：条目最多会在 pending 里待 60ms，直接读 allEntries()
 * 会漏掉最近这一批。
 */
export function flushPendingEntries(): void {
  flushNow();
}

/** 取走并清零接收速率统计窗口，由状态栏每秒调用一次。 */
export function consumeThroughputWindow(): number {
  const bytes = throughputWindow;
  throughputWindow = 0;
  return bytes;
}

/** 导出用：按时间顺序取全部条目。调用前先 flushPendingEntries()。 */
export function allEntries(): LogEntry[] {
  return ring.toArray();
}

/* ---------------- 渲染选择器 ---------------- */

export interface RowSegment {
  text: string;
  hit: boolean;
}

export interface LogRow {
  id: number;
  kind: LogKind;
  timestamp: string;
  segments: RowSegment[];
}

export interface RowQuery {
  version: number;
  language: Language;
  view: LogView;
  filter: string;
  onlyMatch: boolean;
  showTx: boolean;
  showTimestamp: boolean;
  limit: number;
}

let cacheKey = '';
let cacheRows: LogRow[] = [];

/**
 * 计算要渲染的行 —— 缺陷 D7 的核心修复。
 *
 * 原型在每次渲染里对最多 2000 条记录逐条重算 hexStr/asciiStr 再过滤，最后只用最后 600 条；
 * 每次按键、每 500ms 心跳都要跑一遍。这里做两件事：
 *  1. 从最新往回扫，凑够 limit 条就停 —— 无过滤时只碰 600 条，不是 2000 条；
 *  2. 结果按查询条件记忆化，输入框每敲一个字符只重算一次，重渲染不重算。
 */
export function selectRows(query: RowQuery): LogRow[] {
  const key = [
    query.version,
    query.language,
    query.view,
    query.filter,
    query.onlyMatch ? 1 : 0,
    query.showTx ? 1 : 0,
    query.showTimestamp ? 1 : 0,
    query.limit,
  ].join('|');
  if (key === cacheKey) return cacheRows;

  const messages = messagesRef;
  const needle = query.filter.trim().toLowerCase();
  const rows: LogRow[] = [];

  for (let i = ring.size - 1; i >= 0 && rows.length < query.limit; i -= 1) {
    const entry = ring.at(i)!;
    if (entry.kind === 'tx' && !query.showTx) continue;

    const body = entryBody(entry, query.view, messages);
    if (needle && query.onlyMatch && !body.toLowerCase().includes(needle)) continue;

    rows.push({
      id: entry.id,
      kind: entry.kind,
      timestamp: query.showTimestamp ? formatTime(entry.time) : '',
      segments: highlight(body, needle, query.filter.trim().length),
    });
  }

  rows.reverse();
  cacheKey = key;
  cacheRows = rows;
  return rows;
}

/**
 * 选择器需要 Messages 来翻译系统消息，但它不是 React 组件、拿不到 context。
 * 由 App 在语言变化时推进来，配合 query.language 参与缓存键，保证不会读到旧目录。
 */
let messagesRef: Messages = {} as Messages;
export function setSelectorMessages(messages: Messages): void {
  messagesRef = messages;
}

function highlight(body: string, needle: string, needleLength: number): RowSegment[] {
  if (!needle || needleLength === 0) return [{ text: body, hit: false }];

  const segments: RowSegment[] = [];
  const haystack = body.toLowerCase();
  let cursor = 0;
  // 原型只高亮第一处匹配，这里把所有匹配都标出来
  for (;;) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    if (index > cursor) segments.push({ text: body.slice(cursor, index), hit: false });
    segments.push({ text: body.slice(index, index + needleLength), hit: true });
    cursor = index + needleLength;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor), hit: false });
  return segments.length > 0 ? segments : [{ text: body, hit: false }];
}

export function formatTime(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

/** 仅供测试：重置模块级状态。 */
export function __resetLogStoreForTests(): void {
  ring.clear();
  pending = [];
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  nextId = 1;
  throughputWindow = 0;
  cacheKey = '';
  cacheRows = [];
  decoders.rx.reset();
  decoders.tx.reset();
  useLogStore.setState({ version: 0, rxBytes: 0, txBytes: 0, rxFrames: 0, txFrames: 0 });
}
