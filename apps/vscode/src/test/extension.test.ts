import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { SerialToolApi } from '../shared/api';

/**
 * 装进真实 VS Code 里跑的集成测试。
 *
 * 它专攻单元测试与回环测试都够不着的那一段：**扩展装进去之后好不好使**。
 * 这次已经因此栽过两次，两次都是「代码全对、装进去不好使」：
 *  - activationEvents 留空 → 状态栏在用户首次执行命令前根本不存在，
 *    而它正是用来发现这个工具的入口，这条链是断的；
 *  - 状态栏在没有面板时被 hide() → 恰恰在最需要它的时候看不见。
 *
 * 这类问题在 jsdom 里永远测不出来，因为它们根本不是代码的问题，是**清单和时机**的问题。
 */

const EXTENSION_ID = 'samuelyhsu.web-serial-tool-vscode';

function extension(): vscode.Extension<SerialToolApi> {
  // 带上类型参数：不带的话拿到的是 Extension<any>，activate() 返回的 API
  // 从这里开始就不再受类型检查 —— 而它正是这份测试的观察窗口
  const found = vscode.extensions.getExtension<SerialToolApi>(EXTENSION_ID);
  assert.ok(found, `没找到扩展 ${EXTENSION_ID}`);
  return found;
}

/** 等一个条件成立，或超时。VS Code 里很多状态是异步落地的。 */
async function waitFor(what: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`等待超时：${what}`);
}

/**
 * 需要**真实可用**串口的用例，从这里取端口，取不到就跳过。
 *
 * 不能靠「列表非空」来判断有没有可用的口，这是踩过的坑：GitHub 的 Linux runner 上
 * `SerialPort.list()` 会列出一堆 `/dev/ttyS*` 传统 8250 串口 —— 枚举得到、却连不上，
 * 于是所有用例卡在「等端口连上」直到超时，CI 整片红。
 *
 * 开发机上是另一种坏：自动挑列表里的第一个口，可能正好抢走你正在调的设备。
 * 所以和真实串口回环测试（SERIAL_LOOPBACK_PORTS）一样，必须靠环境变量显式开启：
 *
 *   SERIAL_INTEGRATION_PORTS=COM3,COM4 npm run test:vscode
 *
 * 只给一个口时，需要两个口的那条用例会自己跳过。
 */
function hardwarePorts(): string[] {
  return (process.env.SERIAL_INTEGRATION_PORTS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

let api: SerialToolApi;

/** 连着某个口的那个面板处于什么状态。 */
function panelState(portKey: string): string | undefined {
  return api.panels().find((panel) => panel.portKey === portKey)?.state;
}

suite('扩展装进 VS Code 之后', () => {
  suiteSetup(async () => {
    api = await extension().activate();
  });

  teardown(async () => {
    await api.closeAll();
  });

  test('能被激活', () => {
    assert.equal(extension().isActive, true);
  });

  /**
   * activationEvents 必须是 onStartupFinished 而不是留空。
   * 留空时 VS Code 要等用户先执行一次命令才激活，而状态栏、活动栏视图这些
   * 「用来发现这个工具」的入口在那之前根本不存在。
   */
  test('激活时机是启动完成后，而不是等用户先执行命令', () => {
    const manifest = extension().packageJSON as { activationEvents?: string[] };
    assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
  });

  test('命令全部注册上了', async () => {
    const registered = await vscode.commands.getCommands(true);
    for (const command of [
      'serialTool.newPanel',
      'serialTool.showPanels',
      'serialTool.toggleConnection',
      'serialTool.refreshPorts',
      'serialTool.openPort',
      'serialTool.openPortInNewPanel',
    ]) {
      assert.ok(registered.includes(command), `命令未注册：${command}`);
    }
  });

  test('清单里声明了活动栏视图与图标', () => {
    const manifest = extension().packageJSON as {
      contributes?: {
        viewsContainers?: { activitybar?: { id: string; icon: string }[] };
        views?: Record<string, { id: string }[]>;
      };
    };
    const container = manifest.contributes?.viewsContainers?.activitybar?.[0];
    assert.equal(container?.id, 'serialTool');
    assert.equal(container?.icon, 'media/icon.svg');
    assert.equal(manifest.contributes?.views?.serialTool?.[0]?.id, 'serialTool.ports');
  });

  test('新建面板会真的开出一个编辑器标签页', async () => {
    const before = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;

    await vscode.commands.executeCommand('serialTool.newPanel');
    await waitFor(
      '新面板出现在标签页里',
      () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).length > before,
    );

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const panel = tabs.find((tab) => tab.input instanceof vscode.TabInputWebview);
    assert.ok(panel, '没有找到串口面板的标签页');

    // 收尾：把它关掉，免得影响后面的用例
    await vscode.window.tabGroups.close(panel);
  });

  test('刷新端口不会抛错 —— 原生模块在这台机器上确实加载得起来', async () => {
    await vscode.commands.executeCommand('serialTool.refreshPorts');
  });

  /**
   * 端口枚举这一路是真的：原生模块加载、SerialPort.list()、身份与标签生成。
   *
   * 不要求端口可用，因此不走 hardwarePorts() —— 列出什么就检查什么的形状。
   * CI 的 Linux runner 上通常会列出若干 /dev/ttyS*，正好也是有效样本。
   */
  test('列出来的端口描述形状正确', async function () {
    const ports = await api.listPorts();
    if (ports.length === 0) this.skip();

    for (const port of ports) {
      assert.ok(port.key.length > 0, '端口 key 不该为空');
      assert.ok(port.label.length > 0, '端口标签不该为空');
      assert.ok(port.identity.length > 0, '设备标识不该为空');
    }
  });

  /**
   * 真机上打开一个真实的串口，一路走到底：
   * 命令 → 面板 → RPC → 会话 → NodeSerialTransport → 原生模块 → 操作系统。
   * 这条链任何一环断了，前面所有的单元测试都发现不了。
   */
  test('能真的打开一个串口并连上', async function () {
    const [target] = hardwarePorts();
    if (!target) this.skip();

    await api.openPort(target);
    await waitFor('端口连上', () => api.panels().some((panel) => panel.state === 'open'), 15_000);

    const connected = api.panels().find((panel) => panel.state === 'open');
    assert.equal(connected?.portKey, target);
  });

  /**
   * 只有真实 VS Code 能逼出来的一类：**被隐藏的面板收不到 postMessage**。
   *
   * `retainContextWhenHidden` 是关的，面板一隐藏 webview 连同脚本就被销毁，
   * 而 `reveal()` 触发的重新载入是异步的 —— 紧接着 postMessage 会直接丢掉。
   * 从活动栏点一个端口、恰好复用到一个隐藏着的空闲面板时，用户点完什么也不会发生。
   * jsdom 里没有「面板被隐藏」这件事，前三档测试全看不见它。
   */
  test('复用一个被隐藏的空闲面板时，端口照样能打开', async function () {
    const [target] = hardwarePorts();
    if (!target) this.skip();

    // 两个空面板，同一编辑器组 —— 后建的那个会把先建的盖住
    await vscode.commands.executeCommand('serialTool.newPanel');
    await vscode.commands.executeCommand('serialTool.newPanel');
    await waitFor('两个空面板都建好了', () => api.panels().length === 2);

    // 复用逻辑会挑第一个空闲面板，也就是此刻被盖住的那个
    await api.openPort(target);
    await waitFor('端口连上', () => api.panels().some((panel) => panel.state === 'open'), 15_000);

    assert.equal(panelState(target), 'open');
    // 没有多开面板：复用的正是那个空闲的
    assert.equal(api.panels().length, 2);
  });

  /**
   * 这一条抓到过一个真 bug：`SerialSession.dispose()` 只断开引用、没关传输层。
   * 浏览器里看不出来（页面一卸载什么都释放了），但扩展宿主是长驻进程 ——
   * 关掉一个面板就永久漏掉一个串口，再开只会拿到 `Access denied`。
   * 只有真机上的真实端口能把它逼出来。
   */
  test('关掉面板后端口被释放，能立刻再开一次', async function () {
    const [target] = hardwarePorts();
    if (!target) this.skip();

    await api.openPort(target);
    await waitFor('端口连上', () => api.panels().some((panel) => panel.state === 'open'), 15_000);
    await api.closeAll();
    await waitFor('面板全部关掉', () => api.panels().length === 0);

    // 上一次没释放干净的话，这一次会因为端口被占而失败
    await api.openPort(target);
    await waitFor(
      `端口重新连上（当前面板：${JSON.stringify(api.panels())}）`,
      () => api.panels().some((panel) => panel.state === 'open'),
      15_000,
    );
  });

  /**
   * 多面板各连一口 —— 扩展形态的核心卖点，以前只能人工验收。
   * 需要机器上至少有两个可用串口。
   */
  test('两个面板各连一个口，互不干扰', async function () {
    const [first, second] = hardwarePorts();
    if (!first || !second) this.skip();

    await api.openPort(first);
    await waitFor('第一个口连上', () => panelState(first) === 'open', 15_000);

    await api.openPort(second);
    await waitFor('第二个口连上', () => panelState(second) === 'open', 15_000);

    // 第一个仍然连着，没被第二个挤掉
    assert.equal(panelState(first), 'open');
    assert.equal(api.panels().length, 2);
  });

  /**
   * 同一个口不能被两个面板同时打开。
   * 占用仲裁在真实环境下是否生效，只有这里能验证 —— 单元测试里那张占用表是我们自己的，
   * 这里撞上的是操作系统的独占。
   */
  test('同一个口开第二个面板会被拦下，原面板不受影响', async function () {
    const [target] = hardwarePorts();
    if (!target) this.skip();

    await api.openPort(target);
    await waitFor('端口连上', () => panelState(target) === 'open', 15_000);

    await api.openPort(target, { newPanel: true });
    // 给它足够时间去尝试并失败
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const opened = api.panels().filter((panel) => panel.state === 'open');
    assert.equal(opened.length, 1, '同一个口不该有两个面板同时连着');
    assert.equal(opened[0]?.portKey, target);
  });
});
