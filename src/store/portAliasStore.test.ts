import { beforeEach, describe, expect, it } from 'vitest';
import type { PortDescriptor } from '@/core/transport/portRegistry';
import { aliasOf, MAX_ALIAS_LENGTH, portDisplayLabel, usePortAliasStore } from './portAliasStore';

function makePort(overrides: Partial<PortDescriptor> = {}): PortDescriptor {
  return {
    key: 'port-1',
    ordinal: 1,
    identity: 'usb:1A86:7523',
    label: '#1 CH340 (1A86:7523)',
    chip: 'CH340',
    vendor: 'WCH 沁恒',
    connected: true,
    ...overrides,
  };
}

describe('portAliasStore', () => {
  beforeEach(() => {
    localStorage.clear();
    usePortAliasStore.setState({ aliases: {} });
  });

  it('设置备注后可读回', () => {
    usePortAliasStore.getState().setAlias('usb:1A86:7523', '电机控制器');
    expect(usePortAliasStore.getState().aliases['usb:1A86:7523']).toBe('电机控制器');
  });

  it('备注持久化到 localStorage，刷新后仍在', () => {
    usePortAliasStore.getState().setAlias('usb:1A86:7523', '调试板');
    const stored = localStorage.getItem('wst.portAliases');
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual({ 'usb:1A86:7523': '调试板' });
  });

  it('传入空串即删除备注', () => {
    const store = usePortAliasStore.getState();
    store.setAlias('usb:1A86:7523', '调试板');
    store.setAlias('usb:1A86:7523', '   ');
    expect(usePortAliasStore.getState().aliases).toEqual({});
  });

  it('首尾空白被裁掉，连续空白折叠', () => {
    usePortAliasStore.getState().setAlias('x', '  电机   控制器  ');
    expect(usePortAliasStore.getState().aliases['x']).toBe('电机 控制器');
  });

  it('超长备注被截断，避免撑爆下拉框', () => {
    usePortAliasStore.getState().setAlias('x', 'A'.repeat(100));
    expect(usePortAliasStore.getState().aliases['x']).toHaveLength(MAX_ALIAS_LENGTH);
  });

  it('多个端口各自独立', () => {
    const store = usePortAliasStore.getState();
    store.setAlias('usb:1A86:7523', '甲');
    store.setAlias('usb:0403:6001', '乙');
    expect(usePortAliasStore.getState().aliases).toEqual({
      'usb:1A86:7523': '甲',
      'usb:0403:6001': '乙',
    });
  });
});

describe('跨标签页同步', () => {
  beforeEach(() => {
    localStorage.clear();
    usePortAliasStore.setState({ aliases: {} });
  });

  /**
   * localStorage 同源全标签页共享，而备注是整张 map 一次性写入的。
   * 不监听 storage 事件的话，B 页的下一次写入会把 A 页的改动整张覆盖掉。
   */
  it('其他标签页的写入会被同步进来', () => {
    localStorage.setItem(
      'wst.portAliases',
      JSON.stringify({ 'usb:1A86:7523': '来自另一个标签页' }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: 'wst.portAliases' }));

    expect(usePortAliasStore.getState().aliases).toEqual({ 'usb:1A86:7523': '来自另一个标签页' });
  });

  it('同步后本页写入不会覆盖掉其他标签页的备注', () => {
    // 另一个标签页存了甲设备
    localStorage.setItem('wst.portAliases', JSON.stringify({ 'usb:1A86:7523': '甲' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'wst.portAliases' }));

    // 本页再存乙设备
    usePortAliasStore.getState().setAlias('usb:0403:6001', '乙');

    expect(JSON.parse(localStorage.getItem('wst.portAliases')!)).toEqual({
      'usb:1A86:7523': '甲',
      'usb:0403:6001': '乙',
    });
  });

  it('localStorage 被整体清空时（key 为 null）也重新载入', () => {
    usePortAliasStore.setState({ aliases: { x: 'y' } });
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));

    expect(usePortAliasStore.getState().aliases).toEqual({});
  });

  it('无关的键不触发重载', () => {
    usePortAliasStore.setState({ aliases: { x: 'y' } });
    window.dispatchEvent(new StorageEvent('storage', { key: 'wst.theme' }));

    expect(usePortAliasStore.getState().aliases).toEqual({ x: 'y' });
  });
});

describe('portDisplayLabel', () => {
  it('没有备注时显示原始标签', () => {
    expect(portDisplayLabel(makePort(), {})).toBe('#1 CH340 (1A86:7523)');
  });

  it('有备注时把备注放在最前面，同时保留原始信息以便与设备管理器核对', () => {
    expect(portDisplayLabel(makePort(), { 'usb:1A86:7523': '电机控制器' })).toBe(
      '电机控制器 · #1 CH340 (1A86:7523)',
    );
  });

  /**
   * 备注按 VID:PID 存储，因为浏览器不暴露序列号（WICG/serial#175）。
   * 这条测试把该局限固定下来：同型号适配器共用备注是可预期行为，不是 bug。
   */
  it('同型号的两个适配器共用同一条备注', () => {
    const aliases = { 'usb:1A86:7523': 'CH340 适配器' };
    const first = makePort({ key: 'port-1', ordinal: 1, label: '#1 CH340 (1A86:7523)' });
    const second = makePort({ key: 'port-2', ordinal: 2, label: '#2 CH340 (1A86:7523)' });

    expect(portDisplayLabel(first, aliases)).toBe('CH340 适配器 · #1 CH340 (1A86:7523)');
    expect(portDisplayLabel(second, aliases)).toBe('CH340 适配器 · #2 CH340 (1A86:7523)');
  });

  it('不同型号互不影响', () => {
    const aliases = { 'usb:1A86:7523': '甲' };
    const other = makePort({ identity: 'usb:0403:6001', label: '#2 FTDI (0403:6001)' });
    expect(portDisplayLabel(other, aliases)).toBe('#2 FTDI (0403:6001)');
  });
});

describe('aliasOf', () => {
  it('没有选中端口时返回空串', () => {
    expect(aliasOf(undefined, { x: 'y' })).toBe('');
  });

  it('返回选中端口的备注', () => {
    expect(aliasOf(makePort(), { 'usb:1A86:7523': '调试板' })).toBe('调试板');
    expect(aliasOf(makePort(), {})).toBe('');
  });
});
