#!/usr/bin/env bash
# The harness tests: each coding-agent CLI the connector supports (Claude Code, Codex, OpenCode, Pi), for real, in a
# container with no network, against a deterministic fake model (test/fixtures/mock-model.mjs). Each test drives the
# CLI's terminal UI in tmux and the connector's adapter for it: list, read, follow up idle, steer busy, continue a closed
# session, start work, answer a question where the CLI asks one.
#   test/harness/run.sh                 every harness (npm run test:harness)
#   test/harness/run.sh codex           one: test/harness/codex.harness.ts
# Needs podman (or docker). The image is built once per Containerfile (pinned CLI versions) and reused.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
engine="$(command -v podman || command -v docker || true)"
[[ -n $engine ]] || { echo "harness: needs podman or docker" >&2; exit 1; }
tag="10and2-harness:$(sha256sum "$here/Containerfile" | cut -c1-12)"
if ! "$engine" image exists "$tag" 2>/dev/null && ! "$engine" image inspect "$tag" >/dev/null 2>&1; then
  echo "harness: building $tag" >&2
  "$engine" build -q -t "$tag" -f "$here/Containerfile" "$here" >/dev/null
fi
[[ -d $repo/connector/node_modules ]] || (cd "$repo/connector" && npm ci --silent)
files=()
if [[ $# -gt 0 ]]; then for h in "$@"; do files+=("test/harness/$h.harness.ts"); done
else for f in "$here"/*.harness.ts; do files+=("test/harness/$(basename "$f")"); done; fi
# Read-only sources; everything a test writes goes to the container's own /tmp. No network: nothing can reach a real model.
exec "$engine" run --rm --network=none --init \
  -v "$repo/connector:/work/connector:ro" -v "$repo/brain/src:/work/brain/src:ro" \
  "$tag" node --test --test-concurrency=1 "${files[@]}"
