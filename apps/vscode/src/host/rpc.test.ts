import { describe, expect, it } from 'vitest';
import type { HostRequest } from '../shared/protocol';
import { handleRequest } from './rpc';
import type { SessionHost } from './sessionHost';

/**
 * 请求处理的成功与失败两条路。
 *
 * 失败那条尤其要测：它把宿主抛出的异常翻译成对面能读懂的应答。翻错了的话，
 * 界面上的按钮会永远转圈（应答没回去），或者错误原因在路上被抹平成一句
 * 「Error」—— 而「端口被另一个面板占着」这类信息正是用户最需要看到的。
 */

function fakeHost(handle: (body: unknown) => Promise<unknown>): SessionHost {
  return { handle } as unknown as SessionHost;
}

const REQUEST: HostRequest = { kind: 'request', id: 7, body: { method: 'session.close' } };

describe('handleRequest', () => {
  it('成功时带回结果，并对上请求序号', async () => {
    const response = await handleRequest(
      fakeHost(() => Promise.resolve({ ok: true })),
      REQUEST,
    );

    expect(response).toEqual({
      kind: 'response',
      id: 7,
      result: { ok: true },
      error: null,
    });
  });

  it('没有返回值时给 null，而不是 undefined —— 后者过不了序列化', async () => {
    const response = await handleRequest(
      fakeHost(() => Promise.resolve(undefined)),
      REQUEST,
    );

    expect(response.result).toBeNull();
  });

  it('抛出 Error 时保留 name 与 message', async () => {
    const error = new Error('COM3 is held by another panel');
    error.name = 'TransportError';

    const response = await handleRequest(
      fakeHost(() => Promise.reject(error)),
      REQUEST,
    );

    expect(response.error).toEqual({
      kind: 'TransportError',
      message: 'COM3 is held by another panel',
    });
    expect(response.id).toBe(7);
  });

  it('抛出的不是 Error 也照样能应答，不会把请求晾在那里', async () => {
    const response = await handleRequest(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      fakeHost(() => Promise.reject('boom')),
      REQUEST,
    );

    expect(response.error).toEqual({ kind: 'Error', message: 'boom' });
  });
});
