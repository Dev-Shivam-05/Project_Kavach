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
 *
 * ★ WHAT "A WAY IN" MEANS (hardened 6 Sep) ★
 * Until then this test did a raw substring search for `'/route` over whole
 * files. A JSDoc line in `watch.tsx` ("…and pushes `/watch-session`…") satisfied
 * it on its own; deleting the real `router.push('/watch-session')` left it
 * green. It also never entered `src/`, so the real entry points there
 * (`notifications.ts` pushing `/incident/…`, `SosHeaderButton` pushing
 * `/panic`, the tab bar itself) were invisible and the tab routes had to be
 * hand-whitelisted. Now an entry point is a literal INSIDE a navigation call —
 * `router.push|replace|navigate(…)`, a JSX `href=`, or an `{ href: … }` object
 * — on a line that is not a comment, anywhere under `app/` or `src/`, in a file
 * other than the screen itself. Static routes match exactly (`/map-legacy` does
 * not reach `/map`); dynamic routes match a template whose static head is the
 * route's prefix.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(MOBILE, 'app');
const SRC = join(MOBILE, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (file: string): string => relative(MOBILE, file).replace(/\\/g, '/');

/** `app/foo/bar.tsx` → `/foo/bar`, with `/index` collapsed and groups stripped. */
function routeFor(file: string): string {
  let r = file.slice(APP.length).replace(/\\/g, '/').replace(/\.tsx$/, '');
  r = r.replace(/\/\([^)]+\)/g, ''); // (tabs) is a layout group, not a path segment
  if (r.endsWith('/index')) r = r.slice(0, -'/index'.length);
  return r === '' ? '/' : r;
}

/** A line that is prose, not code. JSDoc continuation lines start with `*`. */
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

/**
 * A route literal in a navigation context. The three shapes this codebase uses:
 *   router.push('/x')  router.replace(`/incident/${id}`)  router.navigate(d.href)
 *   <Redirect href="/onboarding" />   <Link href={'/x'}>
 *   { href: '/home', icon: … }        (TabBar's DESTS — the tab routes' way in)
 * A type union like `href: '/home' | '/watch'` is not a way in and is excluded
 * by requiring the object-literal brace before `href:`.
 */
const NAV_LITERAL = /(?:router\.(?:push|replace|navigate)\(\s*|\bhref=\{?\s*|\{\s*href:\s*)(['"`])([^'"`]+)\1/g;

type Entry = { file: string; route: string; dynamic: boolean };

/** Every navigation literal in the tree, normalised to the route it opens. */
function entryPoints(files: string[]): Entry[] {
  const out: Entry[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (isCommentLine(line)) continue;
      for (const m of line.matchAll(NAV_LITERAL)) {
        let text = m[2].replace(/\/\([^)]+\)/g, ''); // `/(tabs)/home` → `/home`
        const dynamic = text.includes('${');
        if (dynamic) text = text.slice(0, text.indexOf('${'));
        text = text.split('?')[0];
        out.push({ file: rel(file), route: text, dynamic });
      }
    }
  }
  return out;
}

const routeFiles = walk(APP).filter((f) => f.endsWith('.tsx'));
const entries = entryPoints([...walk(APP), ...walk(SRC)]);

/**
 * Routes whose only way in is a navigation call on a VARIABLE, which the literal
 * scan above cannot see. Each is pinned to the exact file, literal and call that
 * make it reachable, and the test asserts all three — so this is a checked entry
 * point, not a whitelist: delete either line in `_layout.tsx` and it fails.
 */
const INDIRECT: Record<string, { file: string; literal: RegExp; call: RegExp }> = {
  // T0Presenter: `const target = t0State === 'PROBE' ? '/probe' : … ; router.push(target)`
  '/probe': { file: 'app/_layout.tsx', literal: /'\/probe'/, call: /router\.(?:push|replace)\(target\)/ },
};

test('★ every screen has a way in', () => {
  const orphans: string[] = [];

  for (const file of routeFiles) {
    const base = file.split(/[\\/]/).pop()!;
    if (base.startsWith('_')) continue; // layouts are not destinations
    const route = routeFor(file);
    if (route === '/') continue; // the entry route is where the app starts

    const self = rel(file);
    const dynamic = route.includes('[');
    const prefix = dynamic ? route.slice(0, route.indexOf('[')) : route;

    // Look for the route in any OTHER file — a screen linking to itself is not
    // an entry point. A dynamic route is reached by a template (or a string
    // concatenation) whose static head is the route's prefix.
    const reached = entries.some(
      (e) => e.file !== self && (dynamic ? e.route === prefix : e.route === route && !e.dynamic),
    );
    if (reached) continue;

    const indirect = INDIRECT[route];
    if (indirect) {
      const src = readFileSync(join(MOBILE, indirect.file), 'utf8')
        .split('\n')
        .filter((l) => !isCommentLine(l))
        .join('\n');
      if (indirect.literal.test(src) && indirect.call.test(src)) continue;
    }
    orphans.push(route);
  }

  assert.deepEqual(
    orphans,
    [],
    `unreachable screen(s): ${orphans.join(', ')} — registering a route in a ` +
      '_layout does not give anyone a way to open it; prose in a comment does not either',
  );
});

test('prose is not a way in — the scanner itself', () => {
  // The exact shapes that fooled the old substring search, and the ones that
  // must still count. Pinned here so a "simplification" of NAV_LITERAL or
  // isCommentLine cannot quietly reopen the hole.
  const scan = (line: string): string[] =>
    isCommentLine(line) ? [] : [...line.matchAll(NAV_LITERAL)].map((m) => m[2]);

  assert.deepEqual(scan(" * `state/watchSession.ts` and pushes `/watch-session`. There is no"), []);
  assert.deepEqual(scan("// router.push('/watch-session') used to live here"), []);
  assert.deepEqual(scan("const INCIDENT_ROUTES = ['/panic', '/probe'];"), [], 'a list is not a call');
  assert.deepEqual(scan("  href: '/home' | '/watch' | '/map';"), [], 'a type union is not a call');
  assert.deepEqual(scan("  router.push('/watch-session');"), ['/watch-session']);
  assert.deepEqual(scan('  if (!onboarded) return <Redirect href="/onboarding" />;'), ['/onboarding']);
  assert.deepEqual(scan("  { href: '/home', icon: 'home', label: t('tab.home') },"), ['/home']);
  assert.deepEqual(scan('    router.push(`/incident/${incidentId}`);'), ['/incident/${incidentId}']);
});

test('the tab routes are derived from the tab bar, not whitelisted', () => {
  // The <Tabs> navigator's destinations live in src/ui/TabBar.tsx, outside app/.
  // This is why the scan walks src/: a tab dropped from DESTS is a screen with
  // no way in, and it used to be hidden behind a hand-maintained set.
  const tabs = entries.filter((e) => e.file === 'src/ui/TabBar.tsx').map((e) => e.route);
  for (const expected of ['/home', '/watch', '/map', '/incidents', '/settings']) {
    assert.ok(tabs.includes(expected), `TabBar.tsx no longer navigates to ${expected}`);
  }
});

test('★ the medical card is reachable FROM the panic screen', () => {
  // §10.4 layer 1. The subject may be unconscious; whoever reached them needs a
  // blood group now, and will not go looking in Settings for it. Being reachable
  // "somewhere in the app" is not the requirement — being one tap from the live
  // incident is. And it must be a navigation call, not a mention in a comment.
  assert.ok(
    entries.some((e) => e.file === 'app/panic.tsx' && e.route === '/medical-card'),
    'the panic screen must offer the medical card during a live incident',
  );
});

test('the emergency number is never dialled programmatically (ADR-019)', () => {
  // Wrapping or auto-placing the call risks breaking AML, which is the thing
  // that makes a 112 call useful. The dialler handoff must stay a handoff, and
  // it lives in exactly two places: Call112Button (the constant 112) and the
  // medical card (a contact's number off the card, never a constant). The whole
  // component tree is scanned — the only dialler lives under src/, which the
  // old app/-only walk never visited, so its exemption was unreachable.
  const ALLOWED = new Set(['src/ui/components/Call112Button.tsx', 'app/medical-card.tsx']);
  const diallers = new Map<string, string>(); // file → the code lines that dial

  for (const file of [...walk(APP), ...walk(SRC)]) {
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => !isCommentLine(l) && /tel:/.test(l));
    if (code.length) diallers.set(rel(file), code.join('\n'));
  }

  assert.deepEqual(
    [...diallers.keys()].sort(),
    [...ALLOWED].sort(),
    'a tel: dial appeared outside Call112Button / medical-card, or one of those stopped dialling',
  );
  assert.match(diallers.get('src/ui/components/Call112Button.tsx')!, /tel:112/, 'Call112Button must dial 112 itself');
  assert.doesNotMatch(
    diallers.get('app/medical-card.tsx')!,
    /tel:\d/,
    'the medical card dials a contact off the card, never a hard-coded number',
  );
  assert.match(diallers.get('app/medical-card.tsx')!, /tel:\$\{/);
});
