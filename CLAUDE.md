# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

基于 Web Serial API 的浏览器串口调试工具（React 19 + Zustand + Vite + TypeScript）。
README.md 记录了完整的功能说明与设计取舍，改动前值得先读对应章节。

## 常用命令

```bash
npm run dev            # 开发服务器（Web Serial 需要 https 或 localhost）
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm run format:check   # Prettier 校验（CI 会跑，改完代码记得 npm run format）
npm run test           # Vitest 单跑
npm run test:coverage  # 带覆盖率阈值，CI 用的是这条
npm run build          # tsc --noEmit && vite build → dist/
```

扩展相关：

```bash
npm run build:vscode     # 宿主 esbuild + webview Vite → apps/vscode/dist/
npm run package:vscode   # 打 VSIX（在仓库外的临时目录里做，见下）
```

VS Code 里按 F5 走 `.vscode/launch.json` 的「运行扩展」即可起开发宿主窗口调试。

跑单个测试文件 / 单个用例：

```bash
npx vitest run src/core/framing/frameAssembler.test.ts
npx vitest run -t "CRLF"
npx vitest src/core/framing/frameAssembler.test.ts   # watch 模式
```

CI（`.github/workflows/ci.yml`）依次跑 typecheck / lint / format:check / test:coverage / build /
build:vscode，任一失败都会挡住合并与部署。`format:check` 尤其容易被忘。
`typecheck` 会连扩展的两份 tsconfig（宿主 / webview）一起跑。

## 分层架构

数据是单向流动的：`core`（纯逻辑）→ `store`（Zustand）→ `ui`（React）。

```
src/core/     纯 TypeScript：不 import React / zustand / ui / store，不碰 document / localStorage
  transport/    Web Serial 之上的字节流通道、串行化写队列、端口身份登记
  framing/      接收分帧（raw / idle / line）
  codec/        UTF-8 流式编解码、HEX 解析、日志转义
  checksum/     参数化 CRC 引擎 + SUM/XOR
  scheduler/    周期任务调度、断线重连退避
  session/      把上面几层编排成一次串口会话
  buffer/       日志环形缓冲
src/store/    Zustand 状态层，订阅 core 的事件回调
src/ui/       React 组件（每个目录 = 组件 + CSS Module）
src/i18n/     文案目录（zh / en）
src/lib/      存储安全包装、偏好持久化、跨页面端口占用广播、下载
apps/vscode/  VS Code 扩展（npm workspace 成员，serialport 只装在这里）
  src/host/     扩展宿主进程：NodeSerialTransport、SessionHost、占用表、端口轮询
  src/webview/  webview 侧：RPC 客户端、平台实现、入口
  src/shared/   两端共用的消息协议
```

这条分层不是约定而是**由 ESLint 强制**的（见 eslint.config.js 中 `src/core/**` 的
`no-restricted-imports` / `no-restricted-globals`）。唯一允许接触浏览器串口 API 的文件是
`src/core/transport/webSerialTransport.ts`，它被显式排除在规则之外。

新增 core 模块时若发现需要 React 或 localStorage，说明这段逻辑应该放到 store 或 lib 层。

## 运行环境适配（platform）

同一套 store 与 UI 服务两个运行环境，差异全部收在 `src/store/platform.ts` 这一个接口后面：

- **浏览器**（`src/store/webPlatform.ts`）：会话跑在页面里，端口来自 `navigator.serial`，
  跨页面占用靠 BroadcastChannel。
- **VS Code webview**（`apps/vscode/src/webview/vscodePlatform.ts`）：**会话跑在扩展宿主进程**，
  这边只把界面动作翻成 RPC。原因是 webview 一被隐藏就会销毁 —— 会话放这边，
  切个标签页串口就断了。

`platform()` 没装过会懒装 Web 实现，所以既有测试与网页入口都不用显式初始化；
webview 入口靠 `import './bootstrap'` 排在第一行来保证「先装环境、再求值 store」。
**这个 import 顺序是正确性的一部分，不是风格问题**：store 在模块初始化时就会向 platform()
要会话与调度器。曾经用动态 import 表达同一件事是错的 —— Rollup 的 `inlineDynamicImports`
会把模块内联进同一个 chunk，顶层代码照样提前跑。

新增运行环境相关能力时，先问「这该进 Platform 接口，还是本来就该两边一样」，
不要在 store 里写 `if (kind === 'vscode')`。

## 关键接线点

- **全局单例会话**：`SerialSession` 在 `src/store/connectionStore.ts` 的模块顶层实例化一次，
  通过 `setHandlers` 把 `onFrame` / `onThroughput` / `onNotice` / `onStateChange` 接到 logStore、
  tasksStore、connectionStore 上。core 不知道 store 的存在，依赖靠 `SerialSessionDeps` 注入
  （`createTransport` / `resolvePort` / `describeConfig`）。这也是 `navigator.serial` 只在
  store 层出现的原因。
- **端口身份有两套 ID**（`core/transport/portRegistry.ts`）：`key` 是会话内稳定的（WeakMap 分配，
  刷新即失效，用于重连时重新解析端口对象）；`identity` 是跨会话稳定的（`usb:VID:PID#序号`，
  用于持久化备注）。不要用数组下标当端口身份——那正是被修掉的缺陷 D1。
- **i18n 不在业务层拼字符串**：core 只产出结构化的 `SessionNotice`，翻译发生在渲染时
  （`logStore.entryBody` → `messages.notice(...)`）。日志条目保留 notice 对象，所以切换语言
  时历史日志会跟着重新翻译。`Messages` 接口在 `src/i18n/types.ts`，zh / en 两份目录必须同构。
- **日志渲染有两级缓冲**：`RingBuffer`（容量 5000）+ 60ms 攒批提交，文本视图在入库时算好，
  HEX 视图惰性计算并缓存在条目上。不要在渲染路径上重新解码字节。
- **持久化统一走 `src/lib/persist.ts`**：写用 `saveSoon`（250ms 攒批，`pagehide` /
  `visibilitychange` 时立即落盘），读用 `pickInt` / `pickEnum` / `pickBoolean` / `pickString`
  逐字段校验、非法值回退默认。键名前缀 `wst.` 由 `src/lib/storage.ts` 统一加。
  新增持久化项时沿用这套，不要直接调 `localStorage`。
- **周期任务的唯一真相源是 `TaskScheduler`**：UI 只读 `useTasksStore().running`，不要另存
  「是否在跑」的布尔标志。调度器本身归 Platform 所有 —— VS Code 里它跑在宿主进程，
  面板隐藏也照跑。**任务必须带 `frames` 启动**：只给 `run` 闭包的任务会退化成在 webview
  里跑，面板一隐藏就随它一起没了，而这在浏览器里完全正常、类型检查也不会报 ——
  `src/store/tasks.test.ts` 专门盯着这件事。
- **多页面 / 多面板各连一口**：串口参数按设备存（`wst.portSettings`），端口选择、发送内容、
  接收区视图按「分层作用域」存（页面优先、全局兜底，见 `src/lib/storage.ts`）。
  端口占用在浏览器里靠 BroadcastChannel 尽力而为、在 VS Code 里由宿主权威仲裁。
- **VSIX 必须在仓库之外的临时目录里打**（`apps/vscode/scripts/package.mjs`）。
  workspace 把依赖提升到了根 node_modules，vsce 顺着提升后的路径会算出
  `extension/../../vite.config.ts` 这种跑出扩展目录的相对路径而报错；若在扩展本地
  再铺一份依赖，它又会把同一批文件从两个位置各收一遍，撞上「同名路径」错误。
  `serialport` 同理不能打进 bundle —— node-gyp-build 靠 `__dirname` 找 prebuilds。
- **`@serialport/bindings-interface` 的 exports 没有 types 条件**，`moduleResolution: bundler`
  解析不到它的 `.d.ts`，会让 `SerialPort.list()` 静默退化成 `any`。所以
  `apps/vscode/tsconfig.json` 必须用 `moduleResolution: node`。发现它的是 ESLint 的
  `no-unsafe-*`，tsc 当时是「通过」的 —— 这也是那条规则值得留着的理由。
  同一个坑还有第二种形态：`require.resolve('pkg/package.json')` 对这类包会**静默失败**，
  遍历依赖闭包时必须自己按 Node 的目录算法找（package.mjs 里的 findPackageDir）。

## 测试

- core 层通过 `Transport` 接口解耦，测试用 `tests/fakeTransport.ts` 替换；传输层自身用
  `tests/fakeSerialPort.ts`（基于 WHATWG Streams）测读循环、锁释放、时序竞争。
  「打开 → 收帧 → 掉线 → 退避重连 → 恢复」整条链路无需真实硬件即可跑成确定性测试。
- 覆盖率统计 core / lib / store / `apps/vscode/src/{host,webview}`，阈值分两档写在
  vite.config.ts：整体 85%，`src/core/**` 单独更严（95%）。未达标 CI 直接失败。
  只盯 core 是不够的 —— 真正逃出去的 bug 都在**接缝**上（store 的接线、宿主的编排）。

### 四档测试，各管一段

1. **单元**：core / lib / store / 宿主各模块，jsdom + fake timers。
2. **回环**（`apps/vscode/src/webview/loopback.test.ts`）：把 webview 侧 store 与宿主侧会话
   直接对接，中间 RPC 全是真代码，并用真实的 `bootstrap.ts` 装配（`acquireVsCodeApi`
   换成回环那一头）—— 初始化顺序出过两次问题，测试必须跑真接线而不是另抄一份。
   它还能 `hidePanel()` 模拟面板被隐藏（掐断两侧通道）。
3. **真实串口**（`SERIAL_LOOPBACK_PORTS=COM1,COM2 npm run test:hardware`）：一对互通的口，
   走完整栈测真实驱动的分块时序、分帧、高速完整性、端口占用与释放。**必须靠环境变量显式
   开启**，自动探测会打断别人正在调试的设备。背压那条会先探这对口是否真按波特率限速 ——
   很多虚拟串口对不限速，硬测只会得到假绿。
4. **真机集成**（`npm run test:vscode`）：`@vscode/test-cli` + Mocha，源码在
   `apps/vscode/src/test/`，被 vitest 显式排除。专攻「代码全对、装进去不好使」——
   激活时机、命令注册、清单声明、真实串口的开关。CI 里用 xvfb 跑。
   **依赖真实串口的用例靠 `SERIAL_INTEGRATION_PORTS` 显式开启**，与回环测试同一个道理：
   「列表为空就跳过」这种自动探测是错的 —— Linux runner 上 `/dev/ttyS*` 枚举得到却连不上。
5. **产物断言**：`verify-artifacts.mjs` 随 build 跑（原生模块保持外部、bootstrap 早于 store
   求值、无外部 CDN）；VSIX 内容断言随 package 跑（图标、文案、预编译产物在不在，
   源码有没有混进去）。这类问题单元测试永远看不见，都真的发生过。

### 两条经验（都是踩出来的）

- **写完测试要做变异验证**：把对应的 bug 注回去，确认它真的会红。回环测试第一版里
  那条「周期发送跑在宿主」注入缺陷后照样是绿的（两侧同进程，跑在哪边都能送到串口），
  必须先模拟面板被隐藏、掐断通道，区别才显形。
- **有些 bug 只有真实操作系统资源能逼出来**。`SerialSession.dispose()` 曾经只断开引用、
  不关传输层：浏览器里被页面卸载兜住了，长驻的扩展宿主里就是关一个面板漏一个串口，
  再开只有 `Access denied`。FakeTransport 不模拟操作系统资源，所以前三档全是绿的。
- 扩展通过 `activate()` 返回 `SerialToolApi`（`apps/vscode/src/shared/api.ts`，**刻意自包含、
  不 import 内部类型**）。它既是集成测试的观察窗口，也是别的扩展驱动它的入口。
- `vscode` 模块在 vitest 里被 `tests/vscodeStub.ts` 替掉（vite.config.ts 的 test.alias），
  宿主侧碰 VS Code API 的代码才能被覆盖到。只实现被测代码真正用到的那部分。
- 组件测试在 `tests/dom/`，用 Testing Library + jsdom。
- 涉及定时器的模块（分帧空闲超时、调度器、persist 攒批）用 fake timers；persist 提供
  `__resetPersistForTests()` 避免定时器跨用例泄漏。
- Web Serial 需要用户手势和真实硬件，CI 覆盖不到。README「测试」一节末尾有 8 条人工验收
  清单，改动端口选择 / 重连 / 高速收发相关逻辑后应对照走一遍。

## 其他约定

- 注释用中文，代码标识符用英文。仓库里的注释常引用「缺陷 Dxx」，指的是 `design/` 原型中
  已定位并修复的问题，保留它们有助于理解为什么这样写。
- `design/` 是 Claude Design 原型存档，不参与构建，被 ESLint / Prettier / tsconfig 忽略，
  不要去改它。
- 部署到 GitHub Pages 项目页（`/<repo>/` 子路径），构建时通过 `BASE_PATH` 环境变量注入；
  本地默认根路径。写死绝对路径的资源引用会在线上 404。
- `@/*` 路径别名指向 `src/*`，tsconfig 与 vite.config.ts 两处都配了。
- tsconfig 开了全套严格选项（含 `noUncheckedIndexedAccess`、`noUnusedLocals`、
  `verbatimModuleSyntax`），类型导入必须写成 `import type` / inline `type`（ESLint 也在管）。
- 空 catch 块被 ESLint 禁掉：要么处理，要么写注释说明为何可以忽略。
