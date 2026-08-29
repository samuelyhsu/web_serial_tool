import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * webview 的构建配置。
 *
 * 与 Web 版最大的两点不同：
 *  - 产物名固定成 main.js / main.css。宿主要在 CSP 的 script-src 里给它挂 nonce，
 *    带哈希的文件名反而是负担 —— webview 每次都由宿主现生成 HTML，不需要缓存破坏。
 *  - 不做代码分割。webview 是本地文件加载，多一次请求没有收益，
 *    而单文件让 localResourceRoots 与 CSP 都更简单。
 */
export default defineConfig({
  // 资源用相对路径引用，宿主再用 asWebviewUri 换成 vscode-webview:// 的地址
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/webview',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/webview/main.tsx', import.meta.url)),
      output: {
        entryFileNames: 'main.js',
        assetFileNames: 'main.[ext]',
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
});
