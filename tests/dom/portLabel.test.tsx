import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PortDescriptor } from '@/core/transport/portRegistry';
import { useConnectionStore } from '@/store/connectionStore';
import { __resetLogStoreForTests } from '@/store/logStore';
import { usePortAliasStore } from '@/store/portAliasStore';
import { useUiStore } from '@/store/uiStore';
import { App } from '@/ui/App';

const CH340: PortDescriptor = {
  key: 'port-1',
  ordinal: 1,
  identity: 'usb:1A86:7523#0',
  label: '#1 CH340 (1A86:7523)',
  chip: 'CH340',
  vendor: 'WCH 沁恒',
  usbVendorId: 0x1a86,
  usbProductId: 0x7523,
  connected: true,
};

/**
 * 端口备注住在 portAliasStore 里，而标签页标题与状态栏读的是 connectionStore
 * 的 `selectedPortLabel()` —— 那个 getter 里是 `usePortAliasStore.getState()`，
 * zustand 只在**本 store** 变化时重跑 selector。于是改完备注，PortPicker 立刻变、
 * 这两处却纹丝不动，而「多页面各连一口靠标题分辨」正是它们显示端口名的全部理由。
 */
describe('端口备注的显示要跨 store 生效', () => {
  beforeEach(() => {
    __resetLogStoreForTests();
    localStorage.clear();
    useUiStore.setState({ language: 'zh', theme: 'dark', filter: '', view: 'text' });
    usePortAliasStore.setState({ aliases: {} });
    useConnectionStore.setState({
      supported: true,
      ports: [CH340],
      selectedPortKey: CH340.key,
      sessionState: 'closed',
      openedAt: 0,
    });
  });

  afterEach(cleanup);

  it('改备注后状态栏立刻跟上', () => {
    render(<App />);
    const bar = screen.getByRole('contentinfo');
    expect(bar.textContent).toContain(CH340.label);

    act(() => {
      usePortAliasStore.getState().setAlias(CH340.identity, '电机控制器');
    });

    expect(bar.textContent).toContain(`电机控制器 · ${CH340.label}`);
  });

  it('改备注后浏览器标签标题也跟上', () => {
    render(<App />);

    act(() => {
      usePortAliasStore.getState().setAlias(CH340.identity, '电机控制器');
    });

    expect(document.title).toContain('电机控制器 · #1 CH340');
  });
});
