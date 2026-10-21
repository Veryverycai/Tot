'use strict';

// 兜底：宿主环境若带 ELECTRON_RUN_AS_NODE（VS Code 启动的终端会继承它），
// electron.exe 会退化为纯 Node。开发版下 require('electron') 返回 exe 路径字符串，
// 打包版下模块不存在（用 process.execPath，即 Tot.exe 自身）。
// 这种情况下用真正的 electron 重启自己。
// 注意：electron 对该变量按「是否存在」判断，空字符串也算存在，必须整键删除。
let electronRequire;
try {
  electronRequire = require('electron');
} catch {
  electronRequire = process.execPath;
}
if (typeof electronRequire === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.electron_run_as_node;
  require('child_process')
    .spawn(electronRequire, [__dirname, ...process.argv.slice(2)], { stdio: 'inherit', env })
    .on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow, ipcMain, dialog, protocol, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs/promises');

// 验证时隔离 userData（须在 app ready 前设置）
if (process.env.TOT_USER_DATA) app.setPath('userData', process.env.TOT_USER_DATA);

// 自定义协议：mdfile://local/<绝对路径>，用于加载 md 内的本地图片
protocol.registerSchemesAsPrivileged([
  { scheme: 'mdfile', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// 渲染进程可访问的路径边界：已扫描过的目录（树懒加载链条）。
// 渲染层只能扩展它已见到的目录（scan-children 逐层放行），读/写/图片协议都限于此。
const knownDirs = new Set();
let win = null;

const SKIP_DIRS = new Set(['node_modules', '.git']);

// ---------- 目录扫描（树懒加载：点开哪层扫哪层） ----------

// 读取 dir 的直接子项：子目录 + .md / .markdown 文件；跳过 .git / node_modules
// 与点开头的目录；读不了的目录静默返回空。
async function scanChildren(dir) {
  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries = [];
  for (const item of items) {
    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name) || item.name.startsWith('.')) continue;
      entries.push({ name: item.name, path: path.join(dir, item.name), type: 'dir' });
    } else if (item.isFile() && /\.(md|markdown)$/i.test(item.name)) {
      entries.push({ name: item.name, path: path.join(dir, item.name), type: 'file' });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  return entries;
}

// 枚举存在的盘符（A-Z），作为「我的电脑」根节点下的顶层
async function listDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    try {
      await fs.access(`${letter}:\\`);
      drives.push({ name: `${letter}:\\`, path: `${letter}:\\`, type: 'dir' });
    } catch {}
  }
  return drives;
}

// ---------- 路径边界 ----------

function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 规范化比较（Windows 大小写不敏感）
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// 文件/图片访问边界：盘符根下的文件随盘符可见，其余须在已浏览目录内
// （盘符本身不入 knownDirs，否则 isInside 会把整盘放行）
function pathAllowed(p) {
  const parent = path.dirname(p);
  if (/^[A-Za-z]:[\\/]$/.test(parent)) return true;
  return [...knownDirs].some((k) => isInside(k, p));
}

// ---------- 最近打开（文件菜单索引，最多 3 个） ----------

// userData/config.json：{ recent: [] }。路径由主进程校验后写入
const configPath = () => path.join(app.getPath('userData'), 'config.json');

async function loadConfig() {
  try {
    const cfg = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    return Array.isArray(cfg.recent) ? cfg : { ...cfg, recent: [] };
  } catch {
    return { recent: [] };
  }
}

async function saveConfig(patch) {
  const cfg = { ...(await loadConfig()), ...patch };
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

// 记入最近打开（去重、只留 3 个）并刷新文件菜单里的索引
async function addRecent(filePath) {
  const cfg = await loadConfig();
  const recent = [filePath, ...cfg.recent.filter((p) => p !== filePath)].slice(0, 3);
  await saveConfig({ recent });
  await buildMenu();
}

// ---------- IPC ----------

// 已扫过列表的盘符（其直接子目录才放行——渲染层看不到列表就无从点开）
const drivesSeen = new Set();

// 树懒加载放行：盘符本身、已见盘符的直接子目录、或已知目录的直接子目录（链条式信任，逐层扩展）
async function dirAllowed(dir) {
  if (/^[A-Za-z]:[\\/]$/.test(dir)) return true;
  const parent = path.dirname(dir);
  if (/^[A-Za-z]:[\\/]$/.test(parent)) return drivesSeen.has(parent.toLowerCase());
  return [...knownDirs].some((k) => samePath(k, parent));
}

// 主进程发起的打开（菜单打开文件 / 最近打开 / 开发钩子）：先放行其父目录
function markOpenable(filePath) {
  const parent = path.dirname(filePath);
  if (!/^[A-Za-z]:[\\/]$/.test(parent)) knownDirs.add(parent);
}

// 树懒加载：渲染层请求 dir 的直接子项
ipcMain.handle('scan-children', async (_e, dir) => {
  if (typeof dir !== 'string' || !(await dirAllowed(dir))) throw new Error('目录不在可浏览范围内');
  const tree = await scanChildren(dir);
  if (/^[A-Za-z]:[\\/]$/.test(dir)) drivesSeen.add(dir.toLowerCase());
  else knownDirs.add(dir);
  return { tree };
});

// 渲染层打开文件后上报，记入「最近打开」（只接受可浏览范围内的文件）
ipcMain.handle('add-recent', async (_e, p) => {
  if (typeof p !== 'string' || !pathAllowed(p)) return;
  await addRecent(p);
});

ipcMain.handle('read-file', async (_e, p) => {
  if (typeof p !== 'string' || !pathAllowed(p)) throw new Error('路径不在可浏览范围内');
  const text = await fs.readFile(p, 'utf8');
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // 去掉 BOM
});

// 批量把 md 内 img 的相对 src 解析为 mdfile:// URL；远程 / data: 原样返回
ipcMain.handle('resolve-images', (_e, filePath, srcs) => {
  const base = path.dirname(filePath);
  return srcs.map((src) => {
    if (/^(https?:|data:|mdfile:)/i.test(src)) return src;
    const abs = path.resolve(base, src.replace(/\//g, path.sep));
    return 'mdfile://local/' + encodeURI(abs.replace(/\\/g, '/'));
  });
});

// 保存当前编辑内容（菜单 文件 → 保存 / Ctrl+S），与 read-file 同样的边界校验
ipcMain.handle('write-file', async (_e, p, text) => {
  if (typeof p !== 'string' || !pathAllowed(p)) throw new Error('路径不在可浏览范围内');
  await fs.writeFile(p, text, 'utf8');
});

// 原生菜单栏明暗跟随渲染风格（Windows 菜单栏随应用深色模式着色）
ipcMain.handle('set-theme', (_e, dark) => {
  nativeTheme.themeSource = dark ? 'dark' : 'light';
});

// 拖入文件打开：只收 .md/.markdown，与菜单打开同一流程
// （openByPath 预检存在性、放行父目录、记入最近打开并通知渲染层）
ipcMain.handle('open-dropped', async (_e, p) => {
  if (typeof p !== 'string' || !/\.(md|markdown)$/i.test(p)) return;
  await openByPath(p);
});

// 顶栏「撤销」按钮：与编辑菜单「撤销」（role: 'undo'）同款原生撤销
ipcMain.on('web-undo', (e) => {
  if (win && !win.isDestroyed() && e.sender === win.webContents) win.webContents.undo();
});

// 插入图片：系统文件选择器 → 相对当前文档路径的相对路径（渲染侧再走 resolve-images 取 mdfile URL）
ipcMain.handle('select-image', async (e, docPath) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return null;
  if (typeof docPath !== 'string') return null;
  const r = await dialog.showOpenDialog(win, {
    title: '选择图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const rel = path.relative(path.dirname(docPath), r.filePaths[0]).replace(/\\/g, '/');
  return { rel };
});

// ---------- 图片协议 ----------

function handleMdfile(request) {
  const p = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, '');
  if (!pathAllowed(p)) return new Response('forbidden', { status: 403 });
  return fs.readFile(p).then(
    (data) => {
      const mime = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
      }[path.extname(p).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'Content-Type': mime } });
    },
    () => new Response('not found', { status: 404 }),
  );
}

// ---------- 菜单 ----------

let appMenu = null;

const MIT_LICENSE = `MIT License

Copyright (c) 2026 Veryverycai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// 打开路径（菜单打开文件 / 最近打开共用）：放行父目录、记入最近、通知渲染层
async function openByPath(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    // 文件已不存在（如最近打开索引里的文件被删）：从索引移除并提示渲染层
    // （不做弹框，同步阻塞会挂死自动化）
    const cfg = await loadConfig();
    await saveConfig({ recent: cfg.recent.filter((p) => p !== filePath) });
    await buildMenu();
    win?.webContents.send('open-file-error', { path: filePath });
    return;
  }
  markOpenable(filePath);
  await addRecent(filePath);
  win?.webContents.send('open-file-path', { path: filePath });
}

// 菜单 文件 → 打开文件：对话框选一个 md，树定位展开并打开
async function openFileDialog() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (res.canceled || !res.filePaths.length) return;
  await openByPath(res.filePaths[0]);
}

// 菜单 文件 → 打开文件夹：对话框选目录，树从我的电脑定位展开到它
async function openFolderDialog() {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return;
  win?.webContents.send('locate-path', { path: res.filePaths[0] });
}

async function buildMenu() {
  // 「最近打开」索引：最多 3 个，启动时把已不存在的文件滤掉
  const cfg = await loadConfig();
  const recentItems = [];
  for (const p of cfg.recent) {
    try { await fs.access(p); } catch { continue; }
    recentItems.push({ label: path.basename(p), title: p, click: () => openByPath(p) });
  }
  appMenu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '打开文件', accelerator: 'CmdOrCtrl+O', click: openFileDialog },
        { label: '打开文件夹', accelerator: 'CmdOrCtrl+Shift+O', click: openFolderDialog },
        {
          label: '最近打开',
          submenu: recentItems.length ? recentItems : [{ label: '（暂无最近文件）', enabled: false }],
        },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => win?.webContents.send('menu-command', 'save') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
        { type: 'separator' },
        {
          label: '关于 Tot',
          click: () => {
            if (!win) return;
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 Tot',
              message: 'Tot',
              detail: `版本 ${app.getVersion()}\n\n本地 Markdown 浏览器\nElectron + 原生 JavaScript`,
            });
          },
        },
        {
          label: 'MIT 许可协议',
          click: () => {
            if (!win) return;
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'MIT 许可协议',
              message: 'MIT License',
              detail: MIT_LICENSE,
            });
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);
}

// ---------- 文件关联 / 命令行打开 ----------

// Windows「打开方式」双击 .md：路径作为命令行参数传入（argv[1:]）；
// 应用已运行时新实例拿不到单实例锁，路径经 second-instance 事件转交给已运行实例
const pendingMdPaths = (argv) => argv.filter((a) => /\.(md|markdown)$/i.test(a));
const startupMdPaths = pendingMdPaths(process.argv);
let winReady = false;

// ---------- 窗口 ----------

async function createWindow() {
  win = new BrowserWindow({
    // 标题栏显示「Tot + 版本号」（清晰当前运行版本；图标在任务栏/Alt+Tab，icon.ico 已提供）
    title: 'Tot ' + app.getVersion(),
    icon: path.join(__dirname, 'icon.ico'),
    width: 1280,
    height: 840,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await buildMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 开发模式：渲染进程 console 转发到终端（验证「DevTools 无报错」用）
  if (!app.isPackaged) {
    win.webContents.on('console-message', (...args) => {
      const first = args[0];
      const e = typeof first === 'object' && first.message !== undefined
        ? first
        : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
  }

  win.on('closed', () => { win = null; });

  // 启动：目录浏览以「我的电脑」为根（盘符 → 文件夹 → 文件，树懒加载），
  // 不做任何自动重开；文件菜单的「最近打开」索引负责快速回到最近文件
  // 仅开发/自动验证用：TOT_OPEN_DIR 定位展开到该目录；TOT_OPEN_FILE 再自动打开一个文件；
  // TOT_CHECK 在页面里跑断言并打印 DOM 状态（树/渲染/大纲/scrollspy）后退出
  win.webContents.on('did-finish-load', async () => {
    winReady = true;
    // index.html 的 <title>Tot</title> 会在加载时覆盖窗口标题，这里恢复「Tot + 版本号」
    win.setTitle('Tot ' + app.getVersion());
    if (!process.env.TOT_OPEN_DIR) {
      win.webContents.send('init-tree', { drives: await listDrives() });
      // 文件关联双击：打开命令行传入的 md 文件
      for (const p of startupMdPaths) await openByPath(p);
      startupMdPaths.length = 0;
      if (process.env.TOT_ARGV) {
        // 文件关联首次双击验证：argv 传入的 md 已打开并渲染
        await new Promise((r) => setTimeout(r, 2500));
        console.log('[dev:argv1]', await win.webContents.executeJavaScript(
          `JSON.stringify({ tabs: [...document.querySelectorAll('.tab .tab-name')].map((t) => t.textContent), h1: document.querySelector('#viewer h1')?.textContent ?? null })`,
        ));
        app.quit();
        return;
      }
      if (process.env.TOT_RECENT_MISSING) {
        // 最近打开的文件被删除：openByPath 应移除索引并在渲染层提示
        await new Promise((r) => setTimeout(r, 800));
        await openByPath(process.env.TOT_RECENT_MISSING);
        await new Promise((r) => setTimeout(r, 400));
        console.log('[dev:recent-missing]', JSON.stringify({
          recentLabels: appMenu.items[0].submenu.items.find((i) => i.label === '最近打开')?.submenu.items.map((i) => i.label ?? i.type),
          status: await win.webContents.executeJavaScript(`document.querySelector('#save-status').textContent`),
        }));
        app.quit();
        return;
      }
      if (process.env.TOT_CHECK) {
        await new Promise((r) => setTimeout(r, 800));
        console.log('[dev:start]', await win.webContents.executeJavaScript(
          `JSON.stringify({ treeDirs: [...document.querySelectorAll('#file-tree summary')].map((s) => s.textContent), treeFiles: [...document.querySelectorAll('#file-tree a')].map((a) => a.title), tabs: document.querySelectorAll('.tab').length })`,
        ));
        console.log('[dev:recent]', JSON.stringify({
          recentLabels: appMenu.items[0].submenu.items.find((i) => i.label === '最近打开')?.submenu.items.map((i) => i.label ?? i.type),
          stored: (await loadConfig()).recent,
        }));
        app.quit();
      }
      return;
    }
    try {
      const dir = path.resolve(process.env.TOT_OPEN_DIR);
      win.webContents.send('init-tree', { drives: await listDrives() });
      win.webContents.send('locate-path', { path: dir });
        if (process.env.TOT_OPEN_FILE) {
          await new Promise((r) => setTimeout(r, 2500)); // 等目录链懒加载定位完成
          const file = path.join(dir, process.env.TOT_OPEN_FILE);
          markOpenable(file);
          win.webContents.send('open-file-path', { path: file });
        }
        if (process.env.TOT_CHECK) {
          console.log('[dev:menu]', JSON.stringify({
            labels: appMenu.items.map((i) => i.label),
            fileItems: appMenu.items[0].submenu.items.map((i) => i.label ?? i.type),
            editItems: appMenu.items[1].submenu.items.map((i) => i.label ?? i.type),
            viewItems: appMenu.items[2].submenu.items.map((i) => i.label ?? i.type),
            windowItems: appMenu.items[3].submenu.items.map((i) => i.label ?? i.type),
            saveAcc: appMenu.items[0].submenu.items.find((i) => i.label === '保存')?.accelerator,
            winTitle: win.getTitle(),
            winTitleOk: win.getTitle() === 'Tot ' + app.getVersion(),
          }));
          await new Promise((r) => setTimeout(r, 2500));
          const check = `JSON.stringify({
            treeFiles: [...document.querySelectorAll('#file-tree a')].map((a) => a.textContent),
            treeDirs: [...document.querySelectorAll('#file-tree summary')].map((s) => s.textContent),
            treeIndents: [...document.querySelectorAll('#file-tree ul')].map((u) => getComputedStyle(u).paddingLeft),
            active: document.querySelector('#file-tree a.active')?.textContent ?? null,
            headings: [...document.querySelectorAll('#viewer h1,h2,h3,h4,h5,h6')].map((h) => h.id + ':' + h.tagName + ':' + h.textContent.slice(0, 12)),
            table: !!document.querySelector('#viewer table'),
            pre: !!document.querySelector('#viewer pre code'),
            hljsSpans: document.querySelectorAll('#viewer pre code .hljs-keyword, #viewer pre code .hljs-string, #viewer pre code .hljs-comment').length,
            callouts: [...document.querySelectorAll('#viewer .callout')].map((c) => c.className),
            calloutTitles: [...document.querySelectorAll('#viewer .callout-title')].map((t) => t.textContent),
            delCheck: (() => {
              const tr = [...document.querySelectorAll('#viewer tr')].find((t) => t.textContent.includes('两段接力'));
              if (!tr) return null;
              return { rangeLiteral: tr.textContent.includes('写阶段 1~6，上电侧'), delCount: tr.querySelectorAll('del').length, delTexts: [...tr.querySelectorAll('del')].map((d) => d.textContent) };
            })(),
            imgSrc: document.querySelector('#viewer img')?.getAttribute('src') ?? null,
            imgLoaded: (() => { const i = document.querySelector('#viewer img'); return i ? i.naturalWidth > 0 : null; })(),
            outline: [...document.querySelectorAll('#outline a')].map((a) => a.getAttribute('href')),
            outlineActive: document.querySelector('#outline a.active')?.getAttribute('href') ?? null,
            tabs: document.querySelectorAll('.tab').length,
            activeTab: document.querySelector('.tab.active .tab-name')?.textContent ?? null,
            saveDisabled: document.querySelector('#save-btn').disabled,
            undoBtn: (() => { const u = document.querySelector('#undo-btn'); const s = document.querySelector('#save-btn'); return { present: !!u, disabled: u?.disabled ?? null, afterSave: !!u && s.nextElementSibling === u, sameStyle: !!u && getComputedStyle(u).borderRadius === getComputedStyle(s).borderRadius }; })(),
            turndownLoaded: typeof window.TurndownService !== 'undefined' && typeof window.turndownPluginGfm !== 'undefined',
            turndownRoundtrip: (() => {
              // 与应用内 turndown 配置保持一致（emDelimiter + 删除线双波浪线覆盖），防配置漂移
              const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
              td.use(turndownPluginGfm.gfm);
              td.addRule('strikethrough', { filter: 'del', replacement: (content) => '~~' + content + '~~' });
              const div = document.createElement('div');
              div.innerHTML = '<h2>标题 <em>斜</em></h2><p>行内 <code>c</code> 与 <strong>粗</strong></p><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><del>x</del></td></tr></tbody></table>';
              const md = td.turndown(div);
              return { md, delOk: md.includes('~~x~~'), emOk: md.includes('*斜*'), tableOk: md.includes('| --- |') };
            })(),
            style: document.body.className + '/' + (localStorage.getItem('tot-style') || 'none'),
            panelLabels: [...document.querySelectorAll('.panel-header span')].map((s) => s.textContent),
            panelCollapsed: [document.querySelector('#sidebar').classList.contains('tree-collapsed'), document.querySelector('#sidebar').classList.contains('outline-collapsed')],
            panelVisible: [!document.querySelector('#tree-header').hidden, !document.querySelector('#outline-header').hidden, !document.querySelector('#outline-body').hidden],
            sidebarWidth: Math.round(document.querySelector('#sidebar').getBoundingClientRect().width),
            outlineHeight: Math.round(document.querySelector('#outline-body').getBoundingClientRect().height),
          })`;
          console.log('[dev:check1]', await win.webContents.executeJavaScript(check));
          console.log('[dev:recent]', JSON.stringify({
            recentLabels: appMenu.items[0].submenu.items.find((i) => i.label === '最近打开')?.submenu.items.map((i) => i.label ?? i.type),
            stored: (await loadConfig()).recent,
          }));
          await win.webContents.executeJavaScript(
            `window.__scrollLog = []; document.querySelector('#preview-scroll').addEventListener('scroll', () => window.__scrollLog.push(performance.now().toFixed(0) + ':' + document.querySelector('#preview-scroll').scrollTop)); document.querySelectorAll('#viewer h3')[1]?.scrollIntoView({ block: 'start' });`,
          );
          await new Promise((r) => setTimeout(r, 700));
          console.log('[dev:check2]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              scrollTop: document.querySelector('#preview-scroll').scrollTop,
              active: document.querySelector('#outline a.active')?.getAttribute('href') ?? null,
              scrollLog: window.__scrollLog,
              headings: [...document.querySelectorAll('#viewer h1,h2,h3,h4,h5,h6')].map((h) => h.id + '@' + Math.round(h.getBoundingClientRect().top)),
            })`,
          ));
          if (process.env.TOT_STYLE) {
            // 驱动侧兼容旧风格名（light/dark），映射到注册表新 id
            const styleId = { light: 'github-light', dark: 'github-dark' }[process.env.TOT_STYLE] || process.env.TOT_STYLE;
            console.log('[dev:check3]', await win.webContents.executeJavaScript(
              `new Promise((resolve) => {
                const sel = document.querySelector('#style-select');
                sel.value = ${JSON.stringify(styleId)};
                sel.dispatchEvent(new Event('change'));
                setTimeout(() => {
                  const cs = getComputedStyle(document.querySelector('#viewer'));
                  resolve(JSON.stringify({
                    bodyClass: document.body.className,
                    links: [...document.querySelectorAll('link[data-style-id]')]
                      .map((l) => l.dataset.styleId + (l.disabled ? ':off' : ':on'))
                      .filter((s) => s.endsWith(':on')),
                    linkCount: document.querySelectorAll('link[data-style-id]').length,
                    optgroups: document.querySelectorAll('#style-select optgroup').length,
                    options: document.querySelectorAll('#style-select option').length,
                    stored: localStorage.getItem('tot-style'),
                    viewerBg: cs.backgroundColor,
                    viewerColor: cs.color,
                    shellBg: [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('#topbar')).backgroundColor, getComputedStyle(document.querySelector('#viewer')).backgroundColor, getComputedStyle(document.querySelector('#tabbar')).backgroundColor],
                    preStyle: (() => { const p = getComputedStyle(document.querySelector('#viewer pre')); return { bg: p.backgroundColor, border: p.borderTopColor }; })(),
                    calloutStyle: (() => { const c = getComputedStyle(document.querySelector('#viewer .callout-note')); const t = getComputedStyle(document.querySelector('#viewer .callout-note .callout-title')); return { bg: c.backgroundColor, border: c.borderLeftColor, title: t.color }; })(),
                    paraStyle: (() => { const p = getComputedStyle(document.querySelector('#viewer p')); return { indent: p.textIndent, align: p.textAlign, family: p.fontFamily.slice(0, 60) }; })(),
                    thStyle: (() => { const t = getComputedStyle(document.querySelector('#viewer th')); return { borderTop: t.borderTopStyle, borderTopWidth: t.borderTopWidth, borderLeft: t.borderLeftStyle }; })(),
                  }));
                }, 400);
              })`,
            ));
            console.log('[dev:theme]', JSON.stringify({ themeSource: nativeTheme.themeSource }));
          }
        }
        if (process.env.TOT_TABS) {
          await new Promise((r) => setTimeout(r, 3000)); // 等树懒加载定位完成
          // tabs1: 打开第二个文件 → 两个标签页
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === '02-第二章.md')?.click()`,
          );
          await new Promise((r) => setTimeout(r, 600));
          console.log('[dev:tabs1]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              count: document.querySelectorAll('.tab').length,
              names: [...document.querySelectorAll('.tab-name')].map((s) => s.textContent),
              active: document.querySelector('.tab.active .tab-name')?.textContent ?? null,
              h1: document.querySelector('#viewer h1')?.textContent?.slice(0, 8) ?? null,
            })`,
          ));
          // tabs2: 重复点同一文件 → 只激活不新增
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === '02-第二章.md')?.click()`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:tabs2]', await win.webContents.executeJavaScript(
            `JSON.stringify({ count: document.querySelectorAll('.tab').length })`,
          ));
          // tabs3: tab0 滚动到 150 → 切 tab1 → 切回 tab0，断言滚动恢复
          await win.webContents.executeJavaScript(`document.querySelectorAll('.tab')[0].click()`);
          await new Promise((r) => setTimeout(r, 500));
          await win.webContents.executeJavaScript(`document.querySelector('#preview-scroll').scrollTop = 150`);
          await new Promise((r) => setTimeout(r, 300));
          await win.webContents.executeJavaScript(`document.querySelectorAll('.tab')[1].click()`);
          await new Promise((r) => setTimeout(r, 500));
          await win.webContents.executeJavaScript(`document.querySelectorAll('.tab')[0].click()`);
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:tabs3]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              active: document.querySelector('.tab.active .tab-name')?.textContent ?? null,
              scrollTop: document.querySelector('#preview-scroll').scrollTop,
              h1: document.querySelector('#viewer h1')?.textContent?.slice(0, 8) ?? null,
            })`,
          ));
          // tabs4: 关闭全部标签 → 空态
          await win.webContents.executeJavaScript(`[...document.querySelectorAll('.tab-close')].forEach((b) => b.click())`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:tabs4]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              tabCount: document.querySelectorAll('.tab').length,
              emptyShown: !document.querySelector('#empty').hidden,
              panesHidden: document.querySelector('#panes').hidden,
            })`,
          ));
          // tabs5/6: dirty 关闭确认——块级就地编辑改字 → 关闭弹确认条 → 取消 → 再关并丢弃
          await win.webContents.executeJavaScript(`[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === 'README.md')?.click()`);
          await new Promise((r) => setTimeout(r, 500));
          await win.webContents.executeJavaScript(`[...document.querySelectorAll('#viewer p[data-block]')][0].click()`);
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer p.block-editing');
               p.focus();
               const s = getSelection(); const r = document.createRange();
               r.selectNodeContents(p); r.collapse(false);
               s.removeAllRanges(); s.addRange(r);
               document.execCommand('insertText', false, 'x'); }`,
          );
          await new Promise((r) => setTimeout(r, 200));
          await win.webContents.executeJavaScript(`document.querySelector('.tab-close').click()`);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:tabs5]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              confirmShown: !document.querySelector('#close-confirm').hidden,
              tabStillThere: document.querySelectorAll('.tab').length === 1,
            })`,
          ));
          await win.webContents.executeJavaScript(`document.querySelector('#close-cancel').click()`);
          await new Promise((r) => setTimeout(r, 200));
          await win.webContents.executeJavaScript(`document.querySelector('.tab-close').click()`);
          await new Promise((r) => setTimeout(r, 200));
          await win.webContents.executeJavaScript(`document.querySelector('#close-discard').click()`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:tabs6]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              tabCount: document.querySelectorAll('.tab').length,
              emptyShown: !document.querySelector('#empty').hidden,
            })`,
          ));
        }
        if (process.env.TOT_EDIT) {
          const editFile = path.join(path.resolve(process.env.TOT_OPEN_DIR), process.env.TOT_OPEN_FILE || 'README.md');
          const before = await fs.readFile(editFile, 'utf8'); // 基线（此时磁盘尚未被本轮修改），最后还原用
          await new Promise((r) => setTimeout(r, 3000)); // 等树懒加载定位完成
          // 自包含：确保文件已打开（与 TOT_TABS 组合运行时可能已被全部关闭）
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree a')].find((a) => a.title === ${JSON.stringify(editFile)})?.click()`,
          );
          await new Promise((r) => setTimeout(r, 800));
          // edit0: 刚打开的文档不脏 → 保存按钮禁用（预览即编辑：无模式切换，按钮仅随 dirty 启停）
          console.log('[dev:edit0]', await win.webContents.executeJavaScript(
            `JSON.stringify({ saveDisabled: document.querySelector('#save-btn').disabled })`,
          ));
          // edit1: 点击段落块 → 富文本就地编辑（contenteditable + 浮动工具条）
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer p[data-block]')][0].click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:edit1]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              blockEditing: document.querySelector('#viewer p.block-editing') !== null,
              contentEditable: [...document.querySelectorAll('#viewer p[data-block]')][0].contentEditable === 'true',
              bar: !!document.querySelector('#viewer .block-editor-bar'),
              barCmds: [...document.querySelectorAll('#viewer .block-editor-bar [data-cmd]')].map((b) => b.dataset.cmd),
              formats: [...document.querySelectorAll('#viewer .block-editor-bar .block-format option')].map((o) => o.value),
              idx: document.querySelector('#viewer p.block-editing')?.dataset.block ?? null,
              editStyle: (() => { const cs = getComputedStyle(document.querySelector('#viewer .block-editing')); return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, bg: cs.backgroundColor }; })(),
            })`,
          ));
          // edit2: 键入文本 → 工具条「应用」→ dirty + 编辑器关闭
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer p.block-editing');
               p.focus();
               const s = getSelection();
               const r = document.createRange();
               r.selectNodeContents(p); r.collapse(false);
               s.removeAllRanges(); s.addRange(r);
               document.execCommand('insertText', false, 'TOT编辑段落');
               p.querySelector('.block-apply').click(); }`,
          );
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit2]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              dirty: !document.querySelector('.tab.active .tab-dirty').hidden,
              editorGone: !document.querySelector('#viewer p.block-editing'),
              saveEnabled: !document.querySelector('#save-btn').disabled,
            })`,
          ));
          // edit3: 应用后整页重渲染出标记
          console.log('[dev:edit3]', await win.webContents.executeJavaScript(
            `JSON.stringify({ rendered: document.querySelector('#viewer').textContent.includes('TOT编辑段落') })`,
          ));
          // edit4/5: 点保存按钮保存，断言磁盘真的被改
          await win.webContents.executeJavaScript(`document.querySelector('#save-btn').click()`);
          await new Promise((r) => setTimeout(r, 700));
          const after1 = await fs.readFile(editFile, 'utf8');
          console.log('[dev:edit4]', JSON.stringify({
            diskChanged: after1 !== before,
            dirtyGone: await win.webContents.executeJavaScript(`document.querySelector('.tab.active .tab-dirty').hidden`),
          }));
          console.log('[dev:edit5]', JSON.stringify({
            diskHasMarker: after1.includes('TOT编辑段落'),
            status: await win.webContents.executeJavaScript(`document.querySelector('#save-status').textContent`),
          }));
          // edit5b: 保存后按钮回到禁用
          console.log('[dev:edit5b]', await win.webContents.executeJavaScript(
            `JSON.stringify({ saveDisabled: document.querySelector('#save-btn').disabled })`,
          ));
          // edit6: 工具条「加粗」——选中文本 → execCommand 包 <b> → 应用 → 重渲染出 **粗体**
          await win.webContents.executeJavaScript(
            `{ const p = [...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.includes('加粗测试段落'));
               p.click(); }`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer p.block-editing');
               const s = getSelection(); const r = document.createRange();
               // 工具条被 prepend 在块首：正文第一个文本节点在工具条之后
               r.selectNodeContents([...p.childNodes].find((n) => n.nodeType === 3));
               s.removeAllRanges(); s.addRange(r);
               p.querySelector('[data-cmd="bold"]').click(); }`,
          );
          await new Promise((r) => setTimeout(r, 200));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer p.block-editing .block-apply').click()`);
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit6]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              bolded: [...document.querySelectorAll('#viewer p strong')].some((x) => x.textContent === '这是加粗'),
              noAsteriskLeak: !document.querySelector('#viewer').textContent.includes('****'),
            })`,
          ));
          // edit7: Esc 取消 —— 修改被丢弃、块内容精确还原
          await win.webContents.executeJavaScript(
            `{ const p = [...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.startsWith('第二段'));
               p.click(); }`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer p.block-editing');
               p.focus();
               const s = getSelection(); const r = document.createRange();
               r.selectNodeContents(p); r.collapse(false);
               s.removeAllRanges(); s.addRange(r);
               document.execCommand('insertText', false, 'Y');
               p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:edit7]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              editorGone: !document.querySelector('#viewer p.block-editing'),
              restored: [...document.querySelectorAll('#viewer p[data-block]')].some((x) => x.textContent === '第二段：测试出现第二次。'),
            })`,
          ));
          // edit8: 失焦（焦点移出块）即应用
          await win.webContents.executeJavaScript(
            `{ const p = [...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.startsWith('第二段'));
               p.click(); }`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer p.block-editing');
               p.focus();
               const s = getSelection(); const r = document.createRange();
               r.selectNodeContents(p); r.collapse(false);
               s.removeAllRanges(); s.addRange(r);
               document.execCommand('insertText', false, 'X');
               p.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })); }`,
          );
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit8]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              applied: document.querySelector('#viewer').textContent.includes('X第二段') || document.querySelector('#viewer').textContent.includes('第二段：测试出现第二次。X'),
              editorGone: !document.querySelector('#viewer p.block-editing'),
              dirty: !document.querySelector('.tab.active .tab-dirty').hidden,
            })`,
          ));
          // edit9: 标注块（> [!NOTE]）—— 标题行不参与编辑，正文修改后标注结构保留
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .callout').click()`);
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const bq = document.querySelector('#viewer .callout.block-editing');
               const p = bq.querySelector(':scope > p');
               p.textContent = '标注块已改';
               bq.querySelector('.block-apply').click(); }`,
          );
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit9]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              calloutKept: !!document.querySelector('#viewer .callout'),
              titleKept: !!document.querySelector('#viewer .callout-title'),
              textChanged: document.querySelector('#viewer .callout')?.textContent.includes('标注块已改') ?? false,
            })`,
          ));
          // edit10: 表格 —— 单元格文本修改 → 序列化回管道表格
          await win.webContents.executeJavaScript(`document.querySelector('#viewer table[data-block]').click()`);
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const t = document.querySelector('#viewer table.block-editing');
               [...t.querySelectorAll('td')].find((td) => td.textContent === '值').textContent = '新值';
               t.querySelector('.block-apply').click(); }`,
          );
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit10]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              cellChanged: [...document.querySelectorAll('#viewer table')].some((t) => [...t.querySelectorAll('td')].some((td) => td.textContent === '新值')),
              tableKept: document.querySelectorAll('#viewer table').length === 2,
            })`,
          ));
          // edit10b: 删除线所在表格整体重序列化 —— ~~双波浪线~~ 必须保持（gfm 插件单波浪线规则已被覆盖）
          await win.webContents.executeJavaScript(
            `{ const t = [...document.querySelectorAll('#viewer table[data-block]')].find((x) => x.textContent.includes('两段接力'));
               t.click(); }`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const t = document.querySelector('#viewer table.block-editing');
               [...t.querySelectorAll('th')].find((th) => th.textContent === '说明').textContent = '说明改';
               t.querySelector('.block-apply').click(); }`,
          );
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit10b]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              thChanged: [...document.querySelectorAll('#viewer table')].some((t) => [...t.querySelectorAll('th')].some((th) => th.textContent === '说明改')),
              delStillRendered: [...document.querySelectorAll('#viewer table')].some((t) => t.querySelector('del')?.textContent === '这是删除线'),
            })`,
          ));
          // edit11: 代码围栏 —— 点 pre 打开源码编辑（textarea 载入完整围栏含开闭标记）
          await win.webContents.executeJavaScript(`document.querySelector('#viewer pre[data-block]').click()`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:edit11]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              codeEditing: document.querySelector('#viewer pre.code-editing') !== null,
              hasFenceRaw: document.querySelector('#viewer pre.code-editing textarea')?.value === String.fromCharCode(96, 96, 96) + "js\\nconsole.log('测试');\\n" + String.fromCharCode(96, 96, 96),
            })`,
          ));
          // edit11b: 改源码 → 应用 → 重渲染出高亮代码
          await win.webContents.executeJavaScript(
            `{ const t = document.querySelector('#viewer pre.code-editing textarea');
               t.value = String.fromCharCode(96, 96, 96) + "js\\nconsole.log('新代码')\\n" + String.fromCharCode(96, 96, 96);
               document.querySelector('#viewer pre.code-editing .mermaid-apply').click(); }`,
          );
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit11b]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              codeChanged: document.querySelector('#viewer pre code')?.textContent.includes('新代码') ?? false,
              editorGone: !document.querySelector('#viewer pre.code-editing'),
              dirty: !document.querySelector('.tab.active .tab-dirty').hidden,
            })`,
          ));
          // edit12: 粘贴按纯文本（HTML 剪贴板内容被丢弃）→ Esc 取消
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer p[data-block]')][0].click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer p.block-editing');
               p.focus();
               const s = getSelection(); const r = document.createRange();
               r.selectNodeContents(p); r.collapse(false);
               s.removeAllRanges(); s.addRange(r);
               const dt = new DataTransfer();
               dt.setData('text/html', '<b>恶意</b>');
               dt.setData('text/plain', '纯文本粘贴');
               p.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:edit12]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              plainInserted: document.querySelector('#viewer p.block-editing')?.textContent.includes('纯文本粘贴') ?? false,
              htmlIgnored: !document.querySelector('#viewer p.block-editing')?.textContent.includes('恶意') ?? false,
            })`,
          ));
          await win.webContents.executeJavaScript(
            `document.querySelector('#viewer p.block-editing')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          );
          await new Promise((r) => setTimeout(r, 300));
          // edit13: 图片 —— 编辑块里的 img 序列化回原始相对路径（origSrc 还原）
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.startsWith('波浪号')).click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer p.block-editing');
               const apply = p.querySelector('.block-apply'); // innerHTML 赋值会毁掉工具条，先取按钮引用
               p.innerHTML = '图片：<img src="mdfile://local/x/a.png" data-orig-src="a.png" alt="图">';
               apply.click(); }`,
          );
          await new Promise((r) => setTimeout(r, 600));
          console.log('[dev:edit13]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              imgShown: !!document.querySelector('#viewer img'),
              srcResolved: document.querySelector('#viewer img')?.src.startsWith('mdfile://') ?? false,
              origKept: document.querySelector('#viewer img')?.dataset.origSrc ?? null,
            })`,
          ));
          // edit14: 块格式下拉 h2 → 标题 4（手工宿主重命名：属性/工具条随迁，execCommand 会丢属性）
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer [data-block]')].find((x) => x.tagName === 'H2').click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const h = document.querySelector('#viewer .block-editing');
               const sel = h.querySelector('.block-format');
               sel.value = 'h4'; sel.dispatchEvent(new Event('change')); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:edit14]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              // textContent 含工具条按钮文字，不能整体比较——只比正文文本节点
              renamed: [...(document.querySelector('#viewer h4.block-editing')?.childNodes ?? [])].some((n) => n.nodeType === 3 && n.textContent === '第二章'),
              attrsKept: document.querySelector('#viewer h4.block-editing')?.dataset.block !== undefined,
              barKept: !!document.querySelector('#viewer h4.block-editing .block-editor-bar'),
            })`,
          ));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer h4.block-editing .block-apply').click()`);
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit14b]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              rendered: [...document.querySelectorAll('#viewer h4')].some((x) => x.textContent === '第二章'),
              editorGone: !document.querySelector('#viewer .block-editing'),
            })`,
          ));
          // edit15: 无序列表 —— 段落 → 列表 → 应用回写「- 」
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.includes('这是第一段')).click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `document.querySelector('#viewer .block-editing [data-cmd="ul"]').click()`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:edit15]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              listed: !!document.querySelector('#viewer ul.block-editing'),
              liHasText: document.querySelector('#viewer ul.block-editing li')?.textContent.includes('这是第一段') ?? false,
              barKept: !!document.querySelector('#viewer ul.block-editing .block-editor-bar'),
            })`,
          ));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer ul.block-editing .block-apply').click()`);
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit15b]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              rendered: [...document.querySelectorAll('#viewer ul li')].some((x) => x.textContent.includes('这是第一段')),
            })`,
          ));
          // edit16: 列表还原 —— 段落 → 列表 → 再点还原为段落（内容不变，应用走取消路径）
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.includes('图片')).click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `document.querySelector('#viewer .block-editing [data-cmd="ul"]').click()`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:edit16]', await win.webContents.executeJavaScript(
            `JSON.stringify({ listed: !!document.querySelector('#viewer ul.block-editing') })`,
          ));
          await win.webContents.executeJavaScript(
            `document.querySelector('#viewer ul.block-editing [data-cmd="ul"]').click()`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:edit16b]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              unwrapped: !!document.querySelector('#viewer p.block-editing'),
              textKept: document.querySelector('#viewer p.block-editing')?.textContent.includes('图片') ?? false,
            })`,
          ));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer p.block-editing .block-apply').click()`);
          await new Promise((r) => setTimeout(r, 500));
          // edit17: 引用块 —— 段落 → 引用 → 应用回写「> 」
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.startsWith('第二段')).click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `document.querySelector('#viewer .block-editing [data-cmd="quote"]').click()`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:edit17]', await win.webContents.executeJavaScript(
            `JSON.stringify({ quoted: !!document.querySelector('#viewer blockquote.block-editing') })`,
          ));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer blockquote.block-editing .block-apply').click()`);
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit17b]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              rendered: [...document.querySelectorAll('#viewer blockquote')].some((x) => x.textContent.includes('第二段')),
            })`,
          ));
          // edit18: 顶栏「撤销」按钮 —— 编辑中输入后点击撤销，编辑态不退出（等同编辑菜单撤销）
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.includes('加粗测试段落')).click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:edit18]', await win.webContents.executeJavaScript(
            `JSON.stringify({ undoEnabled: !document.querySelector('#undo-btn').disabled })`,
          ));
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer .block-editing');
               p.focus();
               const s = getSelection(); const r = document.createRange();
               r.selectNodeContents(p); r.collapse(false);
               s.removeAllRanges(); s.addRange(r);
               document.execCommand('insertText', false, '撤销测试');
               document.querySelector('#undo-btn').click(); }`,
          );
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:edit18b]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              undone: !(document.querySelector('#viewer .block-editing')?.textContent.includes('撤销测试') ?? false),
              editorKept: !!document.querySelector('#viewer .block-editing'),
            })`,
          ));
          await win.webContents.executeJavaScript(
            `document.querySelector('#viewer .block-editing')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          );
          await new Promise((r) => setTimeout(r, 300));
          // edit19: 清除格式 —— 第二处「加粗」去粗体 → 应用后仅第一处保留
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.includes('加粗测试段落')).click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer .block-editing');
               const target = [...p.querySelectorAll('strong')].find((s) => s.textContent === '加粗');
               const s = getSelection(); const r = document.createRange();
               r.selectNodeContents(target); s.removeAllRanges(); s.addRange(r);
               p.querySelector('[data-cmd="removeFormat"]').click(); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:edit19]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              secondUnbolded: [...document.querySelectorAll('#viewer .block-editing strong')].every((s) => s.textContent !== '加粗'),
              firstKept: [...document.querySelectorAll('#viewer .block-editing strong')].some((s) => s.textContent === '这是加粗'),
            })`,
          ));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .block-editing .block-apply').click()`);
          await new Promise((r) => setTimeout(r, 500));
          // edit20: 行内链接 —— 选中「图片：」→ 链接 UI → 确定 → 应用回写 [文字](url)
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.includes('图片')).click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer .block-editing');
               const tn = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('图片'));
               const s = getSelection(); const r = document.createRange();
               r.selectNodeContents(tn); s.removeAllRanges(); s.addRange(r);
               p.querySelector('[data-cmd="link"]').click(); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:edit20]', await win.webContents.executeJavaScript(
            `JSON.stringify({ uiShown: !document.querySelector('#viewer .block-editing .block-link-ui').hidden })`,
          ));
          await win.webContents.executeJavaScript(
            `{ const ui = document.querySelector('#viewer .block-editing .block-link-ui');
               ui.querySelector('.block-link-input').value = 'https://example.com';
               ui.querySelector('.block-link-ok').click(); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:edit20b]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              linked: document.querySelector('#viewer .block-editing a')?.getAttribute('href') === 'https://example.com',
              uiHidden: document.querySelector('#viewer .block-editing .block-link-ui').hidden,
            })`,
          ));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .block-editing .block-apply').click()`);
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit20c]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              rendered: [...document.querySelectorAll('#viewer a')].some((x) => x.getAttribute('href') === 'https://example.com'),
            })`,
          ));
          // edit21: 插入图片 —— 相对路径插入走既有 resolve-images（文件选择器留打包冒烟手动过）
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#viewer p[data-block]')].find((x) => x.textContent.includes('图片')).click()`,
          );
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:edit21]', await win.webContents.executeJavaScript(
            `JSON.stringify({ apiPresent: typeof window.tot.selectImage === 'function' })`,
          ));
          await win.webContents.executeJavaScript(
            `{ const p = document.querySelector('#viewer .block-editing');
               p.focus();
               const s = getSelection(); const r = document.createRange();
               r.selectNodeContents(p); r.collapse(false);
               s.removeAllRanges(); s.addRange(r);
               insertImageFromRel('a.png'); }`,
          );
          await new Promise((r) => setTimeout(r, 600));
          console.log('[dev:edit21b]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              imgInserted: [...document.querySelectorAll('#viewer .block-editing img')].some((x) => x.dataset.origSrc === 'a.png'),
            })`,
          ));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .block-editing .block-apply').click()`);
          await new Promise((r) => setTimeout(r, 600));
          console.log('[dev:edit21c]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              rendered: [...document.querySelectorAll('#viewer img')].some((x) => x.dataset.origSrc === 'a.png'),
            })`,
          ));
          // edit22: 最终保存 —— 磁盘含全部修改、无被取消的修改、换行风格保持（LF）
          await win.webContents.executeJavaScript(`document.querySelector('#save-btn').click()`);
          await new Promise((r) => setTimeout(r, 700));
          const final = await fs.readFile(editFile, 'utf8');
          console.log('[dev:edit22]', JSON.stringify({
            hasRichMarker: final.includes('TOT编辑段落'),
            hasBold: final.includes('**这是加粗**'),
            hasBlur: final.includes('X第二段') || final.includes('测试出现第二次。X'),
            hasCalloutPrefix: final.includes('> [!NOTE]'),
            hasCalloutText: final.includes('标注块已改'),
            hasTableCell: final.includes('| 新值 |'),
            hasTh: final.includes('| 说明改 |'),
            delTildeKept: final.includes('~~这是删除线~~'),
            hasCode: final.includes('新代码'),
            hasImg: final.includes('![图](a.png)'),
            hasH4: final.includes('#### 第二章'),
            hasList: final.includes('-   这是第一段'),
            hasQuote: final.includes('> 第二段：测试出现第二次。X'),
            hasLink: final.includes('[图片：](https://example.com)'),
            hasImg2: final.includes('![a.png](a.png)'),
            secondBoldGone: !final.includes('**加粗**测试也在这里'),
            undoCancelled: !final.includes('撤销测试'),
            hasOldCode: !final.includes("console.log('测试')"),
            pasteCancelled: !final.includes('纯文本粘贴'),
            escCancelled: !final.includes('Y第二段'),
            lfKept: !final.includes('\r'),
            dirtyGone: await win.webContents.executeJavaScript(`document.querySelector('.tab.active .tab-dirty').hidden`),
          }));
          // edit23: 经 write-file IPC 恢复原内容，测试数据零污染
          await win.webContents.executeJavaScript(
            `window.tot.writeFile(${JSON.stringify(editFile)}, ${JSON.stringify(before)})`,
          );
          await new Promise((r) => setTimeout(r, 300));
          const restored = await fs.readFile(editFile, 'utf8');
          console.log('[dev:edit23]', JSON.stringify({ restored: restored === before }));
          // edit24: 越界路径被拒
          console.log('[dev:edit24]', JSON.stringify({
            result: await win.webContents.executeJavaScript(
              `window.tot.writeFile('C:/Windows/System32/tot-test.txt', 'x').then(() => 'ok', (e) => 'err')`,
            ),
          }));
        }
        if (process.env.TOT_SEARCH) {
          await new Promise((r) => setTimeout(r, 800));
          // search1: Ctrl+F 开搜索条，输入查询
          await win.webContents.executeJavaScript(
            `{ document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
               const si = document.querySelector('#search-input');
               si.value = ${JSON.stringify(process.env.TOT_SEARCH_QUERY || '测试')};
               si.dispatchEvent(new Event('input', { bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:search1]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              barShown: !document.querySelector('#searchbar').hidden,
              topbarKids: [...document.querySelector('#topbar').children].map((c) => c.id),
              controlsKids: [...document.querySelector('#controls').children].map((c) => c.id),
              barAfterSave: (() => { const a = document.querySelector('#searchbar').getBoundingClientRect(); const b = document.querySelector('#save-btn').getBoundingClientRect(); return a.left >= b.right; })(),
              selectAtRight: Math.round(window.innerWidth - document.querySelector('#style-select').getBoundingClientRect().right),
              marks: document.querySelectorAll('#viewer mark.tot-search').length,
              count: document.querySelector('#search-count').textContent,
              currentIdx: [...document.querySelectorAll('#viewer mark.tot-search')].findIndex((m) => m.classList.contains('current')),
            })`,
          ));
          // search2: 下一个
          await win.webContents.executeJavaScript(`document.querySelector('#search-next').click()`);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:search2]', await win.webContents.executeJavaScript(
            `JSON.stringify({ currentIdx: [...document.querySelectorAll('#viewer mark.tot-search')].findIndex((m) => m.classList.contains('current')) })`,
          ));
          // search3: 打开块级编辑时清空搜索（高亮不能混进编辑区，否则会被序列化进结果）
          await win.webContents.executeJavaScript(`[...document.querySelectorAll('#viewer p[data-block]')][0].click()`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:search3]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              queryCleared: document.querySelector('#search-input').value === '',
              marks: document.querySelectorAll('#viewer mark.tot-search').length,
              blockEditing: !!document.querySelector('#viewer p.block-editing'),
            })`,
          ));
          // search3b: 取消块编辑后重新查询，高亮恢复正常（搜索未被编辑打坏）
          await win.webContents.executeJavaScript(
            `document.querySelector('#viewer p.block-editing')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          );
          await new Promise((r) => setTimeout(r, 300));
          await win.webContents.executeJavaScript(
            `{ const si = document.querySelector('#search-input');
               si.value = ${JSON.stringify(process.env.TOT_SEARCH_QUERY || '测试')};
               si.dispatchEvent(new Event('input', { bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:search3b]', await win.webContents.executeJavaScript(
            `JSON.stringify({ marks: document.querySelectorAll('#viewer mark.tot-search').length })`,
          ));
          // search4: Esc 清除查询与高亮（搜索条常显不隐藏）
          await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:search4]', await win.webContents.executeJavaScript(
            `JSON.stringify({ barShown: !document.querySelector('#searchbar').hidden, inputCleared: document.querySelector('#search-input').value === '', marks: document.querySelectorAll('#viewer mark.tot-search').length })`,
          ));
          // search5: 跨节点命中的计数与上下跳转按完整命中（一个命中跨边界切成多个 mark 仍算一个）
          await win.webContents.executeJavaScript(
            `{ const si = document.querySelector('#search-input');
               si.value = ${JSON.stringify(process.env.TOT_SEARCH_QUERY5 || '加粗测试')};
               si.dispatchEvent(new Event('input', { bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:search5]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              marks: document.querySelectorAll('#viewer mark.tot-search').length,
              count: document.querySelector('#search-count').textContent,
              currentIdx: [...document.querySelectorAll('#viewer mark.tot-search')].findIndex((m) => m.classList.contains('current')),
              currentMarks: document.querySelectorAll('#viewer mark.tot-search.current').length,
            })`,
          ));
          // search5b: 下一个 → 跳到第二个完整命中（而不是同一命中的下一个片段）
          await win.webContents.executeJavaScript(`document.querySelector('#search-next').click()`);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:search5b]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              count: document.querySelector('#search-count').textContent,
              currentIdx: [...document.querySelectorAll('#viewer mark.tot-search')].findIndex((m) => m.classList.contains('current')),
              currentMarks: document.querySelectorAll('#viewer mark.tot-search.current').length,
            })`,
          ));
          // search5c: 再下一个 → 回绕到第一个完整命中
          await win.webContents.executeJavaScript(`document.querySelector('#search-next').click()`);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:search5c]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              count: document.querySelector('#search-count').textContent,
              currentIdx: [...document.querySelectorAll('#viewer mark.tot-search')].findIndex((m) => m.classList.contains('current')),
            })`,
          ));
          // search6: 中文输入法合成期间 Enter 不触发跳转、Esc 不清除（isComposing 守卫）
          const imeBase = await win.webContents.executeJavaScript(
            `JSON.stringify({
              count: document.querySelector('#search-count').textContent,
              currentIdx: [...document.querySelectorAll('#viewer mark.tot-search')].findIndex((m) => m.classList.contains('current')),
            })`,
          );
          await win.webContents.executeJavaScript(
            `document.querySelector('#search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))`,
          );
          await new Promise((r) => setTimeout(r, 200));
          const imeAfter = await win.webContents.executeJavaScript(
            `JSON.stringify({
              count: document.querySelector('#search-count').textContent,
              currentIdx: [...document.querySelectorAll('#viewer mark.tot-search')].findIndex((m) => m.classList.contains('current')),
            })`,
          );
          console.log('[dev:search6]', JSON.stringify({ base: JSON.parse(imeBase), afterImeEnter: JSON.parse(imeAfter), enterIgnored: imeBase === imeAfter }));
          await win.webContents.executeJavaScript(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))`,
          );
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:search6b]', await win.webContents.executeJavaScript(
            `JSON.stringify({ inputKept: document.querySelector('#search-input').value !== '', marks: document.querySelectorAll('#viewer mark.tot-search').length })`,
          ));
          // 对照：非合成 Enter 仍跳转、非合成 Esc 仍清除（守卫没有破坏正常行为）
          await win.webContents.executeJavaScript(
            `document.querySelector('#search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
          );
          await new Promise((r) => setTimeout(r, 200));
          const realAfter = await win.webContents.executeJavaScript(
            `JSON.stringify({
              count: document.querySelector('#search-count').textContent,
              currentIdx: [...document.querySelectorAll('#viewer mark.tot-search')].findIndex((m) => m.classList.contains('current')),
            })`,
          );
          console.log('[dev:search6c]', JSON.stringify({ afterRealEnter: JSON.parse(realAfter), enterMoved: realAfter !== imeAfter }));
          await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:search6d]', await win.webContents.executeJavaScript(
            `JSON.stringify({ inputCleared: document.querySelector('#search-input').value === '', marks: document.querySelectorAll('#viewer mark.tot-search').length })`,
          ));
        }
        if (process.env.TOT_DROP) {
          await new Promise((r) => setTimeout(r, 1500));
          // drop1: 合成 drop（无磁盘路径的 File）→ 默认导航被拦截，不打开标签
          console.log('[dev:drop1]', await win.webContents.executeJavaScript(
            `(async () => {
              const dt = new DataTransfer();
              dt.items.add(new File(['# fake'], 'fake.md', { type: 'text/markdown' }));
              const target = document.body;
              target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
              const prevented = !target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
              await new Promise((r) => setTimeout(r, 400));
              return JSON.stringify({
                prevented,
                tabCount: document.querySelectorAll('.tab').length,
                url: location.pathname.split('/').pop(),
              });
            })()`,
          ));
          // drop2: fixture 目录之外的真实路径经 open-dropped 打开（覆盖目录放行 + 打开流程）
          const dropDir = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'tot-drop-outside');
          await fs.mkdir(dropDir, { recursive: true });
          const dropFile = path.join(dropDir, 'dropped.md');
          await fs.writeFile(dropFile, '# 拖入打开成功\n', 'utf8');
          await win.webContents.executeJavaScript(`window.tot.openDropped(${JSON.stringify(dropFile)})`);
          await new Promise((r) => setTimeout(r, 800));
          console.log('[dev:drop2]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              tabName: document.querySelector('.tab.active .tab-name')?.textContent ?? null,
              h1: document.querySelector('#viewer h1')?.textContent ?? null,
              tabCount: document.querySelectorAll('.tab').length,
            })`,
          ));
          // drop3: 非 md 路径被拒
          await win.webContents.executeJavaScript(`window.tot.openDropped(${JSON.stringify(path.join(dropDir, 'x.txt'))})`);
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:drop3]', await win.webContents.executeJavaScript(
            `JSON.stringify({ tabCount: document.querySelectorAll('.tab').length })`,
          ));
          await fs.unlink(dropFile).catch(() => {});
        }
        if (process.env.TOT_MERMAID) {
          const mermaidFile = path.join(path.resolve(process.env.TOT_OPEN_DIR), 'mermaid-test.md');
          const before = await fs.readFile(mermaidFile, 'utf8'); // 基线（CRLF），最后还原用
          await new Promise((r) => setTimeout(r, 3000)); // 等树懒加载定位完成
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree a')].find((a) => a.title === ${JSON.stringify(mermaidFile)})?.click()`,
          );
          await new Promise((r) => setTimeout(r, 1500)); // mermaid 渲染是异步的
          // mermaid1: 渲染断言 —— 4 wrapper（2 svg + 2 错误态：坏语法 / 拼错图型名），序号 1:1，无 hljs 残留，
          // 且 mermaid 失败的临时容器不泄漏到 body（用户可见的巨型「Syntax error in text」错误图）
          console.log('[dev:mermaid1]', await win.webContents.executeJavaScript(`JSON.stringify({
            mermaidLoaded: typeof window.mermaid !== 'undefined',
            wrappers: document.querySelectorAll('#viewer .mermaid-wrapper').length,
            idx: [...document.querySelectorAll('#viewer .mermaid-wrapper')].map((w) => w.dataset.idx),
            svgs: document.querySelectorAll('#viewer .mermaid-wrapper > svg').length,
            errors: document.querySelectorAll('#viewer .mermaid-wrapper.mermaid-error').length,
            seqActor: [...document.querySelectorAll('#viewer .mermaid-wrapper > svg')].some((s) => s.textContent.includes('Alice')),
            flowNode: [...document.querySelectorAll('#viewer .mermaid-wrapper > svg')].some((s) => s.textContent.includes('开始')),
            hljsInside: document.querySelectorAll('#viewer .mermaid-wrapper .hljs-keyword, #viewer .mermaid-wrapper .hljs-string, #viewer .mermaid-wrapper pre').length,
            themes: [...document.querySelectorAll('#viewer .mermaid-wrapper')].map((w) => w.dataset.theme),
            svgId: document.querySelector('#viewer .mermaid-wrapper > svg')?.id ?? null,
            svgSize: (() => { const r = document.querySelector('#viewer .mermaid-wrapper > svg')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; })(),
            errorTexts: [...document.querySelectorAll('#viewer .mermaid-wrapper.mermaid-error')].map((w) => w.textContent),
            bodyLeak: [...document.body.children].filter((el) => el.id && el.id.startsWith('dtot-mermaid-')).length,
          })`));
          // mermaid2: 搜索排除 —— 图表内标签词 Alice 全程 0 mark；正文词 Mermaid（标题）正常命中且 svg 内仍 0
          await win.webContents.executeJavaScript(
            `{ const si = document.querySelector('#search-input'); si.value = 'Alice'; si.dispatchEvent(new Event('input', { bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          const mermaid2a = await win.webContents.executeJavaScript(
            `JSON.stringify({ marksInSvg: document.querySelectorAll('#viewer svg mark, #viewer .mermaid-wrapper mark').length, marksTotal: document.querySelectorAll('#viewer mark.tot-search').length })`,
          );
          await win.webContents.executeJavaScript(
            `{ const si = document.querySelector('#search-input'); si.value = 'Mermaid'; si.dispatchEvent(new Event('input', { bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          const mermaid2b = await win.webContents.executeJavaScript(
            `JSON.stringify({ marksTotal: document.querySelectorAll('#viewer mark.tot-search').length, marksInSvg: document.querySelectorAll('#viewer svg mark').length })`,
          );
          console.log('[dev:mermaid2]', JSON.stringify({ alice: JSON.parse(mermaid2a), mermaid: JSON.parse(mermaid2b) }));
          await win.webContents.executeJavaScript(`document.querySelector('#search-close').click()`);
          // mermaid3: 切暗色 → 全部 wrapper 重渲染（theme=dark 且 svg id 变化 = svg 被替换）
          await win.webContents.executeJavaScript(
            `{ const sel = document.querySelector('#style-select'); sel.value = 'github-dark'; sel.dispatchEvent(new Event('change')); }`,
          );
          await new Promise((r) => setTimeout(r, 800));
          console.log('[dev:mermaid3]', await win.webContents.executeJavaScript(`JSON.stringify({
            bodyClass: document.body.className,
            themes: [...document.querySelectorAll('#viewer .mermaid-wrapper')].map((w) => w.dataset.theme),
            newSvgId: document.querySelector('#viewer .mermaid-wrapper > svg')?.id ?? null,
            svgs: document.querySelectorAll('#viewer .mermaid-wrapper > svg').length,
            errors: document.querySelectorAll('#viewer .mermaid-wrapper.mermaid-error').length,
          })`));
          // 切回亮色继续
          await win.webContents.executeJavaScript(
            `{ const sel = document.querySelector('#style-select'); sel.value = 'github-light'; sel.dispatchEvent(new Event('change')); }`,
          );
          await new Promise((r) => setTimeout(r, 800));
          // mermaid4: 预览模式编辑 —— 打开（含源码/序号保留）→ 只开一个 → 改标签 → debounce 预览更新 → 取消恢复
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .mermaid-wrapper').click()`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:mermaid4]', await win.webContents.executeJavaScript(`JSON.stringify({
            editorOpen: !!document.querySelector('#viewer .mermaid-editor'),
            srcHasAlice: document.querySelector('#viewer .mermaid-editor-input')?.value.includes('Alice'),
            editingClass: document.querySelector('#viewer .mermaid-wrapper').classList.contains('mermaid-editing'),
            idxKept: document.querySelector('#viewer .mermaid-wrapper').dataset.idx,
          })`));
          await win.webContents.executeJavaScript(`document.querySelectorAll('#viewer .mermaid-wrapper')[1].click()`);
          await new Promise((r) => setTimeout(r, 600));
          console.log('[dev:mermaid4b]', await win.webContents.executeJavaScript(`JSON.stringify({
            editors: document.querySelectorAll('#viewer .mermaid-editor').length,
            firstRestored: !!document.querySelectorAll('#viewer .mermaid-wrapper')[0].querySelector('svg'),
            secondEditing: document.querySelectorAll('#viewer .mermaid-wrapper')[1].classList.contains('mermaid-editing'),
          })`));
          await win.webContents.executeJavaScript(
            `{ const t = document.querySelectorAll('#viewer .mermaid-wrapper')[1].querySelector('.mermaid-editor-input'); t.value = t.value.split('开始').join('起点'); t.dispatchEvent(new Event('input', { bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 600));
          console.log('[dev:mermaid4c]', await win.webContents.executeJavaScript(`JSON.stringify({
            previewUpdated: document.querySelectorAll('#viewer .mermaid-wrapper')[1].querySelector('.mermaid-editor-preview svg')?.textContent.includes('起点') ?? false,
          })`));
          await win.webContents.executeJavaScript(`document.querySelectorAll('#viewer .mermaid-wrapper')[1].querySelector('.mermaid-cancel').click()`);
          await new Promise((r) => setTimeout(r, 600));
          console.log('[dev:mermaid4d]', await win.webContents.executeJavaScript(`JSON.stringify({
            editorGone: !document.querySelectorAll('#viewer .mermaid-wrapper')[1].querySelector('.mermaid-editor'),
            restored: document.querySelectorAll('#viewer .mermaid-wrapper')[1].querySelector('svg')?.textContent.includes('开始') ?? false,
            dirty: !document.querySelector('.tab.active .tab-dirty').hidden,
          })`));
          // mermaid5: 应用 —— tab.text 更新 + dirty + 重渲染（预览即编辑：无编辑模式可切）
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .mermaid-wrapper').click()`);
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const t = document.querySelector('#viewer .mermaid-editor-input'); t.value = t.value.split('Alice').join('爱丽丝'); t.dispatchEvent(new Event('input', { bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .mermaid-apply').click()`);
          await new Promise((r) => setTimeout(r, 800));
          console.log('[dev:mermaid5]', await win.webContents.executeJavaScript(`JSON.stringify({
            editorGone: !document.querySelector('#viewer .mermaid-editor'),
            svgHasNew: document.querySelector('#viewer .mermaid-wrapper > svg')?.textContent.includes('爱丽丝') ?? false,
            svgHasOld: document.querySelector('#viewer .mermaid-wrapper > svg')?.textContent.includes('Alice') ?? false,
            dirty: !document.querySelector('.tab.active .tab-dirty').hidden,
          })`));
          // mermaid5b: 应用后 dirty → 保存按钮启用
          console.log('[dev:mermaid5b]', await win.webContents.executeJavaScript(`JSON.stringify({
            saveEnabled: !document.querySelector('#save-btn').disabled,
            tabDirty: !document.querySelector('.tab.active .tab-dirty').hidden,
          })`));
          // mermaid6: 预览区再改 爱丽丝→鲍勃 应用 —— 重渲染 + dirty；保存落盘 CRLF 还原
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .mermaid-wrapper').click()`);
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const t = document.querySelector('#viewer .mermaid-editor-input'); t.value = t.value.split('爱丽丝').join('鲍勃'); t.dispatchEvent(new Event('input', { bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .mermaid-apply').click()`);
          await new Promise((r) => setTimeout(r, 800));
          console.log('[dev:mermaid6]', await win.webContents.executeJavaScript(`JSON.stringify({
            svgHasNew: document.querySelector('#viewer .mermaid-wrapper > svg')?.textContent.includes('鲍勃') ?? false,
            svgHasOld: document.querySelector('#viewer .mermaid-wrapper > svg')?.textContent.includes('爱丽丝') ?? false,
            dirty: !document.querySelector('.tab.active .tab-dirty').hidden,
          })`));
          await win.webContents.executeJavaScript(`document.querySelector('#save-btn').click()`);
          await new Promise((r) => setTimeout(r, 700));
          const saved = await fs.readFile(mermaidFile, 'utf8');
          console.log('[dev:mermaid6b]', JSON.stringify({
            diskHasNew: saved.includes('鲍勃'),
            crlfPreserved: saved.includes('\r\n') && !/[^\r]\n/.test(saved),
            dirtyGone: await win.webContents.executeJavaScript(`document.querySelector('.tab.active .tab-dirty').hidden`),
          }));
          // mermaid7: 错误态围栏（坏语法，idx 2）—— Esc 取消路径 + 打开修复 + 应用后 4 svg 1 错误
          await win.webContents.executeJavaScript(`[...document.querySelectorAll('#viewer .mermaid-wrapper')][2].click()`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:mermaid7]', await win.webContents.executeJavaScript(`JSON.stringify({
            editorOnError: [...document.querySelectorAll('#viewer .mermaid-wrapper')][2].querySelector('.mermaid-editor-input')?.value.includes('未闭合') ?? false,
          })`));
          await win.webContents.executeJavaScript(
            `document.querySelector('#viewer .mermaid-editor-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
          );
          await new Promise((r) => setTimeout(r, 600));
          console.log('[dev:mermaid7b]', await win.webContents.executeJavaScript(`JSON.stringify({
            editorGone: !document.querySelector('#viewer .mermaid-editor'),
            errorsStill: document.querySelectorAll('#viewer .mermaid-wrapper.mermaid-error').length,
          })`));
          await win.webContents.executeJavaScript(`[...document.querySelectorAll('#viewer .mermaid-wrapper')][2].click()`);
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `{ const t = document.querySelector('#viewer .mermaid-editor-input'); t.value = t.value.split('A[未闭合').join('A[已闭合]'); t.dispatchEvent(new Event('input', { bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .mermaid-apply').click()`);
          await new Promise((r) => setTimeout(r, 800));
          console.log('[dev:mermaid7c]', await win.webContents.executeJavaScript(`JSON.stringify({
            svgs: document.querySelectorAll('#viewer .mermaid-wrapper > svg').length,
            errors: document.querySelectorAll('#viewer .mermaid-wrapper.mermaid-error').length,
            fixed: [...document.querySelectorAll('#viewer .mermaid-wrapper > svg')].some((s) => s.textContent.includes('已闭合')),
          })`));
          // mermaid7d: 拼错图型名（chart TD，idx 3）错误态 —— 错误信息含「图型未识别」，编辑器载入原源码，修正后 5 svg 0 错误
          const mermaid7dPre = JSON.parse(await win.webContents.executeJavaScript(
            `JSON.stringify({ chartErrText: [...document.querySelectorAll('#viewer .mermaid-wrapper')][3].textContent.includes('No diagram type detected') })`,
          ));
          await win.webContents.executeJavaScript(`[...document.querySelectorAll('#viewer .mermaid-wrapper')][3].click()`);
          await new Promise((r) => setTimeout(r, 400));
          const mermaid7dOpen = JSON.parse(await win.webContents.executeJavaScript(
            `JSON.stringify({ editorHasChart: [...document.querySelectorAll('#viewer .mermaid-wrapper')][3].querySelector('.mermaid-editor-input')?.value.includes('chart TD') ?? false })`,
          ));
          await win.webContents.executeJavaScript(
            `{ const t = document.querySelector('#viewer .mermaid-editor-input'); t.value = t.value.split('chart TD').join('flowchart TD'); t.dispatchEvent(new Event('input', { bubbles: true })); }`,
          );
          await new Promise((r) => setTimeout(r, 300));
          await win.webContents.executeJavaScript(`document.querySelector('#viewer .mermaid-apply').click()`);
          await new Promise((r) => setTimeout(r, 800));
          console.log('[dev:mermaid7d]', await win.webContents.executeJavaScript(`JSON.stringify({
            ...${JSON.stringify(mermaid7dPre)}, ...${JSON.stringify(mermaid7dOpen)},
            svgs: document.querySelectorAll('#viewer .mermaid-wrapper > svg').length,
            errors: document.querySelectorAll('#viewer .mermaid-wrapper.mermaid-error').length,
            chartFixed: [...document.querySelectorAll('#viewer .mermaid-wrapper > svg')].some((s) => s.textContent.includes('测试')),
          })`));
          // 还原 fixture（测试数据零污染）
          await win.webContents.executeJavaScript(`window.tot.writeFile(${JSON.stringify(mermaidFile)}, ${JSON.stringify(before)})`);
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:mermaid8]', JSON.stringify({ restored: await fs.readFile(mermaidFile, 'utf8') === before }));
        }
        if (process.env.TOT_DRAG) {
          await new Promise((r) => setTimeout(r, 3000)); // 等树懒加载定位完成
          const drag = (x0, x1, y) => win.webContents.executeJavaScript(
            `{ const fire = (type, x, yy, target) => target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: yy, bubbles: true }));
              const r = document.querySelector('#sidebar-resizer');
              fire('pointerdown', ${x0}, ${y}, r);
              fire('pointermove', ${x1}, ${y}, document);
              fire('pointerup', ${x1}, ${y}, document); }`,
          );
          // drag1: 300 → 480
          await drag(300, 480, 300);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:drag1]', await win.webContents.executeJavaScript(
            `JSON.stringify({ sidebarWidth: document.querySelector('#sidebar').getBoundingClientRect().width })`,
          ));
          // drag2: 拖到 900 → clamp 600
          await drag(480, 900, 300);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:drag2]', await win.webContents.executeJavaScript(
            `JSON.stringify({ sidebarWidth: document.querySelector('#sidebar').getBoundingClientRect().width })`,
          ));
          // drag3: 拖到 0 → clamp 200
          await drag(600, 0, 300);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:drag3]', await win.webContents.executeJavaScript(
            `JSON.stringify({ sidebarWidth: document.querySelector('#sidebar').getBoundingClientRect().width, stored: localStorage.getItem('tot-panels') })`,
          ));
        }
        if (process.env.TOT_PANELS) {
          await new Promise((r) => setTimeout(r, 3000)); // 等树懒加载定位完成
          // TOT_STYLE 指定时先切换到该风格再截（驱动侧兼容旧风格名）
          const styleId = { light: 'github-light', dark: 'github-dark' }[process.env.TOT_STYLE] || process.env.TOT_STYLE;
          if (styleId) {
            await win.webContents.executeJavaScript(
              `{ const sel = document.querySelector('#style-select'); sel.value = ${JSON.stringify(styleId)}; sel.dispatchEvent(new Event('change')); }`,
            );
            await new Promise((r) => setTimeout(r, 600));
          }
          const base = process.env.TOT_PANELS.replace(/\.png$/i, '');
          const shot = async (name) => {
            const img = await win.webContents.capturePage();
            await fs.writeFile(`${base}-${name}.png`, img.toPNG());
            console.log(`[dev] screenshot saved: ${base}-${name}.png`);
          };
          const pstate = () => win.webContents.executeJavaScript(
            `JSON.stringify({
              labels: [...document.querySelectorAll('.panel-header span')].map((s) => s.textContent),
              toggles: [...document.querySelectorAll('.panel-toggle')].map((b) => b.textContent),
              treeCollapsed: document.querySelector('#sidebar').classList.contains('tree-collapsed'),
              outlineCollapsed: document.querySelector('#sidebar').classList.contains('outline-collapsed'),
              treeHeader: getComputedStyle(document.querySelector('#tree-header')).display !== 'none',
              outlineHeader: getComputedStyle(document.querySelector('#outline-header')).display !== 'none',
              outlineBody: getComputedStyle(document.querySelector('#outline-body')).display !== 'none',
              sidebarWidth: Math.round(document.querySelector('#sidebar').getBoundingClientRect().width),
              outlineHeight: Math.round(document.querySelector('#outline-body').getBoundingClientRect().height),
              openDirs: [...document.querySelectorAll('#file-tree details[open]')].map((d) => d.dataset.path),
              dirHidden: [...document.querySelectorAll('#file-tree li.dir-hidden')].map((li) => li.querySelector('summary')?.textContent),
              pathHidden: [...document.querySelectorAll('#file-tree li.path-hidden')].map((li) => li.querySelector('summary')?.textContent).length,
              treeDirs: [...document.querySelectorAll('#file-tree summary')].filter((s) => !s.closest('li.path-hidden, li.dir-hidden')).map((s) => s.textContent).slice(0, 20),
            })`,
          );
          // 1. 空态默认：目录展开、大纲隐藏
          await shot('1-empty');
          console.log('[dev:panels1]', await pstate());
          // 2. 打开文档默认：大纲展开、目录折叠
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === 'README.md')?.click()`,
          );
          await new Promise((r) => setTimeout(r, 800));
          await shot('2-open');
          console.log('[dev:panels2]', await pstate());
          // 3. 手动展开目录 → 大纲自动折叠（标签钉底、内容不显示）
          await win.webContents.executeJavaScript(`document.querySelector('#tree-toggle').click()`);
          await new Promise((r) => setTimeout(r, 300));
          await shot('3-tree-only');
          console.log('[dev:panels3]', await pstate());
          // 4. 手动展开大纲 → 目录自动折叠（标签钉顶、内容不显示）
          await win.webContents.executeJavaScript(`document.querySelector('#outline-toggle').click()`);
          await new Promise((r) => setTimeout(r, 300));
          await shot('4-outline-only');
          console.log('[dev:panels4]', await pstate());
          // 5. 关闭标签页 → 回到空态默认
          await win.webContents.executeJavaScript(`document.querySelector('.tab-close').click()`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:panels5]', await pstate());
          // 6. 树聚焦：先展开 nested 目录（懒加载出文件），再打开其中的 note.markdown
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree summary')].find((s) => s.textContent === 'nested')?.click()`,
          );
          await new Promise((r) => setTimeout(r, 600));
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree a')].find((a) => /nested[\\\\/]note\\.markdown$/.test(a.title))?.click()`,
          );
          await new Promise((r) => setTimeout(r, 800));
          console.log('[dev:panels6]', await pstate());
          await win.webContents.executeJavaScript(`document.querySelector('.tab-close').click()`);
          await new Promise((r) => setTimeout(r, 400));
        }
        if (process.env.TOT_SCREENSHOT) {
          await new Promise((r) => setTimeout(r, Number(process.env.TOT_WAIT) || 1500));
          // TOT_STYLE 指定时先切换到该风格再截（驱动侧兼容旧风格名）
          const styleId = { light: 'github-light', dark: 'github-dark' }[process.env.TOT_STYLE] || process.env.TOT_STYLE;
          if (styleId) {
            await win.webContents.executeJavaScript(
              `{ const sel = document.querySelector('#style-select'); sel.value = ${JSON.stringify(styleId)}; sel.dispatchEvent(new Event('change')); }`,
            );
            await new Promise((r) => setTimeout(r, 600));
          }
          const base = process.env.TOT_SCREENSHOT.replace(/\.png$/i, '');
          const shot1 = await win.webContents.capturePage();
          await fs.writeFile(`${base}.png`, shot1.toPNG());
          console.log(`[dev] screenshot saved: ${base}.png`);
          await win.webContents.executeJavaScript(
            `(document.querySelector('#viewer .callout') || document.querySelectorAll('#viewer h3')[1])?.scrollIntoView({ block: 'center' })`,
          );
          await new Promise((r) => setTimeout(r, 900));
          const shot2 = await win.webContents.capturePage();
          await fs.writeFile(`${base}-scrolled.png`, shot2.toPNG());
          console.log(`[dev] screenshot saved: ${base}-scrolled.png`);
        }
    } catch (err) {
      console.error('[dev] auto-drive failed:', err);
    }
    if (process.env.TOT_SCREENSHOT || process.env.TOT_CHECK || process.env.TOT_PANELS || process.env.TOT_DRAG || process.env.TOT_DROP || process.env.TOT_MERMAID || process.env.TOT_EDIT || process.env.TOT_SEARCH || process.env.TOT_TABS) app.quit();
  });
}

// 文件关联双击：单实例——已运行实例经 second-instance 接收路径并打开
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', async (_e, argv) => {
    for (const p of pendingMdPaths(argv)) {
      if (winReady && win) await openByPath(p);
      else startupMdPaths.push(p);
    }
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (process.env.TOT_ARGV_HOLD) {
      // 文件关联二次双击验证：断言转交过来的文件已打开
      await new Promise((r) => setTimeout(r, 1500));
      console.log('[dev:argv2]', await win.webContents.executeJavaScript(
        `JSON.stringify({ tabs: [...document.querySelectorAll('.tab .tab-name')].map((t) => t.textContent), h1: document.querySelector('#viewer h1')?.textContent ?? null })`,
      ));
      app.quit();
    }
  });

  app.whenReady().then(() => {
    protocol.handle('mdfile', handleMdfile);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
