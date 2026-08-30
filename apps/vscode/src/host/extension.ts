import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { SessionState } from '@/core/session/serialSession';
import type { NodePortInfo } from '@/core/transport/nodePortRegistry';
import type { PortDescriptor } from '@/core/transport/portDescriptor';
import type { ConnectionOptions } from '@/core/transport/types';
import type { SerialToolApi } from '../shared/api';
import type { HostEvent, HostRequest } from '../shared/protocol';
import { NodeSerialTransport, type OpenNodePort } from './nodeSerialTransport';
import { PortLeases } from './portLeases';
import { PortsTreeProvider } from './portsView';
import { handleRequest } from './rpc';
import { PortWatcher } from './portWatcher';
import { SessionHost } from './sessionHost';

/**
 * 扩展入口。
 *
 * 一个面板 = 一条会话 = 一个端口。多面板不需要在协议里编址：每个 WebviewPanel
 * 有自己独立的 postMessage 通道，这里用 Map 把它和 SessionHost 关联起来即可。
 *
 * 全进程共享的只有两样东西，都必须唯一：
 *  - PortLeases：端口占用的权威仲裁者；
 *  - PortWatcher：插拔轮询。桌面端没有 connect/disconnect 事件，只能轮询，
 *    每个面板各跑一个就是 N 倍系统调用。
 */

const VIEW_TYPE = 'serialTool.panel';
const PREFS_KEY = 'serialTool.prefs';

const DEFAULT_OPTIONS: ConnectionOptions = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

/** serialport 的加载结果。原生模块在个别平台/架构上会缺预编译产物。 */
type Binding =
  | {
      ok: true;
      openPort: OpenNodePort;
      list: () => Promise<NodePortInfo[]>;
    }
  | { ok: false; message: string };

let binding: Binding | null = null;

/**
 * 懒加载原生模块。
 *
 * 用动态 import 而不是顶层 import，就是为了能把失败**接住**：
 * `@serialport/bindings-cpp` 缺少对应平台/架构预编译产物是这类扩展最高频的用户投诉，
 * 顶层 import 一旦失败整个扩展都激活不了，用户只会看到一片空白。
 */
async function loadBinding(): Promise<Binding> {
  if (binding) return binding;
  try {
    const module = await import('./serialPortBinding');
    binding = { ok: true, openPort: module.openNodePort, list: module.listNodePorts };
  } catch (error) {
    binding = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return binding;
}

/**
 * 激活。
 *
 * `activationEvents` 是 `onStartupFinished` 而不是留空：留空时 VS Code 要等用户
 * 先执行一次命令才激活，而状态栏项在那之前根本不存在 —— 一个「用来发现这个工具」的
 * 入口，自己却要先被发现一次，这条链是断的。
 *
 * 代价可以接受：这里只建了几个轻量对象和命令注册，原生模块 serialport 要等到
 * 真的去开面板时才会被加载（见 ensureWatcher）。
 */
export function activate(context: vscode.ExtensionContext): SerialToolApi {
  const leases = new PortLeases();
  let watcher: PortWatcher | null = null;
  const panels = new Map<vscode.WebviewPanel, SessionHost>();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'serialTool.showPanels';
  context.subscriptions.push(status);

  /**
   * 状态栏。它同时是**新建面板最主要的入口** —— 一个只能从命令面板打开的工具，
   * 用户装完就找不到了。所以它默认常驻：一个面板都没有时也显示，点一下就新建。
   *
   * 有面板时它顺带聚合「现在有几路串口开着」，这是多面板下最该一眼看到的信息。
   */
  function refreshStatus(): void {
    const visibility = vscode.workspace
      .getConfiguration('serialTool')
      .get<string>('statusBar', 'always');

    if (visibility === 'never' || (visibility === 'whenActive' && panels.size === 0)) {
      status.hide();
      return;
    }

    const hosts = [...panels.values()];
    const open = hosts.filter((host) => host.state === 'open');

    if (panels.size === 0) {
      status.text = '$(plug) 串口';
      status.tooltip = '新建串口面板';
    } else {
      status.text =
        panels.size === 1
          ? `$(plug) ${hosts[0]?.portKey ?? '串口'}`
          : `$(plug) ${open.length}/${panels.size}`;
      status.tooltip = new vscode.MarkdownString(
        [
          ...hosts.map(
            (host) => `- ${host.portKey ?? '（未选端口）'} · ${describeState(host.state)}`,
          ),
          '',
          '_点击可切换面板或新建_',
        ].join('\n'),
      );
    }
    status.show();
  }

  async function ensureWatcher(): Promise<PortWatcher | null> {
    if (watcher) return watcher;
    const loaded = await loadBinding();
    if (!loaded.ok) {
      const open = '打开浏览器版';
      const choice = await vscode.window.showErrorMessage(
        `串口原生模块加载失败：${loaded.message}。当前平台可能缺少 @serialport/bindings-cpp 的预编译产物。`,
        open,
      );
      if (choice === open) {
        await vscode.env.openExternal(
          vscode.Uri.parse('https://samuelyhsu.github.io/web_serial_tool/'),
        );
      }
      return null;
    }
    watcher = new PortWatcher({
      list: loaded.list,
      intervalMs: vscode.workspace
        .getConfiguration('serialTool')
        .get<number>('portPollIntervalMs', 2000),
      onError: (error) => {
        console.error('[serialTool] 枚举串口失败', error);
      },
    });
    return watcher;
  }

  /**
   * 状态栏点击后的去处。
   *
   * 一个面板都没有时直接新建 —— 弹一个只有「新建」一项的选择框是纯粹多余的一步。
   * 已经有面板时列出来，顺带解决多面板下「我刚才那个 COM4 的面板跑哪去了」。
   */
  async function showPanels(): Promise<void> {
    if (panels.size === 0) {
      await createPanel();
      return;
    }

    const items: { label: string; description?: string; panel: vscode.WebviewPanel | null }[] = [
      { label: '$(add) 新建串口面板', panel: null },
      ...[...panels.entries()].map(([panel, host]) => ({
        label: `$(plug) ${host.portKey ?? '（未选端口）'}`,
        description: describeState(host.state),
        panel,
      })),
    ];

    const picked = await vscode.window.showQuickPick(items, { title: '串口面板' });
    if (!picked) return;
    if (picked.panel) picked.panel.reveal();
    else await createPanel();
  }

  async function pickPort(current: PortWatcher): Promise<PortDescriptor | undefined> {
    const ports = await current.refresh();
    if (ports.length === 0) {
      void vscode.window.showWarningMessage('没有找到任何串口设备。');
      return undefined;
    }
    const holders = leases.holders();
    const picked = await vscode.window.showQuickPick(
      ports.map((port) => ({
        label: port.label,
        // 已被别的面板占着的口直接标出来，省得用户选完才发现打不开
        description: holders[port.key] !== undefined ? '已被其他面板占用' : port.identity,
        port,
      })),
      { title: '选择串口', matchOnDescription: true },
    );
    return picked?.port;
  }

  async function createPanel(
    restored?: vscode.WebviewPanel,
    openPortKey?: string,
  ): Promise<vscode.WebviewPanel | undefined> {
    const current = await ensureWatcher();
    if (!current) return undefined;

    const panel =
      restored ??
      vscode.window.createWebviewPanel(VIEW_TYPE, '串口助手', vscode.ViewColumn.Active, {
        enableScripts: true,
        // 不保留隐藏时的上下文：会话本来就活在宿主进程里，面板只是个可重建的视图。
        // 开着 retainContextWhenHidden 只会白白吃内存。
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      });

    const id = `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const host = new SessionHost({
      id,
      leases,
      watcher: current,
      createTransport: (path) =>
        new NodeSerialTransport(path, (p, options) => {
          const loaded = binding;
          if (!loaded?.ok) return Promise.reject(new Error('serial binding is not available'));
          return loaded.openPort(p, options);
        }),
      post: (event: HostEvent) => {
        void panel.webview.postMessage(event);
        // 状态和端口选择都会经过这里，标题与状态栏跟着它们走就够了，
        // 不必再拿一个定时器去轮询「标题该不该变」
        if (event.type === 'state' || event.type === 'selected') {
          refreshStatus();
          retitle();
          ports.refresh();
        }
      },
      pickPort: () => pickPort(current),
      readPrefs: () => context.globalState.get<Record<string, unknown>>(PREFS_KEY, {}),
      writePref: (key, value) => {
        const prefs = context.globalState.get<Record<string, unknown>>(PREFS_KEY, {});
        void context.globalState.update(PREFS_KEY, { ...prefs, [key]: value });
      },
      language: vscode.env.language,
      defaultOptions: DEFAULT_OPTIONS,
    });

    /** 面板标题跟着端口走 —— 多面板时标签页上只剩它能分辨谁是谁。 */
    function retitle(): void {
      const dot = host.state === 'open' ? '● ' : '';
      panel.title = dot + (host.portKey ?? '串口助手');
    }

    panels.set(panel, host);
    refreshStatus();
    retitle();

    panel.webview.html = renderHtml(
      panel.webview,
      context.extensionUri,
      context.globalState.get<Record<string, unknown>>(PREFS_KEY, {}),
    );

    panel.webview.onDidReceiveMessage((message: HostRequest) => {
      if (message.kind !== 'request') return;
      void (async () => {
        const response = await handleRequest(host, message);
        void panel.webview.postMessage(response);

        // 界面报到之后端口列表才就位，此时再让它打开点中的那个口
        if (message.body.method === 'ready') {
          const portKey = pendingOpen.get(panel);
          if (portKey !== undefined) {
            pendingOpen.delete(panel);
            void panel.webview.postMessage({ kind: 'event', type: 'openPort', portKey });
          }
        }
      })();
    });

    // webview 每次被重建（隐藏后再显示、VS Code 重启后恢复）都要重新拿一次快照，
    // 否则用户会看到一个状态全空的界面，而宿主那边端口其实还开着
    panel.onDidChangeViewState(() => {
      if (panel.visible) void panel.webview.postMessage(host.snapshot());
    });

    panel.onDidDispose(() => {
      panels.delete(panel);
      pendingOpen.delete(panel);
      host.dispose();
      refreshStatus();
      ports.refresh();
    });

    // 快照不在这里推：webview 的脚本还没跑起来，postMessage 会丢。
    // 等它报到（ready）时 SessionHost 会自己把快照发过去。
    if (openPortKey !== undefined) {
      pendingOpen.set(panel, openPortKey);
    }
    return panel;
  }

  /**
   * 面板建好后要它打开的端口。
   *
   * 存起来而不是直接 post：此刻 webview 的脚本还没跑起来，消息会丢。
   * 等它报到时再发。
   */
  const pendingOpen = new Map<vscode.WebviewPanel, string>();

  /**
   * 活动栏的端口视图。点一个端口就直接开一个连着它的面板 ——
   * 命令面板 → 新建面板 → 选端口 → 打开，四步压成一步。
   */
  const ports = new PortsTreeProvider({
    leases,
    ensureWatcher,
    holderLabel: (portKey) => {
      const holder = leases.holderOf(portKey);
      if (holder === undefined) return undefined;
      const owner = [...panels.values()].find((host) => host.id === holder);
      return owner?.portKey ?? holder;
    },
  });
  context.subscriptions.push(
    ports,
    vscode.window.registerTreeDataProvider('serialTool.ports', ports),
  );

  /**
   * 点端口的去处。
   *
   * 已经有面板开着这个口就切过去 —— 用户多半是想看它，而不是再开一个必然会被拒的面板。
   * 否则复用一个「开着但还没选端口」的空面板，实在没有才新建：
   * 点两个不同的端口本来就该得到两个面板，但不该在旁边留一堆空壳。
   */
  /**
   * 让一个**已存在**的面板去打开某个端口。
   *
   * 面板可能正被隐藏着：`retainContextWhenHidden` 是关的，此时 webview 连同脚本
   * 已经被销毁，而 `reveal()` 触发的重新载入是异步的 —— 紧接着 postMessage 会直接丢，
   * 用户点了端口却什么都不会发生。所以隐藏的面板走 pendingOpen，等它报到时补发，
   * 与新建面板那条路径共用同一套机制。
   */
  function requestOpen(panel: vscode.WebviewPanel, portKey: string): void {
    const live = panel.visible;
    panel.reveal();
    if (live) {
      void panel.webview.postMessage({ kind: 'event', type: 'openPort', portKey });
    } else {
      pendingOpen.set(panel, portKey);
    }
  }

  async function openPortIn(port: PortDescriptor, forceNew: boolean): Promise<void> {
    if (!forceNew) {
      const existing = [...panels.entries()].find(([, host]) => host.portKey === port.key);
      if (existing) {
        existing[0].reveal();
        return;
      }
      const idle = [...panels.entries()].find(
        ([, host]) => host.portKey === null && host.state === 'closed',
      );
      if (idle) {
        requestOpen(idle[0], port.key);
        return;
      }
    }
    await createPanel(undefined, port.key);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('serialTool.newPanel', () => createPanel()),
    vscode.commands.registerCommand('serialTool.refreshPorts', () => ports.reload()),
    vscode.commands.registerCommand('serialTool.openPort', (port: PortDescriptor) =>
      openPortIn(port, false),
    ),
    vscode.commands.registerCommand('serialTool.openPortInNewPanel', (port: PortDescriptor) =>
      openPortIn(port, true),
    ),
    vscode.commands.registerCommand('serialTool.showPanels', () => showPanels()),
    // 状态栏显隐是可配的，改完要立刻生效，而不是等下次重启
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('serialTool.statusBar')) refreshStatus();
    }),
    vscode.commands.registerCommand('serialTool.toggleConnection', async () => {
      const active = [...panels.entries()].find(([panel]) => panel.active);
      if (!active) {
        void vscode.window.showInformationMessage('没有处于活动状态的串口面板。');
        return;
      }
      // 参数不在这里拼：这条路径手里只有默认值，而面板自己知道用户调过什么
      const [, host] = active;
      if ((await host.toggle()) === 'no-port') {
        void vscode.window.showInformationMessage('请先在面板里选择一个串口。');
      }
      refreshStatus();
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      // VS Code 重启后恢复面板。会话不会跟着恢复（进程都换了），
      // 但端口选择与偏好都在 globalState 里，用户点一下就能接着用。
      deserializeWebviewPanel: async (panel) => {
        await createPanel(panel);
      },
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      for (const host of panels.values()) host.dispose();
      panels.clear();
      watcher?.stop();
    },
  });

  return {
    panels: () =>
      [...panels.values()].map((host) => ({ portKey: host.portKey, state: host.state })),

    listPorts: async () => {
      const current = await ensureWatcher();
      return current ? await current.refresh() : [];
    },

    openPort: async (portKey, apiOptions) => {
      const current = await ensureWatcher();
      const port = current?.current().find((item) => item.key === portKey);
      if (!port) throw new Error(`没有找到端口 ${portKey}`);
      await openPortIn(port, apiOptions?.newPanel === true);
    },

    closeAll: async () => {
      for (const [panel] of [...panels.entries()]) panel.dispose();
      // onDidDispose 是同步触发的，让出一拍等它跑完即可
      await Promise.resolve();
    },
  };
}

function describeState(state: SessionState): string {
  switch (state) {
    case 'open':
      return '已连接';
    case 'opening':
      return '连接中';
    case 'reconnecting':
      return '重连中';
    case 'closed':
      return '未连接';
  }
}

export function deactivate(): void {
  // 面板的清理挂在 context.subscriptions 上，这里不需要再做什么
}

/**
 * 偏好要**同步**地交给 webview。
 *
 * 界面在模块初始化时就会读设置（视图模式、波特率、预设…），等不到一条 postMessage。
 * 所以把它直接烙进 HTML：webview 的 localStorage 靠不住（origin 里带着一个每次重建
 * 都会变的 uuid），真正的存放地是扩展宿主的 globalState。
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * webview 的宿主页面。
 *
 * CSP 是必须的：`default-src 'none'` 之外只放行带 nonce 的脚本和扩展自己的资源。
 * 因此这里不能像 Web 版那样引 Google Fonts —— 串口工具常跑在内网机器上，
 * 那条 CDN 依赖在浏览器版里就已经是「渐进增强」的，在这里干脆去掉。
 */
function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  prefs: Record<string, unknown>,
): string {
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'));
  // nonce 的全部作用就是让注入进来的 <script> 猜不中它。串口日志、设备名本来就是
  // 不可信输入，这里不该用 Math.random() —— 宿主是 Node，密码学随机源是现成的。
  const nonce = randomBytes(16).toString('base64');

  return `<!doctype html>
<html lang="${vscode.env.language.startsWith('zh') ? 'zh-CN' : 'en'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
    <link rel="stylesheet" href="${style.toString()}" />
    <title>串口助手</title>
  </head>
  <body>
    <div id="root" data-prefs="${escapeAttribute(JSON.stringify(prefs))}"></div>
    <script nonce="${nonce}" src="${script.toString()}"></script>
  </body>
</html>`;
}
