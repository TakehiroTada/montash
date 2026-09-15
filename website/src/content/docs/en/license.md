---
title: License
description: montash's license
---

:::caution[Not settled yet]
montash's `package.json` declares `"license": "MIT"`, but there is
**no `LICENSE` file in the repository yet**.

So the position today is: **MIT is intended**, but not yet stated in a license file.
Adding a `LICENSE` once the copyright holder and year are settled is tracked in the
internal issue list (`docs/13-open-issues.md`, C-8). This page will be updated to match
the file once it exists.
:::

## What is known

| Item | Status |
|------|--------|
| Declaration | `"license": "MIT"` in `package.json` |
| `LICENSE` file | **Missing** (to be added) |
| Repository | [TakehiroTada/montash](https://github.com/TakehiroTada/montash) |

If you are considering a use where the licence terms matter — commercial use or redistribution —
please wait for the `LICENSE` file, or ask in the repository's issues.

## Dependencies

Separately from montash's own licence, it depends on the following.

| Software | Role | Note |
|----------|------|------|
| [ffmpeg / ffprobe](https://ffmpeg.org/) | Encoding, decoding and filtering | **Not bundled with montash** — you install it yourself. ffmpeg's own licence (LGPL or GPL, depending on the libraries in the build) applies to the build you use |
| [Bun](https://bun.sh/) | Runtime and package manager | MIT |

The static build that `scripts/install-deps.sh` installs on Linux / WSL is a **GPL build** (including libx264, libx265 and libass).
If your use involves redistributing the output, check the licence terms of the ffmpeg build you are using.
