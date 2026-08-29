import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// GitHub Pages 项目页部署在 /<repo>/ 子路径下；本地 dev/preview 用根路径。
// 通过 BASE_PATH 环境变量覆盖，CI 里显式传入。
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    // 有意保留 sourcemap 并一起发布：本项目源码本就公开，map 只在用户打开
    // DevTools 时才会被请求，对正常访问零成本，换来的是线上问题可以直接按源码定位。
    // 若要缩小部署产物（map 约 1.1MB，是 JS 产物的 4 倍），把这里改成 false 即可。
    sourcemap: true,
  },
  test: {
    globals: true,
    alias: {
      // `vscode` 只有装进编辑器才存在，npm 装不到。替成一层薄门面，
      // 宿主侧碰 VS Code API 的代码才有可能被单元测试覆盖到（见 tests/vscodeStub.ts）
      vscode: fileURLToPath(new URL('./tests/vscodeStub.ts', import.meta.url)),
    },
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    // 扩展宿主的代码住在 apps/vscode，但它实现的是 core 的 Transport 接口，
    // 必须和 Web 侧跑在同一条 CI 上，否则两个运行环境的语义会悄悄分叉
    include: [
      'src/**/*.test.{ts,tsx}',
      'tests/**/*.test.{ts,tsx}',
      'apps/vscode/src/**/*.test.{ts,tsx}',
    ],
    // 集成测试是 Mocha 写的，装进真实 VS Code 里跑（npm run test:vscode），
    // 不归 vitest 管 —— 它连 suite/suiteSetup 这些全局都没有
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/vscode/src/test/**'],
    coverage: {
      provider: 'v8',
      /*
       * 统计范围不止 core。
       *
       * 只盯 core 的话，store 层的接线、扩展宿主的会话编排这些**接缝处**的代码
       * 完全没有阈值守着 —— 而这次真正逃出去的 bug 恰恰都在接缝上。
       * core 的阈值单独更严，因为它是纯逻辑，本来就该接近全覆盖。
       */
      include: [
        'src/core/**/*.ts',
        'src/lib/**/*.ts',
        'src/store/**/*.ts',
        'apps/vscode/src/host/**/*.ts',
        'apps/vscode/src/webview/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        // 纯类型模块编译后没有可执行代码，计入覆盖率只会稀释真实数字
        '**/types.ts',
        'src/core/session/notices.ts',
        'apps/vscode/src/shared/protocol.ts',
        // 扩展入口全是 VS Code API 的接线，只有装进 VS Code 才跑得起来，
        // 单元测试覆盖不到它；真正的逻辑都已经抽到 sessionHost / rpc / portsView 里了
        'apps/vscode/src/host/extension.ts',
        'apps/vscode/src/host/serialPortBinding.ts',
        'apps/vscode/src/webview/main.tsx',
        'apps/vscode/src/webview/mount.tsx',
      ],
      thresholds: {
        lines: 85,
        functions: 80,
        branches: 80,
        statements: 85,
        'src/core/**': {
          lines: 95,
          functions: 95,
          branches: 90,
          statements: 95,
        },
      },
    },
  },
});
