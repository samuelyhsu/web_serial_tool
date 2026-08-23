import type { Messages } from './types';

export const zh: Messages = {
  app: '串口助手',

  port: '端口',
  baud: '波特率',
  baudTip: '可从常用档位中选择，也可直接输入任意值；设备是否支持由驱动决定',
  dataBits: '数据位',
  parity: '校验',
  stopBits: '停止位',
  flow: '流控',
  none: '无',
  autoReconnect: '自动重连',
  selectPort: '选择端口…',
  selectPortTip: '打开浏览器的端口选择器。选中后可以给它起个备注名，方便下次辨认。',
  changePortTip: '点击可重新选择端口',
  portUnplugged: '已拔出',
  aliasLabel: '备注',
  aliasPlaceholder: '给这个端口起个名字',
  aliasTip:
    '浏览器不提供真实端口名（COM3 之类），只给 USB 厂商/产品 ID。' +
    '在这里自己标注设备，刷新后仍然保留。注意：浏览器不暴露序列号，' +
    '无 USB 信息或同型号的多个端口只能按枚举顺序区分，若顺序变化备注可能对调。',
  openPort: '打开串口',
  closePort: '关闭串口',
  disconnected: '未连接',
  opened: '已打开',
  opening: '打开中…',
  reconnecting: '重连中…',
  switchLanguage: '切换语言 / Switch language',
  switchTheme: '切换深色 / 浅色主题',
  payloadLabel: '发送内容',

  receive: '接收区',
  timestamp: '时间戳',
  autoScroll: '自动滚屏',
  showTx: '显示发送',
  filterPlaceholder: '过滤 / 高亮关键字…',
  onlyMatch: '仅匹配',
  saveLog: '保存日志',
  clear: '清空',
  noData: '无数据',
  noDataHint: '点「选择端口」授权设备，再打开串口开始接收',
  jumpToBottom: '↓ 回到底部',
  scrollPaused: '已暂停自动滚屏',

  singleSend: '单条发送',
  eol: '结束符',
  send: '发送',
  singlePlaceholder: '输入要发送的内容，Ctrl+Enter 发送',
  period: '周期',
  loop: '循环',
  stop: '停止',
  bytes: '字节',
  checksum: '校验和',
  checksumAppendTip: '按当前载荷实时计算，发送时自动追加在数据末尾',

  multiSend: '多条发送',
  import: '导入',
  export: '导出',
  colSequence: '序列',
  colFormat: '格式',
  colData: '数据',
  colSend: '发送',
  colPeriod: '周期 ms',
  colLoop: '循环',
  dataPlaceholder: '数据',
  sequenceLoop: '顺序循环',
  gap: '间隔',
  startSequence: '启动顺序循环',
  stopSequence: '停止顺序循环',
  stopAll: '全部停止',
  renamePreset: '重命名发送按钮',
  prevPage: '上一页',
  nextPage: '下一页',
  pageIndicator: (current, total) => `${current}/${total}`,
  toggleHexMode: '切换 TXT / HEX 模式',
  formatToggleLabel: (current, next) => `数据格式：${current}，点击切换为 ${next}`,

  frames: '帧',
  uptime: '运行',
  noTimer: '无周期任务',

  unsupportedTitle: '此浏览器不支持 Web Serial',
  unsupportedBody:
    '请改用 Chrome、Edge 或其他 Chromium 内核浏览器，并通过 HTTPS 或 localhost 访问本页面。',
  unsupportedLink: '查看 MDN 上的浏览器兼容性说明',

  crashTitle: '界面出错了',
  crashBody: '发生了未预期的错误。刷新页面即可恢复，串口不会受影响。',
  reload: '刷新页面',

  presetCount: (total, inSequence) => `${total} 条 · ${inSequence} 条在序列中`,
  sequenceHint: (count) => (count > 0 ? `按序依次发送 ${count} 条` : '先勾选要参与循环的指令'),
  runningTasks: (count) => `${count} 个周期任务运行中`,

  notice: (notice) => {
    switch (notice.code) {
      case 'port-opened':
        return `串口已打开 ${notice.config}`;
      case 'port-closed':
        return '串口已关闭';
      case 'open-failed':
        return `打开失败：${notice.message}`;
      case 'connection-lost':
        return '连接意外断开';
      case 'reconnect-scheduled':
        return `正在重连… (${notice.attempt}/${notice.max})，${notice.delayMs} ms 后重试`;
      case 'reconnect-succeeded':
        return `重连成功（第 ${notice.attempt} 次尝试）`;
      case 'reconnect-gave-up':
        return `重连失败，已尝试 ${notice.attempts} 次`;
      case 'read-error':
        return `读取错误：${notice.message}`;
      case 'write-error':
        return `写入错误：${notice.message}`;
      case 'write-dropped-backpressure':
        return `发送过快，本次已丢弃（队列积压 ${notice.pendingBytes} 字节）。请降低发送频率或提高波特率`;
      case 'not-open':
        return '串口未打开，发送已忽略';
    }
  },

  hexError: (error) =>
    error.kind === 'invalid-char'
      ? `HEX 格式错误：第 ${error.index + 1} 个字符 “${error.char}” 不是十六进制数字`
      : `HEX 格式错误：“${error.token}” 的位数是奇数，无法拼成完整字节`,

  lossyHexSwitch: '当前数据含有非法 UTF-8 字节，转成 TXT 会丢失内容，已保持 HEX 模式',
  importedPresets: (count) => `已导入 ${count} 条预设`,
  importFailed: (reason) => `导入失败：${reason}`,
  exportedLog: (lines) => `日志已导出，共 ${lines} 行`,
  exportedPresets: '发送预设已导出',
  clearedLog: '日志与统计已清空',
  stoppedAll: '已停止全部周期发送',
  openPortFirst: '请先打开串口',
  closePortFirst: '请先关闭串口再修改此项',
  portAuthorized: '端口已授权，现在可以打开',
  portPickerDismissed:
    '未选择端口：选择器已关闭。如果弹窗里是空的，说明浏览器没有枚举到任何串口 —— ' +
    '可在 chrome://device-log 查看枚举记录，并确认设备管理器里的 COM 口工作正常。',
  portPickerBlocked:
    '浏览器拒绝了串口访问。请检查 chrome://settings/content/serialPorts 中本站是否被禁止，' +
    '或是否有企业策略（chrome://policy 的 DefaultSerialGuardSetting）限制。',
  portRequestFailed: (reason) => `选择端口失败：${reason}`,
  taskLagging: (name) => `「${name}」上一帧尚未发完，本次已跳过`,

  presetNames: {
    queryVersion: '查询版本',
    readStatus: '读取状态',
    readTempHumidity: '读温湿度',
    readVoltage: '读取电压',
    heartbeat: '心跳包',
    relayOn: '继电器1 开',
    relayOff: '继电器1 关',
    outputEnable: '使能输出',
    saveConfig: '保存参数',
    softReset: '软复位',
  },
};
