#!/bin/sh
# The nibblet's Chromium. Inside a container Chromium can't use its own
# sandbox (the container is the sandbox), and --test-type hides the warning
# bar --no-sandbox would bring. Closing the last tab quits Chromium, which
# would end the browser for both the nibblet and whoever's watching, so it's
# started again on a blank page. Ending the session (SIGTERM) stops it for good.
set -u
child=""
stop() {
  [ -n "$child" ] && kill "$child" 2>/dev/null
  exit 0
}
trap stop TERM INT HUP

run() {
  /usr/bin/chromium --no-sandbox --test-type "$@" &
  child=$!
  wait "$child"
}

# Restarts keep the flags it was started with (OpenComputerUse passes the
# Wayland ones) but not the pages, which open fresh on about:blank.
only_flags() {
  for a in "$@"; do
    case "$a" in
      (--*) printf '%s\n' "$a" ;;
    esac
  done
}
flags=$(only_flags "$@")
nl='
'

run "$@"
quick=0
while :; do
  started=$(date +%s)
  IFS=$nl
  # shellcheck disable=SC2086 # one flag per line, split on newlines only
  run $flags about:blank
  unset IFS
  # Five crashes within a few seconds each: something's wrong; stop trying.
  if [ $(( $(date +%s) - started )) -lt 5 ]; then
    quick=$((quick + 1))
    [ "$quick" -ge 5 ] && exit 1
    sleep 1
  else
    quick=0
  fi
done
