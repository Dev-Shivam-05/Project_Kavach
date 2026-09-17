# HANDOFF — Kavach — land the 5–6 Sep audit + first 6-D preview APK — 2026-09-17

Branch **`shivam`**, pushed, HEAD after this handoff's docs commit (code at `52734150`). Supersedes
the 1 Sep handoff (6-D-7a/b/c/d + 6-D-8), preserved in git history.

## Done

- **Rescued the 5–6 Sep FINAL COMPLETION MODE work.** That session left 111 files (+5080/−1525)
  uncommitted and wrote no handoff. Committed in six units: `3203af49` ops/tools/CI (envlint, Kotlin
  Gate K, per-binary `run-backend.ps1`, untracked `canary.exe` + `.gotmp`), `3d770fc7` realtime-gw
  (golden frame contract), `f5d18ce8` backend internals, `17565a31` mobile native + config plugins,
  `e4f1aec6` mobile app/src + 15 new test files, `cc99b901` README/PROJECT_MAP.
- **Three failing tests were wrong, not the code — tests corrected:**
  - `realtime-gw/testdata/s2c_frames.golden.json`: `frame.undecodable.at` held a wall-clock value
    (`1788636738408`) captured before `golden_test.go` pinned it to `goldenAt`. One value changed.
  - `mobile/test/t0-manifest.test.ts`: `/\.number\b/` matched `plan.number` (SmsPlan's recipient,
    present at HEAD before the audit). Now `(?<!plan)\.number\b`.
  - `mobile/test/t0-process-guard.test.ts`: Java emits `getRunningAppProcesses()`; the test searched
    case-sensitively for `runningAppProcesses`. Now case-insensitive.
- **`52734150`** — `npx expo install expo-font` (expo-doctor: native peer of `@expo/vector-icons`,
  crash risk outside Expo Go). Also added `expo-font` to `app.json` plugins.
- **EAS preview APK built.** Build `f6ace485-6236-4fc1-8d32-82c59e28685e`, versionCode 3, v1.1.0,
  commit `52734150`, finished 17 Sep 19:39.
  APK: https://expo.dev/artifacts/eas/VaEXsoi_It-e8KsYt5Jc2AYivW3OGqpfKvyTaw0i9PA.apk
- **Verified green on this tree:** `tsc --noEmit` 0 errors · `npm test` **361/361** · `go build`,
  `go vet`, staticcheck, archlint (14 packages, 76 edges) clean · `go test` every package passes
  (several needed retries for Application Control; `sos-ingest` and `incident` via `go test -c`
  into `.gotmp`) · `gen:check` in sync · `npm run lint` (schema, proto, env) clean.
  **`-race` not run** (no gcc).

## Known broken / deliberately skipped

- **★ The APK has not been installed on a phone.** Nothing native has been observed yet.
- **It cannot reach a server.** EAS said: *no environment variables … for the "preview"
  environment*. So `10.0.2.2` is baked in, and `withKavachNetworkSecurity` blocks `http://` in
  release. Needs a real HTTPS backend + `eas env:create --environment preview` for
  `EXPO_PUBLIC_KAVACH_API` / `_API_DIRECT` / `_CONTROL` / `_WS`. **Owner: the user.**
- **No Firebase** (no `google-services.json`, no `KAVACH_FCM_CREDENTIALS`) → no push. **Owner: the user.**
- **expo-doctor still reports** 28 SDK-57 patch mismatches (`npx expo install --fix` not run —
  broad lockfile churn, deliberately left) and New-Arch metadata warnings for
  `react-native-webrtc` / `kavach-t0`. The build succeeded regardless.
- **EAS archive is 970 MB**, almost all tracked `.claude/skills` (812 MB). Upload took 6 min. A root
  `.easignore` would fix it, but it *replaces* `.gitignore` rules, so it must copy them — not done.
- EAS printed `Failed to upload metadata … 400 (Bad Request)`; the build was created anyway.
- Gate K (CI Kotlin compile) has still never been seen green — this EAS build compiling the Kotlin
  is the first evidence it compiles at all.
- `.claude/settings.local.json` left uncommitted (local settings). Untracked `.css`/`.css.map`
  noise under `.claude/skills/` left alone.

## Next session starts here

- **Phase: install the APK on a real Android phone and smoke-test** — launch, onboarding, T0
  permissions, foreground agent, a drill SOS (SMS leg). Record what crashes.
- **Then (user-owned):** a reachable HTTPS backend + EAS `preview` env vars, and Firebase — then rebuild.
- **First command:**
  ```
  git checkout shivam && git log --oneline -3
  cd mobile && npx --yes eas-cli@23.2.0 build:view f6ace485-6236-4fc1-8d32-82c59e28685e
  ```
- **Watch out for:** `eas build:view --non-interactive` fails on eas-cli 23.2.0 — run it without
  that flag. Don't report the finished build as a working Family Watch.
