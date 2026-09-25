#!/usr/bin/env bash
# Run as an ordinary user, under Xvfb and a D-Bus session. No system Node needed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec env ELECTRON_RUN_AS_NODE=1 "/usr/share/${APP:?}/$APP" "$SCRIPT_DIR/smoke-installed-linux.mjs"
