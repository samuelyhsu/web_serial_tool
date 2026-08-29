import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetStorageBackendsForTests,
  readStored,
  readStoredJson,
  writeStored,
} from '@/lib/storage';
import { installPrefStore } from './prefStore';

/**
 * webview 的偏好走扩展宿主的 globalState，不走 localStorage —— webview 的 origin
 * 里带着一个每次重建都会变的 uuid，存进去的东西活不过一次面板重建。
 */
function seedRoot(prefs: unknown): void {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');
  if (prefs !== undefined && root) root.dataset.prefs = JSON.stringify(prefs);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  __resetStorageBackendsForTests();
  document.body.innerHTML = '';
});

describe('webview 偏好存储', () => {
  it('开机即从 data-prefs 同步读到设置 —— 界面等不到一条 postMessage', () => {
    seedRoot({ 'wst.theme': 'light', 'wst.viewPrefs': '{"view":"hex"}' });
    installPrefStore(() => undefined);

    expect(readStored('theme')).toBe('light');
    expect(readStoredJson('viewPrefs', null)).toEqual({ view: 'hex' });
  });

  it('写入交给宿主落盘，同时立刻在本地可读', () => {
    seedRoot({});
    const write = vi.fn();
    installPrefStore(write);

    writeStored('theme', 'dark');

    expect(write).toHaveBeenCalledWith('wst.theme', 'dark');
    expect(readStored('theme')).toBe('dark');
  });

  it('不碰 localStorage —— 那份在 webview 里活不过一次面板重建', () => {
    seedRoot({});
    installPrefStore(() => undefined);

    writeStored('theme', 'dark');

    expect(localStorage.getItem('wst.theme')).toBeNull();
  });

  it('宿主没给偏好时一切照常，只是读不到旧设置', () => {
    seedRoot(undefined);
    expect(() => installPrefStore(() => undefined)).not.toThrow();
    expect(readStored('theme')).toBeNull();
  });

  it('data-prefs 被写坏时退回空，而不是让界面起不来', () => {
    document.body.innerHTML = '<div id="root" data-prefs="not json"></div>';
    installPrefStore(() => undefined);

    expect(readStored('theme')).toBeNull();
  });

  it('非字符串的值被忽略 —— 存储层的契约是字符串进、字符串出', () => {
    seedRoot({ 'wst.theme': 42, 'wst.lang': 'en' });
    installPrefStore(() => undefined);

    expect(readStored('theme')).toBeNull();
    expect(readStored('lang')).toBe('en');
  });

  it('page 作用域仍然走 sessionStorage —— 它的语义本就与视图同生共死', () => {
    seedRoot({});
    installPrefStore(() => undefined);

    writeStored('selectedPort', 'usb:1A86:7523#0', 'page');

    expect(sessionStorage.getItem('wst.selectedPort')).toBe('usb:1A86:7523#0');
  });
});
