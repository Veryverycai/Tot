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

// 标签页：{ id, path, name, text, dirty, mode:'preview'|'edit', lineEnding, scrollTop }
const tabs = [];
let activeTab = null;
let openSeq = 0;      // 打开序号：防慢 readFile 晚到覆盖当前标签页

const $ = (sel) => document.querySelector(sel);

// 当前活动的渲染区与滚动容器（预览 #viewer / 编辑右栏 #edit-viewer）
function activeViewer() {
  return activeTab && activeTab.mode === 'edit' ? $('#edit-viewer') : $('#viewer');
}

function activeScroll() {
  return activeTab && activeTab.mode === 'edit' ? $('#edit-viewer') : $('#preview-scroll');
}

// ---------- 风格切换 ----------

// 风格注册表：每个 id 对应一个 body class + 若干 css 文件（link 惰性创建）
// dark 标记驱动原生菜单栏明暗（Windows 菜单栏随应用深色模式着色）
const STYLES = [
  { id: 'github-light', group: 'GitHub', label: 'GitHub 亮', dark: false, files: ['../lib/github-markdown-light.css', 'styles/github-light.css', 'styles/callouts.css'] },
  { id: 'github-dark', group: 'GitHub', label: 'GitHub 暗', dark: true, files: ['../lib/github-markdown-dark.css', 'styles/github-dark.css', 'styles/callouts-dark.css', 'styles/shell-github-dark.css'] },
  { id: 'minimal', group: '极简', label: '极简', dark: false, files: ['styles/minimal.css', 'styles/callouts.css'] },
  { id: 'rtd', group: '文档', label: 'Read the Docs', dark: false, files: ['styles/rtd.css', 'styles/callouts.css'] },
  { id: 'notion-light', group: '文档', label: 'Notion 亮', dark: false, files: ['styles/notion-light.css', 'styles/callouts.css'] },
  { id: 'notion-dark', group: '文档', label: 'Notion 暗', dark: true, files: ['styles/notion-dark.css', 'styles/callouts-dark.css'] },
  { id: 'typora-white', group: '文档', label: 'Typora White', dark: false, files: ['styles/typora-white.css', 'styles/callouts.css'] },
  { id: 'typora-night', group: '文档', label: 'Typora Night', dark: true, files: ['styles/typora-night.css', 'styles/callouts-dark.css'] },
  { id: 'obsidian', group: '文档', label: 'Obsidian', dark: true, files: ['styles/obsidian.css', 'styles/callouts-dark.css'] },
  { id: 'dracula', group: '代码编辑器', label: 'Dracula', dark: true, files: ['styles/dracula.css', 'styles/callouts-dark.css'] },
  { id: 'nord', group: '代码编辑器', label: 'Nord', dark: true, files: ['styles/nord.css', 'styles/callouts-dark.css'] },
  { id: 'monokai', group: '代码编辑器', label: 'Monokai', dark: true, files: ['styles/monokai.css', 'styles/callouts-dark.css'] },
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
    const tab = {
      id: `tab-${seq}`,
      path: filePath,
      name: baseName(filePath),
      text,
      dirty: false,
      mode: 'preview',
      lineEnding: text.includes('\r\n') ? '\r\n' : '\n',
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
  showPanes('preview');
  await renderMarkdown($('#viewer'), tab.text, tab.path);
  rebuildOutline();
  // 打开文档的默认布局：展开大纲、折叠目录（文档无大纲时保持目录展开）
  if (!$('#outline-header').hidden) {
    setPanelCollapsed('outline-collapsed', false);
    setPanelCollapsed('tree-collapsed', true);
  }
  activeScroll().scrollTop = 0;
  updateTabbar();
  restoreTreeActive();
}

// 切换标签页：互存滚动位置，重渲染并恢复（含编辑/预览模式）
async function activateTab(tab) {
  if (tab === activeTab) return;
  if (activeTab) activeTab.scrollTop = activeScroll().scrollTop;
  activeTab = tab;
  $('#panes').hidden = false;
  $('#empty').hidden = true;
  showPanes(tab.mode);
  if (tab.mode === 'edit') {
    $('#editor').value = tab.text;
    await renderMarkdown($('#edit-viewer'), tab.text, tab.path);
  } else {
    await renderMarkdown($('#viewer'), tab.text, tab.path);
  }
  rebuildOutline();
  activeScroll().scrollTop = tab.scrollTop;
  updateTabbar();
  restoreTreeActive();
}

function updateTabbar() {
  const bar = $('#tabbar');
  bar.textContent = '';
  bar.hidden = tabs.length === 0;
  $('#edit-toggle').disabled = !activeTab;
  $('#save-btn').disabled = !activeTab || activeTab.mode !== 'edit';
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
    $('#edit-toggle').disabled = true;
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
    return;
  }
  if (wasActive) activateTab(tabs[Math.min(i, tabs.length - 1)]);
  else updateTabbar();
}

$('#close-discard').addEventListener('click', () => { if (pendingCloseIndex >= 0) doClose(pendingCloseIndex); });
$('#close-cancel').addEventListener('click', () => { pendingCloseIndex = -1; $('#close-confirm').hidden = true; });

// ---------- 编辑（双栏实时预览） ----------

let editTimer = null; // 输入 debounce

// 显示预览/编辑面板并同步按钮文案
function showPanes(mode) {
  $('#preview-scroll').hidden = mode === 'edit';
  $('#edit-pane').hidden = mode !== 'edit';
  $('#edit-toggle').textContent = mode === 'edit' ? '预览' : '编辑';
  $('#save-btn').disabled = mode !== 'edit'; // 预览模式下保存按钮变灰
}

$('#edit-toggle').addEventListener('click', async () => {
  if (!activeTab) return;
  await setMode(activeTab.mode === 'edit' ? 'preview' : 'edit');
});

// 编辑模式下的保存按钮（与菜单 Ctrl+S 同一路径）
$('#save-btn').addEventListener('click', saveActiveTab);

// 切换当前标签页的预览/编辑模式（互存滚动位置）
async function setMode(mode) {
  if (!activeTab || activeTab.mode === mode) return;
  activeTab.scrollTop = activeScroll().scrollTop;
  activeTab.mode = mode;
  showPanes(mode);
  clearTimeout(editTimer);
  if (mode === 'edit') {
    $('#editor').value = activeTab.text;
    await renderMarkdown($('#edit-viewer'), activeTab.text, activeTab.path);
  } else {
    await renderMarkdown($('#viewer'), activeTab.text, activeTab.path);
  }
  rebuildOutline();
  activeScroll().scrollTop = activeTab.scrollTop;
}

// 编辑器输入：文本与 dirty 即时同步，300ms debounce 刷新右栏
$('#editor').addEventListener('input', (e) => {
  if (!activeTab || activeTab.mode !== 'edit') return;
  activeTab.text = e.target.value;
  activeTab.dirty = true;
  updateTabbarDirty(activeTab);
  clearTimeout(editTimer);
  editTimer = setTimeout(async () => {
    if (!activeTab || activeTab.mode !== 'edit') return; // 期间切走则丢弃
    await renderMarkdown($('#edit-viewer'), activeTab.text, activeTab.path);
    rebuildOutline();
  }, 300);
});

function updateTabbarDirty(tab) {
  if (tab.el) tab.el.querySelector('.tab-dirty').hidden = !tab.dirty;
}

// 菜单 文件 → 保存 / Ctrl+S（唯一入口，渲染层不监听 Ctrl+S 防双触发）
async function saveActiveTab() {
  if (!activeTab || !activeTab.dirty) return;
  const tab = activeTab;
  if (tab.mode === 'edit') {
    tab.text = $('#editor').value;
    await renderMarkdown($('#edit-viewer'), tab.text, tab.path);
    rebuildOutline();
  }
  try {
    // 编辑器把换行统一成 \n，写盘时按原文件的换行风格还原
    await window.tot.writeFile(tab.path, tab.text.split('\n').join(tab.lineEnding));
    tab.dirty = false;
    updateTabbarDirty(tab);
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
  targetEl.innerHTML = marked.parse(text);
  const imgs = [...targetEl.querySelectorAll('img')];
  const srcs = imgs.map((img) => img.getAttribute('src') || '');
  const resolved = await window.tot.resolveImages(filePath, srcs);
  imgs.forEach((img, i) => { img.src = resolved[i]; });
  // 代码语法高亮（替换 code 内文本为 token span，须在 applySearch 之前）
  if (window.hljs) {
    targetEl.querySelectorAll('pre code').forEach((el) => { hljs.highlightElement(el); });
  }
  applyCallouts(targetEl);
  assignHeadingIds(targetEl);
  applySearch();
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
  if (e.key === 'Enter') {
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
  } else if (e.key === 'Escape' && $('#search-input').value) {
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
