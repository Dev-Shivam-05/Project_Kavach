// ═══════════════════════════════════════════════════════════════════════════════
// The wire catalogue, pinned to bytes (§2.5.2 · D-037's mirror).
//
// testdata/s2c_frames.golden.json is every frame type a phone can receive from
// this gateway, one realistic instance each, exactly as it leaves toWire and
// the writer: body under `payload`, resume position under `cursor`, producer
// fields at the top level. testdata/c2s_frames.golden.json is every C→S shape
// the gateway accepts. mobile/test pins the client against the same files, the
// way internal/envelope/crosslang_test.go pins the envelope against one set of
// bytes — so a field renamed on one side fails on both.
//
// Regenerate deliberately, never by accident:
//     go test ./cmd/realtime-gw/ -run Golden -update
// and read the diff before committing it: a changed golden IS a contract
// change, and the mobile client has to move with it.
// ═══════════════════════════════════════════════════════════════════════════════
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/kavach/backend/internal/notify"
)

var update = flag.Bool("update", false, "rewrite the golden fixtures under testdata/")

const (
	goldenFamily   = "11111111-1111-7111-8111-111111111111"
	goldenIncident = "44444444-4444-7444-8444-444444444444"
	goldenMember   = "22222222-2222-7222-8222-222222222222"
	goldenMember2  = "55555555-5555-7555-8555-555555555555"
	goldenDevice   = "33333333-3333-7333-8333-333333333333"
	goldenAt       = int64(1_700_000_000_000)
	goldenCursor   = "42"
)

// s2cCatalogue is one realistic frame per S→C type, each built the way its
// producer builds it. The producer is named so a drift there can be traced:
// the shapes under internal/ are C3's, copied here character for character.
func s2cCatalogue() map[string]*outFrame {
	incidentData := func(extra map[string]any) map[string]any {
		// escalation.publishIncident always adds these three.
		extra["state"], extra["trigger"], extra["isDrill"] = "OWNED", "MANUAL", false
		return extra
	}
	bus := func(f notify.Frame) *outFrame { return toWire(42, f.Encode()) }
	inc := func(typ string, prio notify.Priority, data map[string]any) notify.Frame {
		return notify.Frame{V: notify.FrameVersion, Type: typ, Priority: prio,
			FamilyID: goldenFamily, IncidentID: goldenIncident, At: goldenAt, Data: data}
	}
	fam := func(typ string, prio notify.Priority, key string, data map[string]any) notify.Frame {
		return notify.Frame{V: notify.FrameVersion, Type: typ, Priority: prio, Key: key,
			FamilyID: goldenFamily, At: goldenAt, Data: data}
	}
	reduced := func(f notify.Frame) notify.Frame {
		f.Reduced = true
		return f
	}
	server := func(typ string, prio notify.Priority, payload map[string]any) *outFrame {
		of := serverFrame(goldenFamily, typ, prio, payload)
		of.wf.At = goldenAt
		return of
	}
	undecodable := toWire(42, []byte("not json"))
	undecodable.wf.At = goldenAt

	return map[string]*outFrame{
		// ── internal/escalation (publishIncident) ─────────────────────────
		"incident.state_changed": bus(inc("incident.state_changed", notify.PriorityCritical, incidentData(map[string]any{
			"event": "CLAIM", "from": "ACTIVE_L1", "to": "OWNED", "policyVersion": 1, "hlc": "0000018bcfe0000100aabbccdd"}))),
		"incident.state_changed (reduced)": bus(reduced(inc("incident.state_changed", notify.PriorityCritical, map[string]any{
			"state": "OWNED", "trigger": "MANUAL", "coarseCell": "c7:23.02:72.57", "isDrill": false}))),
		"incident.claimed": bus(inc("incident.claimed", notify.PriorityCritical, incidentData(map[string]any{
			"ownerMemberId": goldenMember2, "firstAckAt": goldenAt}))),
		"incident.released": bus(inc("incident.released", notify.PriorityCritical, incidentData(map[string]any{
			"previousOwnerMemberId": goldenMember2}))),
		"incident.acked": bus(inc("incident.acked", notify.PriorityCritical, incidentData(map[string]any{
			"memberId": goldenMember2, "firstAckAt": goldenAt}))),
		// ── internal/notify (Fanout / publishReduced / delivery receipts) ─
		"incident.notified": bus(inc("incident.notified", notify.PriorityCritical, map[string]any{
			"tier": 1, "label": "L1", "repeat": false, "state": "ACTIVE_L1", "trigger": "MANUAL",
			"duress": false, "isDrill": false, "subject": "PRIYA", "audience": []string{goldenDevice},
			"sealed": "AZ+sealed+ciphertext+placeholder"})),
		"incident.notified (reduced)": bus(reduced(inc("incident.notified", notify.PriorityCritical, map[string]any{
			"tier": 2, "state": "ACTIVE_L2", "trigger": "MANUAL", "coarseCell": "c7:23.02:72.57",
			"subject": "PRIYA", "show112": true}))),
		"notify.delivered": bus(inc("notify.delivered", notify.PriorityHigh, map[string]any{
			"notificationId": "66666666-6666-7666-8666-666666666666", "deviceId": goldenDevice,
			"channel": "fcm", "latencyMs": 180})),
		// ── internal/consent (emit) ───────────────────────────────────────
		"consent.granted": bus(fam("consent.granted", notify.PriorityHigh, "", map[string]any{
			"grantId": "77777777-7777-7777-8777-777777777777", "scope": "live_location", "purpose": "safety",
			"granteeMemberId": goldenMember2, "expiresAt": goldenAt + 86_400_000})),
		"consent.revoked": bus(fam("consent.revoked", notify.PriorityHigh, "", map[string]any{
			"grantId": "77777777-7777-7777-8777-777777777777", "scope": "live_location",
			"granteeMemberId": goldenMember2, "keyRotationPending": true})),
		"consent.access_surfaced": bus(fam("consent.access_surfaced", notify.PriorityHigh, "", map[string]any{
			"subjectMemberId": goldenMember, "count": 1,
			"items": []map[string]any{{"accessorMemberId": goldenMember2, "what": "live_location", "at": goldenAt}}})),
		// ── cmd/control-plane (publishFamily) ─────────────────────────────
		"journey.started": bus(fam("journey.started", notify.PriorityHigh, "journey:88888888-8888-7888-8888-888888888888", map[string]any{
			"journeyId": "88888888-8888-7888-8888-888888888888", "memberId": goldenMember, "dest": "Home", "etaAt": goldenAt + 1_800_000})),
		"journey.updated": bus(fam("journey.updated", notify.PriorityHigh, "journey:88888888-8888-7888-8888-888888888888", map[string]any{
			"journeyId": "88888888-8888-7888-8888-888888888888", "state": "arrived", "arrivedAt": goldenAt, "etaAt": goldenAt + 1_800_000})),
		"member.checked_in": bus(fam("member.checked_in", notify.PriorityHigh, "checkin:"+goldenMember, map[string]any{
			"memberId": goldenMember, "at": goldenAt})),
		"device.find_phone": bus(fam("device.find_phone", notify.PriorityCritical, "", map[string]any{
			"deviceId": goldenDevice, "requestedBy": goldenMember2, "at": goldenAt})),
		"device.health_changed": bus(fam("device.health_changed", notify.PriorityHigh, "dev:"+goldenDevice, map[string]any{
			"deviceId": goldenDevice, "batteryPct": 61, "agentHealthy": true, "degradationLevel": 0})),
		"device.agent_died": bus(fam("device.agent_died", notify.PriorityHigh, "dev:"+goldenDevice, map[string]any{
			"deviceId": goldenDevice, "memberId": goldenMember, "gapMs": 5_400_000, "expectedMs": 300_000,
			"at": goldenAt, "source": "boot"})),
		"presence.paused": bus(fam("presence.paused", notify.PriorityLow, "paused:"+goldenMember, map[string]any{
			"memberId": goldenMember, "paused": true, "at": goldenAt})),
		"geofence.crossing": bus(fam("geofence.crossing", notify.PriorityHigh, "", map[string]any{
			"geofenceId": "99999999-9999-7999-8999-999999999999", "transition": "exit", "memberId": goldenMember, "at": goldenAt})),
		// ── this binary (relays) ──────────────────────────────────────────
		"location.update": bus(fam("location.update", notify.PriorityLow, "loc:"+goldenMember, map[string]any{
			"memberId": goldenMember, "deviceId": goldenDevice, "sealed": "AQIDc2VhbGVk", "at": goldenAt})),
		"presence.changed": toWire(0, fam("presence.changed", notify.PriorityLow, "presence:"+goldenMember, map[string]any{
			"memberId": goldenMember, "deviceId": goldenDevice, "lastSeenAt": goldenAt}).Encode()),
		"watch.signal": toWire(0, fam("watch.signal", notify.PriorityHigh, "", map[string]any{
			"sessionId": "sess-1", "fromMemberId": goldenMember2, "fromDeviceId": goldenDevice,
			"toMemberId": goldenMember, "sealed": "AQIDc2VhbGVk", "at": goldenAt}).Encode()),
		// ── this binary (originated) ──────────────────────────────────────
		"sync.complete":     server("sync.complete", notify.PriorityCritical, map[string]any{"truncated": false}),
		"error":             server("error", notify.PriorityHigh, map[string]any{"code": "KV-2001", "detail": "reduced session may not publish location.report"}),
		"pong":              server("pong", notify.PriorityHigh, map[string]any{"at": goldenAt}),
		"frame.undecodable": undecodable,
	}
}

// c2sCatalogue is every C→S shape the gateway accepts: exactly what
// mobile/src/net/ws.ts's sendFrame puts on the wire.
func c2sCatalogue() map[string]string {
	return map[string]string{
		"ping":            `{"type":"ping","priority":"LOW","payload":{"at":1700000000000}}`,
		"heartbeat":       `{"type":"heartbeat","priority":"LOW","payload":{"at":1700000000000}}`,
		"location.report": `{"type":"location.report","key":"loc","priority":"LOW","payload":"AQIDc2VhbGVk"}`,
		"watch.signal":    `{"type":"watch.signal","priority":"HIGH","payload":{"sessionId":"sess-1","toMemberId":"` + goldenMember + `","sealed":"AQIDc2VhbGVk"}}`,
	}
}

func goldenPath(name string) string { return filepath.Join("testdata", name) }

func compareGolden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := goldenPath(name)
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s is missing — run with -update to create it: %v", path, err)
	}
	if !bytes.Equal(bytes.TrimSpace(want), bytes.TrimSpace(got)) {
		t.Fatalf("%s no longer matches the frames this gateway emits.\n"+
			"This is a CONTRACT change: the mobile client pins the same file. If it is intended, "+
			"run `go test ./cmd/realtime-gw/ -run Golden -update`, read the diff, and hand it to the mobile side.\n"+
			"--- got ---\n%s", path, got)
	}
}

func TestGolden_S2CFrames(t *testing.T) {
	cat := s2cCatalogue()
	names := make([]string, 0, len(cat))
	for n := range cat {
		names = append(names, n)
	}
	sort.Strings(names)

	out := map[string]json.RawMessage{}
	for _, n := range names {
		of := cat[n]
		// The writer stamps the cursor at write time; the fixture shows one.
		of.wf.Cursor = goldenCursor
		b, err := json.Marshal(of.wf)
		if err != nil {
			t.Fatal(err)
		}
		out[n] = b
		// Every frame, whatever its producer, satisfies the envelope rule.
		var probe struct {
			Type    string          `json:"type"`
			Cursor  string          `json:"cursor"`
			Payload json.RawMessage `json:"payload"`
			Data    json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(b, &probe); err != nil {
			t.Fatal(err)
		}
		if probe.Type == "" || probe.Cursor == "" || len(probe.Payload) == 0 || len(probe.Data) != 0 {
			t.Errorf("%s breaks the envelope rule {type, cursor, payload; never data}: %s", n, b)
		}
	}
	pretty, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	compareGolden(t, "s2c_frames.golden.json", append(pretty, '\n'))
}

// TestGolden_C2SFrames pins the accepted shapes to bytes AND to behaviour:
// each fixture, fed to the real handler, must do what the catalogue says.
func TestGolden_C2SFrames(t *testing.T) {
	cat := c2sCatalogue()
	out := map[string]json.RawMessage{}
	for n, raw := range cat {
		out[n] = json.RawMessage(raw)
	}
	pretty, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	compareGolden(t, "c2s_frames.golden.json", append(pretty, '\n'))

	gw := newTestGateway(t)
	sender := newTestConn(t, gw, ticket{Ticket: "g-a", FamilyID: goldenFamily, DeviceID: goldenDevice, MemberID: goldenMember2})
	receiver := newTestConn(t, gw, ticket{Ticket: "g-b", FamilyID: goldenFamily, DeviceID: "dev-b", MemberID: goldenMember})
	ctx := context.Background()

	sender.handleMessage(ctx, []byte(cat["ping"]))
	if of := takeCritical(t, sender); of.wf.Type != "pong" {
		t.Errorf("ping → %s, want pong", of.wf.Type)
	}

	before := gw.bus.LastSeq()
	sender.handleMessage(ctx, []byte(cat["heartbeat"]))
	if of := awaitLow(t, receiver); of.wf.Type != "presence.changed" {
		t.Errorf("heartbeat → %s, want presence.changed (live)", of.wf.Type)
	}
	sender.handleMessage(ctx, []byte(cat["watch.signal"]))
	if of := awaitHigh(t, receiver); of.wf.Type != "watch.signal" {
		t.Errorf("watch.signal → %s, want watch.signal (live)", of.wf.Type)
	}
	if gw.bus.LastSeq() != before {
		t.Error("heartbeat or watch.signal touched the durable stream")
	}

	ch, cancel := gw.bus.Subscribe(notify.StreamSubject(goldenFamily), 0)
	defer cancel()
	sender.handleMessage(ctx, []byte(cat["location.report"]))
	if f := awaitFrame(t, ch); f.Type != "location.update" {
		t.Errorf("location.report → %s, want location.update (durable)", f.Type)
	}
}
