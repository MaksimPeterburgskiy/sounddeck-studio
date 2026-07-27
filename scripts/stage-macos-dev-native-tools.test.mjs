import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageMacosDevelopmentNativeTools } from "./stage-macos-dev-native-tools.mjs";

test("macOS development signing mutates only disposable tool copies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-macos-dev-tools-"));
  const verifiedDir = path.join(root, "verified", "darwin");
  const destinationRoot = path.join(root, "development");
  const contents = {
    ffmpeg: Buffer.from("verified ffmpeg"),
    ytDlp: Buffer.from("verified yt-dlp")
  };
  const prepared = { target: "darwin", files: {} };
  const signedPaths = [];

  try {
    await mkdir(verifiedDir, { recursive: true });
    for (const [name, content] of Object.entries(contents)) {
      const source = path.join(verifiedDir, name);
      await writeFile(source, content);
      prepared.files[name] = source;
    }
    await mkdir(path.join(destinationRoot, "darwin"), { recursive: true });
    await writeFile(path.join(destinationRoot, "darwin", "stale-tool"), "stale");

    const result = await stageMacosDevelopmentNativeTools({
      prepared,
      destinationRoot,
      signFile: async (filePath) => {
        signedPaths.push(filePath);
        const original = await readFile(filePath);
        await writeFile(filePath, Buffer.concat([original, Buffer.from("-signed")]));
      }
    });

    for (const [name, content] of Object.entries(contents)) {
      assert.deepEqual(await readFile(prepared.files[name]), content);
      assert.deepEqual(
        await readFile(result.files[name]),
        Buffer.concat([content, Buffer.from("-signed")])
      );
    }
    assert.equal(signedPaths.length, Object.keys(contents).length);
    assert.ok(signedPaths.every((filePath) => filePath.startsWith(destinationRoot)));
    await assert.rejects(
      readFile(path.join(destinationRoot, "darwin", "stale-tool")),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
