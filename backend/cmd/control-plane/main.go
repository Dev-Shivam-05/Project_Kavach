// Command control-plane serves the coordination API of §9.2 — everything that
// is NOT on the survival path.
//
// The split matters: sos-ingest is a separate binary on a separate host with a
// separate deploy cadence, because the thing that must work when everything
// else is broken cannot share a process with the thing that renders after-
// action reports. This binary is allowed to be rich, and is allowed to be down.
//
// Blue-green friendly: /healthz reports readiness honestly, SIGTERM flips
// readiness off and drains before the listener closes, so nginx moves traffic
// to the other colour before this one stops accepting it.
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kavach/backend/internal/bus"
	"github.com/kavach/backend/internal/consent"
	"github.com/kavach/backend/internal/envelope"
	"github.com/kavach/backend/internal/escalation"
	"github.com/kavach/backend/internal/incident"
	"github.com/kavach/backend/internal/logx"
	"github.com/kavach/backend/internal/notify"
	"github.com/kavach/backend/internal/store"
)

// Bus subjects this binary owns. Journeys, check-ins and the incident→drill_run
// tie have no table in the store, so they are event-sourced onto the durable
// bus and projected into memory at boot. That is not a workaround: an
// append-only log plus a projection is the same shape the incident log already
// uses (§11.2), and it survives a restart exactly as well.
const (
	subjIncidentTie = "cp.incident_drill"
	subjJourney     = "cp.journey"
	subjCheckin     = "cp.checkin"
	subjConsentCur  = "cp.consent_cursor"
	subjAudit       = "cp.audit"

	// ★ D-026 ★ The incident leg. cmd/sos-ingest is the front door for an SOS
	// and publishes every accepted record on fam.{family}.incident; this binary
	// owns the escalation engine. Until W10-h nothing joined the two, so the
	// ladder was armed only for incidents opened through this binary's own HTTP
	// endpoint — which is not the path a person in trouble takes.
	//
	// Durable, because a control plane that is "allowed to be down" (see the
	// package comment) must climb the ladder for an incident that arrived while
	// it was: the cursor is persisted and StartAll replays what it missed.
	subjFamIncident  = "fam.*.incident"
	incidentsDurable = "control-plane.incidents"
)

func main() {
	var (
		addr      = flag.String("addr", env("KAVACH_CP_ADDR", ":8081"), "listen address")
		dataDir   = flag.String("data", env("KAVACH_DATA_DIR", "./data"), "store directory")
		busDir    = flag.String("bus", env("KAVACH_BUS_DIR", "./data/bus"), "bus directory")
		dev       = flag.Bool("dev", logx.Dev(), "developer logging")
		drainWait = flag.Duration("drain", envDur("KAVACH_DRAIN", 3*time.Second), "readiness drain before shutdown")
		workers   = flag.Int("workers", envInt("KAVACH_ESCALATION_WORKERS", 3), "escalation timer workers")
	)
	flag.Parse()

	log := logx.New(*dev)

	// Everything below the flags is wiring, and it lives in newServer so a test
	// can build the same graph without a process, a listener or a signal
	// handler. newServer logs the specific failure itself (D-026).
	srv, err := newServer(serverConfig{
		DataDir: *dataDir,
		BusDir:  *busDir,
		Workers: *workers,
		Token:   os.Getenv("KAVACH_API_TOKEN"),
		Log:     log,
	})
	if err != nil {
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Background work: durable timers and the consent surfacing job. Both are
	// safe to kill at any instant — that is the whole point of durable timers.
	bgCtx, bgCancel := context.WithCancel(context.Background())
	var bg sync.WaitGroup
	bg.Add(2)
	go func() { defer bg.Done(); srv.engine.Run(bgCtx) }()
	go func() { defer bg.Done(); srv.consent.RunSurfacing(bgCtx) }()

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           withCORS(srv.routes()),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		srv.ready.Store(true)
		log.Info("control_plane_listening", "addr", *addr, "data", *dataDir, "bus", *busDir)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen_failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()

	// Blue-green drain: stop answering readiness first, keep serving for
	// drainWait so the load balancer notices, then close the listener.
	srv.ready.Store(false)
	log.Info("draining", "for", *drainWait)
	time.Sleep(*drainWait)

	shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutCtx); err != nil {
		log.Error("shutdown_error", "err", err)
	}
	bgCancel()
	bg.Wait()
	// Drain the incident leg before the notifier closes under it: a rung armed
	// half-way through shutdown is worse than one armed by the next boot's
	// StartAll replay (D-026).
	if srv.incidents != nil {
		srv.incidents.Drain(2 * time.Second)
		srv.incidents.Close()
	}
	srv.notify.Close()
	if err := srv.st.Flush(); err != nil {
		log.Error("store_flush_failed", "err", err)
	}
	log.Info("stopped")
}

// serverConfig is what main's flags resolve to.
type serverConfig struct {
	DataDir string
	BusDir  string
	Workers int
	Token   string
	Log     *slog.Logger
}

// newServer opens the store and the bus, builds the notifier, the escalation
// engine and the consent service, and returns the assembled server. It is
// separate from main so the wiring is reachable from a test: cmd/control-plane
// had no test at all until D-026 needed one, and "does this binary subscribe to
// anything" is a question about the wiring, not about a handler.
func newServer(cfg serverConfig) (*server, error) {
	log := cfg.Log

	st, err := store.Open(cfg.DataDir)
	if err != nil {
		log.Error("store_open_failed", "dir", cfg.DataDir, "err", err)
		return nil, err
	}
	b, err := bus.Open(cfg.BusDir)
	if err != nil {
		log.Error("bus_open_failed", "dir", cfg.BusDir, "err", err)
		return nil, err
	}

	proj := newProjections()
	proj.restore(b, log)

	// ★ W10 — the push leg. ★ Absent credentials are NOT a startup failure: SMS
	// and the socket still work, and a control plane that refuses to boot rings
	// nobody at all. But it is logged at WARN with the variable to set, because
	// "no phone in this family can be reached with its app closed" is the single
	// most consequential fact about a running deployment and must never be
	// something an operator has to infer from silence.
	var push notify.PushSender
	if fcm, ferr := notify.NewFCMFromEnv(time.Now); ferr == nil {
		push = fcm
		log.Info("push_configured", "provider", "fcm")
	} else if errors.Is(ferr, notify.ErrPushNotConfigured) {
		log.Warn("push_not_configured",
			"impact", "a closed app cannot be alerted; SMS is the last leg to a human",
			"set", notify.EnvFCMCredentials)
	} else {
		log.Error("push_init_failed", "set", notify.EnvFCMCredentials, "err", ferr)
	}

	notifier, err := notify.New(notify.Deps{
		Store:  st,
		Bus:    b,
		Log:    log.With("mod", "notify"),
		Budget: notify.NewMemoryBudget(envInt("KAVACH_SMS_CEILING", notify.DefaultSMSCeiling), time.Now),
		Drills: &drillResolver{st: st, proj: proj},
		Push:   push,
		NewID:  newID,
	})
	if err != nil {
		log.Error("notify_init_failed", "err", err)
		return nil, err
	}

	engine, err := escalation.New(escalation.Deps{
		Store:  st,
		Bus:    b,
		Notify: notifier,
		Log:    log.With("mod", "escalation"),
		NewID:  newID,
		Config: escalation.Config{Workers: cfg.Workers, NodeID: nodeID()},
	})
	if err != nil {
		log.Error("escalation_init_failed", "err", err)
		return nil, err
	}

	cons, err := consent.New(consent.Deps{
		Store:       st,
		Publish:     b.Publish,
		Log:         log.With("mod", "consent"),
		NewID:       newID,
		LoadCursors: proj.consentCursors,
		SaveCursor:  func(familyID string, upTo int64) { proj.saveConsentCursor(b, familyID, upTo) },
	})
	if err != nil {
		log.Error("consent_init_failed", "err", err)
		return nil, err
	}

	srv := &server{
		log: log, st: st, bus: b, proj: proj,
		engine: engine, notify: notifier, consent: cons,
		token: cfg.Token,
		idem:  newIdemStore(),
	}

	// ★ D-026 ★ Subscribe LAST: the handler writes incidents and arms rungs, so
	// nothing may be delivered to it until the store, the notifier and the
	// engine above are all built.
	if srv.incidents, err = b.SubscribeDurable(incidentsDurable, subjFamIncident, bus.StartAll, srv.onIngestedIncident); err != nil {
		log.Error("incident_subscribe_failed", "durable", incidentsDurable, "err", err)
		return nil, err
	}
	return srv, nil
}

// ── The incident leg (D-026) ─────────────────────────────────────────────────

// ingestRecord is the subset of cmd/sos-ingest's `record` this binary reads off
// the bus. It is duplicated rather than imported: archlint forbids a cmd → cmd
// edge (I-12), and lifting the type into the kernel would change the WAL format
// of the one binary ADR-002 exists to leave alone. main_test.go pins these tags
// against the original's source text, so a rename there fails a test here rather
// than silently unarming the ladder.
type ingestRecord struct {
	Kind       string `json:"kind"`
	At         int64  `json:"at"`
	FamilyID   string `json:"family_id"`
	IncidentID string `json:"incident_id"`
	DeviceID   string `json:"device_id"`
	HLC        string `json:"hlc"`
	Transport  string `json:"transport"`
	EventType  string `json:"event_type,omitempty"`
	Flags      int64  `json:"flags"`
	Verified   bool   `json:"verified"`
	Body       string `json:"body"`
	Synthetic  bool   `json:"synthetic_from_sms,omitempty"`
}

// onIngestedIncident is the last arrow of Phase 1's trigger → transmit → notify
// → escalate. An SOS accepted by cmd/sos-ingest is projected into this binary's
// store and handed to the escalation engine, which is the only thing in the
// system that climbs L1 → L2 → L3.
//
// ★ It does NOT re-derive the ladder from the generated machine the way
// sos-ingest.armTimers does. The engine mints its own rungs with its own action
// names, which is the half of D-026 that action_routing_test.go measured: the
// projector's NO_ACK has no case in escalation.execute and never had one.
//
// Verification is not re-checked here. sos-ingest already decided, and ADR-018
// says a bad signature flags and proceeds — re-litigating that decision on this
// side could only ever turn an accepted alarm into a dropped one.
func (s *server) onIngestedIncident(m bus.Msg) error {
	if m.Kind != bus.KindIncidentOpen {
		return nil
	}
	var rec ingestRecord
	if err := json.Unmarshal(m.Data, &rec); err != nil {
		// Unparseable is not retryable. Five more attempts produce the same
		// bytes and then park a poison record in front of every other family's
		// incidents (bus.go: maxDeliveryAttempts, then dead-letter).
		s.log.Error("ingest_record_unparseable", "incident", m.IncidentID, "err", err)
		return nil
	}
	if rec.IncidentID == "" || rec.FamilyID == "" {
		s.log.Error("ingest_record_unaddressed", "seq", m.Seq)
		return nil
	}

	// Already fully projected? StartAll replays the whole retained stream at
	// every boot, and F-04 coalescing can publish one incident more than once.
	// engine.arm mints a fresh uuid per rung, so a second unguarded pass would
	// lay down a SECOND complete ladder — the mirror image of D-025, where
	// sos-ingest's derived ids made the same redelivery an overwrite instead.
	//
	// The guard is "has rungs", not "exists", for D-025's own reason: a pass
	// that died between PutIncident and OnIncidentOpen leaves an incident that
	// is recorded and unarmed, and treating that as done would strand exactly
	// the incident whose projection already went wrong once. Every incident the
	// engine has opened has at least the F-02 backstop.
	if cur, exists := s.st.Incident(rec.IncidentID); exists {
		if len(s.st.TimersForIncident(rec.IncidentID)) > 0 {
			return nil
		}
		s.log.Warn("ingest_incident_rearming", "incident", cur.ID, "state", string(cur.State))
		_, err := s.engine.OnIncidentOpen(context.Background(), cur)
		return err
	}

	env, _, err := envelope.Parse([]byte(rec.Body))
	if err != nil {
		s.log.Error("ingest_envelope_unparseable", "incident", rec.IncidentID, "err", err)
		return nil
	}
	if _, ok := s.st.Family(rec.FamilyID); !ok {
		// The same call cmd/sos-ingest's projector makes on the same question,
		// for the same reason: an unknown family has nobody to escalate to, and
		// retrying forever would stall the stream. It is WARN and not silence
		// because a family this binary has never heard of sending an SOS is an
		// operator's problem, and this binary is the one that creates families.
		s.log.Warn("ingest_incident_unknown_family", "family", rec.FamilyID, "incident", rec.IncidentID)
		return nil
	}

	inc := store.Incident{
		ID:               rec.IncidentID,
		FamilyID:         rec.FamilyID,
		SubjectMemberID:  env.MemberID,
		State:            s.initialState(env.Trigger, env.Duress, false),
		Trigger:          strings.ToUpper(env.Trigger),
		PolicyVersion:    int(env.PolicyVersion),
		Duress:           env.Duress,
		IsDrill:          env.IsDrill,
		CoarseH3R7:       env.CoarseCell,
		OpenedAt:         env.ClientTsMs,
		ServerReceivedAt: rec.At,
		ConfidencePct:    int(env.ConfidencePct),
		RiskContext:      int(env.RiskContext),
		SealedPayload:    env.SealedPayload,
		SyntheticFromSms: rec.Synthetic,
		Flags:            int(rec.Flags),
		Inc8:             inc8(rec.IncidentID),
	}
	if inc.OpenedAt == 0 {
		inc.OpenedAt = rec.At
	}
	if inc.PolicyVersion == 0 {
		inc.PolicyVersion = incident.SpecVersion
	}
	if err := s.st.PutIncident(inc); err != nil {
		// Retryable, and it must be: a store that is briefly unavailable may not
		// cost an incident its ladder.
		s.log.Error("ingest_incident_persist_failed", "incident", inc.ID, "err", err)
		return err
	}
	if _, err := s.engine.OnIncidentOpen(context.Background(), inc); err != nil {
		s.log.Error("ingest_incident_arm_failed", "incident", inc.ID, "err", err)
		return err
	}
	s.log.Info("ingest_incident_projected", "incident", inc.ID, "state", string(inc.State),
		"trigger", inc.Trigger, "verified", rec.Verified, "transport", rec.Transport)
	return nil
}

// ── Drill resolution (F-03) ──────────────────────────────────────────────────

// drillResolver answers "which drill run does this incident belong to". The
// incident row has no drill_run_id column, so the tie is a projection written
// by the same handler that created both.
type drillResolver struct {
	st   *store.Store
	proj *projections
}

func (d *drillResolver) DrillRunForIncident(incidentID string) (store.DrillRun, bool) {
	runID, ok := d.proj.drillRunFor(incidentID)
	if !ok {
		return store.DrillRun{}, false
	}
	for _, fam := range d.st.Families() {
		for _, r := range d.st.DrillRuns(fam.ID) {
			if r.ID == runID {
				return r, true
			}
		}
	}
	return store.DrillRun{}, false
}

// ── Projections ──────────────────────────────────────────────────────────────

type journeyRow struct {
	ID               string `json:"id"`
	FamilyID         string `json:"familyId"`
	MemberID         string `json:"memberId"`
	Label            string `json:"label"`
	OriginName       string `json:"originName"`
	DestName         string `json:"destName"`
	StartedAt        int64  `json:"startedAt"`
	EtaAt            int64  `json:"etaAt"`
	ArrivedAt        int64  `json:"arrivedAt"`
	State            string `json:"state"`
	CheckInIntervalS int    `json:"checkInIntervalS"`
	LastCheckInAt    int64  `json:"lastCheckInAt"`
}

type checkinRow struct {
	ID       string `json:"id"`
	FamilyID string `json:"familyId"`
	MemberID string `json:"memberId"`
	At       int64  `json:"at"`
	Note     string `json:"note"`
}

type incidentTie struct {
	IncidentID string `json:"incidentId"`
	DrillRunID string `json:"drillRunId"`
	At         int64  `json:"at"`
}

type cursorRow struct {
	FamilyID string `json:"familyId"`
	UpTo     int64  `json:"upTo"`
}

type projections struct {
	mu       sync.RWMutex
	drillTie map[string]string // incidentID → drillRunID
	journeys map[string]journeyRow
	checkins []checkinRow
	cursors  map[string]int64
}

func newProjections() *projections {
	return &projections{
		drillTie: map[string]string{},
		journeys: map[string]journeyRow{},
		cursors:  map[string]int64{},
	}
}

// restore rebuilds every projection by replaying the durable bus. Losing which
// drill an incident belonged to across a restart would silently break F-03, so
// this replay is not optional.
func (p *projections) restore(b *bus.Bus, log *slog.Logger) {
	start := time.Now()
	n := 0
	n += drain(b, subjIncidentTie, func(data []byte) {
		var t incidentTie
		if json.Unmarshal(data, &t) == nil && t.IncidentID != "" {
			p.drillTie[t.IncidentID] = t.DrillRunID
		}
	})
	n += drain(b, subjJourney, func(data []byte) {
		var j journeyRow
		if json.Unmarshal(data, &j) == nil && j.ID != "" {
			p.journeys[j.ID] = j
		}
	})
	n += drain(b, subjCheckin, func(data []byte) {
		var c checkinRow
		if json.Unmarshal(data, &c) == nil && c.ID != "" {
			p.checkins = append(p.checkins, c)
		}
	})
	n += drain(b, subjConsentCur, func(data []byte) {
		var c cursorRow
		if json.Unmarshal(data, &c) == nil && c.FamilyID != "" && c.UpTo > p.cursors[c.FamilyID] {
			p.cursors[c.FamilyID] = c.UpTo
		}
	})
	log.Info("projections_restored", "records", n, "tookMs", time.Since(start).Milliseconds())
}

// drain replays one subject to exhaustion. End of replay is detected by a short
// idle gap, which is reliable at boot because nothing else is writing yet.
func drain(b *bus.Bus, subject string, fn func([]byte)) int {
	ch, cancel := b.Subscribe(subject, 0)
	defer cancel()
	idle := 200 * time.Millisecond
	t := time.NewTimer(idle)
	defer t.Stop()
	n := 0
	for {
		select {
		case m, ok := <-ch:
			if !ok {
				return n
			}
			fn(m.Data)
			n++
			if !t.Stop() {
				select {
				case <-t.C:
				default:
				}
			}
			t.Reset(idle)
		case <-t.C:
			return n
		}
	}
}

func (p *projections) tieIncidentToDrill(b *bus.Bus, incidentID, drillRunID string) {
	p.mu.Lock()
	p.drillTie[incidentID] = drillRunID
	p.mu.Unlock()
	if data, err := json.Marshal(incidentTie{incidentID, drillRunID, time.Now().UnixMilli()}); err == nil {
		_ = b.Publish(subjIncidentTie, data)
	}
}

func (p *projections) drillRunFor(incidentID string) (string, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	id, ok := p.drillTie[incidentID]
	return id, ok
}

func (p *projections) putJourney(b *bus.Bus, j journeyRow) {
	p.mu.Lock()
	p.journeys[j.ID] = j
	p.mu.Unlock()
	if data, err := json.Marshal(j); err == nil {
		_ = b.Publish(subjJourney, data)
	}
}

func (p *projections) journey(id string) (journeyRow, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	j, ok := p.journeys[id]
	return j, ok
}

func (p *projections) allJourneys(familyID string) []journeyRow {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := []journeyRow{}
	for _, j := range p.journeys {
		if familyID == "" || j.FamilyID == familyID {
			out = append(out, j)
		}
	}
	sort.Slice(out, func(i, j2 int) bool { return out[i].StartedAt > out[j2].StartedAt })
	return out
}

func (p *projections) putCheckin(b *bus.Bus, c checkinRow) {
	p.mu.Lock()
	p.checkins = append(p.checkins, c)
	p.mu.Unlock()
	if data, err := json.Marshal(c); err == nil {
		_ = b.Publish(subjCheckin, data)
	}
}

func (p *projections) consentCursors() map[string]int64 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := map[string]int64{}
	for k, v := range p.cursors {
		out[k] = v
	}
	return out
}

func (p *projections) saveConsentCursor(b *bus.Bus, familyID string, upTo int64) {
	p.mu.Lock()
	p.cursors[familyID] = upTo
	p.mu.Unlock()
	if data, err := json.Marshal(cursorRow{familyID, upTo}); err == nil {
		_ = b.Publish(subjConsentCur, data)
	}
}

// ── Server ───────────────────────────────────────────────────────────────────

type server struct {
	log     *slog.Logger
	st      *store.Store
	bus     *bus.Bus
	proj    *projections
	engine  *escalation.Engine
	notify  *notify.Notifier
	consent *consent.Service
	// incidents is the durable subscription on fam.*.incident (D-026).
	incidents *bus.Sub
	token     string
	idem      *idemStore
	ready     atomicBool
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.health)
	mux.HandleFunc("OPTIONS /", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })

	mux.HandleFunc("GET /v1/family", s.auth(s.getFamily))

	mux.HandleFunc("GET /v1/incidents", s.auth(s.listIncidents))
	mux.HandleFunc("POST /v1/incidents", s.auth(s.idempotent(s.openIncident)))
	mux.HandleFunc("GET /v1/incidents/{id}", s.auth(s.getIncident))
	mux.HandleFunc("POST /v1/incidents/{id}/claim", s.auth(s.idempotent(s.claim)))
	mux.HandleFunc("POST /v1/incidents/{id}/release", s.auth(s.idempotent(s.release)))
	mux.HandleFunc("POST /v1/incidents/{id}/onscene", s.auth(s.idempotent(s.onScene)))
	mux.HandleFunc("POST /v1/incidents/{id}/resolve", s.auth(s.resolve))
	mux.HandleFunc("POST /v1/incidents/{id}/classify", s.auth(s.idempotent(s.classify)))
	mux.HandleFunc("POST /v1/incidents/{id}/cancel", s.auth(s.idempotent(s.cancel)))
	mux.HandleFunc("POST /v1/incidents/{id}/reescalate", s.auth(s.idempotent(s.reescalate)))
	mux.HandleFunc("POST /v1/incidents/{id}/ack", s.auth(s.idempotent(s.ack)))
	mux.HandleFunc("GET /v1/incidents/{id}/after-action", s.auth(s.afterAction))

	mux.HandleFunc("GET /v1/policies/current", s.auth(s.policies))

	mux.HandleFunc("GET /v1/consents", s.auth(s.listConsents))
	mux.HandleFunc("POST /v1/consents", s.auth(s.idempotent(s.createConsent)))
	mux.HandleFunc("POST /v1/consents/check", s.auth(s.checkConsent))
	mux.HandleFunc("DELETE /v1/consents/{id}", s.auth(s.revokeConsent))
	mux.HandleFunc("GET /v1/consents/access-log", s.auth(s.accessLog))

	mux.HandleFunc("GET /v1/journeys", s.auth(s.listJourneys))
	mux.HandleFunc("POST /v1/journeys", s.auth(s.idempotent(s.startJourney)))
	mux.HandleFunc("PATCH /v1/journeys/{id}", s.auth(s.patchJourney))
	mux.HandleFunc("POST /v1/checkins", s.auth(s.idempotent(s.checkin)))
	mux.HandleFunc("POST /v1/find-phone/{id}", s.auth(s.findPhone))

	mux.HandleFunc("GET /v1/drills", s.auth(s.listDrills))
	mux.HandleFunc("POST /v1/drills", s.auth(s.idempotent(s.startDrill)))

	mux.HandleFunc("GET /v1/devices", s.auth(s.listDevices))
	mux.HandleFunc("POST /v1/devices", s.auth(s.idempotent(s.enrolDevice)))
	mux.HandleFunc("PATCH /v1/devices/{id}", s.auth(s.patchDevice))
	mux.HandleFunc("POST /v1/devices/{id}/heartbeat", s.auth(s.heartbeat))

	mux.HandleFunc("POST /v1/rt/ticket", s.auth(s.mintTicket))

	mux.HandleFunc("GET /internal/active-incidents", s.activeIncidents)

	return mux
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	if !s.ready.Load() {
		// Draining, or not yet warm. Blue-green depends on this answer being
		// honest — a green health check on a draining instance loses requests.
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "draining"})
		return
	}
	fired, skipped, overdue, failed, lastPoll := s.engine.Stats()
	backlog, oldest, stalled, surfaced := s.consent.Health()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"service": "control-plane",
		"escalation": map[string]any{
			"timersFired": fired, "timersSkipped": skipped,
			"timersOverdue": overdue, "timersFailed": failed, "lastPollAt": lastPoll,
		},
		"consentSurfacing": map[string]any{
			"backlog": backlog, "oldestUnsurfacedAt": oldest,
			"stalled": stalled, "surfacedTotal": surfaced,
		},
	})
}

// ── Family / devices ─────────────────────────────────────────────────────────

func (s *server) getFamily(w http.ResponseWriter, r *http.Request) {
	famID := s.familyID(r)
	fam, ok := s.st.Family(famID)
	if !ok {
		problem(w, http.StatusNotFound, "KV-1006", "unknown family", famID)
		return
	}
	devices := s.st.Devices(famID)

	now := time.Now().UnixMilli()
	healthy, silent := 0, 0
	for _, d := range devices {
		// §2.11.4: one family member's agent silently dead for hours is worth
		// more than every other metric combined, so it is a first-class field
		// of the family view rather than something buried in diagnostics.
		if d.AgentHealthy && d.LastHeartbeatAt > 0 && now-d.LastHeartbeatAt < 6*60*60*1000 {
			healthy++
		} else {
			silent++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"family":  fam,
		"members": s.st.Members(famID),
		"devices": devices,
		"health": map[string]any{
			"devicesHealthy":  healthy,
			"devicesSilent":   silent,
			"activeIncidents": len(s.st.ActiveIncidents(famID)),
		},
	})
}

func (s *server) listDevices(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"devices": s.st.Devices(s.familyID(r))})
}

type deviceReq struct {
	ID             string `json:"id"`
	MemberID       string `json:"memberId"`
	Platform       string `json:"platform"`
	Model          string `json:"model"`
	SigningPubkey  string `json:"signingPubkey"`
	IdentityPubkey string `json:"identityPubkey"`
	IsDeviceOwner  bool   `json:"isDeviceOwner"`
	BatteryPct     int    `json:"batteryPct"`
	AgentHealthy   *bool  `json:"agentHealthy"`
	Revoked        bool   `json:"revoked"`
	// PushTokenFCM is a POINTER so that "the client did not mention the token"
	// and "the client is telling me the token is gone" are different requests.
	// A plain string would make every PATCH that omits it silently erase the one
	// address the family can be reached at with the app closed (W10).
	PushTokenFCM *string `json:"pushTokenFcm"`
}

func (s *server) enrolDevice(w http.ResponseWriter, r *http.Request) {
	var in deviceReq
	if !readJSON(w, r, &in) {
		return
	}
	if in.MemberID == "" || in.SigningPubkey == "" {
		problem(w, http.StatusBadRequest, "KV-1001", "memberId and signingPubkey are required", "")
		return
	}
	if in.ID == "" {
		in.ID = uuidv7()
	}
	d := store.Device{
		ID: in.ID, FamilyID: s.familyID(r), MemberID: in.MemberID,
		Platform: in.Platform, Model: in.Model,
		SigningPubkey: in.SigningPubkey, IdentityPubkey: in.IdentityPubkey,
		IsDeviceOwner: in.IsDeviceOwner, AgentHealthy: true,
		LastHeartbeatAt: time.Now().UnixMilli(),
	}
	if in.PushTokenFCM != nil {
		d.PushTokenFCM = strings.TrimSpace(*in.PushTokenFCM)
	}
	if err := s.st.PutDevice(d); err != nil {
		problem(w, http.StatusBadRequest, "KV-1006", err.Error(), d.FamilyID)
		return
	}
	// sos-ingest holds device public keys in an in-memory cache refreshed on
	// this event; without it a brand-new device's first SOS is flagged
	// UNVERIFIED (ADR-018 fails open, but verified is better).
	s.publishOps("device.key.changed", d.FamilyID, map[string]any{
		"deviceId": d.ID, "memberId": d.MemberID, "signingPubkey": d.SigningPubkey,
	})
	writeJSON(w, http.StatusCreated, d)
}

func (s *server) patchDevice(w http.ResponseWriter, r *http.Request) {
	d, ok := s.st.Device(r.PathValue("id"))
	if !ok {
		problem(w, http.StatusNotFound, "KV-1011", "unknown device", r.PathValue("id"))
		return
	}
	var in deviceReq
	if !readJSON(w, r, &in) {
		return
	}
	if in.Platform != "" {
		d.Platform = in.Platform
	}
	if in.Model != "" {
		d.Model = in.Model
	}
	if in.SigningPubkey != "" {
		d.SigningPubkey = in.SigningPubkey
	}
	if in.IdentityPubkey != "" {
		d.IdentityPubkey = in.IdentityPubkey
	}
	if in.AgentHealthy != nil {
		d.AgentHealthy = *in.AgentHealthy
	}
	// ★ W10 — this is how a phone becomes reachable with the app closed. ★
	// The client re-PATCHes on every boot and whenever FCM rolls the token, so
	// this is the hot path for push reachability, not a one-off enrolment step.
	// An empty string is an accepted value: it is what a device sends when the
	// user revokes POST_NOTIFICATIONS, and recording that honestly is what makes
	// the delivery matrix say "unreachable by push" instead of silently trying a
	// dead address.
	if in.PushTokenFCM != nil {
		d.PushTokenFCM = strings.TrimSpace(*in.PushTokenFCM)
	}
	if in.Revoked {
		d.RevokedAt = time.Now().UnixMilli()
		// A revoked device is a lost phone or a member who left. Its push address
		// goes with it: leaving the token behind would keep a stranger's handset
		// on the family's alert fan-out (§2.4 device revocation).
		d.PushTokenFCM = ""
	}
	if err := s.st.PutDevice(d); err != nil {
		problem(w, http.StatusServiceUnavailable, "KV-5001", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *server) heartbeat(w http.ResponseWriter, r *http.Request) {
	d, ok := s.st.Device(r.PathValue("id"))
	if !ok {
		problem(w, http.StatusNotFound, "KV-1011", "unknown device", r.PathValue("id"))
		return
	}
	var in struct {
		BatteryPct  int   `json:"batteryPct"`
		Degradation int   `json:"degradationLevel"`
		Healthy     *bool `json:"agentHealthy"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	now := time.Now().UnixMilli()
	d.LastHeartbeatAt = now
	d.BatteryPct = in.BatteryPct
	d.AgentHealthy = true
	if in.Healthy != nil {
		d.AgentHealthy = *in.Healthy
	}
	if err := s.st.PutDevice(d); err != nil {
		problem(w, http.StatusServiceUnavailable, "KV-5001", err.Error(), "")
		return
	}
	f := notify.Frame{
		V: notify.FrameVersion, Type: "device.health_changed", Priority: notify.PriorityHigh,
		Key: "dev:" + d.ID, FamilyID: d.FamilyID, At: now,
		Data: map[string]any{
			"deviceId": d.ID, "batteryPct": d.BatteryPct,
			"agentHealthy": d.AgentHealthy, "degradationLevel": in.Degradation,
		},
	}
	_ = s.bus.Publish(notify.StreamSubject(d.FamilyID), f.Encode())
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "at": now})
}

// ── Incidents ────────────────────────────────────────────────────────────────

func (s *server) listIncidents(w http.ResponseWriter, r *http.Request) {
	famID := s.familyID(r)
	incs := s.st.Incidents(famID)
	if r.URL.Query().Get("activeOnly") == "1" {
		incs = s.st.ActiveIncidents(famID)
	}
	if state := r.URL.Query().Get("state"); state != "" {
		var f []store.Incident
		for _, i := range incs {
			if string(i.State) == state {
				f = append(f, i)
			}
		}
		incs = f
	}
	sort.Slice(incs, func(i, j int) bool { return incs[i].OpenedAt > incs[j].OpenedAt })
	if incs == nil {
		incs = []store.Incident{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"incidents": incs})
}

type openIncidentReq struct {
	ID              string `json:"id"`
	SubjectMemberID string `json:"subjectMemberId"`
	Trigger         string `json:"trigger"`
	ConfidencePct   int    `json:"confidencePct"`
	RiskContext     int    `json:"riskContext"`
	Duress          bool   `json:"duress"`
	IsDrill         bool   `json:"isDrill"`
	DrillRunID      string `json:"drillRunId"`
	PolicyVersion   int    `json:"policyVersion"`
	CoarseH3R7      string `json:"coarseH3R7"`
	SealedPayload   string `json:"sealedPayload"`
	// SkipCancelWindow is set by a client whose own cancel window already
	// elapsed offline, so the server does not restart it.
	SkipCancelWindow bool `json:"skipCancelWindow"`
}

// openIncident is the control plane's incident-open path. The critical path
// lives in sos-ingest (protobuf, signed envelope, no DB read on the request
// path); this JSON door exists for clients already holding a session — and for
// the canary, which must drive the real handler rather than a mock (§16.2).
func (s *server) openIncident(w http.ResponseWriter, r *http.Request) {
	var in openIncidentReq
	if !readJSON(w, r, &in) {
		return
	}
	famID := s.familyID(r)
	if _, ok := s.st.Family(famID); !ok {
		// F-04: no family means nobody to help. Drop at the edge rather than
		// fanning out into the void.
		problem(w, http.StatusNotFound, "KV-1006", "unknown family", famID)
		return
	}
	if in.ID == "" {
		in.ID = uuidv7()
	}
	// KV-1003: a duplicate incident id is success, not an error. The client
	// generated it precisely so a retry over a second transport is idempotent.
	if existing, ok := s.st.Incident(in.ID); ok {
		writeJSON(w, http.StatusOK, map[string]any{"incident": existing, "duplicate": true})
		return
	}
	if in.Trigger == "" {
		in.Trigger = "MANUAL"
	}
	if in.PolicyVersion == 0 {
		in.PolicyVersion = incident.SpecVersion
	}
	if in.SubjectMemberID == "" {
		if ms := s.st.Members(famID); len(ms) > 0 {
			in.SubjectMemberID = ms[0].ID
		}
	}

	now := time.Now()
	state := s.initialState(in.Trigger, in.Duress, in.SkipCancelWindow)

	inc := store.Incident{
		ID:               in.ID,
		FamilyID:         famID,
		SubjectMemberID:  in.SubjectMemberID,
		State:            state,
		Trigger:          strings.ToUpper(in.Trigger),
		PolicyVersion:    in.PolicyVersion,
		Duress:           in.Duress,
		IsDrill:          in.IsDrill,
		CoarseH3R7:       in.CoarseH3R7,
		OpenedAt:         now.UnixMilli(),
		ServerReceivedAt: now.UnixMilli(),
		ConfidencePct:    in.ConfidencePct,
		RiskContext:      in.RiskContext,
		SealedPayload:    in.SealedPayload,
		Inc8:             inc8(in.ID),
	}
	if err := s.st.PutIncident(inc); err != nil {
		problem(w, http.StatusServiceUnavailable, "KV-5001", "could not persist incident", err.Error())
		return
	}
	// ★ F-03 ★ Tie the incident to its drill run BEFORE anything can fan out.
	// If this ordering is wrong the notifier cannot prove the audience and —
	// correctly, fail-closed — notifies nobody, turning a canary run into a
	// page instead of turning a canary run into 96 ringing phones.
	if in.IsDrill && in.DrillRunID != "" {
		s.proj.tieIncidentToDrill(s.bus, inc.ID, in.DrillRunID)
	}

	inc, err := s.engine.OnIncidentOpen(r.Context(), inc)
	if err != nil {
		s.log.Error("incident_open_arm_failed", "incident", inc.ID, "err", err)
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"incident":   inc,
		"serverTsMs": time.Now().UnixMilli(),
	})
}

// initialState is the one rule for the state an incident opens in, shared by the
// HTTP front door above and the bus leg below so that the two cannot drift.
//
// DURESS wins outright and skips the window: a silent alarm that sat in a cancel
// window would be a cancel window the person standing over the victim can watch
// tick down (§7.5). Otherwise the server arms its own copy of the device's
// window — not because the device is untrusted, but because the device may be
// underwater by the time it would have expired (defaultCancelWindowS, §2.5.6).
func (s *server) initialState(trigger string, duress, skipCancelWindow bool) incident.State {
	if duress {
		return incident.StateActiveL1Silent
	}
	if skipCancelWindow || s.engine.CancelWindow(strings.ToUpper(trigger)) == 0 {
		return incident.StateActiveL1
	}
	return incident.StatePending
}

func (s *server) getIncident(w http.ResponseWriter, r *http.Request) {
	inc, ok := s.st.Incident(r.PathValue("id"))
	if !ok {
		problem(w, http.StatusNotFound, "KV-1007", "unknown incident", r.PathValue("id"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"incident": inc,
		"events":   s.st.Events(inc.ID),
	})
}

type actorReq struct {
	MemberID string `json:"memberId"`
	Note     string `json:"note"`
	Outcome  string `json:"outcome"`
	Duress   bool   `json:"duress"`
}

func (s *server) claim(w http.ResponseWriter, r *http.Request) {
	s.transition(w, r, func(id string, in actorReq) (store.Incident, error) {
		return s.engine.Claim(r.Context(), id, in.MemberID)
	})
}

func (s *server) release(w http.ResponseWriter, r *http.Request) {
	s.transition(w, r, func(id string, in actorReq) (store.Incident, error) {
		return s.engine.Release(r.Context(), id, in.MemberID)
	})
}

func (s *server) onScene(w http.ResponseWriter, r *http.Request) {
	s.transition(w, r, func(id string, in actorReq) (store.Incident, error) {
		return s.engine.OnScene(r.Context(), id, in.MemberID)
	})
}

// resolve advances whichever half of the resolution the incident is waiting
// for. ON_SCENE and TWO_PARTY_CONFIRM must come from two different people, or
// an emergency can be declared over by the one person standing in the middle
// of it.
func (s *server) resolve(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in actorReq
	if !readJSON(w, r, &in) {
		return
	}
	inc, ok := s.st.Incident(id)
	if !ok {
		problem(w, http.StatusNotFound, "KV-1007", "unknown incident", id)
		return
	}
	var err error
	switch inc.State {
	case incident.StateOwned:
		inc, err = s.engine.OnScene(r.Context(), id, in.MemberID)
	case incident.StateResolving:
		inc, err = s.engine.Resolve(r.Context(), id, in.MemberID)
	case incident.StateActiveL1, incident.StateActiveL2, incident.StateActiveL3:
		inc, err = s.engine.SelfClear(r.Context(), id, in.MemberID)
	default:
		problem(w, http.StatusConflict, "KV-1008",
			"incident cannot be resolved from this state", string(inc.State))
		return
	}
	if errors.Is(err, escalation.ErrSameParty) {
		problem(w, http.StatusConflict, "KV-1009",
			"two-party resolution requires a second member to confirm", in.MemberID)
		return
	}
	if err != nil {
		problem(w, http.StatusConflict, "KV-1008", err.Error(), string(inc.State))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"incident": inc})
}

func (s *server) cancel(w http.ResponseWriter, r *http.Request) {
	s.transition(w, r, func(id string, in actorReq) (store.Incident, error) {
		// Which PIN was entered is decided on-device; the server never sees a
		// PIN and learns nothing beyond this boolean, which is why both paths
		// cost the same on the wire.
		return s.engine.Cancel(r.Context(), id, in.Duress)
	})
}

func (s *server) reescalate(w http.ResponseWriter, r *http.Request) {
	s.transition(w, r, func(id string, in actorReq) (store.Incident, error) {
		return s.engine.Reescalate(r.Context(), id)
	})
}

func (s *server) ack(w http.ResponseWriter, r *http.Request) {
	s.transition(w, r, func(id string, in actorReq) (store.Incident, error) {
		return s.engine.Ack(r.Context(), id, in.MemberID)
	})
}

func (s *server) transition(w http.ResponseWriter, r *http.Request, fn func(string, actorReq) (store.Incident, error)) {
	var in actorReq
	if !readJSON(w, r, &in) {
		return
	}
	inc, err := fn(r.PathValue("id"), in)
	switch {
	case errors.Is(err, escalation.ErrIncidentNotFound):
		problem(w, http.StatusNotFound, "KV-1007", "unknown incident", r.PathValue("id"))
	case errors.Is(err, escalation.ErrInvalidTransition):
		problem(w, http.StatusConflict, "KV-1008", err.Error(), string(inc.State))
	case err != nil:
		problem(w, http.StatusInternalServerError, "KV-5001", err.Error(), "")
	default:
		writeJSON(w, http.StatusOK, map[string]any{"incident": inc})
	}
}

func (s *server) classify(w http.ResponseWriter, r *http.Request) {
	var in actorReq
	if !readJSON(w, r, &in) {
		return
	}
	inc, ok := s.st.Incident(r.PathValue("id"))
	if !ok {
		problem(w, http.StatusNotFound, "KV-1007", "unknown incident", r.PathValue("id"))
		return
	}
	outcome := strings.ToLower(in.Outcome)
	switch outcome {
	case "real", "false_alarm", "drill", "unknown":
	default:
		problem(w, http.StatusBadRequest, "KV-1001", "outcome must be real|false_alarm|drill|unknown", outcome)
		return
	}
	if inc.IsDrill {
		// F-03: drills are excluded from the False Positive Ledger and from
		// NFR-008 accounting. Ninety-six canary runs a day would otherwise bury
		// the one real false positive the tuning loop needs to see.
		outcome = "drill"
	}
	inc.Outcome = outcome
	inc.OutcomeNote = in.Note
	if err := s.st.PutIncident(inc); err != nil {
		problem(w, http.StatusServiceUnavailable, "KV-5001", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"incident":                     inc,
		"countedInFalsePositiveLedger": !inc.IsDrill,
	})
}

// afterAction is the timeline plus the four clocks plus the notification
// matrix. It is what turns "it worked" into "it worked, and here is which leg
// was slow".
func (s *server) afterAction(w http.ResponseWriter, r *http.Request) {
	inc, ok := s.st.Incident(r.PathValue("id"))
	if !ok {
		problem(w, http.StatusNotFound, "KV-1007", "unknown incident", r.PathValue("id"))
		return
	}
	events := s.st.Events(inc.ID)
	notes := s.st.Notifications(inc.ID)
	deliveries := []store.Delivery{}
	for _, n := range notes {
		deliveries = append(deliveries, s.st.Deliveries(n.ID)...)
	}

	clocks := fourClocks(inc, events)
	writeJSON(w, http.StatusOK, map[string]any{
		"incident": inc,
		"timeline": events,
		"clocks":   clocks,
		"deltas": map[string]any{
			"t1MinusT0Ms": delta(clocks["t0TriggerAt"], clocks["t1ConfirmedAt"]),
			"t2MinusT1Ms": delta(clocks["t1ConfirmedAt"], clocks["t2FirstTransmitAt"]),
			"t3MinusT2Ms": delta(clocks["t2FirstTransmitAt"], clocks["t3FirstNotifiedAt"]),
			"t4MinusT3Ms": delta(clocks["t3FirstNotifiedAt"], clocks["t4FirstAckAt"]),
		},
		"notifications": notes,
		"deliveries":    deliveries,
	})
}

func fourClocks(inc store.Incident, events []store.Event) map[string]int64 {
	c := map[string]int64{
		"t0TriggerAt":       inc.OpenedAt,
		"t1ConfirmedAt":     0,
		"t2FirstTransmitAt": inc.ServerReceivedAt,
		"t3FirstNotifiedAt": inc.FirstNotifiedAt,
		"t4FirstAckAt":      inc.FirstAckAt,
	}
	for _, ev := range events {
		// t2: the first moment the server saw any byte of this incident. The
		// device-side leg (t0→t2) is measured on-device and uploaded as an
		// event; this is the server's honest lower bound for it.
		if ev.ServerReceivedAt > 0 && (c["t2FirstTransmitAt"] == 0 || ev.ServerReceivedAt < c["t2FirstTransmitAt"]) {
			c["t2FirstTransmitAt"] = ev.ServerReceivedAt
		}
		// t1: confirmation is the moment the machine committed to escalating.
		if c["t1ConfirmedAt"] == 0 {
			if to, ok := ev.Detail["to"].(string); ok && strings.HasPrefix(to, "ACTIVE_") {
				c["t1ConfirmedAt"] = ev.ServerReceivedAt
			}
		}
	}
	if c["t1ConfirmedAt"] == 0 && strings.HasPrefix(string(inc.State), "ACTIVE_") {
		c["t1ConfirmedAt"] = inc.OpenedAt
	}
	return c
}

func delta(a, b int64) int64 {
	if a == 0 || b == 0 {
		return -1 // leg not reached; -1 is unambiguous where 0 would lie
	}
	return b - a
}

// ── Policy ───────────────────────────────────────────────────────────────────

func (s *server) policies(w http.ResponseWriter, r *http.Request) {
	windows := map[string]int{}
	for _, t := range escalation.KnownTriggers() {
		windows[t] = s.engine.CancelWindow(t)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version":         incident.SpecVersion,
		"ladder":          escalation.Ladder(),
		"cancelWindowS":   windows,
		"autoQuiesceS":    escalation.AutoQuiesceAfterS(),
		"watchdogS":       escalation.WatchdogAfterS(),
		"neighboursNever": []string{"GEOFENCE", "DEVICE_SILENCED", "DEADMAN"},
	})
}

// ── Consent ──────────────────────────────────────────────────────────────────

func (s *server) listConsents(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"grants":        s.consent.Grants(s.familyID(r)),
		"maxGrantHours": consent.MaxGrantHours,
	})
}

func (s *server) createConsent(w http.ResponseWriter, r *http.Request) {
	var in consent.GrantRequest
	if !readJSON(w, r, &in) {
		return
	}
	in.FamilyID = s.familyID(r)
	if in.GrantorMemberID == "" {
		in.GrantorMemberID = s.memberID(r)
	}
	g, err := s.consent.Grant(in)
	if err != nil {
		problem(w, http.StatusBadRequest, "KV-2004", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusCreated, g)
}

func (s *server) revokeConsent(w http.ResponseWriter, r *http.Request) {
	if err := s.consent.Revoke(s.familyID(r), r.PathValue("id")); err != nil {
		problem(w, http.StatusNotFound, "KV-2001", err.Error(), r.PathValue("id"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": r.PathValue("id")})
}

func (s *server) checkConsent(w http.ResponseWriter, r *http.Request) {
	var in consent.CheckRequest
	if !readJSON(w, r, &in) {
		return
	}
	in.FamilyID = s.familyID(r)
	if in.AccessorMemberID == "" {
		in.AccessorMemberID = s.memberID(r)
	}
	if !in.IncidentActive {
		// An incident_only grant is inert unless something is actually
		// happening, so the caller does not get to assert that for itself.
		in.IncidentActive = len(s.st.ActiveIncidents(in.FamilyID)) > 0
	}
	d, err := s.consent.Check(r.Context(), in)
	if err != nil {
		problem(w, http.StatusServiceUnavailable, "KV-5001",
			"access could not be logged, so the read was refused", err.Error())
		return
	}
	if !d.Allowed {
		code := "KV-2001"
		if d.Reason == consent.ReasonPurposeMismatch {
			code = "KV-2002"
		}
		writeProblem(w, http.StatusForbidden, code, string(d.Reason), map[string]any{"decision": d})
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *server) accessLog(w http.ResponseWriter, r *http.Request) {
	rows := s.consent.AccessLog(s.familyID(r))
	if subject := r.URL.Query().Get("subjectMemberId"); subject != "" {
		f := []store.Access{}
		for _, a := range rows {
			if a.SubjectMemberID == subject {
				f = append(f, a)
			}
		}
		rows = f
	}
	backlog, oldest, stalled, _ := s.consent.Health()
	writeJSON(w, http.StatusOK, map[string]any{
		"entries": rows,
		// The consent-ledger UI must show pending state honestly (§2.4). A UI
		// that implies "everything you see is complete" while the surfacing job
		// is stalled is worse than no UI at all.
		"surfacing": map[string]any{
			"backlog": backlog, "oldestUnsurfacedAt": oldest, "stalled": stalled,
		},
	})
}

// ── Journeys, check-ins, find-phone ──────────────────────────────────────────

func (s *server) listJourneys(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"journeys": s.proj.allJourneys(s.familyID(r))})
}

func (s *server) startJourney(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Label            string `json:"label"`
		OriginName       string `json:"originName"`
		DestName         string `json:"destName"`
		EtaMinutes       int    `json:"etaMinutes"`
		CheckInIntervalS int    `json:"checkInIntervalS"`
		MemberID         string `json:"memberId"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	now := time.Now()
	j := journeyRow{
		ID: uuidv7(), FamilyID: s.familyID(r), MemberID: firstNonEmpty(in.MemberID, s.memberID(r)),
		Label: in.Label, OriginName: in.OriginName, DestName: in.DestName,
		StartedAt: now.UnixMilli(), State: "active", CheckInIntervalS: in.CheckInIntervalS,
	}
	if in.EtaMinutes > 0 {
		j.EtaAt = now.Add(time.Duration(in.EtaMinutes) * time.Minute).UnixMilli()
	}
	s.proj.putJourney(s.bus, j)
	// The corridor itself never leaves the device (ADR-010): only the fact of a
	// journey, its label and its ETA are ever server-side.
	s.publishFamily(j.FamilyID, "journey.started", notify.PriorityHigh, "journey:"+j.ID, map[string]any{
		"journeyId": j.ID, "memberId": j.MemberID, "dest": j.DestName, "etaAt": j.EtaAt,
	})
	writeJSON(w, http.StatusCreated, j)
}

func (s *server) patchJourney(w http.ResponseWriter, r *http.Request) {
	j, ok := s.proj.journey(r.PathValue("id"))
	if !ok {
		problem(w, http.StatusNotFound, "KV-1010", "unknown journey", r.PathValue("id"))
		return
	}
	var in struct {
		State      string `json:"state"`
		EtaMinutes int    `json:"etaMinutes"`
		Arrived    bool   `json:"arrived"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	now := time.Now()
	switch {
	case in.Arrived || in.State == "arrived":
		j.State = "arrived"
		j.ArrivedAt = now.UnixMilli()
	case in.State != "":
		j.State = in.State
	}
	if in.EtaMinutes > 0 {
		j.EtaAt = now.Add(time.Duration(in.EtaMinutes) * time.Minute).UnixMilli()
	}
	s.proj.putJourney(s.bus, j)
	s.publishFamily(j.FamilyID, "journey.updated", notify.PriorityHigh, "journey:"+j.ID, map[string]any{
		"journeyId": j.ID, "state": j.State, "arrivedAt": j.ArrivedAt, "etaAt": j.EtaAt,
	})
	writeJSON(w, http.StatusOK, j)
}

func (s *server) checkin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		MemberID string `json:"memberId"`
		Note     string `json:"note"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	c := checkinRow{
		ID: uuidv7(), FamilyID: s.familyID(r),
		MemberID: firstNonEmpty(in.MemberID, s.memberID(r)),
		At:       time.Now().UnixMilli(), Note: in.Note,
	}
	s.proj.putCheckin(s.bus, c)
	// An explicit "I'm safe" also clears the dead-man timer the journey was
	// running: it is the strongest signal the system can receive.
	for _, j := range s.proj.allJourneys(c.FamilyID) {
		if j.MemberID == c.MemberID && j.State == "active" {
			j.LastCheckInAt = c.At
			s.proj.putJourney(s.bus, j)
		}
	}
	s.publishFamily(c.FamilyID, "member.checked_in", notify.PriorityHigh, "checkin:"+c.MemberID, map[string]any{
		"memberId": c.MemberID, "at": c.At,
	})
	writeJSON(w, http.StatusCreated, c)
}

// findPhone is P-021: ring a device at alarm volume even when it is silenced.
// It is a family-visible action, never a silent one — a tool that can locate a
// phone quietly is a tool for tracking a person.
func (s *server) findPhone(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("id")
	d, ok := s.st.Device(deviceID)
	if !ok {
		problem(w, http.StatusNotFound, "KV-1011", "unknown device", deviceID)
		return
	}
	s.publishFamily(d.FamilyID, "device.find_phone", notify.PriorityCritical, "", map[string]any{
		"deviceId": d.ID, "requestedBy": s.memberID(r), "at": time.Now().UnixMilli(),
	})
	writeJSON(w, http.StatusAccepted, map[string]any{"deviceId": d.ID, "sent": true})
}

// ── Drills ───────────────────────────────────────────────────────────────────

func (s *server) listDrills(w http.ResponseWriter, r *http.Request) {
	runs := s.st.DrillRuns(s.familyID(r))
	if runs == nil {
		runs = []store.DrillRun{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"drills": runs})
}

func (s *server) startDrill(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Kind              string   `json:"kind"`
		NotifiesFamily    bool     `json:"notifiesFamily"`
		AudienceDeviceIDs []string `json:"audienceDeviceIds"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	kind := strings.ToLower(firstNonEmpty(in.Kind, "canary"))
	switch kind {
	case "canary", "quarterly", "annual_full":
	default:
		problem(w, http.StatusBadRequest, "KV-1001", "kind must be canary|quarterly|annual_full", kind)
		return
	}
	// ★ F-03 ★ Only the quarterly/annual orchestrator may ring the family. A
	// canary that could set notifies_family would ring every phone 96 times a
	// day, and the family would mute the app inside a week.
	if kind == "canary" && in.NotifiesFamily {
		problem(w, http.StatusBadRequest, "KV-3001",
			"a canary drill may never notify the family (F-03)", kind)
		return
	}
	if !in.NotifiesFamily && len(in.AudienceDeviceIDs) == 0 {
		problem(w, http.StatusBadRequest, "KV-3002",
			"a scoped drill needs at least one audience device", "")
		return
	}
	run := store.DrillRun{
		ID: uuidv7(), FamilyID: s.familyID(r), Kind: kind,
		NotifiesFamily: in.NotifiesFamily, AudienceDeviceIDs: in.AudienceDeviceIDs,
		StartedAt: time.Now().UnixMilli(),
	}
	if err := s.st.PutDrillRun(run); err != nil {
		problem(w, http.StatusBadRequest, "KV-1006", err.Error(), run.FamilyID)
		return
	}
	writeJSON(w, http.StatusCreated, run)
}

// ── Realtime tickets (F-16) ──────────────────────────────────────────────────

// mintTicket issues a single-use, 60-second, device-bound connect ticket. The
// WebSocket URL therefore carries nothing sensitive (I-6): the credential
// travels in Sec-WebSocket-Protocol, and the resulting session outlives access
// token expiry instead of dying mid-incident.
func (s *server) mintTicket(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DeviceID string `json:"deviceId"`
		MemberID string `json:"memberId"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	famID := s.familyID(r)
	deviceID := firstNonEmpty(in.DeviceID, r.Header.Get("X-Device-Id"))
	memberID := firstNonEmpty(in.MemberID, s.memberID(r))
	if deviceID == "" {
		problem(w, http.StatusBadRequest, "KV-1001", "deviceId is required", "")
		return
	}
	if d, ok := s.st.Device(deviceID); ok {
		if d.RevokedAt != 0 {
			problem(w, http.StatusForbidden, "KV-2001", "device is revoked", deviceID)
			return
		}
		famID = d.FamilyID
		if memberID == "" {
			memberID = d.MemberID
		}
	}

	role := ""
	for _, m := range s.st.Members(famID) {
		if m.ID == memberID {
			role = strings.ToLower(m.Role)
		}
	}
	// F-20: the reduced flag decides which subject the socket subscribes to. A
	// neighbour's connection is never attached to the sealed feed at all, so
	// there is no code path — buggy or otherwise — that can hand them Class A.
	reduced := role == "neighbour"

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		problem(w, http.StatusInternalServerError, "KV-5001", "entropy failure", "")
		return
	}
	ticket := base64.RawURLEncoding.EncodeToString(raw)
	data, err := json.Marshal(map[string]any{
		"ticket": ticket, "familyId": famID, "deviceId": deviceID,
		"memberId": memberID, "reduced": reduced,
		"issuedAt":  time.Now().UnixMilli(),
		"expiresAt": time.Now().Add(60 * time.Second).UnixMilli(),
	})
	if err != nil {
		problem(w, http.StatusInternalServerError, "KV-5001", err.Error(), "")
		return
	}
	if err := s.bus.Publish(notify.TicketSubject, data); err != nil {
		problem(w, http.StatusServiceUnavailable, "KV-5001", "ticket could not be published", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ticket": ticket, "expiresIn": 60, "reduced": reduced,
	})
}

// ── Deploy freeze (F-02 / P-070) ─────────────────────────────────────────────

// activeIncidents is the query CI runs before every deploy. It reads the
// drill-excluding, DORMANT-excluding view: a canary firing every fifteen
// minutes and a forgotten six-hour-old incident must not be able to freeze
// deploys forever.
//
// Unauthenticated on the internal path, but never silent about the break-glass:
// KAVACH_DEPLOY_OVERRIDE emits an audit event and an ops alert.
func (s *server) activeIncidents(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	for _, fam := range s.st.Families() {
		for _, inc := range s.st.ActiveIncidents(fam.ID) {
			out = append(out, map[string]any{
				"id": inc.ID, "familyId": inc.FamilyID, "state": string(inc.State),
				"trigger": inc.Trigger, "openedAt": inc.OpenedAt,
				"ownerMemberId": inc.OwnerMemberID, "autoQuiesceAt": inc.AutoQuiesceAt,
			})
		}
	}
	override := firstNonEmpty(r.Header.Get("X-Kavach-Deploy-Override"), os.Getenv("KAVACH_DEPLOY_OVERRIDE"))
	if override != "" && len(out) > 0 {
		s.log.Warn("deploy_override_used", "reason", override, "blockedBy", len(out))
		s.publishOps("ops.deploy_override", "", map[string]any{
			"severity": "P1", "reason": override, "incidents": out,
		})
		if data, err := json.Marshal(map[string]any{
			"kind": "deploy_override", "reason": override,
			"at": time.Now().UnixMilli(), "incidents": out,
		}); err == nil {
			_ = s.bus.Publish(subjAudit, data)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"active": []any{}, "overridden": true, "reason": override,
			"wouldHaveBlocked": out,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"active": out, "count": len(out)})
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

func (s *server) publishFamily(familyID, kind string, prio notify.Priority, key string, data map[string]any) {
	f := notify.Frame{
		V: notify.FrameVersion, Type: kind, Priority: prio, Key: key,
		FamilyID: familyID, At: time.Now().UnixMilli(), Data: data,
	}
	if err := s.bus.Publish(notify.StreamSubject(familyID), f.Encode()); err != nil {
		s.log.Error("family_publish_failed", "type", kind, "err", err)
	}
}

func (s *server) publishOps(kind, familyID string, data map[string]any) {
	f := notify.Frame{
		V: notify.FrameVersion, Type: kind, Priority: notify.PriorityCritical,
		FamilyID: familyID, At: time.Now().UnixMilli(), Data: data,
	}
	if err := s.bus.Publish(notify.OpsSubject, f.Encode()); err != nil {
		s.log.Error("ops_publish_failed", "type", kind, "err", err)
	}
}

// familyID resolves the tenant for this request. Every query in the system
// filters on it (§2.8.1); a request that does not name one falls back to the
// single seeded family, which is the only correct default at family scale.
func (s *server) familyID(r *http.Request) string {
	if id := r.Header.Get("X-Family-Id"); id != "" {
		return id
	}
	if id := r.URL.Query().Get("familyId"); id != "" {
		return id
	}
	if fams := s.st.Families(); len(fams) > 0 {
		return fams[0].ID
	}
	return ""
}

func (s *server) memberID(r *http.Request) string {
	if id := r.Header.Get("X-Member-Id"); id != "" {
		return id
	}
	return r.URL.Query().Get("memberId")
}

// auth binds the caller. Passkey/WebAuthn assertion is the identity module's
// job; what this layer enforces is the shared-secret gate for a deployment
// exposed beyond localhost. Deliberately not applied to /internal (CI reaches
// it over the private network) or to /healthz.
func (s *server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.token != "" {
			got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
				problem(w, http.StatusUnauthorized, "KV-1002", "bad or missing token", "")
				return
			}
		}
		next(w, r)
	}
}

// idempotent replays the stored response for a repeated Idempotency-Key. Every
// mutating endpoint carries one (§2.9.2) because a client that retried over a
// second transport must not double-claim an incident.
func (s *server) idempotent(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if key == "" {
			next(w, r)
			return
		}
		key = r.Method + " " + r.URL.Path + " " + key
		if status, body, ok := s.idem.get(key); ok {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Idempotent-Replay", "true")
			w.WriteHeader(status)
			_, _ = w.Write(body)
			return
		}
		rec := &recorder{ResponseWriter: w, status: http.StatusOK}
		next(rec, r)
		if rec.status < 500 {
			s.idem.put(key, rec.status, rec.body)
		}
	}
}

type recorder struct {
	http.ResponseWriter
	status int
	body   []byte
}

func (r *recorder) WriteHeader(code int) { r.status = code; r.ResponseWriter.WriteHeader(code) }
func (r *recorder) Write(b []byte) (int, error) {
	r.body = append(r.body, b...)
	return r.ResponseWriter.Write(b)
}

type idemEntry struct {
	status int
	body   []byte
	at     time.Time
}

type idemStore struct {
	mu      sync.Mutex
	entries map[string]idemEntry
}

func newIdemStore() *idemStore { return &idemStore{entries: map[string]idemEntry{}} }

func (i *idemStore) get(key string) (int, []byte, bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	e, ok := i.entries[key]
	if !ok || time.Since(e.at) > 10*time.Minute {
		return 0, nil, false
	}
	return e.status, e.body, true
}

func (i *idemStore) put(key string, status int, body []byte) {
	i.mu.Lock()
	defer i.mu.Unlock()
	// Cheap sweep: bounded by request rate at family scale, but an unbounded
	// map in a long-lived process is still a leak.
	if len(i.entries) > 4096 {
		cutoff := time.Now().Add(-10 * time.Minute)
		for k, v := range i.entries {
			if v.at.Before(cutoff) {
				delete(i.entries, k)
			}
		}
	}
	i.entries[key] = idemEntry{status, append([]byte{}, body...), time.Now()}
}

// withCORS enables browser clients during local development. The origin is
// echoed rather than starred so credentialed requests work from the Expo dev
// server without loosening anything for a deployed origin.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = "*"
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Vary", "Origin")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers",
			"Content-Type, Authorization, Idempotency-Key, X-Family-Id, X-Member-Id, X-Device-Id, X-Kavach-Deploy-Override")
		h.Set("Access-Control-Expose-Headers", "Idempotent-Replay")
		h.Set("Access-Control-Max-Age", "600")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Default().Error("response_encode_failed", "err", err)
	}
}

// problem emits RFC 7807. The KV-#### codes are the client's contract for what
// to do next (§2.9.3) — KV-1002 means "retry anyway, never block an SOS".
func problem(w http.ResponseWriter, status int, code, detail, instance string) {
	writeProblem(w, status, code, detail, map[string]any{"instance": instance})
}

func writeProblem(w http.ResponseWriter, status int, code, detail string, extra map[string]any) {
	body := map[string]any{
		"type":   "https://kavach.example/errors/" + code,
		"title":  http.StatusText(status),
		"status": status,
		"code":   code,
		"detail": detail,
	}
	for k, v := range extra {
		body[k] = v
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		// An empty body is a legitimate no-argument POST (ack, reescalate).
		if errors.Is(err, io.EOF) {
			return true
		}
		problem(w, http.StatusBadRequest, "KV-1001", "malformed JSON body", err.Error())
		return false
	}
	return true
}

type atomicBool struct {
	mu sync.RWMutex
	v  bool
}

func (a *atomicBool) Store(v bool) { a.mu.Lock(); a.v = v; a.mu.Unlock() }
func (a *atomicBool) Load() bool   { a.mu.RLock(); defer a.mu.RUnlock(); return a.v }

// uuidv7 gives time-ordered ids so an incident list sorts correctly without an
// index on opened_at, and so a client-generated id is still monotonic.
func uuidv7() string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	if _, err := rand.Read(b[6:]); err != nil {
		// Entropy failure here is unrecoverable for id uniqueness; fall back to
		// the nanosecond clock rather than emitting zeros.
		n := uint64(time.Now().UnixNano())
		for i := 6; i < 16; i++ {
			b[i] = byte(n >> (8 * (uint(i) % 8)))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x70 // version 7
	b[8] = (b[8] & 0x3f) | 0x80 // variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func newID() string { return uuidv7() }

// inc8 is the 8-character base36 prefix that lets an inbound SMS be matched
// back to its incident (F-09). It is derived from the id, never random, so a
// device with no network computes the same value the server will.
func inc8(incidentID string) string {
	clean := strings.ReplaceAll(incidentID, "-", "")
	if len(clean) > 16 {
		clean = clean[:16]
	}
	raw, err := hex.DecodeString(clean)
	if err != nil || len(raw) == 0 {
		raw = []byte(incidentID)
	}
	var n uint64
	for _, b := range raw {
		n = n*257 + uint64(b)
	}
	s := strconv.FormatUint(n, 36)
	for len(s) < 8 {
		s = "0" + s
	}
	return s[:8]
}

func nodeID() [4]byte {
	var n [4]byte
	if _, err := rand.Read(n[:]); err != nil {
		ms := time.Now().UnixNano()
		n = [4]byte{byte(ms), byte(ms >> 8), byte(ms >> 16), byte(ms >> 24)}
	}
	return n
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envDur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
