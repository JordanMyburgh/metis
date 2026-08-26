// server.mjs — Metis: live vault graph + recall visualisation.
// Plain node:http, no dependencies (house pattern, cf. brain-viewer/server.mjs).
//
// Ports on this machine: 8770 aether2, 8890 brain-viewer, 8780 = us.
// Binds 127.0.0.1 only.
//
// Metis used to embed its own Claude chat. It does not any more: every Claude Code
// session IS the interface, and Metis watches whichever one is live. The SessionStart
// hook (tools/session-hook.mjs) POSTs /api/session on every new session, so the graph
// follows the conversation you are actually having instead of a second one nobody
// wanted. This server now only ever READS — it no longer drives an agent.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildGraph, VAULT } from './lib/vault-index.mjs';
import { loadOrCompute, computeIslandLayout, mergeLayout, setIslandAnchors, DEFAULT_FORCES } from './lib/layout.mjs';
import { buildSystems, nameMatches, ISLANDS, FS_FAN, fsRadius, vaultCategories, buildVaultGateways } from './lib/systems.mjs';
import { FsGraph, FS_ROOT } from './lib/fsgraph.mjs';
import { FsLog, methodLine, table as logTable } from './lib/fslog.mjs';
import { RecallTracker, replaySession, newestSession, sessionFile, classifySession, sessionTouches, idsFromLine, PROJECTS } from './lib/recall.mjs';
import { Loadout } from './lib/loadout.mjs';
import { ActivityLog, buildActivity } from './lib/activity.mjs';
import { buildIndex as buildSearchIndex, search as searchVault } from './lib/search-index.mjs';
import { Desk } from './lib/desk.mjs';
import { Roadmap } from './lib/roadmap.mjs';
import { snapshot as modelsSnapshot, unload as modelUnload, load as modelLoad } from './lib/models.mjs';
import { MODELVAULT } from './lib/config.mjs';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.METIS_PORT || 8780);
const HOST = '127.0.0.1';
const LAYOUT_CACHE = path.join(ROOT, '.layout-cache.json');

// ---------------------------------------------------------------- layout forces
// User-tuned physics from the GUI's forces panel. Persisted next to the other
// runtime state files (gitignored); env/config never override these — they are
// presentation state, not machine identity.
const FORCES_FILE = path.join(ROOT, '.layout-params.json');
const FORCE_CLAMP = {
  repulsion: [0.5, 60], linkPull: [0.0005, 0.08],
  collideRadius: [0, 30], collideStrength: [0, 1],
  spread: [0.4, 1.8],
};
function clampForces(raw) {
  const out = { ...DEFAULT_FORCES };
  for (const k of Object.keys(FORCE_CLAMP)) {
    const v = Number(raw && raw[k]);
    if (Number.isFinite(v)) out[k] = Math.min(FORCE_CLAMP[k][1], Math.max(FORCE_CLAMP[k][0], v));
  }
  return out;
}
let FORCES = { ...DEFAULT_FORCES };
try { FORCES = clampForces(JSON.parse(fs.readFileSync(FORCES_FILE, 'utf8'))); } catch { /* defaults */ }
const LOADOUT_CACHE = path.join(ROOT, '.loadout-cache.json');
const ACTIVITY_CACHE = path.join(ROOT, '.activity-cache.json');
const FS_CACHE = path.join(ROOT, '.fs-graph.json');
const DESK_FILE = path.join(ROOT, '.desk.json');
// The pad tab's file. OUTSIDE the repo on purpose: it is Jordan's text, not app
// state — anything can open it, and a vault-side grep finds it.
const SCRATCH_FILE = process.env.METIS_SCRATCH || 'C:\\AI\\Notes\\scratchpad.md';
// Curriculum is source and committed; progress is personal and gitignored. See lib/roadmap.mjs.
const ROADMAP_DEF = path.join(ROOT, 'data', 'roadmap.json');
const ROADMAP_FILE = path.join(ROOT, '.roadmap.json');
const LOG_DIR = path.join(ROOT, 'logs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  // installability: a manifest served as octet-stream is silently ignored by Chrome/Edge
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

setIslandAnchors(ISLANDS);
// The tools island's roster used to come from the embedded chat's init record. It now
// comes from tool calls actually observed in the transcripts — see lib/loadout.mjs.
const loadout = new Loadout(LOADOUT_CACHE);
// The desk owns notes, the focus timer and the schedule. It is ticked here rather
// than in the browser so a scheduled block still fires while the GUI is behind other
// windows (start-metis.ps1 deliberately parks it at the back of the z-order), and so
// a focus session survives a reload of the page that started it.
const desk = new Desk(DESK_FILE);
// The long game, kept away from the desk on purpose: the desk is today, this is
// nine months. Nothing to tick here on a timer — a roadmap only changes when a
// human ticks something.
const roadmap = new Roadmap(ROADMAP_DEF, ROADMAP_FILE);
setInterval(() => {
  for (const e of desk.tick()) broadcast(e.type, { focus: e.focus, block: e.block });
}, 15000).unref?.();
const lo = loadout.load();
// Local models are graph MEMBERS (an island), so their names must exist before the
// first build. One awaited snapshot at boot; if Ollama is down the island is simply
// absent until the next /api/reindex — same graceful degradation as the models tab.
// After boot a 5 s poller watches RESIDENCY (what is in VRAM now) and broadcasts
// changes over SSE; residency is a client-side overlay, never a graph rebuild —
// loading a model must not reshuffle a map whose membership did not change.
let modelsLive = await modelsSnapshot().catch(() => ({ up: false, gpu: null, models: [] }));
// Cloud models seen actually WORKING (Hermes shim transcripts name them) earn a moon
// too — "which model is active" must not be limited to what fits in the local VRAM.
const remoteSeen = new Set();
const modelNames = () => [...modelsLive.models.map((m) => m.name), ...remoteSeen];
// The models' own notes (C:\AI\ModelVault\<model>\**\*.md) ride along as satellite
// nodes on each moon. Tiny tree, scanned fresh on every systems rebuild.
function mvScan() {
  const out = {};
  try {
    for (const d of fs.readdirSync(MODELVAULT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const files = [];
      const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(MODELVAULT, d.name, rel), { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(r);
          else if (e.name.endsWith('.md')) files.push(r);
        }
      };
      walk('');
      if (files.length) out[d.name] = files;
    }
  } catch { }
  return out;
}
const buildSys = () => buildSystems({ toolNames: loadout.toolNames, modelNames: modelNames(), mvNotes: mvScan() });
let graph = buildGraph();
let systems = buildSys();
// Every vault category is its own network, so the ring anchors are derived from the
// live group counts and recomputed whenever the vault changes. A category that gains
// its first note gets a slot; one that loses its last note gives its slot back.
const groupCounts = (g) => {
  const c = {};
  for (const n of g.nodes) c[n.group] = (c[n.group] || 0) + 1;
  return c;
};
let cats = vaultCategories(groupCounts(graph));
let layout = computeIslandLayout(graph, systems, cats, FORCES);
Object.assign(layout.pos, systems.moonPos);   // ring beats layouter, always
let searchIndex = buildSearchIndex(graph);
console.log(`[metis] vault ${graph.nodes.length} nodes / ${graph.links.length} links`);
console.log(`[metis] search index: ${searchIndex.entries.length} notes`);
console.log(`[metis] loadout ${lo.count} tools from ${lo.from}${lo.scanned ? ` (${lo.scanned} transcripts scanned)` : ''}`);
console.log(`[metis] systems: ${systems.counts.mcp} mcp · ${systems.counts.skills} skills · ${systems.counts.tools} tools · ${systems.counts.models} models (${systems.nodes.length} nodes)`);

// ---------------------------------------------------------------- model residency
// Signature = which models are resident and how much of each sits in VRAM. GPU load
// wobbles constantly and is NOT part of the signature — broadcasting on every wobble
// would be a heartbeat, and SSE frames should mean something changed.
const modelSig = (s) => s.models.filter((m) => m.loaded).map((m) => `${m.name}:${m.vramBytes}`).sort().join('|');
setInterval(async () => {
  const snap = await modelsSnapshot().catch(() => null);
  if (!snap) return;                       // ollama down mid-poll: keep last known state
  const changed = modelSig(snap) !== modelSig(modelsLive);
  const grew = snap.models.length !== modelsLive.models.length;
  modelsLive = snap;
  if (grew) growIslands();                 // a model was created/removed: island membership changed
  if (changed || grew) broadcast('models', { up: snap.up, gpu: snap.gpu, models: snap.models });
}, 5000).unref?.();

// ---------------------------------------------------------------- SSE fan-out
const clients = new Set();
function broadcast(type, data) {
  const frame = `data: ${JSON.stringify({ type, t: Date.now(), ...data })}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
}

// ---------------------------------------------------------------- recall
const sysIds = () => new Set(systems.nodes.map((n) => n.id));

// A tool that has no node on the island lights nothing, so it could never earn a node
// from its own use — the island would be frozen at whatever it started with. Observing
// every call and rebuilding is what lets it grow.
let sysTimer = null;
function growIslands() {
  clearTimeout(sysTimer);
  sysTimer = setTimeout(() => {
    systems = buildSys();
    layout = mergeLayout(layout.pos, graph, systems, cats, FORCES);   // keep every existing position
    Object.assign(layout.pos, systems.moonPos);               // except moons: the ring re-spaces
    broadcast('graph_changed', { reason: 'loadout', counts: systems.counts });
    console.log(`[metis] islands grew -> ${systems.counts.tools} tools · ${systems.counts.mcp} mcp`);
  }, 1200);
}

const tracker = new RecallTracker(() => graph, {
  getSysIds: sysIds,
  onTool: (name) => { if (loadout.observe(name)) growIslands(); },
}).start();

// ---------------------------------------------------------------- activity ledger
// RecallTracker already knows which notes were read; it just forgot them after 200
// events. The ledger persists that stream so "when was this last accessed" survives a
// restart — see lib/activity.mjs for why none of the three timestamps comes from stat().
const activity = new ActivityLog(ACTIVITY_CACHE);

// Hermes shim files belong to the hermes-watcher below, which attributes each touch
// to the MODEL that made it. If the main tracker ever ends up on one (an old pin),
// staying silent here prevents the same touch broadcasting twice — once from the
// core, once from the moon.
const isHermesShim = (f) => !!f && path.resolve(path.dirname(f)) === path.resolve(HERMES_SHIM_DIR);
tracker.on('touch', (h) => {
  if (isHermesShim(tracker.file)) return;
  activity.record(h.ids, h.tool, h.ts); broadcast('touch', h);
});
tracker.on('session', (s) => broadcast('session', { file: path.basename(s.file), path: s.file, live: true, pinned: !!s.pinned }));

// ---------------------------------------------------------------- hermes watcher
// Jordan's model: Claude's graph is Earth; each model is a MOON. A vault query made
// by a model must visibly come FROM that model's node, not from the core — so this
// watcher tails the newest Hermes shim transcript independently of the main tracker
// (Claude keeps the Earth view; Hermes never steals the pin any more) and broadcasts
// each touch with origin = the model's moon. The plugin stamps a top-level "model"
// field on every shim line; a model without a moon yet (a cloud one, ox-alpha) earns
// one on first sighting via the same growIslands path the tools island uses.
const HERMES_SHIM_DIR = path.join(ROOT, '.hermes-transcripts');
const hermesWatch = { file: null, offset: 0, buf: '', seeded: false };
setInterval(() => {
  let newest = null;
  try {
    for (const f of fs.readdirSync(HERMES_SHIM_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(HERMES_SHIM_DIR, f);
      const mt = fs.statSync(full).mtimeMs;
      if (!newest || mt > newest.mt) newest = { full, mt };
    }
  } catch { return; }
  if (!newest) return;
  if (newest.full !== hermesWatch.file) {
    hermesWatch.file = newest.full;
    hermesWatch.buf = '';
    if (!hermesWatch.seeded) {
      // Watcher startup only: seek to end so a Metis restart doesn't replay the
      // last session's history as if it were happening now.
      hermesWatch.seeded = true;
      try { hermesWatch.offset = fs.statSync(newest.full).size; } catch { hermesWatch.offset = 0; }
      return;
    }
    // A file that APPEARS while we watch is a live session starting — and a -z
    // one-shot writes its first tool_use lines in the same flush that creates the
    // file, so seeking to end here would skip the entire session. Read from 0.
    hermesWatch.offset = 0;
    // fall through: process this tick, don't wait 2s
  }
  let size; try { size = fs.statSync(hermesWatch.file).size; } catch { return; }
  if (size < hermesWatch.offset) { hermesWatch.offset = 0; hermesWatch.buf = ''; }
  if (size === hermesWatch.offset) return;
  let chunk;
  try {
    const fd = fs.openSync(hermesWatch.file, 'r');
    const b = Buffer.alloc(size - hermesWatch.offset);
    fs.readSync(fd, b, 0, b.length, hermesWatch.offset);
    fs.closeSync(fd);
    chunk = b.toString('utf8');
  } catch { return; }
  hermesWatch.offset = size;
  hermesWatch.buf += chunk;
  const lines = hermesWatch.buf.split('\n');
  hermesWatch.buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let model = '';
    try { model = String(JSON.parse(line).model || ''); } catch { }
    const hit = idsFromLine(graph, line, sysIds(), null);
    if (!hit) continue;
    // Resolve the touch to an EXISTING moon by fuzzy name — a folder-born moon is
    // titled after its ModelVault folder (ox-alpha), the shim stamp says the full
    // model name (stealth/ox-alpha); nameMatches bridges the two. A model with no
    // moon at all earns one via growIslands and attributes from the next touch on.
    const moon = model ? systems.nodes.find((n) => n.kind === 'moon' && nameMatches(n.title, model)) : null;
    if (model && !moon && !remoteSeen.has(model)) {
      remoteSeen.add(model);
      growIslands();                       // a working cloud model earns its moon
    }
    activity.record(hit.ids, hit.tool, hit.ts);
    broadcast('touch', { ...hit, ...(moon ? { origin: moon.id } : {}), agent: 'hermes', model: model || null });
  }
}, 2000).unref?.();

// The tracker seeks to end-of-file on start, so everything that happened in this
// session BEFORE Metis launched would be missing from the ledger. Replay it once here
// — not per client connect, or reopening the GUI would re-log the same history.
try {
  const seeded = tracker.backfill(400).reduce((n, h) => n + activity.record(h.ids, h.tool, h.ts), 0);
  if (seeded) console.log(`[metis] activity: seeded ${seeded} accesses from the live transcript`);
} catch { /* no transcript yet */ }
console.log(`[metis] activity: ${activity.events.length} accesses tracked across ${activity.last.size} nodes`);

// ---------------------------------------------------------------- FileSystem backbone
// The fourth structure on the map. The vault shell says what I know, the islands say
// what I am plugged into; this says what I just OPENED. It is fed by /api/fs/touch —
// from the FileSearch skill (deliberate lookups, with a reason) and from the
// PreToolUse hook (every file any tool touches, whether I remembered to say so or not).
const fsg = new FsGraph(FS_CACHE);
const fslog = new FsLog(LOG_DIR);
const drained = fslog.drainSpool();
if (drained.length) console.log(`[metis] fs log: drained ${drained.length} spooled entries written while offline`);
// A hook that fired during a restart spools instead of losing the line. Sweep for those.
setInterval(() => { const n = fslog.drainSpool(); if (n.length) console.log(`[metis] fs log: drained ${n.length} spooled entries`); }, 30000).unref();
console.log(`[metis] filesystem: ${fsg.counts().dirs} folders · ${fsg.counts().files} files (cap ${fsg.counts().max}) · log ${fslog.stats().lines} lines`);

let fsHot = [];                       // most-recently-accessed ids, for the accent colour
let fsPos = fsg.layout(ISLANDS.fs.anchor, { R: fsRadius(ISLANDS.fs.radius, fsg.nodes.size), ...FS_FAN });
// A sunburst REFLOWS when a branch grows — a new sibling takes arc from its
// neighbours. That is the correct behaviour for a tree and the opposite of the vault's
// frozen layout, so it is deliberate, not an oversight: children are sorted by path,
// so the reflow is deterministic and a branch keeps its direction as it fills in.
let fsTimer = null;
function fsChanged(reason, added, removed) {
  fsPos = fsg.layout(ISLANDS.fs.anchor, { R: fsRadius(ISLANDS.fs.radius, fsg.nodes.size), ...FS_FAN });
  clearTimeout(fsTimer);
  fsTimer = setTimeout(() => {
    fsg.save();
    broadcast('graph_changed', { reason, added: added || [], removed: removed || [], scope: 'fs', counts: { ...systems.counts, fs: fsg.counts().total } });
  }, 220);
}

// One place where a path becomes graph + log, so the hook, the skill and a raw curl
// all produce identical records. Returns what the caller needs to report back.
function recordTouch(body) {
  const started = Date.now();
  const paths = (Array.isArray(body.paths) ? body.paths : [body.path]).filter(Boolean).slice(0, 24);
  const created = [], pruned = [], resolved = [], ids = [], failed = [];
  for (const p of paths) {
    const r = fsg.touch(p, { cwd: body.cwd || null, kindHint: body.kind || null });
    if (!r.ok) { failed.push({ path: p, reason: r.reason }); continue; }
    created.push(...r.created); pruned.push(...r.pruned);
    resolved.push(r.resolved); ids.push(r.id);
  }
  const entry = fslog.append({
    ts: body.ts || new Date().toISOString(),
    trigger: body.trigger,
    via: body.via,
    tool: body.tool,
    methods: body.methods,
    method: body.method || (body.methods && body.methods.filter((m) => m && m.ok).map((m) => m.name)[0]) || null,
    requested: body.requested || paths.join(' , ') || null,
    resolved: resolved.join(' , ') || null,
    createdNodes: created,
    prunedNodes: pruned,
    ok: body.ok === false ? false : (ids.length > 0),
    error: body.error || (failed.length ? `unresolvable: ${failed.map((f) => f.path).join(', ')}` : null),
    ms: typeof body.ms === 'number' ? body.ms : (Date.now() - started),
    reason: body.reason || null,
    shape: body.shape || null,
    session: body.session || (activeSession && activeSession.id) || null,
  });
  if (ids.length) {
    fsHot = [...ids, ...fsHot.filter((x) => !ids.includes(x))].slice(0, 12);
    broadcast('touch', { tool: body.tool || 'FileSearch', ids, ts: entry.ts, scope: 'fs', chainOf: paths.length === 1 ? ids[0] : null });
  }
  if (created.length || pruned.length) fsChanged('fs-touch', created, pruned);
  if (pruned.length) console.log(`[metis] filesystem: evicted ${pruned.length} cold node(s) to stay under the ${fsg.counts().max}-node cap`);
  return { entry, ids, created, pruned, resolved, failed, counts: fsg.counts() };
}

// ---------------------------------------------------------------- the live session
// Which conversation Metis is watching. Set by the SessionStart hook.
let activeSession = null;

// A session's transcript does NOT exist yet when SessionStart fires — Claude Code
// creates it on first write. The old chat path lost exactly this race with a single
// lookup and the pin silently never happened, so retry with backoff.
function pinSession(id, given, tries = 0) {
  let file = null;
  if (given) { try { if (fs.existsSync(given)) file = given; } catch { /* not yet */ } }
  if (!file && id) file = sessionFile(id);
  if (file) {
    activeSession = { id: id || null, file, at: Date.now() };
    if (tracker.follow(file)) {
      broadcast('session', { file: path.basename(file), path: file, live: true, pinned: true, sessionId: id });
      console.log(`[metis] now following session ${id || path.basename(file)}`);
    }
    return;
  }
  if (tries < 10) { setTimeout(() => pinSession(id, given, tries + 1), 300 * (tries + 1)); return; }
  console.log(`[metis] no transcript for session ${id} — staying on newest-wins`);
}

let replayAbort = null;

// ---------------------------------------------------------------- vault watcher
// A note written while you watch should APPEAR, not wait for a restart. Positions of
// existing nodes are preserved (see mergeLayout) so one new note never reshuffles the map.
let vaultTimer = null;
function rescanVault(reason) {
  const before = new Set(graph.nodes.map((n) => n.id));
  graph = buildGraph();
  searchIndex = buildSearchIndex(graph);
  cats = vaultCategories(groupCounts(graph));
  const merged = mergeLayout(layout.pos, graph, systems, cats, FORCES);
  layout = merged;
  Object.assign(layout.pos, systems.moonPos);
  const added = graph.nodes.map((n) => n.id).filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !graph.nodes.some((n) => n.id === id));
  if (!added.length && !removed.length) {
    broadcast('graph_changed', { reason, added: [], removed: [], nodes: graph.nodes.length });
    return;
  }
  console.log(`[metis] vault ${reason}: +${added.length} -${removed.length} -> ${graph.nodes.length} nodes`);
  broadcast('graph_changed', { reason, added, removed, nodes: graph.nodes.length, links: graph.links.length });
}
try {
  fs.watch(VAULT, { recursive: true, persistent: false }, (_e, f) => {
    if (f && !String(f).toLowerCase().endsWith('.md')) return;   // ignore .git churn
    clearTimeout(vaultTimer);
    vaultTimer = setTimeout(() => rescanVault('changed'), 700);   // notes arrive in bursts
  });
  console.log(`[metis] watching the vault for new notes: ${VAULT}`);
} catch (e) {
  console.log(`[metis] vault watch unavailable (${e && e.message}) — use POST /api/reindex`);
}

// ---------------------------------------------------------------- helpers
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
// "Show me the file graph" and "dump the access log" have to work in a terminal, not
// only in the GUI — so those two routes can answer as plain text.
function text(res, code, s) {
  const b = Buffer.from(String(s) + '\n', 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
// Overflow used to req.destroy(), which kills the socket and leaves the browser with
// a bare "Failed to fetch". Drain-and-flag instead, so an oversized body fails
// validation with a real status rather than a dead connection.
function readBody(req, max = 1e6) {
  return new Promise((resolve) => {
    const chunks = [];
    let len = 0, over = false;
    req.on('data', (d) => {
      if (over) return;
      len += d.length;
      if (len > max) { over = true; chunks.length = 0; return; }
      chunks.push(d);
    });
    req.on('end', () => {
      if (over) return resolve({ __tooLarge: true });
      // Concat THEN decode. `s += chunk` stringifies each chunk as it arrives, so a
      // multi-byte character straddling a chunk boundary becomes two U+FFFD and the
      // JSON either breaks or silently corrupts. One em dash in a note is enough to
      // hit it, and notes are long enough to be chunked.
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); }
    });
  });
}
// The picker lists CONVERSATIONS, not files. See classifySession() in lib/recall.mjs
// for why those are different things and how they are told apart. `all=1` shows the
// unfiltered list, which is the only way to see what is being hidden.
function listSessions({ all = false } = {}) {
  const out = [];
  const stack = [PROJECTS];
  let scanned = 0;
  while (stack.length) {
    const d = stack.pop();
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      scanned++;
      const meta = classifySession(p, st) || { real: false, title: null, sidechain: false };
      if (!all && !meta.real) continue;
      out.push({
        file: p, name: e.name, title: meta.title || null,
        sidechain: meta.sidechain, real: meta.real,
        kb: Math.round(st.size / 1024), mtime: st.mtimeMs,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return { sessions: out.slice(0, 40), scanned, real: out.length };
}

// ---------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    clients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    const live = newestSession();
    res.write(`data: ${JSON.stringify({ type: 'hello', t: Date.now(), live: live ? path.basename(live.path) : null, liveFile: live ? live.path : null, session: activeSession, counts: systems.counts })}\n\n`);
    // Open the GUI mid-session and you should see where Claude has just been,
    // not an empty graph waiting for the next tool call.
    try {
      const hist = tracker.backfill();
      for (const h of hist) res.write(`data: ${JSON.stringify({ type: 'touch', t: Date.now(), ...h, backfill: true })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'backfilled', t: Date.now(), count: hist.length })}\n\n`);
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'backfilled', t: Date.now(), count: 0, error: String(e && e.message) })}\n\n`);
    }
    return;
  }

  if (p === '/api/graph') {
    const vaultNodes = graph.nodes.map((n) => ({
      id: n.id, title: n.title, group: n.group, domain: 'vault',
      type: n.type, status: n.status, rel: n.rel, degree: n.degree,
    }));
    const sysNodes = systems.nodes.map((n) => ({
      id: n.id, title: n.title, group: n.domain, domain: n.domain,
      kind: n.kind, degree: n.degree,
    }));
    const fsNodes = fsg.graphNodes();
    const fsc = fsg.counts();
    // Category gateways + the spokes that make a category a real network rather than a
    // colour. The spokes are drawn at the same faint weight as the island ones (they
    // restate what POSITION already says), but they are what the flare router walks:
    // core -> cat::feedback -> feedback/pref-concise-direct is a path that exists.
    const vgw = buildVaultGateways(groupCounts(graph));
    const catSpokes = graph.nodes.map((n) => ({ source: `cat::${n.group}`, target: n.id, kind: 'local' }));
    return json(res, 200, {
      generated: graph.generated,
      nodes: [
        { id: 'core', title: 'CLAUDE', group: 'core', domain: 'core', kind: 'core', degree: 0 },
        ...vgw.nodes, ...vaultNodes, ...sysNodes, ...fsNodes,
      ],
      links: graph.links.map((l) => ({ ...l, kind: 'vault' })),
      // The FileSystem tree terminates on the backbone exactly like an island gateway:
      // core -> FileSystem -> drive -> folder -> ... -> file.
      systemLinks: [...catSpokes, ...systems.links, ...fsg.graphLinks()],
      backbone: [...vgw.backbone, ...systems.backbone, { source: 'core', target: FS_ROOT, kind: 'backbone' }],
      islands: ISLANDS, categories: cats,
      layout: { ...layout.pos, ...fsPos },
      focal: layout.focal,
      phantomCount: graph.phantomCount,
      // Explicit per-domain counts. The client used to derive the vault count by
      // subtracting the others from nodes.length, which was already off by one and
      // would have broken outright the moment a fourth domain appeared.
      counts: { ...systems.counts, vault: vaultNodes.length, fs: fsc.total, fsDirs: fsc.dirs, fsFiles: fsc.files },
    });
  }

  // Every note's added/updated/accessed, plus the raw access events for the ribbon.
  // ?since=<ms epoch> trims the access lane; the file list is always whole (it is one
  // row per note, and the ribbon needs the out-of-range ones to draw "older than this").
  if (p === '/api/activity') {
    const since = Number(url.searchParams.get('since')) || 0;
    return json(res, 200, buildActivity(graph, activity, VAULT, {
      since,
      force: url.searchParams.get('force') === '1',
    }));
  }

  if (p === '/api/sessions') {
    const r = listSessions({ all: url.searchParams.get('all') === '1' });
    return json(res, 200, { sessions: r.sessions, scanned: r.scanned, conversations: r.real });
  }

  // Which nodes did ONE past session touch. The USED-ONLY filter asks this flat
  // question; /api/replay answers a different one (show me it happening, in order).
  if (p === '/api/session-touches') {
    const f = url.searchParams.get('file');
    if (!f) return json(res, 400, { error: 'file required' });
    const real = path.normalize(f);
    // Path containment: this reads an arbitrary file off a query string otherwise.
    if (!real.startsWith(path.normalize(PROJECTS))) return json(res, 403, { error: 'outside the projects dir' });
    if (!fs.existsSync(real)) return json(res, 404, { error: 'no such transcript' });
    const t = sessionTouches(real, graph, sysIds());
    const meta = classifySession(real) || {};
    return json(res, 200, { file: real, title: meta.title || null, ...t, count: t.ids.length });
  }
  // -------------------------------------------------------------- layout forces
  // POST is matched FIRST: a bare path check would swallow the POST too and the
  // sliders would silently do nothing (caught by verify-forces.mjs, 2026-08-26).
  if (req.method !== 'POST' && p === '/api/forces') {
    return json(res, 200, { forces: FORCES, defaults: DEFAULT_FORCES, clamp: FORCE_CLAMP });
  }
  if (req.method === 'POST' && p === '/api/forces') {
    const b = await readBody(req);
    FORCES = clampForces({ ...FORCES, ...b });
    try { fs.writeFileSync(FORCES_FILE, JSON.stringify(FORCES, null, 2) + '\n'); } catch { /* survivable */ }
    // Full recompute, deliberately NOT mergeLayout: changing the physics is the one
    // sanctioned reason to reshuffle the map. The result re-freezes afterwards.
    layout = computeIslandLayout(graph, systems, cats, FORCES);
    Object.assign(layout.pos, systems.moonPos);
    broadcast('graph_changed', { reason: 'forces' });
    return json(res, 200, { ok: true, forces: FORCES });
  }

  // -------------------------------------------------------------- shutdown
  // metis.mjs stop uses this: graceful, localhost-only like everything else, and it
  // works however the server was started (hook, .vbs, setup, by hand).
  if (req.method === 'POST' && p === '/api/shutdown') {
    json(res, 200, { ok: true, stopping: true });
    console.log('[metis] shutdown requested via /api/shutdown');
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (p === '/api/status') return json(res, 200, {
    clients: clients.size,
    session: activeSession,
    live: tracker.target,                 // what recall is ACTUALLY following, pin included
    pinned: tracker.pinned,
    newest: newestSession()?.path ?? null,
    counts: systems.counts,
    tools: loadout.size,
    filesystem: fsg.counts(),
    fsLog: fslog.stats(),
  });

  // The SessionStart hook calls this on every new Claude Code session. Answer at once
  // and pin in the background — a hook that blocks is a hook that gets uninstalled.
  if (req.method === 'POST' && p === '/api/session') {
    const b = await readBody(req);
    const id = b.sessionId || b.session_id || null;
    const given = b.transcriptPath || b.transcript_path || null;
    if (!id && !given) return json(res, 400, { error: 'sessionId or transcriptPath required' });
    // Changed 2026-08-25: a Hermes registration no longer pins the main tracker.
    // Earth stays Claude's view; the hermes-watcher renders Hermes activity from
    // the model's own moon. (Before this, "the graph follows whichever session
    // registered last" meant a 30-second hermes -z run stole the whole map.)
    if (b.source === 'hermes' || String(id || '').startsWith('hermes:')) {
      broadcast('hermes_session', { sessionId: id });
      return json(res, 200, { ok: true, sessionId: id, following: tracker.target, pinned: false });
    }
    pinSession(id, given);
    return json(res, 200, { ok: true, sessionId: id, following: tracker.target });
  }

  if (req.method === 'POST' && p === '/api/replay') {
    const b = await readBody(req);
    if (replayAbort) replayAbort.abort();
    const file = b.file || listSessions().find((s) => s.name.startsWith('f5561a07'))?.file || listSessions()[0]?.file;
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'no transcript' });
    replayAbort = new AbortController();
    const signal = replayAbort.signal;
    json(res, 200, { ok: true, file: path.basename(file) });
    broadcast('replay_start', { file: path.basename(file) });
    replaySession(file, graph, (h) => broadcast('touch', { ...h, replay: true }), { stepMs: Number(b.stepMs) || 550, signal, sysIds: sysIds() })
      .then((n) => broadcast('replay_end', { count: n }))
      .catch((e) => broadcast('replay_end', { error: String(e && e.message) }));
    return;
  }

  if (req.method === "POST" && p === "/api/reindex") {
    graph = buildGraph();
    modelsLive = await modelsSnapshot().catch(() => modelsLive);   // re-enumerate; keep last known on failure
    systems = buildSys();
    cats = vaultCategories(groupCounts(graph));
    layout = computeIslandLayout(graph, systems, cats, FORCES);
    Object.assign(layout.pos, systems.moonPos);
    searchIndex = buildSearchIndex(graph);
    broadcast('reindexed', { nodes: graph.nodes.length, links: graph.links.length, systems: systems.counts });
    return json(res, 200, { nodes: graph.nodes.length, links: graph.links.length, systems: systems.counts });
  }

  // Token-cheap vault search: ranked hits (id/title/rel/score/snippet), no full-file
  // reads. Every non-empty result also broadcasts as a 'touch' — same event shape the
  // recall tracker emits — so a search lights exactly the notes it matched, tagged
  // tool:'search' in the chronicle, regardless of what called this endpoint (CLI over
  // Bash, curl, a future GUI search box). Read-only: GET, like /api/graph, /api/activity.
  if (p === '/api/search') {
    const q = url.searchParams.get('q') || '';
    const out = searchVault(searchIndex, q, {
      limit: url.searchParams.get('limit'),
      group: url.searchParams.get('group') || null,
      tag: url.searchParams.get('tag') || null,
    });
    if (out.hits.length) {
      const ts = new Date().toISOString();
      const ids = out.hits.map((h) => h.id);
      activity.record(ids, 'search', ts);
      broadcast('touch', { tool: 'search', ids, ts, query: q });
    }
    return json(res, 200, out);
  }

  // ------------------------------------------------------------- FileSystem backbone
  // The ingest point. Every file touch in the system lands here — from the FileSearch
  // skill with a reason attached, or from the PreToolUse hook with none. One writer,
  // one schema, so the graph and the log can never disagree about what happened.
  if (req.method === 'POST' && p === '/api/fs/touch') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    if (!b.path && !(Array.isArray(b.paths) && b.paths.length)) {
      return json(res, 400, { error: 'path or paths[] required' });
    }
    const out = recordTouch(b);
    return json(res, 200, {
      ok: out.entry.ok, entry: out.entry, ids: out.ids, resolved: out.resolved,
      created: out.created, pruned: out.pruned, counts: out.counts,
      methodLine: methodLine(out.entry.methods),
    });
  }

  // ?format=ascii|mermaid renders it; default JSON is the raw tree.
  if (p === '/api/fs/graph') {
    const fmt = url.searchParams.get('format');
    if (fmt === 'ascii' || fmt === 'mermaid') {
      const body = fmt === 'ascii' ? fsg.ascii({ hot: fsHot }) : fsg.mermaid({ hot: fsHot });
      return text(res, 200, body);
    }
    return json(res, 200, {
      root: FS_ROOT, nodes: fsg.graphNodes(), links: fsg.graphLinks(),
      layout: fsPos, anchor: ISLANDS.fs.anchor, hot: fsHot, counts: fsg.counts(),
      colors: { folder: '#4b8fe8', file: '#7fd964', accent: '#ffb020' },
    });
  }

  // The rolling diagnostic log. ?format=table for a human, JSON otherwise.
  if (p === '/api/fs/log') {
    const rows = fslog.recent({
      limit: url.searchParams.get('limit'),
      since: url.searchParams.get('since'),
      via: url.searchParams.get('via'),
      only: url.searchParams.get('only'),
      path: url.searchParams.get('path'),
    });
    if (url.searchParams.get('format') === 'table') return text(res, 200, logTable(rows));
    return json(res, 200, { stats: fslog.stats(), count: rows.length, entries: rows });
  }

  // Start the tree over without restarting Metis. The log is NOT cleared — the graph
  // is a live picture, the log is the record, and wiping the record on a redraw would
  // defeat the point of keeping one.
  if (req.method === 'POST' && p === '/api/fs/reset') {
    fsg.nodes.clear(); fsg.evicted = 0; fsg.ensureRoot(); fsHot = [];
    fsg.save(); fsChanged('fs-reset', [], []);
    fslog.append({ trigger: 'operator', via: 'api', method: 'reset', requested: null, resolved: null, ok: true, ms: 0, reason: 'FileSystem graph cleared via POST /api/fs/reset' });
    return json(res, 200, { ok: true, counts: fsg.counts() });
  }

  // ---------------------------------------------------------------- desk
  // Notes, the focus timer and the schedule. Every one of these is also reachable
  // from a Claude Code session, which is the point: "set a focus session for an hour"
  // typed in the terminal and the 60 button in the GUI hit the same state.
  if (p === '/api/desk') return json(res, 200, desk.snapshot());

  if (req.method === 'POST' && p === '/api/notes') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    if (typeof b.text !== 'string') return json(res, 400, { error: 'text required' });
    const notes = desk.setNotes(b.text);
    // `by` lets the writer ignore its own echo instead of fighting its own textarea.
    broadcast('notes', { notes, by: String(b.by || 'api') });
    return json(res, 200, { ok: true, notes });
  }

  if (req.method === 'POST' && p === '/api/focus/start') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    const focus = desk.startFocus({ minutes: b.minutes ?? b.mins ?? 60, label: b.label, source: b.source || 'api' });
    broadcast('focus_start', { focus });
    return json(res, 200, { ok: true, focus });
  }
  if (req.method === 'POST' && p === '/api/focus/stop') {
    const focus = desk.stopFocus();
    broadcast('focus_stop', { focus });
    return json(res, 200, { ok: true, focus });
  }

  if (req.method === 'POST' && p === '/api/schedule/add') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    let block;
    try { block = desk.addBlock(b); } catch (e) { return json(res, 400, { error: String(e.message) }); }
    broadcast('schedule', { schedule: desk.state.schedule, next: desk.next() });
    return json(res, 200, { ok: true, block, schedule: desk.state.schedule, next: desk.next() });
  }
  // The shared list. `?format=text` is what the two hooks read — they want a prompt
  // block, not JSON, and neither should have to know the shape of a todo.
  if (p === '/api/todos') {
    if (url.searchParams.get('format') === 'text') return text(res, 200, desk.todoBlock());
    return json(res, 200, { todos: desk.state.todos, open: desk.openTodos().length, rev: desk.state.rev || 0 });
  }
  if (req.method === 'POST' && p === '/api/todos/add') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    let todo;
    try { todo = desk.addTodo(b); } catch (e) { return json(res, 400, { error: String(e.message) }); }
    broadcast('todos', { todos: desk.state.todos, rev: desk.state.rev, added: todo.id });
    return json(res, 200, { ok: true, todo, todos: desk.state.todos, rev: desk.state.rev });
  }
  if (req.method === 'POST' && p === '/api/todos/toggle') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    const todo = desk.toggleTodo(String(b.id || ''), b.done);
    if (!todo) return json(res, 404, { error: 'todo not found' });
    broadcast('todos', { todos: desk.state.todos, rev: desk.state.rev });
    return json(res, 200, { ok: true, todo, todos: desk.state.todos, rev: desk.state.rev });
  }
  if (req.method === 'POST' && p === '/api/todos/remove') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    const ok = desk.removeTodo(String(b.id || ''));
    broadcast('todos', { todos: desk.state.todos, rev: desk.state.rev });
    return json(res, ok ? 200 : 404, { ok, todos: desk.state.todos, rev: desk.state.rev });
  }
  if (req.method === 'POST' && p === '/api/todos/clear-done') {
    const removed = desk.clearDoneTodos();
    broadcast('todos', { todos: desk.state.todos, rev: desk.state.rev });
    return json(res, 200, { ok: true, removed, todos: desk.state.todos, rev: desk.state.rev });
  }

  // ---------------------------------------------------------------- roadmap
  // `?format=text` returns the two-line "where is he" block, for a hook to inject.
  // Nothing injects it yet — the endpoint exists so wiring it later is one line in
  // the hook, not a server change.
  // Local model management — Ollama visibility + VRAM control (lib/models.mjs).
  // GET is a live proxy, not a cache: the whole point is "what is in VRAM *now*".
  if (p === '/api/models') {
    return json(res, 200, await modelsSnapshot());
  }
  // Unload/load are the only writes, and neither destroys anything — a model
  // leaves memory, never disk. Install/delete stay in the terminal on purpose.
  if (req.method === 'POST' && p === '/api/models/unload') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    const name = String(b.name || '');
    if (!name) return json(res, 400, { error: 'name required' });
    try { await modelUnload(name); } catch (e) { return json(res, 502, { error: String(e.message) }); }
    return json(res, 200, { ok: true, ...(await modelsSnapshot()) });
  }
  if (req.method === 'POST' && p === '/api/models/load') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    const name = String(b.name || '');
    if (!name) return json(res, 400, { error: 'name required' });
    try { await modelLoad(name, b.keep_alive); } catch (e) { return json(res, 502, { error: String(e.message) }); }
    return json(res, 200, { ok: true, ...(await modelsSnapshot()) });
  }
  if (p === '/api/roadmap') {
    if (url.searchParams.get('format') === 'text') return text(res, 200, roadmap.block());
    return json(res, 200, roadmap.snapshot());
  }
  // Marking, not ticking. There is no endpoint that just sets an item done — a score
  // is required, and the score is what decides whether it passed. The GUI cannot reach
  // this: it is Claude's, called after actually looking at the work. See lib/roadmap.mjs.
  if (req.method === 'POST' && p === '/api/roadmap/mark') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    let hit;
    try { hit = roadmap.mark(String(b.id || ''), b); }
    catch (e) { return json(res, 400, { error: String(e.message) }); }
    if (!hit) return json(res, 404, { error: 'roadmap item not found' });
    const snap = roadmap.snapshot();
    broadcast('roadmap', { roadmap: snap, marked: hit });
    return json(res, 200, { ok: true, mark: hit, roadmap: snap });
  }
  // Undo a marking mistake. Also not reachable from the GUI.
  if (req.method === 'POST' && p === '/api/roadmap/unmark') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    const hit = roadmap.unmark(String(b.id || ''));
    if (!hit) return json(res, 404, { error: 'no mark on that item' });
    const snap = roadmap.snapshot();
    broadcast('roadmap', { roadmap: snap });
    return json(res, 200, { ok: true, ...hit, roadmap: snap });
  }

  if (req.method === 'POST' && p === '/api/schedule/remove') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    const ok = desk.removeBlock(String(b.id || ''));
    broadcast('schedule', { schedule: desk.state.schedule, next: desk.next() });
    return json(res, ok ? 200 : 404, { ok, schedule: desk.state.schedule, next: desk.next() });
  }

  // ---------------------------------------------------------------- pad
  // The desk's notes box is a sticky note inside .desk.json; this is the notebook
  // page behind the pad tab. POST before GET: they share a path, and the bare
  // `p ===` form would swallow the POST.
  if (req.method === 'POST' && p === '/api/scratchpad') {
    const b = await readBody(req);
    if (b.__tooLarge) return json(res, 413, { error: 'body too large' });
    if (typeof b.text !== 'string') return json(res, 400, { error: 'text required' });
    try { fs.mkdirSync(path.dirname(SCRATCH_FILE), { recursive: true }); } catch {}
    fs.writeFileSync(SCRATCH_FILE, b.text, 'utf8');
    return json(res, 200, { ok: true, bytes: Buffer.byteLength(b.text, 'utf8') });
  }
  if (p === '/api/scratchpad') {
    let text = '';
    try { text = fs.readFileSync(SCRATCH_FILE, 'utf8'); } catch {}
    return json(res, 200, { text, file: SCRATCH_FILE });
  }

  // ---------------------------------------------------------------- goals
  // Jordan's goals, straight from the vault note (knowledge/people/jordan-goals.md).
  // The GUI opens them at the start of every day; one source of truth, so editing
  // the note is editing the panel. Read per request, like the scratchpad — the file
  // is a few hundred bytes and a cache would only add a way to be stale.
  if (p === '/api/goals') {
    const gf = path.join(VAULT, 'knowledge', 'people', 'jordan-goals.md');
    let raw = '';
    try { raw = fs.readFileSync(gf, 'utf8'); } catch {}
    // The panel wants the goals, not the metadata block.
    const body = raw.replace(/^---[\s\S]*?\n---\r?\n/, '').trim();
    let mtime = null; try { mtime = fs.statSync(gf).mtimeMs; } catch {}
    return json(res, 200, { text: body, file: gf, updated: mtime });
  }

  // static
  // v1 was deleted 2026-08-22; v2 IS the app now and lives at '/'. The old
  // /v2.html path stays aliased so existing bookmarks and notes keep working.
  let f = (p === '/' || p === '/v2.html') ? '/index.html' : p;
  const file = path.normalize(path.join(ROOT, 'web', f));
  const webRoot = path.join(ROOT, 'web');
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[metis] http://${HOST}:${PORT}  (SSE /api/events · session /api/session · replay /api/replay)`);
  console.log(`[metis] live transcript: ${newestSession()?.path ?? '(none)'}`);
});

process.on('SIGINT', () => { tracker.stop(); loadout.save(); activity.save(); fsg.save(); desk.save(true); process.exit(0); });
