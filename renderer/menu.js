'use strict';

// 自绘菜单栏：文件 / 编辑 / 视图 / 窗口（Tauri 壳无原生菜单，明暗随 body 风格类）。
// 菜单项与快捷键逐项对齐 Electron 时代的原生菜单；保存/撤销/重做复用 app.js
// 的 onMenuCommand 路由（经 bridge 的 tot-menu-command CustomEvent 派发）。

(() => {
  const tot = window.tot;
  const menuCommand = (cmd) => window.dispatchEvent(new CustomEvent('tot-menu-command', { detail: cmd }));

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

  // ---- 模态弹层（关于 / MIT 许可协议，替代原生 MessageBox） ----

  const overlay = document.querySelector('#modal-overlay');
  const modalTitle = document.querySelector('#modal-title');
  const modalBody = document.querySelector('#modal-body');

  function showModal(title, text) {
    modalTitle.textContent = title;
    modalBody.textContent = text;
    overlay.hidden = false;
    document.querySelector('#modal-close').focus();
  }

  function hideModal() {
    overlay.hidden = true;
  }

  document.querySelector('#modal-close').addEventListener('click', hideModal);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) hideModal();
  });

  async function showAbout() {
    const v = await tot.getVersion().catch(() => '');
    showModal('关于 Tot', `Tot\n\n版本 ${v}\n\n本地 Markdown 浏览器\nTauri + 原生 JavaScript`);
  }

  function showLicense() {
    showModal('MIT 许可协议', MIT_LICENSE);
  }

  // ---- 粘贴：web 内容 execCommand('paste') 不可用，读系统剪贴板后按纯文本插入 ----

  async function pasteClipboard() {
    try {
      const text = await tot.readClipboardText();
      if (text) document.execCommand('insertText', false, text);
    } catch {}
  }

  // ---- 菜单定义（标签 / 快捷键显示 / 动作） ----

  const MENUS = [
    {
      label: '文件',
      items: [
        { label: '打开文件', acc: 'Ctrl+O', action: () => tot.openFileDialog() },
        { label: '打开文件夹', acc: 'Ctrl+Shift+O', action: () => tot.openFolderDialog() },
        { label: '最近打开', submenu: 'recent' },
        { sep: true },
        { label: '保存', acc: 'Ctrl+S', action: () => menuCommand('save') },
        { sep: true },
        { label: '退出', action: () => tot.winQuit() },
      ],
    },
    {
      label: '编辑',
      items: [
        // 撤销/重做路由到渲染层：编辑区内原生逐字、退出后文档级快照（与旧版一致）
        { label: '撤销', acc: 'Ctrl+Z', action: () => menuCommand('undo') },
        { label: '重做', acc: 'Ctrl+Shift+Z', action: () => menuCommand('redo') },
        { sep: true },
        { label: '剪切', acc: 'Ctrl+X', action: () => document.execCommand('cut') },
        { label: '复制', acc: 'Ctrl+C', action: () => document.execCommand('copy') },
        { label: '粘贴', acc: 'Ctrl+V', action: pasteClipboard },
        { sep: true },
        { label: '全选', acc: 'Ctrl+A', action: () => document.execCommand('selectAll') },
      ],
    },
    {
      label: '视图',
      items: [
        { label: '重新加载', acc: 'Ctrl+R', action: () => tot.winReload() },
        { sep: true },
        { label: '实际大小', acc: 'Ctrl+0', action: () => tot.zoomReset() },
        { label: '放大', acc: 'Ctrl+=', action: () => tot.zoomIn() },
        { label: '缩小', acc: 'Ctrl+-', action: () => tot.zoomOut() },
        { sep: true },
        { label: '全屏', acc: 'F11', action: () => tot.winFullscreen() },
        { label: '开发者工具', acc: 'Ctrl+Shift+I', action: () => tot.openDevtools() },
      ],
    },
    {
      label: '窗口',
      items: [
        { label: '最小化', action: () => tot.winMinimize() },
        { label: '关闭窗口', acc: 'Alt+F4', action: () => tot.winClose() },
        { sep: true },
        { label: '关于 Tot', action: showAbout },
        { label: 'MIT 许可协议', action: showLicense },
      ],
    },
  ];

  // ---- DOM 构建 ----

  const bar = document.querySelector('#menubar');
  const menuEls = [];

  function buildItem(item) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      return sep;
    }
    const el = document.createElement('div');
    el.className = 'menu-item';
    el.dataset.label = item.label;
    const label = document.createElement('span');
    label.textContent = item.label;
    el.append(label);
    if (item.acc) {
      const acc = document.createElement('span');
      acc.className = 'acc';
      acc.textContent = item.acc;
      el.append(acc);
    }
    if (item.submenu === 'recent') {
      el.classList.add('has-sub');
      const arrow = document.createElement('span');
      arrow.className = 'sub-arrow';
      arrow.textContent = '▸';
      el.append(arrow);
      const sub = document.createElement('div');
      sub.className = 'menu-popup sub-popup';
      el.append(sub);
      el.addEventListener('pointerenter', () => {
        el.classList.add('sub-open');
        fillRecent(sub);
      });
      el.addEventListener('pointerleave', (e) => {
        // 移入子菜单本身时保持展开
        if (!sub.contains(e.relatedTarget)) el.classList.remove('sub-open');
      });
      sub.addEventListener('pointerleave', (e) => {
        if (!el.contains(e.relatedTarget)) el.classList.remove('sub-open');
      });
    } else if (item.action) {
      // mousedown 不夺焦：保留编辑区焦点与选区（剪切/复制/粘贴/撤销依赖现场焦点）
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', () => {
        closeAll();
        item.action();
      });
    }
    return el;
  }

  // 「最近打开」子菜单：最多 3 个，空时显示禁用占位项
  async function fillRecent(sub) {
    const recent = await tot.getRecent().catch(() => []);
    sub.textContent = '';
    if (!recent.length) {
      const empty = document.createElement('div');
      empty.className = 'menu-item disabled';
      empty.textContent = '（暂无最近文件）';
      sub.append(empty);
      return;
    }
    for (const p of recent) {
      const el = document.createElement('div');
      el.className = 'menu-item';
      el.title = p;
      el.textContent = p.split(/[\\/]/).pop();
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', () => {
        closeAll();
        tot.openDropped(p); // 与旧版最近打开同一流程：放行父目录 + 记最近 + 打开
      });
      sub.append(el);
    }
  }

  MENUS.forEach((menu, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'menu';
    const title = document.createElement('button');
    title.className = 'menu-title';
    title.textContent = menu.label;
    title.addEventListener('mousedown', (e) => e.preventDefault());
    title.addEventListener('click', () => {
      if (wrap.classList.contains('open')) closeAll();
      else openMenu(i);
    });
    // 已有菜单展开时，悬停即切换（Windows 菜单习惯）
    title.addEventListener('pointerenter', () => {
      if (bar.querySelector('.menu.open') && !wrap.classList.contains('open')) openMenu(i);
    });
    const popup = document.createElement('div');
    popup.className = 'menu-popup';
    for (const item of menu.items) popup.append(buildItem(item));
    wrap.append(title, popup);
    bar.append(wrap);
    menuEls.push(wrap);
  });

  function openMenu(i) {
    closeAll();
    menuEls[i].classList.add('open');
  }

  function closeAll() {
    for (const el of menuEls) {
      el.classList.remove('open');
      el.querySelectorAll('.sub-open').forEach((s) => s.classList.remove('sub-open'));
    }
  }

  // 点菜单外任意处收起
  document.addEventListener('pointerdown', (e) => {
    if (!bar.contains(e.target)) closeAll();
  });

  // 最近打开索引变化：文件菜单正展开时即时刷新子菜单
  tot.onRecentChanged(() => {
    const fileMenu = menuEls[0];
    if (fileMenu.classList.contains('open')) {
      const sub = fileMenu.querySelector('.sub-popup');
      if (sub && sub.closest('.sub-open')) fillRecent(sub);
    }
  });

  // ---- 全局快捷键（原由原生菜单 accelerator 承担的部分） ----
  // Ctrl+Z/Y/F/H/Tab 的路由在 app.js（编辑区内原生、退出后文档级），这里不重复处理

  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    // 弹层打开时 Esc 只关弹层
    if (e.key === 'Escape' && !overlay.hidden) {
      e.preventDefault();
      e.stopPropagation();
      hideModal();
      return;
    }
    if (e.key === 'Escape' && bar.querySelector('.menu.open')) {
      e.preventDefault();
      e.stopPropagation();
      closeAll();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      menuCommand('save');
    } else if (mod && key === 'o') {
      e.preventDefault();
      if (e.shiftKey) tot.openFolderDialog();
      else tot.openFileDialog();
    } else if (mod && key === 'r') {
      e.preventDefault();
      tot.winReload();
    } else if (mod && e.key === '0') {
      e.preventDefault();
      tot.zoomReset();
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      tot.zoomIn();
    } else if (mod && e.key === '-') {
      e.preventDefault();
      tot.zoomOut();
    } else if (e.key === 'F11') {
      e.preventDefault();
      tot.winFullscreen();
    } else if (mod && e.shiftKey && key === 'i') {
      e.preventDefault();
      tot.openDevtools();
    }
  }, true);
})();