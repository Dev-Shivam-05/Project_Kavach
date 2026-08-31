package consent

import (
	"errors"
	"log/slog"
	"testing"

	"github.com/kavach/backend/internal/store"
)

// fakeStore is the smallest thing satisfying the Store interface — no files,
// no real backing store, just enough to observe what Grant() writes.
type fakeStore struct {
	grants []store.Grant
}

func (f *fakeStore) Members(string) []store.Member { return nil }
func (f *fakeStore) Families() []store.Family      { return nil }
func (f *fakeStore) Grants(familyID string) []store.Grant {
	out := make([]store.Grant, 0, len(f.grants))
	for _, g := range f.grants {
		if g.FamilyID == familyID {
			out = append(out, g)
		}
	}
	return out
}
func (f *fakeStore) PutGrant(g store.Grant) error {
	f.grants = append(f.grants, g)
	return nil
}
func (f *fakeStore) RevokeGrant(string) error        { return nil }
func (f *fakeStore) AccessLog(string) []store.Access { return nil }
func (f *fakeStore) AppendAccess(store.Access) error { return nil }

func newTestService(t *testing.T) (*Service, *fakeStore) {
	t.Helper()
	fs := &fakeStore{}
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
