import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 构建产物的不变量检查。
 *
 * 有几类问题单元测试永远看不见，因为它们发生在打包之后：
 *  - 打包器把该保持外部的原生模块打平了 → 装上才发现加载不了；
 *  - 打包器改变了模块求值顺序 → 运行环境还没装好，store 就先初始化了；
 *  - 静态资源没进产物 → 活动栏一个空白图标。
 *
 * 上面每一条这次都真的发生过，而且都是靠手工翻产物才发现的。翻一次是运气，
 * 写成断言才是保障。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function check(description, condition) {
  if (!condition) failures.push(description);
}

function read(relativePath) {
  try {
    return readFileSync(join(root, relativePath), 'utf8');
  } catch {
    failures.push(`产物缺失：${relativePath}`);
    return '';
  }
}

const host = read('dist/host/extension.js');
const webview = read('dist/webview/main.js');
read('dist/webview/main.css');

/*
 * serialport 必须保持外部依赖。@serialport/bindings-cpp 靠 node-gyp-build 在运行时
 * 按 __dirname 去自己的包目录找 prebuilds/<平台>-<架构>/*.node，一旦被打平就找不到了。
 */
check(
  '宿主产物里 serialport 应保持 require（不能被打进 bundle）',
  /require\(["']serialport["']\)/.test(host),
);
check(
  '宿主产物不该包含 serialport 的实现代码（说明它被打平了）',
  !host.includes('node-gyp-build') && !host.includes('bindings-cpp.node'),
);

/*
 * 初始化顺序：bootstrap 必须先于任何 store 被求值 —— store 在模块初始化时就会向
 * platform() 要会话与调度器。这条曾经被 Rollup 的 inlineDynamicImports 破坏过：
 * 动态 import 的模块被内联进同一个 chunk，顶层代码照样提前跑。
 */
const bootstrapAt = webview.indexOf('acquireVsCodeApi');
const storeAt = webview.indexOf('connectionSettings');
check('webview 产物里应能找到 bootstrap（acquireVsCodeApi）', bootstrapAt >= 0);
check('webview 产物里应能找到 store（connectionSettings）', storeAt >= 0);
check(
  'bootstrap 必须排在 store 之前求值，否则运行环境还没装好 store 就初始化了',
  bootstrapAt >= 0 && storeAt >= 0 && bootstrapAt < storeAt,
);

/*
 * webview 的 CSP 只放行扩展自己的资源。任何外部 URL 在线上都会被挡掉，
 * 而串口工具常跑在内网机器上，那种依赖本来就不该有。
 */
check(
  'webview 产物不该引用外部 CDN（CSP 会挡掉，内网环境也拿不到）',
  !/fonts\.googleapis\.com|cdn\.jsdelivr\.net|unpkg\.com/.test(webview),
);

if (failures.length > 0) {
  console.error('构建产物校验未通过：');
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log('构建产物校验通过。');
