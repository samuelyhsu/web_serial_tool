import { useEffect, useId, useState } from 'react';
import {
  BAUD_RATE_MAX,
  BAUD_RATE_MIN,
  BAUD_RATES,
  isValidBaudRate,
  useConnectionStore,
} from '@/store/connectionStore';
import { useMessages } from '../useMessages';
import styles from './Toolbar.module.css';

/**
 * 波特率输入：一个既能从建议列表里选、又能直接输入任意值的组合框。
 *
 * 用 input + datalist 而不是「下拉框 + 一个『自定义』开关」，是为了让常用档位和
 * 自定义值共用同一个控件 —— 多一个开关就多一个要维护的状态和一次多余的点击。
 *
 * 输入过程中值可能是空串或半截数字，所以本地留一份草稿，只有合法时才提交到 store；
 * 不合法时把输入框标红，但保留用户已经打进去的内容，不做打断式的纠正。
 */
export function BaudRateInput({ disabled }: { disabled: boolean }): React.JSX.Element {
  const t = useMessages();
  const inputId = useId();
  const listId = useId();

  const baudRate = useConnectionStore((s) => s.options.baudRate);
  const setOptions = useConnectionStore((s) => s.setOptions);

  const [draft, setDraft] = useState(() => String(baudRate));

  // store 里的值被别处改动时（例如将来从配置恢复）同步过来；
  // 但不要打断正在输入的内容 —— 草稿解析后与 store 一致就保持原样
  useEffect(() => {
    setDraft((current) => (Number(current) === baudRate ? current : String(baudRate)));
  }, [baudRate]);

  const valid = isValidBaudRate(Number(draft)) && draft.trim() !== '';

  return (
    <>
      <label className="label" htmlFor={inputId}>
        {t.baud}
      </label>
      <input
        id={inputId}
        type="number"
        list={listId}
        className={`field ${styles.baudInput} ${valid ? '' : 'field--invalid'}`}
        value={draft}
        min={BAUD_RATE_MIN}
        max={BAUD_RATE_MAX}
        step={1}
        disabled={disabled}
        aria-invalid={!valid}
        title={t.baudTip}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = Number(next);
          if (next.trim() !== '' && isValidBaudRate(parsed)) setOptions({ baudRate: parsed });
        }}
        onBlur={() => {
          // 失焦时若仍不合法，回退到最后一个有效值，别把非法状态留在界面上
          if (!valid) setDraft(String(baudRate));
        }}
      />
      <datalist id={listId}>
        {BAUD_RATES.map((rate) => (
          <option key={rate} value={rate} />
        ))}
      </datalist>
    </>
  );
}
