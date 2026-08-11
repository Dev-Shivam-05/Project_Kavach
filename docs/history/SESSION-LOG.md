# Session log — recovered history

This project was built across a handful of long sessions and then `/clear`ed several times **without
a handoff**, so the working context was lost. On 2026-08-11 that history was recovered by mining the
Claude Code transcripts. This file exists so it never has to be recovered again.

Nothing here is inferred from the code — it is what the transcripts actually record.

## Where the artifacts live

These are **outside the repo** and are the only copy. Back them up before clearing anything.

| What | Path |
|---|---|
| Main build session (26 Jul → 07 Aug, 10 MB, 5,097 lines) | `~/.claude/projects/d--Projects-Project-Kavach/3e5f73c5-7bd7-42ac-9bc9-71f443e56930.jsonl` |
| Earlier session (26 Jul, 1.1 MB) — **not yet mined**, may hold the original architecture reasoning | `~/.claude/projects/d--Projects-Project-Kavach/2f4187f3-c45f-42cc-9688-0d4701f32c02.jsonl` |
| ★ The six workflow scripts — the plan that was actually executed | `~/.claude/projects/D--Projects-Project-Kavach-mobile/3e5f73c5-…/workflows/scripts/` |
| Per-agent results of completed workflows | `~/.claude/projects/d--Projects-Project-Kavach/3e5f73c5-…/subagents/workflows/<wf-id>/journal.jsonl` |
| The unfinished 07 Aug agents (partial, recoverable) | `…/subagents/workflows/wf_490b5218-df0/agent-*.jsonl` |

The workflow scripts exist in **exactly one directory** and nowhere in the repo. They are the
highest-value recovered artifact: each encodes a phase decomposition and the exact briefs its agents
were given.

## Timeline

| Date | What happened |
|---|---|
| **26 Jul** | PRD analysed word by word → `docs/01`–`docs/04` written. Then a "single-shot, build everything, no incremental confirmation" instruction. Workflow **`kavach-build`** runs: phases `Core` (T0 plane, data layer, state+domain, backend services) and `Surface` (components, screens, native module, ops) |
| **27 Jul** | Expo Go rejects the project at SDK 57. **Expo Go abandoned deliberately, not downgraded.** Workflow **`kavach-surface`** re-runs the UI with a fuller design-token contract. JDK/Android SDK installed locally |
| **28 Jul** | Three device bugs reported (onboarding loop, touch lag on PIN entry, dead "Finish Setup" button) plus a 132 MB APK. Workflow **`kavach-v2`**: APK slimming, cross-generational UI polish, Phase-2 remote camera node, status audit. First local release APK built. **First and only real phase measurement: 59% / 70% / 52%** |
| **4 Aug** | "How many phases are done?" + a question about `.claude/skills`. The 59/70/52 figures are **restated verbatim, seven days old, as if current**. Workflow **`kavach-phase0`** (5 agents) closes the paper gaps: 22 ADRs, 9 CI gates, arch-lint, `proto/incident.proto`, `backend/migrations/`, hardware-backed keys, device enrolment. "Everything green. Committing Phase 0." |
| **5 Aug** | Workflow **`kavach-release-hardening`**: four read-only audit passes (UI 37 · perf 23 · size 18 · crash 26 = **104 findings**), fixes routed to five disjoint file scopes, then a verify pass. APK 62.53 MB → **31.97 MB**. `KeyVault.kt` compiles for the first time. **Last day any source file was modified** |
| **7 Aug 15:03** | APK delivered — v1.1.0 build 2, `in.example.kavach`, commit `80ce4e0`, arm64-v8a + armeabi-v7a, min SDK 26 |
| **7 Aug 17:03** | **The new brief:** delete all mock data · Family ID join · phone-number accounts · offline video calling · satellite map with pinch zoom · bottom-nav redesign · privacy into Settings · total redesign |
| **7 Aug 17:05:37** | Workflow **`kavach-status-and-feasibility`** launched to scope it — 4 agents: phase status, mock inventory, offline-call feasibility, satellite-map feasibility |
| **7 Aug 17:07:31** | **All four agents stop mid-reconnaissance. Zero results written.** The session ends at 17:06:02 |
| **7 Aug 20:33** | `DELIVERY.md` written — three hours after the brief, mentioning none of it |
| **9 Aug 22:01** | Everything squashed into one commit, `62ed6839 "Initial Commit"` |
| **11 Aug** | History recovered from transcripts; this documentation spine written. No code touched |

## The six workflow scripts

| Script | `meta.name` — description | Phases |
|---|---|---|
| `kavach-build-wf_a59af83b-209.js` (1058 ln) | `kavach-build` — build all layers against fixed shared contracts | `Core`, `Surface` |
| `kavach-surface-wf_daa92e6b-4af.js` (482 ln) | `kavach-surface` — UI, screens, native module, build config | `Components`, `Screens`, `Platform` |
| `kavach-v2-wf_b874d60a-c74.js` (195 ln) | `kavach-v2` — APK slimming, cross-generational UI polish, Phase 2 remote camera | `V2` |
| `kavach-phase0-wf_26c7d65b-0dd.js` (289 ln) | `kavach-phase0` — close Phase 0: ADRs, CI gates, contracts, hardware keys, enrolment | `Phase 0` |
| `kavach-release-hardening-wf_4501b94f-97a.js` (353 ln) | `kavach-release-hardening` — audit then fix UI/perf/size/crash, verify, prepare release | `Audit`, `Fix`, `Verify` |
| `kavach-status-and-feasibility-wf_490b5218-df0.js` (197 ln) | `kavach-status-and-feasibility` — phase audit, mock inventory, offline call + satellite map feasibility | `Audit` — **never completed** |

Two instructions recur across the scripts and are house doctrine worth keeping:

> "This codebase has repeatedly shipped code with **ZERO CALL SITES**: a module that exists,
> compiles, is tested, and is reachable from nothing. Treat 'exists' and 'is wired up' as different
> questions and report both."

> "On the emergency path the doctrine is **FAIL OPEN** (ADR-018): accept and flag, never reject,
> never throw. Two places invert that and must stay inverted: the envelope builder fails CLOSED when
> it cannot pad, and the camera node fails closed on privacy."

That first rule earned its keep twice: the 28 Jul audit found `noteLocationFix()`,
`evaluateGeofences()` and `connectWs()` all complete, tested and called from nowhere; and the 5 Aug
verify pass caught **three fresh zero-call-site regressions the fix agents had just introduced**
(`countUnacked`, `bootstrapFailures`, `presenceStatus`).

## Contradictions in the record

Flagged so nobody trusts the wrong number again.

1. **59 / 70 / 52 was measured once, on 28 Jul, and quoted four times over ten days.** On 4 Aug it
   was presented as current while being a week old, and it predates the workflow that closed most of
   Phase 0's paper gaps. Retired — see [PHASES.md](../PHASES.md).
2. **"Committing Phase 0"** (4 Aug 17:43) was said the same afternoon Phase 0 was described as 59%,
   with the gap explained as external work and never restated as a number.
3. **An APK size claim was made and retracted.** 5 Aug 16:16 claimed `expo-dev-client` was shipping
   dev modules into release; 16:25 retracted it — Expo already excludes it. Any earlier size
   attribution is untrustworthy; only the measured 31.97 MB is.
4. **Test counts drift unexplained:** 72/72 → 82/82 → 139/139. Only 139/139 has been re-verified
   (11 Aug).

## The question that was asked and never answered

On 07 Aug the last substantive message posed a question that still gates the offline-calling design,
and the session died before it could be answered:

> For "offline video calling", do you mean **same room / same building** — Wi-Fi Direct, ~30–50 m
> indoors, ~100–200 m outdoors, buildable — or **across the city**, which no app can do without a
> network? Wi-Fi Aware is absent on many budget phones and Bluetooth cannot carry video.

It is carried forward as Phase 6.4 in [PHASES.md](../PHASES.md).

## Rules adopted so this cannot recur

- **Never `/clear` without `/handoff`.** [HANDOFF.md](../HANDOFF.md) is the contract.
- **Commit per phase**, not one squashed commit. `62ed6839` destroyed twelve days of bisectable
  history.
- **Re-measure before quoting a status number**, and stamp it with the date it was measured.
