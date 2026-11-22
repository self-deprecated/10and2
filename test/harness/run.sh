#!/usr/bin/env bash
# The harness tests: each coding-agent CLI the connector supports (Claude Code, Codex, OpenCode, Pi, T3 Code), for real, in a
# container with no network, against a deterministic fake model (test/fixtures/mock-model.mjs). Each test drives the
# CLI's terminal UI in tmux and the connector's adapter for it: list, read, follow up idle, steer busy, continue a closed
# session, start work, answer a question where the CLI asks one.
#   test/harness/run.sh                 every harness (bun run test:harness)
#   test/harness/run.sh codex           one: test/harness/codex.harness.ts (also claude, opencode, pi, t3, gemini, copilot)
#   CODEX=0.160.0 test/harness/run.sh codex
#                                       another version of a CLI (CLAUDE_CODE, CODEX, OPENCODE, PI, T3, GEMINI, COPILOT), for finding the
#                                       oldest each feature works with (src/versions.ts); each subtest is one feature
#   HARNESS_CONCURRENCY=1 test/harness/run.sh
#                                       one test file at a time (two by default)
# Needs podman (or docker). The image is built once per Containerfile (pinned CLI versions) and reused; another
# version is a layer over it, also reused.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
engine="$(command -v podman || command -v docker || true)"
[[ -n $engine ]] || { echo "harness: needs podman or docker" >&2; exit 1; }
have() { "$engine" image exists "$1" 2>/dev/null || "$engine" image inspect "$1" >/dev/null 2>&1; }
# A build that stalls is stopped and tried once more: on CI one sat in a download for the job's whole 45 minutes (21
# November). A build takes under a minute there; HARNESS_BUILD_TIMEOUT allows a slow first one elsewhere.
build() {
  local tag=$1 file=$2 try
  local stop=(); command -v timeout >/dev/null && stop=(timeout -k 30s "${HARNESS_BUILD_TIMEOUT:-10m}")
  for try in 1 2; do
    ${stop[@]+"${stop[@]}"} "$engine" build -q -t "$tag" -f "$file" "$here" >/dev/null && return 0
    echo "harness: building $tag failed or stalled (try $try of 2)" >&2
  done
  return 1
}
tag="10and2-harness:$(sha256sum "$here/Containerfile" | cut -c1-12)"
if ! have "$tag"; then
  echo "harness: building $tag" >&2
  build "$tag" "$here/Containerfile"
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
[[ -n ${GEMINI:-} ]] && steps+=("npm install -g --no-fund --no-audit @google/gemini-cli@$GEMINI")
[[ -n ${COPILOT:-} ]] && steps+=("npm install -g --no-fund --no-audit @github/copilot@$COPILOT")
if [[ ${#steps[@]} -gt 0 ]]; then
  layer="$(printf 'FROM %s\nUSER root\n' "$tag"; for s in "${steps[@]}"; do printf 'RUN %s && npm cache clean --force\n' "$s"; done
    printf 'USER node\n'; if [[ -n ${T3:-} ]]; then printf 'RUN rm -rf ~/.t3 && t3 --version\n'; fi
    if [[ -n ${COPILOT:-} ]]; then printf 'RUN copilot --version\n'; fi)"
  tag="$tag-$(printf '%s' "$layer" | sha256sum | cut -c1-12)"
  if ! have "$tag"; then
    echo "harness: building $tag (${CLAUDE_CODE:+claude-code $CLAUDE_CODE }${CODEX:+codex $CODEX }${OPENCODE:+opencode $OPENCODE }${PI:+pi $PI }${T3:+t3 $T3 }${GEMINI:+gemini $GEMINI }${COPILOT:+copilot $COPILOT})" >&2
    containerfile="$(mktemp)"; trap 'rm -f "$containerfile"' EXIT
    printf '%s\n' "$layer" > "$containerfile"
    build "$tag" "$containerfile"; rm -f "$containerfile"
  fi
fi
# The tests run on the container's Node; the packages only have to be there. Bun's install where there's Bun, npm's elsewhere.
[[ -d $repo/connector/node_modules ]] || (cd "$repo/connector" && if command -v bun >/dev/null; then bun ci --silent; else npm ci --silent --no-audit --no-fund; fi)
files=()
if [[ $# -gt 0 ]]; then for h in "$@"; do files+=("test/harness/$h.harness.ts"); done
else for f in "$here"/*.harness.ts; do files+=("test/harness/$(basename "$f")"); done; fi
# Read-only sources; everything a test writes goes to the container's own /tmp. No network: nothing can reach a real model.
# Two files at a time, which halves the time: each has its own tmux server, fake model (on a free port), homes and
# state, and only T3's uses its fixed port and ~/.t3. Three at once made Codex's plan-mode test time out once.
exec "$engine" run --rm --network=none --init \
  -v "$repo/connector:/work/connector:ro" -v "$repo/brain/src:/work/brain/src:ro" \
  "$tag" node --test --test-concurrency="${HARNESS_CONCURRENCY:-2}" "${files[@]}"
