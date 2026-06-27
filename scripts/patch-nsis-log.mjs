import fs from "node:fs";
import path from "node:path";

const templatePath = path.join(
  process.cwd(),
  "node_modules",
  "app-builder-lib",
  "templates",
  "nsis",
  "installSection.nsh",
);

if (!fs.existsSync(templatePath)) {
  throw new Error(`NSIS install template not found: ${templatePath}`);
}

const original = fs.readFileSync(templatePath, "utf8");
const quietBlock = /\$\{IfNot\} \$\{Silent\}\r?\n\s*SetDetailsPrint none\r?\n\s*\$\{endif\}/;
const verboseBlock = "${IfNot} ${Silent}\n  SetDetailsPrint both\n${endif}";

if (original.includes("SetDetailsPrint both")) {
  console.log("NSIS install details are already enabled.");
} else if (quietBlock.test(original)) {
  fs.writeFileSync(templatePath, original.replace(quietBlock, verboseBlock));
  console.log("Enabled NSIS install detail output.");
} else {
  throw new Error("Could not find the NSIS SetDetailsPrint block to patch.");
}
