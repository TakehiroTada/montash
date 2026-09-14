#!/usr/bin/env bash
# Browser prerequisites: bunx playwright install --with-deps chromium
set -euo pipefail
MONTASH_REPO="${MONTASH_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$MONTASH_REPO"
bun run build:web >/dev/null
bun scripts/e2e-history.ts
