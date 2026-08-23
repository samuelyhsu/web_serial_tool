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
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      exclude: [
        'src/core/**/*.test.ts',
        // 纯类型模块编译后没有可执行代码，计入覆盖率只会稀释真实数字
        'src/core/**/types.ts',
        'src/core/session/notices.ts',
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
