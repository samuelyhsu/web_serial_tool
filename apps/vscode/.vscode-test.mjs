import { defineConfig } from '@vscode/test-cli';

/**
 * 集成测试：把扩展装进**真实的 VS Code** 里跑。
 *
 * 单元测试与回环测试覆盖不到的是这一段：扩展到底能不能激活、命令有没有注册上、
 * 视图容器认不认、面板建不建得出来。这次已经因此栽过两次 ——
 * activationEvents 留空导致状态栏在首次执行命令前根本不存在、
 * 状态栏在没有面板时被隐藏掉，两个都是「代码全对、装进去不好使」。
 *
 * 复用本机已装的 VS Code（`version: 'stable'` 会下载一份，这里指定省掉 150MB）。
 */
export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: 'stable',
  mocha: {
    ui: 'tdd',
    timeout: 30_000,
  },
  launchArgs: [
    // 别加载用户自己装的扩展：它们可能占着串口，也可能拖慢启动
    '--disable-extensions',
  ],
});
