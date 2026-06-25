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

; Install the bundled VB-Audio Virtual Cable driver if it is not present yet.
; VBCABLE_Setup_x64.exe flags: -i = install, -h = hidden (no UI).
!macro customInstall
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
    DetailPrint "Installing VB-Audio Virtual Cable driver..."
    ExecWait '"$INSTDIR\resources\vbcable\VBCABLE_Setup_x64.exe" -i -h' $0
    DetailPrint "VB-Cable setup finished (exit code $0)."
  ${EndIf}
  ${EnableX64FSRedirection}
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

      StrCpy $2 $1 8
      ${If} $2 == "S-1-5-21"
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
      ${EndIf}
      IntOp $0 $0 + 1
    ${Loop}
  ${EndIf}
!macroend
