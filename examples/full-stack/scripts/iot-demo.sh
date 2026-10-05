#!/usr/bin/env bash
# IoT side of the demo: a factory-provisioned camera joins the private control
# plane, an admin approves it, and a signed + sealed job is delivered.
#
#   1. factory   device gets its identity and pins the control plane's job-signing key
#   2. device    boots and asks to join (it can do nothing else until approved)
#   3. admin     reviews the request (serial + mnemonic) and approves it
#   4. admin     sends a credential.set job: signed by the control plane, sealed to the device
#   5. device    verifies the signature against its pinned key, applies, acks
#
#   ./scripts/iot-demo.sh
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_iot

CAM_ROOT="${LOCAL}/camera/$(date +%s)"
CAM_LOG="${CAM_ROOT}.log"
mkdir -p "$(dirname "$CAM_ROOT")"
trap stop_camera EXIT
SERIAL="$(next_serial)"
NEW_PASSWORD="rotated-$(openssl rand -hex 4)"

step "1/5  Factory: provision camera ${SERIAL}, pin the control plane's job-signing key"
show "ofw-util control-key"
CONTROL_KEY="$(ofw_util control-key)"
say "$CONTROL_KEY"
pause
CAMERA_ROOT="$CAM_ROOT" OFW_CONTROL_PUBLIC_KEY="$CONTROL_KEY" SERIAL="$SERIAL" \
  OFW_FACTORY_SECRET="${OFW_FACTORY_SECRET:-demo-factory-secret}" \
  node "$CAMERA_JS" init | grep -E '"serial"|"fingerprint"|"mnemonic"|pinned control key' | sed 's/^ */   /'
FP="$(camera_fingerprint "$CAM_ROOT")"

step "2/5  Device boots and asks to join"
pause
start_camera "$CAM_ROOT" "$CAM_LOG"
wait_until 20 grep -q 'joinRequest:' "$CAM_LOG" || { cat "$CAM_LOG"; die "the camera did not send a join request"; }
grep -E 'Requesting join|joinRequest' "$CAM_LOG" | sed 's/^ */   camera | /'

step "3/5  Admin reviews the pending request and approves it"
pause
show "ofw-util list-pending"
ofw_util list-pending | sed 's/^/   /'
JOIN_ID="$(ofw_util list-pending | awk -F'\t' -v s="$SERIAL" '$3 == s { print $1 }' | tail -1)"
[[ -n "$JOIN_ID" ]] || die "no pending join for ${SERIAL}"
show "ofw-util approve ${JOIN_ID}"
ofw_util approve "$JOIN_ID" | sed 's/^/   /'
wait_until 20 grep -q 'Enrolled' "$CAM_LOG" || { cat "$CAM_LOG"; die "the camera did not see its enrollment"; }
good "camera | Enrolled — it verified the control plane key against the one pinned at the factory"

step "4/5  Admin rotates the camera password: a job signed by the control plane, sealed to this device"
pause
show "ofw-util set-password ${FP:0:16}… '<new password>'"
ofw_util set-password "$FP" "$NEW_PASSWORD" | sed 's/^/   /'

step "5/5  Device verifies the job signature, applies it, acks"
wait_until 20 grep -q 'credential.set: ok' "$CAM_LOG" || { tail -5 "$CAM_LOG"; die "the camera did not apply the job"; }
grep -E 'credential.set' "$CAM_LOG" | tail -1 | sed 's/^ */   camera | /'
show "ofw-util list-jobs"
ofw_util list-jobs | sed 's/^/   /'
if CAMERA_ROOT="$CAM_ROOT" node "$CAMERA_JS" status | grep -q "\"password\": \"${NEW_PASSWORD}\""; then
  good "device state: passwordRotated = true (the job was stored and delivered encrypted to this device key)"
else
  die "device state does not show the new password"
fi

printf '\n%sDONE%s  %s joined, was approved, and applied a signed job.\n' "$C_GREEN" "$C_OFF" "$SERIAL"
