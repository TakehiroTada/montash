---
title: Contributing
description: How to work on montash
---

montash is developed at [TakehiroTada/montash](https://github.com/TakehiroTada/montash).

## Setting up

```bash
git clone https://github.com/TakehiroTada/montash.git
cd montash
bash scripts/install-deps.sh --with-fonts     # ffmpeg, Bun, CJK fonts
bun install
bun run doctor                                # check the environment
```

You can run the CLI without compiling it.

```bash
bun run dev -C ./my-edit timeline show        # same as montash timeline show
bun run dev -C ./my-edit serve --dev          # develop the web UI with HMR
```

## Passing the checks

**Run `bun run check` before opening a PR.** It is what CI runs: typecheck, lint and tests.

```bash
bun run check         # = typecheck + lint + test
bun run typecheck     # tsc --noEmit
bun run lint          # Biome (lint and format check)
bun run lint:fix      # apply fixes
bun test              # unit tests
```

### End-to-end tests

```bash
bunx playwright install --with-deps chromium   # first time only
bash tests/workflows/run-all.sh                # verify the implemented workflows (W-01 …)
bun run e2e:preview                            # preview end-to-end test
```

## Technical ground rules

- **Bun is the only runtime.** CI runs typecheck and lint with `node` neutralized on `PATH`, so anything that reaches for Node fails the build
- TypeScript in strict mode; lint and formatting with [Biome](https://biomejs.dev/)
- Dependencies: yargs (CLI), zod (schemas), chokidar (file watching), React 19 + zustand + canvas (web UI)
- The reasoning behind these choices, with measurements, is in `docs/12-tech-decisions.md`

:::note[The docs site is the one exception]
The Astro + Starlight site under `website/` needs a Node-based toolchain.
Packages are managed with bun (`bun install`), but Astro itself runs on Node.
The site is **not part of CI**.
:::

## Repository layout

| Directory | Contents |
|-----------|----------|
| `src/cli/` | CLI command implementations — one file per command, registered in `src/cli/commands/registry.ts` |
| `src/` | The core: project model, history, ffmpeg integration |
| `web/` | The browser UI (React 19 + canvas) |
| `tests/` | Unit tests and workflow end-to-end tests |
| `scripts/` | Dependency installation, fixtures, end-to-end scripts |
| `docs/` | **Internal specifications for developers** (chapters 01–13) |
| `website/` | **The user-facing documentation site** (this site) |

The internal specs under `docs/` are a separate thing from this site. Design rationale,
ffmpeg mappings and everything else you need while implementing lives there.

## Adding a command

1. Create a file under `src/cli/commands/` and define the command with `defineCommand()`
2. Add one line to `src/cli/commands/registry.ts` (kept in the order of `docs/04-cli-spec.md`)
3. Confirm it shows up in `montash schema --json`
4. Regenerate this site's CLI reference

```bash
cd website && bun run gen:cli
```

The CLI reference is generated from `montash schema --json`, so **there is nothing to write by hand**.
Do commit the generated files (`website/src/content/docs/{ja,en}/reference/cli.md`).

## Opening a PR

1. Branch from `main`
2. Keep it to a reviewable size — do not pile several things into one PR
3. Make `bun run check` pass
4. Open the PR and check that CI is green
5. Review it yourself and fix what you notice

Repository-specific conventions, such as the commit message trailers, are in `AGENTS.md`.

## Working on the documentation site

```bash
cd website
bun install
bun run dev              # http://localhost:4321
bun run build            # astro check + astro build
bun run preview
bun run gen:cli          # regenerate the CLI reference
```

**Update both the Japanese and the English page.** The structure and how to add a translation are described in `website/README.md`.
