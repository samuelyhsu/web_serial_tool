import { TaskScheduler } from '@/core/scheduler/taskScheduler';
import { SerialSession } from '@/core/session/serialSession';
import { TransportError } from '@/core/transport/errors';
import type { PortDescriptor } from '@/core/transport/portDescriptor';
import { describePorts, portKey } from '@/core/transport/portRegistry';
import type { ConnectionOptions } from '@/core/transport/types';
import { isWebSerialSupported, WebSerialTransport } from '@/core/transport/webSerialTransport';
import { createPortLeases } from '@/lib/portLease';
import type { Platform, SessionLike, TasksLike } from './platform';

/**
 * 浏览器运行环境。
 *
 * 这里集中了整个应用对 `navigator.serial` 的全部依赖 —— 之前它们散在
 * connectionStore 里，把 store 钉死在了浏览器上。搬出来之后 store 只认 Platform 接口，
 * 同一套界面才能既跑在网页里、又跑在 VS Code 的 webview 里。
 */

function createSession(): SessionLike {
  let describe: (options: ConnectionOptions) => string = () => '';

  const session = new SerialSession<SerialPort>({
    createTransport: (port) => new WebSerialTransport(port),
    // 重连时按稳定 key 重新解析端口对象（缺陷 D1）
    resolvePort: async (key) => {
      if (!isWebSerialSupported()) return undefined;
      const ports = await navigator.serial.getPorts();
      return ports.find((port) => portKey(port) === key);
    },
    describeConfig: (options) => describe(options),
  });

  return {
    setHandlers: (handlers) => session.setHandlers(handlers),
    setConfigDescriber: (next) => {
      describe = next;
    },
    open: async (key, options) => {
      const ports = await navigator.serial.getPorts();
      const port = ports.find((item) => portKey(item) === key);
      // 端口已经不在授权列表里（拔掉了、或撤销了授权）：这不是「打开失败」，
      // 而是「这台设备现在不存在」，交给 store 去刷新列表
      if (!port) throw new TransportError('invalid-state', `Port ${key} is no longer available`);
      await session.open(port, key, options);
    },
    close: () => session.close(),
    send: (bytes) => session.send(bytes),
    setFraming: (config) => session.setFraming(config),
    setReconnectSettings: (settings) => session.setReconnectSettings(settings),
    get pendingBytes() {
      return session.pendingBytes;
    },
    dispose: () => {
      void session.dispose();
    },
  };
}

function createTasks(): TasksLike {
  const scheduler = new TaskScheduler();
  const listeners = new Set<(running: string[]) => void>();
  const emit = (): void => {
    const running = scheduler.runningIds();
    for (const listener of listeners) listener(running);
  };

  return {
    start: (id, spec) => {
      scheduler.start(id, spec);
      emit();
    },
    stop: (id) => {
      scheduler.stop(id);
      emit();
    },
    stopAll: () => {
      scheduler.stopAll();
      emit();
    },
    update: (id, patch) => {
      if (patch.intervalMs !== undefined) scheduler.updateInterval(id, patch.intervalMs);
      // frames 在浏览器里用不上：执行体每一拍都重读最新状态，内容改动本来就即时生效
    },
    runningIds: () => scheduler.runningIds(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createWebPlatform(): Platform {
  const supported = isWebSerialSupported();

  return {
    kind: 'web',
    supported,
    session: createSession(),
    tasks: createTasks(),
    leases: createPortLeases(),

    listPorts: async () => {
      if (!supported) return [];
      return describePorts(await navigator.serial.getPorts());
    },

    requestPort: async (): Promise<PortDescriptor> => {
      if (!supported) throw new TransportError('unsupported', 'Web Serial is not available');
      const port = await navigator.serial.requestPort();
      const key = portKey(port);
      const ports = describePorts(await navigator.serial.getPorts());
      // 刚授权的端口理应出现在列表里；万一没有，也要把它描述出来交回去
      return ports.find((item) => item.key === key) ?? describePorts([port])[0]!;
    },

    watchPorts: (onChange) => {
      if (!supported) return () => undefined;
      navigator.serial.addEventListener('connect', onChange);
      navigator.serial.addEventListener('disconnect', onChange);
      return () => {
        navigator.serial.removeEventListener('connect', onChange);
        navigator.serial.removeEventListener('disconnect', onChange);
      };
    },
  };
}
