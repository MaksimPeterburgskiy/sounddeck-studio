!include "LogicLib.nsh"
!include "x64.nsh"

!define SOUNDDECK_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define SOUNDDECK_PROFILE_LIST_KEY "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList"
!define SOUNDDECK_DIRECTORY_LOCK_ACCESS 0x000C0080
!define SOUNDDECK_DIRECTORY_OPEN_FLAGS 0x02200000
!define SOUNDDECK_PROTECTED_SECURITY_INFORMATION 0x80000007

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

      ; Lock and validate NSIS's private directory before changing its security.
      ; Share-read only makes this fail if another process already holds a
      ; write/delete handle. OPEN_REPARSE_POINT lets us reject redirected paths.
      System::Call 'kernel32::CreateFileW(w "$PLUGINSDIR", i ${SOUNDDECK_DIRECTORY_LOCK_ACCESS}, i 1, p 0, i 3, i ${SOUNDDECK_DIRECTORY_OPEN_FLAGS}, p 0) p.r6 ?e'
      Pop $5
      ${If} $6 == -1
        DetailPrint "Could not lock the NSIS private directory (Windows error $5)."
        Abort
      ${EndIf}
      System::Alloc 52
      Pop $8
      System::Call 'kernel32::GetFileInformationByHandle(p r6, p r8) i.r0 ?e'
      Pop $5
      ${If} $0 == 0
        System::Free $8
        DetailPrint "Could not validate the NSIS private directory (Windows error $5)."
        Abort
      ${EndIf}
      System::Call '*$8(i.r9)'
      System::Free $8
      IntOp $0 $9 & 0x10
      IntOp $1 $9 & 0x400
      ${If} $0 == 0
      ${OrIf} $1 != 0
        DetailPrint "The NSIS private path is not a real directory."
        Abort
      ${EndIf}

      ; Create the private root atomically with its final protected DACL. This
      ; rejects a path won by another process instead of adopting its explicit
      ; ACEs. SY = SYSTEM, BA = built-in Administrators, D:P = protected DACL.
      System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", i 1, *p .r2, p 0) i.r0 ?e'
      Pop $1
      ${If} $0 == 0
        DetailPrint "Could not build protected VB-CABLE staging permissions (Windows error $1)."
        Abort
      ${EndIf}

      ; Replace the NSIS parent owner, group, and entire DACL through the held
      ; handle. The protected flag prevents user-temp inheritance.
      System::Call 'advapi32::GetSecurityDescriptorOwner(p r2, *p .R0, *i .R1) i.r0'
      ${If} $0 == 0
        DetailPrint "Could not read the protected VB-CABLE staging owner."
        Abort
      ${EndIf}
      System::Call 'advapi32::GetSecurityDescriptorGroup(p r2, *p .R2, *i .R3) i.r0'
      ${If} $0 == 0
        DetailPrint "Could not read the protected VB-CABLE staging group."
        Abort
      ${EndIf}
      System::Call 'advapi32::GetSecurityDescriptorDacl(p r2, *i .R4, *p .R5, *i .R6) i.r0'
      ${If} $0 == 0
      ${OrIf} $R4 == 0
        DetailPrint "Could not read the protected VB-CABLE staging DACL."
        Abort
      ${EndIf}
      System::Call 'advapi32::SetSecurityInfo(p r6, i 1, i ${SOUNDDECK_PROTECTED_SECURITY_INFORMATION}, p R0, p R2, p R5, p 0) i.r0'
      ${If} $0 != 0
        DetailPrint "Could not protect the NSIS private directory (Windows error $0)."
        Abort
      ${EndIf}

      ; Replace the initial lock with a no-delete-share handle that still lets
      ; the elevated installer create children. Keep it through driver exit.
      System::Call 'kernel32::CreateFileW(w "$PLUGINSDIR", i 0, i 3, p 0, i 3, i ${SOUNDDECK_DIRECTORY_OPEN_FLAGS}, p 0) p.r7 ?e'
      Pop $5
      ${If} $7 == -1
        DetailPrint "Could not retain the protected NSIS private directory (Windows error $5)."
        Abort
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p r6)'
      StrCpy $6 $7

      ; electron-builder's NSIS executable is 32-bit, so SECURITY_ATTRIBUTES is
      ; 12 bytes: DWORD, pointer, BOOL.
      System::Call '*(i 12, p r2, i 0) p.r3'
      System::Call 'kernel32::CreateDirectoryW(w "$PLUGINSDIR\vbcable", p r3) i.r4 ?e'
      Pop $5
      System::Free $3
      System::Call 'kernel32::LocalFree(p r2)'
      ${If} $4 == 0
        DetailPrint "Could not create a fresh protected VB-CABLE staging directory (Windows error $5). A pre-existing directory is rejected."
        Abort
      ${EndIf}

      ; Hold the newly created root without delete sharing as a second guard
      ; against rename or replacement until the setup process has exited.
      System::Call 'kernel32::CreateFileW(w "$PLUGINSDIR\vbcable", i 0, i 3, p 0, i 3, i ${SOUNDDECK_DIRECTORY_OPEN_FLAGS}, p 0) p.r7 ?e'
      Pop $5
      ${If} $7 == -1
        DetailPrint "Could not retain the protected VB-CABLE staging directory (Windows error $5)."
        Abort
      ${EndIf}
      System::Alloc 52
      Pop $8
      System::Call 'kernel32::GetFileInformationByHandle(p r7, p r8) i.r0 ?e'
      Pop $5
      ${If} $0 == 0
        System::Free $8
        DetailPrint "Could not validate the protected VB-CABLE staging directory (Windows error $5)."
        Abort
      ${EndIf}
      System::Call '*$8(i.r9)'
      System::Free $8
      IntOp $0 $9 & 0x10
      IntOp $1 $9 & 0x400
      ${If} $0 == 0
      ${OrIf} $1 != 0
        DetailPrint "The protected VB-CABLE staging path is not a real directory."
        Abort
      ${EndIf}

      nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$PLUGINSDIR\vbcable" /setintegritylevel "(OI)(CI)H"'
      Pop $0
      Pop $1
      ${If} $0 != 0
        DetailPrint "Could not set high-integrity VB-CABLE staging permissions: $1"
        Abort
      ${EndIf}

      ; Keep vendor files alone in payload so the verifier can require an exact
      ; inventory. PROVENANCE.json is build audit metadata, not vendor content.
      SetOutPath "$PLUGINSDIR\vbcable\payload"
      File /r /x "PROVENANCE.json" "${BUILD_RESOURCES_DIR}\vbcable\*"
      SetOutPath "$PLUGINSDIR\vbcable"
      File /oname=verify-vbcable.ps1 "${BUILD_RESOURCES_DIR}\verify-vbcable.ps1"
      File /oname=vbcable-provenance.json "${BUILD_RESOURCES_DIR}\vbcable-provenance.json"

      DetailPrint "Reverifying VB-CABLE immediately before elevated execution..."
      nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\vbcable\verify-vbcable.ps1" -FilePath "$PLUGINSDIR\vbcable\payload\VBCABLE_Setup_x64.exe" -ManifestPath "$PLUGINSDIR\vbcable\vbcable-provenance.json"'
      Pop $0
      Pop $1
      ${If} $0 != 0
        DetailPrint "VB-CABLE verification failed (exit code $0): $1"
        MessageBox MB_ICONSTOP|MB_OK "SoundDeck Studio refused to run the bundled audio driver because its integrity or publisher could not be verified. Installation will stop without running the driver."
        Abort
      ${EndIf}

      DetailPrint "Running the verified VB-CABLE setup in hidden install mode."
      ClearErrors
      ExecWait '"$PLUGINSDIR\vbcable\payload\VBCABLE_Setup_x64.exe" -i -h' $0
      ${If} ${Errors}
        StrCpy $1 1
      ${Else}
        StrCpy $1 0
      ${EndIf}
      ; The helper has exited, so replacement can no longer change what ran.
      System::Call 'kernel32::CloseHandle(p r7)'
      System::Call 'kernel32::CloseHandle(p r6)'
      ${If} $1 == 1
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
