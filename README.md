# PROJECT KAVACH

> कवच — "armour". A private, offline-capable, privacy-first family safety and
> coordination platform.

This repository contains the full analysis, architecture, and implementation of
Project Kavach, built from `Project-Kavach-Family-Safety-Platform-PRD-v1.0.md`.

---

## What is here

| Path | Contents |
|---|---|
| `Project-Kavach-...-PRD-v1.0.md` | The source PRD (3,371 lines) |
| `docs/` | Analysis, corrected architecture, implementation guide, pros/cons |
| `spec/state-machine.yaml` | ★ Single source of truth for the incident state machine |
| `tools/smgen.mjs` | Codegen: YAML → TypeScript + Go + shared conformance fixtures |
| `mobile/` | Expo / React Native / TypeScript application |
| `mobile/modules/kavach-t0/` | ★ Native Kotlin Tier-0 module (real survival plane) |
| `backend/` | Go services: `sos-ingest`, `control-plane`, `realtime-gw`, `canary` |
| `ops/` | Run scripts and compose configuration |

---

## Quick start

### 1. Run the app (no backend needed)

```bash
cd mobile && npm install && npx expo start
```

Scan the QR code with **Expo Go** (Android). The app runs fully standalone in
demo mode: incidents open locally, the state machine runs, the alarm sounds, the
escalation ladder advances on real timers, and simulated family responders claim.

### 2. Run the backend (optional — enables the real ingest path)

```bash
pwsh ops/run-backend.ps1
```

Starts `sos-ingest` (:8081), `control-plane` (:8080), `realtime-gw` (:8082) and
the `canary` (:9090). Requires only Go — no Docker, no Postgres, no external
dependencies.

### 3. Verify

```bash
cd mobile && npm run verify
```

Runs the TypeScript typecheck and the invariant suite.

```bash
cd backend && go test ./...
```

Runs the Go suite, including the **same** state-machine conformance fixtures the
TypeScript client runs. If those two ever disagree, the implementations have
diverged and the build fails — which is the entire point of `spec/state-machine.yaml`.

---

## Three things to understand before reading the code

### 1. The three-plane model, and the Prime Directive

```
T0 · SURVIVAL      native, on-device, deterministic. MUST work with no network,
                   2% battery, screen locked, app force-stopped, user unconscious.
T1 · COORDINATION  network fan-out, acknowledgment, live location. Degrades to SMS.
T2 · INTELLIGENCE  automation, geofences, AI, dashboards. May be down for a week.

              ▲ dependencies flow DOWNWARD only. Never upward. ▲
```

**T0 never awaits T1. T1 never blocks on T2.** If you find yourself writing code
where an SOS trigger awaits a response from the intelligence plane, stop — you
have introduced the exact failure mode this project exists to prevent.

The falsifiable test: kill the JS runtime and verify the SOS gesture still fires,
the SMS still sends, the alarm still sounds, and the black box still seals.

### 2. Fail open on the safety path

A deliberate inversion of standard security doctrine, and it is documented here
so that no future reviewer "fixes" it:

> Ambiguous signature? Unknown device? Expired token? **Accept the incident and
> flag it.** A false alarm costs a phone call. A suppressed real alarm costs a life.

`sos-ingest` accepts unverified incidents and marks them `UNVERIFIED`. The `401`
error code instructs the client to **retry anyway**. Rate limiting is never
applied to a family's first incident.

The one correction we made to the PRD here: fail-open is now **bounded**. The
exemption is scoped to *known families* and rate-limited per family rather than
per device, and excess unverified incidents are **coalesced, never dropped** —
which preserves fail-open semantics exactly while capping blast radius.

### 3. Consent is an expiring graph, not a setting

`consent_grant.expires_at` is `NOT NULL`. **There is no permanent grant** — the
schema makes one impossible to create. Every read of another member's data writes
an access-log row, and a background job surfaces it *to the observed person*.
Administration is separated from observation: a guardian can manage membership
and policy but **cannot** silently view an adult's location.

This is a *reliability* feature, not a courtesy. A teenager who can see the
autonomy ramp loosening on a published schedule is dramatically less likely to
sabotage the system than one who cannot.

---

## Invariants

These are enforced by tests, not by convention. See `mobile/test/invariants.test.ts`.

| # | Invariant |
|---|---|
| I-1 | T0 never synchronously awaits T1 or T2 |
| I-2 | The emergency SMS payload is pure ASCII and ≤160 chars |
| I-3 | Zero Class-A plaintext at rest on the server |
| I-4 | `incident_event` is append-only |
| I-5 | No permanent consent grants |
| I-6 | No log line ever contains location, names, phone numbers, or message content |
| I-7 | Duress and normal-cancel are indistinguishable by packet size and timing |
| I-8 | `incident_id` is a client-generated UUIDv7; the server never allocates one |
| I-9 | Transports fire in **parallel**, never sequentially |
| I-10 | AI adjusts a confidence input; AI never decides |
| I-14 | The system never auto-dials 112 |

---

## What this system is not

- **It is not a replacement for emergency services.** It cannot dispatch police,
  fire, or an ambulance, and it never claims to. At escalation level 3 it puts a
  full-screen `CALL 112` button on every family device with the coordinates
  pre-formatted for reading aloud, and then gets out of the way.
- **It is not a surveillance product.** Several capabilities that would be
  technically easy are permanently excluded on principle — see the "NEVER build"
  list in the PRD §1.4.3. The generalisation: *any feature whose primary user is
  the watcher rather than the watched.*
- **It may fail.** It is a second layer, not the first.

---

## Documentation

| Document | What it covers |
|---|---|
| [docs/00-INDEX.md](docs/00-INDEX.md) | Index + the 23 findings against the PRD |
| [docs/01-Analysis-and-Core-Requirements.md](docs/01-Analysis-and-Core-Requirements.md) | Requirement inventory, invariants, findings |
| [docs/02-System-Architecture.md](docs/02-System-Architecture.md) | The corrected, implementable architecture |
| [docs/03-Implementation-Guide.md](docs/03-Implementation-Guide.md) | Phase-by-phase build order with exit criteria |
| [docs/04-Pros-and-Cons-Analysis.md](docs/04-Pros-and-Cons-Analysis.md) | Rated evaluation across 11 dimensions |
| [DELIVERY.md](DELIVERY.md) | What was built, how to run it, and what is honestly not covered |

---

> **A family safety platform is not a feature set. It is a chain, and its value
> equals the reliability of its weakest link at the exact moment it is needed —
> which will be the moment when the battery is dead, the network is gone, and
> nobody is looking at their phone.**
