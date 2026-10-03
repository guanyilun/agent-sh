#!/bin/bash
# bubblewrap sandbox (see SANDBOX.md):
#   sandbox.sh [--rw DIR]... [--hide PATH]... [--home DIR] [--no-net] [--chdir DIR] -- CMD [ARGS...]
#   sandbox.sh --selftest WRITABLE_DIR [HIDDEN_DIR]
set -euo pipefail
BW="${SBX_BWRAP:-/usr/bin/bwrap}"
[ -x "$BW" ] || { echo "sandbox.sh: bubblewrap not found" >&2; exit 97; }

if [ "${1:-}" = "--selftest" ]; then
  D="$(cd "${2:?usage: sandbox.sh --selftest WRITABLE_DIR [HIDDEN_DIR]}" && pwd)"; me="$(readlink -f "$0")"; bad=0
  H="${3:-}"; [ -n "$H" ] && H="$(readlink -f "$H")"
  set +e
  chk() { if { [ "$2" = ok ] && [ "$1" -eq 0 ]; } || { [ "$2" = fail ] && [ "$1" -ne 0 ]; }; then echo "  ok   $3"; else echo "  FAIL $3"; bad=1; fi; }
  "$me" --rw "$D" -- bash -c "echo x > '$D/.sbx_test' && rm '$D/.sbx_test'" 2>/dev/null; chk $? ok "write inside --rw dir"
  "$me" --rw "$D" -- bash -c "echo x > '$HOME/.sbx_test'" 2>/dev/null; chk $? fail "write to \$HOME refused"
  "$me" --rw "$D" -- bash -c "echo x > /tmp/.sbx_test && test -f /tmp/.sbx_test" 2>/dev/null; chk $? ok "private /tmp writable"
  "$me" --rw "$D" -- bash -c "test ! -e /tmp/.sbx_test" 2>/dev/null; chk $? ok "private /tmp not shared between sandboxes"
  if [ -n "${SBX_ENDPOINT:-}" ]; then
    EPH="$SBX_ENDPOINT"; EP="import socket; socket.create_connection(('${EPH%:*}', ${EPH##*:}), 5)"
    "$me" --rw "$D" -- python3 -c "$EP" >/dev/null 2>&1; chk $? ok "network kept: inference endpoint ${EPH} reachable"
    "$me" --rw "$D" --no-net -- python3 -c "$EP" >/dev/null 2>&1; chk $? fail "--no-net: inference endpoint unreachable"
  fi
  if [ -n "$H" ]; then
    [ -e "$H" ] || { echo "  FAIL hidden path $H does not exist on the host (nothing to test)"; bad=1; }
    case "$H" in /tmp|/tmp/*) echo "  FAIL hidden test path must not be under /tmp (private in every sandbox anyway)"; bad=1 ;; esac
    test -n "$(ls -A "$H" 2>/dev/null)"; chk $? ok "hidden path $H is non-empty on the host (meaningful test)"
    "$me" --rw "$D" --hide "$H" -- bash -c "test -z \"\$(ls -A '$H' 2>/dev/null)\" && ! grep -rqs . '$H'" 2>/dev/null; chk $? ok "--hide: $H is empty/unreadable inside"
    "$me" --rw "$D" --hide "$H" -- bash -c "echo x > '$H/.sbx_test'" 2>/dev/null; chk $? fail "--hide: masked path is read-only inside"
    test ! -e "$H/.sbx_test"; chk $? ok "--hide: host copy untouched"
  fi
  rm -f "$HOME/.sbx_test" 2>/dev/null || true
  [ $bad -eq 0 ] && echo "sandbox selftest ok" || { echo "sandbox selftest FAILED"; exit 1; }
  exit 0
fi

args=(--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-pid --die-with-parent --new-session
      --setenv SBX_SANDBOXED 1 --setenv SBX_SANDBOX_KIND bubblewrap --setenv TMPDIR /tmp --setenv XDG_CACHE_HOME /tmp/.cache)
chdir=""; hides=()
while [ $# -gt 0 ]; do
  case "$1" in
    --rw) d="$(readlink -f "$2")"; mkdir -p "$d"; args+=(--bind "$d" "$d"); shift 2 ;;
    --hide) hides+=("$(readlink -f "$2")"); shift 2 ;;
    --home) h="$(readlink -f "$2")"; args+=(--bind "$h" "$h")
            for ro in settings.json keys.json extensions agents workflows; do
              # symlinks (keys.json -> ~/.agent-sh/keys.json) already resolve onto the read-only host
              [ -e "$h/$ro" ] && [ ! -L "$h/$ro" ] && args+=(--ro-bind "$h/$ro" "$h/$ro")
            done; shift 2 ;;
    --no-net) args+=(--unshare-net); shift ;;
    --chdir) chdir="$(readlink -f "$2")"; shift 2 ;;
    --) shift; break ;;
    *) echo "sandbox.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
# hidden paths last, so they also mask anything a --rw bind exposed
for hp in "${hides[@]}"; do
  if [ -d "$hp" ]; then args+=(--tmpfs "$hp" --remount-ro "$hp"); elif [ -e "$hp" ]; then args+=(--ro-bind /dev/null "$hp"); fi
done
[ $# -gt 0 ] || { echo "sandbox.sh: no command" >&2; exit 2; }
args+=(--chdir "${chdir:-$(pwd)}")
exec "$BW" "${args[@]}" -- "$@"
