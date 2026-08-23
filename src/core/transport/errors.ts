export type TransportErrorKind =
  | 'unsupported'
  | 'invalid-state'
  | 'open-failed'
  | 'no-writable'
  | 'read'
  | 'write'
  | 'close-failed'
  | 'backpressure';

/**
 * 传输层错误。原型有 8 处 `catch (e) {}` 把失败静默吞掉（缺陷 D6），
 * 这里所有失败都归一成带 kind 的错误对象，交给上层决定是记日志还是触发重连。
 */
export class TransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TransportError';
  }

  static from(error: unknown, kind: TransportErrorKind, prefix: string): TransportError {
    if (error instanceof TransportError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new TransportError(kind, `${prefix}: ${detail}`, { cause: error });
  }
}
