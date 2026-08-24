import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 各 store 都在模块初始化时读一次 localStorage，因此「刷新页面」在测试里等价于
 * 先写好存储、再 resetModules 重新 import 一遍。
 */
async function reload() {
  vi.resetModules();
  return {
    connection: await import('./connectionStore'),
    send: await import('./sendStore'),
    preset: await import('./presetStore'),
    ui: await import('./uiStore'),
    persist: await import('@/lib/persist'),
  };
}

function stored(key: string): unknown {
  const raw = localStorage.getItem('wst.' + key);
  return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
  localStorage.clear();
});

describe('串口参数持久化', () => {
  it('改过的参数刷新后还在', async () => {
    let app = await reload();
    app.connection.useConnectionStore.getState().setOptions({
      baudRate: 9600,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      flowControl: 'hardware',
    });
    app.persist.flushPersist();

    app = await reload();
    expect(app.connection.useConnectionStore.getState().options).toEqual({
      baudRate: 9600,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      flowControl: 'hardware',
    });
  });

  it('自定义波特率也记得住', async () => {
    let app = await reload();
    app.connection.useConnectionStore.getState().setOptions({ baudRate: 31250 });
    app.persist.flushPersist();

    app = await reload();
    expect(app.connection.useConnectionStore.getState().options.baudRate).toBe(31250);
  });

  it('自动重连开关刷新后还在', async () => {
    let app = await reload();
    app.connection.useConnectionStore.getState().setAutoReconnect(false);
    app.persist.flushPersist();

    app = await reload();
    expect(app.connection.useConnectionStore.getState().autoReconnect).toBe(false);
  });

  it('存量里越界的波特率退回默认，而不是带着必然打不开的配置启动', async () => {
    localStorage.setItem('wst.connectionSettings', JSON.stringify({ baudRate: -1, dataBits: 99 }));
    const app = await reload();
    const { options } = app.connection.useConnectionStore.getState();
    expect(options.baudRate).toBe(app.connection.DEFAULT_OPTIONS.baudRate);
    expect(options.dataBits).toBe(8);
  });

  it('存储被写成垃圾时整体退回默认', async () => {
    localStorage.setItem('wst.connectionSettings', 'not json at all');
    const app = await reload();
    expect(app.connection.useConnectionStore.getState().options).toEqual(
      app.connection.DEFAULT_OPTIONS,
    );
  });
});

describe('发送区持久化', () => {
  it('内容、格式、校验和、周期刷新后都在', async () => {
    let app = await reload();
    // 先切模式再填内容：反过来的话 setMode 会把 TXT 文本按语义转成它的 HEX 字节
    app.send.useSendStore.getState().setMode('hex');
    app.send.useSendStore.getState().setPayload('01 02 AB');
    app.send.useSendStore.getState().setChecksum('crc16-modbus');
    app.send.useSendStore.getState().setIntervalMs(250);
    app.persist.flushPersist();

    app = await reload();
    const restored = app.send.useSendStore.getState();
    expect(restored.payload).toBe('01 02 AB');
    expect(restored.mode).toBe('hex');
    expect(restored.checksum).toBe('crc16-modbus');
    expect(restored.intervalMs).toBe(250);
  });

  it('TXT 结束符刷新后还在', async () => {
    let app = await reload();
    app.send.useSendStore.getState().setEol('crlf');
    app.persist.flushPersist();

    app = await reload();
    expect(app.send.useSendStore.getState().eol).toBe('crlf');
  });

  it('目录里已不存在的校验和退回 none', async () => {
    localStorage.setItem('wst.sendPane', JSON.stringify({ checksum: 'crc16-nonexistent' }));
    const app = await reload();
    expect(app.send.useSendStore.getState().checksum).toBe('none');
  });

  it('还原出来的 HEX 内容若解析不通过，进来就标出错误', async () => {
    localStorage.setItem('wst.sendPane', JSON.stringify({ payload: 'ZZ', mode: 'hex' }));
    const app = await reload();
    expect(app.send.useSendStore.getState().parseError).not.toBeNull();
  });
});

describe('预设持久化', () => {
  it('改名、改数据、勾选顺序循环刷新后都在', async () => {
    let app = await reload();
    const first = app.preset.usePresetStore.getState().presets[0]!.id;
    app.preset.usePresetStore.getState().rename(first, '电机自检');
    app.preset.usePresetStore.getState().setData(first, 'AT+SELFTEST');
    app.preset.usePresetStore.getState().setInSequence(first, false);
    app.persist.flushPersist();

    app = await reload();
    const restored = app.preset.usePresetStore.getState().presets[0]!;
    expect(restored.name).toBe('电机自检');
    expect(restored.data).toBe('AT+SELFTEST');
    expect(restored.inSequence).toBe(false);
  });

  it('没动过时仍是内置示例，名字随语言走', async () => {
    const app = await reload();
    const zh = (await import('@/i18n/zh')).zh;
    const first = app.preset.usePresetStore.getState().presets[0]!;
    expect(first.labelKey).toBe('queryVersion');
    expect(app.preset.presetLabel(first, zh)).toBe('查询版本');
  });

  it('条数始终补齐，存量只有一条也不会让界面缺行', async () => {
    localStorage.setItem(
      'wst.presets',
      JSON.stringify({ version: 1, presets: [{ name: 'a', data: 'AT' }] }),
    );
    const app = await reload();
    expect(app.preset.usePresetStore.getState().presets).toHaveLength(app.preset.PRESET_COUNT);
  });

  it('顺序循环的间隔刷新后还在', async () => {
    let app = await reload();
    app.preset.usePresetStore.getState().setSequenceGapMs(750);
    app.persist.flushPersist();

    app = await reload();
    expect(app.preset.usePresetStore.getState().sequenceGapMs).toBe(750);
  });

  it('存量里非法的间隔退回默认', async () => {
    localStorage.setItem('wst.sequenceGapMs', JSON.stringify(-5));
    const app = await reload();
    expect(app.preset.usePresetStore.getState().sequenceGapMs).toBe(300);
  });

  it('存储损坏时整体退回内置示例', async () => {
    localStorage.setItem('wst.presets', JSON.stringify({ presets: 'nope' }));
    const app = await reload();
    const presets = app.preset.usePresetStore.getState().presets;
    expect(presets).toHaveLength(app.preset.PRESET_COUNT);
    expect(presets[0]!.labelKey).toBe('queryVersion');
  });
});

describe('接收区显示偏好持久化', () => {
  it('HEX 视图、时间戳、自动滚屏、显示 TX 刷新后都在', async () => {
    let app = await reload();
    app.ui.useUiStore.getState().setView('hex');
    app.ui.useUiStore.getState().setShowTimestamp(false);
    app.ui.useUiStore.getState().setAutoScroll(false);
    app.ui.useUiStore.getState().setShowTx(false);
    app.ui.useUiStore.getState().setOnlyMatch(true);
    app.persist.flushPersist();

    app = await reload();
    const ui = app.ui.useUiStore.getState();
    expect(ui.view).toBe('hex');
    expect(ui.showTimestamp).toBe(false);
    expect(ui.autoScroll).toBe(false);
    expect(ui.showTx).toBe(false);
    expect(ui.onlyMatch).toBe(true);
  });

  it('过滤词有意不持久化 —— 日志本身刷新后就是空的', async () => {
    let app = await reload();
    app.ui.useUiStore.getState().setFilter('ERROR');
    app.persist.flushPersist();
    expect(stored('viewPrefs')).not.toHaveProperty('filter');

    app = await reload();
    expect(app.ui.useUiStore.getState().filter).toBe('');
  });
});

describe('写入时机', () => {
  it('攒批写入：未 flush 前不落盘，flush 后落盘', async () => {
    const app = await reload();
    localStorage.clear();
    app.ui.useUiStore.getState().setView('hex');
    expect(stored('viewPrefs')).toBeNull();

    app.persist.flushPersist();
    expect(stored('viewPrefs')).toMatchObject({ view: 'hex' });
  });

  it('localStorage 写不进去时不影响界面功能', async () => {
    const app = await reload();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    app.ui.useUiStore.getState().setView('hex');
    expect(() => app.persist.flushPersist()).not.toThrow();
    expect(app.ui.useUiStore.getState().view).toBe('hex');
    spy.mockRestore();
  });
});
