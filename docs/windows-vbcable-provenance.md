# Updating the bundled VB-CABLE driver

SoundDeck Studio's per-machine Windows installer can run the bundled VB-CABLE setup with administrator privileges. Treat every driver-pack update as a supply-chain change.

The reviewed input is recorded in `build/vbcable-provenance.json`. The current package is `VBCABLE_Driver_Pack45.zip`, released in October 2024, with driver version 3.3.1.7. VB-Audio's public release materials identify the package and version but do not publish a checksum, so a new checksum must not be accepted from the download endpoint alone.

## Review procedure

1. Start from the [official VB-CABLE product page](https://vb-audio.com/Cable/). Follow its current download link instead of guessing a package URL. Record the package label, release date, version, final HTTPS URL, and review date.
2. Download the candidate into a fresh quarantine directory on a Windows review machine. Do not execute either setup program. Compare the archive SHA-256 through at least one independent source or network path and scan the candidate using the project's normal malware-review service.
3. Extract the candidate only after recording its archive digest. Reject unexpected paths, directories, or file inventory changes until they are explained.
4. Record the SHA-256 of `VBCABLE_Setup_x64.exe`. Verify all Authenticode signatures and the timestamp:

   ```powershell
   Get-FileHash .\VBCABLE_Setup_x64.exe -Algorithm SHA256
   Get-AuthenticodeSignature -LiteralPath .\VBCABLE_Setup_x64.exe | Format-List *
   signtool verify /pa /all /v /tw .\VBCABLE_Setup_x64.exe
   ```

   The signature must be valid and timestamped. The approved legal identity is currently `BUREL VINCENT Entrepreneur individuel`, business identifier `423 734 177`; [VB-Audio's legal page](https://vb-audio.com/Services/PrivacyPolicy.htm) identifies Vincent Burel and the matching business registration. `VB-AUDIO Software` in the file's version metadata is not a signing identity. A signer, business identifier, issuer, timestamp, or algorithm change requires manual review. Microsoft documents the structured [`Get-AuthenticodeSignature`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature) result and why a [trusted timestamp preserves verification after certificate expiry](https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures).
5. Verify the Windows 10/11 x64 driver catalog and its membership before approving the new package:

   ```powershell
   signtool verify /kp /all /v /tw .\vbaudio_cable64_win10.cat
   signtool verify /kp /c .\vbaudio_cable64_win10.cat .\vbMmeCable64_win10.inf
   signtool verify /kp /c .\vbaudio_cable64_win10.cat .\vbaudio_cable64_win10.sys
   ```

6. Update `build/vbcable-provenance.json`. Record the SHA-256 of every extracted file; package-time and installer-time re-verification require that exact inventory and reject extra files, directories, and reparse points before the setup helper runs. Update the approved manifest digest in `build/verify-vbcable.ps1`. Keep the signer name and business identifier pinned in the verifier rather than loading them from the adjacent manifest.
7. On Windows, run `node scripts/fetch-vbcable.mjs`, `node scripts/verify-vbcable.mjs`, the test suite, and an unpublished NSIS build. These steps verify and package the driver but do not install it.
8. Test actual driver installation only in a disposable Windows VM. Confirm the missing-driver, already-installed, helper-failure, signature-failure, `/D` non-default-path, update, and reboot flows. The UI hides custom install paths, but NSIS can still accept `/D`; the security boundary must remain independent of `$INSTDIR`.

Do not commit the driver archive or extracted binaries. `build/vbcable/` remains ignored and is rebuilt from a fresh download every time; a pre-existing directory is deleted without being read. Confirm that the project's VB-Audio redistribution permission still covers the new release before publishing it.
