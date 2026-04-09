#!/bin/bash
# Container-aware beads (bd) wrapper.
# Finds .beads/ by walking up from $PWD, sets BEADS_DIR, and execs bd.bin.
# Unlike the host wrapper (which hardcodes openclaw workspace paths), this
# one discovers per-project .beads/ databases dynamically — each project
# (azutech-knowledge, nl-itx, etc.) has its own isolated beads DB.

set -euo pipefail

# Walk up from current directory to find .beads/
find_beads_dir() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.beads" ]; then
      echo "$dir/.beads"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

if [ -z "${BEADS_DIR:-}" ]; then
  if BEADS_DIR=$(find_beads_dir); then
    export BEADS_DIR
  else
    echo "error: no .beads/ found in $PWD or parent directories." >&2
    echo "hint: initialize with 'BEADS_DIR=\$(pwd)/.beads bd init'" >&2
    exit 1
  fi
fi

export BEADS_DIR
export BEADS_DOLT_SERVER_PORT="${BEADS_DOLT_SERVER_PORT:-37310}"
exec /usr/local/bin/bd.bin "$@"
