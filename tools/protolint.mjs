#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * protolint — additive-only guard for the critical-path wire contract
 *
 * Reads    proto/incident.proto
 * Against  proto/.incident.lock.json   (checked in; the shape of every field that
 *                                       has ever been published)
 *
 * NFR-016 / §8.4 / P-060: grandma will not update. A phone running last year's
 * build is the one that has to reach help, so /v1 is frozen and additive-only.
 * Adding a field is always safe — an old decoder skips what it does not know.
 * Everything else is not:
 *
 *   removed field      an old client keeps sending it; the server stops reading it
 *   changed number     the same bytes now mean a different field
 *   changed type       the bytes are reinterpreted, usually as garbage
 *   changed label      `optional` is explicit field presence. Dropping it on
 *                      duress omits `false` from the wire, the envelope shrinks,
 *                      and threat T4 reads the duress bit off the packet size (F-01)
 *   reused number      the worst of the four: it type-checks and it decodes
 *
 * Usage:  node tools/protolint.mjs            check (CI)
 *         node tools/protolint.mjs --update   rewrite the lock after a deliberate add
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTO = path.join(ROOT, 'proto', 'incident.proto');
const LOCK = path.join(ROOT, 'proto', '.incident.lock.json');
const UPDATE = process.argv.includes('--update');
const LOCK_VERSION = 1;

// ── parse ─────────────────────────────────────────────────────────────────────

/** Comments carry field numbers in prose; strip them before scanning statements. */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < src.length) {
        out += src[i];
        if (src[i] === '\\') {
          i++;
          if (i < src.length) out += src[i];
          i++;
          continue;
        }
        if (src[i] === c) break;
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

const FIELD_RE =
  /^(?:(optional|repeated|required)\s+)?((?:map\s*<[^>]*>)|[A-Za-z_][\w.]*)\s+([A-Za-z_]\w*)\s*=\s*(\d+)$/;
const ENUM_VALUE_RE = /^([A-Za-z_]\w*)\s*=\s*(-?\d+)$/;
const BLOCK_RE = /(message|enum|oneof|service|extend)\s+([A-Za-z_][\w.]*)\s*$/;

/** Reserved takes numbers, ranges and quoted names; all three block reuse. */
function parseReserved(rest) {
  const out = [];
  for (const part of rest.split(',')) {
    const t = part.trim();
    let m;
    if ((m = /^(\d+)\s+to\s+(\d+)$/.exec(t))) {
      for (let n = Number(m[1]); n <= Number(m[2]); n++) out.push(n);
    } else if ((m = /^(\d+)\s+to\s+max$/.exec(t))) {
      out.push(Number(m[1]));
    } else if (/^\d+$/.test(t)) {
      out.push(Number(t));
    } else if ((m = /^["'](.+)["']$/.exec(t))) {
      out.push(m[1]);
    }
  }
  return out;
}

function parseProto(src, fatal) {
  const clean = stripComments(src);
  const messages = {};
  const enums = {};
  const stack = [];
  let buf = '';

  const enclosing = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === 'message' || stack[i].kind === 'enum') return stack[i];
    }
    return null;
  };

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];

    if (c === '{') {
      const m = BLOCK_RE.exec(buf.trim());
      buf = '';
      if (!m) {
        stack.push({ kind: 'anon', name: null });
        continue;
      }
      const named = m[1] === 'message' || m[1] === 'enum';
      const parent = stack
        .filter((s) => s.kind === 'message')
        .map((s) => s.simple)
        .join('.');
      const name = named && parent ? `${parent}.${m[2]}` : m[2];
      stack.push({ kind: m[1], name: named ? name : null, simple: m[2] });
      if (m[1] === 'message' && !messages[name]) messages[name] = { fields: {}, reserved: [] };
      if (m[1] === 'enum' && !enums[name]) enums[name] = { values: {}, reserved: [] };
      continue;
    }

    if (c === '}') {
      stack.pop();
      buf = '';
      continue;
    }

    if (c === ';') {
      const stmt = buf.trim().replace(/\s+/g, ' ');
      buf = '';
      if (!stmt) continue;
      const owner = enclosing();
      if (!owner) continue; // syntax / package / import / file-level option

      if (stmt.startsWith('option ')) continue;
      const res = /^reserved (.+)$/.exec(stmt);
      if (res) {
        const target = owner.kind === 'message' ? messages[owner.name] : enums[owner.name];
        target.reserved.push(...parseReserved(res[1]));
        continue;
      }

      const bare = stmt.replace(/\[[^\]]*\]/g, '').trim();
      if (owner.kind === 'message') {
        const f = FIELD_RE.exec(bare);
        if (!f) {
          fatal(`${owner.name}: cannot parse "${stmt}"`);
          continue;
        }
        messages[owner.name].fields[f[3]] = {
          number: Number(f[4]),
          type: f[2].replace(/\s+/g, ''),
          label: f[1] ?? 'singular',
        };
      } else {
        const v = ENUM_VALUE_RE.exec(bare);
        if (!v) {
          fatal(`${owner.name}: cannot parse "${stmt}"`);
          continue;
        }
        enums[owner.name].values[v[1]] = Number(v[2]);
      }
      continue;
    }

    buf += c;
  }

  if (stack.length) fatal(`unbalanced braces: ${stack.length} block(s) left open`);
  return { messages, enums };
}

// ── snapshot ──────────────────────────────────────────────────────────────────

function snapshot({ messages, enums }) {
  const out = { lockVersion: LOCK_VERSION, source: 'proto/incident.proto', messages: {}, enums: {} };
  for (const name of Object.keys(messages).sort()) {
    const fields = {};
    for (const [f, d] of Object.entries(messages[name].fields).sort((a, b) => a[1].number - b[1].number)) {
      fields[f] = { number: d.number, type: d.type, label: d.label };
    }
    out.messages[name] = { fields, reserved: [...messages[name].reserved].sort() };
  }
  for (const name of Object.keys(enums).sort()) {
    const values = {};
    for (const [v, n] of Object.entries(enums[name].values).sort((a, b) => a[1] - b[1])) values[v] = n;
    out.enums[name] = { values, reserved: [...enums[name].reserved].sort() };
  }
  return out;
}

// ── compare ───────────────────────────────────────────────────────────────────

function compare(lock, now) {
  const breaks = [];
  const additions = [];

  for (const [msg, was] of Object.entries(lock.messages ?? {})) {
    const is = now.messages[msg];
    if (!is) {
      breaks.push(`message ${msg} removed — a client still sends it`);
      continue;
    }
    const nowByNumber = new Map(Object.entries(is.fields).map(([f, d]) => [d.number, f]));
    for (const [field, w] of Object.entries(was.fields)) {
      const n = is.fields[field];
      if (!n) {
        const taken = nowByNumber.get(w.number);
        breaks.push(
          taken
            ? `${msg}.${field} = ${w.number} removed and ${w.number} reissued to ${taken} — old bytes now decode as the wrong field`
            : `${msg}.${field} = ${w.number} removed — reserve the number instead`,
        );
        continue;
      }
      if (n.number !== w.number) breaks.push(`${msg}.${field}: number ${w.number} → ${n.number}`);
      if (n.type !== w.type) breaks.push(`${msg}.${field}: type ${w.type} → ${n.type}`);
      if (n.label !== w.label) {
        breaks.push(
          `${msg}.${field}: label ${w.label} → ${n.label}` +
            (w.label === 'optional' ? ' — losing explicit presence changes the wire size (F-01)' : ''),
        );
      }
    }
    const reserved = new Set(was.reserved ?? []);
    for (const [field, n] of Object.entries(is.fields)) {
      if (was.fields[field]) continue;
      if (reserved.has(n.number)) breaks.push(`${msg}.${field} = ${n.number} uses a RESERVED number`);
      else if (reserved.has(field)) breaks.push(`${msg}.${field} reuses a RESERVED name`);
      else additions.push(`${msg}.${field} = ${n.number} (${n.label === 'singular' ? '' : n.label + ' '}${n.type})`);
    }
  }

  for (const [en, was] of Object.entries(lock.enums ?? {})) {
    const is = now.enums[en];
    if (!is) {
      breaks.push(`enum ${en} removed`);
      continue;
    }
    for (const [value, w] of Object.entries(was.values)) {
      if (!(value in is.values)) {
        breaks.push(`${en}.${value} = ${w} removed — an old client still sends that number`);
        continue;
      }
      if (is.values[value] !== w) breaks.push(`${en}.${value}: number ${w} → ${is.values[value]}`);
    }
    for (const [value, n] of Object.entries(is.values)) {
      if (!(value in was.values)) additions.push(`${en}.${value} = ${n}`);
    }
  }

  for (const [msg, is] of Object.entries(now.messages)) {
    if (!lock.messages?.[msg]) additions.push(`message ${msg}`);
  }
  for (const en of Object.keys(now.enums)) {
    if (!lock.enums?.[en]) additions.push(`enum ${en}`);
  }

  return { breaks, additions };
}

/** Duplicates are a defect in the file itself, lock or no lock. */
function selfCheck({ messages, enums }) {
  const breaks = [];
  for (const [msg, m] of Object.entries(messages)) {
    const seen = new Map();
    for (const [field, d] of Object.entries(m.fields)) {
      if (seen.has(d.number)) breaks.push(`${msg}: ${seen.get(d.number)} and ${field} share number ${d.number}`);
      seen.set(d.number, field);
      if (m.reserved.includes(d.number)) breaks.push(`${msg}.${field} = ${d.number} is declared reserved`);
    }
  }
  for (const [en, e] of Object.entries(enums)) {
    const seen = new Map();
    for (const [value, n] of Object.entries(e.values)) {
      // Aliases need `option allow_alias`, which this contract does not use.
      if (seen.has(n)) breaks.push(`${en}: ${seen.get(n)} and ${value} share number ${n}`);
      seen.set(n, value);
    }
  }
  return breaks;
}

// ── run ───────────────────────────────────────────────────────────────────────

const parseErrors = [];
if (!fs.existsSync(PROTO)) {
  console.error(`✖ missing ${path.relative(ROOT, PROTO)}`);
  process.exit(2);
}
const parsed = parseProto(fs.readFileSync(PROTO, 'utf8'), (e) => parseErrors.push(e));
if (parseErrors.length) {
  console.error('✖ proto/incident.proto did not parse:\n' + parseErrors.map((e) => '  - ' + e).join('\n'));
  process.exit(2);
}

const current = snapshot(parsed);
const fieldCount = Object.values(current.messages).reduce((n, m) => n + Object.keys(m.fields).length, 0);

const selfBreaks = selfCheck(parsed);
if (selfBreaks.length) {
  console.error('✖ proto/incident.proto is internally inconsistent:\n' + selfBreaks.map((b) => '  - ' + b).join('\n'));
  process.exit(1);
}

const serialised = JSON.stringify(current, null, 2) + '\n';

if (!fs.existsSync(LOCK)) {
  if (!UPDATE) {
    console.error(`✖ missing ${path.relative(ROOT, LOCK)} — create it with: node tools/protolint.mjs --update`);
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, serialised);
  console.log(`  ✔ wrote ${path.relative(ROOT, LOCK)} (initial)`);
  process.exit(0);
}

const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
if (lock.lockVersion !== LOCK_VERSION) {
  console.error(`✖ lock format is v${lock.lockVersion}, this tool writes v${LOCK_VERSION}`);
  process.exit(2);
}

const { breaks, additions } = compare(lock, current);

if (breaks.length) {
  console.error('✖ BREAKING CHANGE to proto/incident.proto:\n' + breaks.map((b) => '  - ' + b).join('\n'));
  console.error(
    '\n/v1 is additive-only (§8.4, P-060). A device that never updates still speaks the old\n' +
      'contract. Add a new field with a new number and leave the old one alone; if it is\n' +
      'truly dead, keep the declaration and stop reading it, or `reserved` the number.',
  );
  process.exit(1);
}

if (UPDATE) {
  if (serialised === fs.readFileSync(LOCK, 'utf8')) {
    console.log(`  = ${path.relative(ROOT, LOCK)}`);
  } else {
    fs.writeFileSync(LOCK, serialised);
    console.log(`  ✔ ${path.relative(ROOT, LOCK)} updated`);
  }
} else if (additions.length) {
  console.log('  additive changes (allowed) — run --update to record them:');
  for (const a of additions) console.log(`    + ${a}`);
}

console.log(
  `\n✔ ${Object.keys(current.messages).length} messages · ${fieldCount} fields · ` +
    `${Object.keys(current.enums).length} enums — additive-only`,
);
