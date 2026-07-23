param(
  [Parameter(Mandatory = $true)]
  [string] $FilePath,

  [Parameter(Mandatory = $true)]
  [string] $ManifestPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
  throw "The verified VB-CABLE setup helper is missing."
}
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw "The VB-CABLE provenance manifest is missing."
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.package -cne "VBCABLE_Driver_Pack45") {
  throw "The VB-CABLE provenance manifest is not approved."
}
if ($manifest.setup.file -cne "VBCABLE_Setup_x64.exe") {
  throw "The VB-CABLE setup filename is not approved."
}
$payloadDirectory = Split-Path -Parent $FilePath

foreach ($fileProperty in $manifest.files.PSObject.Properties) {
  $fileName = $fileProperty.Name
  $expectedSha256 = [string] $fileProperty.Value
  if ([System.IO.Path]::GetFileName($fileName) -cne $fileName -or $expectedSha256 -notmatch "^[a-f0-9]{64}$") {
    throw "The VB-CABLE provenance manifest contains an unsafe file entry."
  }
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

$signature = Get-AuthenticodeSignature -LiteralPath $FilePath
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
if ($simpleName -cne $manifest.setup.authenticodeSimpleName) {
  throw "VB-CABLE Authenticode signer is not approved."
}
$escapedBusinessId = [Regex]::Escape($manifest.setup.authenticodeBusinessId)
if ($signature.SignerCertificate.Subject -notmatch "(^|,\s*)SERIALNUMBER=$escapedBusinessId(,|$)") {
  throw "VB-CABLE Authenticode signer identity is not approved."
}

Write-Output "VB-CABLE package hashes and Authenticode identity are valid."
