// 打包冒烟脚本（M5 验收，后续打包轮复用）：单实例转发 / 最近打开被删提示 / 越界拒写
// 默认对 release exe 运行（TOT_EXE 可覆盖）；release 的 CDP 由 TOT_CDP 门控
// 用法：node dev\smoke.mjs（先 tauri build；与 verify.mjs 同一 CDP 端口，勿同时跑）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXE = process.env.TOT_EXE || path.join(ROOT, 'src-tauri', 'target', 'release', 'tot.exe');
const PORT = Number(process.env.TOT_CDP_PORT || 9222);
const FIX = path.join(ROOT, 'dev', 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(tag, cond, data) {
  if (cond) { pass++; console.log(`[smoke:${tag}] PASS`, data === undefined ? '' : JSON.stringify(data)); }
  else { fail++; console.log(`[smoke:${tag}] FAIL`, data === undefined ? '' : JSON.stringify(data)); }
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  static async connect() {
    let target = null;
    for (let i = 0; i < 100; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'));
        if (target) break;
      } catch {}
      await sleep(300);
    }
    if (!target) throw new Error('CDP 目标未出现');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面求值异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

function launchApp({ userData, openDir, openFile, args }) {
  const env = { ...process.env, TOT_USER_DATA: userData, TOT_CDP: '1', TOT_CDP_PORT: String(PORT) };
  if (openDir) env.TOT_OPEN_DIR = openDir;
  if (openFile) env.TOT_OPEN_FILE = openFile;
  const child = spawn(EXE, args || [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => process.stdout.write('  [app] ' + b));
  child.stderr.on('data', (b) => process.stderr.write('  [app] ' + b));
  return child;
}
function killApp(child) { try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)]); } catch {} }

async function waitTab(cdp, name) {
  for (let i = 0; i < 60; i++) {
    const ok = await cdp.eval(
      `[...document.querySelectorAll('.tab .tab-name')].some((t) => t.textContent === ${JSON.stringify(name)})`,
    ).catch(() => false);
    if (ok) return;
    await sleep(300);
  }
  throw new Error(`标签页 ${name} 未打开`);
}

// ---------- 1. 单实例转发：第二实例 argv 转交首实例后自行退出 ----------
async function smokeSingle() {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tot-smoke-single-'));
  const a = launchApp({ userData: ud, openDir: FIX, openFile: path.join(FIX, 'README.md') });
  let cdp;
  try {
    cdp = await CDP.connect();
    await waitTab(cdp, 'README.md');
    const b = launchApp({ userData: ud, args: [path.join(FIX, '02-第二章.md')] });
    const exited = await new Promise((res) => {
      const t = setTimeout(() => res(null), 15000);
      b.on('exit', (code) => { clearTimeout(t); res(code); });
    });
    check('single-exit', exited === 0, { code: exited });
    await waitTab(cdp, '02-第二章.md');
    await sleep(800);
    const st = await cdp.eval(`JSON.stringify({
      active: document.querySelector('.tab.active .tab-name')?.textContent,
      h1: document.querySelector('#viewer h1')?.textContent,
      tabs: document.querySelectorAll('.tab').length,
    })`).then(JSON.parse);
    check('single-forward', st.active === '02-第二章.md' && st.h1 === '第二章' && st.tabs === 2, st);
  } finally {
    cdp?.close();
    killApp(a);
    await sleep(800);
    fs.rmSync(ud, { recursive: true, force: true });
  }
}

// ---------- 2. 最近打开被删提示 + 3. 越界拒写（同一实例） ----------
async function smokeRecentAndBoundary() {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'tot-smoke-docs-'));
  const gone = path.join(docs, 'gone.md');
  fs.writeFileSync(gone, '# 即将删除\n\n正文。\n');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tot-smoke-recent-'));
  // 真实双击（argv）流程：TOT_OPEN_FILE 仅在 TOT_OPEN_DIR 分支内生效，这里走 StartupArgs
  const a = launchApp({ userData: ud, args: [gone] });
  let cdp;
  try {
    cdp = await CDP.connect();
    await waitTab(cdp, 'gone.md');
    // 后台 add_recent 落盘
    let recent = [];
    for (let i = 0; i < 30; i++) {
      try { recent = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8')).recent || []; } catch {}
      if (recent.includes(gone)) break;
      await sleep(300);
    }
    check('recent-indexed', recent.includes(gone), recent);
    const before = await cdp.eval(`document.querySelectorAll('.tab').length`);
    fs.rmSync(gone);
    // 与菜单「最近打开」点击同一入口
    await cdp.eval(`window.tot.openDropped(${JSON.stringify(gone)})`);
    await sleep(600);
    const st = await cdp.eval(`JSON.stringify({
      status: document.querySelector('#save-status')?.textContent,
      isError: document.querySelector('#save-status')?.classList.contains('error'),
      tabs: document.querySelectorAll('.tab').length,
    })`).then(JSON.parse);
    let recent2 = [];
    try { recent2 = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8')).recent || []; } catch {}
    check('recent-missing', st.status === '文件不存在，已从「最近打开」中移除' && st.isError && st.tabs === before && !recent2.includes(gone), { ...st, recent: recent2 });

    // 越界拒写：FIX 目录从未被该实例浏览/打开 → 拒绝
    const outside = path.join(FIX, 'README.md');
    const err = await cdp.eval(`window.tot.writeFile(${JSON.stringify(outside)}, 'x').then(() => null, (e) => String(e))`);
    check('boundary-deny', typeof err === 'string' && err.includes('路径不在可浏览范围内'), err);
    check('boundary-intact', fs.readFileSync(outside, 'utf8').includes('Tot 测试文档'));
    // 正向对照：已放行目录内可写
    const okPath = path.join(docs, 'ok.md');
    const err2 = await cdp.eval(`window.tot.writeFile(${JSON.stringify(okPath)}, '# OK\\n').then(() => null, (e) => String(e))`);
    check('boundary-allow', err2 === null && fs.readFileSync(okPath, 'utf8') === '# OK\n', err2);
  } finally {
    cdp?.close();
    killApp(a);
    await sleep(800);
    fs.rmSync(ud, { recursive: true, force: true });
    fs.rmSync(docs, { recursive: true, force: true });
  }
}

if (!fs.existsSync(EXE)) { console.error('exe 不存在：' + EXE); process.exit(2); }
console.log('EXE =', EXE);
await smokeSingle();
await smokeRecentAndBoundary();
console.log(`\n========== SMOKE PASS ${pass} / FAIL ${fail} ==========`);
process.exit(fail ? 1 : 0);