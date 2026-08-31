// ═══════════════════════════════════════════════════════════════════════════════
// 6-D-6 · spec C1 — RequestLocationRefresh, the non-incident push leg.
//
// This bypasses Fanout entirely (no incident, no audience/drill/budget), so it
// gets its own harness rather than reusing fcm_test.go's incident-shaped one.
// Reuses fcm_test.go's fakeStore/fakeBus/recordingSender — same package, same
// fakes, one less thing to duplicate and drift.
// ═══════════════════════════════════════════════════════════════════════════════
package notify

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	"github.com/kavach/backend/internal/store"
)

const refreshFamID = "fam-refresh"

func newRefreshNotifier(t *testing.T, st *fakeStore, push PushSender) *Notifier {
	t.Helper()
	n, err := New(Deps{
		Store: st, Bus: &fakeBus{}, Log: slog.Default(), Push: push,
		NewID: func() string { return "req-fixed" },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return n
}

func TestRequestLocationRefresh_SendsToAndroidDeviceOnly(t *testing.T) {
	st := &fakeStore{
		devices: []store.Device{
			{ID: "dev-android", FamilyID: refreshFamID, MemberID: "mem-1", Platform: "android", PushTokenFCM: "tok-android"},
			{ID: "dev-ios", FamilyID: refreshFamID, MemberID: "mem-1", Platform: "ios", PushTokenFCM: "tok-ios"},
			{ID: "dev-other", FamilyID: refreshFamID, MemberID: "mem-2", Platform: "android", PushTokenFCM: "tok-other"},
		},
	}
	sender := &recordingSender{}
	n := newRefreshNotifier(t, st, sender)

	reqID, err := n.RequestLocationRefresh(context.Background(), refreshFamID, "mem-1")
	if err != nil {
		t.Fatalf("RequestLocationRefresh: %v", err)
	}
	if reqID != "req-fixed" {
		t.Fatalf("requestId = %q, want the injected NewID value", reqID)
	}
	if sender.calls() != 1 {
		t.Fatalf("calls = %d, want 1 (android only, other member excluded)", sender.calls())
	}
	if sender.toks[0] != "tok-android" {
		t.Fatalf("token = %q, want tok-android", sender.toks[0])
	}
	payload := sender.sent[0]
	want := map[string]string{"type": "location_refresh_request", "requestId": "req-fixed", "deviceId": "dev-android"}
	if len(payload) != len(want) {
		t.Fatalf("payload = %v, want exactly %v", payload, want)
	}
	for k, v := range want {
		if payload[k] != v {
			t.Errorf("payload[%q] = %q, want %q", k, payload[k], v)
		}
	}
	// F-21's allowlist is enforced twice (fcm.go's assertPushSafe is the other
	// leg) — assert the payload this function builds actually clears it, so a
	// future field added here without touching pushSafeKeys fails HERE, at the
	// point that invented the field, not at a live send.
	if err := assertPushSafe(payload); err != nil {
		t.Errorf("assertPushSafe rejected the payload this function builds: %v", err)
	}
}

func TestRequestLocationRefresh_MultipleAndroidDevicesEachGetSent(t *testing.T) {
	st := &fakeStore{
		devices: []store.Device{
			{ID: "dev-1", FamilyID: refreshFamID, MemberID: "mem-1", Platform: "android", PushTokenFCM: "tok-1"},
			{ID: "dev-2", FamilyID: refreshFamID, MemberID: "mem-1", Platform: "android", PushTokenFCM: "tok-2"},
		},
	}
	sender := &recordingSender{}
	n := newRefreshNotifier(t, st, sender)

	if _, err := n.RequestLocationRefresh(context.Background(), refreshFamID, "mem-1"); err != nil {
		t.Fatalf("RequestLocationRefresh: %v", err)
	}
	if sender.calls() != 2 {
		t.Fatalf("calls = %d, want 2", sender.calls())
	}
}

func TestRequestLocationRefresh_RevokedDeviceIsSkipped(t *testing.T) {
	st := &fakeStore{
		devices: []store.Device{
			{ID: "dev-1", FamilyID: refreshFamID, MemberID: "mem-1", Platform: "android", PushTokenFCM: "tok-1", RevokedAt: 1},
		},
	}
	sender := &recordingSender{}
	n := newRefreshNotifier(t, st, sender)

	_, err := n.RequestLocationRefresh(context.Background(), refreshFamID, "mem-1")
	if !errors.Is(err, ErrNoReachableDevice) {
		t.Fatalf("err = %v, want ErrNoReachableDevice", err)
	}
	if sender.calls() != 0 {
		t.Fatalf("calls = %d, want 0 — a revoked device must never be sent to", sender.calls())
	}
}

func TestRequestLocationRefresh_NoTokenIsHonestNotSilent(t *testing.T) {
	st := &fakeStore{
		devices: []store.Device{
			{ID: "dev-1", FamilyID: refreshFamID, MemberID: "mem-1", Platform: "android", PushTokenFCM: ""},
		},
	}
	n := newRefreshNotifier(t, st, &recordingSender{})

	_, err := n.RequestLocationRefresh(context.Background(), refreshFamID, "mem-1")
	if !errors.Is(err, ErrPushUnregistered) {
		t.Fatalf("err = %v, want ErrPushUnregistered (KV-NOTOKEN's cause, same as fan-out)", err)
	}
}

func TestRequestLocationRefresh_PushNotConfiguredIsHonestNotSilent(t *testing.T) {
	st := &fakeStore{
		devices: []store.Device{
			{ID: "dev-1", FamilyID: refreshFamID, MemberID: "mem-1", Platform: "android", PushTokenFCM: "tok-1"},
		},
	}
	// Deps.Push left nil: the normal state of this deployment (no FCM creds).
	n := newRefreshNotifier(t, st, nil)

	_, err := n.RequestLocationRefresh(context.Background(), refreshFamID, "mem-1")
	if !errors.Is(err, ErrPushNotConfigured) {
		t.Fatalf("err = %v, want ErrPushNotConfigured", err)
	}
}

func TestRequestLocationRefresh_NoDeviceAtAll(t *testing.T) {
	n := newRefreshNotifier(t, &fakeStore{}, &recordingSender{})

	_, err := n.RequestLocationRefresh(context.Background(), refreshFamID, "mem-ghost")
	if !errors.Is(err, ErrNoReachableDevice) {
		t.Fatalf("err = %v, want ErrNoReachableDevice", err)
	}
}

func TestRequestLocationRefresh_SendFailureFallsBackToOtherDevices(t *testing.T) {
	st := &fakeStore{
		devices: []store.Device{
			{ID: "dev-bad", FamilyID: refreshFamID, MemberID: "mem-1", Platform: "android", PushTokenFCM: "tok-bad"},
			{ID: "dev-good", FamilyID: refreshFamID, MemberID: "mem-1", Platform: "android", PushTokenFCM: "tok-good"},
		},
	}
	sender := &failFirstSender{failToken: "tok-bad"}
	n := newRefreshNotifier(t, st, sender)

	_, err := n.RequestLocationRefresh(context.Background(), refreshFamID, "mem-1")
	if err != nil {
		t.Fatalf("err = %v, want nil — one working device is enough to call this sent", err)
	}
	if len(sender.calls) != 2 {
		t.Fatalf("calls = %v, want both devices attempted", sender.calls)
	}
}

// failFirstSender fails one specific token and records every call, so a test
// can prove a bad device does not stop the loop from trying the rest.
type failFirstSender struct {
	failToken string
	calls     []string
}

func (f *failFirstSender) Send(_ context.Context, token string, _ map[string]string) error {
	f.calls = append(f.calls, token)
	if token == f.failToken {
		return errors.New("simulated send failure")
	}
	return nil
}
