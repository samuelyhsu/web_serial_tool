import { describe, expect, it } from 'vitest';
import {
  readLayered,
  readLayeredJson,
  readStored,
  writeLayered,
  writeLayeredJson,
  writeStored,
} from './storage';

/**
 * 作用域是「同时开多个页面各连一个端口」的地基：哪些偏好该跟着页面走、
 * 哪些该全局共享，弄反了就会出现「刷新一下两个页面跳回同一个端口」这类问题。
 */
describe('偏好存储的作用域', () => {
  it('page 作用域写进 sessionStorage，与 global 互不影响', () => {
    writeStored('k', 'page-value', 'page');
    writeStored('k', 'global-value', 'global');

    expect(sessionStorage.getItem('wst.k')).toBe('page-value');
    expect(localStorage.getItem('wst.k')).toBe('global-value');
    expect(readStored('k', 'page')).toBe('page-value');
    expect(readStored('k')).toBe('global-value');
  });

  it('分层读取优先本页面那份', () => {
    writeStored('k', 'global-value', 'global');
    expect(readLayered('k')).toBe('global-value');

    writeStored('k', 'page-value', 'page');
    expect(readLayered('k')).toBe('page-value');
  });

  it('本页面没存过时继承全局那份 —— 新开的页面不该退回出厂默认', () => {
    writeLayered('k', 'from-another-page');
    sessionStorage.clear(); // 等价于「新开一个标签页」

    expect(readLayered('k')).toBe('from-another-page');
  });

  it('分层写入两处都写，JSON 版同理', () => {
    writeLayeredJson('obj', { view: 'hex' });

    expect(readLayeredJson('obj', null)).toEqual({ view: 'hex' });
    expect(JSON.parse(localStorage.getItem('wst.obj') ?? 'null')).toEqual({ view: 'hex' });
    expect(JSON.parse(sessionStorage.getItem('wst.obj') ?? 'null')).toEqual({ view: 'hex' });
  });

  it('本页面那份写坏了也只退回默认，不影响可用性', () => {
    sessionStorage.setItem('wst.obj', 'not json');
    expect(readLayeredJson('obj', { fallback: true })).toEqual({ fallback: true });
  });
});
