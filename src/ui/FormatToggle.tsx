import { FORMAT_LABEL, type DataFormat } from './dataFormat';
import { useMessages } from './useMessages';

interface Props {
  value: DataFormat;
  onChange: (next: DataFormat) => void;
  /** 预设行那种密集排版下用小号。 */
  compact?: boolean;
  disabled?: boolean;
}

/**
 * 数据格式切换：一个按钮，显示当前格式，点击切到另一种。
 *
 * 接收区、发送区、每条预设都用它 —— 之前接收区和发送区是两个按钮的分段控件，
 * 预设行却是单按钮，同一件事三处两种样子。
 *
 * 无障碍要点：按钮上的可见文字是**当前状态**而非动作，所以不能直接把它当可访问名。
 * aria-label 里同时给出当前格式和点击后的结果，屏幕阅读器用户才知道现在是什么、按下去会变成什么。
 */
export function FormatToggle({ value, onChange, compact, disabled }: Props): React.JSX.Element {
  const t = useMessages();
  const next: DataFormat = value === 'hex' ? 'text' : 'hex';

  return (
    <button
      type="button"
      className={`formatToggle${compact ? ' formatToggle--sm' : ''}`}
      data-format={value}
      title={t.toggleHexMode}
      aria-label={t.formatToggleLabel(FORMAT_LABEL[value], FORMAT_LABEL[next])}
      disabled={disabled}
      onClick={() => onChange(next)}
    >
      {FORMAT_LABEL[value]}
    </button>
  );
}
