import { useConnectionStore } from '@/store/connectionStore';
import { useLogStore } from '@/store/logStore';
import { useUiStore } from '@/store/uiStore';
import type { HostEvent } from '../shared/protocol';

/**
 * 把宿主推来的状态落到 store 上。
 *
 * 与渲染分开成两个模块是有意的：这是一段纯状态逻辑，绑在 React 入口里就意味着
 * 想验证「快照回放对不对」得先拉起整个界面。分开之后回环测试可以直接用它 ——
 * 测到的是真代码，而不是测试里另抄一遍的赝品。
 */

export function applySnapshot(snapshot: Extract<HostEvent, { type: 'snapshot' }>): void {
  // 面板被隐藏时 webview 会被销毁，重建后界面是空的，而宿主那边端口可能还开着。
  // 快照把状态和历史日志一次性交回来，用户不该看到「怎么全没了」。
  useConnectionStore.setState({
    ports: snapshot.ports,
    portHolders: snapshot.holders,
    selectedPortKey: snapshot.selectedPortKey,
    options: snapshot.options,
    autoReconnect: snapshot.autoReconnect,
    sessionState: snapshot.state,
    openedAt: snapshot.openedAt,
  });

  useLogStore.getState().resetFrames(
    snapshot.frames.map((frame) => ({
      direction: frame.direction,
      bytes: frame.bytes,
      at: frame.at,
    })),
  );

  useUiStore.setState({ language: snapshot.language.startsWith('zh') ? 'zh' : 'en' });
}

/**
 * 宿主要求打开某个端口 —— 活动栏的端口视图点一下就走到这里。
 *
 * 走的是界面本来就有的那条路径（选中会套用该设备的参数存档），
 * 而不是让宿主自己去开：两边各写一份「该设备用什么波特率」必然会长歪。
 */
export function openPort(portKey: string): void {
  const store = useConnectionStore.getState();
  store.selectPort(portKey);
  // 已经连着就别再折腾，用户多半只是想把这个面板切到前面来
  if (store.sessionState === 'closed') void useConnectionStore.getState().toggleConnection();
}
