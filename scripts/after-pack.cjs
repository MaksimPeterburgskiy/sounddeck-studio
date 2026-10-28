exports.default = async function afterPack(context) {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const { createHash } = require("node:crypto");
  const root = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "noise-models", "manifest.json"), "utf8"));
  for (const asset of [...manifest.models, manifest.ort]) {
    const data = await fs.readFile(path.join(root, "noise-models", asset.file));
    if (createHash("sha256").update(data).digest("hex") !== asset.sha256) throw new Error(`Invalid packaged noise model asset: ${asset.file}`);
  }
  const { installNativeTools } = await import("./native-tools.mjs");
  const installed = await installNativeTools(context);
  for (const filePath of installed) console.log(`Installed verified native tool: ${filePath}`);
};
