#!/usr/bin/env bash
# -------------------------------------------------------------------------------------------------
# ops/devnet/down.sh — stop this checkout's recorded devnet anvil. Refuses other listeners.
#
#   ops/devnet/down.sh                 stop the anvil listening on DEVNET_PORT (default 8546)
#   ops/devnet/down.sh --clean         also delete this run's files: addresses.json, tier1.devnet.json,
#                                      env/ and state/ (state dump, logs)
#   DEVNET_PORT=8547 ops/devnet/down.sh
#
# up.sh starts anvil in its own session and process group and records its pid, port and start
# time in state/anvil.pid. This stops only that process group (TERM, then KILL after 5 s),
# and exits 1 if the process identity differs or the port remains busy afterwards.
# -------------------------------------------------------------------------------------------------
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PORT=${DEVNET_PORT:-8546}
PID_FILE="$HERE/state/anvil.pid"
CLEAN=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "down.sh: unknown argument $arg" >&2; exit 2 ;;
  esac
done
say() { [ "$QUIET" = 1 ] || echo "$@"; }

is_anvil() { # pid -> 0 when the process is anvil
  local comm
  comm=$(ps -p "$1" -o comm= 2>/dev/null || true)
  case "$comm" in *anvil*) return 0 ;; *) return 1 ;; esac
}
process_start() { ps -p "$1" -o lstart= 2>/dev/null | awk '{$1=$1; print}'; }

port_busy() { # -> 0 while something listens on the port
  if command -v lsof >/dev/null; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
  fi
}

stop_pid() { # pid -> 0 once it is gone. up.sh's anvil leads its own process group (pgid = pid): signal
  # the group. An anvil started some other way may share its group with a shell: signal the pid only.
  local pid=$1 target=$1
  [ "$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ')" = "$pid" ] && target="-$pid"
  kill -TERM -- "$target" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.1; done
  kill -KILL -- "$target" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.1; done
  return 1
}

pids=""
if command -v lsof >/dev/null; then
  pids=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
fi
# An anvil that is still starting (not listening yet) is only known by the pid up.sh recorded.
# The file holds "<pid> <port> <process start time>"; a pid recorded for another port is left alone.
recorded=""
recorded_port=""
recorded_start=""
if [ -f "$PID_FILE" ]; then
  read -r recorded recorded_port recorded_start < "$PID_FILE" || true
  if [ -n "$recorded" ] && [ "$recorded_port" = "$PORT" ] && [ -n "$recorded_start" ] \
    && [ "$(process_start "$recorded")" = "$recorded_start" ] && is_anvil "$recorded"; then
    pids="$recorded $pids"
  fi
fi
pids=$(echo "$pids" | tr ' ' '\n' | sed '/^$/d' | sort -u)

# Refuse before stopping anything, including an Anvil started by another checkout.
for pid in $pids; do
  if ! is_anvil "$pid"; then
    echo "down.sh: port $PORT is held by '$(ps -p "$pid" -o comm= 2>/dev/null)' (pid $pid), which is not anvil; not touching it" >&2
    exit 1
  fi
  if [ "$pid" != "$recorded" ] || [ "$recorded_port" != "$PORT" ] || [ -z "$recorded_start" ] \
    || [ "$(process_start "$pid")" != "$recorded_start" ]; then
    echo "down.sh: port $PORT is held by anvil pid $pid, not this checkout's recorded process; not touching it" >&2
    exit 1
  fi
done

stopped=0
for pid in $pids; do
  stop_pid "$pid" || { echo "down.sh: anvil pid $pid on port $PORT survived TERM and KILL" >&2; exit 1; }
  say "stopped anvil (pid $pid) on port $PORT"
  stopped=$((stopped + 1))
done
[ "$stopped" -gt 0 ] || say "no devnet anvil on port $PORT"
if [ -n "$recorded_port" ] && [ "$recorded_port" = "$PORT" ]; then rm -f "$PID_FILE"; fi

for _ in $(seq 1 50); do port_busy || break; sleep 0.1; done
if port_busy; then
  echo "down.sh: port $PORT is still in use after stopping its anvil" >&2
  exit 1
fi
say "port $PORT is free"

if [ "$CLEAN" = 1 ]; then
  rm -rf "$HERE/addresses.json" "$HERE/tier1.devnet.json" "$HERE/env" "$HERE/state"
  say "removed addresses.json, tier1.devnet.json, env/ and state/"
fi
