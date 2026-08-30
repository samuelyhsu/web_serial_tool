# 自建服务器部署（serial.uplume.com）

GitHub Pages 那份之外，同一份产物再部署一份到自己的服务器。推送到 `main` 后由
`.github/workflows/deploy.yml` 的 `self-hosted` job 自动同步。

## 前提：必须是 HTTPS

Web Serial API 只在**安全上下文**（https 或 localhost）下可用。纯 http 的站点上
`navigator.serial` 根本不存在，页面会显示「此浏览器不支持 Web Serial」横幅。
所以下面的 TLS 步骤不是可选项。

## 一、服务器上准备（只做一次）

以下命令在服务器上执行。

### 1. 建一个只能写站点目录的部署用户

**不要用 root 做 CI 部署。** 部署密钥一旦泄漏，root 意味着整台机器；
专用用户则只意味着一个静态站点目录。

```bash
adduser --system --group --shell /usr/sbin/nologin --home /var/lib/deploy deploy
mkdir -p /var/www/serial.uplume.com
chown -R deploy:deploy /var/www/serial.uplume.com

# rsync 走 ssh，所以这个用户需要能登录 —— 但只给 sftp/ssh，不给交互 shell
usermod --shell /bin/bash deploy
mkdir -p /var/lib/deploy/.ssh
chmod 700 /var/lib/deploy/.ssh
chown -R deploy:deploy /var/lib/deploy
```

### 2. 装 nginx 与证书

```bash
apt update && apt install -y nginx certbot python3-certbot-nginx rsync

# 站点配置（把仓库里那份传上来）
# scp -P <端口> docs/deploy/nginx.conf root@<主机>:/etc/nginx/sites-available/serial.uplume.com
ln -sf /etc/nginx/sites-available/serial.uplume.com /etc/nginx/sites-enabled/

# 先放一个占位页，certbot 需要能访问到这个站点
echo 'ok' > /var/www/serial.uplume.com/index.html
chown deploy:deploy /var/www/serial.uplume.com/index.html
```

首次签证书时 `nginx.conf` 里引用的证书路径还不存在，nginx 起不来。
用 certbot 的 standalone 模式先签一次，再启用配置：

```bash
systemctl stop nginx
certbot certonly --standalone -d serial.uplume.com --agree-tos -m <你的邮箱> --no-eff-email
nginx -t && systemctl start nginx
```

证书续期由 certbot 的 systemd timer 自动完成，确认一下：

```bash
systemctl list-timers | grep certbot
certbot renew --dry-run
```

### 3. 装部署公钥

见下一节生成的公钥：

```bash
echo '<公钥内容>' >> /var/lib/deploy/.ssh/authorized_keys
chmod 600 /var/lib/deploy/.ssh/authorized_keys
chown deploy:deploy /var/lib/deploy/.ssh/authorized_keys
```

## 二、本地生成部署密钥

**专门为这个用途生成一对，不要复用你自己的 SSH 密钥。**

```bash
ssh-keygen -t ed25519 -C "github-actions deploy: serial.uplume.com" -f ./deploy_key -N ""
```

- `deploy_key.pub` → 服务器上 `/var/lib/deploy/.ssh/authorized_keys`
- `deploy_key`（私钥）→ GitHub secret，见下

取主机指纹（**别用 StrictHostKeyChecking=no**，那等于对中间人完全不设防）：

```bash
ssh-keyscan -p <端口> -H <主机> 2>/dev/null
```

装完记得把本地的 `deploy_key` 删掉。

## 三、GitHub secrets

仓库 Settings → Secrets and variables → Actions → New repository secret：

| 名称 | 值 |
| --- | --- |
| `SSH_KEY` | `deploy_key` 私钥全文（含首尾 `-----BEGIN/END-----` 行） |
| `SSH_HOST` | 服务器 IP 或主机名 |
| `SSH_PORT` | SSH 端口 |
| `SSH_USER` | `deploy` |
| `SSH_KNOWN_HOSTS` | 上面 `ssh-keyscan` 的输出 |
| `DEPLOY_PATH` | `/var/www/serial.uplume.com` |

主机与端口放 secrets 而不是写进工作流文件，是因为这个仓库是公开的 ——
非标准 SSH 端口没必要主动登出去。

**没配 `SSH_KEY` 时这个 job 会整个跳过**，不会让流水线变红。

## 四、验证

推一次 `main`，然后：

```bash
curl -I https://serial.uplume.com                       # 200，且带 Strict-Transport-Security
curl -I http://serial.uplume.com                        # 301 跳 https
curl -s https://serial.uplume.com | grep -o 'src="[^"]*"'  # 资源路径应为 /assets/...
```

浏览器打开 <https://serial.uplume.com>，确认「选择端口」按钮**不是**禁用状态 ——
禁用说明 `navigator.serial` 不存在，多半是 TLS 没生效。
