import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveFraming } from '@/core/framing/frameAssembler';
import { messagesFor } from '@/i18n';
import { __resetLogStoreForTests, setSelectorMessages } from '@/store/logStore';
import { useUiStore } from '@/store/uiStore';
import { LogPane } from '@/ui/LogPane/LogPane';

/** 界面上那两个控件当前会推给会话的分帧配置。 */
function effectiveMode(): string {
  const { idleFrameMs, lineFraming, view } = useUiStore.getState();
  return resolveFraming({ idleMs: idleFrameMs, lineFraming, textView: view === 'text' }).mode;
}

function idleInput(): HTMLInputElement {
  return screen.getByLabelText('空闲分帧');
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
      idleFrameMs: 10,
      lineFraming: false,
    });
  });

  afterEach(cleanup);

  it('默认空闲分帧 10ms', () => {
    render(<LogPane />);
    expect(idleInput()).toHaveValue(10);
    expect(effectiveMode()).toBe('idle');
  });

  it('设为 0 即原样显示，不做分帧', async () => {
    const user = userEvent.setup();
    render(<LogPane />);

    await user.clear(idleInput());
    await user.type(idleInput(), '0');

    expect(useUiStore.getState().idleFrameMs).toBe(0);
    expect(effectiveMode()).toBe('raw');
    expect(screen.getByText(/原样显示/)).toBeInTheDocument();
  });

  it('改成 50ms 后按空闲分帧生效', async () => {
    const user = userEvent.setup();
    render(<LogPane />);

    await user.clear(idleInput());
    await user.type(idleInput(), '50');

    expect(useUiStore.getState().idleFrameMs).toBe(50);
    expect(effectiveMode()).toBe('idle');
  });

  it('勾上换行分帧后与空闲分帧互斥：毫秒输入被禁用', async () => {
    const user = userEvent.setup();
    render(<LogPane />);
    expect(idleInput()).toBeEnabled();

    await user.click(screen.getByLabelText('按换行分帧'));

    expect(effectiveMode()).toBe('line');
    expect(idleInput()).toBeDisabled();
  });

  it('取消换行分帧后空闲分帧重新接管', async () => {
    const user = userEvent.setup();
    render(<LogPane />);
    const checkbox = screen.getByLabelText('按换行分帧');

    await user.click(checkbox);
    expect(effectiveMode()).toBe('line');

    await user.click(checkbox);
    expect(effectiveMode()).toBe('idle');
    expect(idleInput()).toBeEnabled();
  });

  it('HEX 视图下不提供换行分帧', () => {
    useUiStore.setState({ view: 'hex' });
    render(<LogPane />);
    expect(screen.queryByLabelText('按换行分帧')).not.toBeInTheDocument();
    expect(idleInput()).toBeInTheDocument();
  });

  it('切到 HEX 时换行分帧不再生效，但偏好本身保留着', () => {
    useUiStore.setState({ lineFraming: true, view: 'text' });
    expect(effectiveMode()).toBe('line');

    useUiStore.setState({ view: 'hex' });
    render(<LogPane />);

    expect(effectiveMode()).toBe('idle'); // 回落
    expect(useUiStore.getState().lineFraming).toBe(true); // 切回 TXT 还在
  });

  it('越界的输入被夹到合法区间，不会把配置弄坏', async () => {
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
    expect(screen.getByLabelText('Idle framing')).toBeInTheDocument();
    expect(screen.getByLabelText('Frame on newline')).toBeInTheDocument();
  });
});
