// activity.mjs — when each vault note was ADDED, UPDATED and last ACCESSED.
//
// Three questions, three different sources, and only one of them is a filesystem
// timestamp. This module exists because the obvious answer is wrong for two of them:
//
//   added    git — the first commit that introduced the path. NOT birthtime.
//            Any writer that saves by rename (sed -i, and most editors' atomic
//            save) gives the file a brand-new creation time, so on this vault
//            birthtime == mtime for every note an agent has ever edited.
//            Measured 2026-08-22: INDEX.md and agents/claude-charter.md are from
//            July, and both reported a birthtime of the minute they were last
//            edited. Git history is the only record that survives an edit.
//
//   updated  mtime — deliberately NOT the last commit date. A note written five
//            minutes ago and not yet committed has still been updated, and the
//            vault is committed in batches at the end of a write session.
//
//   accessed Metis's own recall stream. Nothing on disk records this: NTFS
//            last-access updates are disabled by default on Windows, and if they
//            were on they would count Obsidian's indexer and every grep as a
//            read. "Claude opened this note" is a fact only the transcript knows,
//            and RecallTracker already extracts it — it was just being thrown
//            away after 200 events. This persists it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const GIT_TTL_MS = 60_000;      // one git pass a minute is plenty; adds are rare
const MAX_EVENTS = 4000;        // ring buffer; ~2 months of heavy use
const SAVE_DEBOUNCE_MS = 4000;

// ---------------------------------------------------------------- added (git)
let gitCache = { at: 0, map: new Map() };

// One pass over the whole history instead of `--follow` per file: --follow cannot
// take multiple paths anyway, and 88 subprocesses to answer one question is absurd.
// A rename lands as an A at the new path, which is the right answer here — the
// vault's own SCHEMA forbids agents renaming notes, so this stays rare.
export function gitAddedMap(vault, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - gitCache.at < GIT_TTL_MS) return gitCache.map;
  const map = new Map();
  try {
    // windowsHide matters: when the server runs with no console (hook-started,
    // detached), every console child otherwise allocates a VISIBLE window -- the
    // flashing-terminal bug of 2026-08-26.
    const r = spawnSync('git', ['-C', vault, 'log', '--diff-filter=A', '--name-only',
      '--format=C|%ct', '--reverse', '--', '*.md'], { encoding: 'utf8', maxBuffer: 32e6, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      let ts = 0;
      for (const line of r.stdout.split('\n')) {
        if (line.startsWith('C|')) { ts = Number(line.slice(2)) * 1000; continue; }
        const rel = line.trim();
        if (!rel || map.has(rel)) continue;      // --reverse: first sighting wins
        map.set(rel, ts);
      }
    }
  } catch { /* not a git repo, or no git on PATH — fall back to mtime */ }
  gitCache = { at: now, map };
  return map;
}

// ---------------------------------------------------------------- access ledger
export class ActivityLog {
  constructor(file) {
    this.file = file;
    this.events = [];            // [{id, at, tool}] oldest -> newest
    this.last = new Map();       // id -> ms of most recent access
    this.dirty = false;
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.events = Array.isArray(d.events) ? d.events.slice(-MAX_EVENTS) : [];
      for (const e of this.events) {
        if (!e || !e.id) continue;
        if (!(this.last.get(e.id) >= e.at)) this.last.set(e.id, e.at);
      }
    } catch { /* first run */ }
    return this;
  }

  // Writing 4000 events on every tool call would make the ledger cost more than the
  // thing it records. Batch, and flush on SIGINT (server.mjs) so nothing is lost.
  save() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.dirty) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify({ v: 1, events: this.events.slice(-MAX_EVENTS) }));
      this.dirty = false;
    } catch { /* cache file — a failed write is not worth crashing the server over */ }
  }

  _schedule() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
    if (this.timer.unref) this.timer.unref();
  }

  // A single tool call can name a dozen notes; they share one timestamp and one tool.
  // `ts` arrives as the transcript's ISO string on backfilled hits and as nothing at
  // all on live ones — parse both rather than silently stamping history with now().
  record(ids, tool, ts) {
    let at = Date.now();
    if (typeof ts === 'number' && ts > 0) at = ts;
    else if (typeof ts === 'string') { const p = Date.parse(ts); if (!Number.isNaN(p)) at = p; }
    let added = 0;
    for (const id of ids || []) {
      if (!id) continue;
      // Replay and backfill re-emit history that is already in the ledger. Without
      // this guard, opening the GUI twice would double every event on the ribbon.
      const prev = this.last.get(id);
      if (prev !== undefined && Math.abs(prev - at) < 1500) continue;
      this.events.push({ id, at, tool: tool || 'unknown' });
      if (!(prev >= at)) this.last.set(id, at);
      added++;
    }
    if (!added) return 0;
    if (this.events.length > MAX_EVENTS + 500) this.events = this.events.slice(-MAX_EVENTS);
    this._schedule();
    return added;
  }

  // A plain filter, not a scan back from the tail: startup backfill stamps events
  // with transcript times that can be older than ones already in the ledger, so the
  // array is not reliably sorted and an early-exit scan would truncate the range.
  since(ms) {
    if (!ms) return this.events;
    return this.events.filter((e) => e.at >= ms);
  }
}

// ---------------------------------------------------------------- merged view
// The one shape the GUI consumes: every node that has a file, with all three
// timestamps, plus the raw access events for the ribbon's ACCESSED lane.
export function buildActivity(graph, log, vault, { since = 0, force = false } = {}) {
  const added = gitAddedMap(vault, { force });
  const files = [];
  for (const n of graph.nodes) {
    if (!n.rel) continue;                      // phantom node — no file to stat
    let mtime = 0;
    try { mtime = fs.statSync(path.join(vault, n.rel)).mtimeMs; } catch { continue; }
    // Uncommitted new note: git has never seen it, so its add IS its mtime.
    const a = added.get(n.rel) ?? mtime;
    files.push({
      id: n.id,
      rel: n.rel,
      group: n.group,
      added: Math.round(a),
      updated: Math.round(mtime),
      accessed: log.last.get(n.id) ?? null,
      committed: added.has(n.rel),
    });
  }
  return {
    generated: Date.now(),
    files,
    access: log.since(since).map((e) => ({ id: e.id, at: e.at, tool: e.tool })),
    tracked: log.events.length,
  };
}
