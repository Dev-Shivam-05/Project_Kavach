#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * envlint — ops/README.md §5 names every KAVACH_* the backend reads
 *
 * ops/README.md §5 is "the reference an operator is told to trust", and
 * ops/docker-compose.yml is the documented map of what each container is
 * handed. By 6 Sep the table had drifted from the binaries four variables deep
 * (KAVACH_SMS_CEILING, KAVACH_ENV, KAVACH_DEPLOY_OVERRIDE, KAVACH_RT_DEV_FAMILY
 * were all read and none was listed) and claimed one that a binary does not
 * read. A knob nobody can find is a knob nobody sets — for the SMS budget or
 * the deploy override that is an incident-day surprise.
 *
 * Three checks, all mechanical:
 *   1. every `"KAVACH_…"` string literal in backend/ (non-test Go) has a row in
 *      the §5 table of ops/README.md
 *   2. every row in that table names a variable some Go file actually reads
 *      (a stale row is a lie about a knob that no longer exists)
 *   3. every KAVACH_* key set in ops/docker-compose.yml is read by some binary
 *      (compose setting a name the code ignores is exactly the KAVACH_DEV vs
 *      KAVACH_ENV failure: the "production" switch that switched nothing)
 *
 * Usage:  node tools/envlint.mjs
 * Exit:   0 in step · 1 drift, listed
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const README = path.join(ROOT, 'ops', 'README.md');
const COMPOSE = path.join(ROOT, 'ops', 'docker-compose.yml');

function goFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) goFiles(p, out);
    else if (name.endsWith('.go') && !name.endsWith('_test.go')) out.push(p);
  }
  return out;
}

/** var → set of files that read it. Only quoted literals count: a comment can name a variable it does not read. */
const readBy = new Map();
for (const file of goFiles(BACKEND)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/"(KAVACH_[A-Z0-9_]+)"/g)) {
    if (!readBy.has(m[1])) readBy.set(m[1], new Set());
    readBy.get(m[1]).add(path.relative(ROOT, file).replace(/\\/g, '/'));
  }
}

const readme = fs.readFileSync(README, 'utf8');
const documented = new Set([...readme.matchAll(/^\|\s*`(KAVACH_[A-Z0-9_]+)`\s*\|/gm)].map((m) => m[1]));

const compose = fs.readFileSync(COMPOSE, 'utf8');
const composeSets = new Set([...compose.matchAll(/^\s+(KAVACH_[A-Z0-9_]+):/gm)].map((m) => m[1]));

const failures = [];
for (const [v, files] of [...readBy].sort()) {
  if (!documented.has(v)) failures.push(`${v} is read by ${[...files].join(', ')} and has no row in ops/README.md §5`);
}
for (const v of [...documented].sort()) {
  if (!readBy.has(v)) failures.push(`ops/README.md §5 documents ${v}, which no Go file reads — stale row`);
}
for (const v of [...composeSets].sort()) {
  if (!readBy.has(v)) failures.push(`ops/docker-compose.yml sets ${v}, which no Go file reads — the switch switches nothing`);
}

if (failures.length === 0) {
  console.log(`envlint: ${readBy.size} variables read, ${documented.size} documented, ${composeSets.size} set by compose — in step`);
  process.exit(0);
}
console.error('\nenvlint FAILED — ops/README.md §5 / docker-compose.yml drift from the binaries\n');
for (const f of failures) console.error(`  ${f}`);
console.error('\n  A row in the §5 table is `| \\`KAVACH_X\\` | service | default | notes |`.\n');
process.exit(1);
