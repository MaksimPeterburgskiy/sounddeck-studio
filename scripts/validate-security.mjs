import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const workflowsDir = path.join(repoRoot, ".github", "workflows");
const workflowNames = (await readdir(workflowsDir)).filter((name) => name.endsWith(".yml"));
const workflows = new Map(
  await Promise.all(workflowNames.map(async (name) => [
    name,
    await readFile(path.join(workflowsDir, name), "utf8")
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
assert(/--publish\s+never/.test(release), "Release builds must explicitly disable builder publishing.");
assert(/gh release create[\s\S]{0,200}--draft/.test(release), "Release workflow must create a draft release.");
assert(!/releaseType["']?\s*:\s*["']?release/.test(release), "Release workflow must not force public releases.");

for (const block of release.matchAll(/-\s+name:\s+Install dependencies[\s\S]*?(?=\n\s+-\s+(?:name:|uses:)|$)/g)) {
  for (const tokenName of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_RELEASE_TOKEN", "RELEASE_TOKEN"]) {
    assert(
      new RegExp(`${tokenName}:\\s*[\"']{2}`).test(block[0]),
      `Dependency install must scrub ${tokenName}.`
    );
  }
}

for (const [index, line] of release.split(/\r?\n/).entries()) {
  if (!line.includes("secrets.RELEASE_TOKEN")) continue;
  assert(
    /^\s+GH_TOKEN:\s+\$\{\{\s*secrets\.RELEASE_TOKEN\s*\}\}\s*$/.test(line),
    `RELEASE_TOKEN must be injected only as GH_TOKEN (release.yml:${index + 1}).`
  );
}
const credentialedReleaseSteps = [...release.matchAll(
  /-\s+name:\s+([^\n]+)[\s\S]*?(?=\n\s+-\s+(?:name:|uses:)|$)/g
)].filter((match) => match[0].includes("secrets.RELEASE_TOKEN"));
const allowedCredentialedSteps = new Set([
  "Push version, fast-forward prod, and create draft release",
  "Upload Windows artifacts to draft release",
  "Upload macOS artifacts to draft release",
  "Attach notes to draft release"
]);
assert(credentialedReleaseSteps.length === allowedCredentialedSteps.size, "Release PAT step count changed.");
for (const match of credentialedReleaseSteps) {
  assert(allowedCredentialedSteps.has(match[1].trim()), `Release PAT is exposed to an unapproved step: ${match[1]}`);
}

const badge = requiredWorkflow("download-badge.yml");
assert(!badge.includes("RELEASE_TOKEN"), "Badge workflow must never use the release PAT.");
assert(/^permissions:\s*\n\s+contents:\s*read/m.test(badge), "Badge workflow must default to contents: read.");
assert(/GH_TOKEN:\s+\$\{\{\s*github\.token\s*\}\}/.test(badge), "Badge push must use github.token.");
const badgeWriteJob = badge.match(/\n  write:\n([\s\S]+)$/)?.[1] || "";
assert(/permissions:\s*\n\s+contents:\s*write/.test(badgeWriteJob), "Badge write job must declare contents: write.");
assert(!/\buses:/.test(badgeWriteJob), "Badge write job must not expose its token to action steps.");
assert((badgeWriteJob.match(/\n\s+-\s+name:/g) || []).length === 1, "Badge write job must contain one credentialed step.");

await assertMissing(path.join(workflowsDir, "dependabot-auto-merge.yml"));

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
assert(packageJson.build?.publish?.releaseType === "draft", "Electron Builder releases must remain drafts.");
for (const dependency of ["ffmpeg-static", "youtube-dl-exec"]) {
  assert(!packageJson.dependencies?.[dependency], `${dependency} must not be a production dependency.`);
  assert(!packageJson.build?.asarUnpack?.some((entry) => entry.includes(dependency)), `${dependency} must not be unpacked.`);
}

const workspace = await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
assert(!/^\s+(?:ffmpeg-static|youtube-dl-exec):\s+true/m.test(workspace), "Binary downloader lifecycle scripts must not be allowed.");

for (const scriptName of ["dist-mac.mjs", "dist-win.mjs"]) {
  const source = await readFile(path.join(repoRoot, "scripts", scriptName), "utf8");
  for (const tokenName of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_RELEASE_TOKEN", "RELEASE_TOKEN"]) {
    assert(source.includes(tokenName), `${scriptName} must scrub ${tokenName}.`);
  }
}

console.log(`Validated ${workflows.size} workflows, native binary policy, and draft release gating.`);

function requiredWorkflow(name) {
  const source = workflows.get(name);
  if (!source) throw new Error(`Missing required workflow: ${name}`);
  return source;
}

async function assertMissing(filePath) {
  try {
    await access(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${path.relative(repoRoot, filePath)} must be removed.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
