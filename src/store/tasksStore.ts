import { create } from 'zustand';
import { platform, type TaskPatch, type TaskSpec } from './platform';

/**
 * 周期发送任务的唯一真相源。
 *
 * 原型在多处各存一份布尔标志（`state.singleLoop`、每条预设的 `p.loop`、`state.seqRunning`），
 * 再手工和 `this.timers` 里的定时器保持同步 —— 任何一条路径漏改就会出现「按钮显示在跑、
 * 实际已经停了」。这里让调度器持有事实，UI 只读 `running` 列表，不可能不同步。
 *
 * 调度器本身归运行环境所有（见 platform.ts）：浏览器里就在本页面，
 * VS Code 里跑在扩展宿主进程 —— 面板隐藏时 webview 连同定时器一起被销毁，
 * 而「挂个心跳跑一下午」正是这类工具最常见的用法。
 */
const tasks = platform().tasks;

export const SINGLE_TASK = 'single';
export const SEQUENCE_TASK = 'sequence';
export const presetTask = (id: string): string => `preset:${id}`;

interface TasksState {
  running: readonly string[];
  start: (id: string, spec: TaskSpec) => void;
  stop: (id: string) => void;
  stopAll: () => void;
  /** 改运行中任务的周期或内容。任务没在跑时是空操作。 */
  update: (id: string, patch: TaskPatch) => void;
}

export const useTasksStore = create<TasksState>()((set) => {
  // 运行集合由调度器持有，store 只是它的镜子
  tasks.subscribe((running) => set({ running }));

  return {
    running: tasks.runningIds(),
    start: (id, spec) => tasks.start(id, spec),
    stop: (id) => tasks.stop(id),
    stopAll: () => tasks.stopAll(),
    update: (id, patch) => {
      // 没在跑的任务直接短路。这不只是省事：预设区一有改动就会为全部 50 条各调一次，
      // 在 VS Code 里那是每敲一个键就往宿主发 50 条消息
      if (!tasks.runningIds().includes(id)) return;
      tasks.update(id, patch);
    },
  };
});

export function isTaskRunning(running: readonly string[], id: string): boolean {
  return running.includes(id);
}
