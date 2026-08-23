/**
 * 触发浏览器下载 —— 缺陷 D14。
 *
 * 原型两处导出（日志、预设）都是 `URL.createObjectURL(blob)` 之后就不管了
 * （.dc.html:793-795、880-882）。object URL 会一直持有那份 Blob，直到文档卸载，
 * 每导出一次泄漏一份。这里在下载触发后释放。
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // 立即 revoke 会让部分浏览器来不及取数据，下一轮宏任务再释放
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}

/** 时间戳文件名后缀：20260822-081530 */
export function fileStamp(date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
