import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetLogStoreForTests } from '@/store/logStore';
import { useUiStore } from '@/store/uiStore';
import { App } from '@/ui/App';

describe('App', () => {
  beforeEach(() => {
    __resetLogStoreForTests();
    useUiStore.setState({ language: 'zh', theme: 'dark', filter: '', view: 'text' });
  });

  afterEach(cleanup);

  it('渲染出五个主要区域', () => {
    render(<App />);
    expect(screen.getByText('串口助手')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '接收区' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '单条发送' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '多条发送' })).toBeInTheDocument();
  });

  /**
   * jsdom 没有 navigator.serial，正好等价于「浏览器不支持」的真实场景。
   * 原型此时会锁定演示模式让用户以为能用；这里必须如实说明环境要求。
   */
  it('浏览器不支持 Web Serial 时显示说明横幅而不是假装可用', () => {
    render(<App />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('此浏览器不支持 Web Serial');
    expect(screen.getByRole('link', { name: /MDN/ })).toHaveAttribute(
      'href',
      expect.stringContaining('developer.mozilla.org'),
    );
  });

  it('不支持时「选择端口」和「打开串口」都是禁用的', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: '选择端口…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '打开串口' })).toBeDisabled();
  });

  /** 单端口语义：端口区只剩一个按钮，没有下拉框、没有授权计数、没有撤销按钮。 */
  it('未选端口时端口区只有一个控件', () => {
    render(<App />);
    expect(screen.queryByRole('combobox', { name: '端口' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '备注' })).not.toBeInTheDocument();
  });

  it('主题写到 documentElement 上，供 CSS 变量切换', async () => {
    render(<App />);
    expect(document.documentElement.dataset.theme).toBe('dark');

    await userEvent.click(screen.getByRole('button', { name: '切换深色 / 浅色主题' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('语言切换后界面文案整体换成英文', async () => {
    render(<App />);
    expect(screen.getByText('接收区')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /切换语言|Switch language/ }));
    expect(screen.getByText('Receive')).toBeInTheDocument();
    expect(screen.queryByText('接收区')).not.toBeInTheDocument();
  });

  it('内置预设名随语言切换，且不依赖名字比对', async () => {
    render(<App />);
    // 预设名现在显示在发送按钮上
    expect(screen.getByRole('button', { name: '查询版本' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /切换语言|Switch language/ }));
    expect(screen.getByRole('button', { name: 'Query version' })).toBeInTheDocument();
  });

  /** 缺陷 D16 的回归测试。 */
  it('用户改过名的预设不再被语言切换覆盖', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: '重命名发送按钮: 查询版本' }));

    const nameInput = screen.getByRole('textbox', { name: '重命名发送按钮' });
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, '我的指令{Enter}');

    await userEvent.click(screen.getByRole('button', { name: /切换语言|Switch language/ }));
    expect(screen.getByRole('button', { name: '我的指令' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Query version' })).not.toBeInTheDocument();
  });
});
