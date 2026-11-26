# Contributing to Clipy

Thanks for helping. This repository holds the packages that turn a screen recording into an AREC
file on your own machine, and the Clipy desktop app built from them.

## Ways to help

- Pick an issue labelled `good first issue` or `help wanted`. Comment on it
  first so two people do not build the same thing.
- Report a bug with the bug template. A short screen recording of the problem
  helps a lot.
- Suggest a feature with the feature template, starting from the problem you
  want solved.
- Improve the docs. Small fixes are welcome without an issue.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Layout

| Path | What it is | Tooling |
|---|---|---|
| `packages/moments` | Picks the moments worth a screenshot | TypeScript, Vitest |
| `packages/config` | Provider and transcription settings | TypeScript, Vitest |
| `packages/capture` | Screen capture with ffmpeg | TypeScript, Vitest |
| `packages/transcribe` | Speech to timestamped segments | TypeScript, Vitest |
| `desktop/` | The Clipy desktop app | Tauri 2 (Rust) and React |

The packages form one pnpm workspace at the root. `desktop/` is its own pnpm
project with its own lockfile.

## Packages

You need Node.js 20.19 or newer and pnpm (the version in `package.json`,
`packageManager`; `corepack enable` picks it up).

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

The capture package's real-recording tests run only on Linux with Xvfb and an
ffmpeg that has x11grab and libx264 (`sudo apt-get install ffmpeg xvfb xauth
libxtst6`); elsewhere they are skipped and the rest of the suite still runs.
The other packages run anywhere.

`packages/moments/src/generated/` is generated from the code the hosted
Clipy uses, so both pick moments the same way. Propose changes to it in a
pull request as usual; a maintainer applies the change at its source so the
next sync keeps it.

## Desktop app

You need Rust 1.88 or newer, Node.js 20.19 or newer and pnpm. On macOS, Xcode or
the Command Line Tools. On Windows, Visual Studio Build Tools with the C++
workload and a shared FFmpeg 7 build with `FFMPEG_DIR` pointing at it. Full
build notes are in [desktop/README.md](desktop/README.md).

```bash
cd desktop
pnpm install --frozen-lockfile
pnpm tauri:icon
pnpm setup:native-deps            # macOS: downloads the FFmpeg framework
pnpm exec tsc --noEmit
bash scripts/test-rust.sh --locked --lib
node --test scripts/desktop-packaging.test.mjs scripts/speech-permissions.test.mjs
pnpm tauri:dev                    # run the desktop app
```

The crates in `desktop/src-tauri/crates/` have their own `cargo test`.

## Pull requests

- Keep each pull request to one change. Say what it does and how you tested
  it. Screenshots or a short recording help for anything visible.
- CI runs the package tests on Linux, the desktop tests on macOS, and a
  compile check on Windows. Run the relevant
  ones locally first.
- Keep the privacy promise: with no model provider and on-device
  transcription, nothing leaves the machine. A change that sends data
  anywhere new needs a line in the "Where your data goes" table of the
  README.
- Do not add telemetry, analytics or calls to any Clipy service.
- New dependencies need a reason in the pull request. Prefer small, widely
  used crates and packages with a licence compatible with Apache-2.0.

## Licence and sign-off

This repository is licensed under Apache-2.0. By opening a pull request you agree
that your contribution is licensed under the same terms (section 5 of the
licence). There is no contributor licence agreement and no sign-off line to
add.

## Hiring

We also use real issues from this repository in our hiring process.
Candidates work on distinct issues in their own forks, and shortlisted
candidates open pull requests here like anyone else, under the
`hiring-cohort` label. Everyone's contribution is reviewed the same way.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
