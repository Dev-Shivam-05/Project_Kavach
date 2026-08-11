// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION + W10 — what fan-out records for the FCM leg (RISK.md §4)
//
// internal/notify decides whether a human is woken and had zero direct tests.
// W10 replaces a MODELLED FCM leg — a jittered sleep followed by an unconditional
// "delivered" — with a real HTTP v1 send, so the first job here is to pin what
// the delivery row said before, and the second is to state what it says now and
// why the change is a correction rather than a regression.
//
// ★ THE CORRECTION ★
// The old leg recorded `delivered` for a push that was never sent, to a device
// that had no push token, from a deployment holding no FCM credentials. Those
// rows feed the four clocks and the notification matrix (§2.6.1, §16.2) — the
// only evidence a family has that the chain works. A green row for a leg that
// does not exist is worse than a red one: it is the system lying about the exact
// property W10 exists to establish. Every assertion below that expects a failure
// code is asserting that the system now tells the truth.
// ═══════════════════════════════════════════════════════════════════════════════
package notify

import (
	"context"
	crand "crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kavach/backend/internal/store"
)

// ── fakes ────────────────────────────────────────────────────────────────────

type fakeStore struct {
	mu         sync.Mutex
	members    []store.Member
	devices    []store.Device
	notifs     []store.Notification
	deliveries []store.Delivery
}

func (f *fakeStore) Members(string) []store.Member { return f.members }
func (f *fakeStore) Devices(string) []store.Device { return f.devices }

func (f *fakeStore) PutNotification(n store.Notification) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notifs = append(f.notifs, n)
	return nil
}

func (f *fakeStore) PutDelivery(d store.Delivery) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deliveries = append(f.deliveries, d)
	return nil
}

// legs returns the delivery rows for one channel, newest last.
func (f *fakeStore) legs(ch Channel) []store.Delivery {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.Delivery
	for _, d := range f.deliveries {
		if d.Channel == string(ch) {
			out = append(out, d)
		}
	}
	return out
}

type fakeBus struct {
	mu       sync.Mutex
	subjects []string
}

func (b *fakeBus) Publish(subject string, _ []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subjects = append(b.subjects, subject)
	return nil
}

type recordingSender struct {
	mu   sync.Mutex
	sent []map[string]string
	toks []string
	err  error
}

func (s *recordingSender) Send(_ context.Context, token string, data map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.toks = append(s.toks, token)
	s.sent = append(s.sent, data)
	return s.err
}

func (s *recordingSender) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sent)
}

const (
	famID  = "fam-1"
	subjID = "mem-subject"
)

// harness builds the smallest family that produces exactly one tier-1 recipient:
// the subject (whose own devices are never notified — they are already screaming
// locally) and one guardian holding an Android phone.
func harness(t *testing.T, push PushSender, token string) (*Notifier, *fakeStore, *fakeBus) {
	t.Helper()
	st := &fakeStore{
		members: []store.Member{
			{ID: subjID, FamilyID: famID, Role: "adult", ASCIIShortName: "Asha"},
			{ID: "mem-guardian", FamilyID: famID, Role: "guardian", ASCIIShortName: "Ravi",
				PhoneE164: "+919999900001"},
		},
		devices: []store.Device{
			{ID: "dev-guardian", FamilyID: famID, MemberID: "mem-guardian",
				Platform: "android", AgentHealthy: true, PushTokenFCM: token},
		},
	}
	bus := &fakeBus{}
	seq := 0
	n, err := New(Deps{
		Store: st, Bus: bus, Push: push,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now: func() time.Time { return time.UnixMilli(1_700_000_000_000).UTC() },
		NewID: func() string {
			seq++
			return "id-" + string(rune('a'+seq-1))
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(n.Close)
	return n, st, bus
}

func incident() store.Incident {
	return store.Incident{
		ID: "inc-1", FamilyID: famID, SubjectMemberID: subjID,
		Trigger: "MANUAL", State: "ACTIVE_L1", Duress: true,
	}
}

func tier1(channels ...Channel) Step {
	return Step{Tier: 1, Label: "L1", Channels: channels}
}

// ── characterization: the parts W10 must not disturb ─────────────────────────

func TestFanoutStillPublishesTheSealedFrameAndSettlesTheWSLegImmediately(t *testing.T) {
	n, st, bus := harness(t, nil, "")

	res, err := n.Fanout(context.Background(), incident(), tier1(ChannelWS))
	if err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	n.Close()

	if len(res.Audience) != 1 || res.Audience[0] != "dev-guardian" {
		t.Fatalf("audience = %v, want [dev-guardian] (the subject's own devices are excluded)", res.Audience)
	}
	if len(bus.subjects) != 1 || bus.subjects[0] != StreamSubject(famID) {
		t.Fatalf("published to %v, want one frame on %q", bus.subjects, StreamSubject(famID))
	}
	ws := st.legs(ChannelWS)
	if len(ws) != 1 || ws[0].State != "delivered" || ws[0].LatencyMs != 0 {
		t.Fatalf("ws leg = %+v, want one delivered row at 0 ms", ws)
	}
}

// The subject's own devices are excluded from the ladder. Pinned because W10
// touches the same audience path and re-notifying the person already holding a
// screaming phone is how a family learns to mute the app.
func TestFanoutNeverNotifiesTheSubjectsOwnDevice(t *testing.T) {
	n, st, _ := harness(t, &recordingSender{}, "tok-guardian")
	n.st.(*fakeStore).devices = append(n.st.(*fakeStore).devices, store.Device{
		ID: "dev-subject", FamilyID: famID, MemberID: subjID,
		Platform: "android", AgentHealthy: true, PushTokenFCM: "tok-subject",
	})

	if _, err := n.Fanout(context.Background(), incident(), tier1(ChannelWS, ChannelFCM)); err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	n.Close()

	for _, d := range st.legs(ChannelFCM) {
		if d.DeviceID == "dev-subject" {
			t.Fatal("the subject's own device was pushed to")
		}
	}
}

// A device whose agent has been silently dead is not attempted on any channel
// but the socket. Unchanged by W10 and load-bearing: it is why a dead phone
// shows as unreachable instead of as a pending delivery that never lands.
func TestFanoutSkipsPushForAnUnhealthyAgent(t *testing.T) {
	sender := &recordingSender{}
	n, st, _ := harness(t, sender, "tok-guardian")
	n.st.(*fakeStore).devices[0].AgentHealthy = false

	if _, err := n.Fanout(context.Background(), incident(), tier1(ChannelFCM)); err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	n.Close()

	if sender.calls() != 0 {
		t.Fatalf("pushed to a device with a dead agent (%d calls)", sender.calls())
	}
	legs := st.legs(ChannelFCM)
	if len(legs) != 1 || legs[0].State != "failed" || legs[0].ErrorCode != "KV-AGENT-DEAD" {
		t.Fatalf("fcm leg = %+v, want one failed KV-AGENT-DEAD row", legs)
	}
}

// ── W10: the FCM leg now reports what actually happened ──────────────────────

func TestFCMLegIsAttemptedAndDeliveredWhenTheSendSucceeds(t *testing.T) {
	sender := &recordingSender{}
	n, st, _ := harness(t, sender, "tok-guardian")

	if _, err := n.Fanout(context.Background(), incident(), tier1(ChannelFCM)); err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	n.Close()

	if sender.calls() != 1 {
		t.Fatalf("sender called %d times, want 1", sender.calls())
	}
	if sender.toks[0] != "tok-guardian" {
		t.Fatalf("sent to %q, want the device's stored token", sender.toks[0])
	}

	legs := st.legs(ChannelFCM)
	if len(legs) != 2 {
		t.Fatalf("fcm rows = %d, want 2 (sent, then delivered)", len(legs))
	}
	if legs[0].State != "sent" {
		t.Fatalf("first fcm row is %q, want \"sent\"", legs[0].State)
	}
	if legs[1].State != "delivered" || legs[1].ErrorCode != "" {
		t.Fatalf("final fcm row = %+v, want delivered with no error code", legs[1])
	}
	if legs[1].DeliveredAt == 0 {
		t.Fatal("a delivered row carries no DeliveredAt — the four clocks read this")
	}
}

// ★ THE F-21 / F-01 ASSERTION ★ The duress flag rides the sealed WS frame, where
// only the family's crypto group can read it. It must not be inferable from the
// push payload, which transits Google and lands on a lock screen.
func TestFCMPayloadCarriesOnlyTheLockScreenSafeFive(t *testing.T) {
	sender := &recordingSender{}
	n, _, _ := harness(t, sender, "tok-guardian")

	inc := incident()
	inc.Duress = true
	if _, err := n.Fanout(context.Background(), inc, tier1(ChannelFCM)); err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	n.Close()

	if sender.calls() != 1 {
		t.Fatalf("sender called %d times, want 1", sender.calls())
	}
	got := sender.sent[0]
	want := map[string]string{
		"incidentId":       "inc-1",
		"familyId":         famID,
		"trigger":          "MANUAL",
		"tier":             "1",
		"subjectShortName": "Asha",
	}
	if len(got) != len(want) {
		t.Fatalf("push payload has %d keys, want exactly %d\n got: %v\nwant: %v",
			len(got), len(want), got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("push payload[%q] = %q, want %q", k, got[k], v)
		}
	}
	if _, leaked := got["duress"]; leaked {
		t.Fatal("★ F-01 VIOLATED ★ the duress bit is inferable from the push payload")
	}
}

// A drill must never look like a real emergency on a lock screen, and the canary
// fires one every 15 minutes (F-03).
func TestFCMPayloadIsNotSentForACanaryDrillWithNoRun(t *testing.T) {
	sender := &recordingSender{}
	n, _, _ := harness(t, sender, "tok-guardian")

	inc := incident()
	inc.IsDrill = true
	res, err := n.Fanout(context.Background(), inc, tier1(ChannelFCM))
	if err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	n.Close()

	if !res.DrillScoped {
		t.Fatal("a drill fan-out is not marked drill-scoped")
	}
	if sender.calls() != 0 {
		t.Fatalf("a drill with no resolvable run pushed to %d devices — 96 times a day", sender.calls())
	}
}

func TestFCMLegRecordsNoTokenRatherThanAPhantomDelivery(t *testing.T) {
	sender := &recordingSender{}
	n, st, _ := harness(t, sender, "") // enrolled, never registered a push token

	if _, err := n.Fanout(context.Background(), incident(), tier1(ChannelFCM)); err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	n.Close()

	if sender.calls() != 0 {
		t.Fatalf("sent a push to a device with no token (%d calls)", sender.calls())
	}
	legs := st.legs(ChannelFCM)
	if len(legs) != 1 || legs[0].State != "failed" || legs[0].ErrorCode != "KV-NOTOKEN" {
		t.Fatalf("fcm leg = %+v, want one failed KV-NOTOKEN row", legs)
	}
}

func TestFCMLegRecordsNotConfiguredWhenTheDeploymentHasNoCredentials(t *testing.T) {
	n, st, _ := harness(t, nil, "tok-guardian") // a token, but nothing to send with

	if _, err := n.Fanout(context.Background(), incident(), tier1(ChannelFCM)); err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	n.Close()

	legs := st.legs(ChannelFCM)
	if len(legs) != 1 || legs[0].State != "failed" || legs[0].ErrorCode != "KV-NOPUSHCFG" {
		t.Fatalf("fcm leg = %+v, want one failed KV-NOPUSHCFG row", legs)
	}
}

// T-218: a dead token must be distinguishable from a transient failure, because
// only the first means "this family member can no longer be reached at all".
func TestFCMLegDistinguishesADeadTokenFromATransientFailure(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		code string
	}{
		{"unregistered", ErrPushUnregistered, "KV-UNREGISTERED"},
		{"rejected", ErrPushRejected, "KV-PUSHFAIL"},
		{"transport", errors.New("dial tcp: connection refused"), "KV-PUSHFAIL"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sender := &recordingSender{err: tc.err}
			n, st, _ := harness(t, sender, "tok-guardian")

			if _, err := n.Fanout(context.Background(), incident(), tier1(ChannelFCM)); err != nil {
				t.Fatalf("Fanout: %v", err)
			}
			n.Close()

			legs := st.legs(ChannelFCM)
			if len(legs) != 2 {
				t.Fatalf("fcm rows = %d, want 2 (sent, then the failure)", len(legs))
			}
			if legs[1].State != "failed" || legs[1].ErrorCode != tc.code {
				t.Fatalf("final fcm row = %+v, want failed/%s", legs[1], tc.code)
			}
			if legs[1].DeliveredAt != 0 {
				t.Fatal("a failed leg carries a DeliveredAt — the four clocks would count it")
			}
		})
	}
}

// A failing push must not take the rest of the ladder with it. This is the
// difference between "Ma's phone could not be reached" and "nobody was told".
func TestAFailingPushDoesNotStopTheSocketLeg(t *testing.T) {
	sender := &recordingSender{err: ErrPushRejected}
	n, st, _ := harness(t, sender, "tok-guardian")

	if _, err := n.Fanout(context.Background(), incident(), tier1(ChannelWS, ChannelFCM)); err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	n.Close()

	ws := st.legs(ChannelWS)
	if len(ws) != 1 || ws[0].State != "delivered" {
		t.Fatalf("ws leg = %+v, want it delivered regardless of the push outcome", ws)
	}
}

// ── the client itself ────────────────────────────────────────────────────────

// The RSA key is generated per run rather than checked in. A private key in the
// tree — even a throwaway one — is a key somebody eventually copies into a
// deployment, and this repo's rule is that no secret is ever committed.
func generateTestKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(crand.Reader, 2048)
	if err != nil {
		t.Fatalf("generating a test key: %v", err)
	}
	return key
}

func serviceAccountJSON(t *testing.T, key *rsa.PrivateKey) []byte {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshalling the test key: %v", err)
	}
	pemText := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	raw, err := json.Marshal(map[string]string{
		"type":         "service_account",
		"project_id":   "kavach-test",
		"client_email": "fcm@kavach-test.iam.gserviceaccount.com",
		"private_key":  pemText,
		"token_uri":    "https://oauth2.googleapis.com/token",
	})
	if err != nil {
		t.Fatalf("marshalling the service account: %v", err)
	}
	return raw
}

func TestNewFCMAcceptsAPKCS8ServiceAccountKey(t *testing.T) {
	c, err := NewFCM(serviceAccountJSON(t, generateTestKey(t)), nil)
	if err != nil {
		t.Fatalf("NewFCM: %v", err)
	}
	if c.projectID != "kavach-test" {
		t.Fatalf("projectID = %q", c.projectID)
	}
	if !strings.HasSuffix(c.sendURL, "/v1/projects/kavach-test/messages:send") {
		t.Fatalf("sendURL = %q", c.sendURL)
	}
}

func TestNewFCMFromEnvIsUnconfiguredRatherThanBroken(t *testing.T) {
	t.Setenv(EnvFCMCredentials, "")
	c, err := NewFCMFromEnv(nil)
	if !errors.Is(err, ErrPushNotConfigured) {
		t.Fatalf("err = %v, want ErrPushNotConfigured", err)
	}
	if c != nil {
		t.Fatal("an unconfigured client is not nil — a half-built sender is worse than none")
	}
}

func TestNewFCMRejectsAnIncompleteServiceAccount(t *testing.T) {
	if _, err := NewFCM([]byte(`{"project_id":"p"}`), nil); err == nil {
		t.Fatal("accepted a service account with no client_email or private_key")
	}
	if _, err := NewFCM([]byte(`not json`), nil); err == nil {
		t.Fatal("accepted a service account that is not JSON")
	}
}

func TestAssertPushSafeRejectsEverythingOutsideTheFive(t *testing.T) {
	ok := map[string]string{
		"incidentId": "i", "familyId": "f", "trigger": "MANUAL",
		"tier": "1", "subjectShortName": "Asha",
	}
	if err := assertPushSafe(ok); err != nil {
		t.Fatalf("the permitted five were rejected: %v", err)
	}
	for _, forbidden := range []string{"duress", "sealed", "lat", "lon", "note", "medical", "phoneE164"} {
		bad := map[string]string{"incidentId": "i", forbidden: "x"}
		if err := assertPushSafe(bad); err == nil {
			t.Fatalf("★ F-21 ★ %q was permitted in a push payload", forbidden)
		}
	}
}

// The TTL is read off the generated machine, so a change to
// spec/state-machine.yaml moves it and no constant here goes stale.
func TestPushTTLTracksTheAutoQuiesceHorizon(t *testing.T) {
	if got := pushTTL(); got != 6*time.Hour {
		t.Fatalf("pushTTL() = %v, want the AUTO_QUIESCE horizon (6h) from spec/state-machine.yaml", got)
	}
}

func TestIsUnregisteredReadsFCMErrorDetail(t *testing.T) {
	dead := []byte(`{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`)
	if !isUnregistered(dead) {
		t.Fatal("an UNREGISTERED body was not recognised as a dead token")
	}
	misconfigured := []byte(`{"error":{"status":"PERMISSION_DENIED","details":[{"errorCode":"SENDER_ID_MISMATCH"}]}}`)
	if isUnregistered(misconfigured) {
		t.Fatal("a misconfiguration was misread as a dead token — this would clear a live token")
	}
	if isUnregistered([]byte(`<html>502</html>`)) {
		t.Fatal("a non-JSON body was misread as a dead token")
	}
}

// ── the wire shape, against a stub FCM ───────────────────────────────────────

// fcmStub stands in for both Google endpoints and captures the message body.
type fcmStub struct {
	srv        *httptest.Server
	mu         sync.Mutex
	message    map[string]any
	tokenCalls int
	sendStatus int
	sendBody   string
}

func newFCMStub(t *testing.T) *fcmStub {
	t.Helper()
	s := &fcmStub{sendStatus: http.StatusOK, sendBody: `{"name":"projects/p/messages/1"}`}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.tokenCalls++
		s.mu.Unlock()
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
			http.Error(w, "bad grant_type", http.StatusBadRequest)
			return
		}
		if strings.Count(r.Form.Get("assertion"), ".") != 2 {
			http.Error(w, "assertion is not a JWT", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"at-1","expires_in":3600}`)
	})
	mux.HandleFunc("/send", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer at-1" {
			http.Error(w, "missing bearer", http.StatusUnauthorized)
			return
		}
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		_ = json.Unmarshal(body, &s.message)
		status, resp := s.sendStatus, s.sendBody
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, resp)
	})
	s.srv = httptest.NewServer(mux)
	t.Cleanup(s.srv.Close)
	return s
}

func (s *fcmStub) client(t *testing.T) *FCMClient {
	t.Helper()
	key := generateTestKey(t)
	c, err := NewFCM(serviceAccountJSON(t, key), func() time.Time {
		return time.UnixMilli(1_700_000_000_000).UTC()
	})
	if err != nil {
		t.Fatalf("NewFCM: %v", err)
	}
	c.tokenURI = s.srv.URL + "/token"
	c.sendURL = s.srv.URL + "/send"
	return c
}

func TestFCMClientSendsADataOnlyHighPriorityMessage(t *testing.T) {
	stub := newFCMStub(t)
	c := stub.client(t)

	err := c.Send(context.Background(), "tok-1", map[string]string{
		"incidentId": "inc-1", "familyId": famID, "trigger": "MANUAL",
		"tier": "1", "subjectShortName": "Asha",
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	stub.mu.Lock()
	defer stub.mu.Unlock()
	msg, ok := stub.message["message"].(map[string]any)
	if !ok {
		t.Fatalf("body has no message object: %v", stub.message)
	}
	if _, present := msg["notification"]; present {
		t.Fatal("★ F-21 VIOLATED ★ the message carries a server-composed notification block")
	}
	if msg["token"] != "tok-1" {
		t.Fatalf("message.token = %v, want tok-1", msg["token"])
	}
	android, ok := msg["android"].(map[string]any)
	if !ok {
		t.Fatalf("message has no android block: %v", msg)
	}
	if android["priority"] != "HIGH" {
		t.Fatalf("android.priority = %v, want HIGH — anything else waits for a Doze window", android["priority"])
	}
	if android["ttl"] != "21600s" {
		t.Fatalf("android.ttl = %v, want 21600s (the AUTO_QUIESCE horizon)", android["ttl"])
	}
}

func TestFCMClientReusesItsAccessToken(t *testing.T) {
	stub := newFCMStub(t)
	c := stub.client(t)
	data := map[string]string{"incidentId": "inc-1"}

	for i := 0; i < 3; i++ {
		if err := c.Send(context.Background(), "tok-1", data); err != nil {
			t.Fatalf("Send %d: %v", i, err)
		}
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.tokenCalls != 1 {
		t.Fatalf("minted %d access tokens for 3 sends, want 1 — an emergency fan-out"+
			" cannot spend an RSA signature per device", stub.tokenCalls)
	}
}

func TestFCMClientMapsADeadTokenToErrPushUnregistered(t *testing.T) {
	stub := newFCMStub(t)
	stub.sendStatus = http.StatusNotFound
	stub.sendBody = `{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`
	c := stub.client(t)

	err := c.Send(context.Background(), "tok-dead", map[string]string{"incidentId": "inc-1"})
	if !errors.Is(err, ErrPushUnregistered) {
		t.Fatalf("Send = %v, want ErrPushUnregistered", err)
	}
}

func TestFCMClientRefusesToSendToAnEmptyToken(t *testing.T) {
	stub := newFCMStub(t)
	c := stub.client(t)
	if err := c.Send(context.Background(), "  ", map[string]string{"incidentId": "i"}); !errors.Is(err, ErrPushUnregistered) {
		t.Fatalf("Send to an empty token = %v, want ErrPushUnregistered", err)
	}
}

func TestFCMClientRefusesAForbiddenPayloadBeforeItLeavesTheProcess(t *testing.T) {
	stub := newFCMStub(t)
	c := stub.client(t)
	err := c.Send(context.Background(), "tok-1", map[string]string{"incidentId": "i", "duress": "true"})
	if err == nil {
		t.Fatal("★ F-01 ★ a payload carrying the duress bit was sent")
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.message != nil {
		t.Fatal("the forbidden payload reached the wire before it was rejected")
	}
}
