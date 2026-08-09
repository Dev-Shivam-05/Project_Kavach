package main

import (
	"bufio"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kavach/backend/internal/envelope"
	"github.com/kavach/backend/internal/logx"
	"github.com/kavach/backend/internal/store"
	"github.com/kavach/backend/internal/wal"
)

const (
	testFamily = "11111111-1111-7111-8111-111111111111"
	testMember = "22222222-2222-7222-8222-222222222222"
	testDevice = "33333333-3333-7333-8333-333333333333"
	testPhone  = "+919812345678"
)

var testSMSKey = []byte("kavach-test-sms-hmac-key-32bytes")

// seed writes the family, member and device the caches are primed from. It runs
// BEFORE New() so that boot exercises the real path: store → cache → cache.json.
func seed(t *testing.T, dir string) ed25519.PrivateKey {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "store"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.PutFamily(store.Family{
		ID: testFamily, DisplayName: "Test", CreatedAt: 1,
		SMSHMACKeyB64: base64.StdEncoding.EncodeToString(testSMSKey),
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.PutMember(store.Member{
		ID: testMember, FamilyID: testFamily, DisplayName: "Priya",
		ASCIIShortName: "PRIYA", Role: "adult", PhoneE164: testPhone,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.PutDevice(store.Device{
		ID: testDevice, FamilyID: testFamily, MemberID: testMember, Platform: "android",
		SigningPubkey: base64.StdEncoding.EncodeToString(pub), AgentHealthy: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.Flush(); err != nil {
		t.Fatal(err)
	}
	return priv
}

// sinkRecorder stands in for the notify transport on the Class A′ path. It
// exists to prove the precise coordinates actually REACH fan-out — "never
// persisted" is only a virtue if the alert still goes out.
type sinkRecorder struct {
	mu  sync.Mutex
	got []string
}

func (r *sinkRecorder) fn(alert string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, alert)
	return nil
}

func (r *sinkRecorder) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.got...)
}

func newTestServer(t *testing.T, dir string, sink ...func(string) error) *Server {
	t.Helper()
	var fanout func(string) error
	if len(sink) > 0 {
		fanout = sink[0]
	}
	srv, err := New(Config{
		DataDir: dir,
		// Quiet, but still deny-listed: a PII violation in a log line inside a test
		// must still panic (I-6).
		Logger:     logx.NewTo(os.Stderr, slog.LevelError, true),
		FanoutSink: fanout,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv
}

func envFor(incidentID string, tsMs int64) envelope.Envelope {
	return envelope.Envelope{
		V: 1, IncidentID: incidentID, FamilyID: testFamily, DeviceID: testDevice,
		MemberID: testMember, ClientTsMs: tsMs, HLC: fmt.Sprintf("%012x0001aabbccdd", tsMs),
		Trigger: "MANUAL", ConfidencePct: 100, RiskContext: 2, Duress: false,
		IsDrill: false, PolicyVersion: 1, CoarseCell: "c7:23.02:72.57", BatteryPct: 61,
		SealedPayload: "AZ+sealed+ciphertext+placeholder", Flags: 0,
	}
}

func sealed(t *testing.T, priv ed25519.PrivateKey, e envelope.Envelope) *envelope.Signed {
	t.Helper()
	sg, err := envelope.Seal(&e, priv)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if len(sg.Body) != envelope.FixedEnvelopeSize {
		t.Fatalf("body is %d bytes, want %d", len(sg.Body), envelope.FixedEnvelopeSize)
	}
	return sg
}

func post(t *testing.T, srv *Server, path string, payload any) (int, ack) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw)))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	var a ack
	_ = json.Unmarshal(rec.Body.Bytes(), &a)
	return rec.Code, a
}

// ── the envelope's canonical form round-trips ────────────────────────────────

// TestEnvelopeCanonicalRoundTrip is the three-way agreement the whole signature
// scheme rests on: canonicalise → parse → canonicalise must be byte-identical,
// or a body signed on a phone can never verify on a server.
func TestEnvelopeCanonicalRoundTrip(t *testing.T) {
	e := envFor("44444444-4444-7444-8444-444444444444", 1717171717000)
	if err := envelope.Pad(&e); err != nil {
		t.Fatal(err)
	}
	body := envelope.Canonical(&e)
	if len(body) != envelope.FixedEnvelopeSize {
		t.Fatalf("padded body is %d bytes, want %d", len(body), envelope.FixedEnvelopeSize)
	}

	parsed, anomaly, err := envelope.Parse(body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if anomaly != 0 {
		t.Fatalf("canonical body reported anomalies: %s", anomaly)
	}
	if string(envelope.Canonical(parsed)) != string(body) {
		t.Fatal("re-canonicalising a parsed envelope changed the bytes")
	}
	if *parsed != e {
		t.Fatalf("round trip lost fields:\n got %+v\nwant %+v", *parsed, e)
	}

	// Key ORDER is part of the contract: the first key must be "v" and the last
	// "pad", exactly as KEY_ORDER declares in mobile/src/t0/envelope.ts.
	if !strings.HasPrefix(string(body), `{"v":1,"incidentId":`) {
		t.Fatalf("canonical form does not start with the declared key order: %.40s", body)
	}
	if !strings.HasSuffix(string(body), `.."}`) {
		t.Fatal("canonical form does not end with the pad field")
	}

	// ★ F-01: duress must not change the wire size, in either direction.
	d := e
	d.Duress = true
	if err := envelope.Pad(&d); err != nil {
		t.Fatal(err)
	}
	if len(envelope.Canonical(&d)) != envelope.FixedEnvelopeSize {
		t.Fatal("a duress envelope is not the fixed size — the duress bit leaks")
	}

	// A payload that cannot fit must fail closed, never emit a short envelope.
	big := e
	big.SealedPayload = strings.Repeat("x", envelope.FixedEnvelopeSize)
	if err := envelope.Pad(&big); err == nil {
		t.Fatal("oversized envelope was padded instead of refused")
	}
}

// ── signature verification, and fail-open ────────────────────────────────────

func TestSignatureVerifyAndFailOpen(t *testing.T) {
	dir := t.TempDir()
	priv := seed(t, dir)
	srv := newTestServer(t, dir)

	t.Run("valid signature verifies", func(t *testing.T) {
		sg := sealed(t, priv, envFor("55555555-5555-7555-8555-555555555555", 1717171717001))
		code, a := post(t, srv, "/v1/incident/open", sg)
		if code != http.StatusOK {
			t.Fatalf("status %d, want 200", code)
		}
		if !a.Verified {
			t.Fatal("a correctly signed envelope was not verified")
		}
		if a.Flags&envelope.FlagUnverified != 0 {
			t.Fatal("FLAG_UNVERIFIED set on a verified envelope")
		}
		if a.ServerTsMs == 0 {
			t.Fatal("no server timestamp: the client cannot show 'help is on the way'")
		}
	})

	t.Run("bad signature is accepted and flagged, never dropped", func(t *testing.T) {
		sg := sealed(t, priv, envFor("66666666-6666-7666-8666-666666666666", 1717171717002))
		sg.Signature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
		before := srv.m.Unverified.Load()
		code, a := post(t, srv, "/v1/incident/open", sg)
		if code != http.StatusOK {
			t.Fatalf("status %d — ADR-018 says a bad signature is flagged, not rejected", code)
		}
		if a.Verified {
			t.Fatal("a forged signature verified")
		}
		if a.Flags&envelope.FlagUnverified == 0 {
			t.Fatal("FLAG_UNVERIFIED not set on an unverified envelope")
		}
		if srv.m.Unverified.Load() != before+1 {
			t.Fatal("the unverified-incident metric did not move")
		}
	})

	t.Run("unknown device still opens an incident", func(t *testing.T) {
		e := envFor("77777777-7777-7777-8777-777777777777", 1717171717003)
		e.DeviceID = "99999999-9999-7999-8999-999999999999" // never enrolled
		sg := sealed(t, priv, e)
		code, a := post(t, srv, "/v1/incident/open", sg)
		if code != http.StatusOK || a.Verified {
			t.Fatalf("status %d verified %v, want 200/false", code, a.Verified)
		}
	})

	t.Run("unknown family is bounded at the edge", func(t *testing.T) {
		e := envFor("88888888-8888-7888-8888-888888888888", 1717171717004)
		e.FamilyID = "00000000-0000-7000-8000-000000000000"
		sg := sealed(t, priv, e)
		code, _ := post(t, srv, "/v1/incident/open", sg)
		if code != http.StatusNotFound {
			t.Fatalf("status %d, want 404 — F-04 bounds fail-open to KNOWN families", code)
		}
	})

	t.Run("the incident reaches the store off the request path", func(t *testing.T) {
		if !srv.projector.Drain(3 * time.Second) {
			t.Fatal("projector did not catch up")
		}
		inc, ok := srv.st.Incident("55555555-5555-7555-8555-555555555555")
		if !ok {
			t.Fatal("incident was never projected")
		}
		if inc.State != "PENDING" {
			t.Fatalf("state %s, want PENDING", inc.State)
		}
		if inc.CoarseH3R7 != "c7:23.02:72.57" {
			t.Fatalf("coarse cell %q was not preserved", inc.CoarseH3R7)
		}
		if len(srv.st.Events(inc.ID)) == 0 {
			t.Fatal("no incident_event row was appended")
		}
	})
}

// ── idempotency ──────────────────────────────────────────────────────────────

// TestIdempotentOnIncidentID is P-053 in action: the client owns the id, so the
// same emergency fired over five transports must cost one incident.
func TestIdempotentOnIncidentID(t *testing.T) {
	dir := t.TempDir()
	priv := seed(t, dir)
	srv := newTestServer(t, dir)

	sg := sealed(t, priv, envFor("aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", 1717171717010))
	code, first := post(t, srv, "/v1/incident/open", sg)
	if code != http.StatusOK || first.Duplicate {
		t.Fatalf("first open: status %d duplicate %v", code, first.Duplicate)
	}
	walAfterFirst := srv.wal.Count()

	for i := 0; i < 4; i++ {
		code, a := post(t, srv, "/v1/incident/open", sg)
		if code != http.StatusOK {
			t.Fatalf("retry %d: status %d — §2.9.3 says a duplicate is a SUCCESS", i, code)
		}
		if !a.Duplicate || a.Code != "KV-1003" {
			t.Fatalf("retry %d was not reported as a duplicate: %+v", i, a)
		}
		if a.IncidentID != first.IncidentID {
			t.Fatal("a retry was given a different incident id")
		}
	}
	if got := srv.wal.Count(); got != walAfterFirst {
		t.Fatalf("wal grew from %d to %d on retries — the WAL is not idempotent", walAfterFirst, got)
	}
	if srv.m.Duplicates.Load() != 4 {
		t.Fatalf("duplicate metric is %d, want 4", srv.m.Duplicates.Load())
	}

	if !srv.projector.Drain(3 * time.Second) {
		t.Fatal("projector did not catch up")
	}
	if n := len(srv.st.Incidents(testFamily)); n != 1 {
		t.Fatalf("%d incidents projected, want exactly 1", n)
	}
	if n := len(srv.st.Events("aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa")); n != 1 {
		t.Fatalf("%d event rows, want exactly 1 — dedupe is on (incident_id, hlc)", n)
	}
}

// ── the flood-coalescing bound ───────────────────────────────────────────────

// TestUnverifiedFloodCoalesces proves the F-04 bound: past the threshold,
// unverified incidents from one FAMILY collapse into one incident. Nothing is
// ever dropped — that is what makes coalescing acceptable in a safety system.
func TestUnverifiedFloodCoalesces(t *testing.T) {
	dir := t.TempDir()
	priv := seed(t, dir)
	srv := newTestServer(t, dir)

	ids := []string{
		"b0000000-0000-7000-8000-00000000000a",
		"b0000000-0000-7000-8000-00000000000b",
		"b0000000-0000-7000-8000-00000000000c",
		"b0000000-0000-7000-8000-00000000000d",
		"b0000000-0000-7000-8000-00000000000e",
		"b0000000-0000-7000-8000-00000000000f",
	}
	var acks []ack
	for i, id := range ids {
		e := envFor(id, 1717171717100+int64(i))
		sg := sealed(t, priv, e)
		// Break the signature so every one of these takes the unverified path.
		sg.Signature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
		code, a := post(t, srv, "/v1/incident/open", sg)
		if code != http.StatusOK {
			t.Fatalf("open %d: status %d — a flood must never be dropped", i, code)
		}
		acks = append(acks, a)
	}

	for i := 0; i < floodThreshold; i++ {
		if acks[i].Flags&envelope.FlagUnverifiedFlood != 0 {
			t.Fatalf("incident %d was coalesced below the threshold", i)
		}
		if acks[i].IncidentID != ids[i] {
			t.Fatalf("incident %d lost its own id below the threshold", i)
		}
	}
	for i := floodThreshold; i < len(ids); i++ {
		if acks[i].Flags&envelope.FlagUnverifiedFlood == 0 {
			t.Fatalf("incident %d past the threshold was not flagged UNVERIFIED_FLOOD", i)
		}
		if acks[i].IncidentID != ids[0] {
			t.Fatalf("incident %d coalesced into %q, want the window's first id %q",
				i, acks[i].IncidentID, ids[0])
		}
		if acks[i].CoalescedInto != ids[0] {
			t.Fatal("the client was not told which incident absorbed its report")
		}
	}

	if !srv.projector.Drain(3 * time.Second) {
		t.Fatal("projector did not catch up")
	}
	// The blast radius is capped: threshold incidents, not six.
	if n := len(srv.st.Incidents(testFamily)); n != floodThreshold {
		t.Fatalf("%d incidents projected, want %d — coalescing did not cap the fan-out", n, floodThreshold)
	}

	t.Run("a verified incident is never rate limited", func(t *testing.T) {
		sg := sealed(t, priv, envFor("c0000000-0000-7000-8000-000000000001", 1717171717200))
		code, a := post(t, srv, "/v1/incident/open", sg)
		if code != http.StatusOK || !a.Verified {
			t.Fatalf("status %d verified %v", code, a.Verified)
		}
		if a.Flags&envelope.FlagUnverifiedFlood != 0 || a.CoalescedInto != "" {
			t.Fatal("a verified incident was caught by the unverified flood guard")
		}
	})
}

// ── sms-inbound: inc8 reconciliation (F-09) and Class A′ (F-10) ──────────────

func k1(incidentID string, atMs int64, lat, lon float64, key []byte) string {
	body := strings.Join([]string{
		"K1", envelope.Inc8(incidentID), "PRIYA", "SOS",
		strconv.FormatFloat(lat, 'f', 6, 64) + "," + strconv.FormatFloat(lon, 'f', 6, 64),
		"12", "61", strconv.FormatInt(atMs/1000, 36),
	}, "|")
	return body + "|" + envelope.SMSTag(key, body) + " PRIYA NEEDS HELP. " +
		strconv.FormatFloat(lat, 'f', 6, 64) + "," + strconv.FormatFloat(lon, 'f', 6, 64)
}

func TestSMSInboundInc8Reconciliation(t *testing.T) {
	dir := t.TempDir()
	priv := seed(t, dir)
	sink := &sinkRecorder{}
	srv := newTestServer(t, dir, sink.fn)

	const httpIncident = "d0000000-0000-7000-8000-000000000001"
	const lat, lon = 23.0225, 72.5714

	t.Run("an SMS for a known inc8 joins the existing incident", func(t *testing.T) {
		sg := sealed(t, priv, envFor(httpIncident, 1717171717300))
		if code, _ := post(t, srv, "/v1/incident/open", sg); code != http.StatusOK {
			t.Fatalf("http open: status %d", code)
		}
		code, a := post(t, srv, "/v1/incident/sms-inbound", smsWebhook{
			From: testPhone, Text: k1(httpIncident, 1717171717300, lat, lon, testSMSKey),
			ReceivedAtMs: 1717171717400,
		})
		if code != http.StatusOK {
			t.Fatalf("sms-inbound: status %d", code)
		}
		if a.IncidentID != httpIncident {
			t.Fatalf("SMS minted %q instead of joining %q — F-09 duplicate", a.IncidentID, httpIncident)
		}
		if !a.Verified {
			t.Fatal("a correctly tagged SMS did not verify")
		}
		if a.Flags&envelope.FlagSMSOrigin == 0 {
			t.Fatal("FLAG_SMS_ORIGIN not set")
		}
	})

	t.Run("a bad sig8 is flagged, not dropped", func(t *testing.T) {
		bad := k1("d0000000-0000-7000-8000-00000000000b", 1717171717500, lat, lon, []byte("wrong-key"))
		code, a := post(t, srv, "/v1/incident/sms-inbound", smsWebhook{
			From: testPhone, Text: bad, ReceivedAtMs: 1717171717500,
		})
		if code != http.StatusOK {
			t.Fatalf("status %d — ADR-018 fail-open applies to SMS too", code)
		}
		if a.Verified || a.Flags&envelope.FlagUnverified == 0 {
			t.Fatal("a bad sig8 was not flagged")
		}
	})

	t.Run("an unknown sender is bounded", func(t *testing.T) {
		code, _ := post(t, srv, "/v1/incident/sms-inbound", smsWebhook{
			From: "+10000000000", Text: k1(httpIncident, 1717171717600, lat, lon, testSMSKey),
		})
		if code != http.StatusNotFound {
			t.Fatalf("status %d, want 404 for an unresolvable MSISDN", code)
		}
	})

	t.Run("a miss mints a DETERMINISTIC id, stable across restarts", func(t *testing.T) {
		const unseen = "e0000000-0000-7000-8000-000000000009"
		text := k1(unseen, 1717171717700, lat, lon, testSMSKey)
		_, a1 := post(t, srv, "/v1/incident/sms-inbound", smsWebhook{
			From: testPhone, Text: text, ReceivedAtMs: 1717171717700,
		})
		if a1.IncidentID == unseen {
			t.Fatal("the synthetic id equals the full id, which the SMS never carried")
		}

		// A completely separate process, same family, same inc8, same 300 s window.
		other := t.TempDir()
		seed(t, other)
		srv2 := newTestServer(t, other)
		_, a2 := post(t, srv2, "/v1/incident/sms-inbound", smsWebhook{
			From: testPhone, Text: text, ReceivedAtMs: 1717171717701,
		})
		if a1.IncidentID != a2.IncidentID {
			t.Fatalf("id is not deterministic across processes: %q vs %q — a second SMS "+
				"would create a third incident", a1.IncidentID, a2.IncidentID)
		}
	})

	t.Run("Class A prime: precise coordinates are never persisted", func(t *testing.T) {
		if !srv.projector.Drain(3 * time.Second) {
			t.Fatal("projector did not catch up")
		}
		inc, ok := srv.st.Incident(httpIncident)
		if !ok {
			t.Fatal("incident missing")
		}
		if inc.CoarseH3R7 != envelope.CoarseCell(lat, lon) && inc.CoarseH3R7 != "c7:23.02:72.57" {
			t.Fatalf("coarse cell %q is neither the SMS cell nor the HTTP cell", inc.CoarseH3R7)
		}
		precise := strconv.FormatFloat(lat, 'f', 6, 64)
		for _, name := range []string{"sos.wal", filepath.Join("bus", "stream.wal")} {
			raw, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(raw), precise) {
				t.Fatalf("%s contains the precise latitude — Class A′ must never be written", name)
			}
		}
		for _, name := range []string{"incident.json", "incident_event.json", "access_log.json"} {
			raw, err := os.ReadFile(filepath.Join(dir, "store", name))
			if err != nil {
				continue
			}
			if strings.Contains(string(raw), precise) {
				t.Fatalf("store/%s contains the precise latitude", name)
			}
		}
		// …and the disclosure is recorded and surfaced to the subject.
		var found bool
		for _, a := range srv.st.AccessLog(testFamily) {
			if a.DegradedPlaintext && a.SubjectMemberID == testMember {
				found = true
			}
		}
		if !found {
			t.Fatal("no access_log row recorded the Class A′ disclosure (F-10)")
		}
		if srv.m.FanoutAPrime.Load() == 0 {
			t.Fatal("the in-memory A′ fan-out never ran")
		}

		// "Never persisted" is only a virtue if the alert still goes out. The
		// responder must receive the PRECISE pair — a coarse cell is a 1 km square
		// to search — so prove it reached the sink even though it reached no file.
		var carried bool
		for _, alert := range sink.all() {
			if strings.Contains(alert, precise) {
				carried = true
			}
		}
		if !carried {
			t.Fatalf("the A′ fan-out never carried the precise coordinates: %q", sink.all())
		}
	})
}

// ── WAL ──────────────────────────────────────────────────────────────────────

// TestWALReplayRebuildsIdempotency: a restart mid-incident must not mint a
// duplicate for the very next retry the phone sends.
func TestWALReplayRebuildsIdempotency(t *testing.T) {
	dir := t.TempDir()
	priv := seed(t, dir)

	const id = "f0000000-0000-7000-8000-000000000001"
	sg := sealed(t, priv, envFor(id, 1717171717800))

	srv := newTestServer(t, dir)
	if code, a := post(t, srv, "/v1/incident/open", sg); code != http.StatusOK || a.Duplicate {
		t.Fatalf("first open: status %d duplicate %v", code, a.Duplicate)
	}
	if srv.wal.Count() != 1 {
		t.Fatalf("wal has %d records, want 1", srv.wal.Count())
	}
	if !srv.projector.Drain(3 * time.Second) {
		t.Fatal("projector did not catch up")
	}
	if err := srv.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	restarted := newTestServer(t, dir)
	if restarted.wal.Count() != 1 {
		t.Fatalf("wal lost its record across restart: %d", restarted.wal.Count())
	}
	code, a := post(t, restarted, "/v1/incident/open", sg)
	if code != http.StatusOK {
		t.Fatalf("post-restart retry: status %d", code)
	}
	if !a.Duplicate {
		t.Fatal("the restart forgot the incident: a retry would have duplicated it")
	}
	if !restarted.projector.Drain(3 * time.Second) {
		t.Fatal("projector did not catch up after restart")
	}
	if n := len(restarted.st.Incidents(testFamily)); n != 1 {
		t.Fatalf("%d incidents after restart, want 1", n)
	}
	// F-22: the key cache came back warm, so nothing is spuriously UNVERIFIED.
	if _, ok := restarted.key(testDevice); !ok {
		t.Fatal("the device key cache did not survive the restart (F-22)")
	}
	if _, err := os.Stat(filepath.Join(dir, "cache.json")); err != nil {
		t.Fatalf("cache.json was never persisted: %v", err)
	}
}

// TestWALTornTailIsRepaired simulates a crash in the middle of a record write.
func TestWALTornTailIsRepaired(t *testing.T) {
	path := filepath.Join(t.TempDir(), "torn.wal")
	w, err := wal.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range [][]byte{[]byte("first"), []byte("second"), []byte("third")} {
		if _, err := w.AppendSync(p); err != nil {
			t.Fatal(err)
		}
	}
	size := w.Size()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	// Chop the last record in half: header written, payload truncated.
	if err := os.Truncate(path, size-3); err != nil {
		t.Fatal(err)
	}

	reopened, err := wal.Open(path)
	if err != nil {
		t.Fatalf("a torn WAL must open, not fail: %v", err)
	}
	defer reopened.Close()
	if torn, _ := reopened.TornTailTruncated(); !torn {
		t.Fatal("the torn tail was not detected")
	}
	if reopened.Count() != 2 {
		t.Fatalf("replayed %d records, want the 2 intact ones", reopened.Count())
	}
	var got []string
	if err := reopened.Replay(func(_ uint64, _ int64, p []byte) error {
		got = append(got, string(p))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "first,second" {
		t.Fatalf("replay returned %v", got)
	}
	// The repaired log must still be writable, at the truncated offset.
	if _, err := reopened.AppendSync([]byte("fourth")); err != nil {
		t.Fatal(err)
	}
	if reopened.Count() != 3 {
		t.Fatalf("count %d after appending to a repaired log, want 3", reopened.Count())
	}
}

// ── health ───────────────────────────────────────────────────────────────────

func TestHealthzIsSelfContained(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir)
	srv := newTestServer(t, dir)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d — the canary reads this every 15 minutes", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"status", "walRecords", "busSeq", "cachedKeys", "metrics"} {
		if _, ok := body[k]; !ok {
			t.Fatalf("/healthz is missing %q", k)
		}
	}
	if body["piiViolations"].(float64) != 0 {
		t.Fatal("a PII deny-list violation was recorded (I-6)")
	}
}

// ── invariant I-6: the PII deny-list ─────────────────────────────────────────

// TestPIIDenyListBites guards the guard. A deny-list that has been quietly
// shortened, or a handler that stops checking, fails silently and open — six
// months later the coordinates are in a log aggregator that was never in the
// threat model. This test is the thing that notices.
func TestPIIDenyListBites(t *testing.T) {
	forbidden := []string{"lat", "lon", "latitude", "longitude", "name", "phone",
		"address", "message", "coords", "location", "email", "userLat", "home_address"}
	for _, k := range forbidden {
		if !logx.Violation(k) {
			t.Errorf("%q is not on the deny-list", k)
		}
	}
	// …without becoming unusable: these must stay loggable.
	for _, k := range []string{"latency", "latencyMs", "namespace", "incident", "coarseCell", "flags"} {
		if logx.Violation(k) {
			t.Errorf("%q is denied, but the deny-list must not eat legitimate fields", k)
		}
	}

	t.Run("dev panics", func(t *testing.T) {
		defer func() {
			r := recover()
			if r == nil {
				t.Fatal("logging a denied field did not panic in development (I-6)")
			}
			if s, ok := r.(string); ok && strings.Contains(s, "23.0225") {
				t.Fatal("the panic message carried the value — it must carry the KEY only")
			}
		}()
		logx.NewTo(io.Discard, slog.LevelDebug, true).Info("boom", "lat", 23.0225)
	})

	t.Run("production redacts and counts instead of crashing", func(t *testing.T) {
		var buf strings.Builder
		before := logx.Redactions()
		logx.NewTo(&buf, slog.LevelDebug, false).Info("survived", "lat", 23.0225)
		out := buf.String()
		if strings.Contains(out, "23.0225") {
			t.Fatalf("production logged the raw value: %s", out)
		}
		if !strings.Contains(out, "REDACTED") {
			t.Fatalf("production did not redact: %s", out)
		}
		if logx.Redactions() <= before {
			t.Fatal("the redaction counter did not move")
		}
	})
}

// ── the budget itself ────────────────────────────────────────────────────────

// TestLOCBudget is the CI-enforced ceiling from ADR-002. It counts source lines,
// excluding blanks and comments: comments are how this file stays reviewable and
// must never be what pushes it over.
func TestLOCBudget(t *testing.T) {
	const budget = 1000
	f, err := os.Open("main.go")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	loc, inBlock := 0, false
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if inBlock {
			if idx := strings.Index(line, "*/"); idx >= 0 {
				inBlock = false
				line = strings.TrimSpace(line[idx+2:])
			} else {
				continue
			}
		}
		if idx := strings.Index(line, "/*"); idx >= 0 && !strings.Contains(line[:idx], `"`) {
			inBlock = !strings.Contains(line[idx:], "*/")
			line = strings.TrimSpace(line[:idx])
		}
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		loc++
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if loc > budget {
		t.Fatalf("sos-ingest is %d source lines, over the ADR-002 budget of %d. "+
			"Move something to the control plane — not into this file.", loc, budget)
	}
	t.Logf("sos-ingest: %d/%d source lines", loc, budget)
}
