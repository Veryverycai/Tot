'use strict';

// ---------- marked 配置：转义原始 HTML，防本地 md 内嵌脚本 ----------

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

marked.use({
  renderer: {
    html(token) {
      return escapeHtml(typeof token === 'string' ? token : token.text);
    },
  },
});

// ---------- 状态 ----------

const state = {
  root: null,        // 当前根目录
  style: localStorage.getItem('tot-style') || 'light',
};

// 标签页：{ id, path, name, text, dirty, lineEnding, scrollTop }
const tabs = [];
let activeTab = null;
let openSeq = 0;      // 打开序号：防慢 readFile 晚到覆盖当前标签页

const $ = (sel) => document.querySelector(sel);

// 当前活动的渲染区与滚动容器（应用只有预览一个界面）
function activeViewer() {
  return $('#viewer');
}

function activeScroll() {
  return $('#preview-scroll');
}

// ---------- 风格切换 ----------

// 风格注册表：每个 id 对应一个 body class + 若干 css 文件（link 惰性创建）
// dark 标记驱动原生菜单栏明暗（Windows 菜单栏随应用深色模式着色）
const STYLES = [
  { id: 'github-light', group: 'GitHub', label: 'GitHub 亮', dark: false, files: ['../lib/github-markdown-light.css', 'styles/github-light.css', 'styles/callouts.css', 'styles/mermaid.css'] },
  { id: 'github-dark', group: 'GitHub', label: 'GitHub 暗', dark: true, files: ['../lib/github-markdown-dark.css', 'styles/github-dark.css', 'styles/callouts-dark.css', 'styles/shell-github-dark.css', 'styles/mermaid-dark.css'] },
  { id: 'minimal', group: '极简', label: '极简', dark: false, files: ['styles/minimal.css', 'styles/callouts.css', 'styles/mermaid.css'] },
  { id: 'rtd', group: '文档', label: 'Read the Docs', dark: false, files: ['styles/rtd.css', 'styles/callouts.css', 'styles/mermaid.css'] },
  { id: 'notion-light', group: '文档', label: 'Notion 亮', dark: false, files: ['styles/notion-light.css', 'styles/callouts.css', 'styles/mermaid.css'] },
  { id: 'notion-dark', group: '文档', label: 'Notion 暗', dark: true, files: ['styles/notion-dark.css', 'styles/callouts-dark.css', 'styles/mermaid-dark.css'] },
  { id: 'typora-white', group: '文档', label: 'Typora White', dark: false, files: ['styles/typora-white.css', 'styles/callouts.css', 'styles/mermaid.css'] },
  { id: 'typora-night', group: '文档', label: 'Typora Night', dark: true, files: ['styles/typora-night.css', 'styles/callouts-dark.css', 'styles/mermaid-dark.css'] },
  { id: 'obsidian', group: '文档', label: 'Obsidian', dark: true, files: ['styles/obsidian.css', 'styles/callouts-dark.css', 'styles/mermaid-dark.css'] },
  { id: 'newspaper', group: '文档', label: '报纸', dark: false, files: ['styles/newspaper.css', 'styles/callouts.css', 'styles/mermaid.css'] },
  { id: 'dracula', group: '代码编辑器', label: 'Dracula', dark: true, files: ['styles/dracula.css', 'styles/callouts-dark.css', 'styles/mermaid-dark.css'] },
  { id: 'nord', group: '代码编辑器', label: 'Nord', dark: true, files: ['styles/nord.css', 'styles/callouts-dark.css', 'styles/mermaid-dark.css'] },
  { id: 'monokai', group: '代码编辑器', label: 'Monokai', dark: true, files: ['styles/monokai.css', 'styles/callouts-dark.css', 'styles/mermaid-dark.css'] },
];

// 老版本 localStorage 存的 light/dark 迁移到新 id
const LEGACY_STYLES = { light: 'github-light', dark: 'github-dark' };

function normStyle(v) {
  if (STYLES.some((s) => s.id === v)) return v;
  return LEGACY_STYLES[v] || 'github-light';
}

// 惰性创建每个风格对应的 <link data-style-id>（CSP style-src file: 允许）
function ensureStyleLinks() {
  for (const s of STYLES) {
    for (const file of s.files) {
      if (!document.querySelector(`link[data-style-id="${s.id}"][href="${file}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = file;
        link.dataset.styleId = s.id;
        link.disabled = true;
        document.head.append(link);
      }
    }
  }
}

// Mermaid 就地编辑状态（声明提前：applyStyle 初始化时即调用 reThemeMermaids → flushDiagramEdit，须在 TDZ 之前）
let diagramEditor = null;        // { tab, viewerEl, wrapper, idx, originalSrc }：当前打开的就地编辑器
let diagramPreviewTimer = null;  // 编辑器内实时预览 debounce
let mermaidIdSeq = 0;            // mermaid.render 要求 id 全局唯一（成为 svg id）：两个渲染区共存，全局递增
let mermaidTheme = null;         // 最近一次 mermaid.initialize 的主题：'neutral' | 'dark'
const mermaidSrcs = new WeakMap(); // wrapper → 围栏原始源码（重渲染/编辑/恢复共用）

function applyStyle(id) {
  ensureStyleLinks();
  for (const s of STYLES) {
    document.querySelectorAll(`link[data-style-id="${s.id}"]`)
      .forEach((l) => { l.disabled = s.id !== id; });
  }
  document.body.className = `style-${id}`;
  $('#style-select').value = id;
  localStorage.setItem('tot-style', id);
  // 原生菜单栏明暗跟随渲染风格
  window.tot.setTheme(STYLES.find((s) => s.id === id).dark);
  reThemeMermaids(); // 不 await：后台按新明暗主题重渲染图表
}

// 由注册表生成选项分组，杜绝两份清单漂移
{
  const styleSelect = $('#style-select');
  for (const group of [...new Set(STYLES.map((s) => s.group))]) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const s of STYLES.filter((x) => x.group === group)) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label;
      og.append(opt);
    }
    styleSelect.append(og);
  }
}

$('#style-select').addEventListener('change', (e) => {
  state.style = e.target.value;
  applyStyle(state.style);
});
state.style = normStyle(state.style);
applyStyle(state.style);

// ---------- 菜单命令（主进程 File 菜单触发，打开文件/文件夹由主进程处理对话框） ----------

window.tot.onMenuCommand((cmd) => {
  if (cmd === 'save') saveActiveTab();
  else if (cmd === 'undo') undoAction();
  else if (cmd === 'redo') redoAction();
});

// ---------- 目录与文件树（我的电脑 → 盘符 → 文件夹 → 文件，点开哪层扫哪层） ----------

// 启动：构建「我的电脑」根节点，下面挂盘符
window.tot.onInitTree((data) => {
  const treeEl = $('#file-tree');
  treeEl.textContent = '';
  const li = document.createElement('li');
  const root = document.createElement('details');
  root.open = true;
  root.dataset.pcRoot = '1';
  const summary = document.createElement('summary');
  summary.textContent = '我的电脑';
  root.append(summary, buildTree(data.drives));
  li.append(root);
  const ul = document.createElement('ul');
  ul.append(li);
  treeEl.append(ul);
  $('#empty p').textContent = '选择一个 Markdown 文件开始浏览';
  restoreTreeActive();
});

// 菜单 打开文件夹：树从我的电脑逐层定位展开到该目录
window.tot.onLocatePath(async (data) => {
  await walkPath(data.path);
  document.querySelector(`#file-tree details[data-path="${CSS.escape(data.path)}"] summary`)?.scrollIntoView({ block: 'center' });
});

// 菜单 打开文件 / 最近打开：定位展开并打开该文件
window.tot.onOpenFilePath(async (data) => {
  await openFile(data.path);
});

// 菜单 最近打开的文件已被删除：主进程已从索引移除，这里给出提示
window.tot.onOpenFileError(() => {
  showStatus('文件不存在，已从「最近打开」中移除', true);
});

function buildTree(entries) {
  const ul = document.createElement('ul');
  for (const entry of (entries || [])) {
    const li = document.createElement('li');
    if (entry.type === 'dir') {
      const details = document.createElement('details');
      details.open = false; // 目录默认折叠，只展开打开文件所在路径（walkPath）
      details.dataset.path = entry.path;
      const summary = document.createElement('summary');
      summary.textContent = entry.name;
      details.append(summary, buildTree(entry.children));
      details.addEventListener('toggle', () => { if (details.open) loadChildren(details); });
      li.append(details);
    } else {
      const a = document.createElement('a');
      a.textContent = entry.name;
      a.href = '#';
      a.title = entry.path;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openFile(entry.path, a);
      });
      li.append(a);
    }
    ul.append(li);
  }
  return ul;
}

// 懒加载：目录首次展开时扫描其直接子项并挂到树上（同路径并发请求合并）
const scanInflight = new Map();

async function loadChildren(details) {
  const p = details.dataset.path;
  if (!p || details.dataset.loaded === '1') return;
  if (!scanInflight.has(p)) {
    scanInflight.set(p, window.tot.scanChildren(p)
      .then(({ tree }) => {
        details.append(buildTree(tree));
        details.dataset.loaded = '1';
      })
      .catch(() => { details.dataset.loaded = '1'; })
      .finally(() => scanInflight.delete(p)));
  }
  await scanInflight.get(p);
}

// 逐层懒加载展开到 p：文件展开到其父目录，目录展开到其自身（含子项）。
// 注意盘符路径带尾反斜杠（C:\），子目录路径不带（path.join 产物），逐级拼接要区分。
// 展开的同时做路径聚焦：链上每一级只显示路径上的下一个文件夹（兄弟文件夹与无关文件
// 隐藏，.path-hidden），末级只显示该目录下的 MD 文档（子文件夹隐藏，.dir-hidden）。
// 链外的层保持原样——空态手动浏览时没有聚焦，全部正常显示。
async function walkPath(p) {
  const isFile = /\.(md|markdown)$/i.test(p);
  const parts = p.split(/[\\/]/);
  const chain = [parts[0] + '\\'];
  for (let i = 1; i < parts.length - (isFile ? 1 : 0); i++) {
    const prev = chain[chain.length - 1];
    chain.push(prev.endsWith('\\') ? prev + parts[i] : prev + '\\' + parts[i]);
  }
  for (let i = 0; i < chain.length; i++) {
    const d = document.querySelector(`#file-tree details[data-path="${CSS.escape(chain[i])}"]`);
    if (!d) break; // 链条断开（路径不在可浏览盘符下），停止
    if (!d.open) d.open = true; // 触发 toggle 开始懒加载
    await loadChildren(d); // 等该层加载完成，下一层节点才会出现
    const next = chain[i + 1];
    d.querySelectorAll(':scope > ul > li').forEach((li) => {
      li.classList.remove('path-hidden', 'dir-hidden');
      const childDir = li.querySelector(':scope > details');
      const isFileLi = li.querySelector(':scope > a');
      const keep = next ? (childDir && childDir.dataset.path === next) : isFileLi;
      if (!keep) li.classList.add(next ? 'path-hidden' : 'dir-hidden');
    });
  }
}

// ---------- 标签页 ----------

function baseName(p) {
  return p.split(/[\\/]/).pop();
}

// 打开文件：已开则激活，否则新建标签页并渲染
async function openFile(filePath, linkEl) {
  const existing = tabs.find((t) => t.path === filePath);
  if (existing) {
    await activateTab(existing);
  } else {
    const seq = ++openSeq;
    let text;
    try {
      text = await window.tot.readFile(filePath);
    } catch {
      showStatus('打开失败：文件不存在或无法读取', true);
      return;
    }
    if (seq !== openSeq) return; // 已有更新的打开请求，丢弃本次
    // 内存统一为 \n：marked.lexer 的 token.raw 已把 CRLF 归一成 LF，若拿它去切片
    // 仍含 CRLF 的原文，块区间会从第一个换行起逐行前移——退编辑写回就会串块
    // （吞空行、尾字重复，甚至把标题写进上一段把正文弄粗）。保存时按 lineEnding 还原
    const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
    const normalized = text.replace(/\r\n?/g, '\n');
    const tab = {
      id: `tab-${seq}`,
      path: filePath,
      name: baseName(filePath),
      text: normalized,
      savedText: normalized, // 最近一次保存的文本：dirty 与撤销后的判定基准
      undoStack: [],        // 块/图表编辑提交前的文本快照
      redoStack: [],
      dirty: false,
      lineEnding,
      scrollTop: 0,
    };
    tabs.push(tab);
    await renderTab(tab);
  }
  if (linkEl) {
    document.querySelectorAll('#file-tree a.active').forEach((a) => a.classList.remove('active'));
    linkEl.classList.add('active');
  }
  // 记入文件菜单的「最近打开」
  window.tot.addRecent(filePath);
  // 树定位：懒加载展开到该文件所在路径（路径聚焦），并滚进可视区
  await walkPath(filePath);
  restoreTreeActive();
  document.querySelector(`#file-tree a[title="${CSS.escape(filePath)}"]`)?.scrollIntoView({ block: 'center' });
}

// 新开标签页：渲染到预览区
async function renderTab(tab) {
  activeTab = tab;
  $('#panes').hidden = false;
  $('#empty').hidden = true;
  await renderMarkdown($('#viewer'), tab.text, tab.path);
  rebuildOutline();
  // 打开文档的默认布局：展开大纲、折叠目录（文档无大纲时保持目录展开）
  if (!$('#outline-header').hidden) {
    setPanelCollapsed('outline-collapsed', false);
    setPanelCollapsed('tree-collapsed', true);
  }
  activeScroll().scrollTop = 0;
  updateTabbar();
  updateUndoButton();
  restoreTreeActive();
}

// 切换标签页：互存滚动位置，重渲染并恢复
async function activateTab(tab) {
  if (tab === activeTab) return;
  if (activeTab) activeTab.scrollTop = activeScroll().scrollTop;
  activeTab = tab;
  $('#panes').hidden = false;
  $('#empty').hidden = true;
  await renderMarkdown($('#viewer'), tab.text, tab.path);
  rebuildOutline();
  activeScroll().scrollTop = tab.scrollTop;
  updateTabbar();
  updateUndoButton();
  restoreTreeActive();
}

function updateTabbar() {
  const bar = $('#tabbar');
  bar.textContent = '';
  bar.hidden = tabs.length === 0;
  $('#save-btn').disabled = !activeTab || !activeTab.dirty;
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t === activeTab ? ' active' : '');
    t.el = el; // dirty 更新只改节点类，不重建整条 tab 栏
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name;
    const dirty = document.createElement('span');
    dirty.className = 'tab-dirty';
    dirty.textContent = '●';
    dirty.hidden = !t.dirty;
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = '关闭';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(t);
    });
    el.append(name, dirty, close);
    el.addEventListener('click', () => { activateTab(t); });
    bar.append(el);
  }
}

function restoreTreeActive() {
  document.querySelectorAll('#file-tree a.active').forEach((a) => a.classList.remove('active'));
  if (!activeTab) return;
  const link = document.querySelector(`#file-tree a[title="${CSS.escape(activeTab.path)}"]`);
  if (link) link.classList.add('active');
}

// ---------- 关闭标签页（dirty 时先确认） ----------

let pendingCloseIndex = -1;

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  if (blockEditor && blockEditor.tab === tab) flushBlockEdit();   // 未取消的块编辑先落回，走正常 dirty 确认
  if (diagramEditor && diagramEditor.tab === tab) flushDiagramEdit(); // 未取消的图表修改先落回，走正常 dirty 确认
  if (tab.dirty) {
    pendingCloseIndex = i;
    $('#close-confirm').hidden = false;
    return;
  }
  doClose(i);
}

function doClose(i) {
  pendingCloseIndex = -1;
  $('#close-confirm').hidden = true;
  const wasActive = tabs[i] === activeTab;
  tabs.splice(i, 1);
  if (!tabs.length) {
    activeTab = null;
    $('#panes').hidden = true;
    $('#empty').hidden = false;
    $('#outline-header').hidden = true;
    $('#outline-body').hidden = true;
    $('#outline').textContent = '';
    // 回到空态默认布局：目录展开、大纲折叠
    setPanelCollapsed('tree-collapsed', false);
    setPanelCollapsed('outline-collapsed', true);
    // 清空路径聚焦：回到空态后恢复树的全量浏览
    document.querySelectorAll('#file-tree li.path-hidden, #file-tree li.dir-hidden')
      .forEach((li) => li.classList.remove('path-hidden', 'dir-hidden'));
    // 没有打开的文件：全部目录收回折叠（保留「我的电脑」根节点展开，盘符仍可见）
    document.querySelectorAll('#file-tree details:not([data-pc-root])').forEach((d) => { d.open = false; });
    restoreTreeActive();
    updateTabbar();
    updateUndoButton(); // 最后一个标签页关掉后撤销栈不再存在，按钮回灰
    return;
  }
  if (wasActive) activateTab(tabs[Math.min(i, tabs.length - 1)]);
  else updateTabbar();
}

$('#close-discard').addEventListener('click', () => { if (pendingCloseIndex >= 0) doClose(pendingCloseIndex); });
$('#close-cancel').addEventListener('click', () => { pendingCloseIndex = -1; $('#close-confirm').hidden = true; });

// ---------- 保存 ----------

// 顶栏保存按钮（与菜单 Ctrl+S 同一路径）
$('#save-btn').addEventListener('click', saveActiveTab);

// 顶栏「撤销」按钮：编辑区内走原生逐字撤销；退出编辑后走文档级历史（整块回退）
// mousedown 不抢焦点，否则块失焦会被当作「应用」提交
const undoBtn = $('#undo-btn');
undoBtn.addEventListener('mousedown', (e) => e.preventDefault());
undoBtn.addEventListener('click', undoAction);

// 焦点在可编辑区（块编辑/图表源码/搜索框）时，撤销/重做仍走原生
function editorFocus() {
  const ae = document.activeElement;
  return !!(blockEditor || diagramEditor ||
    (ae && (ae.isContentEditable || ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')));
}
function undoAction() {
  if (editorFocus()) { window.tot.undo(); return; }
  appUndo();
}
function redoAction() {
  if (editorFocus()) { window.tot.redo(); return; }
  appRedo();
}
function updateUndoButton() {
  undoBtn.disabled = !(editorFocus() || (activeTab && activeTab.undoStack && activeTab.undoStack.length));
}
document.addEventListener('focusin', updateUndoButton);
document.addEventListener('focusout', () => setTimeout(updateUndoButton, 0)); // focusout 时 activeElement 尚未更新

function updateTabbarDirty(tab) {
  if (tab.el) tab.el.querySelector('.tab-dirty').hidden = !tab.dirty;
  if (tab === activeTab) $('#save-btn').disabled = !tab.dirty;
}

// ---------- 文档级撤销 / 重做 ----------
// 原生撤销（webContents.undo）只作用于当前焦点编辑区，块编辑提交并重渲染后原生撤销栈
// 随 DOM 一起销毁——退出编辑框后无法回退。这里按 tab 记录整篇文本快照：块/图表编辑
// 提交前压栈，Ctrl+Z（编辑菜单）与顶栏撤销都能整块回退；撤销/重做只改内存，dirty 按
// 最近一次保存的文本重算，只有 Ctrl+S / 保存按钮才写盘
const UNDO_LIMIT = 50;

function pushUndo(tab, beforeText) {
  (tab.undoStack || (tab.undoStack = [])).push(beforeText);
  if (tab.undoStack.length > UNDO_LIMIT) tab.undoStack.shift();
  tab.redoStack = []; // 新编辑作废重做链
}

// 改文本统一入口：dirty 以最近一次保存的文本为基准（撤回保存前状态会重新变脏）
function setTabText(tab, text) {
  if (!tab.undoStack) tab.undoStack = [];
  if (!tab.redoStack) tab.redoStack = [];
  tab.text = text;
  tab.dirty = text !== tab.savedText;
  updateTabbarDirty(tab);
  updateUndoButton();
}

let historyBusy = false;

async function appUndo() {
  const tab = activeTab;
  if (historyBusy || !tab || !tab.undoStack || !tab.undoStack.length) return;
  historyBusy = true;
  tab.redoStack.push(tab.text);
  if (tab.redoStack.length > UNDO_LIMIT) tab.redoStack.shift();
  await restoreTabText(tab, tab.undoStack.pop());
  historyBusy = false;
  showStatus('已撤销');
}

async function appRedo() {
  const tab = activeTab;
  if (historyBusy || !tab || !tab.redoStack || !tab.redoStack.length) return;
  historyBusy = true;
  tab.undoStack.push(tab.text);
  if (tab.undoStack.length > UNDO_LIMIT) tab.undoStack.shift();
  await restoreTabText(tab, tab.redoStack.pop());
  historyBusy = false;
  showStatus('已重做');
}

async function restoreTabText(tab, text) {
  const keep = activeScroll().scrollTop;
  setTabText(tab, text);
  await renderMarkdown(activeViewer(), tab.text, tab.path);
  rebuildOutline();
  activeScroll().scrollTop = keep;
  updateUndoButton();
}

// 菜单 文件 → 保存 / Ctrl+S（唯一入口，渲染层不监听 Ctrl+S 防双触发）
async function saveActiveTab() {
  if (!activeTab) return;
  flushBlockEdit();   // 保存前落回未应用的块编辑（可能置 dirty）
  flushDiagramEdit(); // 同上：图表编辑
  const tab = activeTab;
  if (!tab.dirty) return;
  try {
    // 编辑把换行统一成 \n，写盘时按原文件的换行风格还原
    await window.tot.writeFile(tab.path, tab.text.split('\n').join(tab.lineEnding));
    tab.savedText = tab.text;
    tab.dirty = false;
    updateTabbarDirty(tab);
    updateUndoButton();
    showStatus('已保存');
  } catch (err) {
    showStatus('保存失败：' + err.message, true);
  }
}

let statusTimer = null;

function showStatus(msg, isError) {
  const el = $('#save-status');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}

// ---------- 渲染 ----------

// 把 md 文本渲染进目标容器：marked 解析 + 图片相对路径解析 + 标题 id + 重新应用搜索
async function renderMarkdown(targetEl, text, filePath) {
  flushBlockEdit();   // 整页重渲染会销毁编辑器 DOM：未取消的块编辑先写回文本，绝不静默丢失
  flushDiagramEdit(); // 同上：图表编辑
  targetEl.innerHTML = marked.parse(text);
  const imgs = [...targetEl.querySelectorAll('img')];
  const srcs = imgs.map((img) => img.getAttribute('src') || '');
  const resolved = await window.tot.resolveImages(filePath, srcs);
  imgs.forEach((img, i) => {
    if (resolved[i] !== srcs[i]) img.dataset.origSrc = srcs[i]; // 记原始相对路径：就地编辑回写时还原
    img.src = resolved[i];
  });
  // mermaid 围栏 → 图表 wrapper（在 hljs 之前：pre 被替换后不再进入高亮循环）
  await renderMermaidBlocks(targetEl);
  // 代码语法高亮（替换 code 内文本为 token span，须在 applySearch 之前）
  if (window.hljs) {
    targetEl.querySelectorAll('pre code').forEach((el) => { hljs.highlightElement(el); });
  }
  applyCallouts(targetEl);
  assignBlockIndices(targetEl);
  assignHeadingIds(targetEl);
  applySearch();
}

// ---------- Mermaid 图表渲染与就地编辑 ----------

function currentStyleDark() {
  const s = STYLES.find((x) => x.id === state.style);
  return !!s && s.dark;
}

// 惰性初始化：首次渲染图表时调用；明暗主题变化时重新 initialize
function ensureMermaidInit() {
  if (!window.mermaid) return false;
  const theme = currentStyleDark() ? 'dark' : 'neutral';
  if (mermaidTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
    mermaidTheme = theme;
  }
  return true;
}

// 渲染 mermaid 源码为 svg 字符串（id 递增保证唯一；strict 模式输出已消毒）
async function mermaidRenderSvg(src) {
  if (!ensureMermaidInit()) throw new Error('Mermaid 库未加载');
  const id = `tot-mermaid-${++mermaidIdSeq}`;
  try {
    const { svg } = await mermaid.render(id, src);
    return svg;
  } finally {
    // mermaid 失败时先把内置错误图（大号「Syntax error in text」）画进挂在 body 的临时容器再抛异常，
    // 且只清理成功路径 → 抛异常时兜底按 id 删除，页面不留巨型错误图
    document.getElementById('d' + id)?.remove();
  }
}

// 错误态：保留 wrapper（维持 1:1 序号映射），显示错误信息，仍可点击编辑
function showMermaidError(wrapper, err) {
  wrapper.classList.add('mermaid-error');
  wrapper.dataset.theme = mermaidTheme;
  wrapper.textContent = 'Mermaid 渲染失败：' + String(err.message || err).split('\n')[0].slice(0, 200);
}

// 渲染单个 wrapper：成功注入 svg，失败进入错误态；整页已重渲染则丢弃（isConnected 防竞态）
async function renderMermaidWrapper(wrapper, src) {
  try {
    const svg = await mermaidRenderSvg(src);
    if (!wrapper.isConnected) return;
    wrapper.classList.remove('mermaid-error');
    wrapper.dataset.theme = mermaidTheme;
    wrapper.innerHTML = svg;
  } catch (err) {
    if (!wrapper.isConnected) return;
    showMermaidError(wrapper, err);
  }
}

// 把目标容器里全部 mermaid 围栏替换为 wrapper（DOM 顺序 = 源文围栏顺序，序号 1:1）
async function renderMermaidBlocks(targetEl) {
  const codes = [...targetEl.querySelectorAll('pre code.language-mermaid')];
  let idx = 0;
  for (const code of codes) {
    const pre = code.closest('pre');
    if (!pre) continue;
    const src = code.textContent;
    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid-wrapper';
    wrapper.title = '点击编辑图表';
    wrapper.dataset.idx = String(idx++);
    mermaidSrcs.set(wrapper, src);
    pre.replaceWith(wrapper);
    await renderMermaidWrapper(wrapper, src);
  }
}

// 围栏开行：与 marked 围栏词法对齐——3+ 反引号（信息串不含反引号）或 3+ 波浪线，
// 语言取信息串首词（大小写不敏感），允许 0-3 空格缩进与引用块 > 前缀（marked 同样识别）
const MERMAID_OPEN_RE = /^ {0,3}((?:> ?)*)(`{3,}(?=[^`]*$)|~{3,})mermaid(?:[ \t].*)?$/i;

// 按围栏开行找匹配的闭行（同字符 3+ 个），返回闭行行号；找不到返回 lines.length
function findFenceClose(lines, start, ch, len) {
  const closeRe = new RegExp(`^ {0,3}((?:> ?)*)${ch === '`' ? '`{' + len + ',}' : '~{3,}'}[ \\t]*$`);
  for (let j = start + 1; j < lines.length; j++) {
    if (closeRe.test(lines[j])) return j;
  }
  return lines.length;
}

// 找第 n 个 mermaid 围栏，返回 { open, close, prefix, inner:[open+1, close) }；找不到 null
// prefix 为引用块前缀（普通围栏为 ''），写回时逐行补回
function findMermaidFence(text, n) {
  const lines = text.split(/\r\n|\n|\r/);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MERMAID_OPEN_RE);
    if (!m) continue;
    const j = findFenceClose(lines, i, m[2][0], m[2].length);
    if (count === n) return { open: i, close: j, prefix: m[1], inner: [i + 1, j] };
    count++;
    i = j;
  }
  return null;
}

// 前文被改动导致序号漂移时的兜底：按内容找围栏（内容与编辑前源码一致）
function findMermaidFenceByContent(text, src) {
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(MERMAID_OPEN_RE);
    if (!m) continue;
    const j = findFenceClose(lines, i, m[2][0], m[2].length);
    if (lines.slice(i + 1, j).join('\n') === src) return { open: i, close: j, prefix: m[1], inner: [i + 1, j] };
    i = j;
  }
  return null;
}

// 用新源码替换围栏内容：只动内容行，开/闭行原样保留；整体换行统一为 \n（与编辑器路径
// 一致，保存时 saveActiveTab 按 tab.lineEnding 还原）；引用块围栏逐行补回 > 前缀
function replaceMermaidFenceContent(text, fence, newSrc) {
  const lines = text.split(/\r\n|\n|\r/);
  return [
    ...lines.slice(0, fence.inner[0]),
    ...newSrc.split('\n').map((l) => fence.prefix + l),
    ...lines.slice(fence.inner[1]),
  ].join('\n');
}

// 打开就地编辑器：wrapper 内容替换为 源码 textarea + 实时预览 + 应用/取消
function openDiagramEditor(viewerEl, wrapper) {
  if (!activeTab) return;
  if (diagramEditor) cancelDiagramEdit(); // 同时只开一个：先放弃上一个（恢复原图）
  const src = mermaidSrcs.get(wrapper);
  if (src === undefined) return;
  diagramEditor = { tab: activeTab, viewerEl, wrapper, idx: Number(wrapper.dataset.idx), originalSrc: src };
  const editor = document.createElement('div');
  editor.className = 'mermaid-editor';
  // 静态骨架（不含用户数据），innerHTML 安全
  editor.innerHTML = `
    <div class="mermaid-editor-bar">
      <span>Mermaid 源码</span>
      <button class="mermaid-apply" title="把修改写入文档">应用</button>
      <button class="mermaid-cancel" title="放弃修改 (Esc)">取消</button>
    </div>
    <textarea class="mermaid-editor-input" spellcheck="false"></textarea>
    <div class="mermaid-editor-preview"></div>`;
  const input = editor.querySelector('.mermaid-editor-input');
  input.value = src;
  wrapper.classList.add('mermaid-editing');
  wrapper.innerHTML = '';
  wrapper.append(editor);
  input.focus();
  // 输入 → 300ms debounce 实时重渲染预览
  input.addEventListener('input', () => {
    clearTimeout(diagramPreviewTimer);
    diagramPreviewTimer = setTimeout(() => {
      if (!diagramEditor || diagramEditor.wrapper !== wrapper) return;
      renderDiagramPreview(editor.querySelector('.mermaid-editor-preview'), input.value);
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); cancelDiagramEdit(); }
  });
  editor.querySelector('.mermaid-apply').addEventListener('click', applyDiagramEdit);
  editor.querySelector('.mermaid-cancel').addEventListener('click', cancelDiagramEdit);
  renderDiagramPreview(editor.querySelector('.mermaid-editor-preview'), src);
  updateUndoButton();
}

// 编辑器内预览：直接注入 svg（不经 renderMarkdown——那会销毁编辑器自身）；失败显示错误文本
async function renderDiagramPreview(previewEl, src) {
  previewEl.classList.remove('error');
  try {
    previewEl.innerHTML = await mermaidRenderSvg(src);
  } catch (err) {
    previewEl.classList.add('error');
    previewEl.textContent = '渲染失败：' + String(err.message || err).split('\n')[0].slice(0, 200);
  }
}

// 应用：新源码写回源文围栏 → dirty → 整页重渲染
async function applyDiagramEdit() {
  const d = diagramEditor;
  if (!d || d.tab !== activeTab) return;
  const input = d.wrapper.querySelector('.mermaid-editor-input');
  if (!input) return;
  const newSrc = input.value;
  if (newSrc === d.originalSrc) { cancelDiagramEdit(); return; } // 没改动视同取消
  const fence = findMermaidFence(d.tab.text, d.idx) || findMermaidFenceByContent(d.tab.text, d.originalSrc);
  if (!fence) {
    cancelDiagramEdit();
    showStatus('应用失败：找不到对应代码围栏', true);
    return;
  }
  const before = d.tab.text;
  pushUndo(d.tab, before);
  setTabText(d.tab, replaceMermaidFenceContent(before, fence, newSrc));
  mermaidSrcs.set(d.wrapper, newSrc); // 与文本保持一致：后续重主题按新源码重渲染
  resetDiagramEditor();
  await renderMarkdown(activeViewer(), d.tab.text, d.tab.path);
  rebuildOutline();
  showStatus('已应用图表修改');
}

// 取消：恢复原图（按 originalSrc 重渲染），清状态
async function cancelDiagramEdit() {
  const d = diagramEditor;
  resetDiagramEditor();
  if (d && d.wrapper.isConnected) {
    d.wrapper.classList.remove('mermaid-editing');
    await renderMermaidWrapper(d.wrapper, d.originalSrc);
  }
}

function resetDiagramEditor() {
  clearTimeout(diagramPreviewTimer);
  diagramEditor = null;
  updateUndoButton();
}

// 整页重渲染/关闭标签页前调用：打开着的编辑器若已有修改，先写回 tab.text（含 dirty），
// 保证修改不丢、关闭前 dirty 确认生效
function flushDiagramEdit() {
  const d = diagramEditor;
  if (!d) return;
  const input = d.wrapper.querySelector('.mermaid-editor-input');
  const newSrc = input ? input.value : null;
  if (newSrc !== null && newSrc !== d.originalSrc) {
    const fence = findMermaidFence(d.tab.text, d.idx) || findMermaidFenceByContent(d.tab.text, d.originalSrc);
    if (fence) {
      const before = d.tab.text;
      pushUndo(d.tab, before);
      setTabText(d.tab, replaceMermaidFenceContent(before, fence, newSrc));
      mermaidSrcs.set(d.wrapper, newSrc);
    }
  }
  resetDiagramEditor();
}

// 风格切换后按新明暗主题重渲染当前渲染区的全部图表（先落回未应用的修改，不静默丢失）
async function reThemeMermaids() {
  flushDiagramEdit();
  for (const wrapper of document.querySelectorAll('#viewer .mermaid-wrapper')) {
    wrapper.classList.remove('mermaid-editing');
    await renderMermaidWrapper(wrapper, mermaidSrcs.get(wrapper) || '');
  }
}

// 点击图表 → 就地编辑（委托监听；编辑器内部点击不重开）
document.addEventListener('click', (e) => {
  if (!activeTab) return;
  const viewer = activeViewer();
  if (!viewer.contains(e.target)) return; // 只响应活动渲染区；点击已随重渲染脱离文档的元素时忽略
  const wrapper = e.target.closest('.mermaid-wrapper');
  if (wrapper) {
    if (e.target.closest('.mermaid-editor')) return;
    openDiagramEditor(viewer, wrapper);
    return;
  }
  if (e.target.closest('.block-editor-bar')) return; // 工具条点击不触发块编辑
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return; // 有文本选区时不触发（防打断复制）
  const block = e.target.closest('[data-block]');
  if (block) openBlockEditor(block);
});

// ---------- 块级就地编辑（富文本所见即所得 + 代码围栏源码） ----------

let blockEditor = null; // { tab, el, idx, range, kind:'rich'|'code', originalSrc, originalHtml }

// turndown：编辑块 HTML → GFM（gfm 插件覆盖表格/删除线/任务列表，与 marked 输入对齐）
const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
turndown.use(turndownPluginGfm.gfm);
// gfm 插件的删除线规则输出单波浪线（非 GFM），且与本应用 marked 的单波浪线补丁冲突：
// ~~双波浪线~~ 才渲染删除线——同名规则覆盖插件默认
turndown.addRule('strikethrough', { filter: 'del', replacement: (content) => '~~' + content + '~~' });

// 可编辑块类型（marked lexer 侧与 DOM 侧同过滤，保证 data-block 序号与 token 序号 1:1；
// hr 与 html/space 两侧同跳过）
const BLOCK_TYPES = new Set(['heading', 'paragraph', 'blockquote', 'list', 'table', 'code']);

function isBlockEl(el) {
  return /^(H[1-6]|P|UL|OL|BLOCKQUOTE|TABLE|PRE)$/.test(el.tagName) || el.classList.contains('mermaid-wrapper');
}

// 渲染管线：顶层可编辑块依次编号
function assignBlockIndices(targetEl) {
  let i = 0;
  for (const el of targetEl.children) {
    if (isBlockEl(el)) el.dataset.block = String(i++);
  }
}

// 按序号定位源文区间：marked.lexer 顺序游标，token.raw 即消费的原文切片（块 raw 不含尾换行，
// 换行由 space token 承担——替换区间即天然保留块间分隔）
// 词法结果按文本缓存：同一文档内连续点块进编辑不再每次全量词法分析
let lexCache = { text: null, tokens: null };
function findBlockRange(text, idx) {
  if (lexCache.text !== text) lexCache = { text, tokens: marked.lexer(text) };
  let cursor = 0, n = -1;
  for (const t of lexCache.tokens) {
    if (BLOCK_TYPES.has(t.type)) {
      n++;
      if (n === idx) return { start: cursor, end: cursor + t.raw.length };
    }
    cursor += t.raw.length;
  }
  return null;
}

function openBlockEditor(el) {
  if (!activeTab || blockEditor) return;
  const idx = Number(el.dataset.block);
  const range = findBlockRange(activeTab.text, idx);
  if (!range) { showStatus('编辑失败：找不到对应的源文块', true); return; }
  const src = activeTab.text.slice(range.start, range.end);
  closeSearch(); // 搜索高亮不能混进编辑区（会被序列化进结果）
  if (diagramEditor) cancelDiagramEdit(); // 同时只开一个编辑器
  if (el.tagName === 'PRE') openCodeEditor(el, idx, range, src);
  else openRichEditor(el, idx, range, src);
}

// 富文本就地编辑：块本身变 contenteditable + 浮动工具条；失焦=应用，Esc=取消
function openRichEditor(el, idx, range, src) {
  blockEditor = { tab: activeTab, el, idx, range, kind: 'rich', originalSrc: src, originalHtml: el.innerHTML };
  el.classList.add('block-editing');
  el.contentEditable = 'true';
  el.querySelector('.callout-title')?.setAttribute('contenteditable', 'false'); // 标注块标题不参与编辑
  const bar = document.createElement('div');
  bar.className = 'block-editor-bar';
  bar.contentEditable = 'false';
  // 静态骨架（不含用户数据），innerHTML 安全
  bar.innerHTML = `
    <button data-cmd="bold" title="加粗"><b>B</b></button>
    <button data-cmd="italic" title="斜体"><i>I</i></button>
    <button data-cmd="strikeThrough" title="删除线"><s>S</s></button>
    <button data-cmd="code" title="行内代码">\`</button>
    <button data-cmd="removeFormat" title="清除格式">Tx</button>
    <button data-cmd="ul" title="无序列表">≡</button>
    <button data-cmd="ol" title="有序列表">1≡</button>
    <button data-cmd="quote" title="引用块">❝</button>
    <button data-cmd="link" title="链接">🔗</button>
    <button data-cmd="image" title="插入图片">🖼</button>
    <select class="block-format" title="块格式">
      <option value="p">正文</option>
      <option value="h1">标题 1</option>
      <option value="h2">标题 2</option>
      <option value="h3">标题 3</option>
      <option value="h4">标题 4</option>
      <option value="h5">标题 5</option>
      <option value="h6">标题 6</option>
    </select>
    <span class="block-link-ui" hidden><input class="block-link-input" placeholder="https://…" title="链接地址"><button class="block-link-ok">确定</button><button class="block-link-cancel">取消</button></span>
    <button class="block-apply" title="写入文档">应用</button>
    <button class="block-cancel" title="放弃修改 (Esc)">取消</button>`;
  el.prepend(bar);
  rebindEditorHost(el);
  for (const btn of bar.querySelectorAll('button')) {
    if (btn.closest('.block-link-ui')) continue; // 链接输入行的确定/取消单独接线
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // 防失焦提交
    btn.addEventListener('click', (e) => { e.stopPropagation(); blockBarAction(btn); });
  }
  const linkUi = bar.querySelector('.block-link-ui');
  bar.querySelector('.block-link-ok').addEventListener('click', confirmLink);
  bar.querySelector('.block-link-cancel').addEventListener('click', () => hideLinkUi(blockEditor, linkUi));
  linkUi.querySelector('.block-link-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.stopPropagation(); confirmLink(); }
    if (e.key === 'Escape' && !e.isComposing) {
      e.stopPropagation(); // 只收起链接输入行，不取消整个编辑
      hideLinkUi(blockEditor, linkUi);
    }
  });
  const format = bar.querySelector('.block-format');
  format.addEventListener('mousedown', (e) => e.preventDefault());
  format.addEventListener('change', () => {
    const v = format.value;
    // 手工宿主重命名（execCommand formatBlock 会丢块上的 class/data-block/监听器）：
    // 列表先还原为段落再转目标类型；「正文」即降级为段落
    if (v && !blockTypeGuard()) {
      let el = blockEditor.el;
      if (el.tagName === 'UL' || el.tagName === 'OL') unwrapList(el);
      if (blockEditor && blockEditor.el.tagName !== v.toUpperCase()) renameHost(blockEditor.el, v);
    }
    format.value = 'p'; // 一次性动作：执行后回位
  });
  updateUndoButton();
}

function blockBarAction(btn) {
  if (btn.classList.contains('block-apply')) { applyBlockEdit(); return; }
  if (btn.classList.contains('block-cancel')) { cancelBlockEdit(); return; }
  if (btn.dataset.cmd === 'code') { toggleInlineCode(); return; }
  if (btn.dataset.cmd === 'ul') { toggleList(false); return; }
  if (btn.dataset.cmd === 'ol') { toggleList(true); return; }
  if (btn.dataset.cmd === 'quote') { toggleQuote(); return; }
  if (btn.dataset.cmd === 'link') { linkButtonAction(); return; }
  if (btn.dataset.cmd === 'image') { insertImage(); return; }
  document.execCommand(btn.dataset.cmd); // bold / italic / strikeThrough / removeFormat
}

// 行内代码：execCommand 无 code 命令，手动包/拆 <code>
function toggleInlineCode() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const anchor = sel.anchorNode;
  const code = anchor && anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement.closest('code') : null;
  if (code && blockEditor && blockEditor.el.contains(code)) {
    code.replaceWith(document.createTextNode(code.textContent)); // 已在代码内：还原为文本
    return;
  }
  const range = sel.getRangeAt(0);
  const c = document.createElement('code');
  c.textContent = range.toString();
  range.deleteContents();
  range.insertNode(c);
  range.setStartAfter(c);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ---------- 块级结构转换（列表/引用/标题层级） ----------
// execCommand 的 formatBlock/列表命令会整体替换宿主元素并丢掉 class/data-block/监听器，
// 故全部手工转换：建新元素 → 拷贝属性 → 搬子节点（工具条随迁）→ 重绑监听器 → 焦点回块尾
function unbindEditorHost(el) {
  el.removeEventListener('focusout', onBlockFocusOut);
  el.removeEventListener('keydown', onBlockKeyDown);
  el.removeEventListener('paste', onBlockPaste);
}

function rebindEditorHost(el) {
  el.addEventListener('focusout', onBlockFocusOut);
  el.addEventListener('keydown', onBlockKeyDown);
  el.addEventListener('paste', onBlockPaste);
}

function refocusEditor(el) {
  el.focus();
  const s = getSelection();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  s.removeAllRanges();
  s.addRange(r);
}

// 宿主整体换标签（标题/正文/引用互转、列表有序无序互换）
function renameHost(el, tag) {
  const b = blockEditor;
  if (!b || b.el !== el) return;
  unbindEditorHost(el);
  const n = document.createElement(tag);
  for (const a of [...el.attributes]) n.setAttribute(a.name, a.value);
  while (el.firstChild) n.append(el.firstChild);
  el.replaceWith(n);
  b.el = n;
  rebindEditorHost(n);
  refocusEditor(n);
}

// 标注块（callout）结构特殊（标题行 + [!TYPE] 前缀），不允许块类型转换
function blockTypeGuard() {
  if (blockEditor && blockEditor.el.classList.contains('callout')) {
    showStatus('标注块的块类型不能转换', true);
    return true;
  }
  return false;
}

// 无序/有序列表：段落/标题/引用 → 列表（内容包进单个 li）；同款再点还原为段落；互点互换类型
function toggleList(ordered) {
  const b = blockEditor;
  if (!b || b.kind !== 'rich' || blockTypeGuard()) return;
  const el = b.el;
  const want = ordered ? 'OL' : 'UL';
  if (el.tagName === want) unwrapList(el);
  else if (el.tagName === 'UL' || el.tagName === 'OL') renameHost(el, want);
  else makeList(el, want);
}

function makeList(el, want) {
  const b = blockEditor;
  unbindEditorHost(el);
  const n = document.createElement(want);
  for (const a of [...el.attributes]) n.setAttribute(a.name, a.value);
  const li = document.createElement('li');
  while (el.firstChild) li.append(el.firstChild);
  n.append(li);
  el.replaceWith(n);
  b.el = n;
  rebindEditorHost(n);
  refocusEditor(n);
}

// 列表还原为段落：各 li 内容按 <br> 连接（多 li 时即硬换行）
function unwrapList(el) {
  const b = blockEditor;
  unbindEditorHost(el);
  const p = document.createElement('p');
  for (const a of [...el.attributes]) p.setAttribute(a.name, a.value);
  const items = [...el.querySelectorAll(':scope > li')];
  const bar = el.querySelector(':scope > .block-editor-bar');
  items.forEach((li, i) => {
    if (i) p.append(document.createElement('br'));
    while (li.firstChild) p.append(li.firstChild);
  });
  el.replaceWith(p);
  if (bar) p.prepend(bar); // 工具条回到块首
  b.el = p;
  rebindEditorHost(p);
  refocusEditor(p);
}

function toggleQuote() {
  const b = blockEditor;
  if (!b || b.kind !== 'rich' || blockTypeGuard()) return;
  let el = b.el;
  if (el.tagName === 'UL' || el.tagName === 'OL') unwrapList(el); // 列表先还原再转引用
  el = blockEditor.el;
  renameHost(el, el.tagName === 'BLOCKQUOTE' ? 'p' : 'blockquote');
}

// ---------- 行内链接 ----------

// 选区有文字 → 弹出 URL 输入行，确定后插入 [文字](url)；选区在已有链接内 → 直接移除链接
function linkButtonAction() {
  const b = blockEditor;
  if (!b || b.kind !== 'rich') return;
  const ui = b.el.querySelector('.block-link-ui');
  if (!ui) return;
  if (!ui.hidden) { hideLinkUi(b, ui); return; } // 再点收起
  const sel = getSelection();
  const anchor = sel && sel.anchorNode;
  const node = anchor && anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
  const inLink = node && b.el.contains(node) && node.closest('a');
  if (inLink) {
    inLink.replaceWith(document.createTextNode(inLink.textContent)); // 移除链接保留文字
    return;
  }
  if (!sel || !sel.rangeCount || sel.isCollapsed) { showStatus('先选中要加链接的文字', true); return; }
  // 输入框聚焦会把文档选区换成输入框光标：先把选区 Range 记下来，确定时用它
  b.linkRange = sel.getRangeAt(0).cloneRange();
  ui.hidden = false;
  ui.querySelector('.block-link-input').focus();
}

// 收起链接输入行：焦点在其内部（输入框/确定/取消）时先移回宿主块再隐藏，
// 否则隐藏会让焦点落空（relatedTarget=null）→ 失焦=应用 误提交并关闭编辑器
function hideLinkUi(b, ui) {
  if (b && ui.contains(document.activeElement)) {
    const sel = getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    b.el.focus();
    if (range) { sel.removeAllRanges(); sel.addRange(range); }
  }
  ui.hidden = true;
  ui.querySelector('.block-link-input').value = '';
}

function confirmLink() {
  const b = blockEditor;
  if (!b) return;
  const ui = b.el.querySelector('.block-link-ui');
  if (!ui || ui.hidden) return;
  const input = ui.querySelector('.block-link-input');
  const url = input.value.trim();
  if (!url || /\s/.test(url)) { showStatus('链接地址无效', true); input.focus(); return; }
  const range = b.linkRange;
  if (!range || !b.el.contains(range.commonAncestorContainer)) {
    showStatus('选区已失效，请重新选中文字', true);
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.textContent = range.toString();
  range.deleteContents();
  range.insertNode(a);
  range.setStartAfter(a);
  range.collapse(true);
  b.linkRange = null;
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  hideLinkUi(b, ui);
}

// ---------- 插入图片 ----------

let modalBusy = false; // 原生文件对话框打开期间，抑制失焦=应用（对话框会夺走焦点）

async function insertImage() {
  const b = blockEditor;
  if (!b || b.kind !== 'rich') return;
  modalBusy = true;
  const picked = await window.tot.selectImage(b.tab.path);
  modalBusy = false;
  if (!picked || !blockEditor || blockEditor.tab !== activeTab) return; // 等待期间编辑可能已被取消/换页
  await insertImageFromRel(picked.rel);
}

async function insertImageFromRel(rel) {
  const b = blockEditor;
  if (!b || b.kind !== 'rich' || !b.el.isConnected) return;
  const [url] = await window.tot.resolveImages(b.tab.path, [rel]);
  if (!blockEditor || !blockEditor.el.isConnected) return;
  const img = document.createElement('img');
  img.src = url;
  img.dataset.origSrc = rel; // serializeBlock 按此回写源文相对路径
  img.alt = rel.split('/').pop();
  const sel = getSelection();
  const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (r && !sel.isCollapsed) r.deleteContents(); // 选中内容替换为图片
  const rr = r || document.createRange();
  rr.insertNode(img);
  rr.setStartAfter(img);
  rr.collapse(true);
  sel.removeAllRanges();
  sel.addRange(rr);
  blockEditor.el.focus(); // 对话框回来焦点仍在块上
}

function onBlockFocusOut(e) {
  const b = blockEditor;
  if (!b || b.el !== e.currentTarget) return;
  if (modalBusy) return; // 原生文件对话框打开期间不提交
  if (e.currentTarget.contains(e.relatedTarget)) return; // 焦点还在块内（工具条）
  applyBlockEdit();
}

// 点块外任意位置（正文空白、侧栏、顶栏…）= 应用并退出。不能只靠 focusout：
// 点开编辑后块还没获得焦点时（未再点进正文），根本不存在失焦事件，点空白会
// 一直停在编辑态。pointerdown 捕获阶段显式判定，保证退出行为确定；工具条在块内
// 不受影响，撤销按钮保留焦点做原生撤销
function onOutsidePointerDown(e) {
  const b = blockEditor;
  if (!b || b.kind !== 'rich') return;
  if (b.el.contains(e.target)) return;
  if (e.target.closest?.('#undo-btn')) return;
  applyBlockEdit();
}
document.addEventListener('pointerdown', onOutsidePointerDown, true);

function onBlockKeyDown(e) {
  if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); cancelBlockEdit(); }
}

function onBlockPaste(e) {
  e.preventDefault(); // 粘贴按纯文本，防外来 HTML 混入
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
}

// 应用：块内容序列化为 GFM 写回源文区间 → dirty → 整页重渲染
async function applyBlockEdit() {
  const b = blockEditor;
  if (!b || b.tab !== activeTab) return;
  const newSrc = b.kind === 'code' ? (b.el.querySelector('textarea')?.value ?? null) : serializeBlock(b.el);
  if (newSrc === null) return;
  if (blockEditUnchanged(newSrc, b.originalSrc)) { cancelBlockEdit(); return; } // 没改动视同取消
  writeBlockEdit(b, newSrc);
  await renderMarkdown($('#viewer'), b.tab.text, b.tab.path);
  rebuildOutline();
  showStatus('已更新（Ctrl+S 保存）');
}

// 写回源文（不渲染）：apply 与 flush 共用
function writeBlockEdit(b, newSrc) {
  const before = b.tab.text;
  const after = before.slice(0, b.range.start) + newSrc.replace(/\n+$/, '') + before.slice(b.range.end);
  pushUndo(b.tab, before); // 退出/应用后仍可整块撤销
  setTabText(b.tab, after);
  blockEditor = null;
  updateUndoButton();
}

// 取消：恢复原块
function cancelBlockEdit() {
  const b = blockEditor;
  if (!b) return;
  blockEditor = null;
  updateUndoButton();
  if (!b.el.isConnected) return;
  b.el.classList.remove('block-editing', 'code-editing');
  if (b.kind === 'rich') b.el.contentEditable = 'false';
  b.el.innerHTML = b.originalHtml;
}

// 整页重渲染/关闭标签页/保存前调用：未取消的块编辑先写回（不渲染）
function flushBlockEdit() {
  const b = blockEditor;
  if (!b) return;
  const newSrc = b.kind === 'code' ? (b.el.querySelector('textarea')?.value ?? null) : serializeBlock(b.el);
  if (newSrc !== null && !blockEditUnchanged(newSrc, b.originalSrc)) writeBlockEdit(b, newSrc);
  else blockEditor = null;
  updateUndoButton();
}

// 「没改动就退出」判断：先比字符串（去尾换行）；不等时比渲染等价——
// turndown 输出与原文常有渲染等价差异（列表标记空格数、表格对齐、星号转义、
// 软换行空白折叠），用 marked 渲染后比「结构签名 + 文本」；结构签名保证
// 段落⇄引用/列表这类纯结构转换不被误判为无改动
function blockEditUnchanged(newSrc, originalSrc) {
  const strip = (s) => s.replace(/\n+$/, '');
  if (strip(newSrc) === strip(originalSrc)) return true;
  try {
    const fold = (s) => s.replace(/\s+/g, ' ');
    // 签名含每个元素的直接文本：加粗范围移动（如「这是」并入相邻 strong）时
    // 文本节点归属变化，签名必不同——纯 tag 序列会漏掉这类格式边界变化
    const sig = (el) => {
      const txt = fold([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(''));
      return el.tagName + '(' + txt + [...el.children].map(sig).join('') + ')';
    };
    const render = (md) => {
      const div = document.createElement('div');
      div.innerHTML = marked.parse(md);
      return { sig: [...div.children].map(sig).join(''), text: fold(div.innerText) };
    };
    const a = render(newSrc);
    const b = render(originalSrc);
    return a.sig === b.sig && a.text === b.text;
  } catch { return false; }
}

// 编辑块 → GFM：克隆后清理编辑态产物（工具条/标题行/contenteditable），嵌套图表按位置
// 映射回围栏源码（cloneNode 后 WeakMap 取不到），图片 src 回写原始相对路径
function serializeBlock(el) {
  const clone = el.cloneNode(true);
  clone.querySelector('.block-editor-bar')?.remove();
  clone.removeAttribute('contenteditable');
  clone.removeAttribute('data-block');
  clone.querySelectorAll('.callout-title, [contenteditable]').forEach((n) => n.remove());
  clone.querySelectorAll('img').forEach((img) => {
    if (img.dataset.origSrc) { img.src = img.dataset.origSrc; img.removeAttribute('data-orig-src'); }
  });
  const origWrappers = [...el.querySelectorAll('.mermaid-wrapper')];
  const cloneWrappers = [...clone.querySelectorAll('.mermaid-wrapper')];
  cloneWrappers.forEach((w, i) => {
    const src = mermaidSrcs.get(origWrappers[i]);
    if (src === undefined) { w.remove(); return; }
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = src;
    pre.append(code);
    w.replaceWith(pre);
  });
  // 包一层容器再序列化：turndown 对根元素自身不套规则（h4 会丢 ####、ul 会丢 - ），
  // 宿主作为容器子节点时才会按 heading/list/blockquote/table 规则输出
  const wrap = document.createElement('div');
  wrap.append(clone);
  let md = turndown.turndown(wrap);
  // 相邻同型强调（如 **a** 紧邻 **b**）序列化为 **a****b**，marked 会把星号当字面文本渲染。
  // 中间的 **** 正是「a 的收尾 ** + b 的开启 **」——删掉即合并为单一加粗 **ab**，所见即所得
  md = md.replace(/\*\*\*\*/g, '');
  if (el.classList.contains('callout')) {
    // 标注块：标题行不参与编辑，按原源文的 [!TYPE] 重建（正文序列化自带 > 前缀）
    const type = (blockEditor.originalSrc.match(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i) || [])[1] || 'NOTE';
    md = `> [!${type}]\n` + md;
  }
  return md;
}

// 代码围栏就地编辑：textarea 显示完整围栏源码（含开闭标记），无实时预览
function openCodeEditor(pre, idx, range, src) {
  blockEditor = { tab: activeTab, el: pre, idx, range, kind: 'code', originalSrc: src, originalHtml: pre.innerHTML };
  pre.classList.add('code-editing');
  // 复用 mermaid 编辑器样式与骨架（无预览区）
  const editor = document.createElement('div');
  editor.className = 'mermaid-editor';
  editor.innerHTML = `
    <div class="mermaid-editor-bar">
      <span>代码源码</span>
      <button class="mermaid-apply" title="把修改写入文档">应用</button>
      <button class="mermaid-cancel" title="放弃修改 (Esc)">取消</button>
    </div>
    <textarea class="mermaid-editor-input" spellcheck="false"></textarea>`;
  const input = editor.querySelector('.mermaid-editor-input');
  input.value = src;
  pre.innerHTML = '';
  pre.append(editor);
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); cancelBlockEdit(); }
  });
  editor.querySelector('.mermaid-apply').addEventListener('click', applyBlockEdit);
  editor.querySelector('.mermaid-cancel').addEventListener('click', cancelBlockEdit);
  updateUndoButton();
}

// ---------- Callout 标注块（> [!NOTE] 等） ----------

const CALLOUT_TYPES = {
  NOTE: { label: '注', icon: 'ℹ️' },
  TIP: { label: '提示', icon: '💡' },
  IMPORTANT: { label: '重要', icon: '📌' },
  WARNING: { label: '警告', icon: '⚠️' },
  CAUTION: { label: '注意', icon: '🚨' },
};

// GitHub 风格 Callout：blockquote 首行 [!TYPE] 转为标注块（彩色标题行 + 底色）
function applyCallouts(targetEl) {
  targetEl.querySelectorAll('blockquote').forEach((bq) => {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P') return;
    const m = p.textContent.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
    if (!m) return;
    const type = m[1].toUpperCase();
    const meta = CALLOUT_TYPES[type];
    bq.classList.add('callout', 'callout-' + type.toLowerCase());
    const title = document.createElement('div');
    title.className = 'callout-title';
    title.textContent = `${meta.icon} ${meta.label}`;
    bq.insertBefore(title, bq.firstChild);
    // 去掉首段开头的 [!TYPE] 标记；标题行已单独渲染
    const node = p.firstChild;
    if (node && node.nodeType === Node.TEXT_NODE) {
      node.textContent = node.textContent.replace(/^\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i, '');
    }
    if (!p.textContent.trim()) p.remove();
  });
}

// ---------- 文件内查找（Ctrl+F） ----------

let searchState = { query: '', matches: [], current: -1 };

function openSearch() {
  if (!activeTab) return;
  $('#search-input').focus();
  $('#search-input').select();
}

// 搜索条常驻顶栏：关闭 = 清除查询与高亮（Ctrl+F 聚焦，Esc / × 清除）
function closeSearch() {
  clearMarks();
  searchState = { query: '', matches: [], current: -1 };
  $('#search-input').value = '';
  $('#search-count').textContent = '';
  $('#search-input').blur();
}

// 移除所有搜索高亮，还原文本节点
function clearMarks() {
  document.querySelectorAll('mark.tot-search').forEach((m) => {
    m.replaceWith(...m.childNodes);
  });
}

// 收集渲染区里的文本节点（跳过 script/style/mark；空白节点保留——跨节点匹配需要它们衔接）
function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || ['SCRIPT', 'STYLE', 'MARK'].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      // 跳过 SVG 内的文本（mermaid 图表）：搜索 mark 不能插进 SVG 元素，否则图表被破坏
      if (parent.namespaceURI === 'http://www.w3.org/2000/svg') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

// 在活动渲染区里高亮所有匹配：文本节点拼接成全文后查找，命中区间按字符偏移
// 回映到各文本节点切分——跨内联格式（加粗边界）与代码高亮 span 边界的词也能匹配
function applySearch() {
  clearMarks();
  const q = searchState.query;
  const viewer = activeViewer();
  if (!q || !viewer || !activeTab) return;
  const ql = q.toLowerCase();
  const nodes = collectTextNodes(viewer);
  const ranges = [];
  const lower = nodes.map((n) => n.textContent).join('').toLowerCase();
  let idx = lower.indexOf(ql);
  while (idx >= 0) {
    ranges.push([idx, idx + q.length]);
    idx = lower.indexOf(ql, idx + q.length);
  }
  const matches = ranges.map(() => []); // 每个逻辑命中一组 mark：跨节点切出的多个片段属同一命中
  let base = 0;   // 当前节点在全文中的起点
  let ri = 0;     // 下一个待切分的区间（区间互不重叠且按起点有序）
  for (const node of nodes) {
    const text = node.textContent;
    const end = base + text.length;
    const segs = [];
    while (ri < ranges.length && ranges[ri][0] < end) {
      segs.push([ri, Math.max(ranges[ri][0] - base, 0), Math.min(ranges[ri][1] - base, text.length)]);
      if (ranges[ri][1] > end) break; // 区间跨到下一个文本节点，剩余部分下个节点继续
      ri++;
    }
    base = end;
    if (!segs.length) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [rangeIdx, s, e] of segs) {
      if (s > pos) frag.append(document.createTextNode(text.slice(pos, s)));
      const mark = document.createElement('mark');
      mark.className = 'tot-search';
      mark.textContent = text.slice(s, e);
      frag.append(mark);
      matches[rangeIdx].push(mark);
      pos = e;
    }
    if (pos < text.length) frag.append(document.createTextNode(text.slice(pos)));
    node.replaceWith(frag);
  }
  searchState.matches = matches;
  if (matches.length && searchState.current >= matches.length) searchState.current = matches.length - 1;
  if (!matches.length) searchState.current = -1;
  updateSearchUI();
}

function updateSearchUI() {
  const { matches, current } = searchState;
  $('#search-count').textContent = matches.length ? `${current + 1}/${matches.length}` : '0/0';
  matches.forEach((group, i) => group.forEach((m) => m.classList.toggle('current', i === current)));
  if (matches[current] && matches[current].length) matches[current][0].scrollIntoView({ block: 'center' });
}

function moveSearch(dir) {
  const { matches } = searchState;
  if (!matches.length) return;
  searchState.current = (searchState.current + dir + matches.length) % matches.length;
  updateSearchUI();
}

$('#search-input').addEventListener('input', () => {
  searchState.query = $('#search-input').value;
  searchState.current = 0;
  applySearch();
});

$('#search-input').addEventListener('keydown', (e) => {
  // 中文输入法按回车选字不算「下一个匹配」，否则选字提交会被取消
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    moveSearch(e.shiftKey ? -1 : 1);
  }
});

$('#search-next').addEventListener('click', () => moveSearch(1));
$('#search-prev').addEventListener('click', () => moveSearch(-1));
$('#search-close').addEventListener('click', closeSearch);

// ---------- 面板折叠 / 侧栏宽度拖拽 / 尺寸持久化 ----------

let dragState = null; // { startX, startW }

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

{
  try {
    const saved = JSON.parse(localStorage.getItem('tot-panels') || 'null');
    if (saved && Number.isFinite(saved.w)) $('#sidebar').style.width = clamp(saved.w, 200, 600) + 'px';
  } catch {}
}

function savePanelSizes() {
  localStorage.setItem('tot-panels', JSON.stringify({
    w: Math.round($('#sidebar').clientWidth),
  }));
}

// 折叠状态挂 #sidebar 类（body.className 被渲染风格占用）；只存尺寸不存折叠态。
// 树与大纲互斥：展开一个就折叠另一个、折叠一个就展开另一个——同一时刻只有一个面板展开；
// 折叠的面板只留标题条钉在侧沿（大纲钉底、目录钉顶），对应内容随之不显示
let panelSync = false;
function setPanelCollapsed(kind, collapsed) {
  $('#sidebar').classList.toggle(kind, collapsed);
  const btn = kind === 'tree-collapsed' ? $('#tree-toggle') : $('#outline-toggle');
  btn.textContent = collapsed ? '▸' : '▾';
  if (panelSync) return;
  panelSync = true;
  if (kind === 'tree-collapsed') {
    if (!$('#outline-header').hidden) setPanelCollapsed('outline-collapsed', !collapsed);
  } else {
    setPanelCollapsed('tree-collapsed', !collapsed);
  }
  panelSync = false;
}

$('#tree-toggle').addEventListener('click', () => {
  setPanelCollapsed('tree-collapsed', !$('#sidebar').classList.contains('tree-collapsed'));
});
$('#outline-toggle').addEventListener('click', () => {
  setPanelCollapsed('outline-collapsed', !$('#sidebar').classList.contains('outline-collapsed'));
});

function startDrag(e) {
  dragState = { startX: e.clientX, startW: $('#sidebar').clientWidth };
  e.preventDefault();
}

// 不用 setPointerCapture：合成 PointerEvent 没有真实 pointerId 会抛错，
// 改为 document 级 move/up + 标志位
document.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  $('#sidebar').style.width = clamp(dragState.startW + e.clientX - dragState.startX, 200, 600) + 'px';
});

document.addEventListener('pointerup', () => {
  if (!dragState) return;
  savePanelSizes();
  dragState = null;
});
// 指针拖出窗口再松手会丢 pointerup：离开文档时兜底结束拖拽
document.addEventListener('pointerleave', () => { dragState = null; });

$('#sidebar-resizer').addEventListener('pointerdown', (e) => startDrag(e));

// ---------- 拖入文件打开 ----------

// 拦截默认行为：Chromium 默认把窗口导航到被拖的文件（顶掉整个应用界面），
// 这里改成把 .md 文件路径交给主进程走「打开文件」全流程（放行目录 + 最近打开 + 打开标签页）
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) {
    let p = '';
    try { p = window.tot.getPathForFile(f); } catch {}
    if (p) window.tot.openDropped(p);
  }
});

// ---------- 全局快捷键（渲染层只处理无菜单冲突的键；Ctrl+S/O 走主进程菜单） ----------

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openSearch();
  } else if (mod && e.key === 'Tab') {
    if (tabs.length < 2) return;
    e.preventDefault();
    const i = tabs.indexOf(activeTab);
    activateTab(e.shiftKey ? tabs[(i - 1 + tabs.length) % tabs.length] : tabs[(i + 1) % tabs.length]);
  } else if (mod && e.key.toLowerCase() === 'z' && !e.isComposing && !editorFocus()) {
    // 退出编辑后的 Ctrl+Z / Ctrl+Shift+Z：走文档级历史（整块回退）。编辑区内不拦截，
    // 保持 Chromium 原生逐字撤销。菜单项只显示快捷键不注册，避免两边同时处理导致撤销两步
    e.preventDefault();
    if (e.shiftKey) redoAction(); else undoAction();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redoAction(); // 编辑菜单的重做是 Ctrl+Shift+Z，Windows 习惯的 Ctrl+Y 在此兜底
  } else if (e.key === 'Escape' && !e.isComposing && blockEditor) {
    cancelBlockEdit(); // 焦点不在编辑块内时兜底取消（块内 Esc 由自身 stopPropagation 处理）
  } else if (e.key === 'Escape' && !e.isComposing && diagramEditor) {
    cancelDiagramEdit(); // 焦点不在编辑器 textarea 时兜底取消（textarea 内 Esc 由自身 stopPropagation 处理）
  } else if (e.key === 'Escape' && !e.isComposing && $('#search-input').value) {
    closeSearch();
  }
});

// ---------- 大纲 ----------

// 中文友好的 slug：保留中日韩与字母数字，空白转连字符
function slugify(text) {
  const s = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
  return s || 'section';
}

function assignHeadingIds(targetEl) {
  const counts = new Map();
  targetEl.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    let id = slugify(h.textContent);
    const n = (counts.get(id) || 0) + 1;
    counts.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    h.id = id;
  });
}

function rebuildOutline() {
  const viewer = activeViewer();
  const ul = $('#outline');
  ul.textContent = '';
  const headings = viewer.querySelectorAll('h1,h2,h3,h4,h5,h6');
  const hasHeadings = headings.length > 0;
  $('#outline-header').hidden = !hasHeadings;
  $('#outline-body').hidden = !hasHeadings;
  // 无大纲时树必须可见，否则侧栏只剩一个标题条
  if (!hasHeadings) setPanelCollapsed('tree-collapsed', false);
  headings.forEach((h) => {
    const li = document.createElement('li');
    li.className = `level-${h.tagName[1]}`;
    const a = document.createElement('a');
    a.textContent = h.textContent;
    a.href = `#${h.id}`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.append(a);
    ul.append(li);
  });
  setupScrollspy(headings);
}

// ---------- scrollspy：视口内最靠上的标题在大纲中高亮 ----------

let observer = null;

function setupScrollspy(headings) {
  if (observer) observer.disconnect();
  // IO 回调只带「状态发生变化」的标题，所以维护一张持续更新的可见性表，
  // 每次从当前全部可见的标题里选视口内最靠上的
  const visibility = new Map();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) visibility.set(e.target, e.isIntersecting);
    let best = null;
    let bestTop = Infinity;
    for (const [el, visible] of visibility) {
      if (!visible) continue;
      const top = el.getBoundingClientRect().top;
      if (top < bestTop) {
        bestTop = top;
        best = el;
      }
    }
    if (best) setActiveHeading(best);
  }, { root: activeScroll(), threshold: 0 });
  headings.forEach((h) => observer.observe(h));
}

function setActiveHeading(heading) {
  document.querySelectorAll('#outline a.active').forEach((a) => a.classList.remove('active'));
  const link = document.querySelector(`#outline a[href="#${heading.id}"]`);
  if (link) {
    link.classList.add('active');
    // 大纲区自身可滚动，保证高亮项可见
    link.closest('li').scrollIntoView({ block: 'nearest' });
  }
}
