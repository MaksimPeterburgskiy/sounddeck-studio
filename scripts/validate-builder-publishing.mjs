// Inspect each shell invocation separately, including continued command lines.
export function validateBuilderPublishing(source, name) {
  const joined = source.replace(/\r\n?/g, "\n").replace(/\\\n\s*/g, " ");
  for (const line of joined.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const command = line.replace(/\s+#.*$/, "");
    const invocations = [...command.matchAll(/\belectron-builder\b/g)];
    for (const [invocationIndex, match] of invocations.entries()) {
      const args = command.slice(match.index + match[0].length, invocations[invocationIndex + 1]?.index)
        .split(/[;&|]/, 1)[0].trim().split(/\s+/).map((arg) => arg.replace(/^['"]|['"]$/g, ""));
      const publishFlags = args.filter((arg) => /^--publish(?:=|$)|^-p/.test(arg));
      const index = args.indexOf("--publish");
      if (publishFlags.length !== 1 || publishFlags[0] !== "--publish" || args[index + 1] !== "never") {
        throw new Error(`${name} electron-builder invocations must have exactly one --publish never and no other publishing flags.`);
      }
    }
  }
}
