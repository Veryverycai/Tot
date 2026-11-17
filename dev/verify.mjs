'use strict';

// Tot Tauri 版自动化验证驱动：经 CDP（WebView2 --remote-debugging-port）驱动渲染层，
// 重放 Electron 时代 TOT_* 套件的核心断言。fixture 运行时生成、跑完还原，零污染。
//
// 用法：node dev/verify.mjs [suite...]   （默认全部；需先 cargo build 出 debug exe）
// 套件：check tabs search replace edit mermaid panels drag dbl session argv

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXE = process.env.TOT_EXE || path.join(ROOT, 'src-tauri', 'target', 'debug', 'tot.exe');
const PORT = Number(process.env.TOT_CDP_PORT || 9222);
const FIX = path.join(ROOT, 'dev', 'fixtures');

// ---------- fixture（LF；crlf.md 单独 CRLF） ----------

const README_MD = `# Tot 测试文档

这是第一段，用于列表转换测试。

这是加粗**测试**段落，搜索词跨边界。

第二段：测试出现第二次。

> [!NOTE]
> 标注块正文。

| 键 | 值 |
| --- | --- |
| a | 值 |

\`\`\`js
console.log('测试');
\`\`\`

| 阶段 | 说明 |
| --- | --- |
| 写阶段 1~6，上电侧 | ~~这是删除线~~ |

波浪号区间 7~9 正常显示。

![图](a.png)

## 第二章

### 小节甲

正文甲。${'填充文本。'.repeat(30)}

### 小节乙

正文乙。${'填充文本。'.repeat(300)}
`;

const CH1_MD = `# 第一章

第一章正文，包含测试一词。

## 一节

内容一。

## 二节

内容二。
`;

const CH2_MD = `# 第二章

第二章正文。

## 甲节

甲节内容，足够长以便滚动。${'填充文本。'.repeat(40)}

## 乙节

乙节内容。${'填充文本。'.repeat(40)}
`;

const MERMAID_MD = `# 图表文档

\`\`\`mermaid
sequenceDiagram
  Alice->>Bob: 你好
  Bob-->>Alice: 嗨
\`\`\`

\`\`\`mermaid
chart TD
  A --> B
\`\`\`
`;

const CRLF_MD = '# CRLF 文档\r\n\r\n第一段正文。\r\n\r\n## **粗体标题**\r\n\r\n第二段正文。\r\n';

// 1x1 透明 png
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function writeFixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(path.join(FIX, 'README.md'), README_MD);
  fs.writeFileSync(path.join(FIX, '01-第一章.md'), CH1_MD);
  fs.writeFileSync(path.join(FIX, '02-第二章.md'), CH2_MD);
  fs.writeFileSync(path.join(FIX, 'mermaid.md'), MERMAID_MD);
  fs.writeFileSync(path.join(FIX, 'crlf.md'), CRLF_MD);
  fs.writeFileSync(path.join(FIX, 'a.png'), Buffer.from(PNG_B64, 'base64'));
}

// ---------- CDP 客户端 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
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
    if (!target) throw new Error('CDP 目标未出现（WebView2 调试端口未就绪）');
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
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面求值异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  // 移开物理鼠标（:hover 规则会干扰编辑态 outline 等样式断言）
  async moveMouse(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  close() { try { this.ws.close(); } catch {} }
}

// ---------- 应用进程 ----------

function launchApp({ userData, openDir, openFile, env: extraEnv, args }) {
  const env = {
    ...process.env,
    TOT_USER_DATA: userData,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    ...extraEnv,
  };
  if (openDir) env.TOT_OPEN_DIR = openDir;
  if (openFile) env.TOT_OPEN_FILE = openFile;
  const child = spawn(EXE, args || [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  const tap = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line) continue;
      log.push(line);
      console.log('  [app]', line);
    }
  };
  child.stdout.on('data', tap);
  child.stderr.on('data', tap);
  child.log = log;
  return child;
}

function killApp(child) {
  try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)]); } catch {}
}

async function waitTree(cdp) {
  for (let i = 0; i < 60; i++) {
    if (await cdp.eval(`!!(window.tot && document.querySelector('#file-tree summary'))`).catch(() => false)) return;
    await sleep(300);
  }
  throw new Error('文件树未就绪');
}

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

async function openByTree(cdp, name) {
  await cdp.eval(`[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === ${JSON.stringify(name)})?.click()`);
  await waitTab(cdp, name);
  await sleep(600);
}

// ---------- 断言 ----------

let pass = 0;
let fail = 0;

function check(tag, cond, data) {
  if (cond) { pass++; console.log(`[dev:${tag}] PASS`, data === undefined ? '' : JSON.stringify(data)); }
  else { fail++; console.log(`[dev:${tag}] FAIL`, data === undefined ? '' : JSON.stringify(data)); }
}

// ---------- 套件 ----------

async function suiteCheck(cdp) {
  await waitTab(cdp, 'README.md');
  await sleep(800);
  const c1 = await cdp.eval(`JSON.stringify({
    treeFiles: [...document.querySelectorAll('#file-tree a')].map((a) => a.textContent),
    headings: [...document.querySelectorAll('#viewer h1,h2,h3')].map((h) => h.tagName + ':' + h.textContent.slice(0, 10)),
    table: document.querySelectorAll('#viewer table').length,
    pre: !!document.querySelector('#viewer pre code'),
    hljsSpans: document.querySelectorAll('#viewer pre code .hljs-keyword, #viewer pre code .hljs-string, #viewer pre code .hljs-comment').length,
    callouts: [...document.querySelectorAll('#viewer .callout')].map((c) => c.className),
    calloutTitles: [...document.querySelectorAll('#viewer .callout-title')].map((t) => t.textContent),
    delCheck: (() => {
      const tr = [...document.querySelectorAll('#viewer tr')].find((t) => t.textContent.includes('写阶段'));
      if (!tr) return null;
      return { rangeLiteral: tr.textContent.includes('写阶段 1~6，上电侧'), delCount: tr.querySelectorAll('del').length, delTexts: [...tr.querySelectorAll('del')].map((d) => d.textContent) };
    })(),
    imgSrc: document.querySelector('#viewer img')?.getAttribute('src') ?? null,
    imgLoaded: (() => { const i = document.querySelector('#viewer img'); return i ? i.naturalWidth > 0 : null; })(),
    outline: [...document.querySelectorAll('#outline a')].map((a) => a.getAttribute('href')),
    tabs: document.querySelectorAll('.tab').length,
    saveDisabled: document.querySelector('#save-btn').disabled,
    undoBtn: !!document.querySelector('#undo-btn'),
    turndownLoaded: typeof window.TurndownService !== 'undefined' && typeof window.turndownPluginGfm !== 'undefined',
    title: document.title,
  })`).then(JSON.parse);
  check('check1-tree', c1.treeFiles.includes('README.md') && c1.treeFiles.includes('mermaid.md'), c1.treeFiles);
  check('check1-render', c1.headings.length >= 4 && c1.table === 2 && c1.pre && c1.hljsSpans > 0, { headings: c1.headings.length, table: c1.table, hljsSpans: c1.hljsSpans });
  check('check1-callout', c1.callouts.length === 1 && c1.callouts[0].includes('callout-note') && c1.calloutTitles.length === 1, c1.calloutTitles);
  check('check1-del', c1.delCheck && c1.delCheck.rangeLiteral && c1.delCheck.delCount === 1 && c1.delCheck.delTexts[0] === '这是删除线', c1.delCheck);
  check('check1-img', c1.imgLoaded === true && /^http:\/\/mdfile\.localhost\//.test(c1.imgSrc || ''), { imgSrc: c1.imgSrc, imgLoaded: c1.imgLoaded });
  check('check1-outline', c1.outline.length >= 4, c1.outline);
  check('check1-state', c1.tabs === 1 && c1.saveDisabled && c1.undoBtn && c1.turndownLoaded, { tabs: c1.tabs, saveDisabled: c1.saveDisabled });
  check('check1-title', c1.title === 'Tot 1.3.0', c1.title);

  // 菜单 DOM（自绘菜单替代原生菜单断言）
  const menu = await cdp.eval(`JSON.stringify({
    labels: [...document.querySelectorAll('#menubar .menu-title')].map((b) => b.textContent),
    fileItems: [...document.querySelectorAll('#menubar .menu:nth-child(1) .menu-popup > .menu-item')].map((i) => i.dataset.label),
    saveAcc: [...document.querySelectorAll('#menubar .menu-item')].find((i) => i.dataset.label === '保存')?.querySelector('.acc')?.textContent,
  })`).then(JSON.parse);
  check('menu', JSON.stringify(menu.labels) === JSON.stringify(['文件', '编辑', '视图', '窗口'])
    && menu.fileItems.includes('打开文件') && menu.fileItems.includes('最近打开') && menu.saveAcc === 'Ctrl+S', menu);

  // turndown 配置一致性
  const td = await cdp.eval(`(() => {
    const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
    td.use(turndownPluginGfm.gfm);
    td.addRule('strikethrough', { filter: 'del', replacement: (content) => '~~' + content + '~~' });
    const div = document.createElement('div');
    div.innerHTML = '<h2>标题 <em>斜</em></h2><p>行内 <code>c</code> 与 <strong>粗</strong></p><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><del>x</del></td></tr></tbody></table>';
    const md = td.turndown(div);
    return JSON.stringify({ delOk: md.includes('~~x~~'), emOk: md.includes('*斜*'), tableOk: md.includes('| --- |') });
  })()`).then(JSON.parse);
  check('turndown', td.delOk && td.emOk && td.tableOk, td);

  // 13 套风格逐一切换：body class / 唯一启用 link / localStorage / 菜单栏明暗无亮色残块
  const styles = await cdp.eval(`[...document.querySelectorAll('#style-select option')].map((o) => o.value)`);
  check('check3-count', styles.length === 13, styles.length);
  for (const id of styles) {
    const s = await cdp.eval(`new Promise((resolve) => {
      const sel = document.querySelector('#style-select');
      sel.value = ${JSON.stringify(id)};
      sel.dispatchEvent(new Event('change'));
      setTimeout(() => {
        const cs = getComputedStyle(document.querySelector('#viewer'));
        const mb = getComputedStyle(document.querySelector('#menubar'));
        resolve(JSON.stringify({
          bodyClass: document.body.className,
          onLinks: [...document.querySelectorAll('link[data-style-id]')].filter((l) => !l.disabled).map((l) => l.dataset.styleId),
          stored: localStorage.getItem('tot-style'),
          viewerBg: cs.backgroundColor,
          mbBg: mb.backgroundColor,
          mbFg: mb.color,
        }));
      }, 250);
    })`).then(JSON.parse);
    const dark = ['github-dark', 'notion-dark', 'typora-night', 'obsidian', 'dracula', 'nord', 'monokai'].includes(id);
    const mbLight = s.mbBg === 'rgb(246, 248, 250)';
    check(`check3-${id}`, s.bodyClass === `style-${id}` && s.stored === id
      && s.onLinks.every((x) => x === id) && s.onLinks.length > 0 && (dark ? !mbLight : mbLight), { mbBg: s.mbBg, links: s.onLinks.length });
  }
  // 回到 github-light
  await cdp.eval(`const sel = document.querySelector('#style-select'); sel.value = 'github-light'; sel.dispatchEvent(new Event('change'));`);
  await sleep(300);

  // scrollspy
  await cdp.eval(`document.querySelectorAll('#viewer h3')[1]?.scrollIntoView({ block: 'start' })`);
  await sleep(700);
  const spy = await cdp.eval(`JSON.stringify({ active: document.querySelector('#outline a.active')?.getAttribute('href') ?? null, scrollTop: document.querySelector('#preview-scroll').scrollTop })`).then(JSON.parse);
  check('check2-spy', spy.active && spy.active.includes('小节乙') && spy.scrollTop > 0, spy);
  await cdp.eval(`document.querySelector('#preview-scroll').scrollTop = 0`);
}

async function suiteTabs(cdp) {
  await openByTree(cdp, '02-第二章.md');
  const t1 = await cdp.eval(`JSON.stringify({ count: document.querySelectorAll('.tab').length, active: document.querySelector('.tab.active .tab-name')?.textContent, h1: document.querySelector('#viewer h1')?.textContent })`).then(JSON.parse);
  check('tabs1', t1.count === 2 && t1.active === '02-第二章.md' && t1.h1 === '第二章', t1);
  await cdp.eval(`[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === '02-第二章.md')?.click()`);
  await sleep(400);
  check('tabs2', await cdp.eval(`document.querySelectorAll('.tab').length`) === 2);
  // 滚动恢复
  await cdp.eval(`document.querySelectorAll('.tab')[0].click()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('#preview-scroll').scrollTop = 150`);
  await sleep(300);
  await cdp.eval(`document.querySelectorAll('.tab')[1].click()`);
  await sleep(500);
  await cdp.eval(`document.querySelectorAll('.tab')[0].click()`);
  await sleep(500);
  const t3 = await cdp.eval(`JSON.stringify({ active: document.querySelector('.tab.active .tab-name')?.textContent, scrollTop: document.querySelector('#preview-scroll').scrollTop })`).then(JSON.parse);
  check('tabs3', t3.active === 'README.md' && Math.abs(t3.scrollTop - 150) <= 2, t3);
  // 全部关闭 → 空态
  await cdp.eval(`[...document.querySelectorAll('.tab-close')].forEach((b) => b.click())`);
  await sleep(500);
  const t4 = await cdp.eval(`JSON.stringify({ tabCount: document.querySelectorAll('.tab').length, emptyShown: !document.querySelector('#empty').hidden, panesHidden: document.querySelector('#panes').hidden })`).then(JSON.parse);
  check('tabs4', t4.tabCount === 0 && t4.emptyShown && t4.panesHidden, t4);
  // dirty 关闭确认
  await openByTree(cdp, 'README.md');
  await cdp.eval(`[...document.querySelectorAll('#viewer p[data-block]')][0].click()`);
  await sleep(400);
  await cdp.eval(`(() => { const p = document.querySelector('#viewer p.block-editing');
    p.focus();
    const s = getSelection(); const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false);
    s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertText', false, 'x'); })()`);
  await sleep(300);
  await cdp.eval(`document.querySelector('.tab-close').click()`);
  await sleep(300);
  const t5 = await cdp.eval(`JSON.stringify({ confirmShown: !document.querySelector('#close-confirm').hidden, tabStillThere: document.querySelectorAll('.tab').length === 1 })`).then(JSON.parse);
  check('tabs5', t5.confirmShown && t5.tabStillThere, t5);
  await cdp.eval(`document.querySelector('#close-cancel').click()`);
  await sleep(200);
  await cdp.eval(`document.querySelector('.tab-close').click()`);
  await sleep(200);
  await cdp.eval(`document.querySelector('#close-discard').click()`);
  await sleep(400);
  const t6 = await cdp.eval(`JSON.stringify({ tabCount: document.querySelectorAll('.tab').length, emptyShown: !document.querySelector('#empty').hidden })`).then(JSON.parse);
  check('tabs6', t6.tabCount === 0 && t6.emptyShown, t6);
}

async function setSearch(cdp, q) {
  await cdp.eval(`(() => { const i = document.querySelector('#search-input');
    i.value = ${JSON.stringify(q)};
    i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(400);
}

async function suiteSearch(cdp) {
  await openByTree(cdp, 'README.md');
  await setSearch(cdp, '测试');
  const s1 = await cdp.eval(`JSON.stringify({ count: document.querySelector('#search-count').textContent, marks: document.querySelectorAll('#viewer mark.tot-search').length })`).then(JSON.parse);
  // 标题/首段/加粗段/第二段/代码围栏 共 5 处
  check('search1', s1.count === '1/5' && s1.marks >= 5, s1);
  await cdp.eval(`document.querySelector('#search-next').click()`);
  await sleep(200);
  const s2 = await cdp.eval(`document.querySelector('#search-count').textContent`);
  check('search2', s2 === '2/5', s2);
  // 跨边界命中归组：「加粗测试」横跨文本节点与 strong
  await setSearch(cdp, '加粗测试');
  const s3 = await cdp.eval(`JSON.stringify({ count: document.querySelector('#search-count').textContent, marks: document.querySelectorAll('#viewer mark.tot-search').length, currentMarks: document.querySelectorAll('#viewer mark.tot-search.current').length })`).then(JSON.parse);
  check('search5-cross', s3.count === '1/1' && s3.marks >= 2 && s3.currentMarks === s3.marks, s3);
  // Esc 清除
  await cdp.eval(`document.querySelector('#search-close').click()`);
  await sleep(300);
  const s4 = await cdp.eval(`JSON.stringify({ marks: document.querySelectorAll('#viewer mark.tot-search').length, value: document.querySelector('#search-input').value })`).then(JSON.parse);
  check('search-esc', s4.marks === 0 && s4.value === '', s4);
}

async function suiteReplace(cdp) {
  await openByTree(cdp, 'README.md');
  // Ctrl+H 展开替换行
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true }))`);
  await sleep(300);
  const r1 = await cdp.eval(`JSON.stringify({ open: !document.querySelector('#replace-group').hidden, disabled: document.querySelector('#replace-all').disabled })`).then(JSON.parse);
  check('replace1', r1.open && r1.disabled, r1);
  await setSearch(cdp, '测试');
  await cdp.eval(`(() => { const i = document.querySelector('#replace-input'); i.value = '替换'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  await cdp.eval(`document.querySelector('#replace-all').click()`);
  await sleep(600);
  const r2 = await cdp.eval(`JSON.stringify({
    status: document.querySelector('#save-status').textContent,
    dirty: !document.querySelector('.tab.active .tab-dirty').hidden,
    replaced: document.querySelector('#viewer').textContent.includes('替换') && !document.querySelector('#viewer').textContent.includes('测试'),
    marks: document.querySelectorAll('#viewer mark.tot-search').length,
  })`).then(JSON.parse);
  check('replace2', r2.status.includes('已替换 5 处') && r2.dirty && r2.replaced && r2.marks === 0, r2);
  // 撤销整步回退
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await sleep(500);
  const r3 = await cdp.eval(`JSON.stringify({ restored: document.querySelector('#viewer').textContent.includes('测试'), dirty: !document.querySelector('.tab.active .tab-dirty').hidden })`).then(JSON.parse);
  check('replace3-undo', r3.restored && !r3.dirty, r3);
  // 重做 + 保存落盘
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))`);
  await sleep(500);
  await cdp.eval(`document.querySelector('#save-btn').click()`);
  await sleep(700);
  const disk = fs.readFileSync(path.join(FIX, 'README.md'), 'utf8');
  check('replace5-save', disk.includes('替换') && !disk.includes('测试') && !disk.includes('\r'), { len: disk.length });
  // 撤销保存前 → 重新变脏且磁盘不动
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await sleep(500);
  const r6 = await cdp.eval(`!document.querySelector('.tab.active .tab-dirty').hidden`);
  const disk2 = fs.readFileSync(path.join(FIX, 'README.md'), 'utf8');
  check('replace6', r6 && disk2 === disk, { dirtyAgain: r6 });
  // 还原 fixture 与界面
  fs.writeFileSync(path.join(FIX, 'README.md'), README_MD);
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))`);
  await sleep(300);
  await cdp.eval(`document.querySelector('#search-close').click()`);
  await cdp.eval(`[...document.querySelectorAll('.tab-close')].forEach((b) => b.click())`);
  await sleep(400);
}

async function suiteEdit(cdp) {
  await cdp.moveMouse(5, 5); // 菜单栏区域：排除物理鼠标 hover 对 outline 断言的干扰
  await openByTree(cdp, 'README.md');
  check('edit0', await cdp.eval(`document.querySelector('#save-btn').disabled`));
  await cdp.eval(`[...document.querySelectorAll('#viewer p[data-block]')][0].click()`);
  await sleep(400);
  const e1 = await cdp.eval(`JSON.stringify({
    blockEditing: !!document.querySelector('#viewer p.block-editing'),
    contentEditable: [...document.querySelectorAll('#viewer p[data-block]')][0].contentEditable === 'true',
    bar: !!document.querySelector('#viewer .block-editor-bar'),
    barCmds: [...document.querySelectorAll('#viewer .block-editor-bar [data-cmd]')].map((b) => b.dataset.cmd),
    formats: [...document.querySelectorAll('#viewer .block-editor-bar .block-format option')].map((o) => o.value),
    editStyle: (() => { const cs = getComputedStyle(document.querySelector('#viewer .block-editing')); return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle }; })(),
  })`).then(JSON.parse);
  check('edit1', e1.blockEditing && e1.contentEditable && e1.bar && e1.barCmds.includes('bold')
    && e1.formats.includes('h6') && e1.editStyle.outlineWidth === '2px', e1);
  // 键入 + 应用 → dirty
  await cdp.eval(`(() => { const p = document.querySelector('#viewer p.block-editing');
    p.focus();
    const s = getSelection(); const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false);
    s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertText', false, 'TOT编辑段落');
    p.querySelector('.block-apply').click(); })()`);
  await sleep(600);
  const e2 = await cdp.eval(`JSON.stringify({ dirty: !document.querySelector('.tab.active .tab-dirty').hidden, editorGone: !document.querySelector('#viewer p.block-editing'), rendered: document.querySelector('#viewer').textContent.includes('TOT编辑段落') })`).then(JSON.parse);
  check('edit2', e2.dirty && e2.editorGone && e2.rendered, e2);
  // 保存落盘
  await cdp.eval(`document.querySelector('#save-btn').click()`);
  await sleep(700);
  const disk = fs.readFileSync(path.join(FIX, 'README.md'), 'utf8');
  check('edit4', disk.includes('TOT编辑段落') && !disk.includes('\r'), { status: await cdp.eval(`document.querySelector('#save-status').textContent`) });
  check('edit5b', await cdp.eval(`document.querySelector('#save-btn').disabled`));
  // 加粗：选「这是加粗」文本节点 → B → 应用
  await cdp.eval(`[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.includes('这是加粗')).click()`);
  await sleep(400);
  await cdp.eval(`(() => { const p = document.querySelector('#viewer p.block-editing');
    p.focus();
    const s = getSelection(); const r = document.createRange();
    r.selectNodeContents([...p.childNodes].find((n) => n.nodeType === 3));
    s.removeAllRanges(); s.addRange(r);
    p.querySelector('[data-cmd="bold"]').click(); })()`);
  await sleep(200);
  await cdp.eval(`document.querySelector('#viewer p.block-editing .block-apply').click()`);
  await sleep(600);
  const e6 = await cdp.eval(`JSON.stringify({ bolded: [...document.querySelectorAll('#viewer p strong')].some((x) => x.textContent.includes('这是加粗')), noLeak: !document.querySelector('#viewer').textContent.includes('****') })`).then(JSON.parse);
  check('edit6', e6.bolded && e6.noLeak, e6);
  // Esc 取消精确还原
  await cdp.eval(`[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.startsWith('第二段')).click()`);
  await sleep(400);
  await cdp.eval(`(() => { const p = document.querySelector('#viewer p.block-editing');
    p.focus();
    const s = getSelection(); const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false);
    s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertText', false, 'Y');
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
  await sleep(400);
  const e7 = await cdp.eval(`JSON.stringify({ editorGone: !document.querySelector('#viewer p.block-editing'), restored: [...document.querySelectorAll('#viewer p[data-block]')].some((x) => x.textContent === '第二段：测试出现第二次。') })`).then(JSON.parse);
  check('edit7', e7.editorGone && e7.restored, e7);
  // 代码围栏源码编辑
  await cdp.eval(`document.querySelector('#viewer pre[data-block]').click()`);
  await sleep(400);
  const e11 = await cdp.eval(`JSON.stringify({ codeEditing: !!document.querySelector('#viewer pre.code-editing'), raw: document.querySelector('#viewer pre.code-editing textarea')?.value })`).then(JSON.parse);
  check('edit11', e11.codeEditing && e11.raw === '```js\nconsole.log(\'测试\');\n```', e11.raw);
  await cdp.eval(`(() => { const t = document.querySelector('#viewer pre.code-editing textarea');
    t.value = '\`\`\`js\\nconsole.log(\\'新代码\\')\\n\`\`\`';
    document.querySelector('#viewer pre.code-editing .mermaid-apply').click(); })()`);
  await sleep(600);
  const e11b = await cdp.eval(`JSON.stringify({ codeChanged: document.querySelector('#viewer pre code')?.textContent.includes('新代码') ?? false, editorGone: !document.querySelector('#viewer pre.code-editing') })`).then(JSON.parse);
  check('edit11b', e11b.codeChanged && e11b.editorGone, e11b);
  // 文档级撤销：Ctrl+Z 回退代码编辑
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await sleep(500);
  const undo1 = await cdp.eval(`document.querySelector('#viewer pre code')?.textContent.includes('测试') ?? false`);
  check('edit-undo', undo1);
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))`);
  await sleep(500);
  check('edit-redo', await cdp.eval(`document.querySelector('#viewer pre code')?.textContent.includes('新代码') ?? false`));
  // 编辑区内逐字撤销（bridge execCommand）：进块编辑键入后 tot.undo()
  await cdp.eval(`[...document.querySelectorAll('#viewer p[data-block]')][0].click()`);
  await sleep(400);
  const before = await cdp.eval(`(() => { const p = document.querySelector('#viewer p.block-editing');
    p.focus();
    const s = getSelection(); const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false);
    s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertText', false, 'ZZ');
    return p.textContent; })()`);
  await cdp.eval(`window.tot.undo()`);
  await sleep(200);
  const after = await cdp.eval(`document.querySelector('#viewer p.block-editing')?.textContent ?? ''`);
  check('edit-native-undo', before.includes('ZZ') && !after.includes('ZZ'), { before: before.slice(-6), after: after.slice(-6) });
  await cdp.eval(`document.querySelector('#viewer p.block-editing')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  // 还原 fixture
  fs.writeFileSync(path.join(FIX, 'README.md'), README_MD);
  await cdp.eval(`[...document.querySelectorAll('.tab-close')].forEach((b) => b.click())`);
  await sleep(300);
  await cdp.eval(`document.querySelector('#close-discard')?.click()`);
  await sleep(300);
}

async function suiteMermaid(cdp) {
  await openByTree(cdp, 'mermaid.md');
  await sleep(2500); // mermaid 按需加载 + 渲染
  const m1 = await cdp.eval(`JSON.stringify({
    loaded: typeof window.mermaid !== 'undefined',
    svgs: document.querySelectorAll('#viewer .mermaid-wrapper > svg').length,
    wrappers: document.querySelectorAll('#viewer .mermaid-wrapper').length,
    error: !!document.querySelector('#viewer .mermaid-wrapper .mermaid-error, #viewer .mermaid-wrapper[data-error]'),
    bodyLeak: [...document.body.children].filter((c) => c.id.startsWith('dmermaid') || c.className.includes('mermaid') && c.id !== 'main').length,
  })`).then(JSON.parse);
  check('mermaid1', m1.loaded && m1.svgs === 1 && m1.wrappers === 2, m1);
  // 错误态可点击编辑修复
  await cdp.eval(`document.querySelectorAll('#viewer .mermaid-wrapper')[1].click()`);
  await sleep(400);
  const m2 = await cdp.eval(`JSON.stringify({ editing: !!document.querySelector('#viewer .mermaid-wrapper textarea, #viewer textarea.mermaid-src, #viewer .mermaid-editor textarea') })`).then(JSON.parse);
  check('mermaid-edit-open', m2.editing, m2);
  const fixed = await cdp.eval(`(() => {
    const t = document.querySelector('#viewer .mermaid-wrapper textarea, #viewer textarea.mermaid-src, #viewer .mermaid-editor textarea');
    if (!t) return false;
    t.value = 'sequenceDiagram\\n  Bob->>Alice: 嗨';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(800); // 300ms debounce 实时预览
  const m3 = await cdp.eval(`JSON.stringify({ previewSvgs: document.querySelectorAll('#viewer .mermaid-wrapper svg').length })`).then(JSON.parse);
  check('mermaid-live-preview', fixed && m3.previewSvgs >= 2, m3);
  await cdp.eval(`document.querySelector('#viewer .mermaid-apply')?.click()`);
  await sleep(800);
  const m4 = await cdp.eval(`JSON.stringify({ svgs: document.querySelectorAll('#viewer .mermaid-wrapper > svg').length, dirty: !document.querySelector('.tab.active .tab-dirty').hidden, bodyLeak: [...document.body.children].filter((c) => c.id.startsWith('dmermaid')).length })`).then(JSON.parse);
  check('mermaid-apply', m4.svgs === 2 && m4.dirty && m4.bodyLeak === 0, m4);
  // 搜索排除 SVG：sequenceDiagram 标签为纯 SVG text，词 Alice 全程 0 mark；正文词「图表」正常命中
  await setSearch(cdp, 'Alice');
  const m5 = await cdp.eval(`document.querySelectorAll('#viewer mark.tot-search').length`);
  check('mermaid-search-exclude', m5 === 0, m5);
  await setSearch(cdp, '图表');
  const m6 = await cdp.eval(`JSON.stringify({ total: document.querySelectorAll('#viewer mark.tot-search').length, inSvg: document.querySelectorAll('#viewer svg mark').length })`).then(JSON.parse);
  check('mermaid-search-body', m6.total >= 1 && m6.inSvg === 0, m6);
  await cdp.eval(`document.querySelector('#search-close').click()`);
  await cdp.eval(`[...document.querySelectorAll('.tab-close')].forEach((b) => b.click())`);
  await sleep(300);
  await cdp.eval(`document.querySelector('#close-discard')?.click()`);
  await sleep(300);
  fs.writeFileSync(path.join(FIX, 'mermaid.md'), MERMAID_MD);
}

async function suitePanels(cdp) {
  await openByTree(cdp, 'README.md');
  await sleep(500);
  const p1 = await cdp.eval(`JSON.stringify({
    treeCollapsed: document.querySelector('#sidebar').classList.contains('tree-collapsed'),
    outlineCollapsed: document.querySelector('#sidebar').classList.contains('outline-collapsed'),
  })`).then(JSON.parse);
  check('panels1', p1.treeCollapsed && !p1.outlineCollapsed, p1);
  await cdp.eval(`document.querySelector('#tree-toggle').click()`);
  await sleep(300);
  const p2 = await cdp.eval(`JSON.stringify({
    treeCollapsed: document.querySelector('#sidebar').classList.contains('tree-collapsed'),
    outlineCollapsed: document.querySelector('#sidebar').classList.contains('outline-collapsed'),
  })`).then(JSON.parse);
  check('panels2', !p2.treeCollapsed && p2.outlineCollapsed, p2);
  await cdp.eval(`[...document.querySelectorAll('.tab-close')].forEach((b) => b.click())`);
  await sleep(400);
  const p3 = await cdp.eval(`JSON.stringify({ treeCollapsed: document.querySelector('#sidebar').classList.contains('tree-collapsed'), outlineCollapsed: document.querySelector('#sidebar').classList.contains('outline-collapsed') })`).then(JSON.parse);
  check('panels3', !p3.treeCollapsed && p3.outlineCollapsed, p3);
}

async function suiteDrag(cdp) {
  const d1 = await cdp.eval(`(() => {
    const r = document.querySelector('#sidebar-resizer');
    const rect = r.getBoundingClientRect();
    const x0 = rect.left + 2;
    r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x0, clientY: 200 }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x0 + 150, clientY: 200 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return Math.round(document.querySelector('#sidebar').getBoundingClientRect().width);
  })()`);
  check('drag1', d1 >= 200 && d1 <= 600 && d1 !== 300, d1);
  const d2 = await cdp.eval(`(() => {
    const r = document.querySelector('#sidebar-resizer');
    const rect = r.getBoundingClientRect();
    r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + 2, clientY: 200 }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5000, clientY: 200 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return Math.round(document.querySelector('#sidebar').getBoundingClientRect().width);
  })()`);
  check('drag2-clamp', d2 === 600, d2);
  const stored = await cdp.eval(`JSON.parse(localStorage.getItem('tot-panels') || 'null')`);
  check('drag3-persist', stored && Math.abs(stored.w - 600) <= 1, stored);
}

async function suiteDbl(cdp) {
  await openByTree(cdp, 'README.md');
  // 单击进编辑 → dblclick 选词 → 移焦退出：无改动不写回不标脏
  await cdp.eval(`[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.startsWith('第二段')).click()`);
  await sleep(400);
  await cdp.eval(`(() => { const p = document.querySelector('#viewer p.block-editing');
    p.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    p.focus();
    const s = getSelection(); const r = document.createRange();
    const tn = [...p.childNodes].find((n) => n.nodeType === 3);
    r.setStart(tn, 0); r.setEnd(tn, 3);
    s.removeAllRanges(); s.addRange(r);
    p.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })); })()`);
  await sleep(500);
  const d = await cdp.eval(`JSON.stringify({ editorGone: !document.querySelector('#viewer p.block-editing'), dirty: !document.querySelector('.tab.active .tab-dirty').hidden, intact: [...document.querySelectorAll('#viewer p[data-block]')].some((x) => x.textContent === '第二段：测试出现第二次。') })`).then(JSON.parse);
  check('dbl1', d.editorGone && !d.dirty && d.intact, d);
  await cdp.eval(`[...document.querySelectorAll('.tab-close')].forEach((b) => b.click())`);
  await sleep(300);
}

// CRLF 文件：块区间不漂移 + 保存还原 CRLF
async function suiteCrlf(cdp) {
  await openByTree(cdp, 'crlf.md');
  await cdp.eval(`[...document.querySelectorAll('#viewer h2[data-block]')].find((x) => x.textContent.includes('粗体标题')).click()`);
  await sleep(400);
  await cdp.eval(`(() => { const h = document.querySelector('#viewer .block-editing');
    const s = getSelection(); const r = document.createRange();
    r.selectNodeContents([...h.childNodes].find((n) => n.nodeType === 3 || n.tagName === 'STRONG'));
    s.removeAllRanges(); s.addRange(r);
    h.querySelector('[data-cmd="bold"]')?.click();
    h.querySelector('.block-apply').click(); })()`);
  await sleep(600);
  await cdp.eval(`document.querySelector('#save-btn').click()`);
  await sleep(700);
  const disk = fs.readFileSync(path.join(FIX, 'crlf.md'), 'utf8');
  const firstP = await cdp.eval(`[...document.querySelectorAll('#viewer p[data-block]')][0]?.textContent`);
  check('crlf1', disk.includes('\r\n') && !disk.includes('\r\r') && firstP === '第一段正文。', { firstP, crlf: disk.includes('\r\n') });
  fs.writeFileSync(path.join(FIX, 'crlf.md'), CRLF_MD);
  await cdp.eval(`[...document.querySelectorAll('.tab-close')].forEach((b) => b.click())`);
  await sleep(300);
  await cdp.eval(`document.querySelector('#close-discard')?.click()`);
  await sleep(300);
}

// ---------- 独立启动套件（会话 / argv） ----------

async function suiteSession() {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tot-session-'));
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
    recent: [],
    session: { paths: [path.join(FIX, 'README.md'), path.join(FIX, '02-第二章.md')], active: path.join(FIX, '02-第二章.md') },
  }));
  const child = launchApp({ userData: ud });
  try {
    const cdp = await CDP.connect();
    await waitTree(cdp);
    await sleep(1200);
    const s1 = await cdp.eval(`JSON.stringify({ offerVisible: !document.querySelector('#session-restore').hidden, text: document.querySelector('#session-restore-text').textContent })`).then(JSON.parse);
    check('session-before', s1.offerVisible && s1.text.includes('2 个文件'), s1);
    await cdp.eval(`document.querySelector('#session-restore-ok').click()`);
    await sleep(1500);
    const s2 = await cdp.eval(`JSON.stringify({
      tabs: [...document.querySelectorAll('.tab .tab-name')].map((t) => t.textContent),
      active: document.querySelector('.tab.active .tab-name')?.textContent,
      h1: document.querySelector('#viewer h1')?.textContent ?? null,
      mermaidLoaded: typeof window.mermaid !== 'undefined',
    })`).then(JSON.parse);
    check('session-after', s2.tabs.length === 2 && s2.active === '02-第二章.md' && s2.h1 === '第二章' && !s2.mermaidLoaded, s2);
    // 懒渲染：切到未渲染标签才渲染
    await cdp.eval(`document.querySelectorAll('.tab')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(800);
    const s3 = await cdp.eval(`document.querySelector('#viewer h1')?.textContent ?? null`);
    check('session-lazy', s3 === 'Tot 测试文档', s3);
    cdp.close();
  } finally {
    killApp(child);
    await sleep(800);
    fs.rmSync(ud, { recursive: true, force: true });
  }
  // 忽略 → 清空会话
  const ud2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tot-session2-'));
  fs.writeFileSync(path.join(ud2, 'config.json'), JSON.stringify({
    recent: [],
    session: { paths: [path.join(FIX, 'README.md')], active: path.join(FIX, 'README.md') },
  }));
  const child2 = launchApp({ userData: ud2 });
  try {
    const cdp = await CDP.connect();
    await waitTree(cdp);
    await sleep(1200);
    await cdp.eval(`document.querySelector('#session-restore-no').click()`);
    await sleep(800);
    const cfg = JSON.parse(fs.readFileSync(path.join(ud2, 'config.json'), 'utf8'));
    const hidden = await cdp.eval(`document.querySelector('#session-restore').hidden`);
    check('session-dismiss', hidden && cfg.session === null, { session: cfg.session });
    cdp.close();
  } finally {
    killApp(child2);
    await sleep(800);
    fs.rmSync(ud2, { recursive: true, force: true });
  }
}

async function suiteArgv() {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tot-argv-'));
  const child = launchApp({
    userData: ud,
    env: { TOT_ARGV: '1' },
    args: [path.join(FIX, 'README.md')],
  });
  try {
    // Rust 侧 TOT_ARGV 钩子：打开后打印 [dev:argv1] 并自动退出
    for (let i = 0; i < 60; i++) {
      if (child.log.some((l) => l.includes('[dev:argv1]'))) break;
      await sleep(300);
    }
    const line = child.log.find((l) => l.includes('[dev:argv1]'));
    const data = line ? JSON.parse(line.slice(line.indexOf('{'))) : null;
    check('argv1', data && data.tabs.includes('README.md') && data.h1 === 'Tot 测试文档', data);
  } finally {
    killApp(child);
    await sleep(500);
    fs.rmSync(ud, { recursive: true, force: true });
  }
}

// ---------- 主流程 ----------

const ALL = ['check', 'tabs', 'search', 'replace', 'edit', 'mermaid', 'panels', 'drag', 'dbl', 'crlf', 'session', 'argv'];
const wanted = process.argv.slice(2).filter((a) => ALL.includes(a));
const suites = wanted.length ? wanted : ALL;

if (!fs.existsSync(EXE)) {
  console.error(`exe 不存在：${EXE}\n先在 src-tauri 下 cargo build`);
  process.exit(2);
}

writeFixtures();

const inline = suites.filter((s) => !['session', 'argv'].includes(s));
if (inline.length) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tot-verify-'));
  const child = launchApp({ userData: ud, openDir: FIX, openFile: 'README.md' });
  let cdp;
  try {
    cdp = await CDP.connect();
    await waitTree(cdp);
    const fns = { check: suiteCheck, tabs: suiteTabs, search: suiteSearch, replace: suiteReplace, edit: suiteEdit, mermaid: suiteMermaid, panels: suitePanels, drag: suiteDrag, dbl: suiteDbl, crlf: suiteCrlf };
    for (const s of inline) {
      console.log(`\n===== suite ${s} =====`);
      try { await fns[s](cdp); } catch (e) { fail++; console.log(`[dev:${s}] ERROR`, e.message); }
    }
  } catch (e) {
    fail++;
    console.error('驱动失败:', e.message);
  } finally {
    cdp?.close();
    killApp(child);
    await sleep(800);
    fs.rmSync(ud, { recursive: true, force: true });
  }
}
if (suites.includes('session')) { console.log('\n===== suite session ====='); await suiteSession(); }
if (suites.includes('argv')) { console.log('\n===== suite argv ====='); await suiteArgv(); }

writeFixtures(); // 终态还原，零污染
console.log(`\n========== PASS ${pass} / FAIL ${fail} ==========`);
process.exit(fail ? 1 : 0);