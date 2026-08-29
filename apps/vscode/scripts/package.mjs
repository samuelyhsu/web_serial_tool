import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVSIX } from '@vscode/vsce';

/**
 * 打 VSIX。
 *
 * 为什么要先搭一个临时目录，而不是直接在 apps/vscode 里 `vsce package`：
 *
 * 扩展是 npm workspace 的成员，`serialport` 被提升到了仓库根目录的 node_modules。
 * vsce 的依赖收集顺着提升后的路径走，会算出 `extension/../../vite.config.ts`
 * 这种跑出扩展目录的相对路径，直接报错；而如果在扩展本地再铺一份依赖，它又会把
 * 同一批文件从两个位置各收一遍，撞上「同名路径」错误。关掉依赖收集也不行 ——
 * 那样 node_modules 会被整个丢掉，`.vscodeignore` 里的反向规则救不回来。
 *
 * 把「扩展 + 它自己的依赖」原样搬到仓库之外的一个目录再打包，上面这些就都不存在了：
 * 那里没有 workspace 祖先，依赖只有一份，路径也不会跑到目录外面去。
 *
 * `serialport` 不能打进 bundle：`@serialport/bindings-cpp` 靠 node-gyp-build 在运行时
 * 按 `__dirname` 去自己的包目录找 `prebuilds/<平台>-<架构>/*.node`，打平就找不到了。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(root, '../..');
const repoModules = join(repoRoot, 'node_modules');

/** 扩展在运行时真正会 require 的东西，其余（React、Vite…）都已打进 bundle。 */
const RUNTIME_ROOTS = ['serialport'];

/**
 * 要搬进临时目录的扩展自身文件。
 *
 * 这是一份**白名单**：漏一项就是产物里少一样东西，而且往往要装上才发现
 * （活动栏图标就漏过一次）。加了新的运行时资源记得同步这里。
 */
const EXTENSION_FILES = [
  'package.json',
  'package.nls.json',
  'package.nls.zh-cn.json',
  'README.md',
  'LICENSE',
  '.vscodeignore',
  'dist',
  // 活动栏图标等静态资源
  'media',
];

/**
 * 按 Node 的目录算法找一个包所在的目录。
 *
 * 不用 `require.resolve(name + '/package.json')`：包一旦在 package.json 里声明了
 * `exports` 而其中没有 `./package.json` 这一项（@serialport/bindings-interface 就是如此），
 * 这种解析会直接失败 —— 而失败是静默的，闭包会悄悄少几个包，直到打包时才暴露。
 */
function findPackageDir(name, from) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readManifest(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
}

/**
 * 递归收集依赖闭包，只记直接挂在根 node_modules 下的包 ——
 * 嵌套在包内部的那些（如 serialport/node_modules/debug）会随父包一起被复制。
 */
function collectDependencies() {
  const topLevel = new Set();
  const visited = new Set();

  function walk(name, from) {
    const packageDir = findPackageDir(name, from);
    // 可选依赖 / 平台专属依赖没装上是正常的
    if (packageDir === null || visited.has(packageDir)) return;
    visited.add(packageDir);

    if (packageDir.startsWith(repoModules + sep)) {
      const relativePath = packageDir.slice(repoModules.length + 1);
      if (!relativePath.includes(`${sep}node_modules${sep}`)) topLevel.add(relativePath);
    }

    for (const dependency of Object.keys(readManifest(packageDir).dependencies ?? {})) {
      walk(dependency, packageDir);
    }
  }

  for (const name of RUNTIME_ROOTS) walk(name, root);
  return [...topLevel].sort();
}

const staging = mkdtempSync(join(tmpdir(), 'serial-assistant-'));

try {
  for (const name of EXTENSION_FILES) {
    const source = join(root, name);
    if (!existsSync(source)) continue;
    cpSync(source, join(staging, name), { recursive: true });
  }

  const dependencies = collectDependencies();
  mkdirSync(join(staging, 'node_modules'), { recursive: true });
  for (const relativePath of dependencies) {
    cpSync(join(repoModules, relativePath), join(staging, 'node_modules', relativePath), {
      recursive: true,
      dereference: true,
    });
  }
  console.log(`已搬入 ${dependencies.length} 个运行时依赖：`);
  for (const name of dependencies) console.log('  ' + name.split(sep).join('/'));

  const output = join(root, 'serial-assistant.vsix');
  await createVSIX({
    cwd: staging,
    packagePath: output,
    // 临时目录里没有 workspace 祖先，依赖只有一份，
    // 此时 vsce 自带的收集才是对的（关掉它反而会把 node_modules 整个丢掉）
    dependencies: true,
    allowMissingRepository: true,
  });

  verifyVsix(output);
  console.log(`\n已打包：${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

/**
 * VSIX 内容的不变量。
 *
 * 「打出来了」不等于「打对了」：活动栏图标就漏过一次 —— 上面那份搬运清单是白名单，
 * 少一项要装上才发现是个空白图标。翻一次包是运气，写成断言才是保障。
 */
function verifyVsix(vsixPath) {
  const entries = listZipEntries(vsixPath);
  const problems = [];

  const expect = (predicate, description) => {
    if (!entries.some(predicate)) problems.push(`缺少${description}`);
  };

  expect((name) => name === 'extension/dist/host/extension.js', '宿主产物');
  expect((name) => name === 'extension/dist/webview/main.js', 'webview 产物');
  expect((name) => name === 'extension/dist/webview/main.css', 'webview 样式');
  expect((name) => name === 'extension/media/plug.svg', '活动栏图标');
  expect((name) => name === 'extension/package.nls.json', '英文文案');
  expect((name) => name === 'extension/package.nls.zh-cn.json', '中文文案');
  expect((name) => name.includes('/prebuilds/') && name.endsWith('.node'), '原生预编译产物');

  // 自己的源码不该进包（第三方包内部的 src/ 不算）
  for (const name of entries.filter((entry) => entry.startsWith('extension/src/'))) {
    problems.push(`混进了源码：${name}`);
  }

  if (problems.length > 0) {
    console.error('VSIX 内容校验未通过：');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log(`VSIX 内容校验通过（${entries.length} 个条目）。`);
}

/** 扫 zip 的本地文件头取文件名。VSIX 就是个 zip，为此拉一个依赖不值得。 */
function listZipEntries(vsixPath) {
  const buffer = readFileSync(vsixPath);
  const names = [];
  for (let offset = 0; offset + 30 < buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) continue;
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    names.push(buffer.toString('utf8', offset + 30, offset + 30 + nameLength));
    offset += 29 + nameLength + extraLength;
  }
  return names;
}
