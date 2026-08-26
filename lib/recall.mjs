// recall.mjs — turn Claude Code's session transcript into "which vault notes were touched".
//
// Why the transcript and not a settings.json hook: the JSONL is appended live and already
// contains every tool_use with its inputs, so this needs ZERO config changes and cannot
// break the aether2 / gitnexus hooks. It also costs zero context tokens — nothing here is
// ever seen by the model. A PreToolUse hook would cut ~1s of latency; that's the only gain.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { resolvePath, VAULT } from './vault-index.mjs';
import { PROJECTS } from './config.mjs';

export { PROJECTS };

// Anything that looks like a path into the vault, anywhere in a blob of text.
const VAULT_RE = /(?:[A-Za-z]:)?[\\/]?(?:AI[\\/]Brain|C:\\AI\\Brain)[\\/][^\s"'`,;)\]]+\.md/gi;

// Find a specific session's transcript by id. The project folder is derived from cwd,
// so search rather than guess the directory name.
export function sessionFile(id, dir = PROJECTS) {
  if (!id) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === `${id}.jsonl`) return p;
    }
  }
  return null;
}

// realOnly defaults ON: this is the fallback the whole GUI uses when no SessionStart
// hook has pinned a session, so an unfiltered "newest file wins" pointed Metis at
// whatever one-shot ran last.
export function newestSession(dir = PROJECTS, { realOnly = true } = {}) {
  let best = null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(p);
          if (best && st.mtimeMs <= best.mtimeMs) continue;
          if (realOnly && !classifySession(p, st)?.real) continue;
          best = { path: p, mtimeMs: st.mtimeMs };
        } catch { /* file vanished mid-scan */ }
      }
    }
  }
  return best;
}

// Pull vault note ids out of one transcript line.
// Map a tool call onto the outer islands. A tool_use carries everything needed:
//   Read/Grep/...        -> tools::<Name>
//   mcp__gitnexus__query -> tools::<full name> AND mcp::gitnexus  (the server lights too)
//   Skill{skill:'x'}     -> tools::Skill AND skills::x
// Without this the tools/skills/mcp islands were drawn but never animated.
function systemIds(name, input, sys) {
  const out = [];
  if (!sys || !sys.size || !name) return out;
  const tid = `tools::${name}`;
  if (sys.has(tid)) out.push(tid);
  const m = /^mcp__(.+?)__/.exec(name);
  if (m && sys.has(`mcp::${m[1]}`)) out.push(`mcp::${m[1]}`);
  if (name === 'Skill' && input && input.skill) {
    const sid = `skills::${String(input.skill).split(':').pop()}`;
    if (sys.has(sid)) out.push(sid);
  }
  return out;
}

// onTool fires for EVERY tool_use, not just the ones that light a node. That
// distinction is load-bearing: a tool with no node on the island produces no hit,
// so without this callback a newly-used tool could never earn its node — the
// island could only ever show what it already showed.
// Exported for the hermes-watcher in server.mjs, which tails the shim transcripts
// itself (it needs the raw line for the model stamp) but must map paths to node ids
// EXACTLY the way the main tracker does — one parser, or the two views drift.
export function idsFromLine(graph, line, sys, onTool) {
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  const m = d.message;
  if (!m || typeof m !== 'object') return null;
  const content = Array.isArray(m.content) ? m.content : [];
  const hits = new Set();
  let tool = null;

  for (const c of content) {
    if (!c || typeof c !== 'object') continue;

    if (c.type === 'tool_use') {
      tool = c.name;
      if (onTool) onTool(c.name);
      const inp = c.input || {};
      for (const id of systemIds(c.name, inp, sys)) hits.add(id);
      for (const k of ['file_path', 'path', 'notebook_path']) {
        const id = resolvePath(graph, inp[k]);
        if (id) hits.add(id);
      }
      // Bash / PowerShell: scan the command text for vault paths
      const blob = [inp.command, inp.pattern, inp.prompt].filter(Boolean).join('\n');
      for (const mt of blob.matchAll(VAULT_RE)) {
        const id = resolvePath(graph, mt[0]);
        if (id) hits.add(id);
      }
    }

    if (c.type === 'tool_result') {
      // Grep/Glob results name the files that matched — this is the real recall signal.
      const text = typeof c.content === 'string'
        ? c.content
        : Array.isArray(c.content)
          ? c.content.map((x) => (typeof x === 'string' ? x : x && x.text) || '').join('\n')
          : '';
      for (const mt of String(text).slice(0, 200000).matchAll(VAULT_RE)) {
        const id = resolvePath(graph, mt[0]);
        if (id) hits.add(id);
      }
      if (hits.size && !tool) tool = 'result';
    }
  }

  if (!hits.size) return null;
  return { tool: tool || 'unknown', ids: [...hits], ts: d.timestamp || null };
}

export class RecallTracker extends EventEmitter {
  constructor(getGraph, { backfill = 40, getSysIds = null, onTool = null } = {}) {
    super();
    this.getGraph = getGraph;
    this.getSysIds = getSysIds || (() => new Set());
    this.onTool = onTool;
    this.file = null;
    this.offset = 0;
    this.buf = '';
    this.timer = null;
    this.watcher = null;
    this.pollMs = 900;      // safety net only — fs.watch does the real work
    this.backfillN = backfill;
    this.recent = [];       // rolling window, replayed to clients that connect late
    // Default was "whichever transcript was written most recently", which meant the
    // GUI chat's own tool calls were invisible whenever a terminal session was also
    // active — the terminal's file is almost always newer. Pinning fixes that.
    this.pinned = null;
  }

  // Follow one specific transcript. Pass null to go back to newest-wins.
  follow(file) {
    if (file === this.pinned) return false;
    this.pinned = file || null;
    this.file = null;          // force _tick() to re-seek on the next pass
    this._tick();
    return true;
  }

  get target() { return this.pinned || newestSession()?.path || null; }

  start() {
    this._tick();
    // fs.watch gives sub-50ms reaction; the interval is a fallback for the cases
    // where Windows change notifications get coalesced or dropped.
    this.timer = setInterval(() => this._tick(), this.pollMs);
    return this;
  }

  _watch(file) {
    if (this.watcher) { try { this.watcher.close(); } catch {} this.watcher = null; }
    try {
      this.watcher = fs.watch(file, { persistent: false }, () => this._tick());
    } catch { /* fall back to the interval */ }
  }

  // Measured on this machine: Claude Code flushes each assistant message to the
  // transcript as it happens (tool_use at T, tool_result ~0.36s later), so tailing
  // this file really is live — not an end-of-turn dump.
  backfill(limit = this.backfillN) {
    const cur = this.pinned ? { path: this.pinned } : newestSession();
    if (!cur) return [];
    const graph = this.getGraph();
    let text = '';
    try { text = fs.readFileSync(cur.path, 'utf8'); } catch { return []; }
    const hits = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const h = idsFromLine(graph, line, this.getSysIds(), this.onTool);
      if (h) hits.push(h);
    }
    return hits.slice(-limit);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.watcher) { try { this.watcher.close(); } catch {} this.watcher = null; }
  }

  _tick() {
    const cur = this.pinned ? { path: this.pinned } : newestSession();
    if (!cur) return;
    if (cur.path !== this.file) {
      // New/switched session: start at the end so we stream live activity, not history.
      this.file = cur.path;
      try { this.offset = fs.statSync(this.file).size; } catch { this.offset = 0; }
      this.buf = '';
      this._watch(this.file);
      this.emit('session', { file: this.file, pinned: !!this.pinned });
      return;
    }
    let size;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.offset) { this.offset = 0; this.buf = ''; }   // truncated/rotated
    if (size === this.offset) return;

    let chunk;
    try {
      const fd = fs.openSync(this.file, 'r');
      const len = size - this.offset;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, this.offset);
      fs.closeSync(fd);
      chunk = b.toString('utf8');
    } catch { return; }
    this.offset = size;

    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    const graph = this.getGraph();
    for (const line of lines) {
      if (!line.trim()) continue;
      const hit = idsFromLine(graph, line, this.getSysIds(), this.onTool);
      if (!hit) continue;
      this.recent.push(hit);
      if (this.recent.length > 200) this.recent.shift();
      this.emit('touch', hit);
    }
  }
}

// ---------------------------------------------------------------- what IS a session
// A transcript on disk is NOT the same thing as a conversation Jordan had. Measured
// 2026-08-24: 289 .jsonl files in this tree, 53 real conversations. The rest are
// subagent sidechains (157), headless `claude -p` one-shots — token-cost probes, hook
// calls, the loop skill — and scratchpad runs. Listing them all made the session picker
// roughly three-quarters noise, and let newestSession() point the whole graph at a
// one-line probe whenever one happened to be written last.
//
// The discriminator is STRUCTURAL, not a heuristic on message counts: the interactive
// client writes a `custom-title` record, a headless run never does. Checked against six
// known-real and six known-probe sessions — clean separation, no overlap. Message-count
// rules were tried first and were wrong: they classified a real session that opened
// with a pasted screenshot as empty, because its first user turn carries an image block
// and no text.
//
// The same record carries the session's title, so the picker can show
// "Metis token usage testing" instead of "24cc1621".
const META_TAIL = 512 * 1024;      // titles are rewritten as a session runs; the last one is near the end
const META_FULL_MAX = 4 * 1024 * 1024;
const metaCache = new Map();       // path -> { key, meta }

function readTail(file, size, bytes) {
  const len = Math.min(bytes, size);
  const buf = Buffer.allocUnsafe(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, Math.max(0, size - len)); } finally { fs.closeSync(fd); }
  return buf.toString('utf8');
}

export function classifySession(file, st) {
  let stat = st;
  try { stat = stat || fs.statSync(file); } catch { return null; }
  const key = `${stat.mtimeMs}|${stat.size}`;
  const hit = metaCache.get(file);
  if (hit && hit.key === key) return hit.meta;

  let title = null, sidechain = false;
  try {
    // isSidechain is stamped on every record of a subagent transcript, so the head is
    // enough and a 157-file scan stays cheap.
    const head = readTail(file, Math.min(stat.size, 8192), 8192);
    if (head.includes('"isSidechain":true')) sidechain = true;

    let text = readTail(file, stat.size, META_TAIL);
    if (!text.includes('"custom-title"') && stat.size > META_TAIL && stat.size <= META_FULL_MAX) {
      text = fs.readFileSync(file, 'utf8');       // titled early, then ran long
    }
    let i = text.lastIndexOf('"custom-title"');
    while (i !== -1) {
      const start = text.lastIndexOf('\n', i) + 1;
      let end = text.indexOf('\n', i); if (end === -1) end = text.length;
      try {
        const rec = JSON.parse(text.slice(start, end));
        if (rec && rec.type === 'custom-title') { title = String(rec.customTitle || '').trim(); break; }
      } catch { /* a tail read can start mid-line; keep looking backwards */ }
      i = text.lastIndexOf('"custom-title"', i - 1);
    }
  } catch { /* unreadable: falls through as not-real */ }

  const meta = { title, sidechain, real: !sidechain && title !== null };
  metaCache.set(file, { key, meta });
  return meta;
}

// Every node id a past session touched, with no animation and no delay. `review`
// replays a session as theatre; this answers the flat question the USED-ONLY filter
// asks — "which nodes did this conversation actually reach".
export function sessionTouches(file, graph, sysIds = null) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ids: [], lines: 0, tools: {} }; }
  const ids = new Set();
  const tools = {};
  let lines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const hit = idsFromLine(graph, line, sysIds);
    if (!hit) continue;
    lines++;
    if (hit.tool) tools[hit.tool] = (tools[hit.tool] || 0) + 1;
    for (const id of hit.ids || []) ids.add(id);
  }
  return { ids: [...ids], lines, tools };
}

// Test harness: replay a past transcript so the visualisation can be verified
// without waiting on live activity and without installing any hook.
export async function replaySession(file, graph, onTouch, { stepMs = 550, signal, sysIds = null } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const line of text.split('\n')) {
    if (signal && signal.aborted) break;
    if (!line.trim()) continue;
    const hit = idsFromLine(graph, line, sysIds);   // standalone: no `this` here
    if (!hit) continue;
    onTouch(hit);
    n++;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return n;
}

export { VAULT };
