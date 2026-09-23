#!/usr/bin/env bash

ensure_code_oss_dependencies() {
  if (( $# != 2 )); then
    echo "usage: ensure_code_oss_dependencies <app-dir> <checkout>" >&2
    return 2
  fi

  local app_dir="$1"
  local checkout="$2"
  local bootstrap_helper="$app_dir/scripts/code-oss-bootstrap.mjs"
  local required_node
  local active_node
  local nvm_script
  local install_stamp
  local needs_install
  local previous_directory="$PWD"

  if [[ ! -f "$checkout/package.json" ]]; then
    echo "the tracked Code OSS fork is missing from $checkout" >&2
    return 1
  fi

  required_node="$(tr -d '[:space:]' < "$checkout/.nvmrc")"
  active_node="$(node -v | sed 's/^v//')"
  if [[ "$active_node" != "$required_node" ]]; then
    if command -v fnm >/dev/null 2>&1; then
      eval "$(fnm env)"
      fnm install "$required_node"
      fnm use "$required_node"
    else
      nvm_script="${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
      if [[ ! -f "$nvm_script" ]]; then
        echo "code-oss requires Node $required_node; install fnm or nvm first" >&2
        return 1
      fi
      # shellcheck source=/dev/null
      source "$nvm_script"
      nvm install "$required_node"
      nvm use "$required_node"
    fi
  fi

  active_node="$(node -v | sed 's/^v//')"
  if [[ "$active_node" != "$required_node" ]]; then
    echo "code-oss requires Node $required_node; active Node is $active_node" >&2
    return 1
  fi

  install_stamp="$checkout/node_modules/.dev-fast-package-lock.sha256"
  cd "$checkout" || return 1
  needs_install="$(node "$bootstrap_helper" needs-install "$checkout" "$install_stamp")"
  case "$needs_install" in
    true)
      echo "Installing Code OSS dependencies..."
      npm ci --no-audit --no-fund --prefer-offline
      node "$bootstrap_helper" digest "$checkout" > "$install_stamp"
      ;;
    false)
      echo "Code OSS dependencies are current."
      ;;
    *)
      echo "Code OSS bootstrap check returned '$needs_install'" >&2
      return 1
      ;;
  esac
  cd "$previous_directory" || return 1
}
