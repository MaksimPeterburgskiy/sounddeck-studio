param(
  [Parameter(Mandatory = $true)]
  [string] $FilePath,

  [Parameter(Mandatory = $true)]
  [string] $ManifestPath
)

$ErrorActionPreference = "Stop"
$approvedManifestSha256 = "b9f2c0a55f8580933db455ce377c574a72e3f67a43c332b0437441af57b6ba07"
$approvedSimpleName = "BUREL VINCENT Entrepreneur individuel"
$approvedBusinessId = "423 734 177"

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
  throw "The verified VB-CABLE setup helper is missing."
}
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "The VB-CABLE provenance manifest is missing."
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $manifestText = [System.IO.File]::ReadAllText($ManifestPath, $utf8NoBom)
  $normalizedManifestText = $manifestText.Replace("`r`n", "`n").Replace("`r", "`n")
  $manifestHashBytes = $sha256.ComputeHash($utf8NoBom.GetBytes($normalizedManifestText))
} finally {
  $sha256.Dispose()
}
$actualManifestSha256 = ([System.BitConverter]::ToString($manifestHashBytes) -replace "-", "").ToLowerInvariant()
if ($actualManifestSha256 -cne $approvedManifestSha256) {
  throw "The VB-CABLE provenance manifest hash is not approved."
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.package -cne "VBCABLE_Driver_Pack45") {
  throw "The VB-CABLE provenance manifest is not approved."
}
if ($manifest.setup.file -cne "VBCABLE_Setup_x64.exe") {
  throw "The VB-CABLE setup filename is not approved."
}
$payloadDirectory = Split-Path -Parent $FilePath
$expectedFileNames = @()

foreach ($fileProperty in $manifest.files.PSObject.Properties) {
  $fileName = $fileProperty.Name
  $expectedSha256 = [string] $fileProperty.Value
  if ([System.IO.Path]::GetFileName($fileName) -cne $fileName -or $expectedSha256 -notmatch "^[a-f0-9]{64}$") {
    throw "The VB-CABLE provenance manifest contains an unsafe file entry."
  }
  $expectedFileNames += $fileName
}

$actualFiles = @(Get-ChildItem -LiteralPath $payloadDirectory -Force)
if ($actualFiles.Count -ne $expectedFileNames.Count) {
  throw "The staged VB-CABLE package file inventory is not approved."
}
foreach ($actualFile in $actualFiles) {
  if (
    $actualFile.PSIsContainer -or
    (($actualFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
    ($expectedFileNames -notcontains $actualFile.Name)
  ) {
    throw "The staged VB-CABLE package file inventory is not approved."
  }
}

foreach ($fileProperty in $manifest.files.PSObject.Properties) {
  $fileName = $fileProperty.Name
  $expectedSha256 = [string] $fileProperty.Value
  $payloadFile = Join-Path $payloadDirectory $fileName
  if (-not (Test-Path -LiteralPath $payloadFile -PathType Leaf)) {
    throw "A reviewed VB-CABLE package file is missing: $fileName"
  }

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($payloadFile)
    try {
      $hashBytes = $sha256.ComputeHash($stream)
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }
  $actualSha256 = ([System.BitConverter]::ToString($hashBytes) -replace "-", "").ToLowerInvariant()
  if ($actualSha256 -cne $expectedSha256) {
    throw "VB-CABLE package hash verification failed for $fileName."
  }
}

$systemSecurityModule = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
if (-not (Test-Path -LiteralPath $systemSecurityModule -PathType Leaf)) {
  throw "The system Authenticode verification module is missing."
}
$env:PSModulePath = Join-Path $PSHOME "Modules"
$PSModuleAutoLoadingPreference = "None"
Import-Module -Name $systemSecurityModule -Force -ErrorAction Stop
$signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $FilePath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "VB-CABLE Authenticode verification failed: $($signature.Status)."
}
if ($null -eq $signature.TimeStamperCertificate) {
  throw "VB-CABLE Authenticode signature has no trusted timestamp."
}
$simpleName = $signature.SignerCertificate.GetNameInfo(
  [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
  $false
)
if ($simpleName -cne $approvedSimpleName) {
  throw "VB-CABLE Authenticode signer is not approved."
}
$escapedBusinessId = [Regex]::Escape($approvedBusinessId)
if ($signature.SignerCertificate.Subject -notmatch "(^|,\s*)SERIALNUMBER=$escapedBusinessId(,|$)") {
  throw "VB-CABLE Authenticode signer identity is not approved."
}

Write-Output "VB-CABLE package hashes and Authenticode identity are valid."
