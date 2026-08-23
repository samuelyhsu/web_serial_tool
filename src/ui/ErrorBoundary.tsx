import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { Messages } from '@/i18n';

interface Props {
  messages: Messages;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 缺陷 D19：原型没有错误边界，`renderVals()` 里任何一处抛错都会白屏，
 * 而那个函数有 250 行、几十个表达式。这里至少让用户看到发生了什么并能自行恢复。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI crashed:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { messages } = this.props;
    return (
      <div role="alert" style={{ padding: '48px 24px', maxWidth: 640, margin: '0 auto' }}>
        <h1 style={{ fontSize: 18, marginBottom: 8 }}>{messages.crashTitle}</h1>
        <p style={{ color: 'var(--dim)', lineHeight: 1.7 }}>{messages.crashBody}</p>
        <pre
          style={{
            background: 'var(--sunk)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: 12,
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--red-text)',
            overflowX: 'auto',
          }}
        >
          {error.message}
        </pre>
        <button type="button" className="btn btn--primary" onClick={() => location.reload()}>
          {messages.reload}
        </button>
      </div>
    );
  }
}
