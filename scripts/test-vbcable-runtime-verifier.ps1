param(
  [Parameter(Mandatory = $true)]
  [string] $PayloadDirectory
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceManifest = Join-Path $repoRoot "build\vbcable-provenance.json"
$sourceVerifier = Join-Path $repoRoot "build\verify-vbcable.ps1"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sounddeck-vbcable-verifier-" + [Guid]::NewGuid().ToString("N"))
$testPayload = Join-Path $testRoot "payload"
$testManifest = Join-Path $testRoot "vbcable-provenance.json"
$testVerifier = Join-Path $testRoot "verify-vbcable.ps1"
$hostileModule = Join-Path $testRoot "user-modules\Microsoft.PowerShell.Security"
$originalModulePath = $env:PSModulePath

function Invoke-ExpectedFailure {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Scenario
  )

  $failed = $false
  try {
    & $testVerifier `
      -FilePath (Join-Path $testPayload "VBCABLE_Setup_x64.exe") `
      -ManifestPath $testManifest | Out-Null
  } catch {
    $failed = $true
  }
  if (-not $failed) {
    throw "Runtime verifier unexpectedly accepted $Scenario."
  }
}

try {
  New-Item -ItemType Directory -Path $testPayload | Out-Null
  New-Item -ItemType Directory -Path $hostileModule | Out-Null
  Get-ChildItem -LiteralPath $PayloadDirectory -Force |
    Where-Object { $_.Name -cne "PROVENANCE.json" } |
    Copy-Item -Destination $testPayload -Recurse
  Copy-Item -LiteralPath $sourceManifest -Destination $testManifest
  Copy-Item -LiteralPath $sourceVerifier -Destination $testVerifier

  @'
function Get-AuthenticodeSignature {
  throw "A user-writable PowerShell module was loaded."
}
Export-ModuleMember -Function Get-AuthenticodeSignature
'@ | Set-Content -LiteralPath (Join-Path $hostileModule "Microsoft.PowerShell.Security.psm1") -Encoding UTF8

  $env:PSModulePath = Split-Path -Parent $hostileModule
  & $testVerifier `
    -FilePath (Join-Path $testPayload "VBCABLE_Setup_x64.exe") `
    -ManifestPath $testManifest | Out-Null

  $tamperedManifest = Get-Content -LiteralPath $testManifest -Raw | ConvertFrom-Json
  $tamperedManifest.setup.authenticodeSimpleName = "Unapproved Publisher"
  $tamperedManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $testManifest -Encoding UTF8
  Invoke-ExpectedFailure -Scenario "a tampered provenance manifest"

  Copy-Item -LiteralPath $sourceManifest -Destination $testManifest -Force
  Set-Content -LiteralPath (Join-Path $testPayload "unexpected.dll") -Value "unreviewed companion"
  Invoke-ExpectedFailure -Scenario "an unlisted package companion"

  Remove-Item -LiteralPath (Join-Path $testPayload "unexpected.dll") -Force
  Add-Content -LiteralPath (Join-Path $testPayload "readme.txt") -Value "tampered"
  Invoke-ExpectedFailure -Scenario "a tampered package companion"
} finally {
  $env:PSModulePath = $originalModulePath
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "VB-CABLE runtime verifier rejected module, manifest, inventory, and payload tampering."
