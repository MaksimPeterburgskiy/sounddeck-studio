import { prepareNativeTools } from "./native-tools.mjs";
import { parseFetchNativeToolsOptions } from "./fetch-native-tools-options.mjs";

const result = await prepareNativeTools(parseFetchNativeToolsOptions(process.argv.slice(2)));

for (const [name, filePath] of Object.entries(result.files)) {
  console.log(`Prepared ${name}: ${filePath}`);
}
