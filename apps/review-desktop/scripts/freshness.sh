#!/usr/bin/env bash

# Mtime freshness check shared by build.sh and run.sh. Returns 0 when the
# output is missing, a source is missing, or any source entry is newer.
# node_modules is pruned because code-oss-dependencies.sh owns dependency
# freshness through its digest stamp.
needs_rebuild() {
  if (( $# < 2 )); then
    echo "usage: needs_rebuild <output> <source>..." >&2
    return 2
  fi

  local output="$1"
  shift
  if [[ ! -f "$output" ]]; then
    return 0
  fi

  local source
  for source in "$@"; do
    if [[ ! -e "$source" ]]; then
      return 0
    fi
    if [[ -n "$(find "$source" -name node_modules -prune -o -newer "$output" -print -quit)" ]]; then
      return 0
    fi
  done
  return 1
}
