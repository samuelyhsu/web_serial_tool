import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { downloadText, fileStamp } from '@/lib/download';
import {
  allEntries,
  entryBody,
  flushPendingEntries,
  formatTime,
  selectRows,
  useLogStore,
  type LogRow,
} from '@/store/logStore';
import { useConnectionStore } from '@/store/connectionStore';
import { IDLE_FRAME_MS_MAX, useUiStore } from '@/store/uiStore';
import { FormatToggle } from '../FormatToggle';
import { useMessages } from '../useMessages';
import styles from './LogPane.module.css';

/** 最多渲染多少行。与原型一致；再多也超出一屏，只会拖慢渲染。 */
const RENDER_LIMIT = 600;
/** 距底部多少像素以内算作「贴底」。 */
const BOTTOM_THRESHOLD = 24;

const ARROWS: Record<LogRow['kind'], string> = { rx: '◀', tx: '▶', sys: '·' };

export function LogPane(): React.JSX.Element {
  const t = useMessages();
  const filterId = useId();
  const idleId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const version = useLogStore((s) => s.version);
  const clear = useLogStore((s) => s.clear);

  const language = useUiStore((s) => s.language);
  const view = useUiStore((s) => s.view);
  const showTimestamp = useUiStore((s) => s.showTimestamp);
  const autoScroll = useUiStore((s) => s.autoScroll);
  const showTx = useUiStore((s) => s.showTx);
  const filter = useUiStore((s) => s.filter);
  const onlyMatch = useUiStore((s) => s.onlyMatch);
  const idleFrameMs = useUiStore((s) => s.idleFrameMs);
  const lineFraming = useUiStore((s) => s.lineFraming);
  // 逐个订阅 action：selector 返回新对象会让 zustand 每次快照都不相等，触发无谓重渲染
  const setView = useUiStore((s) => s.setView);
  const setShowTimestamp = useUiStore((s) => s.setShowTimestamp);
  const setAutoScroll = useUiStore((s) => s.setAutoScroll);
  const setShowTx = useUiStore((s) => s.setShowTx);
  const setFilter = useUiStore((s) => s.setFilter);
  const setOnlyMatch = useUiStore((s) => s.setOnlyMatch);
  const setIdleFrameMs = useUiStore((s) => s.setIdleFrameMs);
  const setLineFraming = useUiStore((s) => s.setLineFraming);

  // 换行分帧只在 TXT 视图下生效，与 core 里 resolveFraming 的判断保持一致
  const lineActive = lineFraming && view === 'text';

  const sessionState = useConnectionStore((s) => s.sessionState);

  // 缺陷 D7：记忆化的选择器，重渲染不重算；输入过滤词时也只算一次
  const rows = selectRows({
    version,
    language,
    view,
    filter,
    onlyMatch,
    showTx,
    showTimestamp,
    limit: RENDER_LIMIT,
  });

  /**
   * 缺陷 D15：原型在每次更新后无条件把滚动条拉到底，用户往上翻查历史时会被强行拽回。
   * 这里跟踪用户是否还贴着底部，离开底部就暂停自动滚屏，并给一个回底按钮。
   */
  const [atBottom, setAtBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setAtBottom(distance <= BOTTOM_THRESHOLD);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setAtBottom(true);
  }, []);

  useLayoutEffect(() => {
    if (!autoScroll || !atBottom) return;
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [rows, autoScroll, atBottom]);

  // 重新勾选「自动滚屏」时立即回到底部，符合直觉
  useEffect(() => {
    if (autoScroll) scrollToBottom();
  }, [autoScroll, scrollToBottom]);

  const saveLog = useCallback(() => {
    flushPendingEntries(); // 否则最近 60ms 内收到的帧会漏出导出文件
    const entries = allEntries();
    const text = entries
      .map((entry) => {
        const tag = entry.kind === 'rx' ? '[RX]' : entry.kind === 'tx' ? '[TX]' : '[--]';
        return `${formatTime(entry.time)} ${tag} ${entryBody(entry, view, t)}`;
      })
      .join('\n');
    downloadText(`serial-${fileStamp()}.log`, text);
    useLogStore.getState().appendMessage(t.exportedLog(entries.length));
  }, [view, t]);

  const onClear = useCallback(() => {
    clear();
    useLogStore.getState().appendMessage(t.clearedLog);
  }, [clear, t]);

  const showJump = !atBottom && rows.length > 0;

  return (
    <section className={styles.pane} aria-label={t.receive}>
      <div className={styles.toolbar}>
        <span className="panelTitle">{t.receive}</span>

        <FormatToggle value={view} onChange={setView} />

        <label className="check">
          <input
            type="checkbox"
            checked={showTimestamp}
            onChange={(event) => setShowTimestamp(event.target.checked)}
          />
          {t.timestamp}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(event) => setAutoScroll(event.target.checked)}
          />
          {t.autoScroll}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showTx}
            onChange={(event) => setShowTx(event.target.checked)}
          />
          {t.showTx}
        </label>

        <span className={styles.divider} aria-hidden="true" />

        {/*
          分帧：空闲毫秒数 + 换行开关。两者互斥，因此开了换行分帧就把毫秒输入禁用掉，
          而不是让用户面对两个都能点、实际只有一个生效的控件。
        */}
        <label className="label" htmlFor={idleId} title={t.idleFrameHint}>
          {t.idleFrame}
        </label>
        <input
          id={idleId}
          type="number"
          className={`field field--sunk field--sm ${styles.idleInput}`}
          value={idleFrameMs}
          min={0}
          max={IDLE_FRAME_MS_MAX}
          step={5}
          disabled={lineActive}
          title={t.idleFrameHint}
          onChange={(event) => setIdleFrameMs(Number(event.target.value))}
        />
        <span className="label">{t.idleFrameUnit}</span>

        {/* 换行分帧只在 TXT 视图下有意义：HEX 视图里按 `\n` 切没有意义 */}
        {view === 'text' ? (
          <label className="check" title={t.lineFrameHint}>
            <input
              type="checkbox"
              checked={lineFraming}
              onChange={(event) => setLineFraming(event.target.checked)}
            />
            {t.lineFrame}
          </label>
        ) : null}

        <span className={styles.frameHint}>
          {lineActive ? t.lineFrameHint : idleFrameMs === 0 ? t.rawFrameHint : t.idleFrameHint}
        </span>

        {autoScroll && !atBottom ? <span className="label">{t.scrollPaused}</span> : null}

        <div className={styles.toolbarRight}>
          <label className="visuallyHidden" htmlFor={filterId}>
            {t.filterPlaceholder}
          </label>
          <input
            id={filterId}
            className={`field ${styles.filterInput}`}
            value={filter}
            placeholder={t.filterPlaceholder}
            onChange={(event) => setFilter(event.target.value)}
          />
          <label className="check check--amber">
            <input
              type="checkbox"
              checked={onlyMatch}
              onChange={(event) => setOnlyMatch(event.target.checked)}
            />
            {t.onlyMatch}
          </label>
          <button type="button" className="btn" onClick={saveLog}>
            {t.saveLog}
          </button>
          <button type="button" className="btn btn--danger" onClick={onClear}>
            {t.clear}
          </button>
        </div>
      </div>

      <div ref={listRef} className={styles.list} onScroll={handleScroll} role="log">
        {rows.length === 0 ? (
          <div className={styles.empty}>
            <div>{t.noData}</div>
            {sessionState === 'closed' ? (
              <div className={styles.emptyHint}>{t.noDataHint}</div>
            ) : null}
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.id} className={styles.row} data-kind={row.kind}>
              {row.timestamp ? <span className={styles.time}>{row.timestamp}</span> : null}
              <span className={styles.arrow} aria-hidden="true">
                {ARROWS[row.kind]}
              </span>
              <span className={styles.body}>
                {row.segments.map((segment, index) =>
                  segment.hit ? (
                    <mark key={index} className={styles.hit}>
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  ),
                )}
              </span>
            </div>
          ))
        )}
      </div>

      {showJump ? (
        <button type="button" className={styles.jump} onClick={scrollToBottom}>
          {t.jumpToBottom}
        </button>
      ) : null}
    </section>
  );
}
