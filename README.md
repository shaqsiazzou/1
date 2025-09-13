# SillyTavern 备份微服务（端口 8787）部署与使用教程（零基础版）

本教程教你在服务器上部署一个独立的“备份微服务”，通过网页 http://服务器IP:8787/ 一键备份/恢复/删除 SillyTavern 的数据目录（data），并配置“每日自动备份，仅保留最近 5 份”。全程只需把命令粘贴到 SSH 终端执行。

## 一、前提
- Linux 云服务器（Ubuntu/Debian/CentOS）
- SillyTavern 安装在 `/root/sillytavern`（默认数据目录为 `./data`）
- 拥有服务器 SSH 访问权限（root 或具备 sudo 权限）

## 二、安装备份微服务
以下命令可在任何目录执行。默认配置：
- 备份服务目录：`/opt/st-remote-backup`
- SillyTavern 数据目录：`/root/sillytavern/data`
- 端口：`8787`
- Basic 认证账号/密码：`xiu / 960718`（可自行修改）

1) 创建目录并安装依赖
```bash
sudo mkdir -p /opt/st-remote-backup
cd /opt/st-remote-backup
npm init -y
npm i express tar basic-auth
```

2) 写入服务文件 server.js
```bash
cat > /opt/st-remote-backup/server.js <<'EOF'
const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const tar = require('tar');
const basicAuth = require('basic-auth');

const PORT = process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || '/root/sillytavern/data';
const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/st-remote-backup/backups';
const USER = process.env.BASIC_USER || '';
const PASS = process.env.BASIC_PASS || '';

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }).catch(()=>{}); }

// 排除规则：保留核心数据，避免将缓存/归档/仓库历史打入备份
const EXCLUDE_SEGMENTS_ALWAYS = new Set(['.git', 'node_modules']);
const EXCLUDE_SEGMENTS_CACHE = new Set(['_cache','_uploads','_storage','_webpack','.cache','.parcel-cache','.vite','coverage']);
const EXCLUDE_PREFIXES = ['default-user/backups'];
const EXCLUDE_SUFFIXES = ['.zip','.tar','.tar.gz'];

function shouldInclude(relPath) {
  const p = relPath.replace(/^\.\/?/, '');
  if (EXCLUDE_PREFIXES.some(pre => p === pre || p.startsWith(pre + '/'))) return false;
  const parts = p.split('/');
  if (parts.some(seg => EXCLUDE_SEGMENTS_ALWAYS.has(seg))) return false;
  const isThirdParty = parts[0] === 'third-party';
  if (!isThirdParty && parts.some(seg => EXCLUDE_SEGMENTS_CACHE.has(seg))) return false;
  if (EXCLUDE_SUFFIXES.some(suf => p.endsWith(suf))) return false;
  return true;
}

function authGuard(req, res, next) {
  if (!USER && !PASS) return next();
  const creds = basicAuth(req);
  if (creds && creds.name === USER && creds.pass === PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="st-backup"');
  return res.status(401).send('Unauthorized');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(authGuard);

// 网页 UI 静态目录
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/', express.static(PUBLIC_DIR));

// 健康检查
app.get('/health', async (req, res) => {
  res.json({ ok: true, dataDir: DATA_DIR, backupDir: BACKUP_DIR });
});

// 创建备份
app.post('/backup', async (req, res) => {
  try {
    await ensureDir(BACKUP_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `st-data-${ts}.tar.gz`;
    const out = path.join(BACKUP_DIR, name);
    await tar.c({
      gzip: true,
      gzipOptions: { level: 1 },
      file: out,
      cwd: DATA_DIR,
      filter: (entryPath) => shouldInclude(entryPath)
    }, ['.']);
    res.json({ ok: true, file: name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 列表
app.get('/list', async (req, res) => {
  try {
    await ensureDir(BACKUP_DIR);
    const files = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
    const list = [];
    for (const d of files) {
      if (!d.isFile()) continue;
      const p = path.join(BACKUP_DIR, d.name);
      const st = await fsp.stat(p);
      list.push({ name: d.name, size: st.size, mtime: st.mtime });
    }
    list.sort((a,b)=> new Date(b.mtime)-new Date(a.mtime));
    res.json({ ok: true, items: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 恢复（覆盖式）
app.post('/restore', async (req, res) => {
  try {
    const name = (req.query.name || req.body?.name || '').toString();
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    const file = path.join(BACKUP_DIR, path.basename(name));
    await fsp.access(file);
    await tar.x({ file, cwd: DATA_DIR });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除
app.delete('/delete', async (req, res) => {
  try {
    const name = (req.query.name || '').toString();
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    const file = path.join(BACKUP_DIR, path.basename(name));
    await fsp.unlink(file);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[st-remote-backup] listening on ${PORT}, DATA_DIR=${DATA_DIR}, BACKUP_DIR=${BACKUP_DIR}`);
});
EOF
```

3) 写入网页 UI（美化版）
```bash
sudo mkdir -p /opt/st-remote-backup/public
cat > /opt/st-remote-backup/public/index.html <<'EOF'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Remote Backup</title>
<style>
  :root{--bg:#111216;--panel:#1b1d23;--border:#2a2d35;--text:#e9eaee;--muted:#9aa0aa;--accent:#6ea8fe;--warn:#f0ad4e;--danger:#ff6b6b;--ok:#6ee7a8}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
  .wrap{max-width:980px;margin:0 auto;padding:18px}
  .hdr{display:flex;align-items:center;gap:10px;margin-bottom:14px}
  .badge{padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--panel);color:var(--muted)}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px;margin:12px 0;box-shadow:0 2px 10px rgba(0,0,0,.25)}
  .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
  button{padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:#232630;color:var(--text);cursor:pointer}
  button:hover{border-color:#3a4353}
  .btn-accent{background:linear-gradient(180deg,#2a66ff,#244ee6);border:none}
  .btn-warn{background:#3b2f16;border:1px solid #8a6d3b;color:#f5d08a}
  .btn-danger{background:#3b1b1b;border:1px solid #8a3b3b;color:#ff9b9b}
  .status{margin-top:10px;color:var(--muted)}
  .status.ok{color:var(--ok)} .status.err{color:var(--danger)}
  .tr{display:grid;grid-template-columns:1fr 110px 140px;gap:10px;align-items:center;background:#191b22;border:1px solid var(--border);border-radius:10px;padding:10px;margin:8px 0}
  .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .size{color:var(--muted)}
  .actions{display:flex;gap:8px;justify-content:flex-end}
</style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <h2 style="margin:0">Remote Backup</h2>
      <span class="badge">SFTP 微服务 · 端口 8787</span>
    </div>
    <div class="card">
      <div class="row">
        <button id="health">健康检查</button>
        <button class="btn-accent" id="backup">创建备份</button>
        <button id="refresh">刷新列表</button>
      </div>
      <div id="status" class="status">就绪（首次访问会弹出一次账号/密码）</div>
    </div>
    <div class="card">
      <div class="row"><h3 style="margin:0;font-size:16px">备份列表</h3></div>
      <div id="list" style="margin-top:8px"></div>
    </div>
  </div>
<script>
(function(){
  const $ = s => document.querySelector(s);
  const statusEl = $('#status');
  const listEl = $('#list');
  async function api(method, path){
    const res = await fetch(path, { method, headers:{'Content-Type':'application/json'} });
    const txt = await res.text();
    try{ return JSON.parse(txt); }catch{ return { ok:false, raw:txt }; }
  }
  function human(n){ return (n/1048576).toFixed(2)+' MB'; }
  function setStatus(msg, type){ statusEl.textContent = msg; statusEl.className = 'status' + (type ? ' '+type : ''); }
  async function health(){ setStatus('检查中...'); const r=await api('GET','/health'); setStatus(r.ok?`OK · dataDir=${r.dataDir} · backupDir=${r.backupDir}`:`失败: ${r.error||r.raw||''}`, r.ok?'ok':'err'); }
  async function backup(){ setStatus('备份中...（数据大时需等待）'); const r=await api('POST','/backup'); setStatus(r.ok?('备份完成: '+r.file):('失败: '+(r.error||r.raw||'')), r.ok?'ok':'err'); if(r.ok) refresh(); }
  function render(items){
    listEl.innerHTML=''; if(!items||!items.length){ listEl.innerHTML='<div class="status">暂无备份</div>'; return; }
    items.forEach(it=>{
      const row=document.createElement('div'); row.className='tr';
      row.innerHTML=`<div class="name" title="${it.name}">${it.name}</div><div class="size">${human(it.size)}</div>
        <div class="actions"><button class="btn-warn" data-act="restore">恢复</button><button class="btn-danger" data-act="delete">删除</button></div>`;
      row.querySelector('[data-act="restore"]').onclick=async()=>{ if(!confirm('确定恢复并覆盖 data/?'))return; setStatus('恢复中...'); const r=await api('POST','/restore?name='+encodeURIComponent(it.name)); setStatus(r.ok?'恢复完成':('恢复失败: '+(r.error||r.raw||'')), r.ok?'ok':'err'); };
      row.querySelector('[data-act="delete"]').onclick=async()=>{ if(!confirm('确定删除该备份?'))return; setStatus('删除中...'); const r=await api('DELETE','/delete?name='+encodeURIComponent(it.name)); setStatus(r.ok?'已删除':('删除失败: '+(r.error||r.raw||'')), r.ok?'ok':'err'); if(r.ok) refresh(); };
      listEl.appendChild(row);
    });
  }
  async function refresh(){ setStatus('加载列表...'); const r=await api('GET','/list'); if(!r.ok){ setStatus('失败: '+(r.error||r.raw||''),'err'); return; } setStatus(`共有 ${r.items?.length||0} 个备份`,'ok'); render(r.items); }
  $('#health').onclick=health; $('#backup').onclick=backup; $('#refresh').onclick=refresh;
  refresh().catch(()=>{});
})();
</script>
</body>
</html>
EOF
```

4) 用 PM2 启动（账号/密码可自定义）
```bash
PORT=8787 DATA_DIR=/root/sillytavern/data BACKUP_DIR=/opt/st-remote-backup/backups BASIC_USER=xiu BASIC_PASS=960718 pm2 start /opt/st-remote-backup/server.js --name st-backup --update-env
pm2 save
pm2 startup
```

5) 放行端口（系统防火墙 + 云安全组）
- Ubuntu/Debian：
```bash
sudo ufw allow 8787/tcp && sudo ufw reload
```
- CentOS/RHEL：
```bash
sudo firewall-cmd --permanent --add-port=8787/tcp && sudo firewall-cmd --reload
```

6) 验证
```bash
curl -u 'xiu:960718' http://127.0.0.1:8787/health
# 浏览器访问 http://你的服务器IP:8787/ 首次会弹出账号密码
```

## 三、每日 08:00 自动备份（仅保留最近 5 份）
1) 写脚本
```bash
sudo tee /usr/local/bin/st-backup.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
AUTH='xiu:960718'
BASE='http://127.0.0.1:8787'
BACKUP_DIR='/opt/st-remote-backup/backups'
KEEP=5
curl -sS --fail -u "$AUTH" -X POST "$BASE/backup" >/dev/null
mkdir -p "$BACKUP_DIR"
mapfile -t _FILES < <(ls -1t "$BACKUP_DIR"/st-data-*.tar.gz 2>/dev/null || true)
if (( ${#_FILES[@]} > KEEP )); then
  printf '%s\0' "${_FILES[@]:KEEP}" | xargs -0 -r rm -f --
fi
EOF
sudo chmod +x /usr/local/bin/st-backup.sh
```
2) 立即测试
```bash
/usr/local/bin/st-backup.sh && ls -lh /opt/st-remote-backup/backups
```
3) 加入 crontab（每天 08:00 执行）
```bash
crontab -e
# 末尾添加：
0 8 * * * /usr/local/bin/st-backup.sh >> /var/log/st-backup.cron.log 2>&1
```

## 四、跨服务器恢复（A → B）
- A 推到 B：
```bash
scp -P 22 /opt/st-remote-backup/backups/备份.tar.gz root@B:/opt/st-remote-backup/backups/
```
- B 还原：
```bash
curl -u 'xiu:960718' -X POST "http://B:8787/restore?name=备份.tar.gz"
```

## 五、常见问题
- 页面卡顿：备份进行时会占用 CPU/磁盘 IO，建议低峰定时备份，或降低压缩级别。
- 体积过大：已排除 `.git/node_modules/缓存/归档`。如需更小，可继续在规则中加入大素材目录。
- 外网访问不了：确保监听 `0.0.0.0`、系统防火墙和云安全组已放行 8787。