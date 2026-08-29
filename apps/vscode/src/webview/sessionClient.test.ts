import { describe, expect, it, vi } from 'vitest';
import type { ConnectionOptions } from '@/core/transport/types';
import type { HostEvent, HostRequest } from '../shared/protocol';
import { HostError, SessionClient } from './sessionClient';

const OPTIONS: ConnectionOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

function makeClient(): { client: SessionClient; sent: HostRequest[] } {
  const sent: HostRequest[] = [];
  return { client: new SessionClient((message) => sent.push(message)), sent };
}

/** 宿主成功应答第 n 条请求。 */
function reply(client: SessionClient, id: number, result: unknown = null): void {
  client.receive({ kind: 'response', id, result, error: null });
}

describe('SessionClient（webview 侧的 RPC 客户端）', () => {
  it('把调用翻译成带序号的请求', async () => {
    const { client, sent } = makeClient();

    const opening = client.open('COM3', OPTIONS);
    expect(sent).toEqual([
      {
        kind: 'request',
        id: 1,
        body: { method: 'session.open', portKey: 'COM3', options: OPTIONS },
      },
    ]);

    reply(client, 1);
    await expect(opening).resolves.toBeUndefined();
  });

  it('多个在途请求各自对号入座，不会串线', async () => {
    const { client, sent } = makeClient();

    const first = client.send(new Uint8Array([1]));
    const second = client.send(new Uint8Array([2]));
    expect(sent.map((request) => request.id)).toEqual([1, 2]);

    // 故意乱序应答
    reply(client, 2);
    reply(client, 1);

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it('宿主报错时抛出 HostError，并保留 kind 供界面区分', async () => {
    const { client } = makeClient();

    const opening = client.open('COM3', OPTIONS);
    client.receive({
      kind: 'response',
      id: 1,
      result: null,
      error: { kind: 'TransportError', message: 'COM3 is held by another panel' },
    });

    await expect(opening).rejects.toBeInstanceOf(HostError);
    await expect(opening).rejects.toThrow(/another panel/);
  });

  /**
   * 面板被隐藏时 webview 会被销毁，重建后宿主会先发一条 snapshot。
   * 此时之前那些在途请求永远不会有应答了，必须就地了结，
   * 否则界面上会留下几个永不 resolve 的 promise（按钮一直转圈）。
   */
  it('收到快照时了结所有在途请求', async () => {
    const { client } = makeClient();
    const opening = client.open('COM3', OPTIONS);

    client.receive(snapshot());

    await expect(opening).rejects.toThrow(/reloaded/);
  });

  it('迟到的应答被丢弃，不会误伤后来的同号请求', () => {
    const { client } = makeClient();
    void client.open('COM3', OPTIONS).catch(() => undefined);
    client.receive(snapshot());

    // 面板重建前那条请求的应答现在才到
    expect(() => reply(client, 1)).not.toThrow();
  });

  it('事件按类型分发给对应的处理器', () => {
    const { client } = makeClient();
    const onFrames = vi.fn();
    const onNotice = vi.fn();
    const onState = vi.fn();
    client.setHandlers({ onFrames, onNotice, onState });

    client.receive({ kind: 'event', type: 'frames', items: [] });
    client.receive({ kind: 'event', type: 'notice', notice: { code: 'port-busy' } });
    client.receive({ kind: 'event', type: 'state', state: 'open', openedAt: 1 });

    expect(onFrames).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ notice: { code: 'port-busy' } }),
    );
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ state: 'open' }));
  });

  it('打开端口的请求会分发出去 —— 活动栏点一下端口走的就是这条', () => {
    const { client } = makeClient();
    const onOpenPort = vi.fn();
    client.setHandlers({ onOpenPort });

    client.receive({ kind: 'event', type: 'openPort', portKey: 'COM3' });

    expect(onOpenPort).toHaveBeenCalledWith(expect.objectContaining({ portKey: 'COM3' }));
  });

  it('没注册处理器时收到事件也不该炸', () => {
    const { client } = makeClient();
    expect(() => client.receive({ kind: 'event', type: 'tasks', running: [] })).not.toThrow();
  });

  it('发送通道本身抛错时，调用方拿到的是 rejected 而不是永久挂起', async () => {
    const client = new SessionClient(() => {
      throw new Error('webview is gone');
    });

    await expect(client.close()).rejects.toThrow(/webview is gone/);
  });

  it('即发即忘的调用（分帧、重连开关）不会因为失败冒泡成未处理拒绝', () => {
    const { client } = makeClient();

    expect(() => {
      client.setFraming({ mode: 'line' });
      client.setReconnectSettings({ enabled: false });
      client.writePref('theme', 'dark');
    }).not.toThrow();

    client.receive({
      kind: 'response',
      id: 1,
      result: null,
      error: { kind: 'Error', message: 'boom' },
    });
  });
});

function snapshot(): HostEvent {
  return {
    kind: 'event',
    type: 'snapshot',
    ports: [],
    holders: {},
    selectedPortKey: null,
    options: OPTIONS,
    autoReconnect: true,
    state: 'closed',
    openedAt: 0,
    frames: [],
    runningTasks: [],
    prefs: {},
    language: 'zh',
  };
}
