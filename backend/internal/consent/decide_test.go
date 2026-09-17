// ═══════════════════════════════════════════════════════════════════════════════
// SPECIFICATION — the consent decision, the fail-closed log, and surfacing
// (ADR-010 · F-14 · O-21 · §10.6)
//
// consent.go's header says the product differs from spyware in three ways:
// every grant expires, every read is logged, and every logged read is shown to
// the person it was about. Until this file, none of the three had an executable
// specification — consent_test.go pinned Grant's argument validation and nothing
// else, and its fake store could not fail, so the fail-closed branch in Check
// was unreachable from any test. Each test below states one rule of §10.6 as
// the code now enforces it.
// ═══════════════════════════════════════════════════════════════════════════════
package consent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/kavach/backend/internal/notify"
	"github.com/kavach/backend/internal/store"
)

const (
	nowMs   = int64(1_700_000_000_000)
	subject = "member-a"
	viewer  = "member-b"
)

// capturingBus records every frame the service emits, by subject.
type capturingBus struct {
	mu     sync.Mutex
	frames map[string][]notify.Frame
	err    error
}

func (b *capturingBus) publish(subject string, data []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.err != nil {
		return b.err
	}
	if b.frames == nil {
		b.frames = map[string][]notify.Frame{}
	}
	var f notify.Frame
	_ = json.Unmarshal(data, &f)
	b.frames[subject] = append(b.frames[subject], f)
	return nil
}

func (b *capturingBus) typed(subject, kind string) []notify.Frame {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []notify.Frame
	for _, f := range b.frames[subject] {
		if f.Type == kind {
			out = append(out, f)
		}
	}
	return out
}

// rig is a service with a settable clock and a capturing bus.
func rig(t *testing.T) (*Service, *fakeStore, *capturingBus, *int64) {
	t.Helper()
	fs := newFakeStore()
	seedFamily(fs)
	bus := &capturingBus{}
	clock := nowMs
	seq := 0
	svc, err := New(Deps{
		Store:   fs,
		Publish: bus.publish,
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now:     func() time.Time { return time.UnixMilli(clock).UTC() },
		NewID: func() string {
			seq++
			return "g-" + string(rune('a'+seq-1))
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return svc, fs, bus, &clock
}

func grant(t *testing.T, svc *Service, grantor, grantee, scope, purpose string, hours int) store.Grant {
	t.Helper()
	g, err := svc.Grant(GrantRequest{
		FamilyID: "fam-1", GrantorMemberID: grantor, GranteeMemberID: grantee,
		Scope: scope, Purpose: purpose, Hours: hours,
	})
	if err != nil {
		t.Fatalf("Grant: %v", err)
	}
	return g
}

func ask(scope, purpose string, incidentActive bool) CheckRequest {
	return CheckRequest{
		FamilyID: "fam-1", AccessorMemberID: viewer, SubjectMemberID: subject,
		Scope: scope, Purpose: purpose, IncidentActive: incidentActive,
	}
}

// ── decide: who may see whom ─────────────────────────────────────────────────

func TestDecideRules(t *testing.T) {
	type tc struct {
		name    string
		setup   func(t *testing.T, svc *Service, fs *fakeStore, clock *int64)
		req     CheckRequest
		allowed bool
		reason  Reason
	}
	cases := []tc{
		{
			name:    "no grant, no visibility",
			req:     ask(ScopeLiveLocation, PurposeSafety, false),
			allowed: false, reason: ReasonNoGrant,
		},
		{
			name: "a live grant of the right scope and purpose allows",
			setup: func(t *testing.T, svc *Service, _ *fakeStore, _ *int64) {
				grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 2)
			},
			req:     ask(ScopeLiveLocation, PurposeSafety, false),
			allowed: true, reason: ReasonGrant,
		},
		{
			name: "purpose binding: a safety grant does not satisfy a routine read",
			setup: func(t *testing.T, svc *Service, _ *fakeStore, _ *int64) {
				grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 2)
			},
			req:     ask(ScopeLiveLocation, PurposeRoutine, false),
			allowed: false, reason: ReasonPurposeMismatch,
		},
		{
			name: "scope binding: a location grant does not open the camera",
			setup: func(t *testing.T, svc *Service, _ *fakeStore, _ *int64) {
				grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 2)
			},
			req:     ask(ScopeCamera, PurposeSafety, false),
			allowed: false, reason: ReasonNoGrant,
		},
		{
			name: "an expired grant denies and says so",
			setup: func(t *testing.T, svc *Service, _ *fakeStore, clock *int64) {
				grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 1)
				*clock += 2 * time.Hour.Milliseconds()
			},
			req:     ask(ScopeLiveLocation, PurposeSafety, false),
			allowed: false, reason: ReasonExpired,
		},
		{
			name: "a revoked grant denies on the very next check",
			setup: func(t *testing.T, svc *Service, _ *fakeStore, _ *int64) {
				g := grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 2)
				if err := svc.Revoke("fam-1", g.ID); err != nil {
					t.Fatalf("Revoke: %v", err)
				}
			},
			req:     ask(ScopeLiveLocation, PurposeSafety, false),
			allowed: false, reason: ReasonRevoked,
		},
		{
			name: "incident_only is inert outside an incident",
			setup: func(t *testing.T, svc *Service, _ *fakeStore, _ *int64) {
				grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeIncidentOnly, 2)
			},
			req:     ask(ScopeLiveLocation, PurposeIncidentOnly, false),
			allowed: false, reason: ReasonIncidentOnly,
		},
		{
			name: "incident_only opens during an incident",
			setup: func(t *testing.T, svc *Service, _ *fakeStore, _ *int64) {
				grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeIncidentOnly, 2)
			},
			req:     ask(ScopeLiveLocation, PurposeIncidentOnly, true),
			allowed: true, reason: ReasonGrant,
		},
		{
			name: "the direction matters: a grant from B to A does not let B see A",
			setup: func(t *testing.T, svc *Service, _ *fakeStore, _ *int64) {
				grant(t, svc, viewer, subject, ScopeLiveLocation, PurposeSafety, 2)
			},
			req:     ask(ScopeLiveLocation, PurposeSafety, false),
			allowed: false, reason: ReasonNoGrant,
		},
		{
			name: "your own data is always yours",
			req: CheckRequest{FamilyID: "fam-1", AccessorMemberID: subject, SubjectMemberID: subject,
				Scope: ScopeHistory, Purpose: PurposeRoutine},
			allowed: true, reason: ReasonSelf,
		},
		{
			name: "an unknown purpose is refused before any grant is consulted",
			setup: func(t *testing.T, svc *Service, _ *fakeStore, _ *int64) {
				grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 2)
			},
			req:     ask(ScopeLiveLocation, "curiosity", false),
			allowed: false, reason: ReasonPurposeMismatch,
		},
		{
			name: "a guardian may see a minor for safety without a grant",
			setup: func(t *testing.T, _ *Service, fs *fakeStore, _ *int64) {
				fs.members["fam-1"] = []store.Member{
					{ID: subject, FamilyID: "fam-1", Role: "minor"},
					{ID: viewer, FamilyID: "fam-1", Role: "guardian"},
				}
			},
			req:     ask(ScopeLiveLocation, PurposeSafety, false),
			allowed: true, reason: ReasonGuardianOfMinor,
		},
		{
			name: "…but not for routine curiosity",
			setup: func(t *testing.T, _ *Service, fs *fakeStore, _ *int64) {
				fs.members["fam-1"] = []store.Member{
					{ID: subject, FamilyID: "fam-1", Role: "minor"},
					{ID: viewer, FamilyID: "fam-1", Role: "guardian"},
				}
			},
			req:     ask(ScopeLiveLocation, PurposeRoutine, false),
			allowed: false, reason: ReasonNoGrant,
		},
		{
			name: "an adult is not a minor: guardianship of one does not cover the other",
			setup: func(t *testing.T, _ *Service, fs *fakeStore, _ *int64) {
				fs.members["fam-1"] = []store.Member{
					{ID: subject, FamilyID: "fam-1", Role: "adult"},
					{ID: viewer, FamilyID: "fam-1", Role: "guardian"},
				}
			},
			req:     ask(ScopeLiveLocation, PurposeSafety, false),
			allowed: false, reason: ReasonNoGrant,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			svc, fs, _, clock := rig(t)
			if c.setup != nil {
				c.setup(t, svc, fs, clock)
			}
			d := svc.decide(c.req)
			if d.Allowed != c.allowed || d.Reason != c.reason {
				t.Fatalf("decide = allowed:%v reason:%s, want allowed:%v reason:%s", d.Allowed, d.Reason, c.allowed, c.reason)
			}
		})
	}
}

func TestDecidePicksTheLongestLivedMatchingGrant(t *testing.T) {
	svc, _, _, _ := rig(t)
	short := grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 1)
	long := grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 5)
	d := svc.decide(ask(ScopeLiveLocation, PurposeSafety, false))
	if !d.Allowed || d.GrantID != long.ID || d.ExpiresAt != long.ExpiresAt {
		t.Fatalf("decide = %+v, want the grant %s that expires last (not %s)", d, long.ID, short.ID)
	}
}

// ── Check: every decision writes a row, and no row means no read ─────────────

func TestCheckLogsDenialsAsWellAsReads(t *testing.T) {
	svc, fs, _, _ := rig(t)
	if _, err := svc.Check(context.Background(), ask(ScopeLiveLocation, PurposeSafety, false)); err != nil {
		t.Fatalf("Check: %v", err)
	}
	grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 2)
	d, err := svc.Check(context.Background(), ask(ScopeLiveLocation, PurposeSafety, false))
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	rows := fs.AccessLog("fam-1")
	if len(rows) != 2 {
		t.Fatalf("access rows = %d, want 2 (one denial, one read)", len(rows))
	}
	if rows[0].What != "denied live_location (no_grant)" || rows[0].SurfacedToSubject {
		t.Fatalf("denial row = %+v, want 'denied live_location (no_grant)' and unsurfaced", rows[0])
	}
	if rows[1].What != "read live_location (grant)" || rows[1].GrantID != d.GrantID {
		t.Fatalf("read row = %+v, want it to name the grant it rode on", rows[1])
	}
	if d.AccessLogID != rows[1].ID {
		t.Fatalf("AccessLogID = %d, want the row this check wrote (%d)", d.AccessLogID, rows[1].ID)
	}
}

func TestCheckFailsClosedWhenTheAccessLogCannotBeWritten(t *testing.T) {
	svc, fs, _, _ := rig(t)
	grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 2)
	fs.appendErr = errors.New("disk full")

	d, err := svc.Check(context.Background(), ask(ScopeLiveLocation, PurposeSafety, false))
	if err == nil {
		t.Fatal("Check returned no error while the log could not be written")
	}
	if d.Allowed {
		t.Fatal("★ an UNLOGGED read was allowed — the one thing this module exists to prevent ★")
	}
}

func TestSelfAccessIsBornSurfaced(t *testing.T) {
	svc, fs, _, _ := rig(t)
	req := CheckRequest{FamilyID: "fam-1", AccessorMemberID: subject, SubjectMemberID: subject,
		Scope: ScopeHistory, Purpose: PurposeRoutine}
	if _, err := svc.Check(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	rows := fs.AccessLog("fam-1")
	if len(rows) != 1 || !rows[0].SurfacedToSubject {
		t.Fatalf("self-access row = %+v, want it surfaced at birth (you know you looked)", rows)
	}
}

// ── Grant: the membership boundary ───────────────────────────────────────────

func TestGrantRefusesPartiesOutsideTheFamily(t *testing.T) {
	svc, _, _, _ := rig(t)
	for name, req := range map[string]GrantRequest{
		"grantor from another family": {FamilyID: "fam-1", GrantorMemberID: "stranger", GranteeMemberID: viewer,
			Scope: ScopeLiveLocation, Purpose: PurposeSafety, Hours: 1},
		"grantee from another family": {FamilyID: "fam-1", GrantorMemberID: subject, GranteeMemberID: "stranger",
			Scope: ScopeLiveLocation, Purpose: PurposeSafety, Hours: 1},
		"two ids from another family": {FamilyID: "fam-1", GrantorMemberID: "x", GranteeMemberID: "y",
			Scope: ScopeCamera, Purpose: PurposeSafety, Hours: 1},
		"a family this store has never seen": {FamilyID: "fam-9", GrantorMemberID: subject, GranteeMemberID: viewer,
			Scope: ScopeLiveLocation, Purpose: PurposeSafety, Hours: 1},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := svc.Grant(req); !errors.Is(err, ErrNotMember) {
				t.Fatalf("err = %v, want ErrNotMember", err)
			}
		})
	}
}

// ── Revoke ───────────────────────────────────────────────────────────────────

func TestRevokeIsIdempotentAndEmitsOnce(t *testing.T) {
	svc, _, bus, _ := rig(t)
	g := grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 2)
	if err := svc.Revoke("fam-1", g.ID); err != nil {
		t.Fatalf("first Revoke: %v", err)
	}
	if err := svc.Revoke("fam-1", g.ID); err != nil {
		t.Fatalf("second Revoke: %v", err)
	}
	if got := len(bus.typed(notify.StreamSubject("fam-1"), "consent.revoked")); got != 1 {
		t.Fatalf("consent.revoked frames = %d, want 1 — the second revoke is a no-op", got)
	}
	if err := svc.Revoke("fam-1", "no-such-grant"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown grant: err = %v, want ErrNotFound", err)
	}
	if err := svc.Revoke("fam-2", g.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another family's id: err = %v, want ErrNotFound (revocation is tenant-scoped)", err)
	}
}

// ── SurfaceOnce: the third promise ───────────────────────────────────────────

func read(t *testing.T, svc *Service, at int64, clock *int64) {
	t.Helper()
	*clock = at
	if _, err := svc.Check(context.Background(), ask(ScopeLiveLocation, PurposeSafety, false)); err != nil {
		t.Fatal(err)
	}
}

func TestSurfaceOnceTellsTheSubjectAndFlipsTheRow(t *testing.T) {
	svc, fs, bus, clock := rig(t)
	grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 24)
	read(t, svc, nowMs+1000, clock)
	read(t, svc, nowMs+2000, clock)

	if n := svc.SurfaceOnce(); n != 2 {
		t.Fatalf("surfaced %d rows, want 2", n)
	}
	frames := bus.typed(notify.StreamSubject("fam-1"), "consent.access_surfaced")
	if len(frames) != 1 {
		t.Fatalf("access_surfaced frames = %d, want 1 (one frame per subject)", len(frames))
	}
	if frames[0].Data["subjectMemberId"] != subject || frames[0].Data["count"] != float64(2) {
		t.Fatalf("frame = %v, want subject %s with count 2", frames[0].Data, subject)
	}
	for _, row := range fs.AccessLog("fam-1") {
		if !row.SurfacedToSubject {
			t.Fatalf("row %d still reads unsurfaced after the frame went out", row.ID)
		}
	}
	// Idempotent: nothing left to say.
	if n := svc.SurfaceOnce(); n != 0 {
		t.Fatalf("second pass surfaced %d rows, want 0", n)
	}
	if got := len(bus.typed(notify.StreamSubject("fam-1"), "consent.access_surfaced")); got != 1 {
		t.Fatalf("frames after second pass = %d, want still 1", got)
	}
}

func TestSurfacingAnOldBacklogSuccessfullyIsNotAStall(t *testing.T) {
	svc, _, bus, clock := rig(t)
	grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 24)
	// Rows written while the server was down for twenty minutes…
	read(t, svc, nowMs, clock)
	// …and the first pass after boot delivers them all.
	*clock = nowMs + 20*time.Minute.Milliseconds()
	svc.SurfaceOnce()

	backlog, oldest, stalled, surfaced := svc.Health()
	if stalled || backlog != 0 || oldest != 0 {
		t.Fatalf("Health after a clean pass = backlog:%d oldest:%d stalled:%v — a restart must not page a false P1 (O-21)",
			backlog, oldest, stalled)
	}
	if surfaced != 1 {
		t.Fatalf("surfacedTotal = %d, want 1", surfaced)
	}
	if got := len(bus.typed(notify.OpsSubject, "ops.consent_surfacing_stalled")); got != 0 {
		t.Fatalf("%d stall alerts fired for a backlog that was just delivered", got)
	}
}

func TestAnUndeliverableBacklogStallsExactlyOnceAndRecovers(t *testing.T) {
	svc, _, bus, clock := rig(t)
	grant(t, svc, subject, viewer, ScopeLiveLocation, PurposeSafety, 24)
	read(t, svc, nowMs, clock)

	bus.err = errors.New("bus down")
	*clock = nowMs + 20*time.Minute.Milliseconds()
	svc.SurfaceOnce()
	backlog, oldest, stalled, _ := svc.Health()
	if !stalled || backlog != 1 || oldest != nowMs {
		t.Fatalf("Health = backlog:%d oldest:%d stalled:%v, want a stall on the row that could not go out", backlog, oldest, stalled)
	}
	svc.SurfaceOnce() // still down: no second alert
	bus.err = nil
	if n := svc.SurfaceOnce(); n != 1 {
		t.Fatalf("recovery pass surfaced %d, want the 1 held row", n)
	}
	if _, _, stalled, _ := svc.Health(); stalled {
		t.Fatal("Health still stalled on the pass that delivered the backlog — recovery is a tick late")
	}
	// The alert was raised once, when the bus came back nothing was left to
	// carry it, and that is fine: the alert is a log line and a frame, and the
	// frame could not be published while the bus was down.
	if got := len(bus.typed(notify.OpsSubject, "ops.consent_surfacing_stalled")); got != 0 {
		t.Fatalf("stall alert frames = %d on a bus that was refusing frames", got)
	}
}
