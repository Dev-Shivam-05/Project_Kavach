// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION — the device table's durable shape (§2.8, RISK.md §4)
//
// internal/store is the durable record for everything and had zero direct tests
// (docs/RISK.md item 4). W10 adds a column to `device`, and the house rule for
// this package is: assert what it does today, THEN change it, and watch the
// assertion decide whether the change was compatible.
//
// The property that actually matters here is not "a setter sets" — it is that
// the JSON keys on disk are the SQL column names of §2.8. Those keys are the
// migration contract with backend/migrations/0001_init.sql (ADR-006), and drift
// between them is invisible until migration day. So this file pins the encoded
// key set of Device, not just its round-trip.
//
// It also pins the two semantics a caller relies on and no compiler enforces:
// tenancy validated on write (§2.8 family_id on EVERY record), and rows crossing
// the API boundary BY VALUE — a caller that could mutate a row behind the mutex
// would make the RWMutex decorative.
// ═══════════════════════════════════════════════════════════════════════════════
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// openWithFamily is the minimum viable tenant: PutDevice validates family_id on
// write, so every device test needs one to exist first.
func openWithFamily(t *testing.T) (*Store, string) {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	const famID = "fam-1"
	if err := s.PutFamily(Family{ID: famID, DisplayName: "Test"}); err != nil {
		t.Fatalf("PutFamily: %v", err)
	}
	return s, famID
}

func sampleDevice(famID string) Device {
	return Device{
		ID: "dev-1", FamilyID: famID, MemberID: "mem-1",
		Platform: "android", Model: "Pixel 6a", Manufacturer: "Google",
		OSVersion: "14", SigningPubkey: "c2lnbg==", IdentityPubkey: "aWRlbnQ=",
		IsDeviceOwner: true, LastHeartbeatAt: 1_700_000_000_000,
		BatteryPct: 82, AgentHealthy: true,
	}
}

// ── tenancy ──────────────────────────────────────────────────────────────────

func TestPutDeviceRequiresAKnownFamily(t *testing.T) {
	s, famID := openWithFamily(t)

	if err := s.PutDevice(Device{ID: "dev-x", MemberID: "mem-1"}); err != ErrNoFamilyID {
		t.Fatalf("no family_id: got %v, want ErrNoFamilyID", err)
	}
	if err := s.PutDevice(Device{ID: "dev-x", FamilyID: "fam-nope"}); err != ErrUnknownFamily {
		t.Fatalf("unknown family_id: got %v, want ErrUnknownFamily", err)
	}
	if err := s.PutDevice(Device{FamilyID: famID}); err != ErrNotFound {
		t.Fatalf("no id: got %v, want ErrNotFound", err)
	}
	if got := s.Devices(famID); len(got) != 0 {
		t.Fatalf("a rejected write left %d rows behind", len(got))
	}
}

// ── the disk contract ────────────────────────────────────────────────────────

// TestDeviceJSONKeysMatchTheMigration pins every persisted key of Device against
// the column names in migrations/0001_init.sql. Nothing else checks this pair
// (RISK.md §8), so a rename on either side is caught here or not at all.
//
// A NEW COLUMN IS EXPECTED TO FAIL THIS TEST. That is the point: adding it here
// is the reviewable act, and the entry must name a column that really exists in
// the migration.
func TestDeviceJSONKeysMatchTheMigration(t *testing.T) {
	want := []string{
		"agent_healthy",
		"battery_pct",
		"family_id",
		"id",
		"identity_pubkey",
		"is_device_owner",
		"last_heartbeat_at",
		"manufacturer",
		"member_id",
		"model",
		"os_version",
		"platform",
		// W10 · the FCM registration token, verbatim from device.push_token_fcm in
		// migrations/0001_init.sql. `push_token_apns` and `push_token_voip` are in
		// the migration too and deliberately absent here: iOS is out of scope by
		// ADR-015, and a column nothing writes is the "exists but is not wired up"
		// failure this repo has shipped before.
		"push_token_fcm",
		"revoked_at",
		"signing_pubkey",
	}

	raw, err := json.Marshal(sampleDevice("fam-1"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := make([]string, 0, len(decoded))
	for k := range decoded {
		got = append(got, k)
	}
	sort.Strings(got)

	if len(got) != len(want) {
		t.Fatalf("device has %d persisted keys, expected %d — every key here must be a\n"+
			"column in migrations/0001_init.sql (RISK.md §8)\n got: %v\nwant: %v",
			len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("persisted key %d is %q, expected %q\n got: %v\nwant: %v",
				i, got[i], want[i], got, want)
		}
	}
}

func TestPutDeviceSurvivesAReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	const famID = "fam-1"
	if err := s.PutFamily(Family{ID: famID, DisplayName: "Test"}); err != nil {
		t.Fatalf("PutFamily: %v", err)
	}
	want := sampleDevice(famID)
	if err := s.PutDevice(want); err != nil {
		t.Fatalf("PutDevice: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, "device.json")); err != nil {
		t.Fatalf("device.json was not written: %v", err)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got, ok := reopened.Device(want.ID)
	if !ok {
		t.Fatal("device did not survive the reopen")
	}
	if got != want {
		t.Fatalf("round-trip changed the row\n got: %+v\nwant: %+v", got, want)
	}
	if rows := reopened.Devices(famID); len(rows) != 1 || rows[0] != want {
		t.Fatalf("Devices(%q) = %+v", famID, rows)
	}
	if all := reopened.AllDevices(); len(all) != 1 || all[0] != want {
		t.Fatalf("AllDevices() = %+v", all)
	}
}

func TestPutDeviceUpdatesInPlace(t *testing.T) {
	s, famID := openWithFamily(t)
	d := sampleDevice(famID)
	if err := s.PutDevice(d); err != nil {
		t.Fatalf("PutDevice: %v", err)
	}

	d.BatteryPct = 11
	d.AgentHealthy = false
	if err := s.PutDevice(d); err != nil {
		t.Fatalf("PutDevice (update): %v", err)
	}

	rows := s.Devices(famID)
	if len(rows) != 1 {
		t.Fatalf("update appended a second row: %d rows", len(rows))
	}
	if rows[0].BatteryPct != 11 || rows[0].AgentHealthy {
		t.Fatalf("update did not land: %+v", rows[0])
	}
}

// ── the mutex is not decorative ──────────────────────────────────────────────

func TestDeviceRowsCrossTheBoundaryByValue(t *testing.T) {
	s, famID := openWithFamily(t)
	if err := s.PutDevice(sampleDevice(famID)); err != nil {
		t.Fatalf("PutDevice: %v", err)
	}

	got, _ := s.Device("dev-1")
	got.SigningPubkey = "TAMPERED"
	got.RevokedAt = 42

	fresh, _ := s.Device("dev-1")
	if fresh.SigningPubkey == "TAMPERED" || fresh.RevokedAt == 42 {
		t.Fatal("mutating a returned Device reached the stored row — the RWMutex is decorative")
	}

	rows := s.Devices(famID)
	rows[0].SigningPubkey = "TAMPERED"
	if again, _ := s.Device("dev-1"); again.SigningPubkey == "TAMPERED" {
		t.Fatal("mutating a row from Devices() reached the stored row")
	}
}

// ── the revoked device (relied on by notify's audience resolution) ───────────

func TestDevicesReturnsRevokedRowsAndLeavesTheFilteringToTheCaller(t *testing.T) {
	s, famID := openWithFamily(t)
	d := sampleDevice(famID)
	d.RevokedAt = 1_700_000_001_000
	if err := s.PutDevice(d); err != nil {
		t.Fatalf("PutDevice: %v", err)
	}
	// notify.tierDevices skips RevokedAt != 0 itself. If the store ever started
	// filtering here instead, the revocation check would be applied twice in one
	// place and nowhere in the other — so pin the division of labour.
	if rows := s.Devices(famID); len(rows) != 1 || rows[0].RevokedAt == 0 {
		t.Fatalf("Devices() dropped or unrevoked a revoked row: %+v", rows)
	}
}
