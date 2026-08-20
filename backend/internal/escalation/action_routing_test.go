// ★ D-026 · ADR-002 — the seam between the two things that arm rungs.
//
// Two places in this repo write escalation_timer rows and they do not agree on
// what an Action is called:
//
//   - escalation.arm (engine.go:712) names the WORK: REPEAT_L1, SMS_TIER,
//     ESCALATE_L2, ESCALATE_L3, PROGRESS_WATCHDOG, AUTO_QUIESCE. Its ids are
//     minted UUIDs.
//   - cmd/sos-ingest.armTimers (main.go:1019) names the EVENT, straight out of
//     the generated machine: one rung per scheduled transition, Action =
//     string(t.On). Its ids are derived, incident|state|action.
//
// Three of the four actions the projector can derive happen to collide with an
// action this engine implements. The fourth is NO_ACK — the whole L1→L2→L3
// climb — and execute() has no case for it. This test measures that rather than
// asserting it from the switch statement, and it fails the moment either side
// of the seam moves.
package escalation

import (
	"sort"
	"strings"
	"testing"

	"github.com/kavach/backend/internal/incident"
)

func TestNotEveryActionTheProjectorDerivesIsRoutable(t *testing.T) {
	// Exactly the derivation cmd/sos-ingest.armTimers performs: one rung per
	// transition with a delay on it, named after the event.
	derived := map[string]incident.State{}
	for _, tr := range incident.Transitions {
		if tr.AfterS > 0 {
			derived[string(tr.On)] = tr.From
		}
	}
	if len(derived) == 0 {
		t.Fatal("the generated machine schedules no transitions at all")
	}

	var routable, unroutable []string
	for action, from := range derived {
		// A fresh engine per action: two of these mutate the incident.
		e, _, _, _, _ := rig(t, atState(from), Config{})
		err := fire(t, e, action)
		switch {
		case err == nil:
			routable = append(routable, action)
		case strings.Contains(err.Error(), "unknown timer action"):
			unroutable = append(unroutable, action)
		default:
			t.Fatalf("%s from %s failed for an unrelated reason: %v", action, from, err)
		}
	}
	sort.Strings(routable)
	sort.Strings(unroutable)

	wantRoutable := []string{"AUTO_QUIESCE", "PROBE_TIMEOUT", "PROGRESS_WATCHDOG"}
	if strings.Join(routable, ",") != strings.Join(wantRoutable, ",") {
		t.Fatalf("routable actions %v, want %v", routable, wantRoutable)
	}
	// ★ If this list ever empties, the seam has been closed — say so in D-026
	// and delete this test. If it GROWS, cmd/sos-ingest is arming more rungs
	// that nothing will ever execute.
	if strings.Join(unroutable, ",") != "NO_ACK" {
		t.Fatalf("unroutable actions %v, want exactly [NO_ACK]", unroutable)
	}
}
