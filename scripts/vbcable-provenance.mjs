import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROVENANCE_FILENAME = "PROVENANCE.json";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateManifest(value) {
  if (!value || typeof value !== "object") throw new Error("VB-CABLE provenance manifest must be an object.");
  if (value.schemaVersion !== 1) throw new Error("Unsupported VB-CABLE provenance manifest schema.");
  if (!/^[A-Za-z0-9._-]+$/.test(value.package)) throw new Error("Invalid VB-CABLE package identifier.");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(value.driverVersion)) throw new Error("Invalid VB-CABLE driver version.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.reviewedAt)) throw new Error("Invalid VB-CABLE review date.");

  const sourcePage = new URL(value.sourcePage);
  const downloadUrl = new URL(value.url);
  if (sourcePage.protocol !== "https:" || sourcePage.hostname !== "vb-audio.com") {
    throw new Error("VB-CABLE source page must use the pinned vb-audio.com HTTPS origin.");
  }
  if (downloadUrl.protocol !== "https:" || downloadUrl.hostname !== "download.vb-audio.com") {
    throw new Error("VB-CABLE download must use the pinned download.vb-audio.com HTTPS origin.");
  }
  if (!SHA256_PATTERN.test(value.archiveSha256)) throw new Error("Invalid VB-CABLE archive SHA-256.");
  if (!Number.isSafeInteger(value.maximumArchiveBytes) || value.maximumArchiveBytes < 1) {
    throw new Error("Invalid VB-CABLE maximum archive size.");
  }

  const setup = value.setup;
  if (!setup || typeof setup !== "object") throw new Error("Missing VB-CABLE setup provenance.");
  if (setup.file !== "VBCABLE_Setup_x64.exe") throw new Error("Unexpected VB-CABLE setup filename.");
  if (!SHA256_PATTERN.test(setup.sha256)) throw new Error("Invalid VB-CABLE setup SHA-256.");
  if (typeof setup.authenticodeSimpleName !== "string" || !setup.authenticodeSimpleName) {
    throw new Error("Missing VB-CABLE Authenticode signer name.");
  }
  if (!/^\d{3} \d{3} \d{3}$/.test(setup.authenticodeBusinessId)) {
    throw new Error("Invalid VB-CABLE Authenticode business identifier.");
  }

  if (!value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error("Missing VB-CABLE file inventory.");
  }
  const fileEntries = Object.entries(value.files);
  if (fileEntries.length === 0 || !Object.hasOwn(value.files, setup.file)) {
    throw new Error("Invalid VB-CABLE file inventory.");
  }
  for (const [file, expectedSha256] of fileEntries) {
    if (path.basename(file) !== file || file === PROVENANCE_FILENAME) {
      throw new Error(`Unsafe VB-CABLE inventory entry: ${file}`);
    }
    if (!SHA256_PATTERN.test(expectedSha256)) throw new Error(`Invalid SHA-256 for VB-CABLE file: ${file}`);
  }
  if (value.files[setup.file] !== setup.sha256) {
    throw new Error("VB-CABLE setup digest does not match the file inventory.");
  }
  return value;
}

export async function loadManifest(manifestPath) {
  return validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
}

export async function verifyAuthenticode(filePath, setup) {
  if (process.platform !== "win32") {
    throw new Error("VB-CABLE Authenticode verification requires Windows.");
  }

  const script = String.raw`
$ErrorActionPreference = "Stop"
$signature = Get-AuthenticodeSignature -LiteralPath $env:SOUNDDECK_VBCABLE_FILE
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Authenticode status is $($signature.Status): $($signature.StatusMessage)"
}
if ($null -eq $signature.TimeStamperCertificate) {
  throw "Authenticode signature does not contain a trusted timestamp."
}
$simpleName = $signature.SignerCertificate.GetNameInfo(
  [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
  $false
)
if ($simpleName -cne $env:SOUNDDECK_VBCABLE_SIGNER) {
  throw "Unexpected Authenticode signer: $simpleName"
}
$escapedBusinessId = [Regex]::Escape($env:SOUNDDECK_VBCABLE_BUSINESS_ID)
if ($signature.SignerCertificate.Subject -notmatch "(^|,\s*)SERIALNUMBER=$escapedBusinessId(,|$)") {
  throw "Authenticode signer is missing the approved business identifier."
}
`;

  await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      env: {
        ...process.env,
        SOUNDDECK_VBCABLE_FILE: filePath,
        SOUNDDECK_VBCABLE_SIGNER: setup.authenticodeSimpleName,
        SOUNDDECK_VBCABLE_BUSINESS_ID: setup.authenticodeBusinessId
      }
    }
  );
}

export async function verifyPayload(payloadDir, manifest, options = {}) {
  const verifySignature = options.verifySignature ?? verifyAuthenticode;
  const entries = await readdir(payloadDir, { withFileTypes: true });
  const actualFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const expectedFiles = Object.keys(manifest.files).sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error(
      `VB-CABLE extracted file inventory mismatch.\nExpected: ${expectedFiles.join(", ")}\nActual: ${actualFiles.join(", ")}`
    );
  }
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error("VB-CABLE archive contains an unexpected directory or special entry.");
  }

  for (const file of expectedFiles) {
    const actualSha256 = sha256(await readFile(path.join(payloadDir, file)));
    if (actualSha256 !== manifest.files[file]) {
      throw new Error(
        `VB-CABLE file SHA-256 mismatch for ${file}. Expected ${manifest.files[file]}, got ${actualSha256}.`
      );
    }
  }
  const setupPath = path.join(payloadDir, manifest.setup.file);
  await verifySignature(setupPath, manifest.setup);
  return { setupPath, setupSha256: manifest.setup.sha256 };
}

export async function expandArchiveWithPowerShell(archivePath, destinationPath) {
  if (process.platform !== "win32") throw new Error("VB-CABLE archive extraction requires Windows.");
  const script = String.raw`
$ErrorActionPreference = "Stop"
Expand-Archive -LiteralPath $env:SOUNDDECK_VBCABLE_ARCHIVE -DestinationPath $env:SOUNDDECK_VBCABLE_DESTINATION
`;
  await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      env: {
        ...process.env,
        SOUNDDECK_VBCABLE_ARCHIVE: archivePath,
        SOUNDDECK_VBCABLE_DESTINATION: destinationPath
      }
    }
  );
}

async function readResponseWithLimit(response, maximumBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) throw new Error(`VB-CABLE archive exceeds ${maximumBytes} bytes.`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("VB-CABLE archive exceeded the reviewed size limit.");
        throw new Error(`VB-CABLE archive exceeds ${maximumBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function prepareVbCable(options) {
  const {
    manifest,
    targetDir,
    stageParent,
    fetchImpl = fetch,
    expandArchive = expandArchiveWithPowerShell,
    verifySignature = verifyAuthenticode
  } = options;
  validateManifest(manifest);

  await mkdir(stageParent, { recursive: true });
  await rm(targetDir, { recursive: true, force: true });
  const stageDir = await mkdtemp(path.join(stageParent, ".vbcable-stage-"));
  const archivePath = path.join(stageDir, `${manifest.package}.zip`);
  const payloadDir = path.join(stageDir, "payload");
  let installed = false;

  try {
    const response = await fetchImpl(manifest.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`VB-CABLE download failed: HTTP ${response.status} ${response.statusText}`);
    const bytes = await readResponseWithLimit(response, manifest.maximumArchiveBytes);
    const actualArchiveSha256 = sha256(bytes);
    if (actualArchiveSha256 !== manifest.archiveSha256) {
      throw new Error(
        `VB-CABLE archive SHA-256 mismatch. Expected ${manifest.archiveSha256}, got ${actualArchiveSha256}.`
      );
    }

    await writeFile(archivePath, bytes, { flag: "wx" });
    await mkdir(payloadDir);
    await expandArchive(archivePath, payloadDir);
    const verification = await verifyPayload(payloadDir, manifest, { verifySignature });
    await writeFile(
      path.join(payloadDir, PROVENANCE_FILENAME),
      `${JSON.stringify({
        package: manifest.package,
        driverVersion: manifest.driverVersion,
        reviewedAt: manifest.reviewedAt,
        sourcePage: manifest.sourcePage,
        url: manifest.url,
        archiveSha256: manifest.archiveSha256,
        setupSha256: verification.setupSha256,
        authenticodeSimpleName: manifest.setup.authenticodeSimpleName,
        authenticodeBusinessId: manifest.setup.authenticodeBusinessId
      }, null, 2)}\n`,
      { flag: "wx" }
    );
    await rename(payloadDir, targetDir);
    installed = true;
    return { archiveSha256: actualArchiveSha256, targetDir };
  } finally {
    await rm(stageDir, { recursive: true, force: true });
    if (!installed) {
      await rm(targetDir, { recursive: true, force: true });
    }
  }
}

export async function assertPreparedPayload(payloadDir, manifest, options = {}) {
  await access(path.join(payloadDir, PROVENANCE_FILENAME));
  const entries = await readdir(payloadDir, { withFileTypes: true });
  const payloadEntries = entries.filter((entry) => entry.name !== PROVENANCE_FILENAME);
  const expected = new Set(Object.keys(manifest.files));
  if (
    payloadEntries.length !== expected.size ||
    payloadEntries.some((entry) => !entry.isFile() || !expected.has(entry.name))
  ) {
    throw new Error("Prepared VB-CABLE payload does not match the reviewed inventory.");
  }
  for (const entry of payloadEntries) {
    const actualSha256 = sha256(await readFile(path.join(payloadDir, entry.name)));
    if (actualSha256 !== manifest.files[entry.name]) {
      throw new Error(
        `VB-CABLE file SHA-256 mismatch for ${entry.name}. Expected ${manifest.files[entry.name]}, got ${actualSha256}.`
      );
    }
  }
  const setupPath = path.join(payloadDir, manifest.setup.file);
  await (options.verifySignature ?? verifyAuthenticode)(setupPath, manifest.setup);
  return { setupPath, setupSha256: manifest.setup.sha256 };
}
