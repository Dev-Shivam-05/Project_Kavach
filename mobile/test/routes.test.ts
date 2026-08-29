/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ROUTE REACHABILITY
 *
 * ★ WHY THIS TEST EXISTS ★
 * This failure has now happened twice in this codebase, and both times it was
 * invisible to the compiler, to the tests, and to a screenshot:
 *
 *   · `app/camera-node.tsx` and `app/camera-view.tsx` — the whole Phase 2
 *     monitoring feature — were valid expo-router routes that NOTHING linked to.
 *   · `app/medical-card.tsx` — the §10.4 break-glass card, the one screen a
 *     paramedic reads off a locked phone — was registered in the root layout and
 *     reachable from nowhere at all.
 *
 * A screen with no entry point is not a smaller feature. It is a feature that
 * does not exist, while every review, every typecheck and every unit test says
 * it does. That is the same shape as the audit's "three complete, tested
 * subsystems with zero call sites", and on a safety product it is the shape that
 * matters most: `medical-card` is the LAST thing still working when everything
 * else has failed, so it being unreachable is worst precisely when it counts.
 *
 * Registration in `_layout.tsx` is NOT reachability — it declares a route to the
 * navigator, it does not give a human a way to get there.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../app');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const files = walk(APP);
const allSource = files.map((f) => readFileSync(f, 'utf8')).join('\n');

/** `app/foo/bar.tsx` → `/foo/bar`, with `/index` collapsed and groups stripped. */
function routeFor(file: string): string {
  let r = file.slice(APP.length).replace(/\\/g, '/').replace(/\.tsx$/, '');
  r = r.replace(/\/\([^)]+\)/g, ''); // (tabs) is a layout group, not a path segment
  if (r.endsWith('/index')) r = r.slice(0, -'/index'.length);
  return r === '' ? '/' : r;
}

/**
 * Routes that are reached by a mechanism other than a literal `router.push`:
 *   · tab routes come from the <Tabs> navigator itself
 *   · `/` is the entry point
 *   · dynamic segments are pushed with a template literal
 *   · onboarding is the redirect target of the entry route
 */
// /consent left the tab bar in the Phase-6 nav (Spec B1 / 6.7); it is now a
// root-Stack route reached from Settings > Privacy, so it must prove that link
// like any other pushed screen rather than being whitelisted as a tab.
const NAVIGATOR_REACHED = new Set(['/', '/home', '/watch', '/map', '/incidents', '/settings']);

test('★ every screen has a way in', () => {
  const orphans: string[] = [];

  for (const file of files) {
    const base = file.split(/[\\/]/).pop()!;
    if (base.startsWith('_')) continue; // layouts are not destinations
    const route = routeFor(file);
    if (NAVIGATOR_REACHED.has(route)) continue;

    // A dynamic route is reached via a template literal, so match its prefix.
    const dynamic = route.includes('[');
    const needle = dynamic ? route.slice(0, route.indexOf('[')) : route;

    // Look for the route in any OTHER file — a screen linking to itself is not
    // an entry point.
    const self = readFileSync(file, 'utf8');
    const elsewhere = allSource.split(self).join('');
    if (!elsewhere.includes(`'${needle}`) && !elsewhere.includes(`\`${needle}`)) {
      orphans.push(route);
    }
  }

  assert.deepEqual(
    orphans,
    [],
    `unreachable screen(s): ${orphans.join(', ')} — registering a route in a ` +
      '_layout does not give anyone a way to open it',
  );
});

test('★ the medical card is reachable FROM the panic screen', () => {
  // §10.4 layer 1. The subject may be unconscious; whoever reached them needs a
  // blood group now, and will not go looking in Settings for it. Being reachable
  // "somewhere in the app" is not the requirement — being one tap from the live
  // incident is.
  const panic = readFileSync(join(APP, 'panic.tsx'), 'utf8');
  assert.match(
    panic,
    /medical-card/,
    'the panic screen must offer the medical card during a live incident',
  );
});

test('the emergency number is never dialled programmatically (ADR-019)', () => {
  // Wrapping or auto-placing the call risks breaking AML, which is the thing
  // that makes a 112 call useful. The dialler handoff must stay a handoff.
  for (const file of files) {
    const s = readFileSync(file, 'utf8');
    assert.ok(
      !/Linking\.openURL\(\s*['"`]tel:112/.test(s) || file.endsWith('Call112Button.tsx'),
      `${file} dials 112 directly; that belongs only in Call112Button`,
    );
  }
});
