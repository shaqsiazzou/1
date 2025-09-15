# Remote Backup for SillyTavern (port 8787)

一个独立的备份微服务：通过浏览器页面 http://IP:8787/ 一键【创建备份 / 查看 / 恢复 / 删除】，并可配置每天定时自动备份（仅保留最近 N 份）。无需依赖 Git/Gitee/LFS，也不依赖 SillyTavern 的插件系统。

## 特性
- 一键安装脚本，开箱即用（pm2 后台守护、自启）
- 网页 UI 操作（页面内输入账号密码登录，不弹出浏览器 Basic 框）
- 排除 `.git/ node_modules/`、缓存与已有归档，备份专注核心数据
- 覆盖式恢复：备份中存在的文件覆盖同名文件，本地多余文件保留（更安全）
- 可选每日自动备份，保留最近 N 份
- 页面内置“服务日志”面板，可自动刷新

---

## 1) 一键安装（默认参数）
在目标服务器执行：
```bash
curl -fsSL https://raw.githubusercontent.com/xiu14/1/main/scripts/install.sh -o install.sh
sudo bash install.sh
```
默认配置：
- 服务目录：/opt/st-remote-backup
- 数据目录：/root/sillytavern/data
- 备份目录：/opt/st-remote-backup/backups
- 端口：8787
- 账号/密码：st / 2025（访问 8787 网页或接口使用；可自行更改）

完成后访问：
- 健康检查（本机）：`curl -u 'xiu:960718' http://127.0.0.1:8787/health`
- 浏览器打开：`http://你的服务器IP:8787/`（页面内输入账号/密码并“安全连接”）

> 提示：安装脚本会尽力放行系统防火墙端口；云安全组请在控制台放行 8787/TCP。

---

## 2) 自定义安装参数（可选）
```bash
sudo bash install.sh \
  -p 8787 \
  -d '/root/sillytavern/data' \
  -b '/opt/st-remote-backup/backups' \
  -u st -w 2025 \
  --cron "0 8 * * *" \
  --keep 5
```
- `-p|--port` 监听端口（默认 8787）
- `-d|--data` SillyTavern 数据目录（默认 /root/sillytavern/data）
- `-b|--backup-dir` 备份目录（默认 /opt/st-remote-backup/backups）
- `-u|--user` Basic 用户名（默认 st）
- `-w|--pass` Basic 密码（默认 2025）

提示：路径建议加引号，尤其包含空格/特殊字符时，例如：

```bash
sudo bash install.sh -d '/data/data/com.termux/files/home/SillyTavern/data'
```
- `--cron` 安装系统定时任务（cron 表达式，不传则不装定时）
- `--keep` 保留备份份数（配合 `--cron` 使用，默认 5）
- `--no-firewall` 跳过自动放行系统防火墙

---

## 3) 使用
- 创建备份：网页点击“创建备份”，或接口 `POST /backup`
- 备份列表：网页显示，或接口 `GET /list`
- 恢复备份：网页“恢复”，或接口 `POST /restore?name=xxx.tar.gz`
- 删除备份：网页“删除”，或接口 `DELETE /delete?name=xxx.tar.gz`
- 服务日志：网页“服务日志”面板（自动刷新/清空）；或 `pm2 logs st-backup`

接口示例：
```bash
# 认证统一使用 Basic（网页内输入账号密码后由前端发起，浏览器不弹窗）
curl -u 'st:2025' http://IP:8787/health
curl -u 'st:2025' -X POST http://IP:8787/backup
curl -u 'st:2025' http://IP:8787/list
curl -u 'st:2025' -X POST "http://IP:8787/restore?name=st-data-....tar.gz"
curl -u 'st:2025' -X DELETE "http://IP:8787/delete?name=st-data-....tar.gz"
```

---

## 4) 自动备份（每天 08:00，保留 5 份）
安装时追加：
```bash
sudo bash install.sh --cron "0 8 * * *" --keep 5
```
也可以手动配置（脚本已内置 `/usr/local/bin/st-backup.sh`）：
```bash
crontab -e
# 追加一行：
0 8 * * * /usr/local/bin/st-backup.sh >> /var/log/st-backup.cron.log 2>&1
```

---

## 5) 目录与文件
- `files/server.js`：服务端（Express + tar）
- `files/public/index.html`：网页 UI（Tailwind 风格，内置日志面板）
- `scripts/install.sh`：一键安装脚本（pm2 启动、自启、可选 cron）
- 运行时：
  - `/opt/st-remote-backup/`：服务目录
  - `/opt/st-remote-backup/backups/`：备份目录（.tar.gz）

---

## 6) 更新与卸载
- 更新（拉取仓库最新脚本并重装）：
```bash
curl -fsSL https://raw.githubusercontent.com/xiu14/1/main/scripts/install.sh -o install.sh
sudo bash install.sh --cron "0 8 * * *" --keep 5
```
- 卸载（保留备份）：
```bash
pm2 delete st-backup || true
sudo rm -rf /opt/st-remote-backup
# 如需移除定时：crontab -e 删除对应行
```

---

## 7) 常见问题（FAQ）
- 页面卡顿？
  - 备份过程会占用 CPU/磁盘 IO，建议放在业务低峰（如 03:00）或将压缩级别降到 1（已默认），并排除大缓存/归档（已默认）。
- 外网访问不了 8787？
  - 确保监听 `0.0.0.0`、系统防火墙与云安全组放行 8787。
- 跨服务器恢复？
  - 将 A 的 `.tar.gz` 复制到 B 的 `/opt/st-remote-backup/backups/`，然后在 B 的 8787 页面点“恢复”，或 `POST /restore?name=...`。
- 恢复会删除多余文件吗？
  - 不会。当前为“覆盖式恢复”：只覆盖同名文件，备份中不存在的本地文件保留。

---

## 8) 安全建议
- 修改默认账号/密码，或将服务只绑定内网访问并在网关/Nginx 层做认证
- 重要生产环境建议用反向代理 + HTTPS
- 如需更细的访问控制、IP 白名单、下载限速等，我可以继续为当前服务扩展

