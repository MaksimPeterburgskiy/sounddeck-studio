# Release security

SoundDeck Studio treats native executables and release credentials as part of the production trust boundary. The release workflow builds a draft GitHub Release. A maintainer publishes that draft only after every platform job has succeeded and the attached installers and updater metadata have been reviewed. Draft releases are not visible to `electron-updater`, so a failed or incomplete workflow cannot become an automatic update.

## Native tools

Production packages use only the ffmpeg and yt-dlp files listed in [`config/native-tools.json`](../config/native-tools.json). Each entry has:

- an exact release asset URL, with no `latest` redirect;
- a SHA-256 for the downloaded asset;
- a SHA-256 for the executable after decompression;
- the upstream project and version.

The build verifies existing cache files as well as new downloads. A bad digest, missing offline cache entry, unsupported platform, or old URL/version override stops packaging. Packaged builds do not search `PATH`, Python installations, or dependency folders for these tools. Development builds may use `SOUNDDECK_FFMPEG_PATH`, `SOUNDDECK_YT_DLP_PATH`, or the host toolchain.

FFmpeg publishes source rather than official macOS or Windows executables. The current binary producer is therefore named and pinned in the manifest instead of being treated as an official FFmpeg build. yt-dlp publishes signed checksum manifests; the committed yt-dlp hashes match the upstream release manifest.

To update a native tool:

1. Choose an exact upstream release and inspect its release notes and provenance.
2. Download the exact assets independently. For yt-dlp, verify `SHA2-256SUMS.sig` with the upstream signing key fingerprint `AC0C BBE6 848D 6A87 3464 AF4E 57CF 6593 3B5A 7581`, then verify the selected entry in `SHA2-256SUMS`.
3. Record the compressed asset digest and executable digest in `config/native-tools.json`.
4. Run `pnpm test`, `pnpm run validate:security`, and a platform package build.
5. On macOS, confirm the PKG verification checks both ffmpeg architectures, the universal yt-dlp binary, code signing, Gatekeeper, and notarization. On Windows, confirm the unpacked package hashes and executes both tools.

Relevant upstream guidance:

- [FFmpeg downloads and source verification](https://ffmpeg.org/download.html)
- [yt-dlp release files and checksum verification](https://github.com/yt-dlp/yt-dlp#release-files)
- [electron-builder build lifecycle](https://www.electron.build/docs/features/build-lifecycle/)

## Release flow

The `Release` workflow:

1. installs from the frozen pnpm lockfile with release token variables cleared;
2. runs the security policy, renderer build, and tests;
3. creates the version commit and tag, fast-forwards `prod`, and creates a draft release in one final credentialed step;
4. fetches and verifies native tools before packaging, then forces offline cache verification during Electron Builder;
5. builds without publishing, verifies package contents, and uploads artifacts to the draft in dedicated credentialed steps;
6. writes release notes but leaves the release as a draft.

Before publishing, a maintainer checks that the draft contains both Windows executables, `latest.yml`, the signed and notarized macOS PKG, the macOS ZIP and blockmap, and `latest-mac.yml`. The maintainer then uses GitHub's **Publish release** control. There is no workflow step that promotes the release automatically.

GitHub recommends read-only token permissions by default, full commit-SHA action pins, and credentials scoped to the operation that needs them. Electron Builder documents `releaseType: draft` as its default human promotion gate.

- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)
- [Electron Builder publishing](https://www.electron.build/docs/publish/)
- [Electron Builder GitHub Actions release flow](https://www.electron.build/docs/features/github-actions/)

## Finding disposition at the audited baseline

The audit started from `main` commit `6eb4aeb`. All eight reported findings were valid in that production state. Findings 2 and 3 overlapped and are addressed by the same project-managed ffmpeg path.

### GITHUB_TOKEN exposed to macOS dependency scripts

Valid. The release workflow granted `contents: write` globally and exported `GITHUB_TOKEN` during the macOS dependency install and signed packaging command. The hardened workflow defaults to `contents: read`, clears inherited release token names during installs and builds, and injects the release PAT only into the Git push or release upload/edit step that needs it.

### Unverified macOS ffmpeg binary is packaged and signed

Valid. `scripts/after-pack.cjs` downloaded an environment-selectable `ffmpeg-darwin-{arch}.gz`, trusted an unverified cache entry, and replaced the packaged executable before signing. The hook now installs only manifest entries after verifying the download and executable SHA-256, including cache reuse.

### Unverified ffmpeg binary added to release build

Valid. `ffmpeg-static` ran an allowed lifecycle downloader, was ASAR-unpacked, and was executed by the app. The dependency, lifecycle permission, and ASAR rule are removed. Windows and both macOS architectures now come from the same project-controlled manifest.

### Badge workflow exposes release PAT to mutable actions

Valid. The badge job passed `RELEASE_TOKEN` to checkout and its API script, while action tags were mutable and checkout persisted credentials. The calculation job is read-only, all actions use full commit SHAs, and a separate action-free write job uses `github.token` only for its final Contents API update.

### Release workflow trusts mutable third-party pnpm action

Valid. Release checkout persisted the PAT before tag-based setup actions ran. Actions now use full upstream commit SHAs, every checkout disables credential persistence, and setup/install steps have read-only job permissions.

### Unpinned yt-dlp binary is packaged and executed

Valid. macOS fetched the mutable latest release and trusted its checksum from the same mutable response; Windows packaged the dependency downloader's output. Both platforms now use exact release URLs and committed SHA-256 values. Production discovery has no dependency, Python, or `PATH` fallback.

### Dependabot auto-merge enables supply-chain compromise

Valid. Minor and patch dependency and Actions updates were grouped, approved, and merged by a write-scoped workflow. That workflow is removed. Dependabot still proposes updates after the configured cooldown, but each update follows normal maintainer review and CI requirements.

### Direct public releases weaken auto-update gate

Valid. Electron Builder used `releaseType: release`, so the Windows job could expose an incomplete release before macOS packaging finished. The configuration is restored to `draft`; build and upload are separate; publishing is a documented maintainer action.
