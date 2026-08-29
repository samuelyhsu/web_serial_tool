import { setStorageBackend, type StorageLike } from '@/lib/storage';

/**
 * webview 的偏好存储。
 *
 * 不能用 localStorage：webview 的 origin 是 `vscode-webview://<每次重建都变的 uuid>`，
 * 存进去的东西活不过一次面板重建，用户会看到设置在不停自己重置。
 *
 * 真正的存放地是扩展宿主的 globalState（顺带还能跟着 Settings Sync 跨机器同步）。
 * 读必须是同步的 —— 界面在模块初始化时就要拿设置，等不到一条 postMessage ——
 * 所以宿主把整份偏好烙在 `#root` 的 data-prefs 属性里，这里开机即读。
 */
export function installPrefStore(write: (key: string, value: unknown) => void): void {
  const cache = new Map<string, string>();

  const raw = document.getElementById('root')?.dataset.prefs;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') cache.set(key, value);
        }
      }
    } catch {
      // 属性被写坏了只影响「记不住设置」，不该让界面起不来
    }
  }

  const backend: StorageLike = {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => {
      cache.set(key, value);
      write(key, value);
    },
  };

  setStorageBackend('global', backend);
  // page 那一档保持 sessionStorage：它的语义本来就是「本视图独有、随视图消失」，
  // 与 webview 实例的生命周期正好吻合
}
