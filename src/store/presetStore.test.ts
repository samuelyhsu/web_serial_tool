import { describe, expect, it } from 'vitest';
import { zh } from '@/i18n/zh';
import {
  parseImportedPresets,
  presetLabel,
  PRESET_COUNT,
  usePresetStore,
  type Preset,
} from './presetStore';

function importOrThrow(raw: string): Preset[] {
  const result = parseImportedPresets(raw);
  if (!result.ok) throw new Error(result.reason);
  return result.presets;
}

describe('预设导出 → 导入', () => {
  it('内置预设经过一轮往返后名字不丢', () => {
    // 内置预设的 name 是空串、名字来自翻译目录。导入端若丢掉 labelKey，
    // 这十条就会全部塌成兜底的 'preset'。
    const before = usePresetStore
      .getState()
      .presets.slice(0, 10)
      .map((preset) => presetLabel(preset, zh));

    const restored = importOrThrow(usePresetStore.getState().exportPayload());
    const after = restored.slice(0, 10).map((preset) => presetLabel(preset, zh));

    expect(after).toEqual(before);
    expect(after).not.toContain('preset');
  });

  it('往返后内置预设仍随语言切换（labelKey 保住了才有这个性质）', () => {
    const restored = importOrThrow(usePresetStore.getState().exportPayload());
    expect(restored[0]!.labelKey).toBe('queryVersion');
  });

  it('用户改过名的预设不会被误认成内置项', () => {
    const raw = JSON.stringify({
      version: 1,
      presets: [{ name: '电机自检', labelKey: 'queryVersion', data: 'AT+X', mode: 'text' }],
    });
    // name 非空即用户命名优先，labelKey 不该把它盖掉
    expect(presetLabel(importOrThrow(raw)[0]!, zh)).toBe('电机自检');
  });

  it('伪造的 labelKey 被拒绝，退回普通预设', () => {
    const raw = JSON.stringify({
      version: 1,
      presets: [{ name: '', labelKey: '__evil__', data: 'AT' }],
    });
    const preset = importOrThrow(raw)[0]!;
    expect(preset.labelKey).toBeNull();
    expect(presetLabel(preset, zh)).toBe('preset');
  });

  it('条数补齐到固定总数', () => {
    const raw = JSON.stringify({ version: 1, presets: [{ name: 'a', data: 'AT' }] });
    expect(importOrThrow(raw)).toHaveLength(PRESET_COUNT);
  });
});
