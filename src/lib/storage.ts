/**
 * localStorage 安全包装 —— 缺陷 D18。
 *
 * 原型直接 `localStorage.getItem(...)`（.dc.html:410-411、723）。在 Safari 无痕模式、
 * 或浏览器设置为「阻止站点数据」时，访问 localStorage 本身就会抛异常，整个组件挂载失败。
 */

const PREFIX = 'wst.';

/** localStorage 里的完整键名。storage 事件回调里需要用它比对。 */
export function storageKey(key: string): string {
  return PREFIX + key;
}

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    // 隐私模式 / 站点数据被禁用：读不到偏好设置只影响体验，不影响功能
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // 同上；也可能是配额已满。偏好设置写不进去不值得打断用户操作
  }
}

export function readStoredJson<T>(key: string, fallback: T): T {
  const raw = readStored(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 存量数据格式变更或被外部改坏时，回退到默认值而不是让整个应用起不来
    return fallback;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  writeStored(key, JSON.stringify(value));
}

/** 读取一个受限取值集合的偏好，非法值回退到默认。 */
export function readStoredEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readStored(key);
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}
