package consent

import (
	"errors"
	"log/slog"
	"sync"
	"testing"

	"github.com/kavach/backend/internal/store"
)

// fakeStore is the smallest thing satisfying the Store interface — no files,
// no real backing store, just enough to observe what the service writes. It is
// deliberately CONTROLLABLE: appendErr makes the access log unwritable so the
// fail-closed branch in Check is reachable, and members decides who is in the
// family so Grant's membership check has something to refuse.
type fakeStore struct {
	mu        sync.Mutex
	members   map[string][]store.Member // familyID → members
	grants    []store.Grant
	access    []store.Access
	nextID    int64
	appendErr error
	revoked   map[string]int64
}

func newFakeStore() *fakeStore {
	return &fakeStore{members: map[string][]store.Member{}, revoked: map[string]int64{}}
}

func (f *fakeStore) Members(familyID string) []store.Member { return f.members[familyID] }
func (f *fakeStore) Families() []store.Family {
	var out []store.Family
	for id := range f.members {
		out = append(out, store.Family{ID: id})
	}
	return out
}
func (f *fakeStore) Grants(familyID string) []store.Grant {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]store.Grant, 0, len(f.grants))
	for _, g := range f.grants {
		if g.FamilyID == familyID {
			if at, ok := f.revoked[g.ID]; ok {
				g.RevokedAt = at
			}
			out = append(out, g)
		}
	}
	return out
}
func (f *fakeStore) PutGrant(g store.Grant) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.grants = append(f.grants, g)
	return nil
}
func (f *fakeStore) RevokeGrant(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.revoked[id]; !ok {
		f.revoked[id] = 1
	}
	return nil
}
func (f *fakeStore) AccessLog(familyID string) []store.Access {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []store.Access
	for _, a := range f.access {
		if a.FamilyID == familyID {
			out = append(out, a)
		}
	}
	return out
}
func (f *fakeStore) AppendAccessID(a store.Access) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.appendErr != nil {
		return 0, f.appendErr
	}
	f.nextID++
	a.ID = f.nextID
	f.access = append(f.access, a)
	return a.ID, nil
}
func (f *fakeStore) MarkAccessSurfaced(familyID string, ids []int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	want := map[int64]bool{}
	for _, id := range ids {
		want[id] = true
	}
	for i := range f.access {
		if f.access[i].FamilyID == familyID && want[f.access[i].ID] {
			f.access[i].SurfacedToSubject = true
		}
	}
	return nil
}

// seedFamily puts the two members every Grant test needs into fam-1.
func seedFamily(fs *fakeStore) {
	fs.members["fam-1"] = []store.Member{
		{ID: "member-a", FamilyID: "fam-1", Role: "adult"},
		{ID: "member-b", FamilyID: "fam-1", Role: "adult"},
	}
}

func newTestService(t *testing.T) (*Service, *fakeStore) {
	t.Helper()
	fs := newFakeStore()
	seedFamily(fs)
	svc, err := New(Deps{
		Store:   fs,
		Publish: func(string, []byte) error { return nil },
		Log:     slog.Default(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return svc, fs
}

// ★ Spec F1 (phase6b-redesign-and-family-watch) — `camera` joins `audio` as a
// separately revocable scope for Family Watch. This is the server-side half:
// mobile's ConsentScope union (core/types.ts) already accepts it, and the
// wire contract for a manually-granted camera scope goes through this same
// Grant() path `postConsent` calls.
func TestGrantAcceptsCameraScope(t *testing.T) {
	svc, fs := newTestService(t)
	g, err := svc.Grant(GrantRequest{
		FamilyID:        "fam-1",
		GrantorMemberID: "member-a",
		GranteeMemberID: "member-b",
		Scope:           ScopeCamera,
		Purpose:         PurposeSafety,
		Hours:           1,
	})
	if err != nil {
		t.Fatalf("Grant with scope=camera: %v", err)
	}
	if g.Scope != "camera" {
		t.Fatalf("scope = %q, want camera", g.Scope)
	}
	if len(fs.grants) != 1 {
		t.Fatalf("PutGrant called %d times, want 1", len(fs.grants))
	}
}

// Characterization: an unrecognised scope is still rejected. Pinned so a
// future edit to validScopes cannot silently widen it past what F1 named.
func TestGrantRejectsUnknownScope(t *testing.T) {
	svc, _ := newTestService(t)
	_, err := svc.Grant(GrantRequest{
		FamilyID:        "fam-1",
		GrantorMemberID: "member-a",
		GranteeMemberID: "member-b",
		Scope:           "wiretap",
		Purpose:         PurposeSafety,
		Hours:           1,
	})
	if !errors.Is(err, ErrBadScope) {
		t.Fatalf("err = %v, want ErrBadScope", err)
	}
}

// ★ Spec F2 — the server does not validate GrantedVia against an enum (it
// defaults empty to "self" and otherwise passes whatever the caller sent
// straight through) — so `family_membership` needs no server-side change to
// be accepted. This pins that behaviour rather than assuming it.
func TestGrantPassesThroughFamilyMembershipVia(t *testing.T) {
	svc, _ := newTestService(t)
	g, err := svc.Grant(GrantRequest{
		FamilyID:        "fam-1",
		GrantorMemberID: "member-a",
		GranteeMemberID: "member-b",
		Scope:           ScopeAudio,
		Purpose:         PurposeSafety,
		Hours:           1,
		GrantedVia:      "family_membership",
	})
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if g.GrantedVia != "family_membership" {
		t.Fatalf("grantedVia = %q, want family_membership", g.GrantedVia)
	}
}
