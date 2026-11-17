'use strict';

// Tauri 桥接层：以与 Electron 时代 preload.js 完全相同的签名实现 window.tot，
// app.js 无需感知壳已更换。直接走 Tauri 注入的 __TAURI_INTERNALS__ 原语，
// 不引入 @tauri-apps/api 打包链（维持零构建工具）。

(() => {
  const T = window.__TAURI_INTERNALS__;
  const invoke = (cmd, args) => T.invoke(cmd, args);
  // Tauri 事件 → 与 ipcRenderer.on 相同的回调签名（只收 payload）
  const listen = (event, cb) => T.invoke('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: T.transformCallback((e) => cb(e.payload)),
  });

  // 菜单命令：自绘菜单（menu.js）经 CustomEvent 派发，路由与旧 menu-command IPC 一致
  const menuCbs = [];
  window.addEventListener('tot-menu-command', (e) => {
    for (const cb of menuCbs) cb(e.detail);
  });

  window.tot = {
    // 树懒加载：请求某目录的直接子项（子目录 + md 文件），壳按已知范围放行
    scanChildren: (dir) => invoke('scan_children', { dir }),
    // 读取可浏览范围内文件的文本内容
    readFile: (filePath) => invoke('read_file', { p: filePath }),
    // 保存当前编辑内容（菜单 文件 → 保存 / Ctrl+S）
    writeFile: (filePath, text) => invoke('write_file', { p: filePath, text }),
    // 批量把 md 内图片相对路径解析为图片协议 URL
    resolveImages: (filePath, srcs) => invoke('resolve_images', { filePath, srcs }),
    // 打开文件后上报，记入文件菜单的「最近打开」
    addRecent: (filePath) => invoke('add_recent', { p: filePath }),
    // 拖入/最近打开的 md 文件：壳校验扩展名后走「打开文件」全流程
    openDropped: (filePath) => invoke('open_dropped', { p: filePath }),
    // 插入图片：系统文件选择器 → 返回相对当前文档路径的相对路径
    selectImage: (docPath) => invoke('select_image', { docPath }),
    // 标题栏明暗跟随渲染风格（菜单栏明暗由 body 风格类驱动）
    setTheme: (dark) => invoke('set_theme', { dark }),
    // 会话：标签页变化时上报（关闭后下次启动据此询问是否恢复）
    saveSession: (data) => invoke('save_session', { data }),
    // 用户点「恢复」：壳过滤已删除文件并放行父目录
    restoreSession: (paths) => invoke('restore_session', { paths }),
    // 用户点「忽略」：清空会话记录
    dismissSession: () => invoke('dismiss_session'),
    // 编辑区内逐字撤销/重做：WebView2 的 contenteditable/textarea 原生撤销栈
    // （替代 Electron webContents.undo/redo）
    undo: () => { document.execCommand('undo'); },
    redo: () => { document.execCommand('redo'); },
    // 壳推送「我的电脑」盘符列表（启动）
    onInitTree: (cb) => listen('init-tree', cb),
    // 壳通知：树定位展开到某目录（菜单 打开文件夹）
    onLocatePath: (cb) => listen('locate-path', cb),
    // 壳通知：定位展开并打开某文件（菜单 打开文件 / 最近打开 / argv / 拖入）
    onOpenFilePath: (cb) => listen('open-file-path', cb),
    // 壳通知：要打开的文件已不存在（已从最近打开移除）
    onOpenFileError: (cb) => listen('open-file-error', cb),
    // 菜单命令（保存/撤销/重做，自绘菜单派发）
    onMenuCommand: (cb) => { menuCbs.push(cb); },
    // 壳通知：上次关闭前有打开的文件，询问是否恢复
    onSessionOffer: (cb) => listen('session-offer', cb),
    // 壳通知：最近打开索引变化（自绘菜单刷新）
    onRecentChanged: (cb) => listen('recent-changed', cb),

    // ---- 自绘菜单 / 窗口操作（Tauri 壳新增，Electron 时代由原生菜单承担） ----
    openFileDialog: () => invoke('open_file_dialog'),
    openFolderDialog: () => invoke('open_folder_dialog'),
    getRecent: () => invoke('get_recent'),
    getVersion: () => invoke('get_version'),
    showWindow: () => invoke('show_window'),
    winMinimize: () => invoke('win_minimize'),
    winClose: () => invoke('win_close'),
    winQuit: () => invoke('win_quit'),
    winFullscreen: () => invoke('win_fullscreen'),
    winReload: () => invoke('win_reload'),
    zoomIn: () => invoke('zoom_in'),
    zoomOut: () => invoke('zoom_out'),
    zoomReset: () => invoke('zoom_reset'),
    openDevtools: () => invoke('open_devtools'),
    readClipboardText: () => invoke('plugin:clipboard-manager|read_text', null),
  };

  // 首帧就绪：恢复窗口标题「Tot + 版本号」（document.title 会同步到窗口标题），
  // 显示窗口并通知壳运行启动序列（init-tree / argv / 会话询问）——
  // 此时 app.js 的事件监听已全部注册，不会丢事件
  const ready = () => {
    invoke('get_version')
      .then((v) => { document.title = 'Tot ' + v; })
      .catch(() => {});
    requestAnimationFrame(() => {
      invoke('show_window');
      invoke('frontend_ready', { pageMs: performance.now() });
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();