#!/usr/bin/env bash
# One install test, run as root inside the container (run.sh starts it), with the user's steps run as the user `node`
# in a login shell, as typed. The package under test is /pkgs/new.tgz; the last npm release is /pkgs/old.tgz.
#   upgrade      the last release installed with npm and set up (a systemd service, the credential), then
#                `npm install -g 10and2` to the new one: the credential and the service are kept, and it reconnects
#   readme       the commands in connector/README.md's first section, exactly as written, on a fresh machine
#   no-systemd   setup in a container without systemd: it connects, says how to keep it running, and leaves nothing broken
set -uo pipefail
scenario=$1
failed=0
check() { local what=$1; shift; if "$@"; then echo "  ✓ $what"; else echo "  ✗ $what"; failed=1; fi; }
say() { echo "install-test ($scenario): $*"; }
version_of() { tar -xzOf "$1" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version'; }
new=$(version_of /pkgs/new.tgz)
old=$([[ -f /pkgs/old.tgz ]] && version_of /pkgs/old.tgz || echo "")

user_env=(HOME=/home/node USER=node LOGNAME=node SHELL=/bin/bash PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8)
systemd=false
[[ $scenario != no-systemd ]] && systemd=true
$systemd && user_env+=(XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus)
# A command as the user types it; its output in $out and its exit status in $code, both shown.
run() {
  out=$(cd /home/node && runuser -u node -- env -i "${user_env[@]}" bash -lc "$1" </dev/null 2>&1)
  code=$?
  printf '  $ %s   (exit %s)\n%s\n' "$1" "$code" "$(sed 's/^/      /' <<<"$out")"
}
has() { grep -qF -- "$1" <<<"$out"; }
lacks() { ! grep -qF -- "$1" <<<"$out"; }
is() { [[ $1 == "$2" ]]; }
CONFIG=/home/node/.config/10and2
UNIT=/home/node/.config/systemd/user/10and2.service
STATUS=/home/node/.local/state/10and2/status.json
# The connector says it's linked, as this version, within 30 s.
linked() {
  for _ in $(seq 150); do
    node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(s.linked && s.version === process.argv[2] ? 0 : 1)' "$STATUS" "$1" 2>/dev/null && return 0
    sleep 0.2
  done
  echo "    status.json: $(cat "$STATUS" 2>/dev/null || echo none)"; return 1
}
credential() { sha256sum "$CONFIG/credentials.json" 2>/dev/null | cut -c1-64; }
service() { runuser -u node -- env -i "${user_env[@]}" systemctl --user "$@" 10and2.service 2>/dev/null; }
# Every file the service runs is there (an upgrade can remove what it named: docs/launch/ci.md, 20 November).
runs_what_exists() {
  local exec; exec=$(sed -n 's/^ExecStart=//p' "$UNIT")
  for a in $exec; do a=${a//\"/}; [[ $a == /* && ! -e $a ]] && { echo "    the service runs $a, which isn't there"; return 1; }; done; return 0
}

# --- the stand-ins (standin.mjs), and the user's systemd ---
mkdir -p /run/standin
echo "127.0.0.1 10and2.selfdep.com" >> /etc/hosts
# npm's `latest`: the release to upgrade from, else the package under test.
if [[ $scenario == upgrade ]]; then echo "$old"; else echo "$new"; fi > /run/standin/latest
node /test/standin.mjs >/run/standin/standin.log 2>&1 &
for _ in $(seq 300); do [[ -f /run/standin/ready ]] && break; sleep 0.2; done
[[ -f /run/standin/ready ]] || { say "the stand-ins didn't start"; cat /run/standin/standin.log /run/standin/brain.log 2>/dev/null; exit 1; }
if $systemd; then
  for _ in $(seq 300); do [[ -S /run/user/1000/bus ]] && break; sleep 0.2; done
  [[ -S /run/user/1000/bus ]] || { say "the user's systemd didn't start"; systemctl status user@1000.service --no-pager; exit 1; }
fi

case $scenario in
upgrade)
  say "from $old (npm's last release) to $new (this checkout)"
  run "npm install -g 10and2"
  check "npm installs $old" is "$code" 0
  run "10and2 version"
  check "10and2 version says $old" is "$out" "$old"
  run "10and2 setup"
  check "setup ends well" is "$code" 0
  check "setup says it's approved" has "Approved"
  check "setup says it starts at login" has "Starts at login"
  check "setup says it's connected" has "Connected"
  check "it's linked, as $old" linked "$old"
  check "the service is running" is "$(service is-active)" active
  before=$(credential)
  check "the credential is in a file only the user can read" is "$(stat -c %a "$CONFIG/credentials.json")" 600

  echo "$new" > /run/standin/latest
  run "npm install -g 10and2"
  check "npm upgrades it to $new" is "$code" 0
  run "10and2 version"
  check "10and2 version says $new" is "$out" "$new"
  check "the credential is kept" is "$(credential)" "$before"
  check "the service is still set to start at login" is "$(service is-enabled)" enabled
  run "10and2 status"
  check "status ends well" is "$code" 0
  check "status says it starts at login" has "Starts at login"
  check "every file the service runs is there" runs_what_exists
  # The connector that was running carries on until the service starts again: at the next login, or now.
  service restart
  check "after a restart it's linked again, as $new" linked "$new"
  run "10and2 status"
  check "status says it's connected" has "Connected to"
  check "the credential is still the same" is "$(credential)" "$before"
  ;;

readme)
  say "connector/README.md's first section, as written ($new)"
  # Every line of the ```sh blocks before the README's first ## heading, in order.
  mapfile -t lines < <(awk '/^## /{exit} /^```sh$/{on=1; next} /^```$/{on=0; next} on && NF' /readme/README.md)
  check "the README starts with npm install and setup" is "${lines[0]:-} | ${lines[1]:-}" "npm install -g 10and2 | 10and2 setup"
  for line in "${lines[@]}"; do
    run "$line"
    words=$(awk '{print $1, $2}' <<<"$line")
    case $words in
      "npm install") check "npm installs it" is "$code" 0 ;;
      "10and2 setup")
        check "setup ends well" is "$code" 0
        check "setup says it's connected" has "Connected"
        check "it's linked, as $new" linked "$new"
        check "the service is running" is "$(service is-active)" active ;;
      "10and2 status")
        check "status ends well" is "$code" 0
        check "status says it's connected" has "Connected to"
        check "status says it starts at login" has "Starts at login" ;;
      "10and2 agents")
        check "agents ends well" is "$code" 0
        check "agents saves the choice" has "Saved"
        check "agents restarts the connector" has "restarted" ;;
      "10and2 revoke")
        check "revoke ends well" is "$code" 0
        check "revoke says it's disconnected" has "Disconnected"
        check "the cloud was told" grep -q "cloud: revoke$" /run/standin/events
        check "the credential is gone" bash -c "! grep -q 10and2.selfdep.com $CONFIG/credentials.json 2>/dev/null"
        check "it no longer starts at login" test ! -e "$UNIT" ;;
      "10and2 uninstall")
        check "uninstall ends well" is "$code" 0
        check "uninstall says how to remove the program" has "npm uninstall -g 10and2"
        check "its settings and key are gone" test ! -e "$CONFIG"
        check "nothing starts at login" test ! -e "$UNIT" ;;
      "10and2 help")
        check "help ends well" is "$code" 0
        check "help lists setup" has "10and2 setup" ;;
      *) check "a line this test knows how to judge: $line" false ;;
    esac
  done
  ;;

no-systemd)
  say "setup without systemd ($new)"
  check "there's no systemd user session here" bash -c "! runuser -u node -- systemctl --user is-system-running >/dev/null 2>&1"
  run "npm install -g 10and2"
  check "npm installs it" is "$code" 0
  run "10and2 setup"
  check "setup ends well" is "$code" 0
  check "setup says it's approved" has "Approved"
  check "setup says how to keep it connected" has "10and2 run"
  check "setup doesn't leave a service behind" test ! -e "$UNIT"
  check "the credential is saved" test -s "$CONFIG/credentials.json"
  # What setup says to do: run it in a terminal kept open.
  runuser -u node -- env -i "${user_env[@]}" bash -lc "10and2 run" >/tmp/run.log 2>&1 &
  check "10and2 run links, as $new" linked "$new"
  run "10and2 status"
  check "status ends well" is "$code" 0
  check "status says it's connected" has "Connected to"
  check "status doesn't claim it starts at login" lacks "Starts at login"
  run "10and2 autostart on"
  check "autostart on says why it can't, in words" has "systemd"
  ;;
*) say "no such scenario"; exit 64 ;;
esac

if [[ $failed != 0 ]]; then
  echo "  what the stand-ins saw:"; sed 's/^/    /' /run/standin/events
  echo "  the brain's log (last 20 lines):"; tail -20 /run/standin/brain.log | sed 's/^/    /'
fi
exit "$failed"
