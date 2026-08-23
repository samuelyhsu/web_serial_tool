/**
 * 文本 ⇄ UTF-8 字节。
 *
 * 原型手写了一版 UTF-8 编码器（.dc.html:360-367），只处理到 3 字节序列，
 * 遇到增补平面字符（emoji、部分生僻汉字，U+10000 以上）会编出错误的字节 —— 缺陷 D2。
 * 解码方向更糟：原型压根不解码，逐字节映射，设备发来的中文全变成 "." —— 缺陷 D4。
 *
 * 这里统一交给平台的 TextEncoder / TextDecoder，它们是 UTF-8 处理的唯一正确来源。
 */

const encoder = new TextEncoder();

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 流式解码器：一个多字节字符可能被串口分帧切成两半，逐帧独立解码会各自产生替换字符。
 * 用 `stream: true` 让解码器把不完整的尾部字节留到下一帧，保证跨帧字符正确还原。
 *
 * 每个方向（RX / TX）各持有一个实例，端口重开时 reset()。
 */
export class StreamingUtf8Decoder {
  #decoder = new TextDecoder('utf-8');

  decode(bytes: Uint8Array): string {
    return this.#decoder.decode(bytes, { stream: true });
  }

  /** 结束流，吐出滞留的不完整字节（会变成替换字符）。 */
  flush(): string {
    return this.#decoder.decode();
  }

  reset(): void {
    this.#decoder = new TextDecoder('utf-8');
  }
}

/**
 * 判断一段字节能否无损地表示为 UTF-8 文本。
 * HEX → 文本切换前用它做往返校验：不能无损还原就拒绝切换，避免原型那种静默丢数据（缺陷 D3）。
 */
export function isLosslessUtf8(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const roundTrip = encoder.encode(text);
    if (roundTrip.length !== bytes.length) return false;
    for (let i = 0; i < bytes.length; i += 1) {
      if (roundTrip[i] !== bytes[i]) return false;
    }
    return true;
  } catch {
    // fatal 模式下遇到非法 UTF-8 序列会抛 TypeError —— 正是「不可无损还原」的信号
    return false;
  }
}
