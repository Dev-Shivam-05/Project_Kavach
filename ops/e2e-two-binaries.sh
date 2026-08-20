#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Phase 1's last arrow, end to end, without Docker (D-027 · D-026 · ADR-002)
#
#   bash ops/e2e-two-binaries.sh /tmp/kavach-e2e
#
# This is ops/docker-compose.yml with the containers taken away: sos-ingest and
# control-plane as two separate OS processes, both pointed at ONE
# KAVACH_BUS_DIR, and one real SOS posted to sos-ingest's actual HTTP front
# door. It exists because every other piece of evidence for D-027 is a Go test,
# and a Go test cannot answer "do the two BINARIES talk".
#
# What a good run looks like (~35 s):
#
#   ack                      {"incidentId":…,"verified":false,"flags":1}
#   control-plane log        ingest_incident_projected   <- it heard the other process
#   control-plane store      AUTO_QUIESCE + CANCEL_WINDOW armed
#   after the cancel window  transition PENDING -> ACTIVE_L1
#                            REPEAT_L1, SMS_TIER, ESCALATE_L2, ESCALATE_L3 armed
#   cursors.json             BOTH durables recorded, neither erased by the other
#
# Two things it does NOT prove, and neither is a defect in this script:
#   - Nobody's phone rings. `devices 0` in the fanout line is correct: no device
#     is enrolled and KAVACH_FCM_CREDENTIALS is unset (RISK 14).
#   - The four-container stack still has never been brought up. This is two of
#     the four binaries on one host.
#
# The envelope it posts is unsigned, so it is accepted, flagged and counted —
# ADR-018, fail open on the safety path. That is the product, not a shortcut.
# ═══════════════════════════════════════════════════════════════════════════════
set -u

ROOT="$(cd "$(dirname "$0")/../backend" && pwd)"
E2E="${1:?usage: e2e-two-binaries.sh <empty-work-dir>}"
BIN="$E2E/bin"
DATA="$E2E/data"          # sos-ingest: KAVACH_SOS_DATA -> <data>/bus, <data>/store
CP="$E2E/cp"              # control-plane: KAVACH_DATA_DIR
BUS="$DATA/bus"           # the seam

mkdir -p "$BIN" "$DATA/store" "$CP" "$BUS"

FAM=f-e2e
MEM=m-e2e
DEV=d-e2e
INC=11111111-2222-4333-8444-555555555555

# ⛔ RISK item 18: no running binary can create a family, and BOTH incident
# projectors drop an incident whose family row is missing. So the rows are
# written straight into the store's JSON tables here — the same two rows
# cmd/control-plane/main_test.go's newPlane seeds through the API. When item 18
# is closed (POST /v1/family, or a seed command), delete this function and call
# that instead: a fixture that outlives the gap it works around becomes the
# reason nobody closes it.
seed_store() {
  cat > "$1/family.json" <<JSON
[{"id":"$FAM","display_name":"E2E Family","created_at":1,"policy_version":1,"current_epoch":1,"sms_hmac_key":"","sms_ceiling":10}]
JSON
  cat > "$1/member.json" <<JSON
[{"id":"$MEM","family_id":"$FAM","display_name":"Priya","ascii_short_name":"PRIYA","role":"adult","phone_e164":"+919812345678","created_at":1}]
JSON
}
seed_store "$DATA/store"
seed_store "$CP"

echo "== building both binaries =="
cd "$ROOT" || exit 1
go build -o "$BIN/" ./cmd/sos-ingest ./cmd/control-plane || exit 1

echo "== starting sos-ingest (:18081) and control-plane (:18080) on one bus dir =="
KAVACH_SOS_ADDR=":18081" KAVACH_SOS_DATA="$DATA" KAVACH_DEV=1 \
  "$BIN/sos-ingest"* > "$E2E/sos-ingest.log" 2>&1 &
SOS_PID=$!
KAVACH_CP_ADDR=":18080" KAVACH_DATA_DIR="$CP" KAVACH_BUS_DIR="$BUS" \
  KAVACH_ESCALATION_WORKERS=1 KAVACH_DEV=1 \
  "$BIN/control-plane"* > "$E2E/control-plane.log" 2>&1 &
CP_PID=$!
trap 'kill $SOS_PID $CP_PID 2>/dev/null' EXIT

sleep 4
echo "sos-ingest  /healthz: $(curl -s -m 3 http://127.0.0.1:18081/healthz | head -c 90)"
echo "control-plane /readyz: $(curl -s -m 3 http://127.0.0.1:18080/readyz | head -c 90)"

echo
echo "== POST a real SOS to sos-ingest =="
NOW=$(date +%s)000
cat > "$E2E/envelope.json" <<JSON
{"v":1,"incidentId":"$INC","familyId":"$FAM","deviceId":"$DEV","memberId":"$MEM","clientTsMs":$NOW,"hlc":"$NOW:0:$DEV","trigger":"manual","confidencePct":95,"riskContext":0,"duress":false,"isDrill":false,"policyVersion":1,"coarseCell":"tdr1x","batteryPct":80,"sealedPayload":"","flags":0,"pad":""}
JSON
curl -s -m 5 -X POST http://127.0.0.1:18081/v1/incident/open \
  -H 'Content-Type: application/json' --data-binary "@$E2E/envelope.json"
echo

echo
echo "== waiting 32s: the 250 ms bus poll, the 20 s cancel window, then the ladder =="
sleep 32

echo
echo "== the rungs the ENGINE armed, in the control-plane's own store =="
grep -o '"action":"[A-Z_0-9]*","target_tier":[0-9]*' "$CP/escalation_timer.json" 2>/dev/null
echo
echo "== the incident the control-plane projected =="
grep -o '"id":"[^"]*","family_id":"[^"]*"\|"state":"[A-Z_0-9]*"' "$CP/incident.json" 2>/dev/null | head -3
echo
echo "== the seam =="
echo "stream.wal: $(stat -c %s "$BUS/stream.wal" 2>/dev/null) bytes"
echo "cursors:    $(cat "$BUS/cursors.json" 2>/dev/null)"
echo
echo "== control-plane: what it heard and what it did =="
grep -E "ingest_incident_projected|timer_armed|transition|fanout" "$E2E/control-plane.log" | tail -12
