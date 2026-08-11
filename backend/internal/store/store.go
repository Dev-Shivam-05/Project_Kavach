// Package store is the durable record for the control plane.
//
// It stands in for PostgreSQL because the deliverable has no Docker, but it is
// deliberately NOT a toy: it keeps the table names, the column names and — the
// part that actually matters — the semantics from §2.8:
//
//   - family_id on EVERY record, validated on write. Tenancy that costs nothing
//     now and makes sharding a configuration change later rather than a
//     migration.
//   - incident_event is APPEND-ONLY. §2.8.4 enforces this with a Postgres
//     trigger that raises on UPDATE or DELETE; here the mutating methods exist
//     and return ErrAppendOnly, so the rule is discoverable and testable rather
//     than merely absent.
//   - ★ F-02: active_incident_v EXCLUDES is_drill and DORMANT. Get this wrong
//     and the canary — which opens a drill incident every 15 minutes — freezes
//     deploys forever, and a forgotten real incident freezes them permanently.
//
// Single writer, RWMutex, atomic temp-then-rename per table. Rows cross the API
// boundary BY VALUE: a caller that could mutate a row behind the mutex would
// make the lock decorative.
//
// sos-ingest never touches this on the request path (ADR-002). Only its
// projector does, off the hot path.
package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	sm "github.com/kavach/backend/internal/incident"
)

var (
	// ErrAppendOnly is the store-level equivalent of the incident_event_immutable
	// trigger. The incident log is the accountability record; if it can be edited
	// after the fact it is not a record.
	ErrAppendOnly = errors.New("store: incident_event is append-only")
	// ErrUnknownFamily rejects a record that no tenant owns.
	ErrUnknownFamily = errors.New("store: unknown family_id")
	// ErrNoFamilyID rejects a record with no tenant at all.
	ErrNoFamilyID = errors.New("store: family_id is required on every record")
	ErrNotFound   = errors.New("store: not found")
)

// ── row types (JSON keys mirror the SQL column names of §2.8) ────────────────

type Family struct {
	ID            string `json:"id"`
	DisplayName   string `json:"display_name"`
	CreatedAt     int64  `json:"created_at"`
	PolicyVersion int    `json:"policy_version"`
	CurrentEpoch  int    `json:"current_epoch"`
	// SMSHMACKeyB64 verifies the sig8 tag on an inbound SMS (§2.10.2). It is NOT
	// the E2EE family group secret — the server must never hold that — it is a
	// separate key whose only power is to say "this SMS really came from this
	// family's app".
	SMSHMACKeyB64 string `json:"sms_hmac_key"`
	SMSCeiling    int    `json:"sms_ceiling"`
}

type Member struct {
	ID       string `json:"id"`
	FamilyID string `json:"family_id"`
	// DisplayName is Class B. ASCIIShortName is what an SMS read at 2 a.m.
	// actually shows, and it is UNIQUE per family (F-18).
	DisplayName         string `json:"display_name"`
	ASCIIShortName      string `json:"ascii_short_name"`
	Role                string `json:"role"`
	Locale              string `json:"locale"`
	DOB                 string `json:"dob"`
	PhoneE164           string `json:"phone_e164"`
	IdentityPubkey      string `json:"identity_pubkey"`
	MembershipExpiresAt int64  `json:"membership_expires_at"`
	CreatedAt           int64  `json:"created_at"`
	AvatarColor         string `json:"avatar_color"`
}

type Device struct {
	ID           string `json:"id"`
	FamilyID     string `json:"family_id"`
	MemberID     string `json:"member_id"`
	Platform     string `json:"platform"`
	Model        string `json:"model"`
	Manufacturer string `json:"manufacturer"`
	OSVersion    string `json:"os_version"`
	// SigningPubkey is the base64 Ed25519 EMERGENCY key: deliberately not
	// biometric-gated, because an unconscious person cannot present a
	// fingerprint. This is the key sos-ingest verifies T0 envelopes against.
	SigningPubkey  string `json:"signing_pubkey"`
	IdentityPubkey string `json:"identity_pubkey"`
	IsDeviceOwner  bool   `json:"is_device_owner"`
	// PushTokenFCM is the device's FCM registration token — an opaque routing
	// address issued by Google, not a secret and not a capability: possessing it
	// lets you address this handset only if you also hold the family's FCM
	// service-account key. It is the ONLY thing that lets a phone learn about an
	// incident while the app is closed and the WebSocket is gone; without it the
	// last working leg to another human is SMS (W10).
	//
	// Class B. What travels on this channel is constrained by F-21 to the
	// lock-screen-safe five (incidentId, familyId, trigger, tier,
	// subjectShortName) — the token decides WHERE the alert goes, never WHAT it
	// says. Empty is the honest normal state: an iOS device, a node phone, or an
	// Android that has not yet been granted POST_NOTIFICATIONS.
	PushTokenFCM    string `json:"push_token_fcm"`
	LastHeartbeatAt int64  `json:"last_heartbeat_at"`
	BatteryPct      int    `json:"battery_pct"`
	AgentHealthy    bool   `json:"agent_healthy"`
	RevokedAt       int64  `json:"revoked_at"`
}

type Incident struct {
	ID               string   `json:"id"`
	FamilyID         string   `json:"family_id"`
	SubjectMemberID  string   `json:"subject_member_id"`
	State            sm.State `json:"state"`
	Trigger          string   `json:"trigger"`
	PolicyVersion    int      `json:"policy_version"`
	Duress           bool     `json:"duress"`
	IsDrill          bool     `json:"is_drill"`
	CoarseH3R7       string   `json:"coarse_h3_r7"`
	OwnerMemberID    string   `json:"owner_member_id"`
	OpenedAt         int64    `json:"opened_at"`
	FirstNotifiedAt  int64    `json:"first_notified_at"`
	FirstAckAt       int64    `json:"first_ack_at"`
	ResolvedAt       int64    `json:"resolved_at"`
	Outcome          string   `json:"outcome"`
	OutcomeNote      string   `json:"outcome_note"`
	Inc8             string   `json:"inc8"`
	SyntheticFromSms bool     `json:"synthetic_from_sms"`
	MergedIntoID     string   `json:"merged_into_id"`
	AutoQuiesceAt    int64    `json:"auto_quiesce_at"`
	ConfidencePct    int      `json:"confidence_pct"`
	RiskContext      int      `json:"risk_context"`
	Flags            int      `json:"flags"`
	ServerReceivedAt int64    `json:"server_received_at"`
	// SealedPayload is Class A ciphertext (MLS/GroupBox). The server stores and
	// routes it and can never read it — that is the entire point of §2.4.
	SealedPayload string `json:"sealed_payload"`
}

type IncidentEvent struct {
	ID               int64  `json:"id"`
	IncidentID       string `json:"incident_id"`
	FamilyID         string `json:"family_id"`
	HLC              string `json:"hlc"`
	EventType        string `json:"event_type"`
	SealedPayload    string `json:"sealed_payload"`
	SourceDeviceID   string `json:"source_device_id"`
	SourceTransport  string `json:"source_transport"`
	PolicyVersion    int    `json:"policy_version"`
	ServerReceivedAt int64  `json:"server_received_at"`
	LocalCreatedAt   int64  `json:"local_created_at"`
	Flags            int    `json:"flags"`
	// Detail is server-visible metadata only (state transitions, tier labels).
	// Anything about the SUBJECT belongs in SealedPayload.
	Detail map[string]any `json:"detail,omitempty"`
}

// Event is the name the escalation engine uses for a row of the incident log.
type Event = IncidentEvent

// Timer state values. The escalation engine keeps its own copies of these
// literals; they are the stored column values and must not diverge.
const (
	TimerPending   = "pending"
	TimerFired     = "fired"
	TimerCancelled = "cancelled"
)

type EscalationTimer struct {
	ID            string `json:"id"`
	FamilyID      string `json:"family_id"`
	IncidentID    string `json:"incident_id"`
	Action        string `json:"action"`
	TargetTier    int    `json:"target_tier"`
	PolicyVersion int    `json:"policy_version"`
	FireAt        int64  `json:"fire_at"`
	FiredAt       int64  `json:"fired_at"`
	State         string `json:"state"`
	// Attempts counts firing attempts. A timer that fails to fire is re-armed,
	// not forgotten: an overdue escalation timer is a P0 page (§2.11.5).
	Attempts  int   `json:"attempts"`
	CreatedAt int64 `json:"created_at"`
}

// Timer is the name the escalation engine uses for an escalation_timer row.
type Timer = EscalationTimer

type ConsentGrant struct {
	ID              string `json:"id"`
	FamilyID        string `json:"family_id"`
	GrantorMemberID string `json:"grantor_member_id"`
	GranteeMemberID string `json:"grantee_member_id"`
	Scope           string `json:"scope"`
	Purpose         string `json:"purpose"`
	GrantedAt       int64  `json:"granted_at"`
	// ExpiresAt is NEVER zero. There is no permanent grant (P-008).
	ExpiresAt  int64  `json:"expires_at"`
	RevokedAt  int64  `json:"revoked_at"`
	GrantedVia string `json:"granted_via"`
	// KeyRotationPending: Layer-1 revocation is instant, the Layer-2 ratchet may
	// lag (F-14). The UI must never claim a completeness it does not have.
	KeyRotationPending bool `json:"key_rotation_pending"`
}

// Grant is the name the consent module uses for a consent_grant row.
type Grant = ConsentGrant

type AccessLog struct {
	ID                int64  `json:"id"`
	FamilyID          string `json:"family_id"`
	GrantID           string `json:"grant_id"`
	AccessorMemberID  string `json:"accessor_member_id"`
	SubjectMemberID   string `json:"subject_member_id"`
	What              string `json:"what"`
	Context           string `json:"context"`
	At                int64  `json:"at"`
	SurfacedToSubject bool   `json:"surfaced_to_subject"`
	// DegradedPlaintext marks a Class A′ disclosure: precise coordinates left the
	// system unencrypted during an emergency (F-10). The subject is told.
	DegradedPlaintext bool `json:"degraded_plaintext"`
}

// Access is the name the consent module uses for an access_log row.
type Access = AccessLog

type Notification struct {
	ID         string `json:"id"`
	FamilyID   string `json:"family_id"`
	IncidentID string `json:"incident_id"`
	MemberID   string `json:"member_id"`
	Tier       int    `json:"tier"`
	Label      string `json:"label"`
	Channel    string `json:"channel"`
	// IsDrill keeps drill fan-out out of the False Positive Ledger and out of
	// NFR-008 accounting (F-03).
	IsDrill   bool     `json:"is_drill"`
	Audience  []string `json:"audience"`
	CreatedAt int64    `json:"created_at"`
	SentAt    int64    `json:"sent_at"`
	AckedAt   int64    `json:"acked_at"`
}

// DeliveryAttempt is one leg of one notification. Retained 400 days: this table
// is how "the alert was sent" is distinguished from "the alert arrived".
type DeliveryAttempt struct {
	ID             string `json:"id"`
	FamilyID       string `json:"family_id"`
	IncidentID     string `json:"incident_id"`
	NotificationID string `json:"notification_id"`
	MemberID       string `json:"member_id"`
	DeviceID       string `json:"device_id"`
	Channel        string `json:"channel"`
	State          string `json:"state"`
	AttemptedAt    int64  `json:"attempted_at"`
	DeliveredAt    int64  `json:"delivered_at"`
	LatencyMs      int64  `json:"latency_ms"`
	ErrorCode      string `json:"error_code"`
	// Reduced marks a neighbour-tier delivery: structurally less data, enforced
	// by the authz layer rather than by an application if-statement (§2.4.5).
	Reduced bool `json:"reduced"`
}

// Delivery is the name the notify module uses for a delivery_attempt row.
type Delivery = DeliveryAttempt

type DrillRun struct {
	ID                string          `json:"id"`
	FamilyID          string          `json:"family_id"`
	Kind              string          `json:"kind"`
	NotifiesFamily    bool            `json:"notifies_family"`
	AudienceDeviceIDs []string        `json:"audience_device_ids"`
	StartedAt         int64           `json:"started_at"`
	Scorecard         json.RawMessage `json:"scorecard"`
}

// ── store ────────────────────────────────────────────────────────────────────

type tables struct {
	Families         []*Family          `json:"family"`
	Members          []*Member          `json:"member"`
	Devices          []*Device          `json:"device"`
	Incidents        []*Incident        `json:"incident"`
	IncidentEvents   []*IncidentEvent   `json:"incident_event"`
	EscalationTimers []*EscalationTimer `json:"escalation_timer"`
	ConsentGrants    []*ConsentGrant    `json:"consent_grant"`
	AccessLogRows    []*AccessLog       `json:"access_log"`
	Notifications    []*Notification    `json:"notification"`
	DeliveryAttempts []*DeliveryAttempt `json:"delivery_attempt"`
	DrillRuns        []*DrillRun        `json:"drill_run"`
}

type Store struct {
	mu  sync.RWMutex
	dir string
	t   tables

	familyByID   map[string]*Family
	memberByID   map[string]*Member
	memberByPhne map[string]*Member
	deviceByID   map[string]*Device
	incidentByID map[string]*Incident
	incidentInc8 map[string]*Incident // family_id|inc8  (§2.8.2 index)
	eventsByInc  map[string][]*IncidentEvent
	eventDedupe  map[string]struct{} // incident_id|hlc
	timerByID    map[string]*EscalationTimer
	grantByID    map[string]*ConsentGrant
	notifByID    map[string]*Notification
	deliveryByID map[string]*DeliveryAttempt
	drillByID    map[string]*DrillRun

	nextEventID  int64
	nextAccessID int64
	now          func() int64
}

const (
	tFamily          = "family"
	tMember          = "member"
	tDevice          = "device"
	tIncident        = "incident"
	tIncidentEvent   = "incident_event"
	tEscalationTimer = "escalation_timer"
	tConsentGrant    = "consent_grant"
	tAccessLog       = "access_log"
	tNotification    = "notification"
	tDelivery        = "delivery_attempt"
	tDrillRun        = "drill_run"
)

var allTables = []string{
	tFamily, tMember, tDevice, tIncident, tIncidentEvent, tEscalationTimer,
	tConsentGrant, tAccessLog, tNotification, tDelivery, tDrillRun,
}

// Open loads every table from dir, creating it if needed.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, now: func() int64 { return time.Now().UnixMilli() }}
	s.reindex()

	load := func(name string, into any) error {
		raw, err := os.ReadFile(filepath.Join(dir, name+".json"))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if len(raw) == 0 {
			return nil
		}
		return json.Unmarshal(raw, into)
	}
	for _, l := range []struct {
		name string
		into any
	}{
		{tFamily, &s.t.Families}, {tMember, &s.t.Members}, {tDevice, &s.t.Devices},
		{tIncident, &s.t.Incidents}, {tIncidentEvent, &s.t.IncidentEvents},
		{tEscalationTimer, &s.t.EscalationTimers}, {tConsentGrant, &s.t.ConsentGrants},
		{tAccessLog, &s.t.AccessLogRows}, {tNotification, &s.t.Notifications},
		{tDelivery, &s.t.DeliveryAttempts}, {tDrillRun, &s.t.DrillRuns},
	} {
		if err := load(l.name, l.into); err != nil {
			return nil, err
		}
	}
	s.reindex()
	return s, nil
}

func (s *Store) reindex() {
	s.familyByID = map[string]*Family{}
	s.memberByID = map[string]*Member{}
	s.memberByPhne = map[string]*Member{}
	s.deviceByID = map[string]*Device{}
	s.incidentByID = map[string]*Incident{}
	s.incidentInc8 = map[string]*Incident{}
	s.eventsByInc = map[string][]*IncidentEvent{}
	s.eventDedupe = map[string]struct{}{}
	s.timerByID = map[string]*EscalationTimer{}
	s.grantByID = map[string]*ConsentGrant{}
	s.notifByID = map[string]*Notification{}
	s.deliveryByID = map[string]*DeliveryAttempt{}
	s.drillByID = map[string]*DrillRun{}
	s.nextEventID, s.nextAccessID = 0, 0

	for _, f := range s.t.Families {
		s.familyByID[f.ID] = f
	}
	for _, m := range s.t.Members {
		s.memberByID[m.ID] = m
		if m.PhoneE164 != "" {
			s.memberByPhne[m.PhoneE164] = m
		}
	}
	for _, d := range s.t.Devices {
		s.deviceByID[d.ID] = d
	}
	for _, i := range s.t.Incidents {
		s.incidentByID[i.ID] = i
		if i.Inc8 != "" {
			s.incidentInc8[i.FamilyID+"|"+i.Inc8] = i
		}
	}
	for _, e := range s.t.IncidentEvents {
		s.eventsByInc[e.IncidentID] = append(s.eventsByInc[e.IncidentID], e)
		s.eventDedupe[e.IncidentID+"|"+e.HLC] = struct{}{}
		if e.ID > s.nextEventID {
			s.nextEventID = e.ID
		}
	}
	for _, t := range s.t.EscalationTimers {
		s.timerByID[t.ID] = t
	}
	for _, g := range s.t.ConsentGrants {
		s.grantByID[g.ID] = g
	}
	for _, a := range s.t.AccessLogRows {
		if a.ID > s.nextAccessID {
			s.nextAccessID = a.ID
		}
	}
	for _, n := range s.t.Notifications {
		s.notifByID[n.ID] = n
	}
	for _, d := range s.t.DeliveryAttempts {
		s.deliveryByID[d.ID] = d
	}
	for _, d := range s.t.DrillRuns {
		s.drillByID[d.ID] = d
	}
}

// persist writes one table atomically: temp file, fsync, rename. A crash leaves
// either the old table or the new one, never a truncated one.
func (s *Store) persist(name string) error {
	var payload any
	switch name {
	case tFamily:
		payload = s.t.Families
	case tMember:
		payload = s.t.Members
	case tDevice:
		payload = s.t.Devices
	case tIncident:
		payload = s.t.Incidents
	case tIncidentEvent:
		payload = s.t.IncidentEvents
	case tEscalationTimer:
		payload = s.t.EscalationTimers
	case tConsentGrant:
		payload = s.t.ConsentGrants
	case tAccessLog:
		payload = s.t.AccessLogRows
	case tNotification:
		payload = s.t.Notifications
	case tDelivery:
		payload = s.t.DeliveryAttempts
	case tDrillRun:
		payload = s.t.DrillRuns
	default:
		return errors.New("store: unknown table " + name)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, name+".json")
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(raw); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// requireFamily is the tenancy check every write goes through.
func (s *Store) requireFamily(familyID string) error {
	if familyID == "" {
		return ErrNoFamilyID
	}
	if _, ok := s.familyByID[familyID]; !ok {
		return ErrUnknownFamily
	}
	return nil
}

// ── family / member / device ─────────────────────────────────────────────────

func (s *Store) PutFamily(f Family) error {
	if f.ID == "" {
		return ErrNoFamilyID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.familyByID[f.ID]; ok {
		*old = f
	} else {
		row := f
		s.t.Families = append(s.t.Families, &row)
		s.familyByID[row.ID] = &row
	}
	return s.persist(tFamily)
}

func (s *Store) Family(id string) (Family, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	f, ok := s.familyByID[id]
	if !ok {
		return Family{}, false
	}
	return *f, true
}

func (s *Store) Families() []Family {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Family, 0, len(s.t.Families))
	for _, f := range s.t.Families {
		out = append(out, *f)
	}
	return out
}

func (s *Store) PutMember(m Member) error {
	if m.ID == "" {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireFamily(m.FamilyID); err != nil {
		return err
	}
	row, ok := s.memberByID[m.ID]
	if ok {
		if row.PhoneE164 != "" {
			delete(s.memberByPhne, row.PhoneE164)
		}
		*row = m
	} else {
		cp := m
		row = &cp
		s.t.Members = append(s.t.Members, row)
		s.memberByID[row.ID] = row
	}
	if row.PhoneE164 != "" {
		s.memberByPhne[row.PhoneE164] = row
	}
	return s.persist(tMember)
}

func (s *Store) Member(id string) (Member, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.memberByID[id]
	if !ok {
		return Member{}, false
	}
	return *m, true
}

// Members returns one family's members. Every read is family-scoped for the
// same reason every table carries family_id: tenancy that is impossible to
// forget is tenancy that holds.
func (s *Store) Members(familyID string) []Member {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Member
	for _, m := range s.t.Members {
		if m.FamilyID == familyID {
			out = append(out, *m)
		}
	}
	return out
}

// AllMembers is for cache priming only (sos-ingest's MSISDN index).
func (s *Store) AllMembers() []Member {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Member, 0, len(s.t.Members))
	for _, m := range s.t.Members {
		out = append(out, *m)
	}
	return out
}

// MemberByPhone resolves the sender MSISDN of an inbound SMS (§2.10.2 step 1).
func (s *Store) MemberByPhone(e164 string) (Member, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.memberByPhne[e164]
	if !ok {
		return Member{}, false
	}
	return *m, true
}

func (s *Store) PutDevice(d Device) error {
	if d.ID == "" {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireFamily(d.FamilyID); err != nil {
		return err
	}
	if old, ok := s.deviceByID[d.ID]; ok {
		*old = d
	} else {
		row := d
		s.t.Devices = append(s.t.Devices, &row)
		s.deviceByID[row.ID] = &row
	}
	return s.persist(tDevice)
}

func (s *Store) Device(id string) (Device, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.deviceByID[id]
	if !ok {
		return Device{}, false
	}
	return *d, true
}

func (s *Store) Devices(familyID string) []Device {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Device
	for _, d := range s.t.Devices {
		if d.FamilyID == familyID {
			out = append(out, *d)
		}
	}
	return out
}

// AllDevices is for cache priming only (sos-ingest's key cache).
func (s *Store) AllDevices() []Device {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Device, 0, len(s.t.Devices))
	for _, d := range s.t.Devices {
		out = append(out, *d)
	}
	return out
}

// ── incidents ────────────────────────────────────────────────────────────────

func (s *Store) PutIncident(i Incident) error {
	if i.ID == "" {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireFamily(i.FamilyID); err != nil {
		return err
	}
	row, ok := s.incidentByID[i.ID]
	if ok {
		if row.Inc8 != "" {
			delete(s.incidentInc8, row.FamilyID+"|"+row.Inc8)
		}
		*row = i
	} else {
		cp := i
		row = &cp
		s.t.Incidents = append(s.t.Incidents, row)
		s.incidentByID[row.ID] = row
	}
	if row.Inc8 != "" {
		s.incidentInc8[row.FamilyID+"|"+row.Inc8] = row
	}
	return s.persist(tIncident)
}

func (s *Store) Incident(id string) (Incident, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	i, ok := s.incidentByID[id]
	if !ok {
		return Incident{}, false
	}
	return *i, true
}

// IncidentByInc8 is the F-09 reconciliation index: the same emergency arriving
// by SMS and by HTTP must land on one incident, not two.
func (s *Store) IncidentByInc8(familyID, inc8 string) (Incident, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	i, ok := s.incidentInc8[familyID+"|"+inc8]
	if !ok {
		return Incident{}, false
	}
	return *i, true
}

// Incidents returns one family's incidents, newest first.
func (s *Store) Incidents(familyID string) []Incident {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Incident
	for _, i := range s.t.Incidents {
		if i.FamilyID == familyID {
			out = append(out, *i)
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].OpenedAt > out[b].OpenedAt })
	return out
}

// ActiveIncidents is active_incident_v (§2.8.2) — the deploy-freeze query.
//
// ★ F-02. Three exclusions, each one a production outage if omitted:
//   - is_drill: the canary opens a drill every 15 minutes, so including drills
//     freezes deploys permanently.
//   - DORMANT: auto-quiesce exists precisely so a forgotten incident stops
//     freezing deploys; IsActive() already excludes it and we assert that here
//     rather than trusting it silently.
//   - merged_into_id: a synthetic SMS row reconciled into the real incident is
//     not a second live emergency.
//
// familyID scopes the view; "" is the global form the deploy-freeze check
// (GET /internal/active-incidents) uses.
func (s *Store) ActiveIncidents(familyID string) []Incident {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Incident
	for _, i := range s.t.Incidents {
		if familyID != "" && i.FamilyID != familyID {
			continue
		}
		if i.IsDrill || i.MergedIntoID != "" {
			continue
		}
		if i.State == sm.StateDormant || !sm.IsActive(i.State) {
			continue
		}
		out = append(out, *i)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].OpenedAt < out[b].OpenedAt })
	return out
}

// ── incident_event: APPEND ONLY ──────────────────────────────────────────────

// AppendEvent is the only way a row enters the incident log. It dedupes on
// (incident_id, hlc) — the same identity the bus consumers use — so an
// at-least-once redelivery cannot duplicate the timeline.
func (s *Store) AppendEvent(e Event) error {
	if e.IncidentID == "" {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireFamily(e.FamilyID); err != nil {
		return err
	}
	key := e.IncidentID + "|" + e.HLC
	if _, dup := s.eventDedupe[key]; dup {
		return nil
	}
	s.nextEventID++
	row := e
	row.ID = s.nextEventID
	s.t.IncidentEvents = append(s.t.IncidentEvents, &row)
	s.eventsByInc[row.IncidentID] = append(s.eventsByInc[row.IncidentID], &row)
	s.eventDedupe[key] = struct{}{}
	return s.persist(tIncidentEvent)
}

func (s *Store) HasEvent(incidentID, hlc string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.eventDedupe[incidentID+"|"+hlc]
	return ok
}

// Events returns one incident's log in HLC order — causal order across devices,
// never wall-clock order (P-052).
func (s *Store) Events(incidentID string) []Event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows := s.eventsByInc[incidentID]
	out := make([]Event, 0, len(rows))
	for _, e := range rows {
		out = append(out, *e)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].HLC < out[b].HLC })
	return out
}

// UpdateEvent always fails. It exists so that the rule is visible in the API
// surface rather than implied by an absence (§2.8.4).
func (s *Store) UpdateEvent(Event) error { return ErrAppendOnly }

// DeleteEvent always fails. Erasure of incident history is performed by
// crypto-shredding the content key (F-15), never by deleting log rows.
func (s *Store) DeleteEvent(int64) error { return ErrAppendOnly }

// Delete removes a row from a mutable table. It refuses incident_event and
// access_log — both are accountability records with a 400-day floor.
func (s *Store) Delete(table, id string) error {
	if table == tIncidentEvent || table == tAccessLog {
		return ErrAppendOnly
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch table {
	case tEscalationTimer:
		for idx, t := range s.t.EscalationTimers {
			if t.ID == id {
				s.t.EscalationTimers = append(s.t.EscalationTimers[:idx], s.t.EscalationTimers[idx+1:]...)
				delete(s.timerByID, id)
				return s.persist(tEscalationTimer)
			}
		}
	case tConsentGrant:
		for idx, g := range s.t.ConsentGrants {
			if g.ID == id {
				s.t.ConsentGrants = append(s.t.ConsentGrants[:idx], s.t.ConsentGrants[idx+1:]...)
				delete(s.grantByID, id)
				return s.persist(tConsentGrant)
			}
		}
	case tNotification:
		for idx, n := range s.t.Notifications {
			if n.ID == id {
				s.t.Notifications = append(s.t.Notifications[:idx], s.t.Notifications[idx+1:]...)
				delete(s.notifByID, id)
				return s.persist(tNotification)
			}
		}
	case tDrillRun:
		for idx, d := range s.t.DrillRuns {
			if d.ID == id {
				s.t.DrillRuns = append(s.t.DrillRuns[:idx], s.t.DrillRuns[idx+1:]...)
				delete(s.drillByID, id)
				return s.persist(tDrillRun)
			}
		}
	default:
		return errors.New("store: table is not deletable: " + table)
	}
	return ErrNotFound
}

// ── escalation timers ────────────────────────────────────────────────────────

func (s *Store) PutTimer(t Timer) error {
	if t.ID == "" {
		return ErrNotFound
	}
	if t.State == "" {
		t.State = TimerPending
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireFamily(t.FamilyID); err != nil {
		return err
	}
	if old, ok := s.timerByID[t.ID]; ok {
		*old = t
	} else {
		row := t
		s.t.EscalationTimers = append(s.t.EscalationTimers, &row)
		s.timerByID[row.ID] = &row
	}
	return s.persist(tEscalationTimer)
}

// Timers returns every timer. The escalation engine scans them on a tick; an
// overdue escalation timer is a P0 page (§2.11.5), so none may be hidden here.
func (s *Store) Timers() []Timer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Timer, 0, len(s.t.EscalationTimers))
	for _, t := range s.t.EscalationTimers {
		out = append(out, *t)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].FireAt < out[b].FireAt })
	return out
}

// FireTimer claims a timer: pending → fired, atomically, failing if somebody
// else already claimed it. This is SELECT … FOR UPDATE SKIP LOCKED expressed as
// one call, and it is what stops N escalation workers from fanning out the same
// tier N times.
func (s *Store) FireTimer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.timerByID[id]
	if !ok {
		return ErrNotFound
	}
	if t.State != TimerPending || t.FiredAt != 0 {
		return errors.New("store: timer already claimed: " + id)
	}
	t.State = TimerFired
	t.FiredAt = s.now()
	t.Attempts++
	return s.persist(tEscalationTimer)
}

func (s *Store) TimersDue(at int64) []Timer {
	var out []Timer
	for _, t := range s.Timers() {
		if t.State == TimerPending && t.FiredAt == 0 && t.FireAt <= at {
			out = append(out, t)
		}
	}
	return out
}

func (s *Store) TimersForIncident(incidentID string) []Timer {
	var out []Timer
	for _, t := range s.Timers() {
		if t.IncidentID == incidentID {
			out = append(out, t)
		}
	}
	return out
}

// ── consent, access log, notifications, deliveries, drills ───────────────────

func (s *Store) PutGrant(g Grant) error {
	if g.ID == "" {
		return ErrNotFound
	}
	if g.ExpiresAt == 0 {
		// P-008: there is no permanent grant. Accepting one here would quietly
		// build the surveillance product this architecture exists not to be.
		return errors.New("store: consent_grant.expires_at is mandatory (P-008)")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireFamily(g.FamilyID); err != nil {
		return err
	}
	if old, ok := s.grantByID[g.ID]; ok {
		*old = g
	} else {
		row := g
		s.t.ConsentGrants = append(s.t.ConsentGrants, &row)
		s.grantByID[row.ID] = &row
	}
	return s.persist(tConsentGrant)
}

func (s *Store) Grants(familyID string) []Grant {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Grant
	for _, g := range s.t.ConsentGrants {
		if g.FamilyID == familyID {
			out = append(out, *g)
		}
	}
	return out
}

// RevokeGrant is Layer-1 revocation: instant and server-authoritative. It also
// raises KeyRotationPending, because Layer 2 — the key ratchet — lands only when
// the subject's device next connects (F-14), and the UI must say so.
func (s *Store) RevokeGrant(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.grantByID[id]
	if !ok {
		return ErrNotFound
	}
	if g.RevokedAt == 0 {
		g.RevokedAt = s.now()
		g.KeyRotationPending = true
	}
	return s.persist(tConsentGrant)
}

func (s *Store) AppendAccess(a Access) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireFamily(a.FamilyID); err != nil {
		return err
	}
	s.nextAccessID++
	row := a
	row.ID = s.nextAccessID
	s.t.AccessLogRows = append(s.t.AccessLogRows, &row)
	return s.persist(tAccessLog)
}

func (s *Store) AccessLog(familyID string) []Access {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Access
	for _, a := range s.t.AccessLogRows {
		if a.FamilyID == familyID {
			out = append(out, *a)
		}
	}
	sort.Slice(out, func(x, y int) bool { return out[x].At > out[y].At })
	return out
}

// AccessLogForSubject is what the subject sees: every time someone — or some
// degraded transport — touched their data.
func (s *Store) AccessLogForSubject(memberID string) []Access {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Access
	for _, a := range s.t.AccessLogRows {
		if a.SubjectMemberID == memberID {
			out = append(out, *a)
		}
	}
	sort.Slice(out, func(x, y int) bool { return out[x].At > out[y].At })
	return out
}

func (s *Store) PutNotification(n Notification) error {
	if n.ID == "" {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireFamily(n.FamilyID); err != nil {
		return err
	}
	if old, ok := s.notifByID[n.ID]; ok {
		*old = n
	} else {
		row := n
		s.t.Notifications = append(s.t.Notifications, &row)
		s.notifByID[row.ID] = &row
	}
	return s.persist(tNotification)
}

func (s *Store) Notifications(incidentID string) []Notification {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Notification
	for _, n := range s.t.Notifications {
		if n.IncidentID == incidentID {
			out = append(out, *n)
		}
	}
	return out
}

// PutDelivery records one leg. The id is caller-supplied because notify
// allocates it before the leg starts — a leg that never returns still has to be
// attributable.
func (s *Store) PutDelivery(d Delivery) error {
	if d.ID == "" {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireFamily(d.FamilyID); err != nil {
		return err
	}
	if old, ok := s.deliveryByID[d.ID]; ok {
		*old = d
	} else {
		row := d
		s.t.DeliveryAttempts = append(s.t.DeliveryAttempts, &row)
		s.deliveryByID[row.ID] = &row
	}
	return s.persist(tDelivery)
}

func (s *Store) Deliveries(notificationID string) []Delivery {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Delivery
	for _, d := range s.t.DeliveryAttempts {
		if d.NotificationID == notificationID {
			out = append(out, *d)
		}
	}
	return out
}

func (s *Store) PutDrillRun(d DrillRun) error {
	if d.ID == "" {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireFamily(d.FamilyID); err != nil {
		return err
	}
	if old, ok := s.drillByID[d.ID]; ok {
		*old = d
	} else {
		row := d
		s.t.DrillRuns = append(s.t.DrillRuns, &row)
		s.drillByID[row.ID] = &row
	}
	return s.persist(tDrillRun)
}

func (s *Store) DrillRuns(familyID string) []DrillRun {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []DrillRun
	for _, d := range s.t.DrillRuns {
		if d.FamilyID == familyID {
			out = append(out, *d)
		}
	}
	return out
}

// Counts is the cheap health summary /healthz reports.
func (s *Store) Counts() map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return map[string]int{
		tFamily: len(s.t.Families), tMember: len(s.t.Members), tDevice: len(s.t.Devices),
		tIncident: len(s.t.Incidents), tIncidentEvent: len(s.t.IncidentEvents),
		tEscalationTimer: len(s.t.EscalationTimers), tConsentGrant: len(s.t.ConsentGrants),
		tAccessLog: len(s.t.AccessLogRows), tNotification: len(s.t.Notifications),
		tDelivery: len(s.t.DeliveryAttempts), tDrillRun: len(s.t.DrillRuns),
	}
}

// Flush rewrites every table. Called on shutdown; individual writes already
// persist, so this is belt-and-braces rather than the durability mechanism.
func (s *Store) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, n := range allTables {
		if err := s.persist(n); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Dir() string { return s.dir }
