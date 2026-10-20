; 安装新版前：结束正在运行的旧版 Tot 并静默卸载（先卸载再安装，控制面板始终一个卸载项）
!macro customInit
  ; 结束安装版进程（精确镜像名，不误杀便携版 Tot 1.x.exe）
  nsExec::Exec 'taskkill /F /IM "Tot.exe"'
  Sleep 500
  ; 枚举 HKCU 卸载注册表项，找到 DisplayName 以「Tot 」开头的旧版并静默卸载
  ;（electron-builder 注册为「Tot 1.1.3」带版本号，不能用精确匹配）
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
!macroend
