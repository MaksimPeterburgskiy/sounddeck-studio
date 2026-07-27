// Guards the supply-chain decisions that no linter enforces for us: actions stay
// SHA-pinned, checkouts never persist credentials, builders never publish
// directly, and the removed binary-downloader dependencies stay removed.
//
// Deliberately not asserted here: the internal shape of any workflow's shell
// script. Those change for good reasons and a text-match failure teaches nobody
// anything. If zizmor is ever added to CI, the pinning and persist-credentials
// loops below become redundant and can go.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const workflowsDir = path.join(repoRoot, ".github", "workflows");
const workflowNames = (await readdir(workflowsDir)).filter((name) => name.endsWith(".yml"));
const workflows = new Map(
  await Promise.all(workflowNames.map(async (name) => [
    name,
    (await readFile(path.join(workflowsDir, name), "utf8")).replace(/\r\n?/g, "\n")
  ]))
);

for (const [name, source] of workflows) {
  for (const match of source.matchAll(/\buses:\s*([^\s#]+)/g)) {
    assert(
      /@[a-f0-9]{40}$/.test(match[1]),
      `${name} uses a mutable action reference: ${match[1]}`
    );
  }
  for (const match of source.matchAll(/uses:\s*actions\/checkout@[a-f0-9]{40}[\s\S]*?(?=\n\s*-\s+(?:uses:|name:)|$)/g)) {
    assert(
      /persist-credentials:\s*false/.test(match[0]),
      `${name} checkout must set persist-credentials: false.`
    );
    assert(!/\btoken:/.test(match[0]), `${name} checkout must not receive a write token.`);
  }
}

const release = requiredWorkflow("release.yml");
assert(/^permissions:\s*\n\s+contents:\s*read/m.test(release), "Release workflow must default to contents: read.");
assert(!/--publish\s+always/.test(release), "Release builds must not publish directly.");
assert(/gh release create[\s\S]{0,200}--draft/.test(release), "Release workflow must create a draft release.");

// The workflows delegate packaging to the dist scripts, so the builder publish
// flags are only meaningful there. Every electron-builder invocation must carry
// its own --publish never, not just one of them.
for (const script of ["dist-win.mjs", "dist-mac.mjs"]) {
  const source = await readFile(path.join(repoRoot, "scripts", script), "utf8");
  assert(!/--publish"?,?\s+"?always/.test(source), `${script} must not publish directly.`);
  const invocations = source.match(/"electron-builder"/g)?.length || 0;
  const disabled = source.match(/"--publish",\s*"never"/g)?.length || 0;
  assert(invocations > 0, `${script} must invoke electron-builder.`);
  assert(
    invocations === disabled,
    `${script} has ${invocations} electron-builder invocations but ${disabled} explicitly disable publishing.`
  );
}

for (const [index, line] of release.split("\n").entries()) {
  if (!line.includes("secrets.RELEASE_TOKEN")) continue;
  assert(
    /^\s+GH_TOKEN:\s+\$\{\{\s*secrets\.RELEASE_TOKEN\s*\}\}\s*$/.test(line),
    `RELEASE_TOKEN must be injected only as GH_TOKEN (release.yml:${index + 1}).`
  );
}

const badge = requiredWorkflow("download-badge.yml");
assert(!badge.includes("RELEASE_TOKEN"), "Badge workflow must never use the release PAT.");
assert(/^permissions:\s*\n\s+contents:\s*read/m.test(badge), "Badge workflow must default to contents: read.");
const badgeWriteJob = badge.match(/\n  write:\n([\s\S]+)$/)?.[1] || "";
assert(!/\buses:/.test(badgeWriteJob), "Badge write job must not expose its token to action steps.");

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
assert(packageJson.build?.publish?.releaseType === "draft", "Electron Builder releases must remain drafts.");
assert(
  (packageJson.build?.mac?.x64ArchFiles || "").includes("Contents/Resources/native-tools/"),
  "Universal macOS packaging must allow identical managed native tools."
);
for (const dependency of ["ffmpeg-static", "youtube-dl-exec"]) {
  assert(!packageJson.dependencies?.[dependency], `${dependency} must not be a production dependency.`);
  assert(
    !packageJson.build?.asarUnpack?.some((entry) => entry.includes(dependency)),
    `${dependency} must not be unpacked.`
  );
}

const workspace = await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
assert(
  !/^\s+(?:ffmpeg-static|youtube-dl-exec):\s+true/m.test(workspace),
  "Binary downloader lifecycle scripts must not be allowed."
);

console.log(`Validated ${workflows.size} workflows, native binary policy, and draft release gating.`);

function requiredWorkflow(name) {
  const source = workflows.get(name);
  if (!source) throw new Error(`Missing required workflow: ${name}`);
  return source;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
