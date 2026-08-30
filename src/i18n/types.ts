import type { HexParseError } from '@/core/codec/hex';
import type { SessionNotice } from '@/core/session/notices';

export type Language = 'zh' | 'en';

/**
 * 内置预设的翻译键。原型靠「比对当前名是否等于默认名」来决定要不要翻译
 * （.dc.html:724-730），用户改过名字就失效 —— 缺陷 D16。改成显式的 key：
 * 用户一旦改名，key 置空，此后这条预设不再随语言变化。
 */
/**
 * 内置预设的翻译键。
 *
 * 写成运行时常量再派生类型：导入预设时需要校验 labelKey 是否合法，
 * 光有类型联合在运行时拿不到列表。
 */
export const BUILTIN_PRESET_KEYS = [
  'queryVersion',
  'readStatus',
  'readTempHumidity',
  'readVoltage',
  'heartbeat',
  'relayOn',
  'relayOff',
  'outputEnable',
  'saveConfig',
  'softReset',
] as const;
export type BuiltinPresetKey = (typeof BUILTIN_PRESET_KEYS)[number];
export const LANGUAGES: readonly Language[] = ['zh', 'en'];

/**
 * 文案目录。
 *
 * 原型把中英文硬编码在业务分支里（`en ? "Port opened " : "串口已打开 "`，散落 20 多处），
 * 而且预设名的翻译靠「比对当前名是否等于默认名」来决定要不要替换（.dc.html:724-730），
 * 用户改过名字就失效 —— 缺陷 D16。这里把文案完全抽离，业务层只产出结构化事件。
 */
export interface Messages {
  readonly app: string;

  // 连接区
  readonly port: string;
  readonly baud: string;
  readonly baudTip: string;
  readonly dataBits: string;
  readonly parity: string;
  readonly stopBits: string;
  readonly flow: string;
  readonly none: string;
  readonly autoReconnect: string;
  readonly selectPort: string;
  readonly selectPortTip: string;
  readonly changePortTip: string;
  readonly portUnplugged: string;
  readonly portBusy: string;
  readonly aliasLabel: string;
  readonly aliasPlaceholder: string;
  readonly aliasTip: string;
  readonly openPort: string;
  readonly closePort: string;
  readonly disconnected: string;
  readonly opened: string;
  readonly opening: string;
  readonly reconnecting: string;
  readonly switchLanguage: string;
  readonly switchTheme: string;
  readonly payloadLabel: string;

  // 接收区
  readonly receive: string;
  readonly timestamp: string;
  readonly autoScroll: string;
  readonly showTx: string;
  readonly filterPlaceholder: string;
  readonly onlyMatch: string;

  // 分帧
  readonly framing: string;
  readonly frameModeRaw: string;
  readonly frameModeIdle: string;
  readonly frameModeLine: string;
  readonly idleFrame: string;
  readonly idleFrameUnit: string;
  readonly framingHint: Readonly<Record<'raw' | 'idle' | 'line', string>>;
  readonly saveLog: string;
  readonly clear: string;
  readonly noData: string;
  readonly noDataHint: string;
  readonly jumpToBottom: string;
  readonly scrollPaused: string;

  // 发送区
  readonly singleSend: string;
  readonly eol: string;
  readonly send: string;
  readonly singlePlaceholder: string;
  readonly period: string;
  readonly loop: string;
  readonly stop: string;
  readonly bytes: string;
  readonly checksum: string;
  readonly checksumAppendTip: string;

  // 预设区
  readonly multiSend: string;
  readonly import: string;
  readonly export: string;
  readonly colSequence: string;
  readonly colFormat: string;
  readonly colData: string;
  readonly colSend: string;
  readonly colPeriod: string;
  readonly colLoop: string;
  readonly dataPlaceholder: string;
  readonly sequenceLoop: string;
  readonly gap: string;
  readonly startSequence: string;
  readonly stopSequence: string;
  readonly stopAll: string;
  readonly renamePreset: string;
  readonly prevPage: string;
  readonly nextPage: string;
  readonly pageIndicator: (current: number, total: number) => string;
  readonly toggleHexMode: string;
  readonly formatToggleLabel: (current: string, next: string) => string;

  // 状态栏
  readonly frames: string;
  readonly uptime: string;
  readonly noTimer: string;
  /** 写队列积压。只在真的堵着时才显示，是背压最直接的观测点。 */
  readonly queued: (bytes: number) => string;

  // 浏览器支持
  readonly unsupportedTitle: string;
  readonly unsupportedBody: string;
  readonly unsupportedLink: string;

  // 错误边界
  readonly crashTitle: string;
  readonly crashBody: string;
  readonly reload: string;

  /* ---------- 需要参数的文案 ---------- */
  readonly presetCount: (total: number, inSequence: number) => string;
  readonly sequenceHint: (count: number) => string;
  readonly runningTasks: (count: number) => string;
  readonly notice: (notice: SessionNotice) => string;
  readonly hexError: (error: HexParseError) => string;
  readonly lossyHexSwitch: string;
  readonly importedPresets: (count: number) => string;
  readonly importFailed: (reason: string) => string;
  readonly exportedLog: (lines: number) => string;
  readonly exportedPresets: string;
  readonly clearedLog: string;
  readonly stoppedAll: string;
  readonly openPortFirst: string;
  readonly closePortFirst: string;
  readonly portAuthorized: string;
  readonly portPickerDismissed: string;
  readonly portPickerBlocked: string;
  readonly portRequestFailed: (reason: string) => string;
  readonly taskLagging: (name: string) => string;

  readonly presetNames: Readonly<Record<BuiltinPresetKey, string>>;
}
