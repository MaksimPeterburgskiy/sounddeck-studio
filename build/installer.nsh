!include "LogicLib.nsh"
!include "x64.nsh"

!define SOUNDDECK_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define SOUNDDECK_PROFILE_LIST_KEY "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList"

!macro DeleteSoundDeckStartupValues ROOT_KEY RUN_KEY
  DeleteRegValue ${ROOT_KEY} "${RUN_KEY}" "SoundDeck Studio"
  ; Clean up possible names used by earlier builds before the startup item
  ; name was made explicit in app.setLoginItemSettings().
  DeleteRegValue ${ROOT_KEY} "${RUN_KEY}" "com.sounddeck.studio"
  DeleteRegValue ${ROOT_KEY} "${RUN_KEY}" "sounddeck-studio"
!macroend

; Expand the install log by default so users can watch what is happening,
; and recolor it to match the app theme (lime text on charcoal).
!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
  !ifdef MUI_INSTFILESPAGE_COLORS
    !undef MUI_INSTFILESPAGE_COLORS
  !endif
  !define MUI_INSTFILESPAGE_COLORS "C6F12E 0A0B0D"
!macroend

; Install the reviewed VB-Audio Virtual Cable driver on a first install only.
; electron-builder embeds the verified payload directly into NSIS. It is
; extracted to NSIS's restricted private directory, reverified there, and
; never copied to the user-selected application tree or portable build.
; VBCABLE_Setup_x64.exe flags: -i = install, -h = hidden (no app UI).
!macro customInstall
  SetDetailsPrint both
  DetailPrint "Checking bundled driver prerequisites..."
  ${IfNot} ${isUpdated}
    ${DisableX64FSRedirection}
    ; The driver service key exists whenever VB-Cable is installed, even when the
    ; .sys file lives only in the DriverStore rather than System32\drivers.
    ClearErrors
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\VBAudioVACMME" "ImagePath"
    ${IfNot} ${Errors}
    ${OrIf} ${FileExists} "$SYSDIR\drivers\vbaudio_cable64_win10.sys"
    ${OrIf} ${FileExists} "$SYSDIR\drivers\vbaudio_cable64_win7.sys"
      DetailPrint "VB-Audio Virtual Cable already installed, skipping."
    ${Else}
      DetailPrint "Preparing the reviewed VB-CABLE driver package..."
      InitPluginsDir
      CreateDirectory "$PLUGINSDIR\vbcable"

      ; Lock the private directory before extracting any executable content.
      ; Numeric SIDs avoid localized account names:
      ; S-1-5-18 = SYSTEM, S-1-5-32-544 = built-in Administrators.
      nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$PLUGINSDIR\vbcable" /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"'
      Pop $0
      Pop $1
      ${If} $0 != 0
        DetailPrint "Could not grant protected VB-CABLE staging permissions: $1"
        Abort
      ${EndIf}
      nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$PLUGINSDIR\vbcable" /setowner "*S-1-5-32-544"'
      Pop $0
      Pop $1
      ${If} $0 != 0
        DetailPrint "Could not protect VB-CABLE staging ownership: $1"
        Abort
      ${EndIf}
      nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$PLUGINSDIR\vbcable" /inheritance:r'
      Pop $0
      Pop $1
      ${If} $0 != 0
        DetailPrint "Could not finalize protected VB-CABLE staging permissions: $1"
        Abort
      ${EndIf}
      nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$PLUGINSDIR\vbcable" /setintegritylevel "(OI)(CI)H"'
      Pop $0
      Pop $1
      ${If} $0 != 0
        DetailPrint "Could not set high-integrity VB-CABLE staging permissions: $1"
        Abort
      ${EndIf}

      SetOutPath "$PLUGINSDIR\vbcable"
      File /r "${BUILD_RESOURCES_DIR}\vbcable\*"
      File /oname=verify-vbcable.ps1 "${BUILD_RESOURCES_DIR}\verify-vbcable.ps1"
      File /oname=vbcable-provenance.json "${BUILD_RESOURCES_DIR}\vbcable-provenance.json"

      DetailPrint "Reverifying VB-CABLE immediately before elevated execution..."
      nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\vbcable\verify-vbcable.ps1" -FilePath "$PLUGINSDIR\vbcable\VBCABLE_Setup_x64.exe" -ManifestPath "$PLUGINSDIR\vbcable\vbcable-provenance.json"'
      Pop $0
      Pop $1
      ${If} $0 != 0
        DetailPrint "VB-CABLE verification failed (exit code $0): $1"
        MessageBox MB_ICONSTOP|MB_OK "SoundDeck Studio refused to run the bundled audio driver because its integrity or publisher could not be verified. Installation will stop without running the driver."
        Abort
      ${EndIf}

      DetailPrint "Running the verified VB-CABLE setup in hidden install mode."
      ClearErrors
      ExecWait '"$PLUGINSDIR\vbcable\VBCABLE_Setup_x64.exe" -i -h' $0
      ${If} ${Errors}
        DetailPrint "VB-CABLE setup could not be started."
        MessageBox MB_ICONSTOP|MB_OK "SoundDeck Studio could not start the verified VB-CABLE driver setup. Installation will stop."
        Abort
      ${ElseIf} $0 != 0
        DetailPrint "VB-CABLE setup failed with exit code $0."
        MessageBox MB_ICONSTOP|MB_OK "The verified VB-CABLE driver setup failed with exit code $0. Installation will stop."
        Abort
      ${Else}
        DetailPrint "VB-CABLE setup finished successfully."
      ${EndIf}
    ${EndIf}
    ${EnableX64FSRedirection}
  ${Else}
    DetailPrint "Application update detected; bundled driver setup is not run during updates."
  ${EndIf}
  DetailPrint "Installer tasks finished."
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    !insertmacro DeleteSoundDeckStartupValues HKCU "${SOUNDDECK_RUN_KEY}"

    StrCpy $0 0
    ${Do}
      ClearErrors
      EnumRegKey $1 HKU "" $0
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      ${If} $1 == ""
        ${Break}
      ${EndIf}
      !insertmacro DeleteSoundDeckStartupValues HKU "$1\${SOUNDDECK_RUN_KEY}"
      IntOp $0 $0 + 1
    ${Loop}

    StrCpy $0 0
    ${Do}
      ClearErrors
      EnumRegKey $1 HKLM "${SOUNDDECK_PROFILE_LIST_KEY}" $0
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      ${If} $1 == ""
        ${Break}
      ${EndIf}

      ClearErrors
      EnumRegKey $3 HKU "$1" 0
      ${If} ${Errors}
        ReadRegStr $2 HKLM "${SOUNDDECK_PROFILE_LIST_KEY}\$1" "ProfileImagePath"
        ExpandEnvStrings $2 "$2"
        ${If} ${FileExists} "$2\NTUSER.DAT"
          StrCpy $3 "SoundDeckUninstall$0"
          ExecWait 'reg.exe unload "HKU\$3"' $4
          ExecWait 'reg.exe load "HKU\$3" "$2\NTUSER.DAT"' $4
          ${If} $4 == 0
            !insertmacro DeleteSoundDeckStartupValues HKU "$3\${SOUNDDECK_RUN_KEY}"
            ExecWait 'reg.exe unload "HKU\$3"' $4
          ${EndIf}
        ${EndIf}
      ${EndIf}
      IntOp $0 $0 + 1
    ${Loop}
  ${EndIf}
!macroend
