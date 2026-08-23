import { useEffect, useState } from 'react';
import { useConnectionStore } from '@/store/connectionStore';
import { consumeThroughputWindow, useLogStore } from '@/store/logStore';
import { useTasksStore } from '@/store/tasksStore';
import { useMessages } from '../useMessages';
import styles from './StatusBar.module.css';

/**
 * 状态栏自己持有秒级时钟。
 *
 * 原型把 `now` 和 `rate` 放在组件 state 里、每 500ms 无条件 setState（.dc.html:419-423），
 * 于是空闲时整棵树每秒重渲染两次 —— 缺陷 D8。这里时钟只驱动状态栏一个组件，
 * 而且端口关闭时根本不启动。
 */
export function StatusBar(): React.JSX.Element {
  const t = useMessages();

  const rxBytes = useLogStore((s) => s.rxBytes);
  const txBytes = useLogStore((s) => s.txBytes);
  const rxFrames = useLogStore((s) => s.rxFrames);
  const txFrames = useLogStore((s) => s.txFrames);

  const sessionState = useConnectionStore((s) => s.sessionState);
  const openedAt = useConnectionStore((s) => s.openedAt);
  const options = useConnectionStore((s) => s.options);
  const portLabel = useConnectionStore((s) => s.selectedPortLabel());
  const runningCount = useTasksStore((s) => s.running.length);

  const [uptimeSec, setUptimeSec] = useState(0);
  const [rate, setRate] = useState(0);

  const isOpen = sessionState === 'open';

  useEffect(() => {
    if (!isOpen || openedAt === 0) {
      setUptimeSec(0);
      setRate(0);
      return;
    }
    const tick = setInterval(() => {
      setUptimeSec(Math.max(0, Math.floor((Date.now() - openedAt) / 1000)));
      setRate(consumeThroughputWindow());
    }, 1000);
    return () => clearInterval(tick);
  }, [isOpen, openedAt]);

  const parity = options.parity === 'none' ? 'N' : options.parity === 'even' ? 'E' : 'O';
  const config = `${portLabel} @ ${options.baudRate} ${options.dataBits}${parity}${options.stopBits} · ${t.flow} ${
    options.flowControl === 'none' ? t.none : 'RTS/CTS'
  }`;

  const minutes = String(Math.floor(uptimeSec / 60)).padStart(2, '0');
  const seconds = String(uptimeSec % 60).padStart(2, '0');

  return (
    <footer className={styles.bar}>
      <span>{config}</span>
      <span className={styles.rx}>
        RX {rxBytes} B · {rxFrames} {t.frames}
      </span>
      <span className={styles.tx}>
        TX {txBytes} B · {txFrames} {t.frames}
      </span>
      <span>
        {t.uptime} {isOpen ? `${minutes}:${seconds}` : '--:--'}
      </span>
      <span className={styles.faint}>{isOpen ? `${rate} B/s` : ''}</span>
      <span className={styles.right}>
        {runningCount > 0 ? t.runningTasks(runningCount) : t.noTimer}
      </span>
    </footer>
  );
}
