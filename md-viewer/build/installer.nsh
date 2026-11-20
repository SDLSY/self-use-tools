!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "MUI2.nsh"
!ifndef BUILD_UNINSTALLER
Var AssociateCheckbox
Var AssociateState

; Capture the existing choice before an older uninstaller removes its keys.
!macro customInit
  ReadRegStr $0 HKCU "Software\Classes\MoYue.Markdown\shell\open\command" ""
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice" "ProgId"
  ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\UserChoice" "ProgId"
  ${If} $0 != ""
  ${OrIf} $1 == "MoYue.Markdown"
  ${OrIf} $2 == "MoYue.Markdown"
    StrCpy $AssociateState ${BST_CHECKED}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom AssociationPage AssociationLeave
!macroend

Function AssociationPage
  !insertmacro MUI_HEADER_TEXT "文件关联（可选）" "选择是否将墨阅添加为 Markdown 的打开程序。"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "墨阅支持编辑与预览 Markdown 文件。Windows 可能要求您在设置中确认默认应用。"
  Pop $0
  ${NSD_CreateCheckbox} 0 48u 100% 18u "关联 .md 和 .markdown 文件"
  Pop $AssociateCheckbox
  ${If} $AssociateState == ${BST_CHECKED}
    ${NSD_Check} $AssociateCheckbox
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function AssociationLeave
  ${NSD_GetState} $AssociateCheckbox $AssociateState
FunctionEnd

!macro customInstall
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/ASSOC=" $1
  ${IfNot} ${Errors}
    ${If} $1 == "1"
      StrCpy $AssociateState ${BST_CHECKED}
    ${EndIf}
  ${EndIf}
  ${If} $AssociateState == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Classes\MoYue.Markdown" "" "Markdown 文档（墨阅）"
    WriteRegStr HKCU "Software\Classes\MoYue.Markdown\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
    WriteRegStr HKCU "Software\Classes\MoYue.Markdown\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    WriteRegStr HKCU "Software\Classes\.md\OpenWithProgids" "MoYue.Markdown" ""
    WriteRegStr HKCU "Software\Classes\.markdown\OpenWithProgids" "MoYue.Markdown" ""
    WriteRegStr HKCU "Software\MoYue\Capabilities" "ApplicationName" "墨阅"
    WriteRegStr HKCU "Software\MoYue\Capabilities" "ApplicationDescription" "本地 Markdown 编辑与预览"
    WriteRegStr HKCU "Software\MoYue\Capabilities\FileAssociations" ".md" "MoYue.Markdown"
    WriteRegStr HKCU "Software\MoYue\Capabilities\FileAssociations" ".markdown" "MoYue.Markdown"
    WriteRegStr HKCU "Software\RegisteredApplications" "MoYue" "Software\MoYue\Capabilities"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend

!endif
!macro customUnInstall
  ; Upgrades run the old uninstaller too. Keep the registered Windows choice
  ; valid throughout an upgrade; only a real uninstall should remove it.
  ${IfNot} ${isUpdated}
  DeleteRegKey HKCU "Software\Classes\MoYue.Markdown"
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "MoYue.Markdown"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "MoYue.Markdown"
  DeleteRegValue HKCU "Software\RegisteredApplications" "MoYue"
  DeleteRegKey HKCU "Software\MoYue"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
