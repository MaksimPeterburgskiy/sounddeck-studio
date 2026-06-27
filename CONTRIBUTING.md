# Contributing to SoundDeck Studio

Thanks for helping improve SoundDeck Studio. This guide covers local setup, branch expectations, and what maintainers look for in pull requests.

## Development setup

Requirements:

- Windows 10/11 or macOS
- Node.js 22.12+
- pnpm 11.6+ via Corepack

```bash
git clone https://github.com/MaksimPeterburgskiy/sounddeck-studio.git
cd sounddeck-studio
corepack enable
pnpm install
pnpm start        # Vite dev server + Electron with hot reload
```

Useful commands:

| Command | What it does |
| --- | --- |
| `pnpm test` | Run the Vitest unit tests |
| `pnpm run build` | Type-check (tsc) and bundle the renderer |
| `pnpm run dist:win` | Build the Windows installer + portable exe into `release/` (downloads VB-CABLE on first run) |
| `pnpm run dist:mac` | Build the signed/notarized macOS package and updater artifacts into `release/` |
| `pnpm run dist:mac:unsigned` | Build an unsigned macOS smoke-test app artifact |

> Some features need real OS services, drivers, or hardware. Test VB-CABLE and NSIS packaging on Windows, BlackHole and notarized PKG packaging on macOS, and hardware-key integrations with the matching device.

## Branch model

- **`main`** is the base branch; all pull requests target `main`.
- **`prod`** is the release branch. Maintainers release by running the *Release* workflow, which versions `main`, fast-forwards `prod`, and publishes a GitHub Release. Never open PRs against `prod`.

## Pull request guidelines

1. Open an issue first for new features or behavior changes, so the approach is clear before you start.
2. Keep PRs small and focused: one logical change per PR.
3. Add or update unit tests for logic in `src/lib/` (board model, hotkey parsing, etc.).
4. Make sure `pnpm run build` and `pnpm test` pass locally; CI runs both on every PR.
5. Describe what changed and why in the PR description, and include screenshots or recordings for UI changes.

All PRs require maintainer review before merging. PRs are squash-merged, so your PR title becomes the commit message; make it descriptive.

## Project layout

```
electron/   Main process (window, tray, hotkeys, library storage, Corsair, auto-update)
src/        Renderer (React + TypeScript)
src/lib/    Pure logic (board model, audio engine, hotkeys, waveforms)
build/      Packaging resources (icons, NSIS script, generated macOS package inputs)
scripts/    Build helper scripts for Windows and macOS packaging
```

## Reporting bugs

Use the [bug report template](https://github.com/MaksimPeterburgskiy/sounddeck-studio/issues/new/choose). Include your operating system, app version, and steps to reproduce. For security issues, use the private reporting process in [SECURITY.md](SECURITY.md).
