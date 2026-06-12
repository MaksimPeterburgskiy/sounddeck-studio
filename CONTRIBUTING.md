# Contributing to SoundDeck Studio

Thanks for your interest in contributing! This document explains how the project is set up and what to expect when you open a pull request.

## Development setup

Requirements: **Windows 10/11** and **Node.js 20+**.

```bash
git clone https://github.com/MaksimPeterburgskiy/sounddeck-studio.git
cd sounddeck-studio
npm install
npm start        # Vite dev server + Electron with hot reload
```

Other useful commands:

| Command | What it does |
| --- | --- |
| `npm test` | Run the Vitest unit tests |
| `npm run build` | Type-check (tsc) and bundle the renderer |
| `npm run dist` | Build the Windows installer + portable exe into `release/` (downloads VB-CABLE on first run) |

> **Note:** Some features (virtual mic routing, the NSIS installer's VB-CABLE setup, Corsair G-keys) need real hardware/drivers and can only be fully tested on Windows.

## Branch model

- **`main`** is the base branch; all pull requests target `main`.
- **`prod`** is the release branch. Maintainers release by running the *Release* workflow, which versions `main`, fast-forwards `prod`, and publishes a GitHub Release. Never open PRs against `prod`.

## Pull request guidelines

1. **Open an issue first** for anything non-trivial (new features, behavior changes), so we can agree on the approach before you invest time.
2. Keep PRs **small and focused**: one logical change per PR.
3. Add or update **unit tests** for logic in `src/lib/` (board model, hotkey parsing, etc.).
4. Make sure `npm run build` and `npm test` pass locally; CI runs both on every PR.
5. Describe **what** changed and **why** in the PR description, and include screenshots/recordings for UI changes.

All PRs require maintainer review before merging. PRs are squash-merged, so your PR title becomes the commit message; make it descriptive.

## Project layout

```
electron/   Main process (window, tray, hotkeys, library storage, Corsair, auto-update)
src/        Renderer (React + TypeScript)
src/lib/    Pure logic: board model, audio engine, hotkeys, waveforms (unit-tested)
build/      Packaging resources (icon, NSIS script; VB-CABLE is fetched at build time)
scripts/    Build helper scripts
```

## Reporting bugs

Use the [bug report template](https://github.com/MaksimPeterburgskiy/sounddeck-studio/issues/new/choose). Include your Windows version, app version, and steps to reproduce. For security issues, please see [SECURITY.md](SECURITY.md) instead of opening a public issue.
