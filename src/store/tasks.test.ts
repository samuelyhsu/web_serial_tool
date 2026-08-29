import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Platform, TaskPatch, TaskSpec } from './platform';

/**
 * 周期任务必须把「要发什么」交给平台，而不是只交一个闭包。
 *
 * 这条不是风格问题：在 VS Code 里会话活在扩展宿主进程，面板一被隐藏 webview 就会
 * 连同定时器一起销毁。只有带着 frames 交出去的任务才能继续跑 —— 而「挂个心跳跑一下午」
 * 正是这类工具最常见的用法。
 *
 * 之所以要专门测它：TaskSpec 上的 frames 是可选字段，调用点漏传时类型检查是过的，
 * 浏览器里也一切正常，只有在 VS Code 里切个标签页才会暴露。
 */

interface Recorded {
  start: { id: string; spec: TaskSpec }[];
  update: { id: string; patch: TaskPatch }[];
}

function fakePlatform(recorded: Recorded): Platform {
  let running: string[] = [];
  const listeners = new Set<(ids: string[]) => void>();

  return {
    kind: 'web',
    supported: true,
    session: {
      setHandlers: () => undefined,
      setConfigDescriber: () => undefined,
      open: () => Promise.resolve(),
      close: () => Promise.resolve(),
      send: () => Promise.resolve(),
      setFraming: () => undefined,
      setReconnectSettings: () => undefined,
      pendingBytes: 0,
      dispose: () => undefined,
    },
    tasks: {
      start: (id, spec) => {
        recorded.start.push({ id, spec });
        running = [...new Set([...running, id])];
        for (const listener of listeners) listener(running);
      },
      stop: (id) => {
        running = running.filter((item) => item !== id);
        for (const listener of listeners) listener(running);
      },
      stopAll: () => {
        running = [];
        for (const listener of listeners) listener(running);
      },
      update: (id, patch) => recorded.update.push({ id, patch }),
      runningIds: () => running,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    leases: {
      holders: () => ({}),
      claim: () => undefined,
      release: () => undefined,
      refresh: () => undefined,
      subscribe: () => () => undefined,
      dispose: () => undefined,
    },
    listPorts: () => Promise.resolve([]),
    requestPort: () => Promise.reject(new Error('not used')),
    watchPorts: () => () => undefined,
  };
}

/** 装好假平台再加载 store —— store 在模块初始化时就会向 platform() 要调度器。 */
async function load() {
  vi.resetModules();
  const recorded: Recorded = { start: [], update: [] };
  const platform = await import('./platform');
  platform.setPlatform(fakePlatform(recorded));

  const connection = await import('./connectionStore');
  // 端口没打开时循环会被拒，这里直接把状态摆成已连接
  connection.useConnectionStore.setState({ sessionState: 'open' });

  return {
    recorded,
    send: await import('./sendStore'),
    preset: await import('./presetStore'),
    tasks: await import('./tasksStore'),
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('周期任务把内容交给平台执行', () => {
  it('单条循环带着 frames 启动，而不是只给一个闭包', async () => {
    const app = await load();
    app.send.useSendStore.getState().setMode('hex');
    app.send.useSendStore.getState().setPayload('01 02');

    app.send.useSendStore.getState().toggleLoop();

    const started = app.recorded.start.at(-1);
    expect(started?.id).toBe(app.tasks.SINGLE_TASK);
    expect(started?.spec.frames).toEqual([new Uint8Array([0x01, 0x02])]);
  });

  it('单条预设循环同样带 frames', async () => {
    const app = await load();
    const first = app.preset.usePresetStore.getState().presets[0]!;
    app.preset.usePresetStore.getState().setData(first.id, 'AT');

    app.preset.usePresetStore.getState().toggleLoop(first.id);

    const started = app.recorded.start.find((item) => item.id.startsWith('preset:'));
    expect(started?.spec.frames).toEqual([new TextEncoder().encode('AT')]);
  });

  /** 顺序循环没有「一条固定内容」，但整条队列同样可以一次性交出去。 */
  it('顺序循环把整条队列按勾选顺序交出去', async () => {
    const app = await load();
    const store = app.preset.usePresetStore.getState();
    for (const preset of store.presets) store.setInSequence(preset.id, false);

    const [a, b] = app.preset.usePresetStore.getState().presets;
    store.setData(a!.id, 'AAA');
    store.setData(b!.id, 'BBB');
    store.setInSequence(a!.id, true);
    store.setInSequence(b!.id, true);

    app.preset.usePresetStore.getState().toggleSequence();

    const started = app.recorded.start.find((item) => item.id === app.tasks.SEQUENCE_TASK);
    expect(started?.spec.frames).toEqual([
      new TextEncoder().encode('AAA'),
      new TextEncoder().encode('BBB'),
    ]);
  });

  it('循环期间改报文会把新内容推给平台', async () => {
    const app = await load();
    app.send.useSendStore.getState().setMode('hex');
    app.send.useSendStore.getState().setPayload('01');
    app.send.useSendStore.getState().toggleLoop();
    app.recorded.update.length = 0;

    app.send.useSendStore.getState().setPayload('02');

    expect(app.recorded.update.at(-1)).toEqual({
      id: app.tasks.SINGLE_TASK,
      patch: { frames: [new Uint8Array([0x02])] },
    });
  });

  it('循环期间改周期同样推给平台', async () => {
    const app = await load();
    app.send.useSendStore.getState().toggleLoop();
    app.recorded.update.length = 0;

    app.send.useSendStore.getState().setIntervalMs(250);

    expect(app.recorded.update).toContainEqual({
      id: app.tasks.SINGLE_TASK,
      patch: { intervalMs: 250 },
    });
  });

  /**
   * 预设区一有改动就会为全部 50 条各算一次。若不短路，在 VS Code 里
   * 就是每敲一个键往宿主发 50 条消息。
   */
  it('没在跑的任务不会被推送更新', async () => {
    const app = await load();
    const first = app.preset.usePresetStore.getState().presets[0]!;

    app.preset.usePresetStore.getState().setData(first.id, 'AT+X');

    expect(app.recorded.update).toEqual([]);
  });

  it('报文当前解析不通过时以空队列启动，改对了再补进去', async () => {
    const app = await load();
    app.send.useSendStore.getState().setMode('hex');
    app.send.useSendStore.getState().setPayload('ZZ');

    app.send.useSendStore.getState().toggleLoop();
    expect(app.recorded.start.at(-1)?.spec.frames).toEqual([]);

    app.recorded.update.length = 0;
    app.send.useSendStore.getState().setPayload('AB');
    expect(app.recorded.update.at(-1)?.patch.frames).toEqual([new Uint8Array([0xab])]);
  });
});
