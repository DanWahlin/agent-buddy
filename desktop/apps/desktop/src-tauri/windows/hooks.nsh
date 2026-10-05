; Hooks for the NSIS installer that Tauri builds (bundle.windows.nsis.installerHooks).
;
; The companion service starts at sign-in through this app's program with
; --companion-service (src/launcher.rs), and the Run registry value names it.
; Stop it before the program is replaced or removed. On uninstall, remove the
; Run value too, when it names this program. Opening the app again installs it.

!define AC_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define AC_RUN_VALUE "ESP32 Agent Companion"

!macro AC_STOP_SERVICE
  ReadRegStr $R9 HKCU "${AC_RUN_KEY}" "${AC_RUN_VALUE}"
  ${If} $R9 == ""
  ${OrIf} $R9 == '"$INSTDIR\${MAINBINARYNAME}.exe" --companion-service'
    ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --companion-service-stop'
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AC_STOP_SERVICE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AC_STOP_SERVICE
  ${If} $R9 == '"$INSTDIR\${MAINBINARYNAME}.exe" --companion-service'
    DeleteRegValue HKCU "${AC_RUN_KEY}" "${AC_RUN_VALUE}"
  ${EndIf}
!macroend
