#!/usr/bin/env bash
# The harness tests: each coding-agent CLI the connector supports (Claude Code, Codex, OpenCode, Pi, T3 Code), for real, in a
# container with no network, against a deterministic fake model (test/fixtures/mock-model.mjs). Each test drives the
# CLI's terminal UI in tmux and the connector's adapter for it: list, read, follow up idle, steer busy, continue a closed
# session, start work, answer a question where the CLI asks one.
#   test/harness/run.sh                 every harness (npm run test:harness)
#   test/harness/run.sh codex           one: test/harness/codex.harness.ts
#   CODEX=0.160.0 test/harness/run.sh codex
#                                       another version of a CLI (CLAUDE_CODE, CODEX, OPENCODE, PI, T3), for finding the
#                                       oldest each feature works with (src/versions.ts); each subtest is one feature
# Needs podman (or docker). The image is built once per Containerfile (pinned CLI versions) and reused; another
# version is a layer over it, also reused.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
engine="$(command -v podman || command -v docker || true)"
[[ -n $engine ]] || { echo "harness: needs podman or docker" >&2; exit 1; }
have() { "$engine" image exists "$1" 2>/dev/null || "$engine" image inspect "$1" >/dev/null 2>&1; }
tag="10and2-harness:$(sha256sum "$here/Containerfile" | cut -c1-12)"
if ! have "$tag"; then
  echo "harness: building $tag" >&2
  "$engine" build -q -t "$tag" -f "$here/Containerfile" "$here" >/dev/null
fi
# Pi was @mariozechner/pi-coding-agent before 0.74.0; both install `pi`, so the pinned one goes first.
steps=()
[[ -n ${CLAUDE_CODE:-} ]] && steps+=("npm install -g --no-fund --no-audit @anthropic-ai/claude-code@$CLAUDE_CODE")
[[ -n ${CODEX:-} ]] && steps+=("npm install -g --no-fund --no-audit @openai/codex@$CODEX")
[[ -n ${OPENCODE:-} ]] && steps+=("npm install -g --no-fund --no-audit opencode-ai@$OPENCODE && cd /opt/opencode-config && npm install --no-fund --no-audit --save-exact @opencode-ai/plugin@$OPENCODE")
if [[ -n ${PI:-} ]]; then
  pkg=@earendil-works/pi-coding-agent
  [[ $(printf '%s\n' "$PI" 0.74.0 | sort -V | head -1) != 0.74.0 ]] && pkg=@mariozechner/pi-coding-agent
  steps+=("npm uninstall -g @earendil-works/pi-coding-agent && npm install -g --no-fund --no-audit $pkg@$PI")
fi
# T3 Code's npm package downloads its executable into ~/.t3 on first run, so that's done while there's network.
[[ -n ${T3:-} ]] && steps+=("npm install -g --no-fund --no-audit t3@$T3")
if [[ ${#steps[@]} -gt 0 ]]; then
  layer="$(printf 'FROM %s\nUSER root\n' "$tag"; for s in "${steps[@]}"; do printf 'RUN %s && npm cache clean --force\n' "$s"; done
    printf 'USER node\n'; if [[ -n ${T3:-} ]]; then printf 'RUN rm -rf ~/.t3 && t3 --version\n'; fi)"
  tag="$tag-$(printf '%s' "$layer" | sha256sum | cut -c1-12)"
  if ! have "$tag"; then
    echo "harness: building $tag (${CLAUDE_CODE:+claude-code $CLAUDE_CODE }${CODEX:+codex $CODEX }${OPENCODE:+opencode $OPENCODE }${PI:+pi $PI }${T3:+t3 $T3})" >&2
    printf '%s\n' "$layer" | "$engine" build -q -t "$tag" -f - "$here" >/dev/null
  fi
fi
[[ -d $repo/connector/node_modules ]] || (cd "$repo/connector" && npm ci --silent)
files=()
if [[ $# -gt 0 ]]; then for h in "$@"; do files+=("test/harness/$h.harness.ts"); done
else for f in "$here"/*.harness.ts; do files+=("test/harness/$(basename "$f")"); done; fi
# Read-only sources; everything a test writes goes to the container's own /tmp. No network: nothing can reach a real model.
exec "$engine" run --rm --network=none --init \
  -v "$repo/connector:/work/connector:ro" -v "$repo/brain/src:/work/brain/src:ro" \
  "$tag" node --test --test-concurrency=1 "${files[@]}"
