import { beforeEach, describe, expect, it } from 'vitest';
import { encodeUtf8 } from '@/core/codec/text';
import { messagesFor } from '@/i18n';
import {
  __resetLogStoreForTests,
  allEntries,
  consumeThroughputWindow,
  entryBody,
  flushPendingEntries,
  setSelectorMessages,
  useLogStore,
} from './logStore';

const zh = messagesFor('zh');

function bodies(): string[] {
  flushPendingEntries();
  return allEntries()
    .filter((entry) => entry.kind !== 'sys')
    .map((entry) => entryBody(entry, 'text', zh));
}

describe('logStore', () => {
  beforeEach(() => {
    __resetLogStoreForTests();
    setSelectorMessages(zh);
  });

  it('入库时就完成解码，跨帧被切开的汉字能拼回来', () => {
    const bytes = encodeUtf8('温度');
    const store = useLogStore.getState();
    store.appendFrame('rx', bytes.slice(0, 2));
    store.appendFrame('rx', bytes.slice(2));

    const parts = bodies();
    expect(parts).toHaveLength(2);
    expect(parts.join('')).toBe('温度');
  });

  it('收发两个方向的解码互不串扰', () => {
    const store = useLogStore.getState();
    const rx = encodeUtf8('温度');
    const tx = encodeUtf8('湿度');
    store.appendFrame('rx', rx.slice(0, 2));
    store.appendFrame('tx', tx.slice(0, 2));
    store.appendFrame('rx', rx.slice(2));
    store.appendFrame('tx', tx.slice(2));

    flushPendingEntries();
    const entries = allEntries();
    expect(
      entries
        .filter((e) => e.kind === 'rx')
        .map((e) => e.text)
        .join(''),
    ).toBe('温度');
    expect(
      entries
        .filter((e) => e.kind === 'tx')
        .map((e) => e.text)
        .join(''),
    ).toBe('湿度');
  });

  /**
   * appendFrame 是攒批的（60ms），导出日志前若不先落盘，最近这一批会漏出文件。
   */
  it('flushPendingEntries 把攒批中的条目立即提交', () => {
    useLogStore.getState().appendFrame('rx', encodeUtf8('data\n'));
    expect(allEntries()).toHaveLength(0);

    flushPendingEntries();
    expect(allEntries()).toHaveLength(1);
  });

  it('系统消息立即提交，不等攒批', () => {
    useLogStore.getState().appendMessage('端口已授权');
    expect(allEntries().map((entry) => entry.text)).toEqual(['端口已授权']);
  });

  it('系统消息保留结构化事件，可随语言重新翻译', () => {
    useLogStore.getState().appendNotice({ code: 'port-closed' });
    const entry = allEntries()[0]!;
    expect(entryBody(entry, 'text', messagesFor('zh'))).toBe('串口已关闭');
    expect(entryBody(entry, 'text', messagesFor('en'))).toBe('Port closed');
  });

  it('统计按方向累加，clear 后归零', () => {
    const store = useLogStore.getState();
    store.appendFrame('rx', encodeUtf8('abc'));
    store.appendFrame('tx', encodeUtf8('de'));
    flushPendingEntries();

    expect(useLogStore.getState().rxBytes).toBe(3);
    expect(useLogStore.getState().txBytes).toBe(2);
    expect(useLogStore.getState().rxFrames).toBe(1);
    expect(useLogStore.getState().txFrames).toBe(1);

    useLogStore.getState().clear();
    expect(useLogStore.getState().rxBytes).toBe(0);
    expect(allEntries()).toHaveLength(0);
  });

  it('HEX 视图惰性计算并缓存', () => {
    useLogStore.getState().appendFrame('rx', Uint8Array.of(0x01, 0xab));
    flushPendingEntries();
    const entry = allEntries()[0]!;

    expect(entry.hexCache).toBeNull();
    expect(entryBody(entry, 'hex', zh)).toBe('01 AB');
    expect(entry.hexCache).toBe('01 AB');
  });

  it('速率窗口取走后清零', () => {
    const store = useLogStore.getState();
    store.addThroughput('rx', 120);
    store.addThroughput('rx', 80);
    expect(consumeThroughputWindow()).toBe(200);
    expect(consumeThroughputWindow()).toBe(0);
  });

  it('发送方向不计入接收速率', () => {
    useLogStore.getState().addThroughput('tx', 500);
    expect(consumeThroughputWindow()).toBe(0);
  });
});
