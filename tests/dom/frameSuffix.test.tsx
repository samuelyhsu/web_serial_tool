import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKSUM_ALGORITHMS } from '@/core/checksum';
import { __resetLogStoreForTests } from '@/store/logStore';
import { useSendStore } from '@/store/sendStore';
import { useUiStore } from '@/store/uiStore';
import { SendPane } from '@/ui/SendPane/SendPane';

function bytesOf(): number[] {
  return [...(useSendStore.getState().frameBytes() ?? [])];
}

/**
 * TXT 与 HEX 各有自己的「帧尾」控件，同一位置互斥显示，且都默认「无」——
 * 工具不该在用户没要求时擅自往报文里塞字节。
 */
describe('帧尾控件', () => {
  beforeEach(() => {
    __resetLogStoreForTests();
    useUiStore.setState({ language: 'zh' });
    useSendStore.setState({
      payload: 'AT',
      mode: 'text',
      eol: 'none',
      checksum: 'none',
      parseError: null,
      modeIssue: null,
    });
  });

  afterEach(cleanup);

  it('TXT 模式显示结束符，不显示校验和', () => {
    render(<SendPane />);
    expect(screen.getByLabelText('结束符')).toBeInTheDocument();
    expect(screen.queryByLabelText('校验和')).not.toBeInTheDocument();
  });

  it('HEX 模式显示校验和，不显示结束符', () => {
    useSendStore.setState({ mode: 'hex', payload: '01 03' });
    render(<SendPane />);
    expect(screen.getByLabelText('校验和')).toBeInTheDocument();
    expect(screen.queryByLabelText('结束符')).not.toBeInTheDocument();
  });

  it('结束符默认无，不往载荷后面加任何字节', () => {
    render(<SendPane />);
    expect(screen.getByLabelText('结束符')).toHaveValue('none');
    expect(bytesOf()).toEqual([0x41, 0x54]);
  });

  it('校验和默认无，不往载荷后面加任何字节', () => {
    useSendStore.setState({ mode: 'hex', payload: '01 03 00 00 00 02' });
    render(<SendPane />);
    expect(screen.getByLabelText('校验和')).toHaveValue('none');
    expect(bytesOf()).toEqual([0x01, 0x03, 0x00, 0x00, 0x00, 0x02]);
  });

  it('选了结束符后计入发送字节', async () => {
    render(<SendPane />);
    await userEvent.selectOptions(screen.getByLabelText('结束符'), 'crlf');
    expect(bytesOf()).toEqual([0x41, 0x54, 0x0d, 0x0a]);
  });

  it('校验和下拉框列出全部算法', () => {
    useSendStore.setState({ mode: 'hex', payload: '01' });
    render(<SendPane />);

    const options = [...screen.getByLabelText('校验和').querySelectorAll('option')].map(
      (option) => option.value,
    );
    expect(options[0]).toBe('none');
    for (const algorithm of CHECKSUM_ALGORITHMS) {
      expect(options, algorithm.id).toContain(algorithm.id);
    }
  });

  /** 核心诉求：选中后立刻在下拉框旁显示将要追加的字节。 */
  it('选中校验和后即时显示计算结果，并追加到发送字节', async () => {
    useSendStore.setState({ mode: 'hex', payload: '01 03 00 00 00 02' });
    render(<SendPane />);

    await userEvent.selectOptions(screen.getByLabelText('校验和'), 'crc16-modbus');

    // Modbus RTU 规定 CRC 低字节先发
    expect(screen.getByText('C4 0B')).toBeInTheDocument();
    expect(bytesOf()).toEqual([0x01, 0x03, 0x00, 0x00, 0x00, 0x02, 0xc4, 0x0b]);
  });

  it('载荷变更后校验和结果跟着重算', async () => {
    useSendStore.setState({ mode: 'hex', payload: '01 03 00 00 00 02', checksum: 'crc16-modbus' });
    render(<SendPane />);
    expect(screen.getByText('C4 0B')).toBeInTheDocument();

    useSendStore.setState({ payload: '01 05 00 00 FF 00' });
    expect(await screen.findByText('8C 3A')).toBeInTheDocument();
  });

  it('切换算法后结果与字节序都跟着变', async () => {
    useSendStore.setState({ mode: 'hex', payload: '31 32 33 34 35 36 37 38 39' });
    render(<SendPane />);

    await userEvent.selectOptions(screen.getByLabelText('校验和'), 'crc16-ibm3740');
    expect(screen.getByText('29 B1')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('校验和'), 'crc32');
    expect(screen.getByText('CB F4 39 26')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('校验和'), 'xor8');
    expect(screen.getByText('31')).toBeInTheDocument();
  });

  it('校验和计入真正发出去的字节', async () => {
    useSendStore.setState({ mode: 'hex', payload: '01 03' });
    render(<SendPane />);
    expect(bytesOf()).toHaveLength(2);

    await userEvent.selectOptions(screen.getByLabelText('校验和'), 'crc16-modbus');
    expect(bytesOf()).toHaveLength(4);
  });

  it('HEX 格式非法时不显示计算结果', () => {
    useSendStore.setState({ mode: 'hex', payload: 'ZZ', checksum: 'crc16-modbus' });
    render(<SendPane />);
    expect(screen.queryByText(/^[0-9A-F]{2}( [0-9A-F]{2})*$/)).not.toBeInTheDocument();
  });
});
