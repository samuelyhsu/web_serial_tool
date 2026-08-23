import { create } from 'zustand';
import { TaskScheduler, type PeriodicTaskSpec } from '@/core/scheduler/taskScheduler';

/**
 * 周期发送任务的唯一真相源。
 *
 * 原型在多处各存一份布尔标志（`state.singleLoop`、每条预设的 `p.loop`、`state.seqRunning`），
 * 再手工和 `this.timers` 里的定时器保持同步 —— 任何一条路径漏改就会出现「按钮显示在跑、
 * 实际已经停了」。这里让调度器持有事实，UI 只读 `running` 列表，不可能不同步。
 */
const scheduler = new TaskScheduler();

export const SINGLE_TASK = 'single';
export const SEQUENCE_TASK = 'sequence';
export const presetTask = (id: string): string => `preset:${id}`;

interface TasksState {
  running: readonly string[];
  start: (id: string, spec: PeriodicTaskSpec) => void;
  stop: (id: string) => void;
  stopAll: () => void;
  updateInterval: (id: string, intervalMs: number) => void;
}

export const useTasksStore = create<TasksState>()((set) => {
  const sync = (): void => set({ running: scheduler.runningIds() });

  return {
    running: [],

    start: (id, spec) => {
      scheduler.start(id, spec);
      sync();
    },

    stop: (id) => {
      scheduler.stop(id);
      sync();
    },

    stopAll: () => {
      scheduler.stopAll();
      sync();
    },

    updateInterval: (id, intervalMs) => scheduler.updateInterval(id, intervalMs),
  };
});

export function isTaskRunning(running: readonly string[], id: string): boolean {
  return running.includes(id);
}
