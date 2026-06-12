!include "LogicLib.nsh"
!include "x64.nsh"

; Install the bundled VB-Audio Virtual Cable driver if it is not present yet.
; VBCABLE_Setup_x64.exe flags: -i = install, -h = hidden (no UI).
!macro customInstall
  ${DisableX64FSRedirection}
  ${If} ${FileExists} "$SYSDIR\drivers\vbaudio_cable64_win10.sys"
  ${OrIf} ${FileExists} "$SYSDIR\drivers\vbaudio_cable64_win7.sys"
    DetailPrint "VB-Audio Virtual Cable already installed, skipping."
  ${Else}
    DetailPrint "Installing VB-Audio Virtual Cable driver..."
    ExecWait '"$INSTDIR\resources\vbcable\VBCABLE_Setup_x64.exe" -i -h' $0
    DetailPrint "VB-Cable setup finished (exit code $0)."
  ${EndIf}
  ${EnableX64FSRedirection}
!macroend
