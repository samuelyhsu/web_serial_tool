import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetLogStoreForTests } from '@/store/logStore';
import { useSendStore } from '@/store/sendStore';
import { useUiStore } from '@/store/uiStore';
import { SendPane } from '@/ui/SendPane/SendPane';

describe('SendPane', () => {
  beforeEach(() => {
    __resetLogStoreForTests();
    useUiStore.setState({ language: 'zh' });
    useSendStore.setState({
      payload: 'AT+VER?',
      mode: 'text',
      eol: 'none',
      checksum: 'none',
      intervalMs: 1000,
      parseError: null,
      modeIssue: null,
    });
  });

  afterEach(cleanup);

  it('默认不追加结束符，发出去的就是载荷本身', () => {
    render(<SendPane />);
    expect(useSendStore.getState().frameBytes()).toHaveLength(7);
  });

  it('选了结束符后计入发送字节', () => {
    useSendStore.setState({ eol: 'crlf' });
    render(<SendPane />);
    // "AT+VER?" 7 字节 + CRLF 2 字节
    expect(useSendStore.getState().frameBytes()).toHaveLength(9);
  });

  /** 界面上不再显示字节数与格式标识，避免窄栏里堆无用信息。 */
  it('标题行不显示字节数和格式标识', () => {
    render(<SendPane />);
    expect(screen.queryByText(/字节/)).not.toBeInTheDocument();
    expect(screen.queryByText(/· TXT/)).not.toBeInTheDocument();
  });

  it('文本 → HEX 切换是无损的', async () => {
    render(<SendPane />);
    await userEvent.click(screen.getByTitle('切换 TXT / HEX 模式'));
    expect(useSendStore.getState().payload).toBe('41 54 2B 56 45 52 3F');
    expect(useSendStore.getState().mode).toBe('hex');
  });

  /**
   * 缺陷 D3 的端到端回归：原型会把这个 Modbus 帧的不可打印字节全变成 "."，
   * 用户再切回 HEX 时报文已经毁了。
   */
  it('含非法 UTF-8 字节的报文拒绝切成文本，并给出提示', async () => {
    useSendStore.setState({ payload: '01 03 00 00 00 02 C4 0B', mode: 'hex' });
    render(<SendPane />);

    await userEvent.click(screen.getByTitle('切换 TXT / HEX 模式'));

    expect(useSendStore.getState().mode).toBe('hex');
    expect(useSendStore.getState().payload).toBe('01 03 00 00 00 02 C4 0B');
    expect(screen.getByRole('alert')).toHaveTextContent('会丢失内容');
  });

  it('HEX 格式非法时标红并说明原因，发送按钮禁用', async () => {
    useSendStore.setState({ payload: '', mode: 'hex' });
    render(<SendPane />);

    await userEvent.type(screen.getByLabelText('发送内容'), 'ZZ');

    expect(screen.getByRole('alert')).toHaveTextContent('不是十六进制数字');
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('串口未打开时发送按钮禁用', () => {
    render(<SendPane />);
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });
});
