import { canUseDevelopmentHostTools } from "./development-native-tools.mjs";
import { hasNativeToolsManifestTarget, prepareNativeTools } from "./native-tools.mjs";
import { parseFetchNativeToolsOptions } from "./fetch-native-tools-options.mjs";

const options = parseFetchNativeToolsOptions(process.argv.slice(2));
if (!hasNativeToolsManifestTarget(options.platform, options.arch)) {
  console.log(
    `No project-managed native tools for ${options.platform}-${options.arch}; ` +
    "development will use explicit overrides or PATH."
  );
} else if (options.allowHostTools && await canUseDevelopmentHostTools(options)) {
  console.log("Development ffmpeg and yt-dlp are already available; skipping managed downloads.");
} else {
  const { allowHostTools: _allowHostTools, ...prepareOptions } = options;
  const result = await prepareNativeTools(prepareOptions);
  for (const [name, filePath] of Object.entries(result.files)) {
    console.log(`Prepared ${name}: ${filePath}`);
  }
}
