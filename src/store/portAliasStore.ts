import { create } from 'zustand';
import type { PortDescriptor } from '@/core/transport/portRegistry';
import { readStoredJson, storageKey, writeStoredJson } from '@/lib/storage';

/**
 * 用户给端口起的备注名。
 *
 * 浏览器不提供真实端口名（COM3 之类），`SerialPortInfo` 只有 VID/PID，
 * 见 WICG/serial#175 —— 该诉求至今未解决。所以「知道这个口接的是哪台设备」
 * 只能由用户自己标注，我们负责把它记住。
 *
 * 备注按 PortDescriptor.identity（即 VID:PID）存储，而不是按会话内的 key：
 * key 是运行时计数器，刷新页面就重新分配，拿它存持久化数据必然错乱。
 */

const STORAGE_KEY = 'portAliases';
/** 太长会把下拉框撑爆，也没人真的需要那么长的备注。 */
export const MAX_ALIAS_LENGTH = 24;

type AliasMap = Record<string, string>;

function sanitize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ALIAS_LENGTH);
}

function loadAliases(): AliasMap {
  const raw = readStoredJson<unknown>(STORAGE_KEY, {});
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const result: AliasMap = {};
  for (const [identity, alias] of Object.entries(raw)) {
    if (typeof alias !== 'string') continue;
    const clean = sanitize(alias);
    if (clean) result[identity] = clean;
  }
  return result;
}

interface PortAliasState {
  aliases: Readonly<AliasMap>;
  /** 传入空串即删除备注。 */
  setAlias: (identity: string, alias: string) => void;
}

export const usePortAliasStore = create<PortAliasState>()((set) => ({
  aliases: loadAliases(),

  setAlias: (identity, alias) =>
    set((state) => {
      const clean = sanitize(alias);
      const next = { ...state.aliases };
      if (clean) next[identity] = clean;
      else delete next[identity];
      writeStoredJson(STORAGE_KEY, next);
      return { aliases: next };
    }),
}));

/**
 * 跨标签页同步。
 *
 * localStorage 是同源全标签页共享的，而备注是整张 map 一次性写入的：
 * 若 A 页改了备注，B 页内存里仍是旧 map，B 页下一次写入就会把整张表覆盖回去，
 * A 页的改动随之丢失。storage 事件只在**其他**标签页写入时触发，
 * 收到即重新载入，让每个标签页的内存副本始终跟得上磁盘。
 *
 * event.key 为 null 表示 localStorage 被整体清空，同样需要重载。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== storageKey(STORAGE_KEY)) return;
    usePortAliasStore.setState({ aliases: loadAliases() });
  });
}

/** 下拉框里显示的完整名称：有备注就把备注放在最前面。 */
export function portDisplayLabel(port: PortDescriptor, aliases: Readonly<AliasMap>): string {
  const alias = aliases[port.identity];
  return alias ? `${alias} · ${port.label}` : port.label;
}

/** 读取某个端口当前的备注，没有则为空串。 */
export function aliasOf(port: PortDescriptor | undefined, aliases: Readonly<AliasMap>): string {
  return port ? (aliases[port.identity] ?? '') : '';
}
