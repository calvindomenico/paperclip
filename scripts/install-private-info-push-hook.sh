#!/usr/bin/env bash
set -euo pipefail

# install-private-info-push-hook.sh
#
# Installs a local pre-push hook that runs check-private-info-before-push.mjs
# against origin/master before any push leaves this clone. `.git/hooks` is
# not version-controlled, so this installer is the repeatable, shareable
# artifact; run it once per clone (e.g. right after cloning the fork
# workspace used to stage branches before they go upstream).
#
# Usage:
#   ./scripts/install-private-info-push-hook.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
HOOK_FILE="$HOOKS_DIR/pre-push"

mkdir -p "$HOOKS_DIR"

cat > "$HOOK_FILE" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! git rev-parse --verify origin/master >/dev/null 2>&1; then
  echo "pre-push: no origin/master ref found locally, skipping private-info check." >&2
  exit 0
fi

node scripts/check-private-info-before-push.mjs --base origin/master
HOOK

chmod +x "$HOOK_FILE"
echo "Installed pre-push hook at $HOOK_FILE"
