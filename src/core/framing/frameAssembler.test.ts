import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IDLE_FRAME_MS,
  FrameAssembler,
  resolveFraming,
  type FramingConfig,
} from './frameAssembler';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** 收集成帧结果，断言时按文本比对可读性最好。 */
function harness(config: Partial<FramingConfig> = {}): {
  framer: FrameAssembler;
  frames: string[];
  raw: Uint8Array[];
} {
  const raw: Uint8Array[] = [];
  const frames: string[] = [];
  const framer = new FrameAssembler((frame) => {
    raw.push(frame);
    frames.push(decoder.decode(frame));
  }, config);
  return { framer, frames, raw };
}

describe('原样分块（raw）', () => {
  it('读到什么就交付什么，不缓冲不拼接', () => {
    const { framer, frames } = harness({ mode: 'raw' });
    framer.push(bytes('AB'));
    framer.push(bytes('CD'));
    expect(frames).toEqual(['AB', 'CD']);
    expect(framer.pendingBytes).toBe(0);
  });

  it('空块被忽略', () => {
    const { framer, frames } = harness({ mode: 'raw' });
    framer.push(new Uint8Array(0));
    expect(frames).toEqual([]);
  });
});

describe('空闲分帧（idle）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('静默到点才成帧，其间的多个块拼成一帧', () => {
    const { framer, frames } = harness({ mode: 'idle', idleMs: 10 });
    framer.push(bytes('AB'));
    vi.advanceTimersByTime(5);
    framer.push(bytes('CD'));

    expect(frames).toEqual([]); // 还没静默够
    vi.advanceTimersByTime(10);
    expect(frames).toEqual(['ABCD']);
  });

  it('每来一块都重新计时，持续的数据流不会被中途切开', () => {
    const { framer, frames } = harness({ mode: 'idle', idleMs: 10 });
    for (let i = 0; i < 5; i += 1) {
      framer.push(bytes('x'));
      vi.advanceTimersByTime(9); // 每次都在超时前
    }
    expect(frames).toEqual([]);

    vi.advanceTimersByTime(10);
    expect(frames).toEqual(['xxxxx']);
  });

  it('两段之间静默足够长就切成两帧', () => {
    const { framer, frames } = harness({ mode: 'idle', idleMs: 10 });
    framer.push(bytes('first'));
    vi.advanceTimersByTime(20);
    framer.push(bytes('second'));
    vi.advanceTimersByTime(20);
    expect(frames).toEqual(['first', 'second']);
  });

  it('超过上限时强制成帧，不让缓冲无界增长', () => {
    const { framer, frames, raw } = harness({ mode: 'idle', idleMs: 10, maxFrameBytes: 4 });
    framer.push(bytes('AB'));
    framer.push(bytes('CD')); // 到顶
    expect(raw[0]).toHaveLength(4);
    expect(frames).toEqual(['ABCD']);
    expect(framer.pendingBytes).toBe(0);

    // 强制成帧后定时器也该清掉，不该再吐一个空帧
    vi.advanceTimersByTime(50);
    expect(frames).toHaveLength(1);
  });

  it('默认静默时长是 10ms', () => {
    const { framer, frames } = harness({ mode: 'idle' });
    expect(framer.config.idleMs).toBe(DEFAULT_IDLE_FRAME_MS);
    framer.push(bytes('AB'));
    vi.advanceTimersByTime(DEFAULT_IDLE_FRAME_MS);
    expect(frames).toEqual(['AB']);
  });
});

describe('换行分帧（line）', () => {
  it('见到 \\n 即成帧，分隔符保留在帧里', () => {
    const { framer, frames } = harness({ mode: 'line' });
    framer.push(bytes('OK\nERR\n'));
    expect(frames).toEqual(['OK\n', 'ERR\n']);
  });

  it('CRLF 完整保留 —— 设备发的到底是 CRLF 还是 LF 常常正是要查的东西', () => {
    const { framer, frames } = harness({ mode: 'line' });
    framer.push(bytes('AT+OK\r\n'));
    expect(frames).toEqual(['AT+OK\r\n']);
  });

  it('一行被拆到多个块里也能正确拼回', () => {
    const { framer, frames } = harness({ mode: 'line' });
    framer.push(bytes('AT+'));
    framer.push(bytes('VER'));
    framer.push(bytes('?\n'));
    expect(frames).toEqual(['AT+VER?\n']);
  });

  it('一个块里带多行加半行：整行立即交付，半行留在缓冲里等下一块', () => {
    const { framer, frames } = harness({ mode: 'line' });
    framer.push(bytes('a\nb\nc'));
    expect(frames).toEqual(['a\n', 'b\n']);
    expect(framer.pendingBytes).toBe(1);

    framer.push(bytes('d\n'));
    expect(frames).toEqual(['a\n', 'b\n', 'cd\n']);
  });

  it('空行也是一帧，不被吞掉', () => {
    const { framer, frames } = harness({ mode: 'line' });
    framer.push(bytes('\n\n'));
    expect(frames).toEqual(['\n', '\n']);
  });

  it('迟迟等不到换行时按上限强制成帧', () => {
    const { framer, frames } = harness({ mode: 'line', maxFrameBytes: 4 });
    framer.push(bytes('ABCDEF'));
    expect(frames).toEqual(['ABCDEF']);
  });

  it('二进制数据里恰好出现的 0x0A 也会被当作分隔符 —— 这是该模式的固有语义', () => {
    const { framer, raw } = harness({ mode: 'line' });
    framer.push(Uint8Array.from([0x01, 0x0a, 0x02]));
    expect(raw[0]).toEqual(Uint8Array.from([0x01, 0x0a]));
  });
});

describe('flush 与模式切换', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flush 立刻交付缓冲里的半截数据', () => {
    const { framer, frames } = harness({ mode: 'line' });
    framer.push(bytes('no newline yet'));
    expect(frames).toEqual([]);

    framer.flush(); // 端口关闭时走这条路
    expect(frames).toEqual(['no newline yet']);
  });

  it('缓冲为空时 flush 不产生空帧', () => {
    const { framer, frames } = harness({ mode: 'idle' });
    framer.flush();
    framer.flush();
    expect(frames).toEqual([]);
  });

  it('切换模式前先把攒着的吐出来，不让半截数据按新规则被重新解释', () => {
    const { framer, frames } = harness({ mode: 'idle', idleMs: 10 });
    framer.push(bytes('pending'));
    framer.configure({ mode: 'line' });
    expect(frames).toEqual(['pending']);
    expect(framer.pendingBytes).toBe(0);
  });

  it('配置没变化时不触发 flush', () => {
    const { framer, frames } = harness({ mode: 'idle', idleMs: 10 });
    framer.push(bytes('pending'));
    framer.configure({ mode: 'idle', idleMs: 10 });
    expect(frames).toEqual([]);
  });

  it('切到 raw 后旧的空闲定时器不会再吐帧', () => {
    const { framer, frames } = harness({ mode: 'idle', idleMs: 10 });
    framer.push(bytes('AB'));
    framer.configure({ mode: 'raw' });
    expect(frames).toEqual(['AB']); // 切换时 flush 出来的

    vi.advanceTimersByTime(50);
    expect(frames).toEqual(['AB']); // 定时器已清，没有多余的空帧
  });

  it('reset 丢弃缓冲且不交付', () => {
    const { framer, frames } = harness({ mode: 'idle', idleMs: 10 });
    framer.push(bytes('discard me'));
    framer.reset();
    expect(framer.pendingBytes).toBe(0);
    vi.advanceTimersByTime(50);
    expect(frames).toEqual([]);
  });
});

describe('resolveFraming', () => {
  it('选什么就是什么', () => {
    expect(resolveFraming({ mode: 'raw', idleMs: 10, textView: true })).toMatchObject({
      mode: 'raw',
    });
    expect(resolveFraming({ mode: 'idle', idleMs: 10, textView: true })).toEqual({
      mode: 'idle',
      idleMs: 10,
    });
    expect(resolveFraming({ mode: 'line', idleMs: 10, textView: true })).toMatchObject({
      mode: 'line',
    });
  });

  it('空闲时长为 0 等同于不分帧', () => {
    expect(resolveFraming({ mode: 'idle', idleMs: 0, textView: true })).toMatchObject({
      mode: 'raw',
    });
  });

  it('HEX 视图下换行分帧不生效，回落到空闲分帧', () => {
    expect(resolveFraming({ mode: 'line', idleMs: 10, textView: false })).toMatchObject({
      mode: 'idle',
    });
  });

  it('HEX 视图 + 换行分帧 + 空闲为 0：一路回落到原样', () => {
    expect(resolveFraming({ mode: 'line', idleMs: 0, textView: false })).toMatchObject({
      mode: 'raw',
    });
  });
});
