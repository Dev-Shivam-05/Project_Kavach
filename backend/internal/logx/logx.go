// Package logx is structured logging with a compile-time PII deny-list.
//
// ★ INVARIANT I-6 ★
// Privacy architectures do not usually fail at the crypto. They fail at 3 a.m.
// when somebody adds slog.Float64("lat", p.Lat) to debug a fan-out bug, ships
// it, and six months of precise coordinates are sitting in a log aggregator that
// was never in the threat model. Every control in §2.4 — E2EE payloads, the
// coarse-cell-only rule, Class A′ being memory-only — is undone by that one
// line.
//
// So the deny-list is not advice. In development it PANICS: the offending line
// cannot survive a test run, let alone a review. In production it redacts and
// counts, because crashing the SOS binary over a log statement would trade a
// privacy bug for a safety bug.
package logx

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"
)

// denySubstring are terms long and specific enough that a substring match has no
// meaningful false positives: no legitimate field is called "…location…".
var denySubstring = []string{
	"latitude", "longitude", "address", "coords", "location", "email", "phone",
}

// denyToken are short or common terms that must match a whole word. "lat" as a
// substring would reject "latency", which is a metric we genuinely need; "name"
// as a substring would reject "namespace". Token matching still catches
// user_lat, userLat, lat_deg and their relatives.
var denyToken = []string{"lat", "lon", "name", "message"}

var (
	allowMu    sync.RWMutex
	allowed    = map[string]struct{}{}
	redactions atomic.Uint64
	violations atomic.Uint64
)

// Allow exempts an exact key. It exists so the deny-list can stay strict without
// becoming unusable — and because an explicit, greppable call in source is a
// review artefact, whereas a silent bypass is how the rule dies.
func Allow(keys ...string) {
	allowMu.Lock()
	defer allowMu.Unlock()
	for _, k := range keys {
		allowed[strings.ToLower(k)] = struct{}{}
	}
}

// Deny returns the full deny-list, so CI can assert it has not been quietly
// shortened.
func Deny() []string {
	out := make([]string, 0, len(denySubstring)+len(denyToken))
	out = append(out, denySubstring...)
	out = append(out, denyToken...)
	return out
}

func tokens(key string) []string {
	var out []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, strings.ToLower(cur.String()))
			cur.Reset()
		}
	}
	runes := []rune(key)
	for i, r := range runes {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			// camelCase boundary: a capital preceded by a lowercase starts a token.
			if unicode.IsUpper(r) && i > 0 && unicode.IsLower(runes[i-1]) {
				flush()
			}
			cur.WriteRune(r)
		default:
			flush()
		}
	}
	flush()
	return out
}

// Violation reports whether a field key is forbidden.
func Violation(key string) bool {
	if key == "" {
		return false
	}
	lk := strings.ToLower(key)
	allowMu.RLock()
	_, ok := allowed[lk]
	allowMu.RUnlock()
	if ok {
		return false
	}
	for _, d := range denySubstring {
		if strings.Contains(lk, d) {
			return true
		}
	}
	toks := tokens(key)
	for _, t := range toks {
		for _, d := range denyToken {
			if t == d {
				return true
			}
		}
	}
	return false
}

// Dev reports whether the deny-list should panic. Anything other than an
// explicit KAVACH_ENV=production is development — defaulting the other way would
// mean a developer's first encounter with the rule is a redacted production log
// instead of a failing test.
func Dev() bool { return strings.ToLower(os.Getenv("KAVACH_ENV")) != "production" }

// Redactions counts fields redacted in production. Non-zero is a bug report.
func Redactions() uint64 { return redactions.Load() }

// Violations counts deny-list hits, in either mode.
func Violations() uint64 { return violations.Load() }

// Handler wraps any slog.Handler with the deny-list.
type Handler struct {
	inner  slog.Handler
	dev    bool
	groups []string
}

// New builds the standard Kavach logger: JSON to stderr, deny-listed. In dev the
// deny-list panics; in production it redacts and counts.
func New(dev bool) *slog.Logger {
	level := slog.LevelInfo
	if dev {
		level = slog.LevelDebug
	}
	return NewTo(os.Stderr, level, dev)
}

// NewTo is New with an explicit sink and level, for tests and for binaries that
// ship logs somewhere other than stderr.
func NewTo(w io.Writer, level slog.Level, dev bool) *slog.Logger {
	return slog.New(NewHandler(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level}), dev))
}

func NewHandler(inner slog.Handler, dev bool) *Handler {
	return &Handler{inner: inner, dev: dev}
}

func (h *Handler) Enabled(ctx context.Context, l slog.Level) bool { return h.inner.Enabled(ctx, l) }

func (h *Handler) path(key string) string {
	if len(h.groups) == 0 {
		return key
	}
	return strings.Join(h.groups, ".") + "." + key
}

// report is where the invariant bites. The panic deliberately carries the KEY
// PATH ONLY: printing the value would write the very PII we are refusing into
// the crash output.
func (h *Handler) report(key string) {
	violations.Add(1)
	if h.dev {
		panic("logx: PII deny-list violation — field '" + h.path(key) +
			"' may never be logged (invariant I-6). Log a coarse cell, a hash, or an id instead.")
	}
	redactions.Add(1)
}

func (h *Handler) sanitize(a slog.Attr) slog.Attr {
	if Violation(a.Key) {
		h.report(a.Key)
		return slog.String(a.Key, "[REDACTED:PII]")
	}
	if a.Value.Kind() == slog.KindGroup {
		sub := a.Value.Group()
		out := make([]any, 0, len(sub))
		for _, g := range sub {
			s := h.sanitize(g)
			out = append(out, s)
		}
		return slog.Group(a.Key, out...)
	}
	return a
}

func (h *Handler) Handle(ctx context.Context, r slog.Record) error {
	clean := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	r.Attrs(func(a slog.Attr) bool {
		clean.AddAttrs(h.sanitize(a))
		return true
	})
	return h.inner.Handle(ctx, clean)
}

func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	// Checked here as well as in Handle so a bad key on a logger built at startup
	// fails at startup, not on the one code path that eventually logs it.
	out := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		out = append(out, h.sanitize(a))
	}
	return &Handler{inner: h.inner.WithAttrs(out), dev: h.dev, groups: h.groups}
}

func (h *Handler) WithGroup(name string) slog.Handler {
	if Violation(name) {
		h.report(name)
	}
	g := append(append([]string{}, h.groups...), name)
	return &Handler{inner: h.inner.WithGroup(name), dev: h.dev, groups: g}
}
