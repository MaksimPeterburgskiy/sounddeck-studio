import ts from "typescript";

// Vite 8's Oxc transform preserves standard decorators, which Node cannot yet
// execute. Use the plugin's compiler for the same lowering as the Rollup build.
export function streamDeckTestTransform() {
  return {
    name: "streamdeck-test-decorators",
    enforce: "pre",
    transform(source, id) {
      if (!id.includes("streamdeck-plugin/src/") || !source.includes("@action(")) return null;
      const output = ts.transpileModule(source, {
        fileName: id, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: true },
      });
      return { code: output.outputText, map: output.sourceMapText };
    },
  };
}
