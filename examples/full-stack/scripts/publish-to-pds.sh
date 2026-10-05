#!/usr/bin/env bash
# Publish a message to the demo site through the full trust chain.
# Kept under its old name; it is the happy path: see demo-happy-path.sh.
exec "$(dirname "$0")/demo-happy-path.sh" "$@"
