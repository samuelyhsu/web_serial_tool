import { beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

/**
 * 每个用例开始前把两处存储都清空。
 *
 * 偏好分成 global（localStorage）与 page（sessionStorage）两个作用域之后，
 * 只清 localStorage 是不够的：分层读取是 page 优先的，上一个用例留下的 page 副本
 * 会盖掉下一个用例特意写进 localStorage 的存量数据，测出来的现象与真实行为无关。
 *
 * 判空是必须的：有些用例跑在 node 环境（如协议的结构化克隆保真测试），
 * 那里根本没有这两个对象。
 */
beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
});
