// @vitest-environment node
//
// 必须跑在 node 环境：jsdom 下 structuredClone 产出的 Uint8Array 与测试里字面量写的
// 不是同一个 realm 的构造器，toEqual 会判为不等 —— 那是环境假象，不是协议问题。
// 这个文件本来也不碰 DOM。
import { describe, expect, it } from 'vitest';
import type { PortDescriptor } from '@/core/transport/portDescriptor';
import type { ConnectionOptions } from '@/core/transport/types';
import type { HostEvent, HostResponse, RequestBody, RequestMethod } from './protocol';

/**
 * 协议消息必须经得起结构化克隆。
 *
 * webview 与扩展宿主之间的消息是被序列化的，塞进去一个类实例、一个 Date、一个函数，
 * 类型检查全都过，只有运行到那一步才会炸 —— 而那一步可能是某个不常走的错误分支。
 *
 * 两张样本表用 `Record<判别式, 消息>` 声明：**新增一种消息却忘了加样本时，
 * 类型检查会当场报错**，这张表不会随时间腐化成只覆盖一半的摆设。
 */

const OPTIONS: ConnectionOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

const PORT: PortDescriptor = {
  key: 'COM3',
  identity: 'usb:1A86:7523:SN1',
  ordinal: 1,
  label: 'COM3 · CH340 (1A86:7523)',
  chip: 'CH340',
  vendor: 'WCH 沁恒',
  connected: true,
  usbVendorId: 0x1a86,
  usbProductId: 0x7523,
};

const REQUESTS: Record<RequestMethod, RequestBody> = {
  ready: { method: 'ready' },
  'ports.refresh': { method: 'ports.refresh' },
  'ports.pick': { method: 'ports.pick' },
  'session.open': { method: 'session.open', portKey: 'COM3', options: OPTIONS },
  'session.close': { method: 'session.close' },
  'session.send': { method: 'session.send', bytes: new Uint8Array([1, 2, 3]) },
  'session.setFraming': { method: 'session.setFraming', framing: { mode: 'line' } },
  'session.setReconnect': { method: 'session.setReconnect', enabled: false },
  'prefs.write': { method: 'prefs.write', key: 'wst.theme', value: 'dark' },
  'tasks.start': {
    method: 'tasks.start',
    taskId: 't1',
    frames: [new Uint8Array([0xa5])],
    intervalMs: 100,
  },
  'tasks.update': { method: 'tasks.update', taskId: 't1', frames: [new Uint8Array([1])] },
  'tasks.stop': { method: 'tasks.stop', taskId: 't1' },
  'tasks.stopAll': { method: 'tasks.stopAll' },
};

const EVENTS: Record<HostEvent['type'], HostEvent> = {
  snapshot: {
    kind: 'event',
    type: 'snapshot',
    ports: [PORT],
    holders: { COM3: 'panel-1' },
    selectedPortKey: 'COM3',
    options: OPTIONS,
    autoReconnect: true,
    state: 'open',
    openedAt: 1_700_000_000_000,
    pendingBytes: 0,
    frames: [{ direction: 'rx', at: 1_700_000_000_001, bytes: new Uint8Array([0x41]) }],
    runningTasks: ['t1'],
    prefs: { 'wst.theme': 'dark' },
    language: 'zh-cn',
  },
  ports: { kind: 'event', type: 'ports', ports: [PORT], holders: {} },
  frames: {
    kind: 'event',
    type: 'frames',
    items: [{ direction: 'tx', at: 1, bytes: new Uint8Array([2]) }],
    pendingBytes: 128,
  },
  throughput: { kind: 'event', type: 'throughput', direction: 'rx', byteCount: 64 },
  notice: { kind: 'event', type: 'notice', notice: { code: 'port-busy' } },
  state: { kind: 'event', type: 'state', state: 'reconnecting', openedAt: 0, pendingBytes: 0 },
  selected: {
    kind: 'event',
    type: 'selected',
    portKey: 'COM3',
    options: OPTIONS,
    autoReconnect: false,
  },
  tasks: { kind: 'event', type: 'tasks', running: ['t1'] },
  openPort: { kind: 'event', type: 'openPort', portKey: 'COM3' },
};

describe('协议消息的序列化保真', () => {
  it.each(Object.keys(REQUESTS))('请求 %s 能原样穿过结构化克隆', (method) => {
    const original = REQUESTS[method as RequestMethod];
    expect(structuredClone(original)).toEqual(original);
  });

  it.each(Object.keys(EVENTS))('事件 %s 能原样穿过结构化克隆', (type) => {
    const original = EVENTS[type as HostEvent['type']];
    expect(structuredClone(original)).toEqual(original);
  });

  /**
   * 字节必须以 Uint8Array 的身份到达对面。
   * VS Code 1.57 之前会把它退化成 `{0:1,1:2,…}` 的普通对象，几 MB 数据就能把界面卡死 ——
   * 这也是 engines.vscode 定在 ^1.75 的原因之一。
   */
  it('字节数组穿过之后仍然是 Uint8Array，而不是退化成普通对象', () => {
    const event = EVENTS.frames;
    const cloned = structuredClone(event);
    if (cloned.type !== 'frames') throw new Error('unreachable');

    expect(cloned.items[0]?.bytes).toBeInstanceOf(Uint8Array);
    expect(cloned.items[0]?.bytes).toEqual(new Uint8Array([2]));
  });

  /**
   * 错误必须是**普通对象**，不能直接塞一个 Error 实例：
   * 结构化克隆会把 Error 克隆成 Error，但自定义字段（比如 TransportError 的 kind）
   * 会在路上悄悄丢掉，对面拿到的错误就少了它最有用的那部分。
   */
  it('应答里的错误是普通对象，自定义字段不会在路上丢掉', () => {
    const response: HostResponse = {
      kind: 'response',
      id: 1,
      result: null,
      error: { kind: 'TransportError', message: 'COM3 is held by another panel' },
    };

    expect(structuredClone(response)).toEqual(response);
    expect(structuredClone(response).error?.kind).toBe('TransportError');
  });
});
