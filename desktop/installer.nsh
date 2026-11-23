; 卸载时去掉开机自启（升级时保留）。数据和设置在 %APPDATA%\com.tiangong.feedback，卸载不删除。
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.tiangong.feedback"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.tiangong.feedback"
  ${endIf}
!macroend
