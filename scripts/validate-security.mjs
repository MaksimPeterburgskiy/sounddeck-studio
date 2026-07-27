import { access, readFile, readdir } from "node:fs/promises";
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

const ci = requiredWorkflow("ci.yml");
assert(/release-build:/.test(ci), "CI must exercise unsigned release builds.");
assert(/run:\s*pnpm run dist:win\s*(?:\n|$)/.test(ci), "CI must build Windows artifacts without publishing.");
assert(/pnpm run dist:mac:unsigned/.test(ci), "CI must build an unsigned macOS artifact.");

const release = requiredWorkflow("release.yml");
assert(/^permissions:\s*\n\s+contents:\s*read/m.test(release), "Release workflow must default to contents: read.");
assert(!/--publish\s+always/.test(release), "Release builds must not publish directly.");
assert(/--publish\s+never/.test(release), "Release builds must explicitly disable builder publishing.");
assert(/gh release create[\s\S]{0,200}--draft/.test(release), "Release workflow must create a draft release.");
const releaseNotesJob = release.match(/\n  release-notes:\n([\s\S]+)$/)?.[1] || "";
assert(
  /permissions:\s*\n\s+contents:\s*write/.test(releaseNotesJob),
  "Release notes need job-scoped contents: write to inspect the draft release."
);
assert(!/releaseType["']?\s*:\s*["']?release/.test(release), "Release workflow must not force public releases.");

for (const [index, line] of release.split(/\r?\n/).entries()) {
  if (!line.includes("secrets.RELEASE_TOKEN")) continue;
  assert(
    /^\s+GH_TOKEN:\s+\$\{\{\s*secrets\.RELEASE_TOKEN\s*\}\}\s*$/.test(line),
    `RELEASE_TOKEN must be injected only as GH_TOKEN (release.yml:${index + 1}).`
  );
}
const badge = requiredWorkflow("download-badge.yml");
assert(!badge.includes("RELEASE_TOKEN"), "Badge workflow must never use the release PAT.");
assert(/^permissions:\s*\n\s+contents:\s*read/m.test(badge), "Badge workflow must default to contents: read.");
assert(/GH_TOKEN:\s+\$\{\{\s*github\.token\s*\}\}/.test(badge), "Badge PR update must use github.token.");
const badgeWriteJob = badge.match(/\n  write:\n([\s\S]+)$/)?.[1] || "";
assert(/permissions:\s*\n\s+contents:\s*write/.test(badgeWriteJob), "Badge write job must declare contents: write.");
assert(/pull-requests:\s*write/.test(badgeWriteJob), "Badge write job must declare pull-requests: write.");
assert(!/\buses:/.test(badgeWriteJob), "Badge write job must not expose its token to action steps.");
assert(
  /BADGE_BRANCH:\s*automation\/update-download-badge/.test(badgeWriteJob),
  "Badge updates must use the dedicated automation branch."
);
assert(
  /--method POST "[^"]*\/pulls"/.test(badgeWriteJob),
  "Badge write job must open a pull request."
);
assert(
  /--raw-field head="\$BADGE_BRANCH"/.test(badgeWriteJob) &&
    /--raw-field base="main"/.test(badgeWriteJob),
  "Badge pull requests must carry the dedicated branch into main."
);
assert(
  !/--raw-field branch=["']?main\b/.test(badgeWriteJob),
  "Badge write job must not update main directly."
);
assert(
  !/--method\s+(?:PATCH|PUT)[^\n]*git\/refs?\/heads\/main/.test(badgeWriteJob),
  "Badge write job must not update the main Git reference."
);
const existingBadgePrLookup = badgeWriteJob.indexOf("pulls?state=open&head=");
const badgeNoChangeGuard = badgeWriteJob.indexOf('if [[ "$current_data" == "$BADGE_DATA" ]]');
assert(
  existingBadgePrLookup >= 0 && existingBadgePrLookup < badgeNoChangeGuard,
  "Badge write job must find an existing pull request before its no-change exit."
);
assert(
  /if \[\[ "\$current_data" == "\$BADGE_DATA" \]\]; then[\s\S]*?pulls\/\$existing_pr_number[\s\S]*?--raw-field state=closed[\s\S]*?exit 0/.test(badgeWriteJob),
  "Badge write job must close a stale pull request before its no-change exit."
);

await assertMissing(path.join(workflowsDir, "dependabot-auto-merge.yml"));

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
assert(packageJson.build?.publish?.releaseType === "draft", "Electron Builder releases must remain drafts.");
const macX64ArchFiles = packageJson.build?.mac?.x64ArchFiles || "";
assert(
  macX64ArchFiles.includes("Contents/Resources/native-tools/"),
  "Universal macOS packaging must allow identical managed native tools."
);
for (const toolName of ["ffmpeg-x64", "ffmpeg-arm64", "yt-dlp"]) {
  assert(
    macX64ArchFiles.includes(toolName),
    `Universal macOS packaging must allow identical managed tools (${toolName}).`
  );
}
for (const dependency of ["ffmpeg-static", "youtube-dl-exec"]) {
  assert(!packageJson.dependencies?.[dependency], `${dependency} must not be a production dependency.`);
  assert(!packageJson.build?.asarUnpack?.some((entry) => entry.includes(dependency)), `${dependency} must not be unpacked.`);
}

const workspace = await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
assert(!/^\s+(?:ffmpeg-static|youtube-dl-exec):\s+true/m.test(workspace), "Binary downloader lifecycle scripts must not be allowed.");

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
