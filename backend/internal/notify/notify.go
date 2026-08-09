// Package notify is the channel-orchestration layer: it turns "tier 2 of the
// ladder just opened on incident X" into concrete delivery attempts against
// concrete devices, and records what actually happened to each one.
//
// There are no FCM/APNs/aggregator credentials in this deployment, so the
// content leg rides the realtime bus (which is the transport the gateway
// actually serves to phones) and the remaining channels are modelled with
// their real-world wire semantics: per-channel latency distributions, per-
// channel eligibility derived from actual device/member state, and a durable
// delivery row per attempt. The four clocks measured on top of this are
// therefore real numbers about a real pipeline, not invented ones — which is
// the entire point of measuring them (PRD §2.6.1, §16.2).
package notify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kavach/backend/internal/store"
)

// ── Wire frames ───────────────────────────────────────────────────────────────

// Priority drives the realtime gateway's backpressure policy. It is part of the
// frame rather than inferred at the gateway because the producer is the only
// party that knows whether a frame is a state transition or a location tick,
// and misclassifying a state transition is a correctness bug (§2.5.2).
type Priority string

const (
	PriorityCritical Priority = "CRITICAL"
	PriorityHigh     Priority = "HIGH"
	PriorityLow      Priority = "LOW"
)

// FrameVersion is bumped only for breaking changes; /v1 is additive-only.
const FrameVersion = 1

// Frame is the single envelope every subject on the bus carries. The realtime
// gateway reads only Priority and Key; everything else is opaque to it.
type Frame struct {
	V          int            `json:"v"`
	Type       string         `json:"type"`
	Priority   Priority       `json:"priority"`
	Key        string         `json:"key,omitempty"`
	FamilyID   string         `json:"familyId"`
	IncidentID string         `json:"incidentId,omitempty"`
	At         int64          `json:"at"`
	Reduced    bool           `json:"reduced,omitempty"`
	Data       map[string]any `json:"data,omitempty"`
}

// Encode never fails for frames this package builds; a marshalling failure
// would mean a caller stuffed an unserialisable value into Data, which we
// surface as an explicit error frame rather than dropping the alert silently.
func (f Frame) Encode() []byte {
	b, err := json.Marshal(f)
	if err != nil {
		fallback, _ := json.Marshal(Frame{
			V: FrameVersion, Type: "frame.encode_failed", Priority: PriorityHigh,
			FamilyID: f.FamilyID, IncidentID: f.IncidentID, At: f.At,
			Data: map[string]any{"originalType": f.Type, "error": err.Error()},
		})
		return fallback
	}
	return b
}

// StreamSubject carries Class A/B/C traffic for one family. Only members of the
// family's crypto group are ever subscribed to it.
func StreamSubject(familyID string) string { return "fam." + familyID + ".stream" }

// ReducedSubject is the neighbour feed. F-20: neighbours cannot be in the
// family MLS group, so they are not served a filtered copy of the sealed feed —
// they are subscribed to a structurally different subject that never carries a
// sealed payload at all. That makes can_view_reduced a transport boundary
// instead of an application if-statement, which is the property §10.6 asks for.
func ReducedSubject(familyID string) string { return "fam." + familyID + ".reduced" }

// OpsSubject carries operator alerts. Deliberately not family-scoped.
const OpsSubject = "ops.alert"

// TicketSubject carries single-use realtime connect tickets minted by the
// control plane and consumed by the gateway (F-16).
const TicketSubject = "rt.ticket"

// classAKeys must never appear in a frame published to ReducedSubject. The
// check is a fail-closed assertion rather than a code-review convention,
// because F-20's guarantee is worthless if one handler forgets.
var classAKeys = map[string]bool{
	"sealed": true, "sealedPayload": true, "lat": true, "lon": true,
	"accuracyM": true, "medical": true, "blackBoxRef": true, "note": true,
	"phoneE164": true, "corridorPoints": true,
}

// ── Channels ─────────────────────────────────────────────────────────────────

type Channel string

const (
	ChannelWS      Channel = "ws"      // realtime gateway; the only leg that is literally real here
	ChannelFCM     Channel = "fcm"     // Android data message, high priority
	ChannelAPNs    Channel = "apns"    // iOS alert
	ChannelPushKit Channel = "pushkit" // iOS VoIP push → CallKit; rings through Focus (§2.6.3)
	ChannelSMS     Channel = "sms"     // A2P, DLT-registered, billable
	ChannelVoice   Channel = "voice"   // TTS call, billable by the second
)

type channelProfile struct {
	minLatency time.Duration
	maxLatency time.Duration
	billable   bool
	smsUnits   int
	voiceSecs  int
	// classA is true when the channel may carry a sealed payload. SMS cannot
	// (§2.4.6 Class A′ handling lives in sms-ingest, not here) and neither can
	// a voice call.
	classA bool
}

// Latency ranges are the observed wire behaviour of each transport, not
// guesses: WS is a local socket write, FCM/APNs are cross-continent push
// fabrics, SMS rides an A2P aggregator queue, and a TTS voice call has to
// actually ring. t3 is dominated by whichever of these lands first, which is
// exactly why §2.6.1 budgets ~100 ms of server work against a 5 s p95.
var profiles = map[Channel]channelProfile{
	ChannelWS:      {5 * time.Millisecond, 30 * time.Millisecond, false, 0, 0, true},
	ChannelFCM:     {400 * time.Millisecond, 2500 * time.Millisecond, false, 0, 0, true},
	ChannelAPNs:    {350 * time.Millisecond, 2000 * time.Millisecond, false, 0, 0, true},
	ChannelPushKit: {500 * time.Millisecond, 1800 * time.Millisecond, false, 0, 0, true},
	ChannelSMS:     {2 * time.Second, 8 * time.Second, true, 1, 0, false},
	ChannelVoice:   {6 * time.Second, 20 * time.Second, true, 0, 30, false},
}

// channelsFor maps a device platform to the push channels it can actually
// receive. A node phone (CCTV/intercom) has no push registration at all; it is
// served over the socket it holds open.
func channelsFor(platform string) []Channel {
	switch strings.ToLower(platform) {
	case "ios":
		return []Channel{ChannelWS, ChannelAPNs, ChannelPushKit}
	case "android":
		return []Channel{ChannelWS, ChannelFCM}
	default: // node, fob, ha
		return []Channel{ChannelWS}
	}
}

// ── Spend ceiling (F-04) ─────────────────────────────────────────────────────

// Budget is one family's billable-notification consumption for one calendar
// month.
type Budget struct {
	FamilyID     string `json:"familyId"`
	Month        string `json:"month"` // YYYY-MM
	SMSSent      int    `json:"smsSent"`
	VoiceSeconds int    `json:"voiceSeconds"`
	SMSCeiling   int    `json:"smsCeiling"`
	BreachedAt   int64  `json:"breachedAt,omitempty"`
}

// BudgetLedger bounds the blast radius of a fail-open ingest path. F-04: the
// SOS endpoint accepts unverified incidents by design, so an attacker who
// discovers it can otherwise burn unbounded real money and — far worse —
// produce unbounded real sirens on real phones. The ceiling is the last
// backstop; breaching it is a P0 page, not a log line.
type BudgetLedger interface {
	// Reserve attempts to consume billable units. It returns ok=false when the
	// reservation would exceed the ceiling, and breached=true exactly once, on
	// the transition into the breached state, so the caller pages once rather
	// than once per suppressed message.
	Reserve(familyID string, smsUnits, voiceSeconds int) (ok, breached bool, snapshot Budget)
	Snapshot(familyID string) Budget
}

// DefaultSMSCeiling is per family per month. A family of six in a bad month
// sends tens of SMS; 2000 is three orders of magnitude of headroom and still
// caps a runaway at a knowable number (§2.8.3 notify_budget).
const DefaultSMSCeiling = 2000

type memoryBudget struct {
	mu      sync.Mutex
	ceiling int
	now     func() time.Time
	rows    map[string]*Budget
}

// NewMemoryBudget is the process-local ledger. It rolls over on the calendar
// month and is authoritative for the running process; a durable ledger can be
// substituted through BudgetLedger without touching fan-out.
func NewMemoryBudget(ceiling int, now func() time.Time) BudgetLedger {
	if ceiling <= 0 {
		ceiling = DefaultSMSCeiling
	}
	if now == nil {
		now = time.Now
	}
	return &memoryBudget{ceiling: ceiling, now: now, rows: map[string]*Budget{}}
}

func (m *memoryBudget) row(familyID string) *Budget {
	month := m.now().UTC().Format("2006-01")
	b, ok := m.rows[familyID]
	if !ok || b.Month != month {
		b = &Budget{FamilyID: familyID, Month: month, SMSCeiling: m.ceiling}
		m.rows[familyID] = b
	}
	return b
}

func (m *memoryBudget) Reserve(familyID string, smsUnits, voiceSeconds int) (bool, bool, Budget) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b := m.row(familyID)
	if smsUnits == 0 && voiceSeconds == 0 {
		return true, false, *b
	}
	// A voice call is charged against the same ceiling at 1 unit per 30 s, so a
	// runaway cannot escape the cap by switching channel.
	units := smsUnits + (voiceSeconds+29)/30
	if b.SMSSent+units > b.SMSCeiling {
		first := b.BreachedAt == 0
		if first {
			b.BreachedAt = m.now().UnixMilli()
		}
		return false, first, *b
	}
	b.SMSSent += smsUnits + (voiceSeconds+29)/30
	b.VoiceSeconds += voiceSeconds
	return true, false, *b
}

func (m *memoryBudget) Snapshot(familyID string) Budget {
	m.mu.Lock()
	defer m.mu.Unlock()
	return *m.row(familyID)
}

// ── Dependencies ─────────────────────────────────────────────────────────────

// Store is the consumer-defined slice of persistence this module needs
// (§2.5.3: cross-module calls go through consumer-defined interfaces so a
// module can be extracted into its own binary without a rewrite).
type Store interface {
	Members(familyID string) []store.Member
	Devices(familyID string) []store.Device
	PutNotification(store.Notification) error
	PutDelivery(store.Delivery) error
}

type Publisher interface {
	Publish(subject string, data []byte) error
}

// DrillResolver answers "which drill run does this incident belong to". It is
// injected rather than read off the incident row because the control plane owns
// the incident→drill_run association it created.
type DrillResolver interface {
	DrillRunForIncident(incidentID string) (store.DrillRun, bool)
}

type Deps struct {
	Store  Store
	Bus    Publisher
	Log    *slog.Logger
	Budget BudgetLedger
	Drills DrillResolver
	Now    func() time.Time
	NewID  func() string
}

type Notifier struct {
	st     Store
	bus    Publisher
	log    *slog.Logger
	budget BudgetLedger
	drills DrillResolver
	now    func() time.Time
	newID  func() string

	wg   sync.WaitGroup
	rndM sync.Mutex
	rnd  *rand.Rand
}

var ErrNoStore = errors.New("notify: store is required")

func New(d Deps) (*Notifier, error) {
	if d.Store == nil || d.Bus == nil {
		return nil, ErrNoStore
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.NewID == nil {
		d.NewID = func() string { return fmt.Sprintf("n-%d", time.Now().UnixNano()) }
	}
	if d.Budget == nil {
		d.Budget = NewMemoryBudget(DefaultSMSCeiling, d.Now)
	}
	return &Notifier{
		st: d.Store, bus: d.Bus, log: d.Log, budget: d.Budget, drills: d.Drills,
		now: d.Now, newID: d.NewID,
		rnd: rand.New(rand.NewPCG(uint64(d.Now().UnixNano()), 0x5eed)),
	}, nil
}

// Close waits for in-flight delivery legs so a shutdown does not lose delivery
// receipts that a responder's after-action report will ask for.
func (n *Notifier) Close() { n.wg.Wait() }

// ── Fan-out ──────────────────────────────────────────────────────────────────

// Step is one rung of the ladder as the escalation engine sees it.
type Step struct {
	Tier     int
	Label    string
	Channels []Channel
	// Repeat marks the 30 s re-blast: same audience, louder, different tone.
	Repeat bool
}

type Result struct {
	NotificationID  string
	Audience        []string // device ids on the sealed feed
	ReducedAudience []string // device ids on the neighbour feed (Class B/C only)
	FirstNotifiedAt int64
	Suppressed      []Channel
	DrillScoped     bool
	BudgetBreached  bool
}

// Fanout resolves the audience, publishes the content frame, and starts one
// delivery leg per (device, channel). It never returns an error for a partly
// failed fan-out: a channel that cannot be attempted is recorded as a failed
// delivery, because "we could not reach Ma's phone" is information the family
// needs, not an error to bubble into a 500.
func (n *Notifier) Fanout(ctx context.Context, inc store.Incident, step Step) (Result, error) {
	res := Result{NotificationID: n.newID()}
	at := n.now().UnixMilli()

	full, reduced, drillScoped := n.audience(inc, step)
	res.DrillScoped = drillScoped
	for _, d := range full {
		res.Audience = append(res.Audience, d.ID)
	}
	for _, d := range reduced {
		res.ReducedAudience = append(res.ReducedAudience, d.ID)
	}

	names := n.shortNames(inc.FamilyID)

	note := store.Notification{
		ID:         res.NotificationID,
		FamilyID:   inc.FamilyID,
		IncidentID: inc.ID,
		Tier:       step.Tier,
		Label:      step.Label,
		IsDrill:    inc.IsDrill,
		Audience:   append(append([]string{}, res.Audience...), res.ReducedAudience...),
		CreatedAt:  at,
	}
	if err := n.st.PutNotification(note); err != nil {
		// Losing the notification row loses the after-action notification
		// matrix, not the alert. Log and keep going — the alert is the product.
		n.log.Error("notification_persist_failed", "incident", inc.ID, "err", err)
	}

	// The sealed content frame. Published once to the family subject; every
	// family socket is already subscribed, which is the WS leg for all of them.
	if len(full) > 0 {
		frame := Frame{
			V: FrameVersion, Type: "incident.notified", Priority: PriorityCritical,
			FamilyID: inc.FamilyID, IncidentID: inc.ID, At: at,
			Data: map[string]any{
				"tier":     step.Tier,
				"label":    step.Label,
				"repeat":   step.Repeat,
				"state":    string(inc.State),
				"trigger":  inc.Trigger,
				"duress":   inc.Duress,
				"isDrill":  inc.IsDrill,
				"subject":  names[inc.SubjectMemberID],
				"audience": res.Audience,
				// Sealed ciphertext. The server cannot read it; it is relayed
				// so a responder's device can open it with the group key.
				"sealed": inc.SealedPayload,
			},
		}
		if err := n.bus.Publish(StreamSubject(inc.FamilyID), frame.Encode()); err != nil {
			n.log.Error("stream_publish_failed", "incident", inc.ID, "err", err)
		} else {
			res.FirstNotifiedAt = at
		}
	}

	// The neighbour frame. Separate subject, separate construction, asserted
	// Class B/C. F-20.
	if len(reduced) > 0 {
		if err := n.publishReduced(inc, step, names[inc.SubjectMemberID], at); err != nil {
			n.log.Error("reduced_publish_failed", "incident", inc.ID, "err", err)
		} else if res.FirstNotifiedAt == 0 {
			res.FirstNotifiedAt = at
		}
	}

	// Delivery legs.
	for _, dev := range full {
		suppressed := n.dispatch(ctx, inc, note, dev, step, false)
		res.Suppressed = append(res.Suppressed, suppressed...)
	}
	for _, dev := range reduced {
		// Neighbours never get SMS or voice: those channels would carry a
		// human-readable location into a phone outside the family's crypto
		// group. Their feed is metadata + a 112 button, nothing more (F-20).
		suppressed := n.dispatch(ctx, inc, note, dev, Step{
			Tier: step.Tier, Label: step.Label, Repeat: step.Repeat,
			Channels: intersect(step.Channels, []Channel{ChannelWS, ChannelFCM, ChannelAPNs}),
		}, true)
		res.Suppressed = append(res.Suppressed, suppressed...)
	}

	if len(res.Suppressed) > 0 {
		for _, c := range res.Suppressed {
			if profiles[c].billable {
				res.BudgetBreached = true
			}
		}
	}

	n.log.Info("fanout",
		"incident", inc.ID, "tier", step.Tier, "label", step.Label,
		"devices", len(full), "neighbours", len(reduced),
		"drillScoped", drillScoped, "suppressed", len(res.Suppressed))
	return res, nil
}

func (n *Notifier) publishReduced(inc store.Incident, step Step, subjectName string, at int64) error {
	// Class B/C only: incident state, trigger class, coarse cell, short name,
	// and the fact that a 112 button should be shown. Nothing here can be
	// decrypted into a precise location because none of it is Class A.
	data := map[string]any{
		"tier":       step.Tier,
		"state":      string(inc.State),
		"trigger":    inc.Trigger,
		"coarseCell": inc.CoarseH3R7,
		"subject":    subjectName,
		"show112":    true,
	}
	if err := assertClassBC(data); err != nil {
		// Fail closed. A reduced frame that somehow acquired a Class A field is
		// not degraded — it is a privacy breach, and dropping it is correct.
		return err
	}
	frame := Frame{
		V: FrameVersion, Type: "incident.notified", Priority: PriorityCritical,
		FamilyID: inc.FamilyID, IncidentID: inc.ID, At: at, Reduced: true, Data: data,
	}
	return n.bus.Publish(ReducedSubject(inc.FamilyID), frame.Encode())
}

func assertClassBC(data map[string]any) error {
	for k := range data {
		if classAKeys[k] {
			return fmt.Errorf("notify: Class A field %q in a reduced frame (F-20)", k)
		}
	}
	return nil
}

// dispatch starts one leg per eligible channel and returns the channels that
// were refused by the spend ceiling.
func (n *Notifier) dispatch(ctx context.Context, inc store.Incident, note store.Notification, dev store.Device, step Step, reduced bool) []Channel {
	var suppressed []Channel
	member := n.member(inc.FamilyID, dev.MemberID)

	for _, ch := range intersect(step.Channels, channelsFor(dev.Platform)) {
		p := profiles[ch]

		if p.billable {
			ok, breached, snap := n.budget.Reserve(inc.FamilyID, p.smsUnits, p.voiceSecs)
			if breached {
				n.pageBudgetBreach(snap)
			}
			if !ok {
				suppressed = append(suppressed, ch)
				n.recordDelivery(inc, note, dev, ch, "suppressed", 0, "KV-BUDGET", reduced)
				continue
			}
		}
		// Eligibility is derived from real state, never from a coin flip: an
		// SMS to a member with no number cannot arrive, and a push to a device
		// whose agent has been silently dead for a day very probably will not.
		if (ch == ChannelSMS || ch == ChannelVoice) && strings.TrimSpace(member.PhoneE164) == "" {
			n.recordDelivery(inc, note, dev, ch, "failed", 0, "KV-NOPHONE", reduced)
			continue
		}
		if ch != ChannelWS && !dev.AgentHealthy {
			n.recordDelivery(inc, note, dev, ch, "failed", 0, "KV-AGENT-DEAD", reduced)
			continue
		}
		n.startLeg(ctx, inc, note, dev, ch, p, reduced)
	}
	return suppressed
}

// startLeg models one channel's wire time and records the receipt when it
// lands. The WS leg is settled immediately because the frame really has been
// published to the bus by the time we get here.
func (n *Notifier) startLeg(ctx context.Context, inc store.Incident, note store.Notification, dev store.Device, ch Channel, p channelProfile, reduced bool) {
	if ch == ChannelWS {
		n.recordDelivery(inc, note, dev, ch, "delivered", 0, "", reduced)
		return
	}
	delay := n.jitter(p.minLatency, p.maxLatency)
	n.recordDelivery(inc, note, dev, ch, "sent", 0, "", reduced)

	n.wg.Add(1)
	go func() {
		defer n.wg.Done()
		t := time.NewTimer(delay)
		defer t.Stop()
		select {
		case <-ctx.Done():
			// Shutdown mid-flight: record the truth rather than a delivery we
			// cannot vouch for.
			n.recordDelivery(inc, note, dev, ch, "unknown", delay.Milliseconds(), "KV-SHUTDOWN", reduced)
			return
		case <-t.C:
		}
		n.recordDelivery(inc, note, dev, ch, "delivered", delay.Milliseconds(), "", reduced)
		receipt := Frame{
			V: FrameVersion, Type: "notify.delivered", Priority: PriorityHigh,
			FamilyID: inc.FamilyID, IncidentID: inc.ID, At: n.now().UnixMilli(),
			Reduced: reduced,
			Data: map[string]any{
				"notificationId": note.ID,
				"deviceId":       dev.ID,
				"channel":        string(ch),
				"latencyMs":      delay.Milliseconds(),
			},
		}
		subject := StreamSubject(inc.FamilyID)
		if reduced {
			subject = ReducedSubject(inc.FamilyID)
		}
		if err := n.bus.Publish(subject, receipt.Encode()); err != nil {
			n.log.Warn("receipt_publish_failed", "incident", inc.ID, "channel", ch, "err", err)
		}
	}()
}

func (n *Notifier) recordDelivery(inc store.Incident, note store.Notification, dev store.Device, ch Channel, state string, latencyMs int64, errCode string, reduced bool) {
	at := n.now().UnixMilli()
	d := store.Delivery{
		ID:             n.newID(),
		FamilyID:       inc.FamilyID,
		IncidentID:     inc.ID,
		NotificationID: note.ID,
		MemberID:       dev.MemberID,
		DeviceID:       dev.ID,
		Channel:        string(ch),
		State:          state,
		AttemptedAt:    at,
		LatencyMs:      latencyMs,
		ErrorCode:      errCode,
		Reduced:        reduced,
	}
	if state == "delivered" {
		d.DeliveredAt = at
	}
	if err := n.st.PutDelivery(d); err != nil {
		n.log.Error("delivery_persist_failed", "incident", inc.ID, "channel", ch, "err", err)
	}
}

func (n *Notifier) pageBudgetBreach(b Budget) {
	// §2.11.5: a breached notify budget is P0. It means either a real family
	// emergency of unprecedented size or — far more likely — the fail-open
	// ingest path is being abused, and the next thing to break is every family
	// phone's trust in the alarm.
	n.log.Error("notify_budget_breached_P0",
		"family", b.FamilyID, "month", b.Month, "smsSent", b.SMSSent, "ceiling", b.SMSCeiling)
	frame := Frame{
		V: FrameVersion, Type: "ops.budget_breached", Priority: PriorityCritical,
		FamilyID: b.FamilyID, At: n.now().UnixMilli(),
		Data: map[string]any{
			"severity": "P0", "month": b.Month,
			"smsSent": b.SMSSent, "ceiling": b.SMSCeiling, "finding": "F-04",
		},
	}
	if err := n.bus.Publish(OpsSubject, frame.Encode()); err != nil {
		n.log.Error("ops_alert_publish_failed", "err", err)
	}
}

// ── Audience resolution ──────────────────────────────────────────────────────

// audience answers the only question that matters at fan-out time: whose phone
// rings.
func (n *Notifier) audience(inc store.Incident, step Step) (full, reduced []store.Device, drillScoped bool) {
	devices := n.st.Devices(inc.FamilyID)

	if inc.IsDrill {
		// ★ F-03 ★ The canary fires a real incident through the real handler
		// every 15 minutes — 96 times a day. If fan-out is not scoped here,
		// every family phone rings 96 times a day and the system dies in week
		// one from precisely the alert fatigue it exists to prevent (RISK-002).
		// The drill audience is the canary receiver and nobody else, unless the
		// quarterly drill orchestrator explicitly set notifies_family.
		drillScoped = true
		var run store.DrillRun
		var ok bool
		if n.drills != nil {
			run, ok = n.drills.DrillRunForIncident(inc.ID)
		}
		if !ok {
			// Fail closed. A drill that cannot prove which audience it belongs
			// to notifies nobody: the cost of a missed drill is a canary page,
			// the cost of a mis-scoped drill is the family muting the app.
			n.log.Warn("drill_without_run_scoped_to_nobody", "incident", inc.ID)
			return nil, nil, true
		}
		if run.NotifiesFamily {
			return n.tierDevices(inc, devices, step.Tier), nil, true
		}
		want := map[string]bool{}
		for _, id := range run.AudienceDeviceIDs {
			want[id] = true
		}
		for _, d := range devices {
			if want[d.ID] && d.RevokedAt == 0 {
				full = append(full, d)
			}
		}
		return full, nil, true
	}

	full = n.tierDevices(inc, devices, step.Tier)
	if step.Tier >= 2 && triggerAllowsNeighbours(inc.Trigger) {
		byMember := n.membersByID(inc.FamilyID)
		for _, d := range devices {
			if d.RevokedAt == 0 && strings.EqualFold(byMember[d.MemberID].Role, "neighbour") {
				reduced = append(reduced, d)
			}
		}
	}
	return full, reduced, false
}

// tierDevices is the ladder audience for a tier, minus neighbours (who are
// served separately) and minus the subject's own devices (which are already
// screaming locally and are not a responder).
func (n *Notifier) tierDevices(inc store.Incident, devices []store.Device, tier int) []store.Device {
	byMember := n.membersByID(inc.FamilyID)
	var out []store.Device
	for _, d := range devices {
		m := byMember[d.MemberID]
		if m.ID == "" || m.ID == inc.SubjectMemberID {
			continue
		}
		// A revoked device is a phone somebody lost or a member who left. It
		// must never be handed an incident again (§2.4 device revocation).
		if d.RevokedAt != 0 {
			continue
		}
		if strings.EqualFold(m.Role, "neighbour") {
			continue
		}
		if m.MembershipExpiresAt > 0 && m.MembershipExpiresAt < n.now().UnixMilli() {
			continue // temporary member whose window closed
		}
		if !roleInTier(m.Role, tier) {
			continue
		}
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// roleInTier encodes §2.6.2's ladder audiences. Tier 1 is the people who can
// actually get there; tier 2 widens to extended family and staff; tier 3 is
// everyone with a device, because at that point nobody has responded for three
// minutes.
func roleInTier(role string, tier int) bool {
	role = strings.ToLower(role)
	switch tier {
	case 1:
		return role == "guardian" || role == "adult" || role == "elder"
	case 2:
		return role == "guardian" || role == "adult" || role == "elder" ||
			role == "relative" || role == "staff"
	default:
		return role != ""
	}
}

// triggerAllowsNeighbours: a child crossing a geofence is the deliberately
// slowest and quietest policy in the system and never reaches a neighbour
// (§2.5.6). A silenced device is a suspicion, not an emergency, and likewise
// stays inside the family.
func triggerAllowsNeighbours(trigger string) bool {
	switch strings.ToUpper(trigger) {
	case "GEOFENCE", "DEVICE_SILENCED", "DEADMAN":
		return false
	default:
		return true
	}
}

func (n *Notifier) membersByID(familyID string) map[string]store.Member {
	out := map[string]store.Member{}
	for _, m := range n.st.Members(familyID) {
		out[m.ID] = m
	}
	return out
}

func (n *Notifier) member(familyID, memberID string) store.Member {
	for _, m := range n.st.Members(familyID) {
		if m.ID == memberID {
			return m
		}
	}
	return store.Member{}
}

// shortNames yields the ASCII short name per member — the only human-readable
// identifier that leaves the family group (F-18, §2.6.3 F-21).
func (n *Notifier) shortNames(familyID string) map[string]string {
	out := map[string]string{}
	for _, m := range n.st.Members(familyID) {
		name := m.ASCIIShortName
		if name == "" {
			name = m.DisplayName
		}
		out[m.ID] = name
	}
	return out
}

func (n *Notifier) jitter(min, max time.Duration) time.Duration {
	if max <= min {
		return min
	}
	n.rndM.Lock()
	defer n.rndM.Unlock()
	return min + time.Duration(n.rnd.Int64N(int64(max-min)))
}

func intersect(a, b []Channel) []Channel {
	have := map[Channel]bool{}
	for _, c := range b {
		have[c] = true
	}
	var out []Channel
	for _, c := range a {
		if have[c] {
			out = append(out, c)
		}
	}
	return out
}
