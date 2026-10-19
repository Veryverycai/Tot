# Tot — 本地 MD 文件浏览器 — 实现方案

应用名：**Tot**（package.json name: `tot`；productName / 窗口标题 / exe 名：`Tot`）

## 目标与成功标准

选一个本地目录 → 浏览其中全部 .md 文件 → 渲染阅读，12 套渲染风格可选，自动生成大纲；支持多标签页、双栏实时预览编辑保存、文件内查找、面板拖拽，自动记住上次目录。

1.1 成功标准（全部满足才算完成）：

1. 窗口标题 Tot；顶栏无文字/无打开文件夹按钮；菜单栏 文件/编辑/视图/窗口（文件含打开文件 Ctrl+O、打开文件夹 Ctrl+Shift+O、保存 Ctrl+S；窗口含关于 Tot 与 MIT 许可协议）
2. 多标签页：打开多个文件成 tab，开关切换滚动恢复、dirty 关闭确认、全部关闭回空态
3. 编辑：双栏实时预览（左 textarea + 右渲染，300ms debounce）、Ctrl+S 落盘（按原文件换行风格还原）、dirty 回显、越界路径拒写、编辑模式出现保存按钮（预览模式变灰）
4. 搜索：Ctrl+F 文件内查找，高亮/计数/上下跳转，重渲染后自动重应用
5. 拖拽：文件夹导航与大纲框可拖动大小（sidebar 200–600px / outline 120–600px clamp）
6. 重启自动恢复上次目录（userData/config.json）
7. 12 套渲染风格切换生效 + localStorage 持久化 + 暗色外壳无亮色残块 + 代码块 highlight.js 语法高亮（每套风格独立 token 配色）+ Callout 标注块（`> [!NOTE]` 等 5 类）+ 代码块底色与风格背景对比明显
8. 全量自动化断言通过、测试数据零污染、打包 exe 干净目录双击可用、代码推送 GitHub

## 技术选型

- Electron（44.7.2）+ 原生 JS。**无前端框架、无构建工具**（渲染层就是静态 HTML+JS+CSS）
- Markdown 解析：marked（UMD 版，vendored 到 `lib/`，离线可用）
- 代码语法高亮：highlight.js 11.11.1（common 语言集 vendored），渲染后对 `pre code` 调 `hljs.highlightElement`（有 language class 用之，否则自动检测）；token 配色按 12 套风格各写一份（6 个颜色桶），不走 hljs 官方主题（避免多主题全局类互相覆盖）
- 风格样式：github-markdown-css（light / dark vendored）+ 10 个手写 css（minimal / rtd / notion-light / notion-dark / typora-white / typora-night / obsidian / dracula / nord / monokai / shell-github-dark）
- 安全基线：`contextIsolation: true`、`nodeIntegration: false`；渲染进程不碰 Node API，全部通过 preload 的 contextBridge 白名单 IPC（select-directory / select-file / read-file / write-file / resolve-images / onDirectorySelected / onMenuCommand）；CSP `default-src 'none'` 白名单
- 图片：自定义协议 `mdfile://` 映射本地绝对路径（`protocol.handle`），路径校验限制在所选根目录内
- 记住目录：主进程 userData/config.json（不用 localStorage——渲染层不可信，不提供「提交任意 rootDir」的 IPC）

## 项目结构

```
md-browser/
├── package.json      # devDependencies: electron, electron-builder；main → main.js
├── main.js           # 主进程：窗口/菜单、目录扫描、文件读写、mdfile:// 协议、config、dev 验证钩子
├── preload.js        # contextBridge 暴露 7 个白名单 API
├── renderer/
│   ├── index.html    # 顶栏(搜索条+编辑/保存按钮+风格选择) + 左栏(文件树+大纲) + tab 条 + 双栏正文
│   ├── app.js        # 多标签页、双栏编辑、查找、大纲/scrollspy、拖拽、12 套风格注册表
│   ├── base.css      # 应用布局与控件样式（与渲染风格无关的部分）
│   └── styles/       # 手写渲染风格（每套 = 正文排版，7 套暗色另含外壳配色块）
└── lib/              # 全部第三方 vendored 文件
    ├── marked.min.js
    ├── highlight.min.js
    ├── github-markdown-light.css
    └── github-markdown-dark.css
```

## 关键设计

### 进程分工

- **主进程**：原生菜单（menu-command 推送）、目录/文件对话框、盘符枚举 + 单层扫描 scan-children（只收 .md/.markdown 与子目录，跳过点开头目录与系统缓存目录）、readFile/writeFile/mdfile 按需读写（knownDirs 链条式信任边界——渲染层只能扩展已见过的目录）、config.json 存最近打开
- **preload**：contextBridge 白名单 13 个 API
- **渲染进程**：全部 UI 逻辑（树懒加载 + 路径聚焦、面板互斥、标签页/编辑/搜索/大纲）

### 多标签页

- `tabs: [{id, path, name, text, dirty, mode, lineEnding, scrollTop, el}]`；单 #viewer 复用；openFile 已开则激活否则新开；**序号令牌**防慢 readFile 晚到覆盖当前 tab
- 关闭激活 tab 切邻居；dirty 关闭 → 自绘 #close-confirm 浮条（不用 window.confirm——同步阻塞会挂死自动化）
- 切换 tab：缓存 text 重渲染 → outline → 恢复 scrollTop → 树 active 恢复

### 编辑与保存

- 「编辑/预览」切换按钮：互存滚动位置；编辑模式 = 左 textarea + 右 #edit-viewer 实时渲染（input 即时同步 text/dirty，300ms debounce 渲染，切 tab/切模式 cancel 且回调内校验）
- 保存唯一入口 = 菜单 Ctrl+S 与编辑模式保存按钮（同一函数）：写盘按 tab.lineEnding 还原 \r\n/\n；渲染层**不监听** Ctrl+S 防菜单 accelerator 双触发

### 查找（Ctrl+F）

- TreeWalker 收集活动渲染区文本节点（跳过 script/style/mark）→ 拼接全文大小写不敏感查找 → 区间回映切分 → `mark.tot-search` 高亮全部 + `.current` 区分 → prev/next scrollIntoView；渲染管线末尾统一 applySearch（重渲染后自动重应用，幂等）
- 搜索条常显顶栏（编辑/保存按钮后，风格选择最右）：Ctrl+F 聚焦，Esc / × 清除查询与高亮

### 渲染与大纲

- `marked.parse()` 套 `markdown-body` + 当前风格 class；覆盖 html renderer 转义原始 HTML；图片相对路径改写为 mdfile://
- 标题 slugify + 序号去重 → 大纲缩进列表；IntersectionObserver scrollspy（root 随预览/编辑模式切换）；点击跳转
- 渲染管线顺序：parse → fixImages → hljs 高亮 → callout 转换 → headingIds → applySearch

### Callout 标注块

- blockquote 首段 `[!NOTE/TIP/IMPORTANT/WARNING/CAUTION]` 转 `.callout.callout-<type>`：彩色标题行（emoji + 中文标签）+ rgba 半透明底 + 主题色边框
- 亮色 5 套共用 styles/callouts.css，暗色 7 套共用 styles/callouts-dark.css（rgba 底在任何风格背景上自然融合）；选择器 `body[class]`（属性选择器 = 类级特异性）压过各风格 blockquote 规则

### 风格注册表（12 套）

- `STYLES = [{id, group, label, files[]}]` 单一数据源；惰性创建 `<link data-style-id>`，applyStyle 只 enabled 当前 id 的 link + body.className + localStorage；style-select 的 optgroup 由注册表生成
- 分组：GitHub（github-light/github-dark）、极简（minimal）、文档（rtd/notion-light/notion-dark/typora-white/typora-night/obsidian）、代码编辑器（dracula/nord/monokai）
- 旧 localStorage 值 light/dark 经 LEGACY 映射迁移并回写

### 面板拖拽

- document 级 pointermove/up + dragState 标志（不用 setPointerCapture——合成 PointerEvent 无真实 pointerId 会抛错）；侧栏宽度 clamp 200–600px（大纲高度分隔条已随面板互斥移除）

### 树与面板（1.1.1 重构）

- 树：`我的电脑` 根（details[data-pc-root]）→ 盘符 `C:\` 等 → 单层懒加载（toggle 事件触发 scan-children，scanInflight 合并并发，data-loaded 标记）；`walkPath` 逐级拼接链（盘符带尾反斜杠、子目录不带，须按 `endsWith('\\')` 区分）逐层展开
- 路径聚焦：walkPath 对链上每层只留「路径上的下一个文件夹」（.path-hidden）、末层只留 md 文件（.dir-hidden）；doClose(0) 清全部隐藏类恢复全量浏览
- 面板互斥：setPanelCollapsed 双向联动（panelSync 防递归）——展开一个折叠另一个、折叠一个展开另一个；大纲标题条在内容上方，折叠时 `margin-top: auto` 钉底

### 菜单

- 文件（打开文件/打开文件夹/保存/退出）、编辑（撤销/重做/剪切/复制/粘贴/全选，role 实现）、视图（重新加载/缩放/全屏/开发者工具，role 实现）、窗口（最小化/关闭/关于 Tot/ MIT 许可协议对话框）

## 里程碑与验证点

- **M0 环境** — ✅ Node v24.20.0 / npm 11.19.0
- **M1 骨架** — ✅ `npm start` 窗口打开，DevTools 无报错
- **M2 目录与文件树** — ✅ 树完整、排序正确、文件夹可折叠
- **M3 渲染与风格** — ✅ 表格/代码块/图片渲染，风格切换，重启保持
- **M4 大纲** — ✅ 生成 + 跳转 + scrollspy 高亮跟随
- **M5 打包** — ✅ 1.0.0 便携 exe 干净目录双击可用
- **M6 菜单 + 顶栏 + 打开文件 + 记住目录** — ✅ [dev:menu]/[dev:restore] 断言
- **M7 多标签页** — ✅ [dev:tabs1-6]：去重激活、scrollTop 恢复、空态、dirty 确认/取消/丢弃
- **M8 双栏实时预览编辑 + 保存** — ✅ [dev:edit1-7]：双栏、dirty、debounce、磁盘写入+复原零污染、越界拒写
- **M9 文件内查找** — ✅ [dev:search1-4]：3 匹配、计数、上下跳转、编辑右栏重应用、Esc 清除
- **M10 面板拖拽** — ✅ [dev:drag1-4]：宽度/上下限 clamp/outline 高度
- **M11 12 套风格 + 菜单扩展 + 保存按钮 + 语法高亮 + Callout** — ✅ [dev:check3] 12 套逐一断言（body class、唯一 enabled link、optgroup=4、options=12、localStorage、正文与外壳计算样式、pre 底色、callout 配色），24 张截图目检；[dev:edit0/5b] 保存按钮灰/可用态；[dev:check1] hljsSpans 断言 token span 生成、callouts 断言 5 类标注块与中文标题
- **M12 收尾** — 本版最终验证 + 1.1.0 打包 + 推送

## 1.1.1 修正（我的电脑树 / 最近打开 / 面板互斥 / 路径聚焦）

- 目录浏览以「我的电脑」为根：盘符（A-Z 枚举）→ 文件夹 → 文件，树懒加载（details toggle 触发 scan-children，并发合并）；主进程 knownDirs 链条式信任边界（渲染层只能扩展已见过的目录）
- 去掉上次打开记忆：启动不再自动重开文件/目录；文件菜单加「最近打开」子菜单（config.json `recent`，去重、最多 3 个、最新在前）
- 菜单 打开文件 / 打开文件夹 都保留：选择后在树中逐层定位展开（打开文件还会自动打开该文件）
- 面板互斥展开：树与大纲同一时刻只展开一个（展开一个就折叠另一个、折叠一个就展开另一个）；折叠的面板只留标题条钉在侧沿（大纲钉底、目录钉顶），大纲标签下移即内容折叠不显示；大纲标题条位于内容上方
- 路径聚焦：定位展开时链上每一级只显示路径上的下一个文件夹（.path-hidden），末级只显示该目录下的 MD 文档（.dir-hidden）；关闭全部标签后恢复全量浏览
- 大纲高度分隔条移除（面板互斥后两栏不再同显，高度拖拽失去意义）；侧栏宽度拖拽 + 持久化保留（localStorage `tot-panels`）
- 面板标题条折叠三角 11px → 22px（标签条高度收紧）；文件标签页顶部圆角 8px 8px 0 0
- 最近打开的文件若已被删除：点击时自动从索引移除并在状态栏提示（openByPath fs.access 预检 + open-file-error 推送；渲染层 readFile 失败兜底）
- 文件关联双击打开（Windows「打开方式」关联 .md 后双击）：argv 传入的 .md 路径启动即打开（did-finish-load 排空 startupMdPaths）；单实例锁——已运行实例经 second-instance 接收路径、恢复并聚焦窗口、打开文件；ELECTRON_RUN_AS_NODE 兜底重启透传 argv
- 验证：[dev:panels1-6] 状态断言（互斥/聚焦/dirHidden/pathHidden/treeDirs）+ 亮暗截图；[dev:drag1-3] 侧栏宽度 clamp + 持久化；[dev:start] 盘符树；[dev:recent] 最近打开菜单与 config 一致；[dev:recent-missing] 被删文件自动出索引 + 提示；[dev:argv1] argv 启动打开；[dev:argv2] second-instance 转交打开

## 1.1.2 修正（搜索匹配 / 常显搜索条 / 拖入打开）

- 搜索匹配跨节点：文本节点拼接成全文查找，命中区间按字符偏移回映到各文本节点切分——跨内联格式（**加粗**边界）与代码高亮 span 边界的词可匹配（原实现按单个文本节点 indexOf，跨边界即 0 匹配）；空白文本节点保留参与拼接（相邻匹配需要）
- 搜索条常显顶栏：[保存状态/编辑/保存/搜索条] 一组居左，渲染风格选择居最右；Ctrl+F 只聚焦搜索框，Esc / × 清除查询与高亮（搜索条不再隐藏，编辑保存后保持）
- 拖入打开：document 级 dragover/drop 拦截默认导航（Chromium 默认把窗口导航到被拖的文件，顶掉整个应用界面）→ webUtils.getPathForFile 取路径（Electron 32+ File.path 已移除）→ open-dropped IPC（仅收 .md/.markdown）→ openByPath 全流程（放行父目录 + 最近打开 + 打开标签页）
- 验证：[dev:search1-4] 跨边界查询断言 + 顶栏布局断言（topbarKids/controlsKids/barAfterSave/selectAtRight）；[dev:drop1-3] 合成 drop 拦截默认导航 / 目录外真实路径打开 / 非 md 拒绝

## 1.1.3 修正（搜索命中归组 / 目录树不缩进）

- 搜索命中归组：一个逻辑命中跨节点切出的多个 mark 片段归为同一组——计数与上下跳转按完整命中走（原实现每个片段算一个命中，`log('测试')` 显示 1/4 且 ↓ 在片段间逐字移动）；current 高亮覆盖该命中的全部片段
- 目录树左对齐：子节点不再向右缩进（#file-tree ul 的 padding-left 16px → 0，根级 4px 保留）——所有层级文字左边界对齐，层级只靠展开三角区分
- 验证：[dev:search5-5c] 跨节点命中归组断言（marks=4 片段 / count=1/2、↓ 跳第二个完整命中的首片段、再 ↓ 回绕）；[dev:check1] treeIndents 断言（根 4px / 嵌套全 0px）

## 已知限制（1.1）

- BOM 丢失：读文件按 utf8 解码，带 BOM 的 md 保存后 BOM 不保留（内容不变）
- 跨目录旧 tab 只读：换目录后旧 tab 仍可看缓存内容，保存被 isInside 拒绝并回显错误
- 不监听文件系统变化：外部修改文件需重开
- 不支持内联 HTML（安全起见全部转义）

## 明确不做（留作后续）

- md 相对链接跳转（点 `[xxx](other.md)` 打开对应文件）
- 全文搜索（跨文件）
- 更多风格（GitLab/MDN/Logseq/学术论文/思源宋体/报纸等）

## 风险与前提

1. Node 已装（v24.20.0 LTS）。开发脚本里可用全路径 `C:\Program Files\nodejs\node.exe` 兜底；Bash 会话需 `export PATH="/c/Program Files/nodejs:$PATH"`
2. 大目录扫描：异步 + 只收 md；实测卡顿再做懒加载
3. Windows 长路径/无权限文件：扫描时 try/catch 跳过读不了的项
4. 开发验证钩子（TOT_* 环境变量 + [dev:*] 断言输出）保留在 main.js dev 块中，不进入打包版路径
