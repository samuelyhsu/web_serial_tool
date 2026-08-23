import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messagesFor, type Language } from '@/i18n';
import { __resetLogStoreForTests, setSelectorMessages } from '@/store/logStore';
import { useSendStore } from '@/store/sendStore';
import { useUiStore } from '@/store/uiStore';
import { LogPane } from '@/ui/LogPane/LogPane';
import { PresetPane } from '@/ui/PresetPane/PresetPane';
import { SendPane } from '@/ui/SendPane/SendPane';

const TOGGLE_TITLE: Record<Language, string> = {
  zh: '切换 TXT / HEX 模式',
  en: 'Toggle TXT / HEX mode',
};

function useLanguage(language: Language): void {
  useUiStore.setState({ language });
  setSelectorMessages(messagesFor(language));
}

/**
 * 数据格式在三处（接收区 / 发送区 / 每条预设）都用同一个控件表示：
 * 一个按钮，显示当前格式，点击切换。这组测试同时锁住两件事 ——
 * 控件形态一致，以及 TXT / HEX 这两个标识符不随语言变化。
 */
describe('数据格式控件', () => {
  beforeEach(() => {
    __resetLogStoreForTests();
    useLanguage('zh');
    useUiStore.setState({ view: 'text', filter: '' });
    useSendStore.setState({ payload: 'AT', mode: 'text', parseError: null, modeIssue: null });
  });

  afterEach(cleanup);

  it.each(['zh', 'en'] as const)('接收区在 %s 界面下是单个按钮，默认 TXT', (language) => {
    useLanguage(language);
    render(<LogPane />);

    const toggle = screen.getByTitle(TOGGLE_TITLE[language]);
    expect(toggle).toHaveTextContent('TXT');
    // 旧的双按钮分段控件不该再出现
    expect(screen.queryAllByTitle(TOGGLE_TITLE[language])).toHaveLength(1);
  });

  it.each(['zh', 'en'] as const)('发送区在 %s 界面下是单个按钮，默认 TXT', (language) => {
    useLanguage(language);
    render(<SendPane />);

    const toggle = screen.getByTitle(TOGGLE_TITLE[language]);
    expect(toggle).toHaveTextContent('TXT');
    expect(screen.queryAllByTitle(TOGGLE_TITLE[language])).toHaveLength(1);
  });

  it('点击后在 TXT 与 HEX 之间来回切换', async () => {
    render(<SendPane />);
    const toggle = screen.getByTitle(TOGGLE_TITLE.zh);

    expect(toggle).toHaveTextContent('TXT');
    await userEvent.click(toggle);
    expect(useSendStore.getState().mode).toBe('hex');
    expect(screen.getByTitle(TOGGLE_TITLE.zh)).toHaveTextContent('HEX');

    await userEvent.click(screen.getByTitle(TOGGLE_TITLE.zh));
    expect(useSendStore.getState().mode).toBe('text');
  });

  it('接收区切换只影响显示，默认仍是 TXT', async () => {
    render(<LogPane />);
    expect(useUiStore.getState().view).toBe('text');

    await userEvent.click(screen.getByTitle(TOGGLE_TITLE.zh));
    expect(useUiStore.getState().view).toBe('hex');
  });

  /** 按钮上的可见文字是当前状态而非动作，可访问名必须同时给出现状和按下后的结果。 */
  it('可访问名同时说明当前格式与点击后的结果', () => {
    render(<SendPane />);
    expect(screen.getByTitle(TOGGLE_TITLE.zh)).toHaveAccessibleName(
      '数据格式：TXT，点击切换为 HEX',
    );
  });

  it('英文界面下可访问名也用 TXT / HEX 这两个标识符', () => {
    useLanguage('en');
    render(<SendPane />);
    expect(screen.getByTitle(TOGGLE_TITLE.en)).toHaveAccessibleName(
      'Data format: TXT, click to switch to HEX',
    );
  });

  it.each(['zh', 'en'] as const)('预设行用的是同一个控件（小号），%s 界面一致', (language) => {
    useLanguage(language);
    render(<PresetPane />);

    const toggles = screen.getAllByTitle(TOGGLE_TITLE[language]);
    expect(toggles.length).toBeGreaterThan(0);
    expect(new Set(toggles.map((el) => el.textContent))).toEqual(new Set(['TXT', 'HEX']));
    // 与另两处共用同一套样式类
    expect(toggles[0]!.className).toContain('formatToggle');
  });
});
