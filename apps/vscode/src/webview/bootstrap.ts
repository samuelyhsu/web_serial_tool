import { setPlatform } from '@/store/platform';
import { installPrefStore } from './prefStore';
import type { HostEvent } from '../shared/protocol';
import { createVsCodePlatform, type VsCodeApi } from './vscodePlatform';

/**
 * 运行环境的安装。
 *
 * **这个模块必须先于任何 store 被求值** —— store 在模块初始化时就会向 platform()
 * 要会话与调度器。保证靠的是 ESM 的求值顺序：main.tsx 把 `import './bootstrap'`
 * 写在第一行，规范要求依赖按 import 出现的顺序深度优先求值，打包器也必须保持这个顺序。
 *
 * 曾经用「先 setPlatform，再动态 import 界面」来表达同一件事，那是错的：
 * Rollup 的 inlineDynamicImports 会把被动态 import 的模块内联进同一个 chunk，
 * 顶层代码照样提前跑，顺序保证就没了。静态 import 才是这里唯一可靠的表达方式。
 */

declare function acquireVsCodeApi(): VsCodeApi;

export type Snapshot = Extract<HostEvent, { type: 'snapshot' }>;
export type Selected = Extract<HostEvent, { type: 'selected' }>;

/**
 * 快照的去处。界面挂载之前到达的快照先攒着 —— 宿主是建好面板就立刻发一条的，
 * 那时 React 还没渲染。
 */
export const snapshotSink: {
  apply: ((snapshot: Snapshot) => void) | null;
  buffered: Snapshot[];
  /** 打开端口的请求同样可能早于界面挂载（点端口视图会顺带新建面板）。 */
  openPort: ((portKey: string) => void) | null;
  pendingOpen: string | null;
  /** 宿主改了选中端口/参数。同样可能早于挂载，攒最后一条即可（后到的本就覆盖先到的）。 */
  selected: ((event: Selected) => void) | null;
  pendingSelected: Selected | null;
} = {
  apply: null,
  buffered: [],
  openPort: null,
  pendingOpen: null,
  selected: null,
  pendingSelected: null,
};

const platformImpl = createVsCodePlatform({
  api: acquireVsCodeApi(),
  onSnapshot: (snapshot) => {
    if (snapshotSink.apply) snapshotSink.apply(snapshot);
    else snapshotSink.buffered.push(snapshot);
  },
  onOpenPort: (portKey) => {
    if (snapshotSink.openPort) snapshotSink.openPort(portKey);
    else snapshotSink.pendingOpen = portKey;
  },
  onSelected: (event) => {
    if (snapshotSink.selected) snapshotSink.selected(event);
    else snapshotSink.pendingSelected = event;
  },
});

// 偏好后端必须先装：下面 setPlatform 之后紧接着被求值的就是各个 store，
// 它们在模块初始化时就要读设置
installPrefStore(platformImpl.writePref);
setPlatform(platformImpl);

/**
 * 把界面接到运行环境上：交出快照的去处，并补发挂载之前攒下的那些。
 *
 * 单独成函数是为了让回环测试能用**同一段接线**，而不是在测试里另抄一遍 ——
 * 抄出来的那份和真代码一起腐化时，测试是绿的，应用是坏的。
 */
export function attachView(view: {
  applySnapshot: (snapshot: Snapshot) => void;
  applySelected: (event: Selected) => void;
  openPort: (portKey: string) => void;
}): void {
  snapshotSink.apply = view.applySnapshot;
  snapshotSink.selected = view.applySelected;
  snapshotSink.openPort = view.openPort;

  for (const snapshot of snapshotSink.buffered.splice(0)) view.applySnapshot(snapshot);

  // 排在快照之后：快照里也带着选中端口，晚到的这条才是更新的
  if (snapshotSink.pendingSelected !== null) {
    const event = snapshotSink.pendingSelected;
    snapshotSink.pendingSelected = null;
    view.applySelected(event);
  }

  // 「打开这个端口」必须排在快照之后：端口列表要先就位，selectPort 才找得到那个 key
  if (snapshotSink.pendingOpen !== null) {
    const portKey = snapshotSink.pendingOpen;
    snapshotSink.pendingOpen = null;
    view.openPort(portKey);
  }
}
