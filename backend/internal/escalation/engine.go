// Package escalation runs the incident ladder on durable timers.
//
// ★ Do not use time.AfterFunc. Do not use cron. ★ (ADR-014, §2.5.4)
//
// A timer that lives in process memory dies with the process, and the process
// will die — during a deploy, during an OOM, during a host reboot at 3 a.m.
// while somebody's incident is sitting at ACTIVE_L1 waiting for the 90-second
// rung. Every timer in this package is a row the store owns; a worker claims it
// atomically, executes it, and the claim is what makes execution at-most-once.
// You can inspect the pending ladder with a read at 3 a.m., which is exactly
// when you will need to.
package escalation

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/kavach/backend/internal/incident"
	"github.com/kavach/backend/internal/notify"
	"github.com/kavach/backend/internal/store"
)

// ── Ladder ───────────────────────────────────────────────────────────────────

// Timer actions. The action is the unit of work; the resulting state
// transition (if any) is looked up from the generated machine, never hardcoded
// twice.
const (
	ActionCancelWindow = "CANCEL_WINDOW"
	ActionProbeTimeout = "PROBE_TIMEOUT"
	ActionRepeatL1     = "REPEAT_L1"
	ActionSMSTier      = "SMS_TIER"
	ActionEscalateL2   = "ESCALATE_L2"
	ActionEscalateL3   = "ESCALATE_L3"
	ActionWatchdog     = "PROGRESS_WATCHDOG"
	ActionAutoQuiesce  = "AUTO_QUIESCE"
)

// Timer lifecycle states, re-exported from the store so there is exactly one
// spelling of "pending" in the codebase.
const (
	TimerPending   = store.TimerPending
	TimerFired     = store.TimerFired
	TimerCancelled = store.TimerCancelled
)

// Ladder offsets in seconds, anchored at the moment the incident becomes
// ACTIVE_L1 (not at open — a geofence policy has a five-minute cancel window
// and its ladder must not have already run out by the time L1 starts).
//
// RepeatL1 and SMSTier have no state transition of their own: they are extra
// notification rungs on the same state. Humans genuinely miss the first push
// (§2.6.2), and the SMS rung is independent of both our infrastructure and
// Google's/Apple's, which is the whole reason it exists.
const (
	RepeatL1AfterS = 30
	SMSTierAfterS  = 60
)

// afterSFor reads the timeout straight out of the generated state machine so a
// change to spec/state-machine.yaml propagates here instead of drifting.
// Divergence between the spec and the server's idea of the ladder is a class of
// bug we cannot afford (§2.5.5).
func afterSFor(from incident.State, on incident.Event, fallback int) int {
	for _, t := range incident.Transitions {
		if t.From == from && t.On == on && t.AfterS > 0 {
			return t.AfterS
		}
	}
	return fallback
}

// L2AfterS / L3AfterS / WatchdogAfterS / AutoQuiesceAfterS mirror §2.6.2.
// L3 is anchored at L1 entry, not at L2 entry, because the PRD ladder is stated
// in absolute time from the blast (T+180s), and a responder reading the
// timeline needs those numbers to mean what the policy document says.
func L2AfterS() int { return afterSFor(incident.StateActiveL1, incident.EventNoAck, 90) }
func L3AfterS() int { return afterSFor(incident.StateActiveL2, incident.EventNoAck, 180) }
func WatchdogAfterS() int {
	return afterSFor(incident.StateOwned, incident.EventProgressWatchdog, 300)
}

// AutoQuiesceAfterS is F-02: an incident that reaches OWNED and never receives
// its two-party confirmation (subject hospitalised, responder forgets) would
// otherwise stay active forever — freezing every deploy and leaving escalation
// timers armed against a phone that stopped caring hours ago.
func AutoQuiesceAfterS() int {
	return afterSFor(incident.StateActiveL1, incident.EventAutoQuiesce, 21600)
}

// defaultCancelWindowS is the per-scenario cancel window from §2.5.6. The
// device runs its own copy of this from policy_cache so T0 works with no
// network; the server arms it too, because the device may be underwater.
var defaultCancelWindowS = map[string]int{
	"MANUAL":          20,
	"CRASH":           20,
	"FALL":            45,
	"NO_MOTION":       45,
	"SENSOR_HOME":     60,
	"GEOFENCE":        300,
	"DEADMAN":         900,
	"DEVICE_SILENCED": 0,
	"BLE_FOB":         10,
	"VOICE_PHRASE":    10,
	"RELAY":           0,
	"DRILL":           0,
}

// ── Dependencies ─────────────────────────────────────────────────────────────

// Store is the consumer-defined persistence slice this module needs (§2.5.3).
type Store interface {
	Incident(id string) (store.Incident, bool)
	PutIncident(store.Incident) error
	AppendEvent(store.Event) error
	Events(incidentID string) []store.Event
	Timers() []store.Timer
	TimersForIncident(incidentID string) []store.Timer
	PutTimer(store.Timer) error
}

// TimerClaimer is the atomic claim primitive: move a timer from pending to
// fired in one step, returning an error if somebody else already had it. That
// is SELECT … FOR UPDATE SKIP LOCKED expressed as one call. A store that offers
// it gets exact cross-process semantics for free; a store that does not falls
// back to claimOptimistic below.
type TimerClaimer interface {
	FireTimer(id string) error
}

type Publisher interface {
	Publish(subject string, data []byte) error
}

// Fanouter is satisfied by *notify.Notifier.
type Fanouter interface {
	Fanout(ctx context.Context, inc store.Incident, step notify.Step) (notify.Result, error)
}

type Config struct {
	// Workers is how many stateless pollers this process runs.
	//
	// ★ F-13: there is NO leader election here, deliberately. ★
	// FOR UPDATE SKIP LOCKED exists precisely so you do not need one, and a
	// leader-elected design has a failure mode this one cannot have: a lost
	// leader stalls *every* timer in the system until the lease expires, which
	// on an escalation ladder means nobody's phone rings. N stateless workers
	// racing for the same rows have no such state to lose — kill any of them at
	// any moment and the rest keep firing.
	Workers int

	PollFast   time.Duration // when something is due soon
	PollSlow   time.Duration // when nothing is
	DueSoon    time.Duration // "soon" threshold
	BatchLimit int

	// CancelWindowS overrides the §2.5.6 defaults per trigger.
	CancelWindowS map[string]int

	// NodeID seeds the HLC node field (§2.10.5).
	NodeID [4]byte
}

func (c *Config) applyDefaults() {
	if c.Workers <= 0 {
		c.Workers = 3
	}
	// 250 ms when a timer is due within 5 s, 2 s otherwise: identical latency
	// at the moment it matters, ~90% fewer reads the rest of the time (F-13).
	if c.PollFast <= 0 {
		c.PollFast = 250 * time.Millisecond
	}
	if c.PollSlow <= 0 {
		c.PollSlow = 2 * time.Second
	}
	if c.DueSoon <= 0 {
		c.DueSoon = 5 * time.Second
	}
	if c.BatchLimit <= 0 {
		c.BatchLimit = 100
	}
}

type Deps struct {
	Store  Store
	Bus    Publisher
	Notify Fanouter
	Log    *slog.Logger
	Now    func() time.Time
	NewID  func() string
	Config Config
}

type Engine struct {
	st    Store
	bus   Publisher
	fan   Fanouter
	log   *slog.Logger
	now   func() time.Time
	newID func() string
	cfg   Config

	hlc  hlcClock
	wg   sync.WaitGroup
	stat stats

	claimMu  sync.Mutex
	inflight map[string]bool
}

type stats struct {
	mu       sync.Mutex
	fired    int64
	skipped  int64
	overdue  int64
	failed   int64
	lastPoll int64
}

var (
	ErrIncidentNotFound  = errors.New("escalation: incident not found")
	ErrInvalidTransition = errors.New("escalation: event does not apply in this state")
	ErrSameParty         = errors.New("escalation: two-party resolution requires a second member")
)

func New(d Deps) (*Engine, error) {
	if d.Store == nil || d.Bus == nil {
		return nil, errors.New("escalation: store and bus are required")
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.NewID == nil {
		d.NewID = func() string { return fmt.Sprintf("t-%d", time.Now().UnixNano()) }
	}
	d.Config.applyDefaults()
	return &Engine{
		st: d.Store, bus: d.Bus, fan: d.Notify, log: d.Log,
		now: d.Now, newID: d.NewID, cfg: d.Config,
		hlc:      hlcClock{node: d.Config.NodeID},
		inflight: map[string]bool{},
	}, nil
}

// claim implements the SKIP LOCKED move. Whoever wins owns the row; everybody
// else moves on without blocking. No lease, no leader, nothing to stall.
func (e *Engine) claim(t store.Timer) bool {
	if c, ok := e.st.(TimerClaimer); ok {
		return c.FireTimer(t.ID) == nil
	}
	return e.claimOptimistic(t)
}

// claimOptimistic is the fallback when the store has no transactional claim:
// take a process-local in-flight marker, re-read the row, and only write if it
// is still pending. Two workers that read the same pending row simultaneously
// converge here, and the loser simply skips.
func (e *Engine) claimOptimistic(t store.Timer) bool {
	e.claimMu.Lock()
	if e.inflight[t.ID] {
		e.claimMu.Unlock()
		return false
	}
	e.inflight[t.ID] = true
	e.claimMu.Unlock()

	release := func() {
		e.claimMu.Lock()
		delete(e.inflight, t.ID)
		e.claimMu.Unlock()
	}

	for _, cur := range e.st.TimersForIncident(t.IncidentID) {
		if cur.ID != t.ID {
			continue
		}
		if cur.State != TimerPending || cur.FiredAt != 0 {
			release()
			return false
		}
		cur.State = TimerFired
		cur.FiredAt = e.now().UnixMilli()
		if err := e.st.PutTimer(cur); err != nil {
			e.log.Error("timer_claim_write_failed", "timer", t.ID, "err", err)
			release()
			return false
		}
		return true
	}
	release()
	return false
}

func (e *Engine) releaseClaim(id string) {
	e.claimMu.Lock()
	delete(e.inflight, id)
	e.claimMu.Unlock()
}

// ── The worker pool ──────────────────────────────────────────────────────────

// Run starts Workers identical pollers and blocks until ctx is done. Every
// worker is stateless and interchangeable; there is no coordinator to lose.
func (e *Engine) Run(ctx context.Context) {
	for i := 0; i < e.cfg.Workers; i++ {
		e.wg.Add(1)
		go func(id int) {
			defer e.wg.Done()
			e.worker(ctx, fmt.Sprintf("w%d", id))
		}(i)
	}
	<-ctx.Done()
	e.wg.Wait()
}

func (e *Engine) worker(ctx context.Context, workerID string) {
	// Stagger the pollers so N workers do not all wake on the same millisecond
	// and contend for the same rows every single tick.
	stagger := time.Duration(int64(e.cfg.PollFast) / int64(max(e.cfg.Workers, 1)))
	timer := time.NewTimer(stagger)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		wait := e.pollOnce(ctx, workerID)
		timer.Reset(wait)
	}
}

// pollOnce claims and executes every due timer, then returns how long to sleep.
func (e *Engine) pollOnce(ctx context.Context, workerID string) time.Duration {
	now := e.now().UnixMilli()
	all := e.st.Timers()

	var due []store.Timer
	nextFuture := int64(0)
	for _, t := range all {
		if t.State != TimerPending {
			continue
		}
		if t.FireAt <= now {
			due = append(due, t)
			continue
		}
		if nextFuture == 0 || t.FireAt < nextFuture {
			nextFuture = t.FireAt
		}
	}
	sort.Slice(due, func(i, j int) bool { return due[i].FireAt < due[j].FireAt })
	if len(due) > e.cfg.BatchLimit {
		due = due[:e.cfg.BatchLimit]
	}

	for _, t := range due {
		select {
		case <-ctx.Done():
			return e.cfg.PollFast
		default:
		}
		if !e.claim(t) {
			e.stat.bump(&e.stat.skipped)
			continue
		}
		if lateBy := now - t.FireAt; lateBy > 60_000 {
			// §2.11.5: an escalation timer more than 60 s overdue is P0.
			e.stat.bump(&e.stat.overdue)
			e.log.Error("escalation_timer_overdue_P0",
				"timer", t.ID, "incident", t.IncidentID, "action", t.Action, "lateMs", lateBy)
			e.publishOps("ops.timer_overdue", t.FamilyID, map[string]any{
				"severity": "P0", "timerId": t.ID, "incidentId": t.IncidentID,
				"action": t.Action, "lateMs": lateBy,
			})
		}
		e.stat.bump(&e.stat.fired)
		err := e.execute(ctx, t)
		e.releaseClaim(t.ID)
		if err != nil {
			e.stat.bump(&e.stat.failed)
			e.log.Error("timer_execute_failed",
				"worker", workerID, "timer", t.ID, "incident", t.IncidentID,
				"action", t.Action, "err", err)
			// A consumed timer whose work failed would silently drop a rung of
			// the ladder. Re-arm a fresh one a few seconds out so the ladder
			// limps forward instead of stopping.
			e.rearm(t)
		}
	}

	e.stat.mu.Lock()
	e.stat.lastPoll = now
	e.stat.mu.Unlock()

	// Adaptive poll (F-13): tight only when something is actually about to
	// fire. Same latency at the moment that matters, ~90% fewer reads the rest
	// of the day. We just executed a batch, so if anything was due we stay hot
	// for one more tick to pick up whatever those transitions armed.
	if len(due) > 0 {
		return e.cfg.PollFast
	}
	if nextFuture == 0 {
		return e.cfg.PollSlow
	}
	if until := time.Duration(nextFuture-now) * time.Millisecond; until <= e.cfg.DueSoon {
		return e.cfg.PollFast
	}
	return e.cfg.PollSlow
}

func (e *Engine) rearm(t store.Timer) {
	if t.Attempts >= 3 {
		e.log.Error("timer_abandoned_after_retries", "timer", t.ID, "incident", t.IncidentID)
		return
	}
	retry := t
	retry.ID = e.newID()
	retry.State = TimerPending
	retry.FireAt = e.now().Add(5 * time.Second).UnixMilli()
	retry.Attempts = t.Attempts + 1
	retry.CreatedAt = e.now().UnixMilli()
	if err := e.st.PutTimer(retry); err != nil {
		e.log.Error("timer_rearm_failed", "timer", t.ID, "err", err)
	}
}

// Stats exposes the numbers the operator dashboard cares about (§2.11.4).
func (e *Engine) Stats() (fired, skipped, overdue, failed, lastPollAt int64) {
	e.stat.mu.Lock()
	defer e.stat.mu.Unlock()
	return e.stat.fired, e.stat.skipped, e.stat.overdue, e.stat.failed, e.stat.lastPoll
}

func (s *stats) bump(p *int64) {
	s.mu.Lock()
	*p++
	s.mu.Unlock()
}

// ── Timer execution ──────────────────────────────────────────────────────────

func (e *Engine) execute(ctx context.Context, t store.Timer) error {
	inc, ok := e.st.Incident(t.IncidentID)
	if !ok {
		return ErrIncidentNotFound
	}
	if incident.IsTerminal(inc.State) || inc.MergedIntoID != "" {
		// The incident finished (or was merged, F-09) while this timer sat in
		// the queue. Nothing to do; cancel the rest of its ladder.
		e.cancelTimers(inc.ID, "")
		return nil
	}

	switch t.Action {
	case ActionCancelWindow:
		if inc.State != incident.StatePending {
			return nil
		}
		next, err := e.applyEvent(ctx, inc, incident.EventCancelWindowExpired, nil, map[string]any{
			"source": "server_timer",
		})
		if err != nil {
			return err
		}
		return e.BlastL1(ctx, next)

	case ActionProbeTimeout:
		if inc.State != incident.StateProbe {
			return nil
		}
		_, err := e.applyEvent(ctx, inc, incident.EventProbeTimeout, nil, nil)
		return err

	case ActionRepeatL1:
		if !isL1(inc.State) {
			return nil
		}
		return e.notifyStep(ctx, inc, notify.Step{
			Tier: 1, Label: "repeat-L1", Repeat: true,
			Channels: []notify.Channel{notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit},
		})

	case ActionSMSTier:
		if !incident.IsActive(inc.State) || inc.State == incident.StatePending || inc.State == incident.StateOwned {
			return nil
		}
		return e.notifyStep(ctx, inc, notify.Step{
			Tier: 1, Label: "sms-tier",
			Channels: []notify.Channel{notify.ChannelSMS},
		})

	case ActionEscalateL2:
		if inc.State != incident.StateActiveL1 && inc.State != incident.StateActiveL1Silent {
			return nil
		}
		next, err := e.applyEvent(ctx, inc, incident.EventNoAck, nil, nil)
		if err != nil {
			return err
		}
		return e.notifyStep(ctx, next, notify.Step{
			Tier: 2, Label: "L2",
			Channels: []notify.Channel{notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit, notify.ChannelVoice},
		})

	case ActionEscalateL3:
		if inc.State != incident.StateActiveL2 {
			return nil
		}
		next, err := e.applyEvent(ctx, inc, incident.EventNoAck, nil, nil)
		if err != nil {
			return err
		}
		return e.notifyStep(ctx, next, notify.Step{
			Tier: 3, Label: "L3",
			Channels: []notify.Channel{notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit, notify.ChannelSMS, notify.ChannelVoice},
		})

	case ActionWatchdog:
		if inc.State != incident.StateOwned {
			return nil
		}
		// The owner claimed and then went quiet. Without this rung one person
		// claims, gets stuck in traffic, and everyone else has stood down
		// permanently (P-030).
		next, err := e.applyEvent(ctx, inc, incident.EventProgressWatchdog, nil, map[string]any{
			"previousOwner": inc.OwnerMemberID,
			"reason":        "no progress for " + fmt.Sprint(WatchdogAfterS()) + "s",
		})
		if err != nil {
			return err
		}
		next.OwnerMemberID = ""
		if err := e.st.PutIncident(next); err != nil {
			return err
		}
		e.armL3(next, e.now())
		return e.notifyStep(ctx, next, notify.Step{
			Tier: 2, Label: "reclaimed-watchdog",
			Channels: []notify.Channel{notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit},
		})

	case ActionAutoQuiesce:
		// F-02. Six hours in, this incident is not an emergency any more; it is
		// a stuck row that freezes deploys and keeps timers armed.
		next, err := e.applyEvent(ctx, inc, incident.EventAutoQuiesce, nil, map[string]any{
			"reason": "auto-quiesce after " + fmt.Sprint(AutoQuiesceAfterS()) + "s",
			"banner": "This incident was closed automatically after 6 hours.",
		})
		if err != nil {
			return err
		}
		e.cancelTimers(next.ID, "")
		return nil

	default:
		return fmt.Errorf("escalation: unknown timer action %q", t.Action)
	}
}

func isL1(s incident.State) bool {
	return s == incident.StateActiveL1 || s == incident.StateActiveL1Silent
}

func (e *Engine) notifyStep(ctx context.Context, inc store.Incident, step notify.Step) error {
	if e.fan == nil {
		return nil
	}
	res, err := e.fan.Fanout(ctx, inc, step)
	if err != nil {
		return err
	}
	// t3 — first notified. Recorded once, on the first rung that actually
	// reached somebody.
	if inc.FirstNotifiedAt == 0 && res.FirstNotifiedAt > 0 {
		inc.FirstNotifiedAt = res.FirstNotifiedAt
		if err := e.st.PutIncident(inc); err != nil {
			e.log.Error("first_notified_persist_failed", "incident", inc.ID, "err", err)
		}
	}
	return e.appendInfo(inc, "NOTIFY_"+step.Label, map[string]any{
		"tier":        step.Tier,
		"audience":    res.Audience,
		"reduced":     res.ReducedAudience,
		"drillScoped": res.DrillScoped,
		"suppressed":  res.Suppressed,
	})
}

// ── Arming ───────────────────────────────────────────────────────────────────

// OnIncidentOpen arms everything an incident needs the moment it exists. This
// runs on the control-plane request path and is budgeted at ≤20 ms (§2.6.1),
// so it writes rows and returns — it never waits on a notification.
func (e *Engine) OnIncidentOpen(ctx context.Context, inc store.Incident) (store.Incident, error) {
	now := e.now()

	// F-02: every incident gets a death date at birth.
	if inc.AutoQuiesceAt == 0 {
		inc.AutoQuiesceAt = now.Add(time.Duration(AutoQuiesceAfterS()) * time.Second).UnixMilli()
		if err := e.st.PutIncident(inc); err != nil {
			return inc, err
		}
	}
	e.arm(inc, ActionAutoQuiesce, 0, inc.AutoQuiesceAt)

	switch inc.State {
	case incident.StatePending:
		w := e.cancelWindowS(inc.Trigger)
		e.arm(inc, ActionCancelWindow, 0, now.Add(time.Duration(w)*time.Second).UnixMilli())
	case incident.StateProbe:
		s := afterSFor(incident.StateProbe, incident.EventProbeTimeout, 45)
		e.arm(inc, ActionProbeTimeout, 0, now.Add(time.Duration(s)*time.Second).UnixMilli())
	default:
		if isL1(inc.State) {
			// The device's own cancel window already expired offline; the
			// ladder starts now and the simultaneous blast goes out at T+0.
			e.armLadder(inc, now)
			if err := e.BlastL1(ctx, inc); err != nil {
				e.log.Error("l1_blast_failed", "incident", inc.ID, "err", err)
			}
			if fresh, ok := e.st.Incident(inc.ID); ok {
				inc = fresh
			}
		}
	}
	return inc, nil
}

// BlastL1 is T+0 of the ladder: FCM data + APNs + PushKit→CallKit + the socket
// frame, simultaneously (§2.6.2). ACTIVE_L1_SILENT takes the same path — a
// duress alarm is loud on every phone except the subject's own.
func (e *Engine) BlastL1(ctx context.Context, inc store.Incident) error {
	if !isL1(inc.State) {
		return nil
	}
	label := "L1"
	if inc.State == incident.StateActiveL1Silent {
		label = "L1-silent"
	}
	return e.notifyStep(ctx, inc, notify.Step{
		Tier: 1, Label: label,
		Channels: []notify.Channel{notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit},
	})
}

// LadderStep describes one published rung, for GET /v1/policies/current.
type LadderStep struct {
	AtS      int      `json:"atS"`
	Tier     int      `json:"tier"`
	Label    string   `json:"label"`
	Channels []string `json:"channels"`
}

// Ladder is the published shape of §2.6.2, measured from L1 entry. Devices
// cache this so an offline phone escalates on the same schedule the server
// would have used.
func Ladder() []LadderStep {
	return []LadderStep{
		{0, 1, "L1 simultaneous blast", []string{"ws", "fcm", "apns", "pushkit"}},
		{RepeatL1AfterS, 1, "repeat L1, louder", []string{"ws", "fcm", "apns", "pushkit"}},
		{SMSTierAfterS, 1, "SMS tier", []string{"sms"}},
		{L2AfterS(), 2, "L2 neighbours + relatives + voice", []string{"ws", "fcm", "apns", "pushkit", "voice"}},
		{L3AfterS(), 3, "L3 all voice calls + CALL 112", []string{"ws", "fcm", "apns", "pushkit", "sms", "voice"}},
	}
}

// CancelWindow exposes the effective cancel window for a trigger so devices and
// the policy endpoint agree with the timer this engine actually arms.
func (e *Engine) CancelWindow(trigger string) int { return e.cancelWindowS(trigger) }

// KnownTriggers lists the triggers this engine has a cancel-window policy for.
func KnownTriggers() []string {
	out := make([]string, 0, len(defaultCancelWindowS))
	for k := range defaultCancelWindowS {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// armLadder lays down the four rungs measured from L1 entry.
func (e *Engine) armLadder(inc store.Incident, from time.Time) {
	e.arm(inc, ActionRepeatL1, 1, from.Add(RepeatL1AfterS*time.Second).UnixMilli())
	e.arm(inc, ActionSMSTier, 1, from.Add(SMSTierAfterS*time.Second).UnixMilli())
	e.arm(inc, ActionEscalateL2, 2, from.Add(time.Duration(L2AfterS())*time.Second).UnixMilli())
	e.armL3(inc, from)
}

func (e *Engine) armL3(inc store.Incident, from time.Time) {
	e.arm(inc, ActionEscalateL3, 3, from.Add(time.Duration(L3AfterS())*time.Second).UnixMilli())
}

func (e *Engine) arm(inc store.Incident, action string, tier int, fireAt int64) {
	t := store.Timer{
		ID:            e.newID(),
		FamilyID:      inc.FamilyID,
		IncidentID:    inc.ID,
		Action:        action,
		TargetTier:    tier,
		PolicyVersion: inc.PolicyVersion,
		FireAt:        fireAt,
		State:         TimerPending,
		CreatedAt:     e.now().UnixMilli(),
	}
	if err := e.st.PutTimer(t); err != nil {
		e.log.Error("timer_arm_failed", "incident", inc.ID, "action", action, "err", err)
		return
	}
	e.log.Debug("timer_armed", "incident", inc.ID, "action", action,
		"in", time.Duration(fireAt-e.now().UnixMilli())*time.Millisecond)
}

// cancelTimers marks every pending timer for an incident cancelled. Passing
// keepAction retains one action (used when CLAIM halts the ladder but the
// auto-quiesce backstop must survive).
func (e *Engine) cancelTimers(incidentID string, keepAction string) {
	for _, t := range e.st.TimersForIncident(incidentID) {
		if t.State != TimerPending {
			continue
		}
		if keepAction != "" && t.Action == keepAction {
			continue
		}
		t.State = TimerCancelled
		if err := e.st.PutTimer(t); err != nil {
			e.log.Error("timer_cancel_failed", "timer", t.ID, "err", err)
		}
	}
}

func (e *Engine) cancelWindowS(trigger string) int {
	if e.cfg.CancelWindowS != nil {
		if v, ok := e.cfg.CancelWindowS[trigger]; ok {
			return v
		}
	}
	if v, ok := defaultCancelWindowS[trigger]; ok {
		return v
	}
	return 20
}

// ── Public transitions ───────────────────────────────────────────────────────

// Claim halts the ladder and broadcasts ownership. This is the single most
// important transition in the system: it converts "somebody should do
// something" into "Rohan is responding" (P-003).
func (e *Engine) Claim(ctx context.Context, incidentID, memberID string) (store.Incident, error) {
	inc, ok := e.st.Incident(incidentID)
	if !ok {
		return store.Incident{}, ErrIncidentNotFound
	}
	next, err := e.applyEvent(ctx, inc, incident.EventClaim, nil, map[string]any{"memberId": memberID})
	if err != nil {
		return inc, err
	}
	next.OwnerMemberID = memberID
	if next.FirstAckAt == 0 {
		next.FirstAckAt = e.now().UnixMilli() // t4
	}
	if err := e.st.PutIncident(next); err != nil {
		return next, err
	}

	// The ladder stops here. Auto-quiesce does not — a claimed incident that is
	// never resolved is exactly the F-02 case.
	e.cancelTimers(next.ID, ActionAutoQuiesce)
	e.arm(next, ActionWatchdog, 2, e.now().Add(time.Duration(WatchdogAfterS())*time.Second).UnixMilli())

	// Ownership goes out over the bus as CRITICAL. Everyone else's siren
	// becomes a persistent quiet banner — not silence (P-030 correction 1).
	e.publishIncident(next, "incident.claimed", notify.PriorityCritical, map[string]any{
		"ownerMemberId": memberID,
		"firstAckAt":    next.FirstAckAt,
	})

	// ★ W10-d · 1.32 ★ …and over push, because the bus only reaches sockets that
	// are open. §2.6.4: "Fan-out of CLAIM goes over BOTH channels simultaneously.
	// Never rely on only one; a backgrounded device may have no WS." The phone
	// with no socket is the phone still sirening for an incident somebody is
	// already driving to, and it is the one that most needs telling.
	//
	// Tier 1 because the ladder has STOPPED — this rung must not read as an
	// escalation in the after-action matrix — and no SMS or voice: spending the
	// family's notify budget to announce that nothing further is needed is how a
	// budget runs out before the incident that needs it.
	return next, e.notifyStep(ctx, next, notify.Step{
		Tier: 1, Label: "claim-broadcast", Kind: notify.KindClaimed,
		Channels: []notify.Channel{notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit},
	})
}

// Release gives ownership back and re-broadcasts, urgently.
func (e *Engine) Release(ctx context.Context, incidentID, memberID string) (store.Incident, error) {
	inc, ok := e.st.Incident(incidentID)
	if !ok {
		return store.Incident{}, ErrIncidentNotFound
	}
	next, err := e.applyEvent(ctx, inc, incident.EventRelease, nil, map[string]any{"memberId": memberID})
	if err != nil {
		return inc, err
	}
	next.OwnerMemberID = ""
	if err := e.st.PutIncident(next); err != nil {
		return next, err
	}
	e.cancelTimers(next.ID, ActionAutoQuiesce)
	e.armL3(next, e.now())
	e.publishIncident(next, "incident.released", notify.PriorityCritical, map[string]any{
		"previousOwnerMemberId": memberID,
	})
	return next, e.notifyStep(ctx, next, notify.Step{
		Tier: 2, Label: "released-rebroadcast", Kind: notify.KindReleased,
		Channels: []notify.Channel{notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit},
	})
}

// OnScene records that the owner has physically arrived.
func (e *Engine) OnScene(ctx context.Context, incidentID, memberID string) (store.Incident, error) {
	inc, ok := e.st.Incident(incidentID)
	if !ok {
		return store.Incident{}, ErrIncidentNotFound
	}
	next, err := e.applyEvent(ctx, inc, incident.EventOnScene, nil, map[string]any{"memberId": memberID})
	if err != nil {
		return inc, err
	}
	e.cancelTimers(next.ID, ActionAutoQuiesce)
	return next, nil
}

// Resolve is the second half of two-party resolution. The confirming member
// must not be the one who reported ON_SCENE: one person alone declaring an
// emergency over is how an emergency quietly stays unresolved.
func (e *Engine) Resolve(ctx context.Context, incidentID, memberID string) (store.Incident, error) {
	inc, ok := e.st.Incident(incidentID)
	if !ok {
		return store.Incident{}, ErrIncidentNotFound
	}
	if other := e.onSceneActor(incidentID); other != "" && other == memberID {
		return inc, ErrSameParty
	}
	next, err := e.applyEvent(ctx, inc, incident.EventTwoPartyConfirm, nil, map[string]any{"memberId": memberID})
	if err != nil {
		return inc, err
	}
	next.ResolvedAt = e.now().UnixMilli()
	if err := e.st.PutIncident(next); err != nil {
		return next, err
	}
	e.cancelTimers(next.ID, "")
	return next, nil
}

// SelfClear is the subject saying "it was me, I am fine" with their PIN.
func (e *Engine) SelfClear(ctx context.Context, incidentID, memberID string) (store.Incident, error) {
	inc, ok := e.st.Incident(incidentID)
	if !ok {
		return store.Incident{}, ErrIncidentNotFound
	}
	next, err := e.applyEvent(ctx, inc, incident.EventSelfClearPin, nil, map[string]any{"memberId": memberID})
	if err != nil {
		return inc, err
	}
	next.ResolvedAt = e.now().UnixMilli()
	if err := e.st.PutIncident(next); err != nil {
		return next, err
	}
	e.cancelTimers(next.ID, "")
	return next, nil
}

// Cancel handles the cancel window. duress=true takes the constant-time twin
// path: the UI is identical to a successful cancel, and the incident goes
// silently to ACTIVE_L1_SILENT instead of FALSE_ALARM.
func (e *Engine) Cancel(ctx context.Context, incidentID string, duress bool) (store.Incident, error) {
	inc, ok := e.st.Incident(incidentID)
	if !ok {
		return store.Incident{}, ErrIncidentNotFound
	}
	ev := incident.EventPinCorrect
	if duress {
		ev = incident.EventPinDuress
	}
	next, err := e.applyEvent(ctx, inc, ev, nil, nil)
	if err != nil {
		return inc, err
	}
	if duress {
		next.Duress = true
		if err := e.st.PutIncident(next); err != nil {
			return next, err
		}
		e.armLadder(next, e.now())
		return next, e.notifyStep(ctx, next, notify.Step{
			Tier: 1, Label: "L1-silent",
			Channels: []notify.Channel{notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit},
		})
	}
	e.cancelTimers(next.ID, "")
	return next, nil
}

// Reescalate implements P-058: a second SOS during an active incident does not
// open a second incident, it jumps the ladder immediately.
func (e *Engine) Reescalate(ctx context.Context, incidentID string) (store.Incident, error) {
	inc, ok := e.st.Incident(incidentID)
	if !ok {
		return store.Incident{}, ErrIncidentNotFound
	}
	next, err := e.applyEvent(ctx, inc, incident.EventReescalate, nil, nil)
	if err != nil {
		return inc, err
	}
	tier := 2
	if next.State == incident.StateActiveL3 {
		tier = 3
	}
	e.cancelTimers(next.ID, ActionAutoQuiesce)
	if tier == 2 {
		e.armL3(next, e.now())
	}
	return next, e.notifyStep(ctx, next, notify.Step{
		Tier: tier, Label: "reescalate",
		Channels: []notify.Channel{notify.ChannelWS, notify.ChannelFCM, notify.ChannelAPNs, notify.ChannelPushKit, notify.ChannelSMS},
	})
}

// Ack records that a recipient saw the alert without taking ownership. It does
// not halt the ladder — only a CLAIM does — but it is t4 for the four clocks.
func (e *Engine) Ack(ctx context.Context, incidentID, memberID string) (store.Incident, error) {
	inc, ok := e.st.Incident(incidentID)
	if !ok {
		return store.Incident{}, ErrIncidentNotFound
	}
	if inc.FirstAckAt == 0 {
		inc.FirstAckAt = e.now().UnixMilli()
		if err := e.st.PutIncident(inc); err != nil {
			return inc, err
		}
	}
	if err := e.appendInfo(inc, "ACK", map[string]any{"memberId": memberID}); err != nil {
		return inc, err
	}
	e.publishIncident(inc, "incident.acked", notify.PriorityCritical, map[string]any{
		"memberId": memberID, "firstAckAt": inc.FirstAckAt,
	})
	return inc, nil
}

// Apply is the generic escape hatch for events the control plane routes
// straight through (CONTEXT_ELEVATED, SENSOR_ANOMALY, USER_FINE, …).
func (e *Engine) Apply(ctx context.Context, incidentID string, ev incident.Event, guards incident.Guards, detail map[string]any) (store.Incident, error) {
	inc, ok := e.st.Incident(incidentID)
	if !ok {
		return store.Incident{}, ErrIncidentNotFound
	}
	return e.applyEvent(ctx, inc, ev, guards, detail)
}

// onSceneActor reads back who reported arrival, from the append-only log.
func (e *Engine) onSceneActor(incidentID string) string {
	for _, ev := range e.st.Events(incidentID) {
		if ev.EventType != string(incident.EventOnScene) {
			continue
		}
		if id, ok := ev.Detail["memberId"].(string); ok {
			return id
		}
	}
	return ""
}

// ── The one place a state changes ────────────────────────────────────────────

// applyEvent is the only function in this package that mutates incident.state.
// It appends first and projects second: incident.state is a materialised
// projection recomputable by folding the event log, so if it is ever wrong the
// log is what fixes it (§2.5.5).
func (e *Engine) applyEvent(ctx context.Context, inc store.Incident, ev incident.Event, guards incident.Guards, detail map[string]any) (store.Incident, error) {
	next, ok := incident.NextState(inc.State, ev, guards)
	if !ok {
		return inc, fmt.Errorf("%w: %s on %s", ErrInvalidTransition, ev, inc.State)
	}

	if detail == nil {
		detail = map[string]any{}
	}
	detail["from"] = string(inc.State)
	detail["to"] = string(next)

	now := e.now()
	row := store.Event{
		IncidentID: inc.ID,
		FamilyID:   inc.FamilyID,
		HLC:        e.hlc.next(now),
		EventType:  string(ev),
		// ★ P-069: every transition is stamped with the policy version that
		// produced it. Six months later, "why did it escalate at 90 seconds"
		// is answerable only if the row knows which policy was live.
		PolicyVersion:    inc.PolicyVersion,
		SourceTransport:  "server",
		ServerReceivedAt: now.UnixMilli(),
		LocalCreatedAt:   now.UnixMilli(),
		Detail:           detail,
	}
	if err := e.st.AppendEvent(row); err != nil {
		return inc, fmt.Errorf("append event: %w", err)
	}

	inc.State = next
	if incident.IsTerminal(next) && inc.ResolvedAt == 0 {
		inc.ResolvedAt = now.UnixMilli()
	}
	if err := e.st.PutIncident(inc); err != nil {
		return inc, fmt.Errorf("project state: %w", err)
	}

	// Entering L1 from the cancel window starts the ladder.
	if isL1(next) && (ev == incident.EventCancelWindowExpired) {
		e.armLadder(inc, now)
	}
	if incident.IsTerminal(next) {
		e.cancelTimers(inc.ID, "")
	}

	e.publishIncident(inc, "incident.state_changed", notify.PriorityCritical, map[string]any{
		"event": string(ev), "from": detail["from"], "to": string(next),
		"policyVersion": inc.PolicyVersion, "hlc": row.HLC,
	})
	e.log.Info("transition", "incident", inc.ID, "event", ev,
		"from", detail["from"], "to", next, "policyVersion", inc.PolicyVersion)
	return inc, nil
}

func (e *Engine) appendInfo(inc store.Incident, kind string, detail map[string]any) error {
	now := e.now()
	return e.st.AppendEvent(store.Event{
		IncidentID:       inc.ID,
		FamilyID:         inc.FamilyID,
		HLC:              e.hlc.next(now),
		EventType:        kind,
		PolicyVersion:    inc.PolicyVersion,
		SourceTransport:  "server",
		ServerReceivedAt: now.UnixMilli(),
		LocalCreatedAt:   now.UnixMilli(),
		Detail:           detail,
	})
}

func (e *Engine) publishIncident(inc store.Incident, kind string, prio notify.Priority, data map[string]any) {
	if data == nil {
		data = map[string]any{}
	}
	data["state"] = string(inc.State)
	data["trigger"] = inc.Trigger
	data["isDrill"] = inc.IsDrill
	f := notify.Frame{
		V: notify.FrameVersion, Type: kind, Priority: prio,
		FamilyID: inc.FamilyID, IncidentID: inc.ID,
		At: e.now().UnixMilli(), Data: data,
	}
	if err := e.bus.Publish(notify.StreamSubject(inc.FamilyID), f.Encode()); err != nil {
		e.log.Error("state_publish_failed", "incident", inc.ID, "type", kind, "err", err)
	}
	// Neighbours see the state machine move, never the sealed detail (F-20).
	rf := notify.Frame{
		V: notify.FrameVersion, Type: kind, Priority: prio,
		FamilyID: inc.FamilyID, IncidentID: inc.ID, At: f.At, Reduced: true,
		Data: map[string]any{
			"state": string(inc.State), "trigger": inc.Trigger,
			"coarseCell": inc.CoarseH3R7, "isDrill": inc.IsDrill,
		},
	}
	if err := e.bus.Publish(notify.ReducedSubject(inc.FamilyID), rf.Encode()); err != nil {
		e.log.Warn("reduced_state_publish_failed", "incident", inc.ID, "err", err)
	}
}

func (e *Engine) publishOps(kind, familyID string, data map[string]any) {
	f := notify.Frame{
		V: notify.FrameVersion, Type: kind, Priority: notify.PriorityCritical,
		FamilyID: familyID, At: e.now().UnixMilli(), Data: data,
	}
	if err := e.bus.Publish(notify.OpsSubject, f.Encode()); err != nil {
		e.log.Error("ops_publish_failed", "type", kind, "err", err)
	}
}

// ── HLC ──────────────────────────────────────────────────────────────────────

// hlcClock produces the 12-byte hybrid logical clock of §2.10.5: 48-bit
// physical ms ‖ 16-bit logical ‖ 32-bit node, hex-encoded. Timelines render
// from this; wall clock is only ever an annotation, because a phone with a
// wrong clock must not be able to reorder an incident.
type hlcClock struct {
	mu       sync.Mutex
	physical int64
	logical  uint16
	node     [4]byte
}

func (h *hlcClock) next(now time.Time) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	wall := now.UnixMilli()
	if wall > h.physical {
		h.physical = wall
		h.logical = 0
	} else {
		h.logical++
		if h.logical == 0 {
			h.physical++
		}
	}
	var b [12]byte
	p := uint64(h.physical)
	b[0] = byte(p >> 40)
	b[1] = byte(p >> 32)
	b[2] = byte(p >> 24)
	b[3] = byte(p >> 16)
	b[4] = byte(p >> 8)
	b[5] = byte(p)
	b[6] = byte(h.logical >> 8)
	b[7] = byte(h.logical)
	copy(b[8:], h.node[:])
	return hex.EncodeToString(b[:])
}
