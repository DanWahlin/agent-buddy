; Hooks for the NSIS installer that Tauri builds (bundle.windows.nsis.installerHooks).
;
; The app was named Agent Companion before it became Agent Buddy, and the product
; name sets the install folder and the uninstall entry. So an update removes the
; Agent Companion install first, as its own uninstaller does when run silently:
; that keeps the app data, removes its shortcuts and entry, and its hook stops
; the companion service. Without this, the update would leave a second app.
;
; The companion service starts at sign-in through this app's program with
; --companion-service (src/launcher.rs), and the Run registry value names it.
; Stop it before the program is replaced or removed. On uninstall, remove the
; Run value too, when it names this program. Opening the app again installs it.

!define AC_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define AC_RUN_VALUE "ESP32 Agent Companion"
!define AC_OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Agent Companion"

!macro AC_REMOVE_RENAMED_INSTALL
  Push $R5
  Push $R6
  Push $R7
  ; The quoted path of the old uninstall.exe.
  ReadRegStr $R7 SHCTX "${AC_OLD_UNINSTKEY}" "UninstallString"
  ${If} $R7 != ""
    StrCpy $R5 $R7 1
    ${If} $R5 == '"'
      StrCpy $R7 $R7 "" 1
      StrCpy $R7 $R7 -1
    ${EndIf}
    ${GetParent} $R7 $R6
    ${If} ${FileExists} $R7
    ${AndIf} $R6 != $INSTDIR
      ClearErrors
      ; _?= runs it in place, so this waits for it; it can't remove itself then.
      ExecWait '"$R7" /S _?=$R6' $R5
      ${IfNot} ${Errors}
      ${AndIf} $R5 = 0
        ; Windows can keep the uninstaller locked for a short time after it exits.
        StrCpy $R5 0
        ${Do}
          ClearErrors
          Delete "$R7"
          ${IfNot} ${Errors}
          ${OrIf} $R5 >= 40
            ${Break}
          ${EndIf}
          IntOp $R5 $R5 + 1
          Sleep 250
        ${Loop}
        RMDir "$R6"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $R7
  Pop $R6
  Pop $R5
!macroend

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
  !insertmacro AC_REMOVE_RENAMED_INSTALL
  !insertmacro AC_STOP_SERVICE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AC_STOP_SERVICE
  ${If} $R9 == '"$INSTDIR\${MAINBINARYNAME}.exe" --companion-service'
    DeleteRegValue HKCU "${AC_RUN_KEY}" "${AC_RUN_VALUE}"
  ${EndIf}
!macroend
