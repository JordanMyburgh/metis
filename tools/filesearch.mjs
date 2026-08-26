#!/usr/bin/env node
// filesearch.mjs — the FileSearch executable behind the FileSearch skill.
//
// One entry point for "where is this file", so that every lookup produces (a) a
// resolved path, (b) a node on the Metis FileSystem tree, and (c) a log line saying
// what triggered it, what was tried, what worked and what it cost.
//
// The skill is the INTENT half of the system and this is its hands. The other half is
// tools/fs-hook.mjs, which is registered as a PreToolUse hook and catches every file
// any tool touches whether or not anyone remembered to come through here. A skill is
// markdown loaded into a model's context — it is advisory and it can be forgotten. A
// hook is run by the harness and cannot. Both write the same log, via the same server
// endpoint, so the record is complete either way; what only THIS path can supply is
// the "why", which no hook can infer.
//
//   node tools/filesearch.mjs <path-or-query> [options]
//     --why "<reason>"     why the file is needed (free text, lands in the log)
//     --trigger "<what>"   user-message | tool-result | internal-decision | <free text>
//     --terms "a,b"        extra search terms, OR-ed with the query
//     --root <dir>         extra search root (repeatable)
//     --content            also search file CONTENT, not just names
//     --limit <n>          max hits to report (default 8)
//     --json               machine-readable output
//     --quiet              print only the resolved path
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalise } from '../lib/fsgraph.mjs';
import { attempt, methodLine, spoolAppend } from '../lib/fslog.mjs';
import { getJSON, postJSON } from '../lib/httpjson.mjs';
import { FS_ROOTS } from '../lib/config.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const PORT = Number(process.env.METIS_PORT || 8780);
const BASE = `http://127.0.0.1:${PORT}`;

// C:/Gitnexus is deliberately NOT a default root. Measured, a filename sweep across
// AI + .claude + Gitnexus cost 407ms warm and most of that was Gitnexus. Indexed code
// is queried through the gitnexus MCP (structure first, then a narrow read), which is
// the standing rule anyway — so pay for it only when asked, via --root.
const DEFAULT_ROOTS = FS_ROOTS
  .split(/[;,]/).map((s) => s.trim()).filter(Boolean);

// ------------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const o = { query: [], roots: [], limit: 8, why: null, trigger: 'internal-decision',
              terms: [], content: false, json: false, quiet: false, order: null, allHits: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--why') o.why = argv[++i];
    else if (a === '--trigger') o.trigger = argv[++i];
    else if (a === '--terms') o.terms = String(argv[++i] || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    else if (a === '--root') o.roots.push(argv[++i]);
    else if (a === '--limit') o.limit = Math.max(1, Math.min(50, Number(argv[++i]) || 8));
    else if (a === '--content') o.content = true;
    else if (a === '--files-first') o.order = 'files';
    else if (a === '--notes-first') o.order = 'notes';
    else if (a === '--all-hits') o.allHits = true;
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else o.query.push(a);
  }
  o.q = o.query.join(' ').trim();
  if (!o.roots.length) o.roots = DEFAULT_ROOTS.slice();
  o.roots = o.roots.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
  return o;
}

// ------------------------------------------------------------------- ripgrep
// `rg` on this machine's PATH is a BASH FUNCTION that Claude Code installs — it
// re-enters claude.exe with ARGV0=rg. That works in an interactive shell and is
// invisible to spawnSync, which found ENOENT for both `rg` and `rg.exe`. So ripgrep
// has to be resolved to a real binary, in this order:
//
//   1. $METIS_RG            — explicit override, wins over everything
//   2. PATH                 — a proper install (recommended: winget install BurntSushi.ripgrep.MSVC)
//   3. VS Code's vendored copy — real, but under a build-hash directory that changes
//                                on every VS Code update, so it is discovered, not
//                                hard-coded, and re-discovered when the cache goes stale
//
// The result is cached to .rg-path.json because globbing the VS Code tree costs ~1s
// and this runs on every lookup. If nothing is found the ladder records
// `ripgrep-name -> unavailable` and falls through to the bounded walk — the search
// still answers, it just answers slower, and the log says why.
const RG_CACHE = path.join(ROOT, '.rg-path.json');

function works(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}

function findVendoredRg() {
  const bases = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'),
    path.join(process.env.ProgramFiles || '', 'Microsoft VS Code'),
    path.join(process.env.USERPROFILE || '', '.local'),
  ].filter((b) => { try { return fs.statSync(b).isDirectory(); } catch { return false; } });
  const out = [];
  for (const base of bases) {
    const stack = [[base, 0]];
    while (stack.length && out.length < 1) {
      const [d, depth] = stack.pop();
      if (depth > 8) continue;
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push([full, depth + 1]);
        else if (e.name.toLowerCase() === 'rg.exe') { out.push(full); break; }
      }
    }
  }
  return out[0] || null;
}

function resolveRg() {
  if (process.env.METIS_RG && works(process.env.METIS_RG)) return process.env.METIS_RG;
  try {
    const c = JSON.parse(fs.readFileSync(RG_CACHE, 'utf8'));
    if (c.rg && fs.existsSync(c.rg) && works(c.rg)) return c.rg;
    if (c.rg === null && Date.now() - (c.at || 0) < 6 * 3600e3) return null;   // "none here", rechecked every 6h
  } catch { /* no cache yet */ }
  let found = works('rg.exe') ? 'rg.exe' : (works('rg') ? 'rg' : null);
  if (!found) found = findVendoredRg();
  if (found && !works(found)) found = null;
  try { fs.writeFileSync(RG_CACHE, JSON.stringify({ rg: found, at: Date.now() }), 'utf8'); } catch { /* fine */ }
  return found;
}

// ------------------------------------------------------------------- the ladder
// Order is Jordan's brief, with ONE deviation, made explicit in the log rather than
// hidden: when the input is already a concrete path that exists on disk, `direct`
// runs first and the search stages are recorded as `skipped`. Running a vault index
// query and a ripgrep sweep to "find" C:\AI\Brain\INDEX.md would cost hundreds of ms
// to learn what statSync answers in microseconds, and the log would then claim a
// search happened when nothing was searched.

function tryDirect(o) {
  const t0 = Date.now();
  const cands = [];
  const abs = normalise(o.q, process.cwd());
  if (abs) cands.push(abs);
  for (const r of o.roots) {
    const j = normalise(path.join(r, o.q), r);
    if (j && !cands.includes(j)) cands.push(j);
  }
  const hits = cands.filter((c) => { try { fs.statSync(c); return true; } catch { return false; } });
  return { att: attempt('direct', hits.length > 0, Date.now() - t0, hits.length ? null : 'no such path'), hits };
}

// Metis's own inverted index over the vault. Ranked note hits, ~1KB instead of the
// ~7KB a raw grep of the same term costs — and it lights the notes it matched.
async function tryMetisIndex(o) {
  const t0 = Date.now();
  const d = await getJSON(PORT, `/api/search?q=${encodeURIComponent(o.q)}&limit=${o.limit}`, 2500);
  if (!d) return { att: attempt('metis-index', false, Date.now() - t0, 'unavailable'), hits: [] };
  const hits = (d.hits || []).map((h) => normalise(h.abs, null)).filter(Boolean);
  return { att: attempt('metis-index', hits.length > 0, Date.now() - t0, hits.length ? `${hits.length} ranked notes` : 'no vault match'), hits };
}

function rgFiles(o) {
  const t0 = Date.now();
  if (!RG) return { att: attempt('ripgrep-name', false, Date.now() - t0, 'unavailable'), hits: [] };
  const pats = [o.q, ...o.terms].filter(Boolean);
  const hits = [];
  for (const root of o.roots) {
    for (const pat of pats) {
      const args = ['--files', '--iglob', `**/*${pat.replace(/[\\/]/g, '*')}*`,
                    '--iglob', '!**/node_modules/**', '--iglob', '!**/.git/**', root];
      const r = spawnSync(RG, args, { encoding: 'utf8', timeout: 6000, windowsHide: true, maxBuffer: 8e6 });
      for (const line of String(r.stdout || '').split('\n')) {
        const n = normalise(line.trim(), null);
        if (n && !hits.includes(n)) hits.push(n);
      }
      if (hits.length >= o.limit) break;
    }
    if (hits.length >= o.limit) break;
  }
  // Rank before truncating. The glob is a substring match, so searching `fsgraph.mjs`
  // returned `probe-fsgraph.mjs` first purely by directory order — the wrong answer to
  // a question that named an exact file. Exact basename wins, then a basename that
  // starts with the query, then shortest path (the least-nested match is usually the
  // real one rather than a copy or a build artefact).
  const q = o.q.toLowerCase();
  const base = (p) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  const rank = (p) => (base(p) === q ? 0 : base(p).startsWith(q) ? 1 : base(p).includes(q) ? 2 : 3);
  hits.sort((a, b) => rank(a) - rank(b) || a.length - b.length || (a < b ? -1 : 1));
  return { att: attempt('ripgrep-name', hits.length > 0, Date.now() - t0, hits.length ? `${hits.length} filename matches` : 'no filename match'), hits: hits.slice(0, o.limit) };
}

function rgContent(o) {
  const t0 = Date.now();
  if (!RG) return { att: attempt('ripgrep-content', false, Date.now() - t0, 'unavailable'), hits: [] };
  const hits = [];
  for (const root of o.roots) {
    const args = ['-i', '-l', '--max-filesize', '2M', '-g', '!node_modules', '-g', '!.git',
                  '-g', '!*.jsonl', '--', o.q, root];
    const r = spawnSync(RG, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8e6 });
    for (const line of String(r.stdout || '').split('\n')) {
      const n = normalise(line.trim(), null);
      if (n && !hits.includes(n)) hits.push(n);
    }
    if (hits.length >= o.limit) break;
  }
  return { att: attempt('ripgrep-content', hits.length > 0, Date.now() - t0, hits.length ? `${hits.length} files contain it` : 'no content match'), hits: hits.slice(0, o.limit) };
}

// Last resort. fd is not installed on this machine (checked, not assumed), and if
// ripgrep ever goes missing too a plain walk still answers rather than the whole
// skill failing. Bounded so a wrong root cannot walk the disk.
function walk(o) {
  const t0 = Date.now();
  const needle = o.q.toLowerCase();
  const hits = [];
  let seen = 0;
  const SKIP = new Set(['node_modules', '.git', '.gitnexus', 'AppData', 'Windows', '$Recycle.Bin']);
  for (const root of o.roots) {
    const stack = [root];
    while (stack.length && hits.length < o.limit && seen < 60000) {
      const d = stack.pop();
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        seen++;
        if (SKIP.has(e.name)) continue;
        const full = d.replace(/\\/g, '/') + '/' + e.name;
        if (e.name.toLowerCase().includes(needle)) { const n = normalise(full, null); if (n && !hits.includes(n)) hits.push(n); }
        if (e.isDirectory()) stack.push(full);
      }
    }
  }
  return { att: attempt('walk', hits.length > 0, Date.now() - t0, `${seen} entries scanned`), hits: hits.slice(0, o.limit) };
}

const RG = resolveRg();

// ------------------------------------------------------------------- graph + log
async function report(payload) {
  const r = await postJSON(PORT, '/api/fs/touch', payload, 2500);
  if (r) return r;
  // Metis is down. The lookup still happened, so the line is still written — it just
  // waits in the spool until the server is back and can replay it into the real log.
  spoolAppend(LOG_DIR, { ...payload, error: payload.error || 'metis offline — spooled' });
  return { ok: false, offline: true, ids: [], created: [], pruned: [], resolved: payload.paths || [] };
}

// ------------------------------------------------------------------- main
(async () => {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.q) {
    console.log('usage: node tools/filesearch.mjs <path-or-query> [--why "..."] [--trigger "..."]');
    console.log('       [--terms a,b] [--root DIR] [--content] [--limit N] [--json] [--quiet]');
    process.exit(o.help ? 0 : 2);
  }

  const t0 = Date.now();
  const methods = [];
  let hits = [];

  // Which question is this? The vault index answers "WHICH NOTE IS ABOUT x" and
  // ripgrep answers "WHERE IS THE FILE x". They are different questions, and running
  // them in a fixed order answers the wrong one half the time — measured: searching
  // "make-icons" hit metis-index first and resolved to knowledge/infra/metis.md,
  // because that note mentions the script. Correct as a topic answer, useless as a
  // file answer. So a query with no whitespace is treated as filename-shaped and goes
  // to ripgrep first; a phrase is treated as topic-shaped and goes to the index first.
  // --files-first / --notes-first override it, and the choice is written to the log.
  const shape = o.order || (/\s/.test(o.q) ? 'notes' : 'files');
  const skip = (n) => methods.push(attempt(n, false, 0, 'skipped'));

  const direct = tryDirect(o);
  methods.push(direct.att);
  if (direct.att.ok) {
    hits = direct.hits;
    // Say plainly that the rest of the ladder never ran, rather than leaving a reader
    // to infer it from absence.
    skip('metis-index'); skip('ripgrep-name'); skip('ripgrep-content');
  } else {
    const runIndex = async () => { const r = await tryMetisIndex(o); methods.push(r.att); if (!hits.length) hits = r.hits; };
    const runName = () => { const r = rgFiles(o); methods.push(r.att); if (!hits.length) hits = r.hits; };
    if (shape === 'files') { runName(); if (!hits.length) await runIndex(); else skip('metis-index'); }
    else { await runIndex(); if (!hits.length) runName(); else skip('ripgrep-name'); }
    if (!hits.length || o.content) { const rc = rgContent(o); methods.push(rc.att); if (!hits.length) hits = rc.hits; }
    else skip('ripgrep-content');
    if (!hits.length) { const w = walk(o); methods.push(w.att); hits = w.hits; }
  }

  hits = hits.slice(0, o.limit);
  const winner = methods.filter((m) => m.ok).map((m) => m.name)[0] || null;
  const ms = Date.now() - t0;

  // Only the RESOLVED path becomes a node. The alternatives are search output, not
  // accesses — graphing all eight candidates of a vault query would make the tree
  // claim files were opened that never were, and the tree's whole job is letting
  // Jordan check that the right file was opened. If one of the alternatives IS then
  // opened, the PreToolUse hook records that on its own. --all-hits opts back in.
  const toGraph = o.allHits ? hits : hits.slice(0, 1);

  const graph = await report({
    paths: toGraph.length ? toGraph : [normalise(o.q, process.cwd())].filter(Boolean),
    cwd: process.cwd(),
    via: 'skill:FileSearch',
    tool: 'FileSearch',
    trigger: o.trigger,
    reason: o.why,
    methods, method: winner,
    requested: o.q,
    ok: hits.length > 0,
    error: hits.length ? null : 'not found',
    ms,
    shape,
  });

  const out = {
    ok: hits.length > 0,
    requested: o.q,
    resolved: hits[0] || null,
    alternatives: hits.slice(1),
    method: winner,
    ladder: methodLine(methods),
    ms,
    graph: {
      created: graph.created || [],
      pruned: graph.pruned || [],
      nodes: graph.ids || [],
      counts: graph.counts || null,
      offline: !!graph.offline,
    },
  };

  if (o.json) { console.log(JSON.stringify(out, null, 2)); process.exit(out.ok ? 0 : 1); }
  if (o.quiet) { if (out.resolved) console.log(out.resolved); process.exit(out.ok ? 0 : 1); }

  console.log(`FileSearch  "${o.q}"`);
  console.log(`  trigger   ${o.trigger}${o.why ? '\n  why       ' + o.why : ''}`);
  console.log(`  read as   ${shape === 'files' ? 'a filename (ripgrep first)' : 'a topic (vault index first)'}`);
  console.log(`  ladder    ${out.ladder}`);
  if (out.ok) {
    console.log(`  RESOLVED  ${out.resolved}`);
    if (out.alternatives.length) {
      console.log(`  also      ${out.alternatives.slice(0, 5).join('\n            ')}`);
      if (out.alternatives.length > 5) console.log(`            (+${out.alternatives.length - 5} more, raise --limit to see them)`);
    }
  } else {
    console.log('  RESOLVED  (not found)');
  }
  const c = out.graph.created;
  console.log(`  graph     ${c.length ? '+' + c.length + ' new node(s): ' + c.map((x) => x.replace(/^fs::/, '')).join(' -> ') : 'no new nodes (path already on the tree)'}`);
  if (out.graph.pruned.length) console.log(`  evicted   ${out.graph.pruned.length} cold node(s) to stay under the cap`);
  if (out.graph.offline) console.log('  NOTE      Metis is not answering on 8780 — logged to the spool, graph not updated');
  console.log(`  took      ${ms}ms`);
  process.exit(out.ok ? 0 : 1);
})();
