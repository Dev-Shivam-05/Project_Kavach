// Package consent is the anti-stalkerware machinery.
//
// The difference between a family safety platform and spyware is not the code
// that moves location data — it is identical. The difference is that here every
// grant expires, every read is logged, and every logged read is shown to the
// person it was about. Remove any one of those three and what remains is
// stalkerware with a nice icon.
//
// The third one is the one that rots silently: a grant ledger nobody sees is
// theatre. That is why the surfacing backlog is monitored as a first-class
// signal (optimisation O-21) rather than assumed to work.
package consent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kavach/backend/internal/notify"
	"github.com/kavach/backend/internal/store"
)

// ── Vocabulary ───────────────────────────────────────────────────────────────

// Scopes mirror ConsentScope in the shared type vocabulary.
const (
	ScopeLiveLocation = "live_location"
	ScopeHistory      = "history"
	ScopeVitals       = "vitals"
	ScopeAudio        = "audio"
	ScopeDocuments    = "documents"
	ScopeScreenTime   = "screen_time"
)

// Purposes. Purpose binding is the property RBAC cannot give you: a grant made
// "for safety" cannot satisfy a "routine curiosity" check, and the purpose is
// part of the authorization decision and of the log (§10.6).
const (
	PurposeSafety       = "safety"
	PurposeIncidentOnly = "incident_only"
	PurposeRoutine      = "routine"
	PurposeCare         = "care"
)

var validScopes = map[string]bool{
	ScopeLiveLocation: true, ScopeHistory: true, ScopeVitals: true,
	ScopeAudio: true, ScopeDocuments: true, ScopeScreenTime: true,
}

var validPurposes = map[string]bool{
	PurposeSafety: true, PurposeIncidentOnly: true,
	PurposeRoutine: true, PurposeCare: true,
}

// MaxGrantHours caps how long any grant can last. ★ There is no permanent
// grant. ★ (P-008) A grant that never expires is indistinguishable from
// surveillance, so the only lever the UI offers is "how long", never "forever".
const MaxGrantHours = 24 * 30

// SurfacingInterval is how often the backlog is drained.
const SurfacingInterval = 30 * time.Second

// BacklogAlertCount / BacklogAlertAge define "the surfacing job has stalled".
// O-21: if this job stops, nothing breaks, no request fails, no dashboard turns
// red — and the entire consent guarantee is silently void. It has to be watched
// explicitly because its failure mode is silence.
const (
	BacklogAlertCount = 50
	BacklogAlertAge   = 15 * time.Minute
)

var (
	ErrExpiryRequired = errors.New("consent: a grant must expire; there is no permanent grant")
	ErrExpiryTooLong  = fmt.Errorf("consent: expiry exceeds %d hours", MaxGrantHours)
	ErrBadScope       = errors.New("consent: unknown scope")
	ErrBadPurpose     = errors.New("consent: unknown purpose")
	ErrSelfGrant      = errors.New("consent: grantor and grantee are the same member")
	ErrNotFound       = errors.New("consent: grant not found")
)

// ── Decisions ────────────────────────────────────────────────────────────────

// Reason is the machine-readable "why" behind a decision. It is returned to the
// caller so the UI can say *which* purpose the grant covers rather than a bare
// 403 (error code KV-2002).
type Reason string

const (
	ReasonSelf            Reason = "self"
	ReasonGrant           Reason = "grant"
	ReasonGuardianOfMinor Reason = "guardian_of_minor"
	ReasonIncidentActive  Reason = "incident_active"
	ReasonNoGrant         Reason = "no_grant"
	ReasonExpired         Reason = "expired"
	ReasonRevoked         Reason = "revoked"
	ReasonPurposeMismatch Reason = "purpose_mismatch"
	ReasonIncidentOnly    Reason = "incident_only_but_no_incident"
	ReasonScopeMismatch   Reason = "scope_mismatch"
)

type Decision struct {
	Allowed bool   `json:"allowed"`
	Reason  Reason `json:"reason"`
	GrantID string `json:"grantId,omitempty"`
	// CoveredPurpose is set on a purpose mismatch so the client can tell the
	// human which purpose their grant actually covers.
	CoveredPurpose string `json:"coveredPurpose,omitempty"`
	ExpiresAt      int64  `json:"expiresAt,omitempty"`
	AccessLogID    int64  `json:"accessLogId,omitempty"`
}

// CheckRequest is one authorization question.
type CheckRequest struct {
	FamilyID         string
	AccessorMemberID string
	SubjectMemberID  string
	Scope            string
	// Purpose is the purpose the *access* is being made for. It must match the
	// grant's purpose exactly.
	Purpose string
	// What and Context are recorded verbatim in the access log — this is the
	// text the subject eventually reads.
	What    string
	Context string
	// IncidentActive gates incident_only grants.
	IncidentActive bool
	// DegradedPlaintext marks a Class A′ disclosure: precise coordinates that
	// left the system unencrypted over SMS (F-10, §2.4.6).
	DegradedPlaintext bool
}

// ── Dependencies ─────────────────────────────────────────────────────────────

// Store is the consumer-defined persistence slice (§2.5.3).
type Store interface {
	Members(familyID string) []store.Member
	Families() []store.Family
	Grants(familyID string) []store.Grant
	PutGrant(store.Grant) error
	RevokeGrant(id string) error
	AccessLog(familyID string) []store.Access
	AppendAccess(store.Access) error
}

type Deps struct {
	Store Store
	// Publish is the only bus capability this module needs on the write side.
	Publish func(subject string, data []byte) error
	// LoadCursors / SaveCursor persist the surfacing watermark. The access log
	// is append-only (it is the accountability record and must stay immutable),
	// so "already surfaced" is tracked as a watermark beside it rather than as
	// a mutation of the row.
	LoadCursors func() map[string]int64
	SaveCursor  func(familyID string, upTo int64)
	Log         *slog.Logger
	Now         func() time.Time
	NewID       func() string
}

type Service struct {
	st      Store
	publish func(string, []byte) error
	save    func(string, int64)
	log     *slog.Logger
	now     func() time.Time
	newID   func() string

	mu      sync.Mutex
	cursors map[string]int64 // familyID → highest surfaced access id

	backlogMu    sync.Mutex
	backlog      int
	oldestUnsurf int64
	stalled      bool
	surfaced     int64
}

func New(d Deps) (*Service, error) {
	if d.Store == nil || d.Publish == nil {
		return nil, errors.New("consent: store and publish are required")
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.NewID == nil {
		d.NewID = func() string { return fmt.Sprintf("g-%d", time.Now().UnixNano()) }
	}
	if d.SaveCursor == nil {
		d.SaveCursor = func(string, int64) {}
	}
	cursors := map[string]int64{}
	if d.LoadCursors != nil {
		for k, v := range d.LoadCursors() {
			cursors[k] = v
		}
	}
	return &Service{
		st: d.Store, publish: d.Publish, save: d.SaveCursor,
		log: d.Log, now: d.Now, newID: d.NewID, cursors: cursors,
	}, nil
}

// ── Grants ───────────────────────────────────────────────────────────────────

type GrantRequest struct {
	FamilyID        string `json:"familyId"`
	GrantorMemberID string `json:"grantorMemberId"`
	GranteeMemberID string `json:"granteeMemberId"`
	Scope           string `json:"scope"`
	Purpose         string `json:"purpose"`
	Hours           int    `json:"hours"`
	GrantedVia      string `json:"grantedVia"`
}

// Grant creates a time-boxed, purpose-bound grant. Every argument is validated
// because this is the one write in the system that widens who can see a human
// being.
func (s *Service) Grant(req GrantRequest) (store.Grant, error) {
	if !validScopes[req.Scope] {
		return store.Grant{}, fmt.Errorf("%w: %q", ErrBadScope, req.Scope)
	}
	if !validPurposes[req.Purpose] {
		return store.Grant{}, fmt.Errorf("%w: %q", ErrBadPurpose, req.Purpose)
	}
	if req.GrantorMemberID == req.GranteeMemberID {
		return store.Grant{}, ErrSelfGrant
	}
	if req.Hours <= 0 {
		return store.Grant{}, ErrExpiryRequired
	}
	if req.Hours > MaxGrantHours {
		return store.Grant{}, ErrExpiryTooLong
	}
	via := req.GrantedVia
	if via == "" {
		via = "self"
	}

	now := s.now()
	g := store.Grant{
		ID:              s.newID(),
		FamilyID:        req.FamilyID,
		GrantorMemberID: req.GrantorMemberID,
		GranteeMemberID: req.GranteeMemberID,
		Scope:           req.Scope,
		Purpose:         req.Purpose,
		GrantedAt:       now.UnixMilli(),
		ExpiresAt:       now.Add(time.Duration(req.Hours) * time.Hour).UnixMilli(),
		GrantedVia:      via,
	}
	if err := s.st.PutGrant(g); err != nil {
		return store.Grant{}, err
	}
	s.emit(req.FamilyID, "consent.granted", map[string]any{
		"grantId": g.ID, "scope": g.Scope, "purpose": g.Purpose,
		"granteeMemberId": g.GranteeMemberID, "expiresAt": g.ExpiresAt,
	})
	s.log.Info("consent_granted", "family", req.FamilyID, "grant", g.ID,
		"scope", g.Scope, "purpose", g.Purpose, "hours", req.Hours)
	return g, nil
}

// Revoke is Layer-1 revocation: instant, server-authoritative, and effective on
// the very next Check. The Layer-2 key ratchet may lag by design (F-14) — the
// grant row carries KeyRotationPending so the consent ledger UI can show that
// honestly instead of claiming a completeness it does not have yet.
func (s *Service) Revoke(familyID, grantID string) error {
	var found *store.Grant
	for _, g := range s.st.Grants(familyID) {
		if g.ID == grantID {
			gg := g
			found = &gg
			break
		}
	}
	if found == nil {
		return ErrNotFound
	}
	if err := s.st.RevokeGrant(grantID); err != nil {
		return err
	}
	s.emit(familyID, "consent.revoked", map[string]any{
		"grantId": grantID, "scope": found.Scope,
		"granteeMemberId":    found.GranteeMemberID,
		"keyRotationPending": true,
	})
	s.log.Info("consent_revoked", "family", familyID, "grant", grantID)
	return nil
}

// Grants lists the ledger, newest first, with expiry state resolved so the UI
// never has to recompute "is this still live".
func (s *Service) Grants(familyID string) []store.Grant {
	out := append([]store.Grant{}, s.st.Grants(familyID)...)
	sort.Slice(out, func(i, j int) bool { return out[i].GrantedAt > out[j].GrantedAt })
	return out
}

// ── The authorization decision ───────────────────────────────────────────────

// Check answers one access question and — win or lose — writes an access-log
// row. Logging denials matters as much as logging grants: "he tried to look and
// could not" is exactly the sentence a teenager needs to be able to read.
func (s *Service) Check(ctx context.Context, req CheckRequest) (Decision, error) {
	d := s.decide(req)

	id, err := s.recordAccess(req, d)
	if err != nil {
		// ★ Fail closed. ★ If we cannot write the access log we cannot honour
		// the promise the grant is built on, so the read does not happen. An
		// unlogged read is the thing this entire module exists to prevent.
		s.log.Error("access_log_write_failed_denying", "family", req.FamilyID, "err", err)
		return Decision{Allowed: false, Reason: ReasonNoGrant}, err
	}
	d.AccessLogID = id
	return d, nil
}

func (s *Service) decide(req CheckRequest) Decision {
	if !validPurposes[req.Purpose] {
		return Decision{Allowed: false, Reason: ReasonPurposeMismatch}
	}

	// Your own data is always yours.
	if req.AccessorMemberID == req.SubjectMemberID {
		return Decision{Allowed: true, Reason: ReasonSelf}
	}

	now := s.now().UnixMilli()
	roles := s.rolesByID(req.FamilyID)

	// Best matching grant. "Best" = correct scope, correct purpose, live.
	var best *store.Grant
	var nearMiss *store.Grant
	grants := s.st.Grants(req.FamilyID)
	for _, g := range grants {
		if g.GranteeMemberID != req.AccessorMemberID || g.GrantorMemberID != req.SubjectMemberID {
			continue
		}
		if g.Scope != req.Scope {
			continue
		}
		if g.Purpose != req.Purpose {
			// ★ Purpose binding. ★ A "safety" grant does not satisfy a
			// "routine" check even though the bytes it would return are
			// identical. Keep it aside so we can tell the human what their
			// grant actually covers.
			gg := g
			nearMiss = &gg
			continue
		}
		if g.RevokedAt > 0 {
			gg := g
			if nearMiss == nil {
				nearMiss = &gg
			}
			continue
		}
		if g.ExpiresAt <= now {
			gg := g
			if nearMiss == nil {
				nearMiss = &gg
			}
			continue
		}
		gg := g
		if best == nil || gg.ExpiresAt > best.ExpiresAt {
			best = &gg
		}
	}

	if best != nil {
		// incident_only grants are inert outside an incident. This is the lever
		// that lets someone say "you may see me only when something is wrong".
		if best.Purpose == PurposeIncidentOnly && !req.IncidentActive {
			return Decision{Allowed: false, Reason: ReasonIncidentOnly,
				GrantID: best.ID, CoveredPurpose: best.Purpose, ExpiresAt: best.ExpiresAt}
		}
		return Decision{Allowed: true, Reason: ReasonGrant,
			GrantID: best.ID, CoveredPurpose: best.Purpose, ExpiresAt: best.ExpiresAt}
	}

	// A guardian may see a minor without an explicit grant — that is what
	// guardianship is — but only for safety or care, and the read is logged and
	// surfaced exactly like any other. Visibility is the price of the exemption.
	if roles[req.AccessorMemberID] == "guardian" && roles[req.SubjectMemberID] == "minor" &&
		(req.Purpose == PurposeSafety || req.Purpose == PurposeCare) {
		return Decision{Allowed: true, Reason: ReasonGuardianOfMinor}
	}

	if nearMiss != nil {
		switch {
		case nearMiss.RevokedAt > 0:
			return Decision{Allowed: false, Reason: ReasonRevoked, GrantID: nearMiss.ID}
		case nearMiss.ExpiresAt <= now:
			return Decision{Allowed: false, Reason: ReasonExpired,
				GrantID: nearMiss.ID, ExpiresAt: nearMiss.ExpiresAt}
		default:
			return Decision{Allowed: false, Reason: ReasonPurposeMismatch,
				GrantID: nearMiss.ID, CoveredPurpose: nearMiss.Purpose}
		}
	}
	return Decision{Allowed: false, Reason: ReasonNoGrant}
}

func (s *Service) recordAccess(req CheckRequest, d Decision) (int64, error) {
	verb := "denied"
	if d.Allowed {
		verb = "read"
	}
	what := req.What
	if what == "" {
		what = req.Scope
	}
	contextStr := req.Context
	if contextStr == "" {
		contextStr = PurposeRoutine
	}
	a := store.Access{
		FamilyID:         req.FamilyID,
		GrantID:          d.GrantID,
		AccessorMemberID: req.AccessorMemberID,
		SubjectMemberID:  req.SubjectMemberID,
		What:             fmt.Sprintf("%s %s (%s)", verb, what, d.Reason),
		Context:          contextStr,
		At:               s.now().UnixMilli(),
		// Self-access needs no surfacing — you already know you looked at your
		// own data — so it is born surfaced and never enters the backlog.
		SurfacedToSubject: d.Reason == ReasonSelf,
		DegradedPlaintext: req.DegradedPlaintext,
	}
	if err := s.st.AppendAccess(a); err != nil {
		return 0, err
	}
	// The store assigns the row id on append, so read it back. The log is
	// append-only and monotonic, which makes the highest id in the family the
	// row we just wrote.
	var id int64
	for _, r := range s.st.AccessLog(req.FamilyID) {
		if r.ID > id {
			id = r.ID
		}
	}
	return id, nil
}

// AccessLog is the "who looked at my data, when" feed, newest first.
func (s *Service) AccessLog(familyID string) []store.Access {
	rows := append([]store.Access{}, s.st.AccessLog(familyID)...)
	sort.Slice(rows, func(i, j int) bool { return rows[i].At > rows[j].At })
	return rows
}

// ── The surfacing job ────────────────────────────────────────────────────────

// RunSurfacing drives surfaced_to_subject → true. It is a loop, not a
// request-path side effect, because surfacing must happen even for accesses
// made while the subject's phone was off.
func (s *Service) RunSurfacing(ctx context.Context) {
	t := time.NewTicker(SurfacingInterval)
	defer t.Stop()
	// Drain once immediately so a restart does not add a full interval of
	// latency to a backlog that may already be stale.
	s.SurfaceOnce()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.SurfaceOnce()
		}
	}
}

// SurfaceOnce publishes one round of unsurfaced access rows and advances the
// watermark. Returns how many rows it surfaced.
func (s *Service) SurfaceOnce() int {
	now := s.now()
	total := 0
	backlog := 0
	oldest := int64(0)

	for _, fam := range s.st.Families() {
		s.mu.Lock()
		cursor := s.cursors[fam.ID]
		s.mu.Unlock()

		rows := s.st.AccessLog(fam.ID)
		sort.Slice(rows, func(i, j int) bool { return rows[i].At < rows[j].At })

		highest := cursor
		var pending []store.Access
		for _, a := range rows {
			if a.SurfacedToSubject || a.ID <= cursor {
				continue
			}
			pending = append(pending, a)
			if a.ID > highest {
				highest = a.ID
			}
		}
		if len(pending) == 0 {
			continue
		}

		// One frame per subject: the consent ledger UI wants "3 people looked
		// at your location today", not three unrelated pings.
		bySubject := map[string][]store.Access{}
		for _, a := range pending {
			bySubject[a.SubjectMemberID] = append(bySubject[a.SubjectMemberID], a)
		}
		delivered := true
		for subject, rows := range bySubject {
			items := make([]map[string]any, 0, len(rows))
			for _, a := range rows {
				items = append(items, map[string]any{
					"id": a.ID, "accessorMemberId": a.AccessorMemberID,
					"what": a.What, "context": a.Context, "at": a.At,
					"grantId": a.GrantID, "degradedPlaintext": a.DegradedPlaintext,
				})
				if oldest == 0 || a.At < oldest {
					oldest = a.At
				}
			}
			if err := s.emit(fam.ID, "consent.access_surfaced", map[string]any{
				"subjectMemberId": subject,
				"count":           len(items),
				"items":           items,
			}); err != nil {
				// Leave the watermark where it is; these rows will be retried.
				s.log.Error("surfacing_publish_failed", "family", fam.ID, "err", err)
				delivered = false
				break
			}
			total += len(items)
		}
		if !delivered {
			backlog += len(pending)
			continue
		}
		s.mu.Lock()
		s.cursors[fam.ID] = highest
		s.mu.Unlock()
		s.save(fam.ID, highest)
	}

	s.backlogMu.Lock()
	s.backlog = backlog
	s.oldestUnsurf = oldest
	s.surfaced += int64(total)
	wasStalled := s.stalled
	stalled := backlog > BacklogAlertCount ||
		(oldest > 0 && now.UnixMilli()-oldest > BacklogAlertAge.Milliseconds())
	s.stalled = stalled
	s.backlogMu.Unlock()

	// ★ O-21 ★ If this alert never fires, nobody will ever notice the job died,
	// because a stalled surfacing job produces no errors and no failed
	// requests — it just quietly stops telling people they were watched.
	if stalled && !wasStalled {
		s.log.Error("consent_surfacing_backlog_stalled",
			"backlog", backlog, "oldestUnsurfacedAtMs", oldest, "optimisation", "O-21")
		_ = s.emit("", "ops.consent_surfacing_stalled", map[string]any{
			"severity": "P1", "backlog": backlog, "oldestUnsurfacedAt": oldest,
			"note": "consent guarantee is void while this is true",
		})
	}
	if !stalled && wasStalled {
		s.log.Info("consent_surfacing_recovered", "surfacedTotal", s.surfaced)
	}
	return total
}

// Health reports the surfacing job's state for /metrics and the daily
// safety-chain dashboard.
func (s *Service) Health() (backlog int, oldestUnsurfacedAt int64, stalled bool, surfacedTotal int64) {
	s.backlogMu.Lock()
	defer s.backlogMu.Unlock()
	return s.backlog, s.oldestUnsurf, s.stalled, s.surfaced
}

func (s *Service) rolesByID(familyID string) map[string]string {
	out := map[string]string{}
	for _, m := range s.st.Members(familyID) {
		out[m.ID] = strings.ToLower(m.Role)
	}
	return out
}

func (s *Service) emit(familyID, kind string, data map[string]any) error {
	subject := notify.StreamSubject(familyID)
	prio := notify.PriorityHigh
	if familyID == "" {
		subject = notify.OpsSubject
		prio = notify.PriorityCritical
	}
	f := notify.Frame{
		V: notify.FrameVersion, Type: kind, Priority: prio,
		FamilyID: familyID, At: s.now().UnixMilli(), Data: data,
	}
	return s.publish(subject, f.Encode())
}

// MarshalDecision is a small helper so handlers can return a decision as an
// RFC 7807 extension member without re-deriving the shape.
func MarshalDecision(d Decision) json.RawMessage {
	b, err := json.Marshal(d)
	if err != nil {
		return json.RawMessage(`{"allowed":false,"reason":"no_grant"}`)
	}
	return b
}
