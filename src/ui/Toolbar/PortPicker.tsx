import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useConnectionStore } from '@/store/connectionStore';
import { useLogStore } from '@/store/logStore';
import {
  aliasOf,
  MAX_ALIAS_LENGTH,
  portDisplayLabel,
  usePortAliasStore,
} from '@/store/portAliasStore';
import { useMessages } from '../useMessages';
import styles from './Toolbar.module.css';

/**
 * 端口选择器 —— 单端口语义。
 *
 * 之前是「下拉框 + 添加端口 + 撤销授权 + 备注输入框 + 已授权数量」五个常驻控件，
 * 但浏览器本来就只允许通过它自己的选择器授权端口，页面侧再维护一份列表意义不大。
 * 现在只留两个：一个显示/切换当前端口的按钮，一个改备注的 ✎。
 * 备注输入框只在刚选完端口、或点 ✎ 时出现，用完即收起。
 */
export function PortPicker(): React.JSX.Element {
  const t = useMessages();
  const aliasId = useId();
  const aliasRef = useRef<HTMLInputElement>(null);

  const supported = useConnectionStore((s) => s.supported);
  const sessionState = useConnectionStore((s) => s.sessionState);
  const requestPort = useConnectionStore((s) => s.requestPort);
  // ports 变化时要重新求值，所以订阅它而不是只调 getter
  const selected = useConnectionStore((s) =>
    s.ports.find((port) => port.key === s.selectedPortKey),
  );

  const aliases = usePortAliasStore((s) => s.aliases);
  const setAlias = usePortAliasStore((s) => s.setAlias);

  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');

  const locked = sessionState !== 'closed';

  // 备注框出现时自动聚焦并全选，选完端口可以直接打字。
  // select() 按规范不移动焦点，必须先 focus()。
  useEffect(() => {
    if (!naming) return;
    aliasRef.current?.focus();
    aliasRef.current?.select();
  }, [naming]);

  const startNaming = useCallback(() => {
    setDraft(aliasOf(selected, aliases));
    setNaming(true);
  }, [selected, aliases]);

  const commitNaming = useCallback(() => {
    if (selected) setAlias(selected.identity, draft);
    setNaming(false);
  }, [selected, draft, setAlias]);

  const onPick = useCallback(() => {
    void requestPort()
      .then((port) => {
        useLogStore.getState().appendMessage(t.portAuthorized);
        // 选完立刻提示起名：这是用户唯一能给端口加上可辨识信息的机会
        setDraft(usePortAliasStore.getState().aliases[port.identity] ?? '');
        setNaming(true);
      })
      .catch((error: unknown) => {
        const log = useLogStore.getState();
        const name = error instanceof DOMException ? error.name : '';
        if (name === 'NotFoundError') log.appendMessage(t.portPickerDismissed);
        else if (name === 'SecurityError' || name === 'NotAllowedError')
          log.appendMessage(t.portPickerBlocked);
        else
          log.appendMessage(
            t.portRequestFailed(error instanceof Error ? error.message : String(error)),
          );
      });
  }, [requestPort, t]);

  return (
    <div className={styles.group}>
      <span className="label">{t.port}</span>

      <button
        type="button"
        className={`btn ${styles.portButton}`}
        onClick={onPick}
        disabled={!supported || locked}
        title={selected ? t.changePortTip : t.selectPortTip}
      >
        {selected ? (
          <>
            <span className={styles.portName}>{portDisplayLabel(selected, aliases)}</span>
            {!selected.connected ? (
              <span className={styles.portState}> · {t.portUnplugged}</span>
            ) : null}
          </>
        ) : (
          t.selectPort
        )}
      </button>

      {selected && !naming ? (
        <button
          type="button"
          className="btn"
          onClick={startNaming}
          title={t.aliasTip}
          aria-label={t.aliasLabel}
        >
          ✎
        </button>
      ) : null}

      {selected && naming ? (
        <>
          <label className="visuallyHidden" htmlFor={aliasId}>
            {t.aliasLabel}
          </label>
          <input
            id={aliasId}
            ref={aliasRef}
            className={`field ${styles.aliasInput}`}
            value={draft}
            placeholder={t.aliasPlaceholder}
            title={t.aliasTip}
            maxLength={MAX_ALIAS_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitNaming}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitNaming();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setNaming(false);
              }
            }}
          />
        </>
      ) : null}
    </div>
  );
}
