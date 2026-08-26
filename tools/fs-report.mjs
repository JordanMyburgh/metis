#!/usr/bin/env node
// fs-report.mjs — read the FileSystem tree and the file-access log from a terminal.
//
// The GUI is the live picture; this is the same two things in text, for when the
// answer belongs in a conversation rather than on a canvas ("show me the file graph",
// "dump the access log"). It asks the running server first so the numbers match what
// is on screen exactly, and falls back to the on-disk cache and log file when Metis
// is not running — a report that only works when the GUI is up is a report you cannot
// use to debug the GUI being down.
//
//   node tools/fs-report.mjs graph [--format ascii|mermaid|json]
//   node tools/fs-report.mjs log   [--limit N] [--format table|json]
//                                  [--only fail] [--via skill|hook] [--path <substr>]
//   node tools/fs-report.mjs stats
import fs from 'node:fs';
import path from 'node:path';
import { FsGraph } from '../lib/fsgraph.mjs';
import { table as logTable, LOG_NAME } from '../lib/fslog.mjs';
import { getJSON, getText } from '../lib/httpjson.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.METIS_PORT || 8780);

const get = (url, asText) => (asText ? getText(PORT, url, 3000) : getJSON(PORT, url, 3000));

function parse(argv) {
  const o = { cmd: argv[0] || 'graph', format: null, limit: 25, only: null, via: null, path: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') o.format = argv[++i];
    else if (a === '--limit') o.limit = Math.max(1, Math.min(2000, Number(argv[++i]) || 25));
    else if (a === '--only') o.only = argv[++i];
    else if (a === '--via') o.via = argv[++i];
    else if (a === '--path') o.path = argv[++i];
  }
  return o;
}

// Local fallbacks — same code the server runs, pointed at the same files on disk.
function localGraph(format) {
  const g = new FsGraph(path.join(ROOT, '.fs-graph.json'));
  if (format === 'mermaid') return g.mermaid({});
  if (format === 'json') return JSON.stringify({ nodes: g.graphNodes(), links: g.graphLinks(), counts: g.counts() }, null, 2);
  return g.ascii({});
}
function localLog(o) {
  let rows = [];
  try {
    rows = fs.readFileSync(path.join(ROOT, 'logs', LOG_NAME), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no log yet */ }
  if (o.via) rows = rows.filter((r) => String(r.via || '').includes(o.via));
  if (o.only === 'fail') rows = rows.filter((r) => !r.ok);
  if (o.path) rows = rows.filter((r) => String(r.resolved || r.requested || '').toLowerCase().includes(o.path.toLowerCase()));
  return rows.slice(-o.limit);
}

(async () => {
  const o = parse(process.argv.slice(2));

  if (o.cmd === 'graph') {
    const fmt = o.format || 'ascii';
    if (fmt === 'json') {
      const live = await get('/api/fs/graph');
      console.log(live ? JSON.stringify(live, null, 2) : localGraph('json'));
      return;
    }
    const live = await get('/api/fs/graph?format=' + encodeURIComponent(fmt), true);
    if (live !== null) {
      console.log(live.trimEnd());
      // The accent is a live-only fact — the on-disk cache does not record which node
      // was last accessed, so say which source answered.
      console.log('\n(live from Metis on ' + PORT + ' — "<== ACCESSED" marks the current accent nodes)');
    } else {
      console.log(localGraph(fmt));
      console.log('\n(Metis is not running — read from .fs-graph.json, so no accent marks)');
    }
    if (fmt === 'ascii') console.log('legend: # root   + folder (blue)   * file (green)   accent = orange');
    return;
  }

  if (o.cmd === 'log') {
    const qs = `?limit=${o.limit}` + (o.only ? `&only=${o.only}` : '') + (o.via ? `&via=${encodeURIComponent(o.via)}` : '')
      + (o.path ? `&path=${encodeURIComponent(o.path)}` : '');
    if (o.format === 'json') {
      const live = await get('/api/fs/log' + qs);
      console.log(JSON.stringify(live || { entries: localLog(o) }, null, 2));
      return;
    }
    const live = await get('/api/fs/log' + qs + '&format=table', true);
    if (live !== null) { console.log(live.trimEnd()); return; }
    console.log(logTable(localLog(o)));
    console.log('\n(Metis is not running — read straight from logs/' + LOG_NAME + ')');
    return;
  }

  if (o.cmd === 'stats') {
    const s = await get('/api/status');
    if (s) {
      console.log('filesystem  ' + JSON.stringify(s.filesystem));
      console.log('log         ' + JSON.stringify(s.fsLog));
    } else {
      const g = new FsGraph(path.join(ROOT, '.fs-graph.json'));
      console.log('filesystem  ' + JSON.stringify(g.counts()) + '   (offline)');
    }
    return;
  }

  console.log('usage: node tools/fs-report.mjs graph|log|stats [options]  (see the header of this file)');
  process.exit(2);
})();
