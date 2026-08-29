import { TaskScheduler } from '@/core/scheduler/taskScheduler';
import type { SessionEvents } from '@/core/session/serialSession';
import type { PortDescriptor } from '@/core/transport/portDescriptor';
import type { LeaseHolders } from '@/lib/portLease';
import type { Platform, SessionLike, TasksLike } from '@/store/platform';
import type { HostMessage, HostRequest } from '../shared/protocol';
import { SessionClient } from './sessionClient';

/**
 * VS Code webview 运行环境。
 *
 * 与浏览器实现最大的不同：**会话不在这里**。它活在扩展宿主进程里，
 * 因为面板一旦被隐藏，webview 连同它的一切都会被销毁。这边只负责把界面的动作
 * 翻成 RPC，再把宿主推来的事件翻回 store 认识的形状。
 */

export interface VsCodeApi {
  postMessage: (message: unknown) => void;
  getState: <T>() => T | undefined;
  setState: <T>(state: T) => T;
}

export interface VsCodePlatformDeps {
  api: VsCodeApi;
  /** 收到宿主快照时的回调，由入口用来回放历史日志、恢复选中端口。 */
  onSnapshot: (snapshot: Extract<HostMessage, { type: 'snapshot' }>) => void;
  /** 宿主要求打开某个端口（活动栏的端口视图点了一下）。 */
  onOpenPort: (portKey: string) => void;
}

/** 除了 Platform 本身，还要把「写偏好」交出去 —— 偏好后端要用它（见 prefStore.ts）。 */
export type VsCodePlatform = Platform & {
  writePref: (key: string, value: unknown) => void;
};

export function createVsCodePlatform(deps: VsCodePlatformDeps): VsCodePlatform {
  const client = new SessionClient((message: HostRequest) => deps.api.postMessage(message));

  let handlers: Partial<SessionEvents> = {};
  let ports: PortDescriptor[] = [];
  let holders: LeaseHolders = {};
  let onPortsChange: (() => void) | null = null;
  const leaseListeners = new Set<(holders: LeaseHolders) => void>();

  /**
   * 兜底用的本地调度器：万一有任务没带 frames（说明调用点漏了），
   * 它至少还能在面板可见时跑起来，而不是静默什么都不发生。
   * 正常路径上所有任务都带 frames，由宿主执行。
   */
  const localScheduler = new TaskScheduler();
  let running: string[] = [];
  const taskListeners = new Set<(running: string[]) => void>();

  const emitTasks = (hostRunning?: string[]): void => {
    const merged = [...new Set([...(hostRunning ?? running), ...localScheduler.runningIds()])];
    running = merged;
    for (const listener of taskListeners) listener(merged);
  };

  const emitPorts = (): void => {
    onPortsChange?.();
    for (const listener of leaseListeners) listener(holders);
  };

  client.setHandlers({
    onSnapshot: (event) => {
      ports = event.ports;
      holders = event.holders;
      emitPorts();
      emitTasks(event.runningTasks);
      deps.onSnapshot(event);
    },
    onPorts: (event) => {
      ports = event.ports;
      holders = event.holders;
      emitPorts();
    },
    onFrames: (event) => {
      for (const frame of event.items) handlers.onFrame?.(frame.direction, frame.bytes);
    },
    onThroughput: (event) => handlers.onThroughput?.(event.direction, event.byteCount),
    onNotice: (event) => handlers.onNotice?.(event.notice),
    onState: (event) => handlers.onStateChange?.(event.state),
    onTasks: (event) => emitTasks(event.running),
    onOpenPort: (event) => deps.onOpenPort(event.portKey),
  });

  window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    client.receive(event.data);
  });

  const session: SessionLike = {
    setHandlers: (next) => {
      handlers = next;
    },
    // 配置摘要由宿主自己拼（它才知道设备路径），这边不需要
    setConfigDescriber: () => undefined,
    open: (portKey, options) => client.open(portKey, options),
    close: () => client.close(),
    send: (bytes) => client.send(bytes),
    setFraming: (config) => client.setFraming(config),
    setReconnectSettings: (settings) => client.setReconnectSettings(settings),
    // 背压是宿主那边的事；界面上的「积压字节」在 VS Code 里暂时恒为 0
    pendingBytes: 0,
    dispose: () => {
      void client.stopAllTasks().catch(() => undefined);
    },
  };

  const tasks: TasksLike = {
    start: (id, spec) => {
      if (spec.frames !== undefined) {
        // 交给宿主：面板被隐藏、甚至切到别的编辑器组，它都照跑
        void client.startTask(id, spec.frames, spec.intervalMs).catch(() => undefined);
      } else {
        localScheduler.start(id, spec);
        emitTasks();
      }
    },
    stop: (id) => {
      localScheduler.stop(id);
      void client.stopTask(id).catch(() => undefined);
      emitTasks();
    },
    stopAll: () => {
      localScheduler.stopAll();
      void client.stopAllTasks().catch(() => undefined);
      emitTasks([]);
    },
    update: (id, patch) => {
      if (patch.intervalMs !== undefined) localScheduler.updateInterval(id, patch.intervalMs);
      // 宿主那边也要跟上，否则循环期间改周期 / 改报文对已经跑起来的任务无效
      void client.updateTask(id, patch).catch(() => undefined);
    },
    runningIds: () => running,
    subscribe: (listener) => {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    },
  };

  // 报到。必须在这里而不是等界面挂载：面板隐藏后重建时，用户可能一眼就看到
  // 一个空界面，越早把快照要回来越好
  void client.ready().catch(() => undefined);

  return {
    kind: 'vscode',
    writePref: (key, value) => client.writePref(key, value),
    // 宿主进程加载不了原生模块时面板根本不会被创建，所以走到这里就是可用的
    supported: true,
    session,
    tasks,

    leases: {
      holders: () => holders,
      // 占用由宿主在 open/close 时权威登记，这边不需要也不应该自己记账
      claim: () => undefined,
      release: () => undefined,
      refresh: () => {
        void client.refreshPorts().catch(() => undefined);
      },
      subscribe: (listener) => {
        leaseListeners.add(listener);
        return () => leaseListeners.delete(listener);
      },
      dispose: () => leaseListeners.clear(),
    },

    listPorts: async () => {
      await client.refreshPorts().catch(() => undefined);
      return ports;
    },

    requestPort: async () => {
      const picked = (await client.pickPort()) as PortDescriptor | null;
      if (!picked) {
        // 与 Web Serial 的 requestPort() 对齐：用户取消时抛 NotFoundError，
        // UI 侧（PortPicker）因此不必分运行环境处理
        throw new DOMException('Port selection was dismissed', 'NotFoundError');
      }
      return picked;
    },

    watchPorts: (onChange) => {
      onPortsChange = onChange;
      return () => {
        onPortsChange = null;
      };
    },
  };
}
