// Command canary fires a real incident through the real handler every 15
// minutes, forever.
//
// ★ This is the single highest-value investment in the system (PRD §16.2). ★
//
// CPU graphs, error rates and uptime checks all look green while an FCM
// service-account key silently expires, a DLT template gets deregistered, or an
// APNs certificate lapses. None of those produce an error anywhere — they
// produce a family that does not get woken up. The canary is the only thing in
// the architecture that notices, and it notices within fifteen minutes.
//
// It is also the only page-worthy alert in the system. Everything else is a
// ticket. If this binary pages you, something in the chain between a phone
// screaming and a human being told is broken.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptrace"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kavach/backend/internal/bus"
	"github.com/kavach/backend/internal/logx"
	"github.com/kavach/backend/internal/notify"
)

// T3Budget is the pass/fail line. NFR-002 budgets t3 p95 < 5 s end to end; the
// canary pages at 15 s, which is deliberately looser — a page is for "the chain
// is broken", not "the chain is slower than we would like". Slow is a ticket.
const T3Budget = 15 * time.Second

func main() {
	var (
		apiBase  = flag.String("api", env("KAVACH_API_BASE", "http://127.0.0.1:8081"), "control-plane base URL")
		busDir   = flag.String("bus", env("KAVACH_BUS_DIR", "./data/bus"), "bus directory")
		metrics  = flag.String("metrics", env("KAVACH_CANARY_METRICS_ADDR", ":9101"), "metrics listen address")
		interval = flag.Duration("interval", envDur("KAVACH_CANARY_INTERVAL", 15*time.Minute), "run interval")
		receiver = flag.String("receiver", os.Getenv("KAVACH_CANARY_DEVICE_ID"), "canary receiver device id")
		pageURL  = flag.String("page-url", os.Getenv("KAVACH_PAGE_URL"), "webhook for P0 pages (ntfy/Telegram)")
		token    = flag.String("token", os.Getenv("KAVACH_API_TOKEN"), "control-plane bearer token")
		dev      = flag.Bool("dev", env("KAVACH_DEV", "1") == "1", "developer logging")
		once     = flag.Bool("once", false, "run a single probe and exit (CI smoke test)")
	)
	flag.Parse()

	log := logx.New(*dev)
	b, err := bus.Open(*busDir)
	if err != nil {
		log.Error("bus_open_failed", "dir", *busDir, "err", err)
		os.Exit(1)
	}

	c := &canary{
		log: log, bus: b, api: strings.TrimRight(*apiBase, "/"),
		receiverID: *receiver, pageURL: *pageURL, token: *token,
		http: &http.Client{Timeout: 30 * time.Second},
		m:    newMetrics(),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *once {
		res := c.probe(ctx)
		c.report(res)
		if !res.OK {
			os.Exit(1)
		}
		return
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", c.m.handler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		ok, last := c.m.lastSuccess()
		status := http.StatusOK
		if !ok || time.Since(last) > 3*(*interval) {
			status = http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":      map[bool]string{true: "ok", false: "stale"}[status == http.StatusOK],
			"lastSuccess": last.UnixMilli(),
		})
	})
	srv := &http.Server{Addr: *metrics, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		log.Info("canary_metrics_listening", "addr", *metrics)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("metrics_listen_failed", "err", err)
		}
	}()

	log.Info("canary_started", "api", *apiBase, "interval", *interval, "t3Budget", T3Budget)

	t := time.NewTicker(*interval)
	defer t.Stop()
	// Fire immediately: a canary that waits fifteen minutes after a deploy to
	// tell you the deploy broke the chain is fifteen minutes too polite.
	c.report(c.probe(ctx))
	for {
		select {
		case <-ctx.Done():
			shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = srv.Shutdown(shutCtx)
			cancel()
			log.Info("canary_stopped")
			return
		case <-t.C:
			c.report(c.probe(ctx))
		}
	}
}

// ── The probe ────────────────────────────────────────────────────────────────

// Result carries the four clocks and everything that went wrong.
type Result struct {
	OK          bool
	IncidentID  string
	DrillRunID  string
	FamilyID    string
	T0          time.Time // trigger constructed
	T1          time.Time // server confirmed the incident exists
	T2          time.Time // first byte left this process on the wire
	T3          time.Time // first responder actually notified
	T4          time.Time // first acknowledgement (CLAIM accepted)
	Failures    []string
	LeakedTo    []string // F-03 violation: family devices that were notified
	FrozeDeploy bool     // F-02 violation: drill appeared in active-incidents
}

func (r Result) leg(a, b time.Time) float64 {
	if a.IsZero() || b.IsZero() {
		return -1
	}
	return b.Sub(a).Seconds()
}

type canary struct {
	log        *slog.Logger
	bus        *bus.Bus
	api        string
	token      string
	receiverID string
	pageURL    string
	http       *http.Client
	m          *metrics

	consecutiveFailures int
	lastPagedAt         time.Time
}

func (c *canary) probe(ctx context.Context) Result {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	res := Result{}
	fail := func(format string, args ...any) Result {
		res.Failures = append(res.Failures, fmt.Sprintf(format, args...))
		res.OK = false
		return res
	}

	// 1. Who is in this family, and which device is the canary receiver?
	var fam struct {
		Family  map[string]any   `json:"family"`
		Members []map[string]any `json:"members"`
		Devices []map[string]any `json:"devices"`
	}
	if err := c.call(ctx, http.MethodGet, "/v1/family", nil, &fam, nil); err != nil {
		return fail("GET /v1/family: %v", err)
	}
	familyID, _ := fam.Family["ID"].(string)
	if familyID == "" {
		familyID, _ = fam.Family["id"].(string)
	}
	if familyID == "" {
		return fail("family response carried no id")
	}
	res.FamilyID = familyID

	receiver := c.receiverID
	if receiver == "" {
		receiver = pickReceiver(fam.Devices)
	}
	if receiver == "" {
		return fail("no canary receiver device available")
	}
	familyDevices := map[string]bool{}
	for _, d := range fam.Devices {
		if id := str(d, "id", "ID"); id != "" && id != receiver {
			familyDevices[id] = true
		}
	}
	subjectMember, claimMember, confirmMember := pickMembers(fam.Members)

	// 2. A drill run scoped to the receiver alone. ★ F-03 ★ Without this the
	//    canary rings every family phone 96 times a day.
	var run map[string]any
	if err := c.call(ctx, http.MethodPost, "/v1/drills", map[string]any{
		"kind":              "canary",
		"notifiesFamily":    false,
		"audienceDeviceIds": []string{receiver},
	}, &run, map[string]string{"X-Family-Id": familyID}); err != nil {
		return fail("POST /v1/drills: %v", err)
	}
	res.DrillRunID = str(run, "id", "ID")
	if res.DrillRunID == "" {
		return fail("drill run response carried no id")
	}

	// 3. Watch the real bus, from now, exactly as a device would.
	frames, unsub := c.bus.Subscribe(notify.StreamSubject(familyID), 0)
	defer unsub()
	drainNow(frames)

	// 4. Fire.
	//    t0 = the trigger. t1 = local confirmation, which for a drill is
	//    immediate because there is no cancel window to wait out. t2 = the
	//    first byte actually leaving this process, measured with httptrace
	//    rather than estimated — that is the leg §2.3 budgets at 150 ms.
	res.T0 = time.Now()
	res.T1 = time.Now()
	var open struct {
		Incident   map[string]any `json:"incident"`
		ServerTsMs int64          `json:"serverTsMs"`
	}
	var wroteAt time.Time
	trace := &httptrace.ClientTrace{
		WroteRequest: func(httptrace.WroteRequestInfo) { wroteAt = time.Now() },
	}
	err := c.call(httptrace.WithClientTrace(ctx, trace), http.MethodPost, "/v1/incidents", map[string]any{
		"trigger":         "DRILL",
		"isDrill":         true,
		"drillRunId":      res.DrillRunID,
		"subjectMemberId": subjectMember,
		"confidencePct":   100,
		"coarseH3R7":      "canary",
		// ★ REAL code path: same handler, same bus, same store. Not a mock. ★
		"skipCancelWindow": true,
	}, &open, map[string]string{"X-Family-Id": familyID})
	if err != nil {
		return fail("POST /v1/incidents: %v", err)
	}
	res.T2 = wroteAt
	if res.T2.IsZero() {
		res.T2 = res.T0
	}
	res.IncidentID = str(open.Incident, "id", "ID")
	if res.IncidentID == "" {
		return fail("incident response carried no id")
	}

	// 5. t3 — wait for the notification to actually reach the receiver, and
	//    check on the way past that nobody else was rung.
	t3, leaked, err := c.awaitNotification(ctx, frames, res.IncidentID, receiver, familyDevices)
	res.LeakedTo = leaked
	if err != nil {
		fail("t3: %v", err)
	} else {
		res.T3 = t3
	}
	if len(leaked) > 0 {
		// This is not a latency problem, it is the failure mode that kills the
		// product: 96 drills a day reaching real phones.
		fail("F-03 VIOLATION: drill notified %d family device(s): %s",
			len(leaked), strings.Join(leaked, ","))
	}

	// 6. F-02 — the drill must be invisible to the deploy-freeze query. If it
	//    is not, every CI run has a chance of being refused with no explanation.
	if frozen, err := c.checkDeployFreeze(ctx, res.IncidentID); err != nil {
		fail("GET /internal/active-incidents: %v", err)
	} else if frozen {
		res.FrozeDeploy = true
		fail("F-02 VIOLATION: drill incident %s appears in /internal/active-incidents", res.IncidentID)
	}

	// 7. t4 — the receiver claims. This exercises the ladder halt and the
	//    ownership broadcast, which is the transition a responder's phone must
	//    never miss.
	claimAt := time.Now()
	if err := c.call(ctx, http.MethodPost, "/v1/incidents/"+res.IncidentID+"/claim",
		map[string]any{"memberId": claimMember}, nil,
		map[string]string{"X-Family-Id": familyID}); err != nil {
		fail("POST claim: %v", err)
	} else {
		res.T4 = claimAt
	}

	// 8. Close it out through the real two-party path so the incident does not
	//    linger — belt and braces alongside auto-quiesce.
	if err := c.call(ctx, http.MethodPost, "/v1/incidents/"+res.IncidentID+"/resolve",
		map[string]any{"memberId": claimMember}, nil,
		map[string]string{"X-Family-Id": familyID}); err != nil {
		fail("POST resolve (on-scene): %v", err)
	}
	if err := c.call(ctx, http.MethodPost, "/v1/incidents/"+res.IncidentID+"/resolve",
		map[string]any{"memberId": confirmMember}, nil,
		map[string]string{"X-Family-Id": familyID}); err != nil {
		fail("POST resolve (two-party confirm): %v", err)
	}

	if !res.T3.IsZero() && res.T3.Sub(res.T0) > T3Budget {
		fail("t3 %.2fs exceeds the %.0fs budget", res.T3.Sub(res.T0).Seconds(), T3Budget.Seconds())
	}
	if len(res.Failures) == 0 {
		res.OK = true
	}
	return res
}

// afterAction is the persisted notification matrix the responder UI reads.
type afterAction struct {
	Incident struct {
		FirstNotifiedAt int64  `json:"first_notified_at"`
		FirstAckAt      int64  `json:"first_ack_at"`
		State           string `json:"state"`
	} `json:"incident"`
	Notifications []struct {
		Tier     int      `json:"tier"`
		Label    string   `json:"label"`
		Audience []string `json:"audience"`
	} `json:"notifications"`
	Deliveries []struct {
		DeviceID    string `json:"device_id"`
		Channel     string `json:"channel"`
		State       string `json:"state"`
		DeliveredAt int64  `json:"delivered_at"`
	} `json:"deliveries"`
}

// awaitNotification watches for the delivery that proves the chain worked, and
// simultaneously proves nobody else was disturbed.
//
// It watches two places at once. The bus is the live path a phone actually
// rides, and it is authoritative when the canary shares a bus with the control
// plane. The after-action record is the persisted truth, and it works across
// process and host boundaries — which is the deployment the canary is normally
// in, running out-of-band from the system it watches (§2.11.1). Whichever
// answers first wins; both must agree that only the receiver was notified.
func (c *canary) awaitNotification(ctx context.Context, frames <-chan bus.Msg, incidentID, receiver string, familyDevices map[string]bool) (time.Time, []string, error) {
	limit := T3Budget + 5*time.Second
	deadline := time.NewTimer(limit)
	defer deadline.Stop()
	poll := time.NewTicker(250 * time.Millisecond)
	defer poll.Stop()

	var t3 time.Time
	leakedSet := map[string]bool{}
	settle := false

	for {
		select {
		case <-ctx.Done():
			return t3, keys(leakedSet), ctx.Err()

		case <-deadline.C:
			if t3.IsZero() {
				return t3, keys(leakedSet), fmt.Errorf(
					"no notification for incident %s within %s", incidentID, limit)
			}
			return t3, keys(leakedSet), nil

		case m, ok := <-frames:
			if !ok {
				// The bus subscription ended; the polling leg still stands.
				frames = nil
				continue
			}
			var f notify.Frame
			if json.Unmarshal(m.Data, &f) != nil || f.IncidentID != incidentID {
				continue
			}
			switch f.Type {
			case "incident.notified":
				for _, id := range anyStrings(f.Data["audience"]) {
					if familyDevices[id] {
						leakedSet[id] = true
					}
				}
				if t3.IsZero() && containsString(anyStrings(f.Data["audience"]), receiver) {
					t3 = time.UnixMilli(f.At)
					settle = true
					deadline.Reset(2 * time.Second)
				}
			case "notify.delivered":
				if id, _ := f.Data["deviceId"].(string); familyDevices[id] {
					leakedSet[id] = true
				}
			}

		case <-poll.C:
			var aa afterAction
			if err := c.call(ctx, http.MethodGet,
				"/v1/incidents/"+incidentID+"/after-action", nil, &aa, nil); err != nil {
				continue
			}
			for _, n := range aa.Notifications {
				for _, id := range n.Audience {
					if familyDevices[id] {
						leakedSet[id] = true
					}
				}
			}
			for _, d := range aa.Deliveries {
				if familyDevices[d.DeviceID] {
					leakedSet[d.DeviceID] = true
				}
			}
			if t3.IsZero() && aa.Incident.FirstNotifiedAt > 0 {
				t3 = time.UnixMilli(aa.Incident.FirstNotifiedAt)
				// Keep looking for a moment: a leak may only appear on a later
				// rung, and finding it late is still finding it.
				settle = true
				deadline.Reset(2 * time.Second)
			}
			if settle && len(leakedSet) > 0 {
				return t3, keys(leakedSet), nil
			}
		}
	}
}

func (c *canary) checkDeployFreeze(ctx context.Context, incidentID string) (bool, error) {
	var out struct {
		Active []map[string]any `json:"active"`
	}
	if err := c.call(ctx, http.MethodGet, "/internal/active-incidents", nil, &out, nil); err != nil {
		return false, err
	}
	for _, row := range out.Active {
		if str(row, "id", "ID") == incidentID {
			return true, nil
		}
	}
	return false, nil
}

// ── Reporting and paging ─────────────────────────────────────────────────────

func (c *canary) report(res Result) {
	c.m.observe(res)

	attrs := []any{
		"incident", res.IncidentID,
		"t1MinusT0s", res.leg(res.T0, res.T1),
		"t2MinusT1s", res.leg(res.T1, res.T2),
		"t3MinusT2s", res.leg(res.T2, res.T3),
		"t4MinusT3s", res.leg(res.T3, res.T4),
		"t3TotalS", res.leg(res.T0, res.T3),
	}
	if res.OK {
		c.consecutiveFailures = 0
		c.log.Info("canary_ok", attrs...)
		return
	}

	c.consecutiveFailures++
	c.log.Error("canary_failed_P0", append(attrs,
		"failures", strings.Join(res.Failures, " | "),
		"consecutive", c.consecutiveFailures)...)

	// §2.11.5: repeat every 5 minutes until acknowledged. There is no ack
	// channel here, so "acknowledged" is "the next probe succeeded".
	if time.Since(c.lastPagedAt) < 5*time.Minute {
		return
	}
	c.lastPagedAt = time.Now()
	c.page(res)
}

// page sends the alert OUT of the system being monitored. Routing an alert
// through the infrastructure that just failed is how outages go unnoticed.
func (c *canary) page(res Result) {
	body := fmt.Sprintf("KAVACH P0 — safety chain canary failed (%d consecutive)\nincident=%s\n%s\nt3=%.2fs (budget %.0fs)",
		c.consecutiveFailures, res.IncidentID,
		strings.Join(res.Failures, "\n"), res.leg(res.T0, res.T3), T3Budget.Seconds())

	if c.pageURL == "" {
		// No webhook configured: stderr is still out-of-band relative to the
		// bus and the control plane, and systemd/journald will carry it.
		fmt.Fprintln(os.Stderr, "\n=== PAGE ===\n"+body+"\n============")
		return
	}
	req, err := http.NewRequest(http.MethodPost, c.pageURL, strings.NewReader(body))
	if err != nil {
		c.log.Error("page_build_failed", "err", err)
		return
	}
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Title", "Kavach canary P0")
	req.Header.Set("Priority", "urgent")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		c.log.Error("page_send_failed", "err", err)
		fmt.Fprintln(os.Stderr, "\n=== PAGE (webhook failed) ===\n"+body)
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

func (c *canary) call(ctx context.Context, method, path string, in any, out any, headers map[string]string) error {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.api+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("decode: %w (body %.200s)", err, raw)
		}
	}
	return nil
}

// ── Metrics ──────────────────────────────────────────────────────────────────

// metrics emits Prometheus text format by hand. Four counters, four histograms
// and one timestamp is not worth a dependency.
type metrics struct {
	mu sync.Mutex

	runs, failures int64
	f03, f02       int64
	lastSuccessAt  time.Time
	lastT3Seconds  float64
	legs           map[string]*histogram
}

type histogram struct {
	buckets []float64
	counts  []int64
	sum     float64
	count   int64
}

func newHistogram() *histogram {
	b := []float64{0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30}
	return &histogram{buckets: b, counts: make([]int64, len(b))}
}

func (h *histogram) observe(v float64) {
	if v < 0 {
		return
	}
	h.sum += v
	h.count++
	for i, b := range h.buckets {
		if v <= b {
			h.counts[i]++
		}
	}
}

func newMetrics() *metrics {
	return &metrics{legs: map[string]*histogram{
		"t1_t0": newHistogram(), "t2_t1": newHistogram(),
		"t3_t2": newHistogram(), "t4_t3": newHistogram(),
		"t3_total": newHistogram(),
	}}
}

func (m *metrics) observe(res Result) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runs++
	if res.OK {
		m.lastSuccessAt = time.Now()
	} else {
		m.failures++
	}
	if len(res.LeakedTo) > 0 {
		m.f03++
	}
	if res.FrozeDeploy {
		m.f02++
	}
	m.legs["t1_t0"].observe(res.leg(res.T0, res.T1))
	m.legs["t2_t1"].observe(res.leg(res.T1, res.T2))
	m.legs["t3_t2"].observe(res.leg(res.T2, res.T3))
	m.legs["t4_t3"].observe(res.leg(res.T3, res.T4))
	total := res.leg(res.T0, res.T3)
	m.legs["t3_total"].observe(total)
	if total >= 0 {
		m.lastT3Seconds = total
	}
}

func (m *metrics) lastSuccess() (bool, time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return !m.lastSuccessAt.IsZero(), m.lastSuccessAt
}

func (m *metrics) handler(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var b strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }

	line("# HELP kavach_canary_runs_total Canary probes attempted.")
	line("# TYPE kavach_canary_runs_total counter")
	line("kavach_canary_runs_total %d", m.runs)

	line("# HELP kavach_canary_failures_total Canary probes that failed any leg. Every one is a P0 page.")
	line("# TYPE kavach_canary_failures_total counter")
	line("kavach_canary_failures_total %d", m.failures)

	line("# HELP kavach_canary_drill_leak_total Drill notifications that reached a family device (F-03 violation).")
	line("# TYPE kavach_canary_drill_leak_total counter")
	line("kavach_canary_drill_leak_total %d", m.f03)

	line("# HELP kavach_canary_deploy_freeze_total Drill incidents visible to the deploy-freeze query (F-02 violation).")
	line("# TYPE kavach_canary_deploy_freeze_total counter")
	line("kavach_canary_deploy_freeze_total %d", m.f02)

	line("# HELP kavach_canary_last_success_timestamp_seconds Unix time of the last fully successful probe.")
	line("# TYPE kavach_canary_last_success_timestamp_seconds gauge")
	line("kavach_canary_last_success_timestamp_seconds %d", m.lastSuccessAt.Unix())

	line("# HELP kavach_canary_t3_seconds Most recent trigger-to-first-notification latency.")
	line("# TYPE kavach_canary_t3_seconds gauge")
	line("kavach_canary_t3_seconds %.4f", m.lastT3Seconds)

	line("# HELP kavach_canary_leg_seconds Four-clock leg latencies.")
	line("# TYPE kavach_canary_leg_seconds histogram")
	names := make([]string, 0, len(m.legs))
	for k := range m.legs {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, name := range names {
		h := m.legs[name]
		for i, ub := range h.buckets {
			line(`kavach_canary_leg_seconds_bucket{leg="%s",le="%g"} %d`, name, ub, h.counts[i])
		}
		line(`kavach_canary_leg_seconds_bucket{leg="%s",le="+Inf"} %d`, name, h.count)
		line(`kavach_canary_leg_seconds_sum{leg="%s"} %.4f`, name, h.sum)
		line(`kavach_canary_leg_seconds_count{leg="%s"} %d`, name, h.count)
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = io.WriteString(w, b.String())
}

// ── Small helpers ────────────────────────────────────────────────────────────

// pickReceiver prefers a dedicated node device (a CCTV or intercom phone that
// nobody carries) so the canary never rings a pocket.
func pickReceiver(devices []map[string]any) string {
	var fallback string
	for _, d := range devices {
		id := str(d, "id", "ID")
		if id == "" {
			continue
		}
		if strings.EqualFold(str(d, "platform", "Platform"), "node") {
			return id
		}
		if fallback == "" {
			fallback = id
		}
	}
	return fallback
}

// pickMembers returns three ids: the drill subject, the claimer, and a second
// member for the two-party confirmation. Two-party resolution genuinely
// requires two people, so a one-member family degrades to reusing the subject
// and the resolve leg will report the conflict rather than pretend.
func pickMembers(members []map[string]any) (subject, claimer, confirmer string) {
	var ids []string
	for _, m := range members {
		if id := str(m, "id", "ID"); id != "" {
			ids = append(ids, id)
		}
	}
	switch len(ids) {
	case 0:
		return "", "", ""
	case 1:
		return ids[0], ids[0], ids[0]
	case 2:
		return ids[0], ids[1], ids[0]
	default:
		return ids[0], ids[1], ids[2]
	}
}

func str(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func anyStrings(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// drainNow discards anything already queued so the probe measures its own
// incident and not a previous one.
func drainNow(ch <-chan bus.Msg) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
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
