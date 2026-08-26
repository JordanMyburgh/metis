// search.mjs — CLI front end for /api/search.
// Usage: node tools/search.mjs <query...> [--limit N] [--group G] [--tag T] [--json]
//
// Prefers the running server so results come from the graph it already has in
// memory AND so the hit fires the 'touch' broadcast (see server.mjs /api/search) —
// that's what makes the fire visuals light up exactly what was searched for. Falls
// back to building a local index if the server is down, so this still works cold.
import path from 'node:path';
import { buildGraph } from '../lib/vault-index.mjs';
import { buildIndex, search } from '../lib/search-index.mjs';

const PORT = Number(process.env.METIS_PORT || 8780);
const HOST = '127.0.0.1';

function parseArgs(argv) {
  const opts = { limit: 8, group: null, tag: null, json: false };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--limit') opts.limit = Number(argv[++i]) || 8;
    else if (a === '--group') opts.group = argv[++i];
    else if (a === '--tag') opts.tag = argv[++i];
    else words.push(a);
  }
  opts.query = words.join(' ');
  return opts;
}

async function viaServer(opts) {
  const qs = new URLSearchParams({ q: opts.query, limit: String(opts.limit) });
  if (opts.group) qs.set('group', opts.group);
  if (opts.tag) qs.set('tag', opts.tag);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1200);
  try {
    const r = await fetch(`http://${HOST}:${PORT}/api/search?${qs}`, { signal: ac.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

function viaLocal(opts) {
  const graph = buildGraph();
  const index = buildIndex(graph);
  return search(index, opts.query, opts);
}

function render(out, opts, live) {
  if (opts.json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`"${out.query}" — ${out.count}/${out.total} hits (${out.tookMs}ms${live ? ', live — fired' : ', local index'})`);
  if (!out.count) { console.log('  (no matches)'); return; }
  for (const h of out.hits) {
    console.log(`\n${h.id}  [${h.group}]  score=${h.score}`);
    console.log(`  ${h.abs}`);
    if (h.snippet) console.log(`  ${h.snippet}`);
  }
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.query) {
    console.error('usage: node tools/search.mjs <query...> [--limit N] [--group G] [--tag T] [--json]');
    process.exit(1);
  }
  const fromServer = await viaServer(opts);
  if (fromServer) { render(fromServer, opts, true); return; }
  render(viaLocal(opts), opts, false);
})();
