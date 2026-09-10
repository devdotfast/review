#!/usr/bin/env bash
# Validate a sealed Fedora publication in clean, pinned Fedora containers.
set -euo pipefail
PUBLICATION="$(cd "${1:?usage: verify-repository.sh publication-directory [43|44|all]}" && pwd -P)"
TARGET="${2:-all}"
case "$TARGET" in all|43|44) ;; *) echo "Unknown Fedora test target: $TARGET" >&2; exit 2 ;; esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GENERATION="$(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); assert p["format"] == "rpm"; print(p["generation"])' "$PUBLICATION/repos/current.json")"
FINGERPRINT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["keyFingerprint"])' "$PUBLICATION/repos/current.json")"
for VERSION in 43 44; do
  if [[ "$TARGET" != all && "$TARGET" != "$VERSION" ]]; then continue; fi
  case "$VERSION" in
    43) IMAGE='fedora:43@sha256:a651ddf48ea28a06ed4e1e6519f51c9f47e7a5a138722ade87369b8fbb7e5b42' ;;
    44) IMAGE='fedora:44@sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80' ;;
  esac
  docker run --rm --platform linux/amd64 \
    -v "$PUBLICATION:/publication:ro" -v "$SCRIPT_DIR:/test:ro" \
    -e GENERATION="$GENERATION" -e FINGERPRINT="$FINGERPRINT" \
    "$IMAGE" bash /test/verify-fedora-container.sh
  echo "Fedora $VERSION: install, upgrade, retention, package/metadata tamper and untrusted-key rejection passed"
done
