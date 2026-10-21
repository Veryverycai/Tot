'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tot', {
  // 树懒加载：请求某目录的直接子项（子目录 + md 文件），主进程按已知范围放行
  scanChildren: (dir) => ipcRenderer.invoke('scan-children', dir),
  // 读取可浏览范围内文件的文本内容
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  // 保存当前编辑内容（菜单 文件 → 保存 / Ctrl+S）
  writeFile: (filePath, text) => ipcRenderer.invoke('write-file', filePath, text),
  // 批量把 md 内图片相对路径解析为 mdfile:// URL
  resolveImages: (filePath, srcs) => ipcRenderer.invoke('resolve-images', filePath, srcs),
  // 打开文件后上报，记入文件菜单的「最近打开」
  addRecent: (filePath) => ipcRenderer.invoke('add-recent', filePath),
  // 拖入文件：从 File 对象取本地路径（Electron 32 起 File.path 已移除）
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // 拖入的 md 文件：主进程校验扩展名后走「打开文件」全流程
  openDropped: (filePath) => ipcRenderer.invoke('open-dropped', filePath),
  // 主进程推送「我的电脑」盘符列表（启动）
  onInitTree: (cb) => ipcRenderer.on('init-tree', (_e, data) => cb(data)),
  // 主进程通知：树定位展开到某目录（菜单 打开文件夹）
  onLocatePath: (cb) => ipcRenderer.on('locate-path', (_e, data) => cb(data)),
  // 主进程通知：定位展开并打开某文件（菜单 打开文件 / 最近打开）
  onOpenFilePath: (cb) => ipcRenderer.on('open-file-path', (_e, data) => cb(data)),
  // 主进程通知：要打开的文件已不存在（已从最近打开移除）
  onOpenFileError: (cb) => ipcRenderer.on('open-file-error', (_e, data) => cb(data)),
  // 主进程菜单命令（保存）
  onMenuCommand: (cb) => ipcRenderer.on('menu-command', (_e, cmd) => cb(cmd)),
  // 顶栏「撤销」按钮：与编辑菜单「撤销」同款原生撤销（作用于当前焦点编辑区）
  undo: () => ipcRenderer.send('web-undo'),
  // 插入图片：系统文件选择器 → 返回相对当前文档路径的相对路径
  selectImage: (docPath) => ipcRenderer.invoke('select-image', docPath),
  // 原生菜单栏明暗跟随渲染风格
  setTheme: (dark) => ipcRenderer.invoke('set-theme', dark),
});
