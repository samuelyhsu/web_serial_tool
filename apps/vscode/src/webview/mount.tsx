import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/ui/App';
import '@/styles/tokens.css';
import '@/styles/base.css';
import './webview.css';

/**
 * 界面挂载。状态回放在 applySnapshot.ts，与渲染分开。
 *
 * 这个模块**必须在 setPlatform() 之后**才被求值：它拉起的 store 在模块初始化时
 * 就会向 platform() 要会话与调度器。main.tsx 靠把 `import './bootstrap'` 写在
 * 第一行来保证这个顺序 —— 那个 import 顺序是正确性的一部分，不是风格问题。
 */

export function mount(): void {
  const container = document.getElementById('root');
  if (!container) throw new Error('Root container #root is missing');

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
