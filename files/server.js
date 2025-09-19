const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const tar = require('tar');
const basicAuth = require('basic-auth');

const PORT = process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || '/root/sillytavern/data';
const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/st-remote-backup/backups';
let USER = process.env.BASIC_USER || '';
let PASS = process.env.BASIC_PASS || '';
const CRED_FILE = path.join(__dirname, 'cred.json');

// 尝试从 cred.json 读取用户名密码
async function loadCred() {
  try {
    const raw = await fsp.readFile(CRED_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj.user && obj.pass) {
      USER = obj.user;
      PASS = obj.pass;
    }
  } catch {}
}
// 启动时加载一次
loadCred();

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }).catch(()=>{}); }

// 内存日志环形缓冲（用于 /logs 页面展示）
const LOG_BUF = [];
const LOG_MAX = 2000;
const __origLog = console.log;
const __origErr = console.error;
function pushLog(level, msg) {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const line = `${ts} [${level}] ${msg}`;
  LOG_BUF.push(line);
  if (LOG_BUF.length > LOG_MAX) LOG_BUF.splice(0, LOG_BUF.length - LOG_MAX);
  (level === 'error' ? __origErr : __origLog)(line);
}
console.log = (...a) => pushLog('info', a.join(' '));
console.error = (...a) => pushLog('error', a.join(' '));

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

// 仅保留业务关键日志，去除 HTTP 访问日志

// 静态页面（UI 不鉴权，避免浏览器弹出 Basic 框）
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/', express.static(PUBLIC_DIR));

// 接口鉴权（仅保护 API，由页面内输入账号密码发起请求）
app.use(authGuard);

// 健康检查
app.get('/health', async (req, res) => {
  console.log('[health] ok');
  res.json({ ok: true, dataDir: DATA_DIR, backupDir: BACKUP_DIR });
});

// 获取最近日志（默认 500 行）
app.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '500', 10), LOG_MAX);
  res.json({ lines: LOG_BUF.slice(-limit) });
});

// 清空日志
app.delete('/logs', (req, res) => {
  LOG_BUF.length = 0;
  res.json({ ok: true });
});

// 创建备份
app.post('/backup', async (req, res) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `st-data-${ts}.tar.gz`;
  const out = path.join(BACKUP_DIR, name);
  const t0 = Date.now();
  try {
    await ensureDir(BACKUP_DIR);
    await tar.c({
      gzip: true,
      gzipOptions: { level: 1 },
      file: out,
      cwd: DATA_DIR,
      filter: (entryPath) => shouldInclude(entryPath)
    }, ['.']);
    const st = await fsp.stat(out);
    console.log(`[backup] done name=${name} size=${(st.size/1048576).toFixed(2)}MB time=${Date.now()-t0}ms`);
    res.json({ ok: true, file: name });
  } catch (e) {
    console.error('[backup] error:', e && e.stack || e);
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
    console.log(`[list] ok count=${list.length}`);
    res.json({ ok: true, items: list });
  } catch (e) {
    console.error('[list] error:', e && e.stack || e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 恢复（覆盖式）
app.post('/restore', async (req, res) => {
  const name = (req.query.name || req.body?.name || '').toString();
  const t0 = Date.now();
  try {
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    const file = path.join(BACKUP_DIR, path.basename(name));
    await fsp.access(file);
    await tar.x({ file, cwd: DATA_DIR });
    console.log(`[restore] done name=${name} time=${Date.now()-t0}ms`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[restore] error:', e && e.stack || e);
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
    console.log(`[delete] done name=${name}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[delete] error:', e && e.stack || e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 修改用户名密码接口（需旧用户名密码校验）
app.post('/change-cred', async (req, res) => {
  try {
    // 校验旧用户名密码（用 basic-auth）
    const creds = basicAuth(req);
    if (!creds || creds.name !== USER || creds.pass !== PASS) {
      return res.status(401).json({ ok: false, error: '旧用户名或密码错误' });
    }
    const { user, pass } = req.body || {};
    if (!user || !pass) return res.status(400).json({ ok: false, error: '新用户名和密码不能为空' });
    if (typeof user !== 'string' || typeof pass !== 'string' || user.length < 2 || pass.length < 2) {
      return res.status(400).json({ ok: false, error: '新用户名和密码格式不正确' });
    }
    await fsp.writeFile(CRED_FILE, JSON.stringify({ user, pass }), 'utf8');
    USER = user;
    PASS = pass;
    res.json({ ok: true });
    console.log(`[change-cred] 用户名密码已修改`);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 日志获取/清空
app.listen(PORT, () => {
  console.log(`[st-remote-backup] listening on ${PORT}, DATA_DIR=${DATA_DIR}, BACKUP_DIR=${BACKUP_DIR}`);
});

