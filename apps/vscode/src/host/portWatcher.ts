import { describeNodePorts, type NodePortInfo } from '@/core/transport/nodePortRegistry';
import type { PortDescriptor } from '@/core/transport/portDescriptor';

/**
 * 端口列表监视器。
 *
 * 浏览器端有 `navigator.serial` 的 connect / disconnect 事件，桌面端**没有**：
 * `serialport` 只提供 `SerialPort.list()`，插拔只能靠定时轮询 + 比对。
 *
 * 因此这里必须是**全进程唯一**的一份，由所有面板共享：
 * 每个面板各跑一个轮询器，就是 N 倍的系统调用，而在 Windows 上枚举串口本身并不便宜。
 */

export interface PortWatcherDeps {
  list: () => Promise<NodePortInfo[]>;
  intervalMs: number;
  /** 枚举失败时的去处。轮询不会因此停下 —— 拔个 USB 集线器就再也不刷新了是不可接受的。 */
  onError?: (error: unknown) => void;
}

/** 端口列表的指纹。只有它变了才值得通知界面重画。 */
function fingerprint(ports: readonly PortDescriptor[]): string {
  return ports.map((port) => `${port.key}|${port.identity}|${port.label}`).join('\n');
}

export class PortWatcher {
  #ports: PortDescriptor[] = [];
  #fingerprint = '';
  #timer: ReturnType<typeof setInterval> | null = null;
  /** 上一拍还没回来就跳过这一拍：慢速枚举不该把请求堆起来。 */
  #polling = false;
  readonly #listeners = new Set<(ports: readonly PortDescriptor[]) => void>();

  constructor(private readonly deps: PortWatcherDeps) {}

  current(): readonly PortDescriptor[] {
    return this.#ports;
  }

  /**
   * 订阅端口变化。第一个订阅者到来时开始轮询，最后一个走掉时停下 ——
   * 没有面板开着时不该有任何后台活动。
   */
  subscribe(listener: (ports: readonly PortDescriptor[]) => void): () => void {
    this.#listeners.add(listener);
    if (this.#timer === null) this.#start();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.stop();
    };
  }

  /** 立刻枚举一次。打开面板、用户手动刷新、刚关闭一个端口之后都该调。 */
  async refresh(): Promise<readonly PortDescriptor[]> {
    if (this.#polling) return this.#ports;
    this.#polling = true;
    try {
      const ports = describeNodePorts(await this.deps.list());
      const next = fingerprint(ports);
      if (next !== this.#fingerprint) {
        this.#fingerprint = next;
        this.#ports = ports;
        for (const listener of this.#listeners) listener(ports);
      }
    } catch (error) {
      this.deps.onError?.(error);
    } finally {
      this.#polling = false;
    }
    return this.#ports;
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  #start(): void {
    this.#timer = setInterval(() => {
      void this.refresh();
    }, this.deps.intervalMs);
    void this.refresh();
  }
}
