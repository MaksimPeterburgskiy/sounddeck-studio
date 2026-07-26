import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPreparedPayload,
  canonicalizeManifestText,
  loadManifest,
  prepareVbCable,
  sha256,
  validateManifest,
  verifyPayload
} from "../scripts/vbcable-provenance.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(repoRoot, "build", "vbcable-provenance.json");
const temporaryDirectories = [];

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sounddeck-vbcable-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeManifest(archiveBytes, setupBytes) {
  return {
    schemaVersion: 1,
    package: "VBCABLE_Driver_Pack45",
    driverVersion: "3.3.1.7",
    released: "2024-10",
    reviewedAt: "2026-07-23",
    sourcePage: "https://vb-audio.com/Cable/",
    url: "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip",
    archiveSha256: sha256(archiveBytes),
    maximumArchiveBytes: 1024,
    setup: {
      file: "VBCABLE_Setup_x64.exe",
      sha256: sha256(setupBytes),
      authenticodeSimpleName: "BUREL VINCENT Entrepreneur individuel",
      authenticodeBusinessId: "423 734 177"
    },
    files: {
      "VBCABLE_Setup_x64.exe": sha256(setupBytes),
      "driver.cat": sha256(Buffer.from("catalog"))
    }
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("VB-CABLE provenance", () => {
  it("pins the reviewed official origin, archive, helper, signer, and inventory", async () => {
    const manifest = await loadManifest(manifestPath);

    expect(manifest).toMatchObject({
      package: "VBCABLE_Driver_Pack45",
      driverVersion: "3.3.1.7",
      reviewedAt: "2026-07-23",
      url: "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip",
      archiveSha256: "b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb",
      setup: {
        file: "VBCABLE_Setup_x64.exe",
        sha256: "734c35dfa6d98f48782a451633ceb471166ec70d60482fd89a1123d0ee3c4f41",
        authenticodeSimpleName: "BUREL VINCENT Entrepreneur individuel",
        authenticodeBusinessId: "423 734 177"
      }
    });
    expect(manifest.files).toHaveProperty("vbaudio_cable64_win10.cat");
    expect(manifest.files).toHaveProperty("vbMmeCable64_win10.inf");
    expect(manifest.files).toHaveProperty("vbaudio_cable64_win10.sys");
  });

  it("rejects unapproved origins and malformed digest pins", async () => {
    const manifest = await loadManifest(manifestPath);

    expect(() => validateManifest({ ...manifest, url: "https://example.com/driver.zip" })).toThrow(
      "pinned download.vb-audio.com"
    );
    expect(() => validateManifest({ ...manifest, archiveSha256: "latest" })).toThrow(
      "Invalid VB-CABLE archive SHA-256"
    );
  });

  it("accepts a UTF-8 BOM while preserving the canonical manifest hash", async () => {
    const directory = await makeTemporaryDirectory();
    const manifest = fakeManifest(Buffer.from("archive"), Buffer.from("reviewed helper"));
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestWithBomPath = path.join(directory, "vbcable-provenance.json");

    await writeFile(manifestWithBomPath, `\uFEFF${manifestText}`);

    await expect(loadManifest(manifestWithBomPath)).resolves.toEqual(manifest);
    expect(sha256(Buffer.from(canonicalizeManifestText(`\uFEFF${manifestText}`), "utf8"))).toBe(
      sha256(Buffer.from(manifestText, "utf8"))
    );
  });

  it("checks the complete extracted inventory, helper digest, and signature", async () => {
    const directory = await makeTemporaryDirectory();
    const archiveBytes = Buffer.from("archive");
    const setupBytes = Buffer.from("reviewed helper");
    const manifest = fakeManifest(archiveBytes, setupBytes);
    await writeFile(path.join(directory, manifest.setup.file), setupBytes);
    await writeFile(path.join(directory, "driver.cat"), "catalog");
    const verifySignature = vi.fn(async () => {});

    await expect(verifyPayload(directory, manifest, { verifySignature })).resolves.toMatchObject({
      setupSha256: manifest.setup.sha256
    });
    expect(verifySignature).toHaveBeenCalledOnce();

    await writeFile(path.join(directory, "unexpected.dll"), "unexpected");
    await expect(verifyPayload(directory, manifest, { verifySignature })).rejects.toThrow("file inventory mismatch");
  });

  it("deletes stale ignored input and exposes only a freshly verified payload", async () => {
    const root = await makeTemporaryDirectory();
    const targetDir = path.join(root, "vbcable");
    const stageParent = path.join(root, "staging");
    const archiveBytes = Buffer.from("reviewed archive");
    const setupBytes = Buffer.from("reviewed helper");
    const manifest = fakeManifest(archiveBytes, setupBytes);
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, manifest.setup.file), "stale malicious helper");

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => Uint8Array.from(archiveBytes).buffer
    }));
    const expandArchive = vi.fn(async (_archivePath, destinationPath) => {
      await writeFile(path.join(destinationPath, manifest.setup.file), setupBytes);
      await writeFile(path.join(destinationPath, "driver.cat"), "catalog");
    });
    const verifySignature = vi.fn(async () => {});

    await prepareVbCable({
      manifest,
      targetDir,
      stageParent,
      fetchImpl,
      expandArchive,
      verifySignature
    });

    expect(await readFile(path.join(targetDir, manifest.setup.file), "utf8")).toBe("reviewed helper");
    expect(JSON.parse(await readFile(path.join(targetDir, "PROVENANCE.json"), "utf8"))).toMatchObject({
      archiveSha256: manifest.archiveSha256,
      setupSha256: manifest.setup.sha256
    });
    expect(verifySignature).toHaveBeenCalledOnce();

    await writeFile(path.join(targetDir, "driver.cat"), "tampered catalog");
    await expect(assertPreparedPayload(targetDir, manifest, { verifySignature })).rejects.toThrow(
      "file SHA-256 mismatch for driver.cat"
    );
  });

  it("fails closed and leaves no stale payload on an archive digest mismatch", async () => {
    const root = await makeTemporaryDirectory();
    const targetDir = path.join(root, "vbcable");
    const stageParent = path.join(root, "staging");
    const manifest = fakeManifest(Buffer.from("expected archive"), Buffer.from("reviewed helper"));
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, manifest.setup.file), "stale malicious helper");

    await expect(
      prepareVbCable({
        manifest,
        targetDir,
        stageParent,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => Uint8Array.from(Buffer.from("different archive")).buffer
        }),
        expandArchive: vi.fn(),
        verifySignature: vi.fn()
      })
    ).rejects.toThrow("archive SHA-256 mismatch");

    await expect(readFile(path.join(targetDir, manifest.setup.file))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let a concurrent preparation remove the verified target", async () => {
    const root = await makeTemporaryDirectory();
    const targetDir = path.join(root, "vbcable");
    const stageParent = path.join(root, "staging");
    const archiveBytes = Buffer.from("reviewed archive");
    const setupBytes = Buffer.from("reviewed helper");
    const manifest = fakeManifest(archiveBytes, setupBytes);
    let releaseExpansion;
    const expansionStarted = new Promise((resolve) => {
      releaseExpansion = resolve;
    });
    let continueExpansion;
    const expansionBlocked = new Promise((resolve) => {
      continueExpansion = resolve;
    });
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => Uint8Array.from(archiveBytes).buffer
    });
    const expandArchive = async (_archivePath, destinationPath) => {
      releaseExpansion();
      await expansionBlocked;
      await writeFile(path.join(destinationPath, manifest.setup.file), setupBytes);
      await writeFile(path.join(destinationPath, "driver.cat"), "catalog");
    };
    const firstPreparation = prepareVbCable({
      manifest,
      targetDir,
      stageParent,
      fetchImpl,
      expandArchive,
      verifySignature: async () => {}
    });

    await expansionStarted;
    await expect(
      prepareVbCable({
        manifest,
        targetDir,
        stageParent,
        fetchImpl,
        expandArchive: vi.fn(),
        verifySignature: vi.fn()
      })
    ).rejects.toThrow("preparation is already in progress");

    continueExpansion();
    await expect(firstPreparation).resolves.toMatchObject({ targetDir });
    expect(await readFile(path.join(targetDir, manifest.setup.file), "utf8")).toBe("reviewed helper");
  });

  it("recovers an abandoned preparation lock", async () => {
    const root = await makeTemporaryDirectory();
    const targetDir = path.join(root, "vbcable");
    const stageParent = path.join(root, "staging");
    const archiveBytes = Buffer.from("reviewed archive");
    const setupBytes = Buffer.from("reviewed helper");
    const manifest = fakeManifest(archiveBytes, setupBytes);
    const resolvedTarget = path.resolve(targetDir);
    const lockKey = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
    const lockDir = path.join(stageParent, `.vbcable-lock-${sha256(lockKey).slice(0, 16)}`);
    await mkdir(lockDir, { recursive: true });
    const abandonedAt = new Date(Date.now() - 60_000);
    await utimes(lockDir, abandonedAt, abandonedAt);

    await expect(
      prepareVbCable({
        manifest,
        targetDir,
        stageParent,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => Uint8Array.from(archiveBytes).buffer
        }),
        expandArchive: async (_archivePath, destinationPath) => {
          await writeFile(path.join(destinationPath, manifest.setup.file), setupBytes);
          await writeFile(path.join(destinationPath, "driver.cat"), "catalog");
        },
        verifySignature: async () => {}
      })
    ).resolves.toMatchObject({ targetDir });
    expect(await readFile(path.join(targetDir, manifest.setup.file), "utf8")).toBe("reviewed helper");
  });
});

describe("Windows installer trust boundary", () => {
  it("keeps VB-CABLE out of installed app resources and hides custom paths for per-machine installs", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    const extraResources = packageJson.build.win.extraResources;

    expect(packageJson.build.nsis).toMatchObject({
      oneClick: false,
      perMachine: true,
      allowToChangeInstallationDirectory: false
    });
    expect(extraResources.some((resource) => resource.from === "build/vbcable")).toBe(false);
  });

  it("extracts to private NSIS storage and rechecks trust immediately before execution", async () => {
    const installer = await readFile(path.join(repoRoot, "build", "installer.nsh"), "utf8");
    const parentLock = installer.indexOf('CreateFileW(w "$PLUGINSDIR"');
    const parentProtection = installer.indexOf("advapi32::SetSecurityInfo", parentLock);
    const protectedCreate = installer.indexOf("kernel32::CreateDirectoryW");
    const payloadExtraction = installer.indexOf('File /r /x "PROVENANCE.json"');
    const helperCommand = 'ExecWait \'"$PLUGINSDIR\\vbcable\\payload\\VBCABLE_Setup_x64.exe" -i -h\'';
    const helperExecution = installer.indexOf(helperCommand);
    const lastHandleClose = installer.lastIndexOf("kernel32::CloseHandle");

    expect(installer).toContain('SetOutPath "$PLUGINSDIR\\vbcable\\payload"');
    expect(installer).toContain('File /r /x "PROVENANCE.json" "${BUILD_RESOURCES_DIR}\\vbcable\\*"');
    expect(installer).toContain("verify-vbcable.ps1");
    expect(installer).toContain("vbcable-provenance.json");
    expect(installer).toContain("ConvertStringSecurityDescriptorToSecurityDescriptorW");
    expect(installer).toContain("SOUNDDECK_DIRECTORY_OPEN_FLAGS 0x02200000");
    expect(installer).toContain("SOUNDDECK_PROTECTED_SECURITY_INFORMATION 0x80000007");
    expect(installer).toContain("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
    expect(installer).toContain("GetFileInformationByHandle");
    expect(installer).toContain("advapi32::SetSecurityInfo");
    expect(installer).toContain("A pre-existing directory is rejected");
    expect(installer).not.toContain('CreateDirectory "$PLUGINSDIR\\vbcable"');
    expect(parentLock).toBeGreaterThan(-1);
    expect(parentProtection).toBeGreaterThan(parentLock);
    expect(protectedCreate).toBeGreaterThan(-1);
    expect(protectedCreate).toBeGreaterThan(parentProtection);
    expect(payloadExtraction).toBeGreaterThan(protectedCreate);
    expect(helperExecution).toBeGreaterThan(payloadExtraction);
    expect(lastHandleClose).toBeGreaterThan(helperExecution);
    expect(installer).toContain('"$SYSDIR\\icacls.exe"');
    expect(installer).toContain('/setintegritylevel "(OI)(CI)H"');
    expect(installer).toContain(helperCommand);
    expect(installer).not.toContain("$INSTDIR\\resources\\vbcable");
    expect(installer).not.toContain("!macro customInit");
    expect(installer).not.toContain("SoundDeckDriverSetupComplete");
    expect(installer).toContain(
      'ReadRegStr $0 HKLM "SYSTEM\\CurrentControlSet\\Services\\VBAudioVACMME" "ImagePath"'
    );
    expect(installer).toContain("Abort");
  });

  it("keeps silent driver failures noninteractive without recursively removing the app", async () => {
    const installer = await readFile(path.join(repoRoot, "build", "installer.nsh"), "utf8");
    const failureDialogs = installer.match(/^\s*MessageBox MB_ICONSTOP\|MB_OK .*$/gm) ?? [];
    const failureStart = installer.indexOf("!macro AbortSoundDeckInstall");
    const failureEnd = installer.indexOf("!macroend", failureStart);
    const activeFailure = installer.slice(failureStart, failureEnd);
    const failureCalls = installer.match(/^\s*!insertmacro AbortSoundDeckInstall\s*$/gm) ?? [];

    expect(failureDialogs.length).toBeGreaterThanOrEqual(4);
    expect(failureDialogs.every((dialog) => dialog.endsWith("/SD IDOK"))).toBe(true);
    expect(failureStart).toBeGreaterThan(-1);
    expect(activeFailure).toContain("kernel32::CloseHandle(p r7)");
    expect(activeFailure).toContain("kernel32::CloseHandle(p r6)");
    expect(activeFailure).toContain("kernel32::LocalFree(p r2)");
    expect(activeFailure).toContain("${EnableX64FSRedirection}");
    expect(activeFailure).toContain("SoundDeck Studio remains installed");
    expect(activeFailure).toContain("SetErrorLevel 2");
    expect(activeFailure).toContain("Abort");
    expect(activeFailure).not.toContain("$INSTDIR");
    expect(activeFailure).not.toContain("UNINSTALL_FILENAME");
    expect(activeFailure).not.toContain("RMDir");
    expect(failureCalls.length).toBeGreaterThan(0);
    expect(installer).toContain("${ElseIf} $0 == 3010");
    expect(installer).toContain("SetRebootFlag true");
    expect(installer).toContain("SetErrorLevel 3010");
  });

  it("anchors runtime verification outside the adjacent manifest and system-loads Authenticode", async () => {
    const manifest = await loadManifest(manifestPath);
    const runtimeVerifier = await readFile(path.join(repoRoot, "build", "verify-vbcable.ps1"), "utf8");
    const manifestText = await readFile(manifestPath, "utf8");
    const manifestSha256 = sha256(Buffer.from(canonicalizeManifestText(manifestText), "utf8"));

    expect(runtimeVerifier).toContain("$manifest.files.PSObject.Properties");
    expect(runtimeVerifier).toContain("Get-ChildItem -LiteralPath $payloadDirectory -Force");
    expect(runtimeVerifier).toContain("$actualFiles.Count -ne $expectedFileNames.Count");
    expect(runtimeVerifier).toContain("[System.IO.FileAttributes]::ReparsePoint");
    expect(runtimeVerifier).toContain(manifestSha256);
    expect(runtimeVerifier).toContain(manifest.setup.authenticodeSimpleName);
    expect(runtimeVerifier).toContain(manifest.setup.authenticodeBusinessId);
    expect(runtimeVerifier).toContain("TimeStamperCertificate");
    expect(runtimeVerifier).toContain("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature");
    expect(runtimeVerifier).toContain('$env:PSModulePath = Join-Path $PSHOME "Modules"');
    expect(runtimeVerifier).toContain("[System.IO.Path]::GetFileName($FilePath) -cne $manifest.setup.file");
  });
});
