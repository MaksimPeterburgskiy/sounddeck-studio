exports.default = async function afterPack(context) {
  const { installNativeTools } = await import("./native-tools.mjs");
  const installed = await installNativeTools(context);
  for (const filePath of installed) console.log(`Installed verified native tool: ${filePath}`);
};
