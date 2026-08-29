/**
 * localStorage 安全包装 —— 缺陷 D18。
 *
 * 原型直接 `localStorage.getItem(...)`（.dc.html:410-411、723）。在 Safari 无痕模式、
 * 或浏览器设置为「阻止站点数据」时，访问 localStorage 本身就会抛异常，整个组件挂载失败。
 *
 * 支持多页面（同时开多个标签页，各连一个端口）之后，「存在哪」不再只有一个答案，
 * 于是这里引入了作用域：
 *  - `global`：localStorage，同源全标签页共享。语言、主题、预设、端口备注属于这一档。
 *  - `page`：sessionStorage，每个标签页独立且刷新后仍在。当前选中哪个端口、
 *    发送框里写着什么、接收区看的是 HEX 还是 TXT，都应该各页面互不干扰。
 *  - `layered`（见 readLayered / writeLayered）：读时 page 优先、global 兜底，写时两处都写。
 *    效果是「已开的页面各改各的，新开的页面继承你最后一次的选择」。
 */

const PREFIX = 'wst.';

/** 偏好的存储作用域。 */
export type PrefScope = 'global' | 'page';

/** localStorage 里的完整键名。storage 事件回调里需要用它比对。 */
export function storageKey(key: string): string {
  return PREFIX + key;
}

/** 底层存储要的最小能力。浏览器的 Storage 天然满足它。 */
export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/**
 * 可替换的存储后端。
 *
 * VS Code 的 webview 必须换掉 global 那一档：webview 的 origin 是
 * `vscode-webview://<每次重建都变的 uuid>`，localStorage 因此活不过一次面板重建，
 * 用户会发现设置在不停地自己重置。那边改用扩展宿主的 globalState
 * （顺带还能跟着 Settings Sync 跨机器同步）。
 */
const backends: Record<PrefScope, StorageLike | null> = { page: null, global: null };

export function setStorageBackend(scope: PrefScope, backend: StorageLike): void {
  backends[scope] = backend;
}

/**
 * 取底层存储。
 *
 * 访问 `sessionStorage` / `localStorage` 这两个属性本身就可能抛异常（隐私模式、
 * 站点数据被禁用），所以取用也要包在 try 里，而不只是包住 getItem/setItem。
 */
function backing(scope: PrefScope): StorageLike | null {
  const injected = backends[scope];
  if (injected) return injected;
  try {
    return scope === 'page' ? sessionStorage : localStorage;
  } catch {
    // 隐私模式 / 站点数据被禁用：拿不到存储只影响偏好记忆，不影响功能
    return null;
  }
}

export function readStored(key: string, scope: PrefScope = 'global'): string | null {
  try {
    return backing(scope)?.getItem(PREFIX + key) ?? null;
  } catch {
    // 同上；读不到偏好设置只影响体验
    return null;
  }
}

export function writeStored(key: string, value: string, scope: PrefScope = 'global'): void {
  try {
    backing(scope)?.setItem(PREFIX + key, value);
  } catch {
    // 同上；也可能是配额已满。偏好设置写不进去不值得打断用户操作
  }
}

export function readStoredJson<T>(key: string, fallback: T, scope: PrefScope = 'global'): T {
  const raw = readStored(key, scope);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 存量数据格式变更或被外部改坏时，回退到默认值而不是让整个应用起不来
    return fallback;
  }
}

export function writeStoredJson(key: string, value: unknown, scope: PrefScope = 'global'): void {
  writeStored(key, JSON.stringify(value), scope);
}

/**
 * 分层读取：本页面存过就用本页面的，没存过就继承全局的那份。
 *
 * 「继承」这一步是有意的 —— 新开一个标签页时，如果连视图模式、波特率都退回出厂默认，
 * 多页面反而变得难用。分层之后：老页面各自独立，新页面延续你最后一次的选择。
 */
export function readLayeredJson<T>(key: string, fallback: T): T {
  const page = readStored(key, 'page');
  if (page !== null) return readStoredJson(key, fallback, 'page');
  return readStoredJson(key, fallback, 'global');
}

/** 分层写入：两处都写。global 那份的作用只是「新页面的初始值」。 */
export function writeLayeredJson(key: string, value: unknown): void {
  writeStoredJson(key, value, 'page');
  writeStoredJson(key, value, 'global');
}

/** readLayeredJson 的字符串版本。 */
export function readLayered(key: string): string | null {
  return readStored(key, 'page') ?? readStored(key, 'global');
}

/** writeLayeredJson 的字符串版本。 */
export function writeLayered(key: string, value: string): void {
  writeStored(key, value, 'page');
  writeStored(key, value, 'global');
}

/** 读取一个受限取值集合的偏好，非法值回退到默认。 */
export function readStoredEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
  scope: PrefScope = 'global',
): T {
  const raw = readStored(key, scope);
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/** 仅供测试：清掉注入的后端，回到浏览器默认。 */
export function __resetStorageBackendsForTests(): void {
  backends.page = null;
  backends.global = null;
}
