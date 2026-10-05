#!/usr/bin/env bash
# Back to a clean slate: stop everything, delete all demo state (PDS accounts
# and releases, Sidekar state, the site message, control-plane devices, the
# emulated camera), then start again. Keys in .local/ and built images are kept,
# so this needs no network.
#   ./scripts/demo-reset.sh            reset and start
#   ./scripts/demo-reset.sh --down     reset and stay down
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

echo "removing containers and volumes…"
compose down -v --remove-orphans --timeout 2
rm -rf "${LOCAL}/camera"

if [[ "${1:-}" == "--down" ]]; then
  echo "stack is down and clean."
  exit 0
fi
exec "${ROOT}/scripts/demo-up.sh" --no-build
