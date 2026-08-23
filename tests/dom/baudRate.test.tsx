import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BAUD_RATE_MAX,
  BAUD_RATES,
  DEFAULT_OPTIONS,
  isValidBaudRate,
  useConnectionStore,
} from '@/store/connectionStore';
import { useUiStore } from '@/store/uiStore';
import { BaudRateInput } from '@/ui/Toolbar/BaudRateInput';

function baudInput(): HTMLInputElement {
  return screen.getByLabelText('波特率');
}

function suggestions(): number[] {
  return [...document.querySelectorAll('datalist option')].map((option) =>
    Number((option as HTMLOptionElement).value),
  );
}

describe('波特率', () => {
  beforeEach(() => {
    useUiStore.setState({ language: 'zh' });
    useConnectionStore.setState({ options: { ...DEFAULT_OPTIONS } });
  });

  afterEach(cleanup);

  it('候选列表覆盖到 3000000，且严格升序无重复', () => {
    const rates = [...BAUD_RATES];
    expect(rates).toContain(3000000);
    expect(Math.max(...rates)).toBe(3000000);
    expect(new Set(rates).size).toBe(rates.length);
    expect([...rates].sort((a, b) => a - b)).toEqual(rates);
  });

  it('候选列表包含各类芯片与协议常用的档位', () => {
    const rates = new Set<number>(BAUD_RATES);
    // 传统 UART / Windows mode 枚举的档位
    for (const rate of [110, 300, 1200, 9600, 19200, 38400, 57600, 115200, 128000, 256000]) {
      expect(rates, String(rate)).toContain(rate);
    }
    // 协议 / 设备特定档位：MIDI、DMX512 与 3D 打印机、Dynamixel
    for (const rate of [31250, 250000, 500000, 1000000]) {
      expect(rates, String(rate)).toContain(rate);
    }
    // USB-serial 芯片的高速档
    for (const rate of [921600, 1500000, 2000000, 3000000]) {
      expect(rates, String(rate)).toContain(rate);
    }
  });

  it('候选值全部合法', () => {
    for (const rate of BAUD_RATES) {
      expect(isValidBaudRate(rate), String(rate)).toBe(true);
    }
  });

  it('输入框把候选列表作为建议提供出来', () => {
    render(<BaudRateInput disabled={false} />);
    expect(baudInput()).toHaveAttribute('list');
    expect(suggestions()).toEqual([...BAUD_RATES]);
  });

  it('默认值是 115200', () => {
    render(<BaudRateInput disabled={false} />);
    expect(baudInput()).toHaveValue(115200);
  });

  /** 核心诉求：不在候选列表里的值也能用。 */
  it('可以输入候选列表里没有的自定义值', async () => {
    render(<BaudRateInput disabled={false} />);
    const input = baudInput();

    await userEvent.clear(input);
    await userEvent.type(input, '31250');
    expect(useConnectionStore.getState().options.baudRate).toBe(31250);

    await userEvent.clear(input);
    await userEvent.type(input, '4000000');
    expect(useConnectionStore.getState().options.baudRate).toBe(4000000);
  });

  it('输入过程中的中间值不会被纠正或打断', async () => {
    render(<BaudRateInput disabled={false} />);
    const input = baudInput();

    await userEvent.clear(input);
    await userEvent.type(input, '115');
    // 115 本身合法，会被提交；但界面上仍是用户打进去的内容，没有被改写
    expect(input).toHaveValue(115);

    await userEvent.type(input, '200');
    expect(input).toHaveValue(115200);
  });

  it('清空输入不会把 0 写进配置', async () => {
    render(<BaudRateInput disabled={false} />);
    await userEvent.clear(baudInput());

    expect(useConnectionStore.getState().options.baudRate).toBe(115200);
    expect(baudInput()).toHaveAttribute('aria-invalid', 'true');
  });

  it('失焦时若仍非法则回退到最后一个有效值', async () => {
    render(<BaudRateInput disabled={false} />);
    const input = baudInput();

    await userEvent.clear(input);
    await userEvent.tab();

    expect(input).toHaveValue(115200);
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('端口打开期间不可修改', () => {
    render(<BaudRateInput disabled />);
    expect(baudInput()).toBeDisabled();
  });
});

describe('isValidBaudRate', () => {
  it('接受正整数', () => {
    expect(isValidBaudRate(1)).toBe(true);
    expect(isValidBaudRate(115200)).toBe(true);
    expect(isValidBaudRate(3000000)).toBe(true);
    expect(isValidBaudRate(BAUD_RATE_MAX)).toBe(true);
  });

  it('拒绝 0、负数、小数与越界值', () => {
    // 规范要求 baudRate 大于 0
    expect(isValidBaudRate(0)).toBe(false);
    expect(isValidBaudRate(-9600)).toBe(false);
    expect(isValidBaudRate(9600.5)).toBe(false);
    expect(isValidBaudRate(BAUD_RATE_MAX + 1)).toBe(false);
  });

  it('拒绝 NaN 与无穷大', () => {
    expect(isValidBaudRate(Number.NaN)).toBe(false);
    expect(isValidBaudRate(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
