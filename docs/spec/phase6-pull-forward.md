# SPEC LOCK — Phase 6 pull-forward

Locked 2026-08-21. Approved by the user (`go`) with three additions folded in: a family "private
space" identity (F3), family creation + a size cap (F1/F2), and **100% mock-data removal now in
scope** (G, an explicit override of the earlier "sequence after push" decision).

This file is the contract. A future session with no memory of the chat must build the identical
thing from it. No implementation value may appear that is not in a table here; a missing decision
found mid-build means: stop, add a row, get one-word approval.

Supersedes the "Phase 6 runs after the Phase 1 gate" sequencing (11 Aug) and pulls 6.4/6.5/6.6/6.7/
6.8 **+ 6.1 + a family-identity/size layer** to #1. See [../PHASES.md](../PHASES.md) "#1 PRIORITY",
[../RISK.md](../RISK.md) item 20.

---

## A · Theme & visual rebuild (6.8)

| # | Ambiguity | Locked value | Why |
|---|---|---|---|
| A1 | "different theme" | Keep the dark base + computed-contrast surface/semantic scale; add ONE brand accent = bright teal. Not a light theme, not a hue teardown. | Dark scale is safety-tuned and `test/theme-contrast.test.ts` gates it at 7:1. "Different" comes from accent + full component/nav rebuild. |
| A2 | brand accent | `accent #2DD4BF` (fill) with dark text `#0B0F14` on it · `accentText #5EEAD4` (teal-on-dark text/icon) · `accentSoft #0C2622` · `accentBorder #155E56` | Teal collides with no reserved hue (red=alarm, blue=info/focus, violet=duress, green=ok, amber=warn). Bright-fill-plus-dark-text stays quieter than white-on-red, so red remains the loudest thing. |
| A3 | one loud colour | Alarm red stays the only loud colour. Teal never sits on an SOS or an active incident. | §6.4 one-saturated-colour rule. |
| A4 | "total rebuild" | Rebuild all shared components + every screen onto existing tokens: 4pt `space`, `radius.lg`=16 cards, `shadow`, the 1.22 `font`/`leading` scale. | Rework the look, keep the tested measurement discipline. |
| A5 | animation | No idle/decorative animation. Only: cancel-countdown ring, 120ms press-scale (`PressableScale`), 200ms layer/sheet transitions. | theme.ts §6.4. |
| A6 | contrast rule | Every new fg/bg pair passes `theme-contrast.test.ts` (7:1 body, 3:1 non-text). Hexes may shift a few points to clear it — a locked constraint, not a free choice. | The test is the authority. |

## B · Tab bar + centre SOS button (6.6 + 6.7)

| # | Ambiguity | Locked value | Why |
|---|---|---|---|
| B1 | tab layout | 5 flat tabs → 4 tabs + 1 centre button. Order: `Home · Map · ⦿SOS · Incidents · Settings`. Consent folds into Settings (6.7). | 6.6+6.7 in one change. |
| B2 | centre button | 66px red circle raised 20px above the bar, `danger #C4241F` fill, white SOS glyph 26px, 3px `bg`-coloured ring, "SOS" label 11px caps below. Static — no pulse. | "Voice-assistant style" = the prominence of a Google/Siri centre button. Red because it IS the alarm. No pulse honours A5. |
| B3 | tap | Single tap → existing arm/confirm SOS flow (`panic.tsx`: hold-to-fire + cancel countdown). Not instant fire. | Accidental-press safety; reuses the built cancel window. |
| B4 | haptic | `expo-haptics` `notificationAsync(Warning)` on press-in. | Dep present. |
| B5 | geometry | 60px content height + bottom safe-area inset; glyphs → `react-native-svg` icons; label ALWAYS under every tab. | P-018 glyph-AND-label. |

## C · Live map + member locations (6.5)

| # | Ambiguity | Locked value | Why |
|---|---|---|---|
| C1 | engine | MapLibre GL (`@maplibre/maplibre-react-native`) replaces the hand-drawn SVG map. | Open, no Google billing, offline tile packs (leak-free, ADR-010), satellite raster, native pinch/pan/rotate/pitch. |
| C2 | tiles | MapTiler (API key — user-owned dependency like the FCM key) online; downloadable offline pack for the family's own box. | Phase-6 leak-free path; MapTiler licence permits offline, Google/Mapbox forbid caching. |
| C3 | layers v1 | v1 = Standard (MapTiler Streets) + Satellite, both with pinch/zoom/pan/rotate. Traffic + Street View deferred (E "later"). | Standard+Satellite are offline-capable. Traffic = online paid feed; Street View = separate Google native SDK (panoramas) — both online-only, both leak, both own keys. |
| C4 | "exact location" | Rides existing `live_location` consent grants, mutual-by-default inside a family. Pin + accuracy circle + name/avatar + freshness age. | ADR-010/P-008/F-14: exact AND revocable AND logged, not a silent tracker. |
| C5 | no-grant/paused | Listed as "location not shared", never pinned at last-known. | The honest-absence rule (`FamilyMapView`). Non-negotiable. |
| C6 | cadence | Foreground every 10s (`expo-location`); stale > 15min → dimmed+dashed+age (existing `STALE_MS`). | Matches existing staleness handling. |
| C7 | "you" marker | Teal `accent` dot; others in member colour. | A2. |

## D · Camera + mic — "Family Watch" (6.4)

| # | Ambiguity | Locked value | Why |
|---|---|---|---|
| D1 | transport | WebRTC (`react-native-webrtc`, new native dep) · signalling over existing `realtime-gw` · TURN relay (coturn — new infra). 1↔1 live view. | Across-city (Kabilpore→Surat) rules out offline P2P. |
| D2 | consent model | Auto-allow within the family (frictionless), gated by D3–D5. Superseding ADR required (overturns P-024 + ADR-017). | Matches "har member ko authority", not silently. |
| D3 | **on-device indicator (hard line)** | Mandatory, non-suppressible: target's phone shows a full-width banner "X is viewing your camera / listening" + persistent status dot + short start-sound. Cannot be turned off. Push notifications stay optional; the indicator does not. | The line between a consented family feature and stalkerware. |
| D4 | access log | Every session writes a Class-A access-log row (who, whom, camera/mic, start, end). | A privacy property nobody can see is a promise nobody can check. |
| D5 | target control | The viewed person always holds a "pause access to me" kill that cannot be overruled from another phone. | Mirrors the P-024 kill-switch asymmetry. |
| D6 | recording | Live view only. No recording, no storage of any camera/mic stream. | The app is on record as "IT DOES NOT RECORD". |

## E · Family creation, size cap, private identity (6.2-adjacent — NEW, user-added 21 Aug)

| # | Ambiguity | Locked value | Why |
|---|---|---|---|
| E1 | create a family | A user creates a family: types a `display_name`; app generates the Family ID (existing `family.id` uuid). New `POST /v1/family` already exists (W10-j) — extend it. | Reuses the enrolment seam. |
| E2 | "define its size" | New `max_members` column on the `family` table. Range **2–20**, default **6**. Set at creation, editable by a family admin only. | Worked example was 5; 6 is a sane default, 20 a sane ceiling. |
| E3 | **enforce the cap** | The (`max_members`+1)th member enrolment is refused server-side with 409 `KV-1012 family_full`. Counted over live members in `cmd/control-plane` before `PutMember`/`PutDevice`. | "Us se zyada koi set nahi ho sakta" — enforced at the writer, the only place all members are counted. |
| E4 | naming authority | `max_members` is added to `backend/migrations/0001_init.sql` (family table) AND `store.Family` AND any store_test column list, in the same commit. | ADR-006/D-003: the migration is the naming authority; never invent a persisted field name. |
| E5 | **"private space" identity (F3)** | A visible family-identity surface: `display_name` + a deterministic crest (colour+monogram derived from `family.id`) + the Family ID, shown on the Home header and Settings, with a shield marker + one line "End-to-end within your family — nobody outside can see this." | The "kuch bahut private cheez" — an unmistakable signal this space belongs to THIS family and is private. |
| E6 | Family ID = discovery, not auth | The typed/shown Family ID identifies and helps people find each other; the SAS fingerprint still admits a device. | Phase-6 rule: add a discovery layer, do not replace the security layer. |

## G · 100% mock-data removal (6.1 — NOW IN SCOPE, user override 21 Aug)

| # | Ambiguity | Locked value | Why |
|---|---|---|---|
| G1 | what to remove | Delete `src/domain/demo.ts` (1,261 lines) and every gate site (~40, incl. 17 short-circuited endpoints in `api.ts`), `simulateResponders`, the fake camera peer (`nodeStore.ts:405`), all fixtures. | "Koi bhi mock data nahi chahiye." |
| G2 | demoMode default | `EXPO_PUBLIC_KAVACH_DEMO`/`extra.demoMode` default flips to **false** (`config.ts`, `app.json`). The `demo` build profile is removed too (100% removal); can be re-added later if a showcase build is ever needed. | 100% means no demo path in a default build. |
| G3 | sequencing | Mock removal is the LAST step of Phase 6-A, landing together with the family-create real-data path (E). Screens are then driven by real enrolment/incidents only. | Deleting demo data before the real-data path empties Home/incidents/consent/drills/vault. |
| G4 | expected consequence | After removal, an app with no family/members/incidents shows real empty states, not fabricated ones. Each screen must have an honest empty state (no adjectives — a "create/join a family" CTA on Home, "no incidents" on Incidents, etc.). | This is correct post-removal behaviour, not a regression. |

## Build order

| Phase | Contents | Verifiable on THIS machine? |
|---|---|---|
| 6-A | Theme+accent (A) · component/screen rebuild (A4) · tab bar + centre SOS (B) · Consent→Settings · **family create + size cap + private identity (E)** · **100% mock removal (G, last)** | ✅ Yes — pure TS/RN + Go/control-plane + migration. `tsc`, mobile tests, contrast test, `go test`, archlint, LOC budget all run here. Ships first, fully. |
| 6-B | MapLibre + Standard/Satellite + live-location pins on consent grants (C) | ⚠️ Partly — TS logic + consent wiring testable here; native map + MapTiler key need a device build (no Android toolchain, D-021). |
| 6-C | Family Watch camera+mic (D) + superseding ADR | ❌ No — native WebRTC + TURN infra + device. Design + ADR locked; verified only on a real build. Ships last. |
| later | Traffic overlay + Street View (online-only, own keys) | separate |

## OUT OF SCOPE
- Light theme / different base hue (unless A1 vetoed).
- Street View + live Traffic in v1 (deferred, online-only, own keys).
- Recording camera/mic (D6).
- Group/N-way calls — v1 is 1↔1.
- Member removal, family deletion, passkeys.

## ACCEPTANCE CRITERIA (binary)
- [ ] Tab bar shows exactly 4 labelled tabs + a 66px red centre SOS button raised 20px; Consent is no longer a tab.
- [ ] Centre button tap opens the arm/cancel-countdown SOS flow (does not fire instantly).
- [ ] `theme-contrast.test.ts` passes with the new palette; `tsc --noEmit` and `npm test` green.
- [ ] A user can create a family, set a size 2–20, and see the family's private identity (name + crest + ID + shield line) on Home.
- [ ] Enrolling one member past `max_members` is refused with 409 `KV-1012 family_full`; `go test ./...`, archlint, LOC budget, staticcheck green; `max_members` present in the migration, `store.Family`, and store_test.
- [ ] `src/domain/demo.ts` is deleted, `demoMode` defaults false, `grep -rn "demo" src/` shows no runtime gate; every screen renders an honest empty state with no fabricated data.
- [ ] (6-B) Map renders Standard + Satellite; pinch/pan/rotate work; a member with a live grant shows a pin+accuracy+age; no grant → "location not shared", never pinned.
- [ ] (6-C) Starting a camera/mic session raises an undismissable banner + dot + start-sound on the target and writes one access-log row; the viewed member can end it from their own phone and it cannot be restarted remotely.

## RISKS
- 6-C is the least-verifiable, highest-cost piece (native WebRTC + TURN + device). Cheapest early check: audio-only 1↔1 over `realtime-gw` on two physical devices before video/UI.
- Map/camera need user-owned keys + infra (MapTiler key, TURN server) — same shape as the pending FCM key.
- 6-B/6-C cannot be compiled here (D-021). TS/logic buildable+testable; "runs on a phone" needs a device build the user triggers.
- Superseding ADRs required for D2 (vs P-024/ADR-017) and C2 (vs ADR-010) — written per phase, not skipped.
- **Mock removal (G) empties every screen unless the real-data path lands with it** — hence G3 sequencing.
