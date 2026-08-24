/**
 * 偏好持久化的公共部件：攒批写入 + 读取侧的逐字段校验。
 *
 * 两条约束决定了这里的做法：
 *  - **写要攒批**。发送区文本框、预设的数据格每敲一个键都会改状态，逐次
 *    `localStorage.setItem` 是主线程上的同步 IO，高频编辑时能感觉到顿。
 *  - **读要逐字段校验**。localStorage 里的东西可能来自旧版本、被别的标签页写坏、
 *    或被用户手改。任何一个字段不认识就退回默认值，绝不能让存量数据把应用弄挂 ——
 *    这也是这里不做 schema 版本号的原因：字段级兜底本身就是向后兼容的。
 */
import { writeStoredJson } from './storage';

/** 攒批间隔。取值只需保证连续击键落在同一批里，不必更长。 */
const WRITE_DELAY_MS = 250;

const pending = new Map<string, unknown>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** 立即把攒着的写入落盘。页面隐藏/卸载前必须调用，否则最后一批改动会丢。 */
export function flushPersist(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return;
  for (const [key, value] of pending) writeStoredJson(key, value);
  pending.clear();
}

/** 排队写入某个键；同一键在一批内只写最后一次。 */
export function saveSoon(key: string, value: unknown): void {
  pending.set(key, value);
  timer ??= setTimeout(flushPersist, WRITE_DELAY_MS);
}

if (typeof window !== 'undefined') {
  // pagehide 覆盖关闭/前进后退/移动端切走；visibilitychange 兜住切标签页。
  // 两者都比 beforeunload 可靠（beforeunload 在移动端常常不触发）。
  window.addEventListener('pagehide', flushPersist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist();
  });
}

/* ---------------- 读取侧：逐字段校验 ---------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pickBoolean(source: unknown, key: string, fallback: boolean): boolean {
  if (!isRecord(source)) return fallback;
  return typeof source[key] === 'boolean' ? source[key] : fallback;
}

/** 允许空串 —— 发送内容被清空也是一种有效状态。 */
export function pickString(source: unknown, key: string, fallback: string): string {
  if (!isRecord(source)) return fallback;
  return typeof source[key] === 'string' ? source[key] : fallback;
}

export function pickEnum<T extends string>(
  source: unknown,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (!isRecord(source)) return fallback;
  const value = source[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** 整数字段；`accept` 用来接入各自领域的合法性判断（如波特率区间）。 */
export function pickInt(
  source: unknown,
  key: string,
  fallback: number,
  accept: (value: number) => boolean = Number.isInteger,
): number {
  if (!isRecord(source)) return fallback;
  const value = source[key];
  return typeof value === 'number' && Number.isInteger(value) && accept(value) ? value : fallback;
}

/** 仅供测试：丢弃尚未落盘的写入，避免定时器跨用例泄漏。 */
export function __resetPersistForTests(): void {
  pending.clear();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
