/**
 * `vscode` 模块的测试替身。
 *
 * 真实的 vscode 模块只有装进编辑器才存在，`npm install` 装不到它。宿主侧凡是碰到
 * VS Code API 的代码因此天然没法用单元测试覆盖 —— 除非把这层薄薄的门面替掉。
 *
 * 只实现被测代码真正用到的那部分：多写的每一行都是没人验证过的假设。
 */

export class EventEmitter<T> {
  readonly #listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): { dispose: () => void } => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  constructor(readonly value = '') {}
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: MarkdownString | string;
  iconPath?: ThemeIcon;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };

  constructor(
    readonly label: string,
    readonly collapsibleState: number = TreeItemCollapsibleState.None,
  ) {}
}
