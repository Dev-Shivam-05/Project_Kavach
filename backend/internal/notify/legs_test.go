// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION — delivery legs outlive the request that started them
// (§2.6.4 · D-015 · F-20 · D-007)
//
// Four things this file pins, each of which shipped wrong at least once:
//
//  1. A push started from an HTTP handler survives the handler returning. Every
//     HTTP-initiated transition — CLAIM, RELEASE, REESCALATE, the duress cancel
//     — hands notify the request context, which net/http cancels the moment
//     ServeHTTP returns. sendPush ran the FCM round trip under that context, so
//     "CLAIM goes over BOTH channels" never left the server for a closed phone,
//     and the delivery matrix said KV-SHUTDOWN about a process that was running.
//  2. Close is still the thing that cuts a leg short, and says so truthfully.
//  3. Every field of Step reaches the neighbour leg. The reduced Step was
//     rebuilt by hand, and the next field added to Step would have been dropped
//     for neighbours only, with every main-path test green (CLAUDE.md).
//  4. The neighbour feed never carries the duress bit, in either spelling:
//     not as `duress`, and not as the state name ACTIVE_L1_SILENT, which exists
//     for PIN_DURESS alone. The family stream keeps both — relatives must know.
//
// ═══════════════════════════════════════════════════════════════════════════════
package notify

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"testing"
	"time"

	sm "github.com/kavach/backend/internal/incident"
	"github.com/kavach/backend/internal/store"
)

// gatedSender blocks every Send until release is closed, or until the context
// it was handed ends — which is the difference this file exists to measure.
type gatedSender struct {
	release chan struct{}
	seen    chan context.Context
}

func newGatedSender() *gatedSender {
	return &gatedSender{release: make(chan struct{}), seen: make(chan context.Context, 8)}
}

func (g *gatedSender) Send(ctx context.Context, _ string, _ map[string]string) error {
	g.seen <- ctx
	select {
	case <-g.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func finalFCMRow(t *testing.T, st *fakeStore) store.Delivery {
	t.Helper()
	legs := st.legs(ChannelFCM)
	if len(legs) == 0 {
		t.Fatal("no fcm rows at all")
	}
	return legs[len(legs)-1]
}

func TestAPushStartedFromARequestSurvivesTheRequestEnding(t *testing.T) {
	sender := newGatedSender()
	n, st, _ := harness(t, sender, "tok-guardian")

	// The shape of every HTTP-initiated transition: a request context that is
	// cancelled the instant the handler writes its response.
	reqCtx, endRequest := context.WithCancel(context.Background())
	if _, err := n.Fanout(reqCtx, incident(), tier1(ChannelFCM)); err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	select {
	case <-sender.seen:
	case <-time.After(2 * time.Second):
		t.Fatal("the push leg never started")
	}
	endRequest() // ServeHTTP returned; FCM has not answered yet.

	close(sender.release) // FCM answers 200 a moment later.
	n.Close()

	if row := finalFCMRow(t, st); row.State != "delivered" || row.ErrorCode != "" {
		t.Fatalf("final fcm row = %+v, want delivered — the request ending killed the push", row)
	}
}

func TestCloseCutsAnInFlightPushShortAndRecordsShutdownNotAPushFailure(t *testing.T) {
	sender := newGatedSender()
	n, st, _ := harness(t, sender, "tok-guardian")

	if _, err := n.Fanout(context.Background(), incident(), tier1(ChannelFCM)); err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	select {
	case ctx := <-sender.seen:
		if ctx.Err() != nil {
			t.Fatal("the leg's context was already cancelled before Close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the push leg never started")
	}
	n.Close() // never released: the process is going down mid-flight

	row := finalFCMRow(t, st)
	if row.State != "unknown" || row.ErrorCode != "KV-SHUTDOWN" {
		t.Fatalf("final fcm row = %+v, want unknown/KV-SHUTDOWN — a shutdown is not FCM refusing", row)
	}
}

// ── every Step field reaches the neighbour leg ───────────────────────────────

// fill sets every exported field of a Step to a distinctive non-zero value, so
// that a field which is not copied is visibly absent. A field of a kind this
// helper cannot synthesise fails the test: that is the decision point the
// CLAUDE.md trap describes, surfaced at `go test` instead of on a phone.
func fill(t *testing.T, v reflect.Value) {
	t.Helper()
	for i := 0; i < v.NumField(); i++ {
		f := v.Field(i)
		name := v.Type().Field(i).Name
		switch f.Kind() {
		case reflect.Int:
			f.SetInt(7)
		case reflect.Bool:
			f.SetBool(true)
		case reflect.String:
			f.SetString("filled-" + name)
		case reflect.Slice:
			if f.Type().Elem().Kind() == reflect.String {
				f.Set(reflect.MakeSlice(f.Type(), 0, 0))
				f.Set(reflect.Append(f, reflect.ValueOf("sms").Convert(f.Type().Elem()),
					reflect.ValueOf("ws").Convert(f.Type().Elem()), reflect.ValueOf("fcm").Convert(f.Type().Elem())))
			} else {
				t.Fatalf("Step.%s is a %s: teach fill() how to populate it and decide whether neighbours get it", name, f.Type())
			}
		default:
			t.Fatalf("Step.%s is a %s: teach fill() how to populate it and decide whether neighbours get it", name, f.Type())
		}
	}
}

func TestEveryStepFieldReachesTheNeighbourLeg(t *testing.T) {
	var in Step
	fill(t, reflect.ValueOf(&in).Elem())

	out := neighbourStep(in)

	iv, ov := reflect.ValueOf(in), reflect.ValueOf(out)
	for i := 0; i < iv.NumField(); i++ {
		name := iv.Type().Field(i).Name
		if name == "Channels" {
			// The one field neighbours are NOT handed verbatim: SMS and voice
			// would carry a human-readable location outside the crypto group.
			if got := out.Channels; len(got) != 2 || got[0] != ChannelWS || got[1] != ChannelFCM {
				t.Fatalf("neighbour channels = %v, want [ws fcm] (the push/socket intersection)", got)
			}
			continue
		}
		if !reflect.DeepEqual(iv.Field(i).Interface(), ov.Field(i).Interface()) {
			t.Fatalf("Step.%s = %v on the neighbour leg, want %v — the field was dropped for neighbours only",
				name, ov.Field(i).Interface(), iv.Field(i).Interface())
		}
	}
}

// ── the duress bit stays inside the crypto group ─────────────────────────────

func withNeighbour(t *testing.T, n *Notifier) {
	t.Helper()
	st := n.st.(*fakeStore)
	st.members = append(st.members, store.Member{
		ID: "mem-neighbour", FamilyID: famID, Role: "neighbour", ASCIIShortName: "Meena",
	})
	st.devices = append(st.devices, store.Device{
		ID: "dev-neighbour", FamilyID: famID, MemberID: "mem-neighbour",
		Platform: "node", AgentHealthy: true,
	})
}

func TestTheNeighbourFeedNeverSaysDuressInEitherSpelling(t *testing.T) {
	n, _, bus := harness(t, nil, "")
	withNeighbour(t, n)

	inc := incident()
	inc.State = sm.StateActiveL1Silent
	inc.Duress = true
	step := Step{Tier: 2, Label: "L2", Channels: []Channel{ChannelWS}}
	if _, err := n.Fanout(context.Background(), inc, step); err != nil {
		t.Fatalf("Fanout: %v", err)
	}
	n.Close()

	reduced := bus.frames(ReducedSubject(famID))
	if len(reduced) != 1 {
		t.Fatalf("reduced frames = %d, want 1", len(reduced))
	}
	if _, present := reduced[0].Data["duress"]; present {
		t.Fatal("the neighbour frame carries a `duress` key")
	}
	if got := reduced[0].Data["state"]; got != string(sm.StateActiveL1) {
		t.Fatalf("neighbour frame state = %v, want ACTIVE_L1 — ACTIVE_L1_SILENT IS the duress bit", got)
	}

	// The family stream is inside the crypto group and keeps both: a relative
	// who does not know it was duress may phone the subject and ask.
	family := bus.frames(StreamSubject(famID))
	if len(family) != 1 {
		t.Fatalf("family frames = %d, want 1", len(family))
	}
	if family[0].Data["duress"] != true || family[0].Data["state"] != string(sm.StateActiveL1Silent) {
		t.Fatalf("family frame = %v, want duress=true and the real state", family[0].Data)
	}
}

func TestReducedFrameRefusesADuressKeyFromAnyProducer(t *testing.T) {
	inc := incident()
	if _, err := ReducedFrame("incident.state_changed", PriorityCritical, inc, 1, map[string]any{"duress": true}); err == nil {
		t.Fatal("a reduced frame with a duress key was built instead of refused")
	}
	f, err := ReducedFrame("incident.state_changed", PriorityCritical, inc, 1, map[string]any{"state": "ACTIVE_L1_SILENT"})
	if err != nil {
		t.Fatal(err)
	}
	if f.Data["state"] != "ACTIVE_L1" || !f.Reduced {
		t.Fatalf("frame = %+v, want the caller's state overwritten by ReducedState and Reduced set", f)
	}
}

// ── FCM: transient answers are retried once, inside the same budget ──────────

func TestFCMClientRetriesATransientAnswerOnce(t *testing.T) {
	stub := newFCMStub(t)
	stub.onSend = func(call int) (int, string, http.Header) {
		if call == 1 {
			return http.StatusServiceUnavailable, `{"error":{"status":"UNAVAILABLE"}}`, nil
		}
		return http.StatusOK, `{"name":"projects/p/messages/1"}`, nil
	}
	c := stub.client(t)
	if err := c.Send(context.Background(), "tok-1", map[string]string{"incidentId": "inc-1"}); err != nil {
		t.Fatalf("Send after a single 503 = %v, want nil", err)
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.sendCalls != 2 {
		t.Fatalf("send calls = %d, want 2 (one attempt, one retry)", stub.sendCalls)
	}
}

func TestFCMClientGivesUpAfterOneRetryAndSaysTransient(t *testing.T) {
	stub := newFCMStub(t)
	stub.sendStatus = http.StatusTooManyRequests
	stub.sendBody = `{"error":{"status":"RESOURCE_EXHAUSTED"}}`
	c := stub.client(t)
	err := c.Send(context.Background(), "tok-1", map[string]string{"incidentId": "inc-1"})
	if !errors.Is(err, ErrPushTransient) {
		t.Fatalf("Send = %v, want ErrPushTransient", err)
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.sendCalls != 2 {
		t.Fatalf("send calls = %d, want exactly 2 — a third attempt would outlive the SMS leg", stub.sendCalls)
	}
}

func TestFCMClientDoesNotRetryARejection(t *testing.T) {
	stub := newFCMStub(t)
	stub.sendStatus = http.StatusBadRequest
	stub.sendBody = `{"error":{"status":"INVALID_ARGUMENT","details":[{"fieldViolations":[{"field":"message.android.ttl"}]}]}}`
	c := stub.client(t)
	err := c.Send(context.Background(), "tok-1", map[string]string{"incidentId": "inc-1"})
	if !errors.Is(err, ErrPushRejected) {
		t.Fatalf("Send = %v, want ErrPushRejected (our bug, not the handset's)", err)
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.sendCalls != 1 {
		t.Fatalf("send calls = %d, want 1", stub.sendCalls)
	}
}

func TestIsUnregisteredReadsInvalidArgumentOnTheTokenField(t *testing.T) {
	onToken := []byte(`{"error":{"status":"INVALID_ARGUMENT","details":[{"fieldViolations":[{"field":"message.token","description":"Invalid registration token"}]}]}}`)
	if !isUnregistered(onToken) {
		t.Fatal("INVALID_ARGUMENT on message.token was not read as a dead token (the comment on isUnregistered promised it)")
	}
	onTTL := []byte(`{"error":{"status":"INVALID_ARGUMENT","details":[{"fieldViolations":[{"field":"message.android.ttl"}]}]}}`)
	if isUnregistered(onTTL) {
		t.Fatal("INVALID_ARGUMENT on a non-token field was misread as a dead token — this would clear a live token")
	}
}

func TestRetryAfterParsesSecondsOnly(t *testing.T) {
	for in, want := range map[string]time.Duration{"": 0, "2": 2 * time.Second, " 1 ": time.Second, "-1": 0, "Wed, 21 Oct 2015 07:28:00 GMT": 0} {
		if got := retryAfter(in); got != want {
			t.Errorf("retryAfter(%q) = %v, want %v", in, got, want)
		}
	}
}
