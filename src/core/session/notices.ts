/**
 * 会话通知：core 层不认识任何语言，只发出带 code + 参数的结构化事件，
 * 由 UI 层的 i18n 决定怎么措辞。原型把中英文字符串硬编码在业务逻辑里
 * （`this.sys(en ? "Port opened " : "串口已打开 ")`，全文散落 20 多处），
 * 加一种语言就要改遍所有分支。
 */
export type SessionNotice =
  | { code: 'port-opened'; config: string }
  | { code: 'port-closed' }
  | { code: 'open-failed'; message: string }
  | { code: 'connection-lost' }
  | { code: 'reconnect-scheduled'; attempt: number; max: number; delayMs: number }
  | { code: 'reconnect-succeeded'; attempt: number }
  | { code: 'reconnect-gave-up'; attempts: number }
  | { code: 'read-error'; message: string }
  | { code: 'write-error'; message: string }
  | { code: 'write-dropped-backpressure'; pendingBytes: number }
  | { code: 'not-open' }
  /** 该端口已被本工具的另一个页面占用。多页面各连一口时才会出现。 */
  | { code: 'port-busy' };

export type SessionNoticeCode = SessionNotice['code'];
