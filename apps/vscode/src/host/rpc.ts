import type { HostRequest, HostResponse } from '../shared/protocol';
import type { SessionHost } from './sessionHost';

/**
 * 一次 RPC 的处理：把请求交给会话，把结果或错误包成应答。
 *
 * 单独成文件不是为了复用（只有一个调用方），而是为了**能被测到**：
 * 有了它，测试可以把 webview 侧的客户端和宿主侧的会话直接对接起来跑一条
 * 完整的回环，而不是各测各的、把中间那段协议留成盲区 ——
 * 周期发送那个 bug 恰恰就藏在接缝里（调用点漏传 frames，两端各自都是对的）。
 */
export async function handleRequest(
  host: SessionHost,
  message: HostRequest,
): Promise<HostResponse> {
  try {
    const result = await host.handle(message.body);
    return { kind: 'response', id: message.id, result: result ?? null, error: null };
  } catch (error) {
    return {
      kind: 'response',
      id: message.id,
      result: null,
      error: {
        kind: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
