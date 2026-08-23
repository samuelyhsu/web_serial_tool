/**
 * 一个可编程的 SerialPort 替身，用 WHATWG Streams 模拟真实端口的行为。
 *
 * 有了它，WebSerialTransport 里最容易出错的那段 —— 读循环的退出条件、关闭时的
 * 锁释放顺序、流出错后的恢复（缺陷 D5 / D6）—— 才能在 CI 里跑成确定性测试。
 */
export class FakeSerialPort extends EventTarget {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  /** 设备是否物理在位，对应 SerialPort.connected。 */
  connected = true;

  readonly written: Uint8Array[] = [];
  readonly openCalls: SerialOptions[] = [];
  closeCalls = 0;

  failOpen: Error | null = null;
  failClose: Error | null = null;
  /** 设为 false 可模拟「打开后没有可写流」的异常实现。 */
  provideWritable = true;
  /** getInfo() 抛错，验证标签生成的容错。 */
  infoThrows = false;

  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #info: SerialPortInfo;
  #opened = false;
  /** 设成非 null 后 open() 会挂起，直到测试调用 releaseOpen()。 */
  #openGate: Promise<void> | null = null;
  releaseOpen: () => void = () => undefined;

  constructor(info: SerialPortInfo = {}) {
    super();
    this.#info = info;
  }

  /** 让下一次 open() 挂起，模拟驱动打开端口需要时间。 */
  blockOpen(): void {
    this.#openGate = new Promise<void>((resolve) => {
      this.releaseOpen = resolve;
    });
  }

  async open(options: SerialOptions): Promise<void> {
    if (this.#openGate) {
      const gate = this.#openGate;
      this.#openGate = null;
      await gate;
    }
    if (this.failOpen) {
      const error = this.failOpen;
      this.failOpen = null;
      return Promise.reject(error);
    }
    this.#opened = true;
    this.openCalls.push(options);
    this.#makeReadable();
    this.writable = this.provideWritable
      ? new WritableStream<Uint8Array>({
          write: (chunk) => {
            this.written.push(chunk);
          },
        })
      : null;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    if (this.failClose) return Promise.reject(this.failClose);
    // 规范：端口未打开时 close() 以 InvalidStateError 拒绝
    // https://wicg.github.io/serial/#dom-serialport-close
    if (!this.#opened) {
      return Promise.reject(new DOMException('The port is already closed.', 'InvalidStateError'));
    }
    this.#opened = false;
    this.readable = null;
    this.writable = null;
    this.#controller = null;
    return Promise.resolve();
  }

  getInfo(): SerialPortInfo {
    if (this.infoThrows) throw new Error('getInfo unavailable');
    return this.#info;
  }

  forgetCalls = 0;

  forget(): Promise<void> {
    this.forgetCalls += 1;
    this.connected = false;
    return Promise.resolve();
  }

  getSignals(): Promise<SerialInputSignals> {
    return Promise.resolve({
      dataCarrierDetect: false,
      clearToSend: false,
      ringIndicator: false,
      dataSetReady: false,
    });
  }

  setSignals(): Promise<void> {
    return Promise.resolve();
  }

  /* ---------- 测试驱动接口 ---------- */

  /** 端口此刻是否物理打开。孤儿 transport 会让它停在 true。 */
  get isPhysicallyOpen(): boolean {
    return this.#opened;
  }

  /** 模拟设备发来数据。 */
  push(bytes: Uint8Array | number[]): void {
    const chunk = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.#controller?.enqueue(chunk);
  }

  /** 流正常结束（read() 返回 done）。 */
  endStream(): void {
    this.#controller?.close();
    this.#controller = null;
  }

  /**
   * 流进入 error 状态。Chromium 在奇偶 / 帧错误时就是这样：
   * 当前流报错，释放锁后 port.readable 会是一个可继续读的新流。
   */
  errorStream(error: Error, provideFreshStream = true): void {
    this.#controller?.error(error);
    this.#controller = null;
    if (provideFreshStream) this.#makeReadable();
    else this.readable = null;
  }

  /** 模拟设备被拔出：可读流直接消失。 */
  unplug(): void {
    this.#controller?.error(new Error('The device has been lost.'));
    this.#controller = null;
    this.readable = null;
  }

  #makeReadable(): void {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
  }
}

export function asSerialPort(port: FakeSerialPort): SerialPort {
  return port as unknown as SerialPort;
}
