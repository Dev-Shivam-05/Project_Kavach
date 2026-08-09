package logx

import (
	"io"
	"log/slog"
	"strings"
	"testing"
)

// required is invariant I-6 written down as data.
//
// I-6 does not die from an attack. It dies at 3 a.m. when somebody drops "lat"
// from the list to get one fan-out log line out, ships it, and six months of
// coordinates accumulate in an aggregator that was never in the threat model.
// Every term below has to be removed from BOTH this slice and logx.go for that
// to compile, and removing it from here is a diff nobody merges by accident.
var required = []string{
	"lat", "lon", "latitude", "longitude", "address", "coords",
	"location", "email", "phone", "name", "message",
}

func TestDenyListIsComplete(t *testing.T) {
	have := map[string]bool{}
	for _, d := range Deny() {
		have[d] = true
	}
	for _, want := range required {
		if !have[want] {
			t.Errorf("deny-list no longer contains %q (§10.5, I-6). "+
				"If a field genuinely needs to be logged, call logx.Allow on that exact key — "+
				"an Allow call is greppable, a shortened deny-list is not.", want)
		}
	}
}

// TestDenyListTermsAreEnforced closes the gap between the list and the handler:
// a term could sit in Deny() and match nothing if the matching rules changed.
func TestDenyListTermsAreEnforced(t *testing.T) {
	for _, term := range required {
		if !Violation(term) {
			t.Errorf("%q is on the deny-list but Violation(%q) is false", term, term)
		}
	}
	// Real-world spellings. Token matching has to survive snake_case, camelCase
	// and a prefix, or the list is decorative.
	for _, key := range []string{
		"user_lat", "userLat", "loc_lon", "locLon", "subjectLatitude",
		"home_address", "member.phone", "displayName", "sms_message",
	} {
		if !Violation(key) {
			t.Errorf("Violation(%q) is false; a PII field would reach the log", key)
		}
	}
}

// TestDenyListDoesNotEatLegitimateFields is why "lat" and "lon" are matched as
// whole tokens and not as substrings. A deny-list that rejects escalation_timer
// gets weakened by the next person who needs to log one, and the weakening is
// what actually loses the invariant.
func TestDenyListDoesNotEatLegitimateFields(t *testing.T) {
	for _, key := range []string{
		"latency_ms", "escalation_timer", "namespace", "coarse_h3_r7",
		"family_id", "incident_id", "policy_version", "colon",
	} {
		if Violation(key) {
			t.Errorf("Violation(%q) is true; the deny-list is over-matching and will be relaxed to compensate", key)
		}
	}
}

// TestDevHandlerPanics is the teeth. Redaction alone would let the line ship.
func TestDevHandlerPanics(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("dev handler accepted a deny-listed field without panicking")
		}
		msg, ok := r.(string)
		if !ok || !strings.Contains(msg, "I-6") {
			t.Fatalf("panic does not cite the invariant: %v", r)
		}
		// The panic must carry the key path only. Printing the value would
		// write the PII being refused into the crash output.
		if strings.Contains(msg, "28.6139") {
			t.Fatal("panic text leaked the field value")
		}
	}()
	log := slog.New(NewHandler(slog.NewJSONHandler(io.Discard, nil), true))
	log.Info("fix", "lat", 28.6139)
}

// TestProdHandlerRedactsInsteadOfCrashing — crashing the SOS binary over a log
// statement would trade a privacy bug for a safety bug (ADR-018's reflex).
func TestProdHandlerRedactsInsteadOfCrashing(t *testing.T) {
	var sb strings.Builder
	before := Redactions()
	log := slog.New(NewHandler(slog.NewJSONHandler(&sb, nil), false))
	log.Info("fix", "lat", 28.6139)
	out := sb.String()
	if strings.Contains(out, "28.6139") {
		t.Fatalf("production log emitted the value: %s", out)
	}
	if !strings.Contains(out, "[REDACTED:PII]") {
		t.Fatalf("production log did not redact: %s", out)
	}
	if Redactions() <= before {
		t.Fatal("redaction was not counted; a non-zero count is the bug report")
	}
}
