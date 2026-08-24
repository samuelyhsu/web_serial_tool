import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveFraming } from '@/core/framing/frameAssembler';
import { messagesFor } from '@/i18n';
import { __resetLogStoreForTests, setSelectorMessages } from '@/store/logStore';
import { useUiStore } from '@/store/uiStore';
import { LogPane } from '@/ui/LogPane/LogPane';

/** 界面上那个下拉框当前会推给会话的分帧模式。 */
function effectiveMode(): string {
  const { frameMode, idleFrameMs, view } = useUiStore.getState();
  return resolveFraming({ mode: frameMode, idleMs: idleFrameMs, textView: view === 'text' }).mode;
}

function modeSelect(): HTMLSelectElement {
  return screen.getByLabelText('分帧');
}

function idleInput(): HTMLInputElement {
  return screen.getByLabelText('空闲时长');
}

describe('接收区分帧控件', () => {
  beforeEach(() => {
    __resetLogStoreForTests();
    setSelectorMessages(messagesFor('zh'));
    useUiStore.setState({
      language: 'zh',
      view: 'text',
      filter: '',
      onlyMatch: false,
      showTx: true,
      showTimestamp: true,
      autoScroll: true,
      frameMode: 'idle',
      idleFrameMs: 10,
    });
  });

  afterEach(cleanup);

  it('下拉框直接写着当前模式 —— 不必比对两个控件谁在生效', () => {
    render(<LogPane />);
    expect(modeSelect()).toHaveValue('idle');
    expect(screen.getByRole('option', { name: '空闲超时', selected: true })).toBeInTheDocument();
  });

  it('默认空闲 10ms', () => {
    render(<LogPane />);
    expect(idleInput()).toHaveValue(10);
    expect(effectiveMode()).toBe('idle');
  });

  it('选「按换行」后 ms 输入框直接消失，界面上只剩一个分帧控件', async () => {
    const user = userEvent.setup();
    render(<LogPane />);
    expect(idleInput()).toBeInTheDocument();

    await user.selectOptions(modeSelect(), 'line');

    expect(effectiveMode()).toBe('line');
    expect(screen.queryByLabelText('空闲时长')).not.toBeInTheDocument();
    expect(modeSelect()).toHaveValue('line');
  });

  it('选「原样显示」后同样只剩下拉框', async () => {
    const user = userEvent.setup();
    render(<LogPane />);

    await user.selectOptions(modeSelect(), 'raw');

    expect(effectiveMode()).toBe('raw');
    expect(screen.queryByLabelText('空闲时长')).not.toBeInTheDocument();
  });

  it('切回空闲超时后 ms 输入框回来', async () => {
    const user = userEvent.setup();
    render(<LogPane />);

    await user.selectOptions(modeSelect(), 'line');
    await user.selectOptions(modeSelect(), 'idle');

    expect(effectiveMode()).toBe('idle');
    expect(idleInput()).toBeInTheDocument();
  });

  it('把空闲时长填成 0 会把模式同步成「原样显示」，下拉框不会和实际生效的打架', async () => {
    const user = userEvent.setup();
    render(<LogPane />);

    await user.clear(idleInput());
    await user.type(idleInput(), '0');

    expect(useUiStore.getState().frameMode).toBe('raw');
    expect(effectiveMode()).toBe('raw');
    expect(modeSelect()).toHaveValue('raw');
  });

  it('清空输入框重打时，输入框不会中途消失', async () => {
    const user = userEvent.setup();
    render(<LogPane />);

    // 清空是「选中重打」的常规动作。若把空串当成 0，模式会立刻变成原样、
    // 输入框自己消失，新值根本打不完。
    await user.clear(idleInput());
    expect(idleInput()).toBeInTheDocument();
    expect(useUiStore.getState().frameMode).toBe('idle');

    await user.type(idleInput(), '25');
    expect(useUiStore.getState().idleFrameMs).toBe(25);
  });

  it('输入框留空时失焦，回填当前生效值', async () => {
    const user = userEvent.setup();
    render(<LogPane />);

    await user.clear(idleInput());
    await user.tab();

    expect(idleInput()).toHaveValue(10);
  });

  it('改成 50ms 仍是空闲分帧', async () => {
    const user = userEvent.setup();
    render(<LogPane />);

    await user.clear(idleInput());
    await user.type(idleInput(), '50');

    expect(useUiStore.getState().idleFrameMs).toBe(50);
    expect(effectiveMode()).toBe('idle');
  });

  it('HEX 视图下不提供「按换行」选项', () => {
    useUiStore.setState({ view: 'hex' });
    render(<LogPane />);
    expect(screen.queryByRole('option', { name: '按换行' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: '空闲超时' })).toBeInTheDocument();
  });

  it('在 HEX 视图下，下拉框显示的是实际生效的模式而非存着的偏好', () => {
    useUiStore.setState({ frameMode: 'line', view: 'hex' });
    render(<LogPane />);

    // 换行分帧在 HEX 下不生效，因此下拉框必须显示回落后的结果
    expect(modeSelect()).toHaveValue('idle');
    expect(effectiveMode()).toBe('idle');
    // 偏好本身保留着，切回 TXT 还在
    expect(useUiStore.getState().frameMode).toBe('line');
  });

  it('当前模式的说明随选择变化', async () => {
    const user = userEvent.setup();
    render(<LogPane />);
    expect(screen.getByText(/Modbus RTU/)).toBeInTheDocument();

    await user.selectOptions(modeSelect(), 'line');
    expect(screen.getByText(/AT \/ NMEA/)).toBeInTheDocument();

    await user.selectOptions(modeSelect(), 'raw');
    expect(screen.getByText(/不做分帧/)).toBeInTheDocument();
  });

  it('越界的输入被夹到合法区间', async () => {
    const user = userEvent.setup();
    render(<LogPane />);

    await user.clear(idleInput());
    await user.type(idleInput(), '99999');

    expect(useUiStore.getState().idleFrameMs).toBeLessThanOrEqual(1000);
    expect(useUiStore.getState().idleFrameMs).toBeGreaterThanOrEqual(0);
  });

  it('英文界面下标签同步翻译', () => {
    useUiStore.setState({ language: 'en' });
    setSelectorMessages(messagesFor('en'));
    render(<LogPane />);
    expect(screen.getByLabelText('Framing')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'On newline' })).toBeInTheDocument();
  });
});
