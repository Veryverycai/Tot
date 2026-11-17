; 安装新版前：结束正在运行的旧版 Tot 并静默卸载旧 Electron 版（先卸载再安装，控制面板始终一个卸载项）
; 移植自 Electron 时代的 build/installer.nsh customInit
!macro NSIS_HOOK_PREINSTALL
  ; 结束所有运行中的 Tot 进程（镜像名匹配不区分大小写：安装版 tot.exe 与同名绿色版都会结束，避免文件占用）
  nsExec::Exec 'taskkill /F /IM "Tot.exe"'
  Sleep 500
  ; 枚举 HKCU 卸载注册表项，找到 DisplayName 以「Tot 」开头的旧 Electron 版并静默卸载
  ;（electron-builder 注册为「Tot 1.2.8」带版本号；Tauri 新版注册为「Tot」不带空格后缀，不会误卸载自己）
  ; 卸载会删除该注册键导致索引前移，故卸载一个后从头重新枚举
  StrCpy $0 0
  uninstallLoop:
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" uninstallDone
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    StrCpy $4 $2 4
    StrCmp $4 "Tot " uninstallNow
    Goto nextKey
  uninstallNow:
    ReadRegStr $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "QuietUninstallString"
    StrCmp $3 "" nextKey
    ExecWait '$3'
    StrCpy $0 0
    Goto uninstallLoop
  nextKey:
    IntOp $0 $0 + 1
    Goto uninstallLoop
  uninstallDone:
  ; 用户若曾以「打开方式 → Tot.exe」关联 .md/.markdown（UserChoice=Applications\Tot.exe），
  ; 该 ProgId 的 command 仍指旧路径（旧安装目录/绿色版目录）：改写为新装路径，升级后双击无缝切换。
  ; UserChoice 本身带哈希保护不可改写，更新其指向的 ProgId 命令即可；
  ; 仅当 UserChoice 确为 Applications\Tot.exe 时才动，不劫持用户选的其他默认应用（VSCode 等）
  ReadRegStr $5 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice" "ProgId"
  StrCmp $5 "Applications\Tot.exe" fixAppCmd
  ReadRegStr $5 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\UserChoice" "ProgId"
  StrCmp $5 "Applications\Tot.exe" fixAppCmd hookDone
  fixAppCmd:
  WriteRegStr HKCU "Software\Classes\Applications\Tot.exe\shell\open\command" "" '"$INSTDIR\tot.exe" "%1"'
  hookDone:
!macroend