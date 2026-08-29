/**
 * 扩展对外暴露的 API。
 *
 * **刻意做成自包含的**：不 import 任何内部类型。公开接口一旦泄漏内部结构，
 * 内部重构就会变成对外的破坏性变更；而且集成测试只编译这一个文件就能拿到类型，
 * 不必把整个宿主源码拖进它的编译范围。
 *
 * 取用方式与其他扩展一致：
 * ```ts
 * const api = await vscode.extensions.getExtension('samuelyhsu.web-serial-tool-vscode')?.activate();
 * ```
 */

export type SerialSessionState = 'closed' | 'opening' | 'open' | 'reconnecting';

export interface SerialPortSummary {
  /** 打开设备用的键。桌面端就是设备路径（`COM3` / `/dev/ttyUSB0`）。 */
  key: string;
  /** 人类可读的名字，如 `COM3 · CH340 (1A86:7523)`。 */
  label: string;
  /** 跨会话稳定的设备标识，如 `usb:1A86:7523:SN0123`。 */
  identity: string;
}

export interface SerialPanelSummary {
  portKey: string | null;
  state: SerialSessionState;
}

export interface SerialToolApi {
  /** 当前每个面板连着什么、状态如何。 */
  panels: () => readonly SerialPanelSummary[];
  listPorts: () => Promise<readonly SerialPortSummary[]>;
  /**
   * 打开某个端口。默认已有面板连着它就切过去，否则复用空面板或新建一个。
   *
   * `newPanel: true` 强制新开一个面板 —— 同一个口会被占用仲裁拦下，
   * 这正是「一个口只能被一个面板打开」这条规则的验证入口。
   *
   * 端口不存在时抛错。
   */
  openPort: (portKey: string, options?: { newPanel?: boolean }) => Promise<void>;
  /**
   * 关掉全部面板并释放所有端口。
   *
   * 烧录类扩展可以在烧写前调它让出串口，烧完再开回来 ——
   * 这是扩展形态相对网页版最硬的差异化能力。
   */
  closeAll: () => Promise<void>;
}
