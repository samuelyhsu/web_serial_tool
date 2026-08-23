import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport, TEST_OPTIONS } from '../../../tests/fakeTransport';
import { TaskScheduler } from '../scheduler/taskScheduler';
import { TransportError } from '../transport/errors';
import type { SessionNotice } from './notices';
import { SerialSession, type Direction } from './serialSession';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Harness {
  session: SerialSession;
  transports: FakeTransport[];
  current: () => FakeTransport;
  frames: { direction: Direction; text: string }[];
  notices: SessionNotice[];
  states: string[];
  resolvePort: ReturnType<typeof vi.fn>;
}

function makeHarness(
  options: {
    portAvailable?: boolean;
    /** 每次创建 transport 时调用，可用来让某一次 open() 挂起。 */
    onCreateTransport?: (transport: FakeTransport, index: number) => void;
  } = {},
): Harness {
  const transports: FakeTransport[] = [];
  const frames: { direction: Direction; text: string }[] = [];
  const notices: SessionNotice[] = [];
  const states: string[] = [];
  const fakePort = {} as SerialPort;

  const resolvePort = vi.fn(() =>
    Promise.resolve(options.portAvailable === false ? undefined : fakePort),
  );

  const session = new SerialSession({
    createTransport: () => {
      const transport = new FakeTransport();
      options.onCreateTransport?.(transport, transports.length);
      transports.push(transport);
      return transport;
    },
    resolvePort,
    describeConfig: (o) => `#1 @ ${o.baudRate}`,
  });

  session.setHandlers({
    onFrame: (direction, bytes) => frames.push({ direction, text: decoder.decode(bytes) }),
    onNotice: (notice) => notices.push(notice),
    onStateChange: (state) => states.push(state),
    onThroughput: () => undefined,
  });

  return {
    session,
    transports,
    current: () => transports[transports.length - 1]!,
    frames,
    notices,
    states,
    resolvePort,
  };
}

describe('关闭与在途的打开竞争', () => {
  it('重连尝试正卡在 open 里时点关闭，不会留下一个还开着的 transport', async () => {
    vi.useFakeTimers();
    // 第 2 个 transport（即重连那一次）的 open() 挂起，模拟设备刚重新枚举、驱动很慢
    const harness = makeHarness({
      onCreateTransport: (transport, index) => {
        if (index === 1) transport.blockOpen();
      },
    });
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);

    harness.current().emitUnplug(); // 设备被拔出 → 进入退避重连
    expect(harness.session.state).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(2000); // 退避到点，重连尝试开始并卡在 open 里
    expect(harness.transports).toHaveLength(2);

    await harness.session.close(); // 用户此刻点了「关闭」
    harness.transports[1]!.releaseOpen(); // 驱动这才把端口打开
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.session.state).toBe('closed');
    // 关键：那条迟到的链路必须被就地关掉，否则端口被独占到刷新页面为止
    expect(harness.transports[1]!.state).toBe('closed');
    vi.useRealTimers();
  });

  it('打开途中点关闭，迟到的 open 不会把状态复活成 open', async () => {
    const harness = makeHarness({
      onCreateTransport: (transport) => transport.blockOpen(),
    });

    const opening = harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    const closing = harness.session.close();
    setTimeout(() => harness.transports[0]!.releaseOpen(), 0);
    await Promise.allSettled([opening, closing]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.session.state).toBe('closed');
    expect(harness.transports[0]!.state).toBe('closed');
    expect(harness.states.at(-1)).toBe('closed');
  });
});

function codes(notices: SessionNotice[]): string[] {
  return notices.map((n) => n.code);
}

describe('SerialSession', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    harness = makeHarness();
    harness.session.setReconnectSettings({
      enabled: true,
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 4000,
      jitterRatio: 0,
    });
  });

  afterEach(() => {
    harness.session.dispose();
    vi.useRealTimers();
  });

  it('打开端口后进入 open 状态并发出 port-opened 通知', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);

    expect(harness.session.state).toBe('open');
    expect(harness.states).toEqual(['opening', 'open']);
    expect(harness.notices).toContainEqual({ code: 'port-opened', config: '#1 @ 115200' });
    expect(harness.current().openCalls).toEqual([TEST_OPTIONS]);
  });

  it('打开失败时回到 closed 并发出 open-failed', async () => {
    const session = harness.session;
    // 让下一个 transport 的 open 失败
    const failing = new SerialSession({
      createTransport: () => {
        const t = new FakeTransport();
        t.failNextOpen = new Error('Access denied');
        return t;
      },
      resolvePort: () => Promise.resolve(undefined),
      describeConfig: () => 'cfg',
    });
    const notices: SessionNotice[] = [];
    failing.setHandlers({ onNotice: (n) => notices.push(n) });

    await expect(failing.open({} as SerialPort, 'port-1', TEST_OPTIONS)).rejects.toThrow(
      'Access denied',
    );
    expect(failing.state).toBe('closed');
    expect(notices).toContainEqual({ code: 'open-failed', message: 'Access denied' });
    expect(session.state).toBe('closed');
  });

  /**
   * 原样分块：驱动交付一次就是一帧，不按 \n 切、也不按空闲超时切。
   * 一次交付里含多个换行，仍然只算一帧。
   */
  it('驱动每交付一次数据就是一帧，不做任何切分', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    harness.current().emitData(encoder.encode('+VER: SA-2100\r\nOK\r\n'));

    expect(harness.frames).toEqual([{ direction: 'rx', text: '+VER: SA-2100\r\nOK\r\n' }]);
  });

  it('分两次交付就是两帧，不做拼接', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    harness.current().emitData(encoder.encode('+VER: SA-'));
    harness.current().emitData(encoder.encode('2100\r\n'));

    expect(harness.frames).toEqual([
      { direction: 'rx', text: '+VER: SA-' },
      { direction: 'rx', text: '2100\r\n' },
    ]);
  });

  it('发送成功时记一条 tx 帧', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    await harness.session.send(encoder.encode('AT+VER?\r\n'));

    expect(harness.frames).toEqual([{ direction: 'tx', text: 'AT+VER?\r\n' }]);
    expect(harness.current().written).toHaveLength(1);
  });

  it('端口未打开时发送只提示，不抛异常', async () => {
    await harness.session.send(encoder.encode('AT'));
    expect(codes(harness.notices)).toContain('not-open');
  });

  it('空数据不发送', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    await harness.session.send(new Uint8Array(0));
    expect(harness.current().written).toHaveLength(0);
  });

  /** 缺陷 D10：背压不再是静默积压，而是一条用户可见的通知。 */
  it('写队列满时发出背压通知而不是抛异常', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    harness.current().rejectWritesWith(new TransportError('backpressure', 'full'));

    await harness.session.send(encoder.encode('AT'));
    expect(codes(harness.notices)).toContain('write-dropped-backpressure');
  });

  it('写入失败（非背压）发出 write-error', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    harness.current().rejectWritesWith(new TransportError('write', 'device gone'));

    await harness.session.send(encoder.encode('AT'));
    expect(codes(harness.notices)).toContain('write-error');
  });

  it('主动关闭时不触发重连', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    await harness.session.close();

    expect(harness.session.state).toBe('closed');
    expect(codes(harness.notices)).toContain('port-closed');
    expect(codes(harness.notices)).not.toContain('connection-lost');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.transports).toHaveLength(1);
  });

  /** 原样分块没有缓冲，收到即上报，因此关闭时不存在「残留半帧」这回事。 */
  it('数据收到即上报，关闭时没有滞留内容', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    harness.current().emitData(encoder.encode('no newline here'));
    expect(harness.frames).toEqual([{ direction: 'rx', text: 'no newline here' }]);

    await harness.session.close();
    expect(harness.frames).toHaveLength(1);
  });

  /** 这是原型最难在真机上复现、也最容易写错的一条链路。 */
  it('设备掉线后按退避重连，成功后回到 open', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    harness.current().emitUnplug();

    expect(harness.session.state).toBe('reconnecting');
    expect(codes(harness.notices)).toContain('connection-lost');

    await vi.advanceTimersByTimeAsync(500);
    expect(harness.session.state).toBe('open');
    expect(harness.notices).toContainEqual({ code: 'reconnect-succeeded', attempt: 1 });
    expect(harness.transports).toHaveLength(2);
  });

  it('重连时按稳定 key 重新解析端口，而不是复用可能失效的旧对象', async () => {
    await harness.session.open({} as SerialPort, 'port-7', TEST_OPTIONS);
    harness.current().emitUnplug();
    await vi.advanceTimersByTimeAsync(500);

    expect(harness.resolvePort).toHaveBeenCalledWith('port-7');
  });

  it('端口彻底消失时按退避重试到上限后放弃', async () => {
    const gone = makeHarness({ portAvailable: false });
    gone.session.setReconnectSettings({
      enabled: true,
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitterRatio: 0,
    });
    await gone.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    gone.current().emitUnplug();

    await vi.advanceTimersByTimeAsync(100 + 200 + 400);

    expect(gone.session.state).toBe('closed');
    expect(gone.notices).toContainEqual({ code: 'reconnect-gave-up', attempts: 2 });
    gone.session.dispose();
  });

  it('关闭自动重连后掉线直接进入 closed', async () => {
    harness.session.setReconnectSettings({ enabled: false });
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    harness.current().emitUnplug();

    expect(harness.session.state).toBe('closed');
    expect(codes(harness.notices)).toContain('connection-lost');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.transports).toHaveLength(1);
  });

  it('重连过程中主动关闭会取消重连', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    harness.current().emitUnplug();
    expect(harness.session.state).toBe('reconnecting');

    await harness.session.close();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.session.state).toBe('closed');
    expect(harness.transports).toHaveLength(1);
  });

  it('读取错误经通知上报，不再像原型那样被空 catch 吞掉', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    harness.current().emitError(new TransportError('read', 'Framing error'));

    expect(harness.notices).toContainEqual({ code: 'read-error', message: 'Framing error' });
  });

  it('重复 open 会抛错而不是打开第二个端口', async () => {
    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    await expect(harness.session.open({} as SerialPort, 'port-2', TEST_OPTIONS)).rejects.toThrow(
      TransportError,
    );
    expect(harness.transports).toHaveLength(1);
  });

  /**
   * 缺陷 D12 的回归测试。
   *
   * 原型把重连退避定时器（键名 "rc1".."rc5"）和周期发送任务塞进同一个 this.timers，
   * stopAll() 一律 clearTimeout，于是用户点「全部停止」会连带把正在进行的重连也干掉，
   * 而且没有任何提示。现在两者分属 TaskScheduler 与 ReconnectController，互不影响。
   */
  it('停止全部周期发送不会误杀正在进行的重连', async () => {
    const scheduler = new TaskScheduler();
    scheduler.start('single', { intervalMs: 50, run: () => undefined });

    await harness.session.open({} as SerialPort, 'port-1', TEST_OPTIONS);
    harness.current().emitUnplug();
    expect(harness.session.state).toBe('reconnecting');

    scheduler.stopAll();
    expect(scheduler.runningCount).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(harness.session.state).toBe('open');
    expect(harness.notices).toContainEqual({ code: 'reconnect-succeeded', attempt: 1 });
  });
});
