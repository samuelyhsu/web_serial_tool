import { useId, useMemo } from 'react';
import { CHECKSUM_ALGORITHMS, checksumBytes, findChecksum } from '@/core/checksum';
import { formatHex } from '@/core/codec/hex';
import { useConnectionStore } from '@/store/connectionStore';
import { buildFrame, payloadToBytes, EOL_KEYS, type EolKey } from '@/store/payload';
import { useSendStore } from '@/store/sendStore';
import { isTaskRunning, SINGLE_TASK, useTasksStore } from '@/store/tasksStore';
import { FormatToggle } from '../FormatToggle';
import { useMessages } from '../useMessages';
import styles from './SendPane.module.css';

const EOL_LABELS: Record<EolKey, string> = {
  none: '—',
  crlf: '\\r\\n',
  lf: '\\n',
  cr: '\\r',
};

export function SendPane(): React.JSX.Element {
  const t = useMessages();
  const editorId = useId();
  const eolId = useId();
  const checksumId = useId();
  const intervalId = useId();

  const payload = useSendStore((s) => s.payload);
  const mode = useSendStore((s) => s.mode);
  const eol = useSendStore((s) => s.eol);
  const checksum = useSendStore((s) => s.checksum);
  const intervalMs = useSendStore((s) => s.intervalMs);
  const parseError = useSendStore((s) => s.parseError);
  const modeIssue = useSendStore((s) => s.modeIssue);

  const setPayload = useSendStore((s) => s.setPayload);
  const setMode = useSendStore((s) => s.setMode);
  const setEol = useSendStore((s) => s.setEol);
  const setChecksum = useSendStore((s) => s.setChecksum);
  const setIntervalMs = useSendStore((s) => s.setIntervalMs);
  const sendOnce = useSendStore((s) => s.sendOnce);
  const toggleLoop = useSendStore((s) => s.toggleLoop);

  const running = useTasksStore((s) => s.running);
  const looping = isTaskRunning(running, SINGLE_TASK);
  const isOpen = useConnectionStore((s) => s.sessionState) === 'open';

  // 真正会写到串口上的字节：文本模式下含结束符。
  // 显示成「N 字节」的必须是这个数，否则用户对不上抓包结果。
  const frame = useMemo(
    () => buildFrame(payload, mode, eol, checksum),
    [payload, mode, eol, checksum],
  );

  // 每次数据变更都重算所选校验和，直接显示将要追加的字节
  const checksumPreview = useMemo(() => {
    const algorithm = findChecksum(checksum);
    if (!algorithm || mode !== 'hex') return null;
    const parsed = payloadToBytes(payload, 'hex');
    if (!parsed.ok) return null;
    return formatHex(checksumBytes(parsed.bytes, algorithm));
  }, [payload, mode, checksum]);

  const issueText = parseError
    ? t.hexError(parseError)
    : modeIssue
      ? modeIssue.kind === 'lossy'
        ? t.lossyHexSwitch
        : t.hexError(modeIssue.error)
      : null;

  const canSend = isOpen && frame.ok && frame.bytes.length > 0;

  return (
    <section className={styles.pane} aria-label={t.singleSend}>
      <div className={styles.head}>
        <span className="panelTitle">{t.singleSend}</span>

        <FormatToggle value={mode} onChange={setMode} />

        {/* TXT 与 HEX 各有自己的「帧尾」控件，同一位置互斥显示 */}
        {mode === 'text' ? (
          <>
            <label className="label" htmlFor={eolId}>
              {t.eol}
            </label>
            <select
              id={eolId}
              className="field field--sm"
              value={eol}
              onChange={(event) => setEol(event.target.value as EolKey)}
            >
              {EOL_KEYS.map((key) => (
                <option key={key} value={key}>
                  {key === 'none' ? t.none : EOL_LABELS[key]}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label className="label" htmlFor={checksumId}>
              {t.checksum}
            </label>
            <select
              id={checksumId}
              className={`field field--sm ${styles.checksumSelect}`}
              value={checksum}
              onChange={(event) => setChecksum(event.target.value)}
            >
              <option value="none">{t.none}</option>
              {CHECKSUM_ALGORITHMS.map((algorithm) => (
                <option key={algorithm.id} value={algorithm.id}>
                  {algorithm.label}
                </option>
              ))}
            </select>
            {checksumPreview !== null ? (
              <span className={styles.checksumValue} title={t.checksumAppendTip}>
                {checksumPreview}
              </span>
            ) : null}
          </>
        )}
      </div>

      <div className={styles.editor}>
        <label className="visuallyHidden" htmlFor={editorId}>
          {t.payloadLabel}
        </label>
        <textarea
          id={editorId}
          className={styles.textarea}
          value={payload}
          spellCheck={false}
          placeholder={t.singlePlaceholder}
          aria-invalid={parseError !== null}
          onChange={(event) => setPayload(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void sendOnce();
            }
          }}
        />

        <div className={styles.side}>
          <button
            type="button"
            className={styles.sendBtn}
            disabled={!canSend}
            onClick={() => void sendOnce()}
          >
            {t.send}
          </button>

          <div className={styles.loopBox}>
            <label className="label" htmlFor={intervalId}>
              {t.period}
            </label>
            <input
              id={intervalId}
              type="number"
              className={`field field--sunk field--sm ${styles.loopInput}`}
              value={intervalMs}
              min={10}
              step={10}
              onChange={(event) => setIntervalMs(Number(event.target.value))}
            />
            <span className="label">ms</span>
            <button
              type="button"
              className={`btn ${styles.loopBtn} ${looping ? 'btn--on' : ''}`}
              aria-pressed={looping}
              disabled={!looping && !canSend}
              onClick={toggleLoop}
            >
              {looping ? t.stop : t.loop}
            </button>
          </div>
        </div>
      </div>

      {issueText ? (
        <div className={styles.message} role="alert">
          {issueText}
        </div>
      ) : null}
    </section>
  );
}
