import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetLogStoreForTests, useLogStore } from '@/store/logStore';
import { useUiStore } from '@/store/uiStore';
import { LogPane } from '@/ui/LogPane/LogPane';
import { setSelectorMessages } from '@/store/logStore';
import { messagesFor } from '@/i18n';

const encoder = new TextEncoder();

function feed(text: string): void {
  useLogStore.getState().appendFrame('rx', encoder.encode(text));
}

function currentRows(): string[] {
  const log = screen.getByRole('log');
  return [...log.querySelectorAll('[data-kind]')].map((el) => el.textContent ?? '');
}

/** 日志是攒批提交的（60ms），断言前要等提交发生。 */
async function rowTexts(expectedCount?: number): Promise<string[]> {
  return waitFor(() => {
    const rows = currentRows();
    if (expectedCount === undefined) expect(rows.length).toBeGreaterThan(0);
    else expect(rows).toHaveLength(expectedCount);
    return rows;
  });
}

describe('LogPane', () => {
  beforeEach(() => {
    __resetLogStoreForTests();
    setSelectorMessages(messagesFor('zh'));
    useUiStore.setState({
      language: 'zh',
      view: 'text',
      filter: '',
      onlyMatch: false,
      showTx: true,
      showTimestamp: false,
      autoScroll: true,
    });
  });

  afterEach(cleanup);

  it('没有数据时显示空态引导', () => {
    render(<LogPane />);
    expect(screen.getByText('无数据')).toBeInTheDocument();
    expect(screen.getByText(/点「选择端口」授权设备/)).toBeInTheDocument();
  });

  it('收到的帧会出现在日志里', async () => {
    render(<LogPane />);
    feed('+VER: SA-2100\r\n');
    expect(await rowTexts()).toEqual([expect.stringContaining('+VER: SA-2100')]);
  });

  /** 缺陷 D4 的端到端回归：原型这里会显示成一串点。 */
  it('设备发来的中文正确显示，而不是变成点', async () => {
    render(<LogPane />);
    feed('温度 24.6C\n');
    expect(await rowTexts()).toEqual([expect.stringContaining('温度 24.6C')]);
  });

  it('控制字符以转义形式显示，帧边界可见', async () => {
    render(<LogPane />);
    feed('OK\r\n');
    expect(await rowTexts()).toEqual([expect.stringContaining('OK\\r\\n')]);
  });

  it('切到 HEX 视图后同一帧显示为十六进制', async () => {
    render(<LogPane />);
    feed('AT');
    await rowTexts();

    await userEvent.click(screen.getByTitle('切换 TXT / HEX 模式'));
    expect(await rowTexts()).toEqual([expect.stringContaining('41 54')]);
  });

  it('过滤关键字被高亮，且所有匹配都标出来', async () => {
    render(<LogPane />);
    feed('OK OK OK\n');
    await rowTexts();

    await userEvent.type(screen.getByPlaceholderText('过滤 / 高亮关键字…'), 'OK');
    await waitFor(() => {
      expect(screen.getAllByText('OK')).toHaveLength(3);
    });
  });

  it('勾选「仅匹配」后不含关键字的行被隐藏', async () => {
    render(<LogPane />);
    feed('alpha\n');
    feed('beta\n');
    await rowTexts();

    await userEvent.type(screen.getByPlaceholderText('过滤 / 高亮关键字…'), 'alpha');
    await userEvent.click(screen.getByRole('checkbox', { name: '仅匹配' }));

    const texts = await rowTexts(1);
    expect(texts[0]).toContain('alpha');
  });

  it('取消「显示发送」后 TX 行被隐藏', async () => {
    render(<LogPane />);
    useLogStore.getState().appendFrame('tx', encoder.encode('AT\r\n'));
    feed('OK\r\n');
    await rowTexts(2);

    await userEvent.click(screen.getByRole('checkbox', { name: '显示发送' }));
    const remaining = await rowTexts(1);
    expect(remaining[0]).toContain('OK');
  });

  it('清空后统计归零并给出反馈', async () => {
    render(<LogPane />);
    feed('data\n');
    await rowTexts();

    await userEvent.click(screen.getByRole('button', { name: '清空' }));
    await waitFor(() => {
      expect(useLogStore.getState().rxBytes).toBe(0);
      expect(useLogStore.getState().rxFrames).toBe(0);
    });
    expect(await rowTexts()).toEqual([expect.stringContaining('日志与统计已清空')]);
  });

  it('系统消息随语言切换重新翻译（保留结构化事件的好处）', async () => {
    render(<LogPane />);
    useLogStore.getState().appendNotice({ code: 'port-closed' });
    expect(await rowTexts()).toEqual([expect.stringContaining('串口已关闭')]);

    setSelectorMessages(messagesFor('en'));
    act(() => useUiStore.setState({ language: 'en' }));

    await waitFor(() => {
      expect(currentRows()).toEqual([expect.stringContaining('Port closed')]);
    });
  });
});
