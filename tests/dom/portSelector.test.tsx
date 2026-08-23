import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortDescriptor } from '@/core/transport/portRegistry';
import { useConnectionStore } from '@/store/connectionStore';
import { __resetLogStoreForTests } from '@/store/logStore';
import { usePortAliasStore } from '@/store/portAliasStore';
import { useUiStore } from '@/store/uiStore';
import { PortPicker } from '@/ui/Toolbar/PortPicker';

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

/** jsdom 没有 navigator.serial，直接注入 store 状态来测 UI。 */
function seed(port: PortDescriptor | null): void {
  useConnectionStore.setState({
    supported: true,
    ports: port ? [port] : [],
    selectedPortKey: port?.key ?? null,
    sessionState: 'closed',
  });
}

describe('PortPicker', () => {
  beforeEach(() => {
    __resetLogStoreForTests();
    localStorage.clear();
    useUiStore.setState({ language: 'zh' });
    usePortAliasStore.setState({ aliases: {} });
    seed(null);
  });

  afterEach(() => {
    cleanup();
    seed(null);
    useConnectionStore.setState({ supported: false });
    vi.restoreAllMocks();
  });

  it('未选端口时只有一个「选择端口」按钮', () => {
    render(<PortPicker />);
    expect(screen.getByRole('button', { name: '选择端口…' })).toBeInTheDocument();
    // 备注相关控件此时都不该出现
    expect(screen.queryByRole('button', { name: '备注' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('已选端口时按钮显示端口信息，另有一个改备注的按钮', () => {
    seed(CH340);
    render(<PortPicker />);

    expect(screen.getByRole('button', { name: /#1 CH340 \(1A86:7523\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '备注' })).toBeInTheDocument();
    // 单端口语义下不再有下拉框
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  /** 这是需求的核心流程：选完端口立刻让用户起名。 */
  it('选择端口成功后自动弹出备注输入框', async () => {
    const requestPort = vi.fn(() => {
      seed(CH340);
      return Promise.resolve(CH340);
    });
    useConnectionStore.setState({ requestPort });
    render(<PortPicker />);

    await userEvent.click(screen.getByRole('button', { name: '选择端口…' }));

    const input = await screen.findByRole('textbox');
    expect(input).toHaveAttribute('placeholder', '给这个端口起个名字');
    expect(input).toHaveFocus();
  });

  it('输入备注按回车后收起，端口按钮显示备注名', async () => {
    seed(CH340);
    render(<PortPicker />);

    await userEvent.click(screen.getByRole('button', { name: '备注' }));
    await userEvent.type(screen.getByRole('textbox'), '电机控制器{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /电机控制器 · #1 CH340 \(1A86:7523\)/ }),
    ).toBeInTheDocument();
  });

  it('备注持久化，刷新后仍在', async () => {
    seed(CH340);
    render(<PortPicker />);

    await userEvent.click(screen.getByRole('button', { name: '备注' }));
    await userEvent.type(screen.getByRole('textbox'), '调试板{Enter}');

    expect(JSON.parse(localStorage.getItem('wst.portAliases')!)).toEqual({
      'usb:1A86:7523#0': '调试板',
    });
  });

  it('按 Esc 放弃编辑，不写入备注', async () => {
    seed(CH340);
    render(<PortPicker />);

    await userEvent.click(screen.getByRole('button', { name: '备注' }));
    await userEvent.type(screen.getByRole('textbox'), '不要保存{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
    expect(usePortAliasStore.getState().aliases).toEqual({});
  });

  it('失焦也会提交备注', async () => {
    seed(CH340);
    render(<PortPicker />);

    await userEvent.click(screen.getByRole('button', { name: '备注' }));
    await userEvent.type(screen.getByRole('textbox'), '传感器');
    await userEvent.tab();

    await waitFor(() => {
      expect(usePortAliasStore.getState().aliases['usb:1A86:7523#0']).toBe('传感器');
    });
  });

  it('设备被拔出时在按钮上标注', () => {
    seed({ ...CH340, connected: false });
    render(<PortPicker />);
    expect(screen.getByRole('button', { name: /已拔出/ })).toBeInTheDocument();
  });

  it('端口打开期间不允许换端口', () => {
    seed(CH340);
    useConnectionStore.setState({ sessionState: 'open' });
    render(<PortPicker />);
    expect(screen.getByRole('button', { name: /CH340/ })).toBeDisabled();
  });

  it('浏览器不支持时按钮禁用', () => {
    useConnectionStore.setState({ supported: false });
    render(<PortPicker />);
    expect(screen.getByRole('button', { name: '选择端口…' })).toBeDisabled();
  });

  it('用户关闭选择器时给出可操作的提示，而不是贴浏览器原文', async () => {
    const requestPort = vi.fn(() =>
      Promise.reject(new DOMException('No port selected by the user.', 'NotFoundError')),
    );
    useConnectionStore.setState({ requestPort });
    render(<PortPicker />);

    await userEvent.click(screen.getByRole('button', { name: '选择端口…' }));

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
    expect(useConnectionStore.getState().selectedPortKey).toBeNull();
  });
});
