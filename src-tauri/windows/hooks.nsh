; filo NSIS hook: after installation, file associations use the
; "document" icon (doc.ico) instead of the app icon. The progid is
; read from the registry, so we don't depend on how Tauri builds it.

!macro FILO_SET_DOC_ICON EXT
  ReadRegStr $0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $0 != ""
    WriteRegStr SHCTX "Software\Classes\$0\DefaultIcon" "" "$INSTDIR\icons\doc.ico"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  !insertmacro FILO_SET_DOC_ICON "txt"
  !insertmacro FILO_SET_DOC_ICON "log"
  !insertmacro FILO_SET_DOC_ICON "md"
  !insertmacro FILO_SET_DOC_ICON "csv"
  !insertmacro FILO_SET_DOC_ICON "json"
  !insertmacro FILO_SET_DOC_ICON "xml"
  !insertmacro FILO_SET_DOC_ICON "svg"
  !insertmacro FILO_SET_DOC_ICON "xaml"
  !insertmacro FILO_SET_DOC_ICON "filo"
  Pop $0
  ; SHCNE_ASSOCCHANGED: Explorer reloads the icon cache
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
