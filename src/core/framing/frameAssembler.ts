/**
 * 接收分帧。
 *
 * 驱动交付的「块」边界是时序的产物，不是协议的边界：同一条设备回复可能被拆成两次
 * read()，也可能和下一条挤在一次里。这里把字节流重新切成有意义的帧。
 *
 * 三种模式互斥，因此建模成一个枚举而不是几个布尔开关 —— 让「同时开了换行分帧和
 * 空闲分帧」这种状态从类型上就不存在，不必靠界面去约束。
 *
 *  - `raw`  原样分块：读到什么就交付什么，零延迟、完全可预测，最适合排查
 *           「数据到底是怎么到达的」。
 *  - `idle` 空闲分帧：静默超过 idleMs 即成帧。Modbus RTU 的 3.5 字符间隔就是这个思路，
 *           适合没有帧尾标记的二进制协议。
 *  - `line` 换行分帧：见到 `\n` 即成帧，适合 AT 指令、NMEA 这类文本协议。
 *
 * 帧里**保留分隔符本身**（`\n`、以及它前面的 `\r`）。这是调试工具，不能悄悄吃掉字节：
 * 设备到底发的是 CRLF 还是 LF，往往正是要查的东西；而且状态栏的 RX 字节数直接来自
 * 帧长度，丢字节会让统计对不上。
 */

/** 换行分帧的分隔符。 */
const LF = 0x0a;

export type FrameMode = 'raw' | 'idle' | 'line';

/** 空闲分帧的默认静默时长。 */
export const DEFAULT_IDLE_FRAME_MS = 10;

/**
 * 单帧字节上限。
 *
 * 没有它，一个只发二进制、永远不出现 `\n` 的设备会让 line 模式无限攒下去；
 * idle 模式在持续满速率、从不静默的链路上同样攒不完。到顶就强制成帧，
 * 宁可切错一帧，也不能让缓冲无界增长。
 */
export const DEFAULT_MAX_FRAME_BYTES = 8192;

export interface FramingConfig {
  mode: FrameMode;
  idleMs: number;
  maxFrameBytes: number;
}

export const DEFAULT_FRAMING: FramingConfig = {
  mode: 'raw',
  idleMs: DEFAULT_IDLE_FRAME_MS,
  maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
};

export class FrameAssembler {
  #parts: Uint8Array[] = [];
  #size = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #config: FramingConfig;

  constructor(
    private readonly emit: (frame: Uint8Array) => void,
    config: Partial<FramingConfig> = {},
  ) {
    this.#config = { ...DEFAULT_FRAMING, ...config };
  }

  get config(): FramingConfig {
    return this.#config;
  }

  /** 已收下但尚未成帧的字节数。 */
  get pendingBytes(): number {
    return this.#size;
  }

  /**
   * 改分帧配置。
   *
   * 先把攒着的字节吐出来再换 —— 否则切换的瞬间缓冲里那半截数据会按新模式的规则
   * 被重新解释，甚至永远卡在里面。
   */
  configure(config: Partial<FramingConfig>): void {
    const next: FramingConfig = { ...this.#config, ...config };
    if (
      next.mode === this.#config.mode &&
      next.idleMs === this.#config.idleMs &&
      next.maxFrameBytes === this.#config.maxFrameBytes
    ) {
      return;
    }
    this.flush();
    this.#config = next;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;

    switch (this.#config.mode) {
      case 'raw':
        // 不缓冲、不拼接，读到什么就是一帧
        this.emit(chunk);
        return;
      case 'line':
        this.#pushLine(chunk);
        return;
      case 'idle':
        this.#append(chunk);
        if (this.#size >= this.#config.maxFrameBytes) {
          this.flush(); // 强制成帧，同时把定时器清掉
          return;
        }
        this.#restartIdleTimer();
        return;
    }
  }

  /** 立刻交付缓冲中的内容。端口关闭、切换模式时调用，避免尾巴上的半截数据永远不出现。 */
  flush(): void {
    this.#clearTimer();
    if (this.#size === 0) return;
    const frame = this.#take();
    this.emit(frame);
  }

  /** 丢弃缓冲，不交付。用于会话重置。 */
  reset(): void {
    this.#clearTimer();
    this.#parts = [];
    this.#size = 0;
  }

  #pushLine(chunk: Uint8Array): void {
    let start = 0;
    for (let i = 0; i < chunk.byteLength; i += 1) {
      if (chunk[i] !== LF) continue;
      // 分隔符归属于它结束的那一帧，因此切点在 i 之后
      this.#append(chunk.subarray(start, i + 1));
      this.emit(this.#take());
      start = i + 1;
    }

    if (start < chunk.byteLength) {
      this.#append(chunk.subarray(start));
      // 迟迟等不到 `\n` 时兜底，避免缓冲无界增长
      if (this.#size >= this.#config.maxFrameBytes) this.flush();
    }
  }

  #append(part: Uint8Array): void {
    if (part.byteLength === 0) return;
    this.#parts.push(part);
    this.#size += part.byteLength;
  }

  /**
   * 取走缓冲，拼成一块连续的字节。
   *
   * 攒的时候只往数组里放引用、成帧时才拼一次，避免每来一个块就 O(n) 复制一遍
   * （高波特率下那会退化成 O(n²)）。
   */
  #take(): Uint8Array {
    const frame = new Uint8Array(this.#size);
    let offset = 0;
    for (const part of this.#parts) {
      frame.set(part, offset);
      offset += part.byteLength;
    }
    this.#parts = [];
    this.#size = 0;
    return frame;
  }

  #restartIdleTimer(): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.#config.idleMs);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

/**
 * 把界面上选的模式落成实际生效的分帧配置。
 *
 * 两条回落规则：
 *  - 换行分帧只在 TXT 视图下有意义（HEX 视图里按 `\n` 切没有意义），选了但视图是 HEX
 *    时回落到空闲；
 *  - 空闲时长为 0 等同于不分帧。界面会把这种情况同步成 `raw`，让下拉框显示的和
 *    实际生效的永远一致，这里只是兜底。
 */
export function resolveFraming(options: {
  mode: FrameMode;
  idleMs: number;
  textView: boolean;
}): Pick<FramingConfig, 'mode' | 'idleMs'> {
  const mode = options.mode === 'line' && !options.textView ? 'idle' : options.mode;
  if (mode === 'idle' && options.idleMs <= 0) return { mode: 'raw', idleMs: options.idleMs };
  return { mode, idleMs: options.idleMs };
}
