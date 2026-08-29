/**
 * 跨页面的端口占用登记 —— 支持「同时开多个页面，各连一个端口」。
 *
 * 一个串口同一时刻只能被一个使用者打开。单页面时这不构成问题，多页面之后必须回答
 * 「这个口是不是已经被我自己的另一个页面占着」：直接去 `open()` 撞一鼻子灰，用户
 * 只会看到一句语焉不详的 `Failed to open serial port`，根本不知道该去哪关。
 *
 * 实现是**尽力而为**的，不是分布式锁：
 *  - 浏览器里没有跨标签页的权威仲裁者，BroadcastChannel 只能广播「我占了谁」；
 *  - 真正的兜底始终是 `open()` 本身会失败 —— 外部程序（PuTTY、Arduino IDE）占用的口，
 *    这里永远看不见。所以这套机制的定位是「把能说清的情况说清」，而不是保证互斥。
 *
 * 陈旧条目（页面崩溃、进程被杀，来不及发 release）靠 refresh() 消解：重新广播一次
 * 询问，只有还活着的页面会应答，据此整表重建。
 */

/** identity（跨会话稳定的设备标识）→ 占用者的不透明 id。 */
export type LeaseHolders = Readonly<Record<string, string>>;

type LeaseMessage =
  | { type: 'claim'; tabId: string; identity: string }
  | { type: 'release'; tabId: string }
  | { type: 'query'; tabId: string };

/** 应答收集窗口。只需覆盖同机另一个标签页的一次消息往返，不必更长。 */
const REFRESH_WINDOW_MS = 300;

const CHANNEL_NAME = 'wst.portLeases';

export interface PortLeases {
  /** 当前已知的占用情况，不含自己。 */
  holders: () => LeaseHolders;
  /** 声明本页面占用了某个设备。 */
  claim: (identity: string) => void;
  /** 释放本页面的占用。未占用时调用是安全的。 */
  release: () => void;
  /** 重新询问一轮，据应答重建占用表，顺便清掉陈旧条目。 */
  refresh: () => void;
  subscribe: (listener: (holders: LeaseHolders) => void) => () => void;
  dispose: () => void;
}

function noop(): PortLeases {
  return {
    holders: () => ({}),
    claim: () => undefined,
    release: () => undefined,
    refresh: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };
}

export function createPortLeases(channelName = CHANNEL_NAME): PortLeases {
  // BroadcastChannel 在旧 WebView 和部分测试环境里没有。占用提示是锦上添花，
  // 拿不到就退化成「什么都不知道」，功能不受影响。
  if (typeof BroadcastChannel === 'undefined') return noop();

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(channelName);
  } catch {
    // 同上：构造失败（某些隐私模式）时静默降级
    return noop();
  }

  const tabId = Math.random().toString(36).slice(2, 10);
  let owned: string | null = null;
  let holders: Record<string, string> = {};
  /** refresh() 期间的收集表；非 null 即表示正在收集。 */
  let collecting: Record<string, string> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(holders: LeaseHolders) => void>();

  const emit = (): void => {
    for (const listener of listeners) listener(holders);
  };

  const post = (message: LeaseMessage): void => {
    try {
      channel.postMessage(message);
    } catch {
      // 通道已关闭（页面正在卸载）：这条广播丢了不影响正确性，接收方靠 refresh 自愈
    }
  };

  const record = (identity: string, holder: string): void => {
    holders = { ...holders, [identity]: holder };
    if (collecting !== null) collecting[identity] = holder;
  };

  channel.onmessage = (event: MessageEvent<LeaseMessage>) => {
    const message = event.data;
    if (message.tabId === tabId) return; // 自己的广播不算占用

    switch (message.type) {
      case 'claim':
        record(message.identity, message.tabId);
        emit();
        break;
      case 'release': {
        const next = Object.fromEntries(
          Object.entries(holders).filter(([, holder]) => holder !== message.tabId),
        );
        holders = next;
        if (collecting !== null) {
          for (const [identity, holder] of Object.entries(collecting)) {
            if (holder === message.tabId) delete collecting[identity];
          }
        }
        emit();
        break;
      }
      case 'query':
        // 别人在重建占用表：还占着就应一声，这样陈旧条目会被自然淘汰
        if (owned !== null) post({ type: 'claim', tabId, identity: owned });
        break;
    }
  };

  const refresh = (): void => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    collecting = {};
    post({ type: 'query', tabId });
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      holders = collecting ?? {};
      collecting = null;
      emit();
    }, REFRESH_WINDOW_MS);
  };

  const release = (): void => {
    if (owned === null) return;
    owned = null;
    post({ type: 'release', tabId });
  };

  // 页面关闭前必须放手，否则别的页面会以为这个口还被占着。
  // pagehide 比 beforeunload 可靠（与 persist.ts 中同样的理由）。
  const onPageHide = (): void => {
    release();
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

  return {
    holders: () => holders,

    claim: (identity) => {
      owned = identity;
      post({ type: 'claim', tabId, identity });
    },

    release,
    refresh,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose: () => {
      release();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      listeners.clear();
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      try {
        channel.close();
      } catch {
        // 已经关过了；重复关闭没有副作用
      }
    },
  };
}
