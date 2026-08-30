import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('分帧设置刷新后还在', async () => {
    let app = await reload();
    app.ui.useUiStore.getState().setIdleFrameMs(50);
    app.ui.useUiStore.getState().setFrameMode('line');
    app.persist.flushPersist();

    app = await reload();
    expect(app.ui.useUiStore.getState().idleFrameMs).toBe(50);
    expect(app.ui.useUiStore.getState().frameMode).toBe('line');
  });

  it('空闲时长填 0 后，模式与时长一起被记住', async () => {
    let app = await reload();
    app.ui.useUiStore.getState().setIdleFrameMs(0);
    app.persist.flushPersist();

    app = await reload();
    expect(app.ui.useUiStore.getState().idleFrameMs).toBe(0);
    expect(app.ui.useUiStore.getState().frameMode).toBe('raw');
  });

  it('认得旧格式：lineFraming=true 迁移成 line 模式', async () => {
    localStorage.setItem('wst.viewPrefs', JSON.stringify({ idleFrameMs: 20, lineFraming: true }));
    const app = await reload();
    expect(app.ui.useUiStore.getState().frameMode).toBe('line');
    expect(app.ui.useUiStore.getState().idleFrameMs).toBe(20);
  });

  it('认得旧格式：idleFrameMs=0 迁移成 raw 模式', async () => {
    localStorage.setItem('wst.viewPrefs', JSON.stringify({ idleFrameMs: 0, lineFraming: false }));
    const app = await reload();
    expect(app.ui.useUiStore.getState().frameMode).toBe('raw');
  });

  it('存量里越界的空闲分帧退回默认 10ms', async () => {
    localStorage.setItem('wst.viewPrefs', JSON.stringify({ idleFrameMs: 999999 }));
    const app = await reload();
    expect(app.ui.useUiStore.getState().idleFrameMs).toBe(10);
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

  /**
   * 无选择器的 subscribe 对**每一次** setState 都会回调，而 sessionState、openedAt、
   * portHolders 这些与串口参数毫无关系的字段变得最勤。不先比一下的话，每次都要
   * 重建 profile、整表复制 portProfiles 再排一次队，纯属白做。
   */
  it('与参数无关的状态变化不触发落盘', async () => {
    const app = await reload();
    app.persist.flushPersist();
    localStorage.clear();

    app.connection.useConnectionStore.setState({ sessionState: 'open', openedAt: 123 });
    app.connection.useConnectionStore.setState({ portHolders: { 'usb:1A86:7523#0': 'tab-2' } });
    app.persist.flushPersist();

    expect(stored('connectionSettings')).toBeNull();

    // 真正改了参数就照常落盘
    app.connection.useConnectionStore.getState().setOptions({ baudRate: 9600 });
    app.persist.flushPersist();
    expect(stored('connectionSettings')).toMatchObject({ baudRate: 9600 });
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

/**
 * 多页面：同时开多个页面、各连一个端口。
 *
 * 这里测的是「页面之间不打架」的三件事：端口选择记在本页面、串口参数按设备存、
 * 端口被别的页面占着时不硬闯。
 */
describe('多页面各连一个端口', () => {
  const CH340_ID = 'usb:1A86:7523#0';
  const FTDI_ID = 'usb:0403:6001#0';

  function fakePort(usbVendorId: number, usbProductId: number): SerialPort {
    return {
      getInfo: () => ({ usbVendorId, usbProductId }),
      connected: true,
    } as unknown as SerialPort;
  }

  const ch340 = fakePort(0x1a86, 0x7523);
  const ftdi = fakePort(0x0403, 0x6001);
  /** 端口选择器下一次会返回谁。 */
  let picked: SerialPort = ch340;

  async function reloadWithSerial(ports: SerialPort[]) {
    vi.resetModules();
    vi.stubGlobal('navigator', {
      // i18n 在模块初始化时读 navigator.language，桩里少了它整个应用起不来
      language: 'zh-CN',
      languages: ['zh-CN'],
      serial: {
        getPorts: () => Promise.resolve(ports),
        requestPort: () => Promise.resolve(picked),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    return {
      connection: await import('./connectionStore'),
      log: await import('./logStore'),
      persist: await import('@/lib/persist'),
    };
  }

  afterEach(() => {
    // navigator 的桩必须收回，否则同文件后面的用例会以为浏览器支持串口
    vi.unstubAllGlobals();
  });

  it('每台设备各记各的串口参数，互不覆盖', async () => {
    picked = ch340;
    const app = await reloadWithSerial([ch340, ftdi]);
    const store = () => app.connection.useConnectionStore.getState();

    await store().requestPort();
    store().setOptions({ baudRate: 9600 });
    app.persist.flushPersist();

    picked = ftdi;
    await store().requestPort();
    // 这台设备还没有存档，沿用当前参数（而不是退回出厂默认）
    expect(store().options.baudRate).toBe(9600);
    store().setOptions({ baudRate: 921600 });
    app.persist.flushPersist();

    picked = ch340;
    await store().requestPort();
    expect(store().options.baudRate).toBe(9600);

    picked = ftdi;
    await store().requestPort();
    expect(store().options.baudRate).toBe(921600);
  });

  it('端口选择记在本页面，同时留一份供新页面继承', async () => {
    picked = ch340;
    const app = await reloadWithSerial([ch340]);
    await app.connection.useConnectionStore.getState().requestPort();

    expect(sessionStorage.getItem('wst.selectedPort')).toBe(CH340_ID);
    expect(localStorage.getItem('wst.selectedPort')).toBe(CH340_ID);
  });

  it('本页面选过的端口优先于全局那份 —— 刷新后两个页面不会跳到同一台设备', async () => {
    sessionStorage.setItem('wst.selectedPort', FTDI_ID);
    localStorage.setItem('wst.selectedPort', CH340_ID);

    const app = await reloadWithSerial([ch340, ftdi]);
    await app.connection.useConnectionStore.getState().refreshPorts();

    expect(app.connection.useConnectionStore.getState().selectedPort()?.identity).toBe(FTDI_ID);
  });

  it('恢复端口时连它自己的参数存档一起套用', async () => {
    localStorage.setItem(
      'wst.portSettings',
      JSON.stringify({ [CH340_ID]: { baudRate: 4800, parity: 'even', autoReconnect: false } }),
    );
    sessionStorage.setItem('wst.selectedPort', CH340_ID);

    const app = await reloadWithSerial([ch340]);
    await app.connection.useConnectionStore.getState().refreshPorts();

    const state = app.connection.useConnectionStore.getState();
    expect(state.options.baudRate).toBe(4800);
    expect(state.options.parity).toBe('even');
    expect(state.autoReconnect).toBe(false);
  });

  it('端口正被别的页面占着时不硬闯，并在日志里说清原因', async () => {
    sessionStorage.setItem('wst.selectedPort', CH340_ID);
    const app = await reloadWithSerial([ch340]);
    app.log.__resetLogStoreForTests();

    const store = app.connection.useConnectionStore;
    await store.getState().refreshPorts();
    store.setState({ portHolders: { [CH340_ID]: 'another-page' } });
    expect(store.getState().busyElsewhere()).toBe(true);

    await store.getState().toggleConnection();

    expect(store.getState().sessionState).toBe('closed');
    expect(app.log.allEntries().at(-1)?.notice).toEqual({ code: 'port-busy' });
  });
});
