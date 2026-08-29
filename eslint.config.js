import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  { ignores: ['dist', 'design', 'coverage', 'node_modules'] },

  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // 原型里有 8 处 `catch (e) {}` 把失败全吞了（缺陷 D6）。禁掉空块，
      // 强制每个 catch 要么处理、要么显式注释说明为何可以忽略。
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // 分层铁律：core/ 是纯 TS，不得依赖 React、store、UI，也不得直接摸 DOM 全局。
  // 唯一例外是 webSerialTransport.ts —— 它是与浏览器 API 的边界层。
  {
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/transport/webSerialTransport.ts', 'src/core/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                'zustand',
                '@/ui/*',
                '@/store/*',
                '../../ui/*',
                '../../store/*',
              ],
              message: 'core/ 必须保持框架无关：不得依赖 React / zustand / ui / store。',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'core/ 不得直接访问 DOM。' },
        {
          name: 'localStorage',
          message: 'core/ 不得直接访问 localStorage，请用 src/lib/storage.ts。',
        },
      ],
    },
  },

  // 扩展的代码不在根 tsconfig 的 include 里，得显式告诉类型化规则去哪找工程配置，
  // 否则 serialport 这类依赖会被当成无法解析的类型，触发一片 no-unsafe-* 误报。
  {
    files: ['apps/vscode/**/*.{ts,tsx}'],
    // 构建配置不在 tsconfig 的 include 里，交给下面那条免类型检查的规则去管
    ignores: ['apps/vscode/vite.webview.config.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: false,
        project: ['./apps/vscode/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['**/*.test.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  {
    files: ['vite.config.ts', 'eslint.config.js', 'apps/vscode/vite.webview.config.ts'],
    languageOptions: { globals: globals.node },
    ...tseslint.configs.disableTypeChecked,
  },
);
