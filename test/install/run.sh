#!/usr/bin/env bash
# The install tests: the connector as a user installs it with npm, in a container with no network (scenario.sh says what
# each checks). A stand-in npm registry serves this checkout's package and npm's last release, and a stand-in for the
# cloud's pairing passes the link to the real brain from this package (standin.mjs). No secret, no model, no account.
#   test/install/run.sh                         upgrade, readme and no-systemd
#   test/install/run.sh readme                  one of them
#   FROM=0.10.0 test/install/run.sh upgrade     upgrade from another release (default: npm's newest that isn't this version)
# Needs podman and npm's registry, from this machine, to fetch the release to upgrade from.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
connector="$(cd "$here/../.." && pwd)"
engine="$(command -v podman || true)"
[[ -n $engine ]] || { echo "install-test: needs podman (systemd as PID 1 is run with --systemd=always)" >&2; exit 1; }
scenarios=("$@")
[[ ${#scenarios[@]} -gt 0 ]] || scenarios=(upgrade readme no-systemd)

work=$(mktemp -d)
ids=()
cleanup() { for id in "${ids[@]}"; do "$engine" rm -f "$id" >/dev/null 2>&1 || true; done; rm -rf "$work"; }
trap cleanup EXIT
mkdir "$work/pkgs"
# This checkout's package, as npm would publish it.
(cd "$connector" && npm run --silent build >/dev/null && npm pack --silent --pack-destination "$work" >/dev/null)
mv "$work"/10and2-*.tgz "$work/pkgs/new.tgz"
version=$(node -p 'require(process.argv[1]).version' "$connector/package.json")
if [[ " ${scenarios[*]} " == *" upgrade "* ]]; then
  from=${FROM:-$(npm view 10and2 versions --json | node -e '
    const v = JSON.parse(require("fs").readFileSync(0, "utf8")), mine = process.argv[1];
    const n = (s) => s.split(/[.-]/).map(Number);
    const older = [].concat(v).filter((x) => /^\d+\.\d+\.\d+$/.test(x) && x !== mine).sort((a, b) => { const [p, q] = [n(a), n(b)]; return p[0] - q[0] || p[1] - q[1] || p[2] - q[2]; });
    console.log(older.at(-1) ?? "")' "$version")}
  [[ -n $from ]] || { echo "install-test: npm has no other release of 10and2 to upgrade from" >&2; exit 1; }
  # Our own package, which a minimum release age in the user's npm settings mustn't hide.
  (cd "$work" && npm pack --silent --min-release-age=0 "10and2@$from" >/dev/null && mv "10and2-$from.tgz" pkgs/old.tgz)
fi

tag="10and2-install:$(sha256sum "$here/Containerfile" | cut -c1-12)"
if ! "$engine" image inspect "$tag" >/dev/null 2>&1; then
  echo "install-test: building $tag" >&2
  "$engine" build -q -t "$tag" -f "$here/Containerfile" "$here" >/dev/null
fi
mounts=(-v "$work/pkgs:/pkgs:ro" -v "$here:/test:ro" -v "$connector/README.md:/readme/README.md:ro")

failed=()
for s in "${scenarios[@]}"; do
  echo "install-test: $s" >&2
  if [[ $s == no-systemd ]]; then
    # A container's usual way: the test is the only process, with no init and no service manager.
    "$engine" run --rm --network=none "${mounts[@]}" "$tag" /test/scenario.sh "$s" || failed+=("$s")
  else
    # systemd as PID 1, as on a Linux desktop or server.
    id=$("$engine" run -d --network=none --systemd=always "${mounts[@]}" "$tag" /sbin/init)
    ids+=("$id")
    "$engine" exec "$id" /test/scenario.sh "$s" || failed+=("$s")
    "$engine" rm -f "$id" >/dev/null
  fi
done
if [[ ${#failed[@]} -gt 0 ]]; then echo "install-test: failed: ${failed[*]}" >&2; exit 1; fi
echo "install-test: all passed (${scenarios[*]})" >&2
