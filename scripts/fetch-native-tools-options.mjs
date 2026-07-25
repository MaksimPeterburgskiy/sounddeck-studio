export function parseFetchNativeToolsOptions(values, {
  platform = process.platform,
  arch = process.arch,
  env = process.env
} = {}) {
  const result = { platform, arch };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--offline") {
      result.offline = true;
    } else if (value === "--allow-host-tools") {
      result.allowHostTools = true;
    } else if (value === "--platform" || value === "--arch") {
      const name = value.slice(2);
      result[name] = values[index + 1];
      index += 1;
      if (!result[name]) throw new Error(`${value} requires a value.`);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (env.SOUNDDECK_NATIVE_TOOLS_OFFLINE === "1") result.offline = true;
  return result;
}
