import { useId } from 'react';
import type { Parity } from '@/core/transport/types';
import { useConnectionStore } from '@/store/connectionStore';
import { useUiStore } from '@/store/uiStore';
import { useMessages } from '../useMessages';
import { BaudRateInput } from './BaudRateInput';
import { PortPicker } from './PortPicker';
import styles from './Toolbar.module.css';

export function Toolbar(): React.JSX.Element {
  const t = useMessages();
  const ids = {
    dataBits: useId(),
    parity: useId(),
    stopBits: useId(),
    flow: useId(),
  };

  const supported = useConnectionStore((s) => s.supported);
  const hasPort = useConnectionStore((s) => s.selectedPortKey !== null);
  const options = useConnectionStore((s) => s.options);
  const sessionState = useConnectionStore((s) => s.sessionState);
  const autoReconnect = useConnectionStore((s) => s.autoReconnect);

  const setOptions = useConnectionStore((s) => s.setOptions);
  const setAutoReconnect = useConnectionStore((s) => s.setAutoReconnect);
  const toggleConnection = useConnectionStore((s) => s.toggleConnection);

  const language = useUiStore((s) => s.language);
  const theme = useUiStore((s) => s.theme);
  const toggleLanguage = useUiStore((s) => s.toggleLanguage);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  const isOpen = sessionState === 'open';
  const busy = sessionState === 'opening';
  // 端口参数在链路打开期间不可改：改了也不会生效，只会让界面和硬件对不上
  const locked = sessionState !== 'closed';

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <div className={styles.mark} aria-hidden="true">
          S
        </div>
        <div className={styles.title}>{t.app}</div>
      </div>

      <PortPicker />

      <div className={styles.group}>
        <BaudRateInput disabled={locked} />

        <label className="label" htmlFor={ids.dataBits}>
          {t.dataBits}
        </label>
        <select
          id={ids.dataBits}
          className="field"
          value={options.dataBits}
          disabled={locked}
          onChange={(event) => setOptions({ dataBits: Number(event.target.value) as 7 | 8 })}
        >
          <option value={8}>8</option>
          <option value={7}>7</option>
        </select>

        <label className="label" htmlFor={ids.parity}>
          {t.parity}
        </label>
        <select
          id={ids.parity}
          className="field"
          value={options.parity}
          disabled={locked}
          onChange={(event) => setOptions({ parity: event.target.value as Parity })}
        >
          <option value="none">None</option>
          <option value="even">Even</option>
          <option value="odd">Odd</option>
        </select>

        <label className="label" htmlFor={ids.stopBits}>
          {t.stopBits}
        </label>
        <select
          id={ids.stopBits}
          className="field"
          value={options.stopBits}
          disabled={locked}
          onChange={(event) => setOptions({ stopBits: Number(event.target.value) as 1 | 2 })}
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
        </select>

        <label className="label" htmlFor={ids.flow}>
          {t.flow}
        </label>
        <select
          id={ids.flow}
          className="field"
          value={options.flowControl}
          disabled={locked}
          onChange={(event) =>
            setOptions({ flowControl: event.target.value === 'hardware' ? 'hardware' : 'none' })
          }
        >
          <option value="none">{t.none}</option>
          <option value="hardware">RTS/CTS</option>
        </select>
      </div>

      <div className={styles.right}>
        <label className="check">
          <input
            type="checkbox"
            checked={autoReconnect}
            onChange={(event) => setAutoReconnect(event.target.checked)}
          />
          {t.autoReconnect}
        </label>

        <div className={styles.status}>
          <span className={styles.led} data-state={sessionState} aria-hidden="true" />
          {/* 状态灯是纯色彩信息，屏幕阅读器需要文字播报（缺陷 D20） */}
          <span className={styles.statusText} role="status" aria-live="polite">
            {sessionState === 'open'
              ? t.opened
              : sessionState === 'opening'
                ? t.opening
                : sessionState === 'reconnecting'
                  ? t.reconnecting
                  : t.disconnected}
          </span>
        </div>

        <button
          type="button"
          className={styles.connect}
          data-open={isOpen || sessionState === 'reconnecting'}
          disabled={busy || (!isOpen && (!supported || !hasPort))}
          onClick={() => void toggleConnection()}
        >
          {sessionState === 'closed' ? t.openPort : t.closePort}
        </button>

        <div className={styles.switches}>
          <button
            type="button"
            className="btn"
            onClick={toggleLanguage}
            aria-label={t.switchLanguage}
          >
            {language === 'zh' ? 'EN' : '中文'}
          </button>
          <button type="button" className="btn" onClick={toggleTheme} aria-label={t.switchTheme}>
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </div>
    </header>
  );
}
