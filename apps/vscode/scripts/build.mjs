import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

/**
 * 扩展的构建：宿主用 esbuild，webview 用 Vite。
 *
 * 关键约束是 external 那一行：`serialport` 及其原生绑定**绝不能打进 bundle**。
 * `@serialport/bindings-cpp` 靠 node-gyp-build 在运行时按平台/架构去自己的包目录里
 * 找 .node 文件，一旦被打平，那套查找路径就失效了。它必须原样躺在 node_modules 里
 * 跟着 VSIX 一起走（见 .vscodeignore 末尾的两条 ! 规则）。
 *
 * Vite 走 Node API 而不是子进程：Windows 上 spawn 一个 .cmd 在新版 Node 里直接 EINVAL，
 * 而绕过它的 shell: true 又会引入参数拼接的注入面。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const hostOptions = {
  entryPoints: [resolve(root, 'src/host/extension.ts')],
  outfile: resolve(root, 'dist/host/extension.js'),
  bundle: true,
  platform: 'node',
  // 扩展宿主加载的是 CommonJS
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  minify: !watch,
  external: ['vscode', 'serialport', '@serialport/bindings-cpp'],
  logLevel: 'info',
};

if (watch) {
  const context = await esbuild.context(hostOptions);
  await context.watch();
} else {
  await esbuild.build(hostOptions);
}

await viteBuild({
  configFile: resolve(root, 'vite.webview.config.ts'),
  ...(watch ? { build: { watch: {} } } : {}),
});

// 监视模式下不校验：那会儿产物随时在变，报错只是噪音
if (!watch) await import('./verify-artifacts.mjs');
