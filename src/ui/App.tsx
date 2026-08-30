import { useEffect } from 'react';
import {
  disposeSession,
  useConnectionStore,
  useSelectedPortLabel,
  watchPortChanges,
} from '@/store/connectionStore';
import { setSelectorMessages } from '@/store/logStore';
import { useTasksStore } from '@/store/tasksStore';
import { useUiStore } from '@/store/uiStore';
import styles from './App.module.css';
import { ErrorBoundary } from './ErrorBoundary';
import { LogPane } from './LogPane/LogPane';
import { PresetPane } from './PresetPane/PresetPane';
import { SendPane } from './SendPane/SendPane';
import { StatusBar } from './StatusBar/StatusBar';
import { Toolbar } from './Toolbar/Toolbar';
import { UnsupportedBanner } from './UnsupportedBanner';
import { useMessages } from './useMessages';

export function App(): React.JSX.Element {
  const t = useMessages();
  const theme = useUiStore((state) => state.theme);
  const language = useUiStore((state) => state.language);
  const supported = useConnectionStore((state) => state.supported);
  const refreshPorts = useConnectionStore((state) => state.refreshPorts);
  const sessionState = useConnectionStore((state) => state.sessionState);
  const portLabel = useSelectedPortLabel();

  // 日志选择器不是组件，拿不到 context，语言变化时把目录推给它
  useEffect(() => {
    setSelectorMessages(t);
  }, [t]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 同时开多个页面各连一个端口时，浏览器标签条上只剩标题能分辨谁是谁。
  // 前面那个圆点用来一眼看出哪个页面正连着。
  useEffect(() => {
    const dot = sessionState === 'open' ? '● ' : '';
    document.title = portLabel === '—' ? t.app : `${dot}${portLabel} · ${t.app}`;
  }, [portLabel, sessionState, t]);

  // 语言切换必须同步到 <html lang>：屏幕阅读器按它挑发音，
  // 写死 zh-CN 会让切到英文的界面被用中文腔读出来
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

  useEffect(() => {
    void refreshPorts();
    const unwatch = watchPortChanges();
    return () => {
      unwatch();
      // 卸载时必须停掉周期任务并关闭端口，否则热更新会留下孤儿定时器和被占用的端口
      useTasksStore.getState().stopAll();
      disposeSession();
    };
  }, [refreshPorts]);

  return (
    <ErrorBoundary messages={t}>
      <div className={styles.shell}>
        <Toolbar />
        {supported ? null : <UnsupportedBanner messages={t} />}
        <main className={styles.main}>
          <LogPane />
          <div className={styles.right}>
            <SendPane />
            <PresetPane />
          </div>
        </main>
        <StatusBar />
      </div>
    </ErrorBoundary>
  );
}
