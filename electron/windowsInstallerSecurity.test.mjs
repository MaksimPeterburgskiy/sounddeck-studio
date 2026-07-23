import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPreparedPayload,
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

    expect(installer).toContain('SetOutPath "$PLUGINSDIR\\vbcable"');
    expect(installer).toContain('File /r "${BUILD_RESOURCES_DIR}\\vbcable\\*"');
    expect(installer).toContain("verify-vbcable.ps1");
    expect(installer).toContain("vbcable-provenance.json");
    expect(installer).toContain('"$SYSDIR\\icacls.exe"');
    expect(installer).toContain("/setowner");
    expect(installer).toContain("/inheritance:r");
    expect(installer).toContain('/setintegritylevel "(OI)(CI)H"');
    expect(installer).toContain('ExecWait \'"$PLUGINSDIR\\vbcable\\VBCABLE_Setup_x64.exe" -i -h\'');
    expect(installer).not.toContain("$INSTDIR\\resources\\vbcable");
    expect(installer).toContain("${IfNot} ${isUpdated}");
    expect(installer).toContain("Abort");
  });

  it("anchors runtime verification outside the adjacent manifest and system-loads Authenticode", async () => {
    const manifest = await loadManifest(manifestPath);
    const runtimeVerifier = await readFile(path.join(repoRoot, "build", "verify-vbcable.ps1"), "utf8");
    const manifestSha256 = sha256(await readFile(manifestPath));

    expect(runtimeVerifier).toContain("$manifest.files.PSObject.Properties");
    expect(runtimeVerifier).toContain(manifestSha256);
    expect(runtimeVerifier).toContain(manifest.setup.authenticodeSimpleName);
    expect(runtimeVerifier).toContain(manifest.setup.authenticodeBusinessId);
    expect(runtimeVerifier).toContain("TimeStamperCertificate");
    expect(runtimeVerifier).toContain("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature");
    expect(runtimeVerifier).toContain('$env:PSModulePath = Join-Path $PSHOME "Modules"');
  });
});
