import { useEffect, useState } from 'react';
import { IDLE_FRAME_MS_MAX } from '@/store/uiStore';
import styles from './LogPane.module.css';

interface Props {
  id: string;
  label: string;
  value: number;
  onCommit: (value: number) => void;
}

/**
 * 空闲时长输入框。
 *
 * 与波特率输入框同样持一份本地草稿，原因在这里更硬：直接把每次按键的结果写进 store 的话，
 * 「选中重打」这个再常规不过的动作会先让输入框变空，空串被当成 0，而 0 表示不分帧 ——
 * 于是这个输入框自己就消失了，新值根本打不完。
 *
 * 草稿只在解析得出数字时才提交；空串是编辑中间态，不动 store。失焦时若草稿无效，
 * 回填当前生效值，不把一个空框留在界面上。
 */
export function IdleFrameInput({ id, label, value, onCommit }: Props): React.JSX.Element {
  const [draft, setDraft] = useState(() => String(value));

  // store 里的值被别处改动时同步过来，但不打断正在输入的内容
  useEffect(() => {
    setDraft((current) => (Number(current) === value ? current : String(value)));
  }, [value]);

  return (
    <input
      id={id}
      type="number"
      className={`field field--sunk field--sm ${styles.idleInput}`}
      value={draft}
      min={0}
      max={IDLE_FRAME_MS_MAX}
      step={5}
      aria-label={label}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (next.trim() === '') return; // 编辑中间态，先不提交
        const parsed = Number(next);
        if (Number.isFinite(parsed)) onCommit(parsed);
      }}
      onBlur={() => {
        if (draft.trim() === '' || !Number.isFinite(Number(draft))) setDraft(String(value));
      }}
    />
  );
}
