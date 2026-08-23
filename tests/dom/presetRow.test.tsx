import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetLogStoreForTests } from '@/store/logStore';
import { PRESET_COUNT, PRESET_PAGE_SIZE, PRESET_PAGES, usePresetStore } from '@/store/presetStore';
import { useUiStore } from '@/store/uiStore';
import { PresetPane } from '@/ui/PresetPane/PresetPane';

function rows(): HTMLElement[] {
  return screen.getAllByRole('checkbox').map((box) => box.closest('div') as HTMLElement);
}

describe('多条发送', () => {
  beforeEach(() => {
    __resetLogStoreForTests();
    useUiStore.setState({ language: 'zh' });
    usePresetStore.setState({
      presets: usePresetStore.getInitialState().presets,
      page: 0,
      issues: {},
    });
  });

  afterEach(cleanup);

  it('每页固定 10 条，没有新增和删除', () => {
    render(<PresetPane />);
    expect(usePresetStore.getState().presets).toHaveLength(PRESET_COUNT);
    expect(rows()).toHaveLength(PRESET_PAGE_SIZE);

    expect(screen.queryByRole('button', { name: '+ 新增' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument();
  });

  it('不显示序号列', () => {
    render(<PresetPane />);
    expect(screen.queryByText('序')).not.toBeInTheDocument();
    expect(screen.queryByText('01')).not.toBeInTheDocument();
  });

  it('列顺序为：序列 · 格式 · 数据 · 发送 · 周期 · 循环', () => {
    render(<PresetPane />);
    const headers = screen.getByText('序列').parentElement!.querySelectorAll('span');
    expect([...headers].map((h) => h.textContent).filter(Boolean)).toEqual([
      '序列',
      '格式',
      '数据',
      '发送',
      '周期 ms',
      '循环',
    ]);
  });

  /** 每条一行：一行里六个控件，不再是原来的两行布局。 */
  it('每条预设的控件都在同一行内', () => {
    render(<PresetPane />);
    const first = rows()[0]!;

    expect(within(first).getByRole('checkbox')).toBeInTheDocument();
    expect(within(first).getByTitle('切换 TXT / HEX 模式')).toBeInTheDocument();
    expect(within(first).getByRole('textbox', { name: /数据/ })).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: '查询版本' })).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: /重命名发送按钮/ })).toBeInTheDocument();
    expect(within(first).getByRole('spinbutton', { name: /周期/ })).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: /循环/ })).toBeInTheDocument();
  });

  it('发送按钮上显示的就是预设名称', () => {
    render(<PresetPane />);
    expect(screen.getByRole('button', { name: '查询版本' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '读取状态' })).toBeInTheDocument();
  });

  it('点 ✎ 切换成输入框改名，回车提交', async () => {
    render(<PresetPane />);
    await userEvent.click(screen.getByRole('button', { name: '重命名发送按钮: 查询版本' }));

    const input = screen.getByRole('textbox', { name: '重命名发送按钮' });
    expect(input).toHaveFocus();

    await userEvent.clear(input);
    await userEvent.type(input, '读版本号{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '读版本号' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('textbox', { name: '重命名发送按钮' })).not.toBeInTheDocument();
  });

  it('按 Esc 放弃改名', async () => {
    render(<PresetPane />);
    await userEvent.click(screen.getByRole('button', { name: '重命名发送按钮: 查询版本' }));
    await userEvent.type(screen.getByRole('textbox', { name: '重命名发送按钮' }), '别存{Escape}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '查询版本' })).toBeInTheDocument();
    });
  });

  it('名称留空时保持原名，不会出现没有文字的按钮', async () => {
    render(<PresetPane />);
    await userEvent.click(screen.getByRole('button', { name: '重命名发送按钮: 查询版本' }));

    const input = screen.getByRole('textbox', { name: '重命名发送按钮' });
    await userEvent.clear(input);
    await userEvent.type(input, '{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '查询版本' })).toBeInTheDocument();
    });
  });

  it('串口未打开时发送与循环都禁用', () => {
    render(<PresetPane />);
    expect(screen.getByRole('button', { name: '查询版本' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /^循环/ })[0]).toBeDisabled();
  });

  it('勾选框控制是否参与顺序循环', async () => {
    render(<PresetPane />);
    const before = usePresetStore.getState().presets.filter((p) => p.inSequence).length;

    await userEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(usePresetStore.getState().presets.filter((p) => p.inSequence)).toHaveLength(before - 1);
  });

  it('翻页只换这一页的 10 条，总数不变', async () => {
    render(<PresetPane />);
    expect(screen.getByText(`1/${PRESET_PAGES}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查询版本' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(screen.getByText(`2/${PRESET_PAGES}`)).toBeInTheDocument();
    expect(rows()).toHaveLength(PRESET_PAGE_SIZE);
    // 第二页是空行，第一页的内置预设不该还在
    expect(screen.queryByRole('button', { name: '查询版本' })).not.toBeInTheDocument();
    expect(usePresetStore.getState().presets).toHaveLength(PRESET_COUNT);
  });

  it('首页禁用上一页，末页禁用下一页', async () => {
    render(<PresetPane />);
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();

    for (let i = 0; i < PRESET_PAGES - 1; i += 1) {
      await userEvent.click(screen.getByRole('button', { name: '下一页' }));
    }
    expect(screen.getByText(`${PRESET_PAGES}/${PRESET_PAGES}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  /** 勾选的含义是「参与顺序循环」，与当前看的是哪一页无关。 */
  it('顺序循环跨页统计勾选项', async () => {
    render(<PresetPane />);
    const checked = usePresetStore.getState().presets.filter((preset) => preset.inSequence).length;
    expect(screen.getByText(`按序依次发送 ${checked} 条`)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '下一页' }));
    // 翻到没有勾选项的第二页，统计仍然是全局的
    expect(screen.getByText(`按序依次发送 ${checked} 条`)).toBeInTheDocument();
  });

  it('翻页后编辑第二页的行不影响第一页', async () => {
    render(<PresetPane />);
    await userEvent.click(screen.getByRole('button', { name: '下一页' }));

    const firstRowData = screen.getAllByRole('textbox')[0]!;
    await userEvent.type(firstRowData, 'AT+PAGE2');

    await userEvent.click(screen.getByRole('button', { name: '上一页' }));
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('AT+VER?');
  });
});
