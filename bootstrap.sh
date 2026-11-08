#!/usr/bin/env bash
# Set up pi-light on a new machine:
#   bash <(curl -fsSL https://raw.githubusercontent.com/locnbk2002/pi-light/main/bootstrap.sh) [--dry-run|--yes]
# Needs pi, git and node. AgentKit (`ak`, logged in) and herdr are set up by extensions/setup/setup.mjs when present.
# Credentials and the default model are never touched.
set -euo pipefail
for tool in pi git node; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Install it first (pi: npm install -g @earendil-works/pi-coding-agent)." >&2; exit 1; }
done
source="git:github.com/locnbk2002/pi-light"
dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/git/github.com/locnbk2002/pi-light"
setup="$dir/extensions/setup/setup.mjs"
if [[ ! -f "$setup" ]]; then
  # No checkout yet: install it. A pre-0.5 checkout (setup.mjs at the root): update it.
  action=(install "$source")
  [[ -d "$dir" ]] && action=(update --extensions)
  if [[ "${1:-}" == "--dry-run" ]]; then
    echo "Dry run: would run 'pi ${action[*]}', then node extensions/setup/setup.mjs --dry-run." >&2
    exit 0
  fi
  pi "${action[@]}"
fi
exec node "$setup" "$@"
