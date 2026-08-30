# 串口助手 · Web Serial Tool（离线包）

这是网页版的构建产物，随 GitHub Release 一起分发，供**内网 / 没有外网**的机器离线部署。

## 怎么用

**不能直接双击 `index.html`。** Web Serial API 只在**安全上下文**下可用，也就是
`https://` 或 `localhost`，`file://` 不算 —— 双击打开的话页面会提示浏览器不支持。

解压后在这个目录里起一个本地静态服务器，任选一种：

```bash
npx serve .
# 或
python -m http.server 8000
```

然后用 Chrome / Edge 打开它提示的 `localhost` 地址。

若要部署到内网服务器供多人访问，同样需要 **https**（或通过 `localhost` 访问）。

## 关于字体

页面会尝试从 Google Fonts 取 IBM Plex 字体。**没有外网时这个请求会失败，但不影响功能** ——
字体栈里有系统字体兜底，界面照常可用，只是字形换成系统默认的。

## 环境要求

- Chrome / Edge 89+ 或其他 Chromium 内核浏览器
- Firefox 与 Safari **不支持** Web Serial，页面会显示说明横幅而不是假装可用

## 其他

- 更省事的办法是装 VS Code 扩展（同一个 Release 里的 `.vsix`），它不需要 https，
  也不用每次手动授权端口。
- 许可证：MIT
- 项目主页：<https://github.com/samuelyhsu/web_serial_tool>
