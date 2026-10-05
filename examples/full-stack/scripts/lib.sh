# Shared helpers for the demo scripts. Source it; do not run it.
# shellcheck shell=bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "${ROOT}/../.." && pwd)"
OFW="${OFW_BIN:-${REPO}/cli/target/release/ofw}"
LOCAL="${ROOT}/.local"
OEM_KEY_FILE="${OEM_KEY_FILE:-${LOCAL}/oem.pem}"
OEM_KEY_ID="${OEM_KEY_ID:-demo-oem-1}"

PRODUCT="${PRODUCT:-demo-site}"
CHANNEL="${CHANNEL:-stable}"
DEMO_SITE_URL="${DEMO_SITE_URL:-http://127.0.0.1:8080}"
PUBLISHER_HANDLE="${PUBLISHER_HANDLE:-publisher.pds.test}"
PUBLISHER_PASSWORD="${PUBLISHER_PASSWORD:-publisher-pass-change-me}"
CI_HANDLE="${CI_HANDLE:-ci-attester.pds.test}"

# ofw reads these. The password goes through the environment, never argv.
export OFW_PDS="${OFW_PDS:-http://127.0.0.1:2583}"
export OFW_IDENTIFIER="$PUBLISHER_HANDLE"
export OFW_PASSWORD="$PUBLISHER_PASSWORD"
# Make sure nothing inherited from the caller's shell changes what gets published.
unset OFW_OEM_KEY OFW_OEM_KEY_ID OFW_SKIP_PIPELINE OFW_REQUIRE_PIPELINE OFW_PIPELINE_STAGES \
  OFW_ATTESTER_DIDS OFW_TRUSTED_OEM_KEYS OFW_AUTHOR_DID OFW_REPO OFW_VERSION OFW_KIND \
  OFW_PRODUCT OFW_CHANNEL

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_BOLD=$'\033[1m' C_DIM=$'\033[2m' C_RED=$'\033[1;31m' C_GREEN=$'\033[1;32m'
  C_YELLOW=$'\033[1;33m' C_CYAN=$'\033[1;36m' C_OFF=$'\033[0m'
else
  C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_CYAN='' C_OFF=''
fi

step() { printf '\n%s== %s ==%s\n' "$C_CYAN" "$*" "$C_OFF"; }
say() { printf '   %s\n' "$*"; }
good() { printf '   %s%s%s\n' "$C_GREEN" "$*" "$C_OFF"; }
warn() { printf '   %s%s%s\n' "$C_YELLOW" "$*" "$C_OFF"; }
bad() { printf '   %s%s%s\n' "$C_RED" "$*" "$C_OFF"; }
die() { printf '%sERROR: %s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }

# With DEMO_PAUSE=1 the scripts stop before each beat so the presenter can talk.
pause() {
  if [[ "${DEMO_PAUSE:-0}" == "1" && -t 0 ]]; then
    read -r -p "   ${C_DIM}[Enter to continue]${C_OFF} " _ || true
  fi
}

# Print a command the way the audience should read it, then run it.
show() { printf '   %s$ %s%s\n' "$C_BOLD" "$*" "$C_OFF"; }

pds() { node "${ROOT}/scripts/_pds.mjs" "$@"; }

compose() { docker compose --project-directory "$ROOT" "$@"; }

need_tools() {
  local t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"
  done
}

ensure_ofw() {
  if [[ ! -x "$OFW" ]]; then
    echo "building ofw (first run only)…" >&2
    cargo build --release --locked --manifest-path "${REPO}/cli/Cargo.toml" >&2
  fi
}

require_stack() {
  need_tools node curl docker
  curl -fsS --max-time 3 "${OFW_PDS}/xrpc/_health" >/dev/null 2>&1 ||
    die "the PDS is not answering at ${OFW_PDS}. Start the stack: ./scripts/demo-up.sh"
  curl -fsS --max-time 3 "${DEMO_SITE_URL}/healthz" >/dev/null 2>&1 ||
    die "demo-site is not answering at ${DEMO_SITE_URL}. Start the stack: ./scripts/demo-up.sh"
  [[ -f "$OEM_KEY_FILE" ]] || die "no OEM key at ${OEM_KEY_FILE}. Run ./scripts/demo-setup.sh"
  ensure_ofw
  PUBLISHER_DID="$(pds did "$PUBLISHER_HANDLE")" ||
    die "publisher account not found on the PDS (bootstrap did not finish?): docker compose logs bootstrap"
  CI_DID="$(pds did "$CI_HANDLE")" || die "CI attester account not found on the PDS"
  OEM_PUBLIC_KEY="$(oem_public_key "$OEM_KEY_FILE")"
}

# Raw Ed25519 public key (32 bytes, unpadded base64url) of a PKCS#8 PEM key.
oem_public_key() {
  openssl pkey -in "$1" -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n'
}

release_rkey() { printf '%s-%s-%s' "$PRODUCT" "$1" "$CHANNEL"; }

site_message() { pds message "$DEMO_SITE_URL"; }
site_shows() { [[ "$(site_message)" == "$1" ]]; }

# sidekar_log <since RFC3339> : Sidekar's own lines since then, without the timestamp noise.
sidekar_log() {
  compose logs --no-color --no-log-prefix --since "$1" sidekar 2>/dev/null |
    grep -E 'applying|applied|REFUSED|tick error' | sed -E 's/^[0-9TZ:.-]+ - //' || true
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# wait_until <seconds> <command…> : poll every 0.5 s until the command succeeds.
wait_until() {
  local deadline=$((SECONDS + $1))
  shift
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || return 1
    sleep 0.5
  done
}

# ── attack beats ────────────────────────────────────────────────────────
attack_banner() {
  printf '\n%s ATTACK %s %s\n' "$C_RED" "$C_OFF" "$1"
  shift
  local l
  for l in "$@"; do say "$l"; done
}

# attack_verdict <since> <log pattern> <message before> <attacker payload>
# Waits for Sidekar to log a refusal matching the pattern, then proves the
# site did not change. Exits 1 if the attacker's payload went live.
attack_verdict() {
  local since="$1" pattern="$2" before="$3" payload="$4" line=''
  step "What Sidekar did"
  for _ in $(seq 1 40); do
    line="$(compose logs --no-color --no-log-prefix --since "$since" sidekar 2>/dev/null |
      grep -E 'REFUSED|tick error' | grep -E "$pattern" | tail -1 | sed -E 's/^[0-9TZ:.-]+ - //')" || true
    [[ -n "$line" ]] && break
    sleep 0.5
  done
  if [[ -n "$line" ]]; then
    printf '   %ssidekar | %s%s\n' "$C_YELLOW" "$line" "$C_OFF"
  else
    warn "no refusal line from Sidekar yet (docker compose logs --tail 20 sidekar)"
  fi
  # Give a wrong apply every chance to show up before declaring victory.
  sleep 2
  local after
  after="$(site_message)"
  if [[ "$after" == "$payload" ]]; then
    bad "FAILED OPEN: the demo site is serving the attacker's payload: \"${after}\""
    exit 1
  fi
  [[ "$after" == "$before" ]] || warn "site message changed to \"${after}\" (not the attacker's payload)"
  say "demo site still says: \"${after}\""
  if [[ -z "$line" ]]; then
    bad "the payload was not applied, but Sidekar logged no refusal — check its logs"
    exit 1
  fi
  printf '\n%sBLOCKED%s  %s\n' "$C_GREEN" "$C_OFF" "the attacker's release is on the PDS, and nothing installed it."
}

# audit_expect_fail <rkey> : independent check with ofw audit; must exit 2.
audit_expect_fail() {
  local rkey="$1" rc=0
  step "Independent check: ofw audit with the real OEM key pinned"
  show "ofw audit --repo ${PUBLISHER_HANDLE} --rkey ${rkey} --trusted-oem-key ${OEM_PUBLIC_KEY}"
  env -u OFW_IDENTIFIER -u OFW_PASSWORD "$OFW" audit --repo "$PUBLISHER_HANDLE" --rkey "$rkey" \
    --trusted-oem-key "$OEM_PUBLIC_KEY" 2>&1 | sed 's/^/   /' || rc=${PIPESTATUS[0]}
  if [[ $rc -eq 2 ]]; then
    say "exit code 2 = do not install"
  else
    bad "expected ofw audit to exit 2, got ${rc}"
    exit 1
  fi
}

# ── IoT control plane ───────────────────────────────────────────────────
export OFW_CONTROL_URL="${OFW_CONTROL_URL:-http://127.0.0.1:8787}"
export OFW_ADMIN_TOKEN="${OFW_ADMIN_TOKEN:-local-dev-admin-token}"
CAMERA_JS="${REPO}/examples/iot-camera-emulator/src/run.mjs"
UTIL_JS="${REPO}/packages/utility/dist/cli.js"

ofw_util() { node "$UTIL_JS" "$@"; }

require_iot() {
  need_tools node curl
  [[ -f "$UTIL_JS" && -f "${REPO}/packages/iot/dist/index.js" ]] ||
    die "TypeScript packages are not built. From the repo root: pnpm install --frozen-lockfile && pnpm -r build"
  curl -fsS --max-time 3 "${OFW_CONTROL_URL}/healthz" >/dev/null 2>&1 ||
    die "the control plane is not answering at ${OFW_CONTROL_URL}. Start the stack: ./scripts/demo-up.sh"
}

# next_serial : CAM-0001, CAM-0002, … (one above what the control plane has seen)
next_serial() {
  local n
  n="$( (ofw_util list-devices; ofw_util list-pending) | grep -c 'CAM-' || true)"
  printf 'CAM-%04d' "$((n + 1))"
}

camera_fingerprint() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]+"/factory/profile.json","utf8")).fingerprint)' "$1"
}

# start_camera <root> <logfile> : run the emulated device in the background.
start_camera() {
  CAMERA_ROOT="$1" POLL_MS=1000 node "$CAMERA_JS" run >"$2" 2>&1 &
  CAMERA_PID=$!
}

stop_camera() {
  [[ -n "${CAMERA_PID:-}" ]] && kill "$CAMERA_PID" 2>/dev/null || true
  wait "${CAMERA_PID:-}" 2>/dev/null || true
}
