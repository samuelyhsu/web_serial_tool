import * as vscode from 'vscode';
import type { PortDescriptor } from '@/core/transport/portDescriptor';
import type { PortLeases } from './portLeases';
import type { PortWatcher } from './portWatcher';

/**
 * 活动栏里的端口列表。
 *
 * 它存在的理由是「少点几下」：命令面板 → 新建面板 → 选端口 → 打开，四步；
 * 在这里点一下端口就全做完了 —— 而且这才是设备类工具该有的形态，
 * 左边一个图标点开就知道机器上现在插着什么。
 *
 * 端口枚举是**惰性**的：只有视图真的被展开时才会去加载原生模块、开始轮询。
 * 用户打开这个视图本身就是「我要用串口」的意思，而没打开它的人不该为此付出启动开销。
 */

export interface PortsViewDeps {
  leases: PortLeases;
  /** 惰性拿到轮询器。原生模块加载失败时返回 null。 */
  ensureWatcher: () => Promise<PortWatcher | null>;
  /** 某个端口当前是被哪个面板占着；没有则 undefined。 */
  holderLabel: (portKey: string) => string | undefined;
}

export class PortsTreeProvider implements vscode.TreeDataProvider<PortDescriptor> {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;

  #watcher: PortWatcher | null = null;
  #unsubscribe: (() => void) | null = null;
  #failed = false;

  constructor(private readonly deps: PortsViewDeps) {
    // 占用情况变了（别的面板开了/关了口），列表上的标注要跟着变
    this.#unsubscribe = deps.leases.subscribe(() => this.refresh());
  }

  refresh(): void {
    this.#changed.fire();
  }

  /** 手动刷新：立刻重新枚举一次，不必等下一次轮询。 */
  async reload(): Promise<void> {
    const watcher = await this.#ensure();
    await watcher?.refresh();
    this.refresh();
  }

  async getChildren(element?: PortDescriptor): Promise<PortDescriptor[]> {
    // 端口是平铺的，没有下一层
    if (element) return [];
    const watcher = await this.#ensure();
    if (!watcher) return [];
    return [...(await watcher.refresh())];
  }

  getTreeItem(port: PortDescriptor): vscode.TreeItem {
    const item = new vscode.TreeItem(port.label, vscode.TreeItemCollapsibleState.None);
    const holder = this.deps.holderLabel(port.key);

    item.id = port.key;
    item.description = holder !== undefined ? '已连接' : port.identity;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${port.label}**`,
        '',
        `- 设备标识：\`${port.identity}\``,
        port.chip ? `- 芯片：${port.chip}` : null,
        port.vendor ? `- 厂商：${port.vendor}` : null,
        holder !== undefined ? `- 正被面板「${holder}」使用` : null,
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );

    // 已经连着的口给一个醒目的颜色：多端口时一眼看出哪几个在用
    item.iconPath = new vscode.ThemeIcon(
      'plug',
      holder !== undefined ? new vscode.ThemeColor('charts.green') : undefined,
    );
    // 右键菜单靠它区分「已连接 / 空闲」
    item.contextValue = holder !== undefined ? 'port.busy' : 'port';

    item.command = {
      command: 'serialTool.openPort',
      title: '打开',
      arguments: [port],
    };
    return item;
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#changed.dispose();
  }

  async #ensure(): Promise<PortWatcher | null> {
    if (this.#watcher || this.#failed) return this.#watcher;
    const watcher = await this.deps.ensureWatcher();
    if (!watcher) {
      // 原生模块加载失败已经弹过提示了，不必每次展开视图再弹一遍
      this.#failed = true;
      return null;
    }
    this.#watcher = watcher;
    // 插拔后列表要自己更新，用户不该需要手动点刷新
    watcher.subscribe(() => this.refresh());
    return watcher;
  }
}
