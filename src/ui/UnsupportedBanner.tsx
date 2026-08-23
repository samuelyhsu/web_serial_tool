import type { Messages } from '@/i18n';
import styles from './App.module.css';

const MDN_URL = 'https://developer.mozilla.org/docs/Web/API/Web_Serial_API#browser_compatibility';

/**
 * 浏览器不支持 Web Serial 时的说明。
 *
 * 原型的处理是「锁定演示模式」让用户以为工具能用；演示模式移除后，这里如实告诉用户
 * 需要什么环境，并给出权威文档链接，而不是留一个点了没反应的界面。
 */
export function UnsupportedBanner({ messages }: { messages: Messages }): React.JSX.Element {
  return (
    <div className={styles.unsupported} role="alert">
      <div className={styles.unsupportedTitle}>{messages.unsupportedTitle}</div>
      <div className={styles.unsupportedBody}>
        {messages.unsupportedBody}{' '}
        <a href={MDN_URL} target="_blank" rel="noreferrer noopener">
          {messages.unsupportedLink}
        </a>
      </div>
    </div>
  );
}
