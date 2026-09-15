---
title: License
description: montash's license and third-party notices
---

montash is released under the **MIT License**.

- [LICENSE](https://github.com/TakehiroTada/montash/blob/main/LICENSE) — Copyright (c) 2026 Takehiro Tada
- [THIRD-PARTY-NOTICES.md](https://github.com/TakehiroTada/montash/blob/main/THIRD-PARTY-NOTICES.md) — the software montash depends on

## About ffmpeg (important)

montash delegates all encoding and decoding to **ffmpeg / ffprobe**, but it does **not bundle ffmpeg**. It only launches ffmpeg as a separate process at runtime; it does not link against it as a library. montash itself therefore stays MIT.

However, **the ffmpeg build you install carries its own license**.

| How you install it | What you get | License |
|---|---|---|
| `scripts/install-deps.sh` (macOS) | Homebrew's `ffmpeg-full` | effectively **GPL** (it includes libx264) |
| `scripts/install-deps.sh` (Linux / WSL) | a GPL static build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | **GPL-3.0 or later** |
| Your own build | anything | whatever that build says |

**If you redistribute that ffmpeg binary, the GPL terms apply to it.** To use your own ffmpeg instead, pass `--ffmpeg-path` or set `MONTASH_FFMPEG` (`montash doctor` checks that the required features are present).

See [ffmpeg.org/legal.html](https://ffmpeg.org/legal.html) for ffmpeg's own licensing.

## Runtime and dependencies

| Software | Role | License |
|---|---|---|
| [Bun](https://bun.sh/) | runtime / package manager / test runner / bundler | MIT (not bundled; montash uses the one on your machine) |
| yargs / zod / chokidar / react / react-dom / zustand | CLI and web implementation | MIT |
| TypeScript / Playwright | type checking and browser E2E (development only) | Apache-2.0 |
| Biome | lint and format (development only) | MIT OR Apache-2.0 |

Across all 37 npm packages including transitive dependencies: **28 MIT / 4 ISC / 3 Apache-2.0 / 2 MIT OR Apache-2.0**. None are copyleft (GPL / LGPL / AGPL). The full list lives in [THIRD-PARTY-NOTICES.md](https://github.com/TakehiroTada/montash/blob/main/THIRD-PARTY-NOTICES.md) and can be regenerated with `bun run licenses`.

## This site

Built with [Astro](https://astro.build/) (MIT) and [Starlight](https://starlight.astro.build/) (MIT).
