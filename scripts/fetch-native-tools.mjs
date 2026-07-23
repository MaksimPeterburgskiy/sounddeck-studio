import { prepareNativeTools } from "./native-tools.mjs";

const args = parseArgs(process.argv.slice(2));
const result = await prepareNativeTools({
  platform: args.platform || process.platform,
  arch: args.arch || process.arch,
  offline: args.offline
});

for (const [name, filePath] of Object.entries(result.files)) {
  console.log(`Prepared ${name}: ${filePath}`);
}

function parseArgs(values) {
  const result = { offline: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--offline") {
      result.offline = true;
    } else if (value === "--platform" || value === "--arch") {
      const name = value.slice(2);
      result[name] = values[index + 1];
      index += 1;
      if (!result[name]) throw new Error(`${value} requires a value.`);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return result;
}
