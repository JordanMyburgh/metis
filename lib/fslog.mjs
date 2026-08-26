// fslog.mjs — the Metis file-access diagnostic log.
//
// One line per file-system touch, JSONL, append-only, rolling. The schema is fixed
// and every field is mandatory, because the point of this log is to answer "did the
// agent go to the right file, how did it find it, and how long did that cost" without
// you having to reconstruct it from a transcript afterwards.
//
// SINGLE WRITER. The server owns this file. Hooks and CLI callers POST to
// /api/fs/touch and the server appends; if the server is down they append to the
// SPOOL instead, which the server drains on startup and periodically. Two processes
// appending to one log is a race that eats lines exactly when you most want them.
import fs from 'node:fs';
import path from 'node:path';

export const LOG_NAME = 'metis_file_access.log';
export const SPOOL_NAME = 'metis_file_access.spool.log';

const MAX_LINES = Number(process.env.METIS_FS_LOG_LINES || 5000);
const RING = Number(process.env.METIS_FS_LOG_RING || 400);

// The eight fields the log contract promises, in a fixed order so a raw `tail` of the
// file is readable without a parser.
export function makeEntry(e) {
  const o = e || {};
  return {
    ts: o.ts || new Date().toISOString(),           // ISO-8601 with milliseconds
    trigger: o.trigger || 'unknown',                // what caused the lookup
    via: o.via || 'unknown',                        // skill:FileSearch | hook:PreToolUse | api
    tool: o.tool || null,                           // the Claude tool, when there was one
    methods: Array.isArray(o.methods) ? o.methods : [],   // ordered ladder + outcome each
    method: o.method || null,                       // the one that actually resolved it
    requested: o.requested === undefined ? null : o.requested,
    resolved: o.resolved === undefined ? null : o.resolved,
    createdNodes: Array.isArray(o.createdNodes) ? o.createdNodes : [],
    prunedNodes: Array.isArray(o.prunedNodes) ? o.prunedNodes : [],
    ok: o.ok !== false,
    error: o.error || null,
    ms: typeof o.ms === 'number' ? Math.round(o.ms) : null,
    reason: o.reason || null,                       // free-text "why this file"
    shape: o.shape || null,                         // 'files' | 'notes' — which ladder order ran
    session: o.session || null,
  };
}

// A method attempt, rendered for humans as "metis-index -> miss" / "ripgrep -> hit(3)".
export function attempt(name, ok, ms, note) {
  return { name, ok: !!ok, ms: typeof ms === 'number' ? Math.round(ms) : null, note: note || null };
}
export function methodLine(methods) {
  return (methods || [])
    .map((m) => m.name + ' -> ' + (m.ok ? 'hit' : (m.note === 'skipped' || m.note === 'unavailable' ? m.note : 'miss'))
      + (m.ms === null ? '' : ' (' + m.ms + 'ms)'))
    .join(' | ');
}

export class FsLog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, LOG_NAME);
    this.spool = path.join(dir, SPOOL_NAME);
    this.ring = [];
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already there */ }
    this.lines = this.countLines();
    this.warm();
  }

  countLines() {
    try { return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
  }

  // Keep the tail hot in memory so "dump the log" never re-reads the whole file.
  warm() {
    try {
      const all = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      this.ring = all.slice(-RING).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { this.ring = []; }
  }

  append(entry) {
    const e = makeEntry(entry);
    try {
      fs.appendFileSync(this.file, JSON.stringify(e) + '\n', 'utf8');
      this.lines++;
      if (this.lines > MAX_LINES) this.rotate();
    } catch { /* never let logging break the lookup it is describing */ }
    this.ring.push(e);
    if (this.ring.length > RING) this.ring.shift();
    return e;
  }

  // Rolling, not unbounded: keep the newest half, and keep exactly one previous
  // generation on disk. Trimming in place (rather than a .1/.2/.3 ladder) means the
  // path in the docs is always the file you want to read.
  rotate() {
    try {
      const all = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      const keep = all.slice(-Math.floor(MAX_LINES / 2));
      fs.writeFileSync(this.file + '.1', all.slice(0, all.length - keep.length).join('\n') + '\n', 'utf8');
      fs.writeFileSync(this.file, keep.join('\n') + '\n', 'utf8');
      this.lines = keep.length;
    } catch { /* leave it long rather than lose it */ }
  }

  // Drain anything written while the server was down, oldest first, then delete it.
  drainSpool() {
    let raw;
    try { raw = fs.readFileSync(this.spool, 'utf8'); } catch { return []; }
    const rows = raw.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    for (const r of rows) this.append({ ...r, via: (r.via || 'unknown') + '+spooled' });
    try { fs.unlinkSync(this.spool); } catch { /* gone already */ }
    return rows;
  }

  // limit/since/via/ok filters. Reads the ring when it can, the file when it must.
  recent(opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(2000, Number(o.limit) || 25));
    let rows = this.ring;
    if (limit > this.ring.length && this.lines > this.ring.length) {
      try {
        rows = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { /* ring is what we have */ }
    }
    if (o.since) rows = rows.filter((r) => String(r.ts) >= String(o.since));
    if (o.via) rows = rows.filter((r) => String(r.via || '').includes(o.via));
    if (o.only === 'fail') rows = rows.filter((r) => !r.ok);
    if (o.path) {
      const q = String(o.path).toLowerCase();
      rows = rows.filter((r) => String(r.resolved || r.requested || '').toLowerCase().includes(q));
    }
    return rows.slice(-limit);
  }

  stats() {
    const r = this.ring;
    const ok = r.filter((x) => x.ok).length;
    const times = r.map((x) => x.ms).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    const created = r.reduce((s, x) => s + (x.createdNodes ? x.createdNodes.length : 0), 0);
    return {
      lines: this.lines,
      buffered: r.length,
      ok, failed: r.length - ok,
      nodesCreated: created,
      medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
      p95Ms: times.length ? times[Math.floor(times.length * 0.95)] : null,
      file: this.file,
    };
  }
}

// Fallback writer for hooks/CLI when the server is not answering. Same schema, its
// own file, drained into the real log the moment the server is back.
export function spoolAppend(dir, entry) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, SPOOL_NAME), JSON.stringify(makeEntry(entry)) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ presentation
export function table(rows) {
  if (!rows || !rows.length) return '(no file-access entries)';
  const short = (s, n) => {
    s = String(s === null || s === undefined ? '-' : s);
    return s.length <= n ? s : '...' + s.slice(-(n - 3));
  };
  const cols = [
    ['TIME', (r) => String(r.ts).slice(11, 23), 12],
    ['VIA', (r) => short(r.via, 18), 18],
    ['TRIGGER', (r) => short(r.trigger, 22), 22],
    ['METHOD', (r) => short(r.method || methodLine(r.methods).split(' | ')[0] || '-', 16), 16],
    ['RESOLVED', (r) => short(r.resolved || r.requested, 46), 46],
    ['NEW', (r) => String((r.createdNodes || []).length), 3],
    ['OK', (r) => (r.ok ? 'y' : 'N'), 2],
    ['MS', (r) => (r.ms === null ? '-' : String(r.ms)), 5],
  ];
  const pad = (s, n) => (String(s).length >= n ? String(s).slice(0, n) : String(s) + ' '.repeat(n - String(s).length));
  const head = cols.map((c) => pad(c[0], c[2])).join('  ');
  const rule = cols.map((c) => '-'.repeat(c[2])).join('  ');
  const body = rows.map((r) => cols.map((c) => pad(c[1](r), c[2])).join('  '));
  return [head, rule, ...body].join('\n');
}
