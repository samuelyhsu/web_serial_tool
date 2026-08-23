import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { downloadText } from '@/lib/download';
import { useConnectionStore } from '@/store/connectionStore';
import { useLogStore } from '@/store/logStore';
import {
  parseImportedPresets,
  PRESET_PAGE_SIZE,
  PRESET_PAGES,
  presetLabel,
  usePresetStore,
  type Preset,
} from '@/store/presetStore';
import { isTaskRunning, presetTask, SEQUENCE_TASK, useTasksStore } from '@/store/tasksStore';
import { FormatToggle } from '../FormatToggle';
import { useMessages } from '../useMessages';
import styles from './PresetPane.module.css';

export function PresetPane(): React.JSX.Element {
  const t = useMessages();
  const gapId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [gapMs, setGapMs] = useState(300);

  const presets = usePresetStore((s) => s.presets);
  const page = usePresetStore((s) => s.page);
  const setPage = usePresetStore((s) => s.setPage);
  const issues = usePresetStore((s) => s.issues);
  const replaceAll = usePresetStore((s) => s.replaceAll);
  const exportPayload = usePresetStore((s) => s.exportPayload);
  const toggleSequence = usePresetStore((s) => s.toggleSequence);

  const running = useTasksStore((s) => s.running);
  const stopAll = useTasksStore((s) => s.stopAll);
  const isOpen = useConnectionStore((s) => s.sessionState) === 'open';

  // 顺序循环跨页生效：勾选的含义是「参与循环」，与当前看的是哪一页无关
  const inSequenceCount = presets.filter((preset) => preset.inSequence).length;
  const pagePresets = presets.slice(page * PRESET_PAGE_SIZE, (page + 1) * PRESET_PAGE_SIZE);
  const sequenceRunning = isTaskRunning(running, SEQUENCE_TASK);

  const onExport = useCallback(() => {
    downloadText('serial-presets.json', exportPayload(), 'application/json');
    useLogStore.getState().appendMessage(t.exportedPresets);
  }, [exportPayload, t]);

  const onImportFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      void file.text().then((raw) => {
        const result = parseImportedPresets(raw);
        const log = useLogStore.getState();
        if (!result.ok) {
          log.appendMessage(t.importFailed(result.reason));
          return;
        }
        replaceAll(result.presets);
        log.appendMessage(t.importedPresets(result.presets.length));
        if (result.skipped > 0) {
          // 原型是静默截断的；跳过了多少条必须让用户知道（缺陷 D17）
          log.appendMessage(t.importFailed(`${result.skipped} skipped`));
        }
      });
    },
    [replaceAll, t],
  );

  const onStopAll = useCallback(() => {
    stopAll();
    useLogStore.getState().appendMessage(t.stoppedAll);
  }, [stopAll, t]);

  return (
    <aside className={styles.pane} aria-label={t.multiSend}>
      <div className={styles.head}>
        <span className="panelTitle">{t.multiSend}</span>
        <div className={styles.pager}>
          <button
            type="button"
            className={`btn ${styles.pageBtn}`}
            disabled={page === 0}
            aria-label={t.prevPage}
            onClick={() => setPage(page - 1)}
          >
            ‹
          </button>
          <span className={styles.pageLabel}>{t.pageIndicator(page + 1, PRESET_PAGES)}</span>
          <button
            type="button"
            className={`btn ${styles.pageBtn}`}
            disabled={page >= PRESET_PAGES - 1}
            aria-label={t.nextPage}
            onClick={() => setPage(page + 1)}
          >
            ›
          </button>
        </div>

        <div className={styles.headActions}>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            {t.import}
          </button>
          <button type="button" className="btn" onClick={onExport}>
            {t.export}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={onImportFile}
          />
        </div>
      </div>

      <div className={styles.columns}>
        <span>{t.colSequence}</span>
        <span>{t.colFormat}</span>
        <span>{t.colData}</span>
        <span>{t.colSend}</span>
        <span />
        <span>{t.colPeriod}</span>
        <span className={styles.columnLoop}>{t.colLoop}</span>
      </div>

      <div className={styles.list}>
        {pagePresets.map((preset) => (
          <PresetRow
            key={preset.id}
            preset={preset}
            invalid={issues[preset.id]?.kind === 'parse'}
            looping={isTaskRunning(running, presetTask(preset.id))}
            canSend={isOpen}
          />
        ))}
      </div>

      <div className={styles.footer}>
        <div className={styles.footerRow}>
          <span className="label">{t.sequenceLoop}</span>
          <span className={styles.count}>{t.sequenceHint(inSequenceCount)}</span>
          <div className={styles.footerRight}>
            <label className="label" htmlFor={gapId}>
              {t.gap}
            </label>
            <input
              id={gapId}
              type="number"
              className={`field field--sunk field--sm ${styles.gapInput}`}
              value={gapMs}
              min={10}
              step={10}
              onChange={(event) => setGapMs(Math.max(10, Number(event.target.value) || 10))}
            />
            <span className="label">ms</span>
          </div>
        </div>

        <div className={styles.footerActions}>
          <button
            type="button"
            className={`btn ${styles.seqBtn} ${sequenceRunning ? 'btn--on' : ''}`}
            aria-pressed={sequenceRunning}
            disabled={!sequenceRunning && (!isOpen || inSequenceCount === 0)}
            onClick={() => toggleSequence(gapMs)}
          >
            {sequenceRunning ? t.stopSequence : t.startSequence}
          </button>
          <button
            type="button"
            className={`btn btn--danger ${styles.stopAllBtn}`}
            disabled={running.length === 0}
            onClick={onStopAll}
          >
            {t.stopAll}
          </button>
        </div>
      </div>
    </aside>
  );
}

interface RowProps {
  preset: Preset;
  invalid: boolean;
  looping: boolean;
  canSend: boolean;
}

/**
 * 一条预设一行，列序固定：勾选 · 格式 · 数据 · 发送 · 周期 · 循环。
 *
 * 名称不单独占一列 —— 它就是发送按钮上的文字，点旁边的 ✎ 才切换成输入框改名，
 * 改完即收起。这样常态下一行只有六个控件，比原来的两行布局密度和可读性都更好。
 */
function PresetRow({ preset, invalid, looping, canSend }: RowProps): React.JSX.Element {
  const t = useMessages();
  const nameRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  const rename = usePresetStore((s) => s.rename);
  const setData = usePresetStore((s) => s.setData);
  const setInterval = usePresetStore((s) => s.setInterval);
  const setInSequence = usePresetStore((s) => s.setInSequence);
  const toggleMode = usePresetStore((s) => s.toggleMode);
  const sendOnce = usePresetStore((s) => s.sendOnce);
  const toggleLoop = usePresetStore((s) => s.toggleLoop);

  const label = presetLabel(preset, t);
  const empty = preset.data.trim() === '';

  // select() 按规范不移动焦点，必须先 focus()
  useEffect(() => {
    if (!renaming) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [renaming]);

  const commit = useCallback(() => {
    // 名称留空没有意义 —— 按钮上就没字了，保持原名
    if (draft.trim() !== '') rename(preset.id, draft);
    setRenaming(false);
  }, [rename, preset.id, draft]);

  return (
    <div className={styles.row} data-looping={looping}>
      <input
        type="checkbox"
        className={styles.seq}
        checked={preset.inSequence}
        aria-label={`${label} ${t.colSequence}`}
        onChange={(event) => setInSequence(preset.id, event.target.checked)}
      />

      <FormatToggle compact value={preset.mode} onChange={() => toggleMode(preset.id)} />

      <input
        className={styles.data}
        value={preset.data}
        spellCheck={false}
        placeholder={t.dataPlaceholder}
        aria-label={`${label} ${t.colData}`}
        aria-invalid={invalid}
        onChange={(event) => setData(preset.id, event.target.value)}
      />

      {renaming ? (
        <input
          ref={nameRef}
          className={styles.nameInput}
          value={draft}
          maxLength={16}
          aria-label={t.renamePreset}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setRenaming(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={styles.sendBtn}
          disabled={!canSend || invalid || empty}
          title={label}
          onClick={() => void sendOnce(preset.id)}
        >
          {label}
        </button>
      )}

      <button
        type="button"
        className={styles.renameBtn}
        title={t.renamePreset}
        aria-label={`${t.renamePreset}: ${label}`}
        onClick={() => {
          setDraft(label);
          setRenaming(true);
        }}
      >
        ✎
      </button>

      <input
        type="number"
        className={`field field--sunk field--sm ${styles.intervalInput}`}
        value={preset.intervalMs}
        min={10}
        step={10}
        aria-label={`${label} ${t.colPeriod}`}
        onChange={(event) => setInterval(preset.id, Number(event.target.value))}
      />

      <button
        type="button"
        className={`btn ${styles.loopBtn} ${looping ? 'btn--on' : ''}`}
        aria-pressed={looping}
        aria-label={`${looping ? t.stop : t.loop}: ${label}`}
        disabled={!looping && (!canSend || invalid || empty)}
        onClick={() => toggleLoop(preset.id)}
      >
        {looping ? '■' : '↻'}
      </button>
    </div>
  );
}
