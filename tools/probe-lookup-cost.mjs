#!/usr/bin/env node
// probe-lookup-cost.mjs - measure what it COSTS to find something in the front-end.
//
// Written to settle one question with numbers instead of opinion: how much context does
// an agent have to pull in to locate a piece of the renderer precisely enough to edit it?
//
// It measures three paths for the same three targets, so the comparison is honest:
//
//   A  naive      read the whole file. What actually happened on 2026-08-23.
//   B  grep       search for the word in the QUESTION (not an insider symbol name),
//                 then read a +/-20 line span around the top hit clusters.
//   C  graph      GitNexus gives file + line range, read exactly that span.
//                 Only possible when the code is visible to the indexer.
//
// B matters. Comparing the worst old behaviour against the best new one would prove
// nothing - B is what a careful agent could already do without any change at all.
//
// Path C's locate step is an MCP call, so its cost is passed in with --graph-locate=N
// (bytes of the returned JSON) and the span is computed from --symbol=name:start:end.
//
//   node tools/probe-lookup-cost.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');

// Post-split the module lives in its own file; pre-split it is inline in the HTML.
// The probe follows whichever exists so the same command works in both states.
const APP = fs.existsSync(path.join(WEB, 'app.js')) ? path.join(WEB, 'app.js') : path.join(WEB, 'index.html');
const STATE = APP.endsWith('app.js') ? 'post-split' : 'pre-split';

// Claude's tokeniser is not public, so bytes are the exact measurement and tokens are
// derived. 3.6 chars/token is a reasonable figure for dense source; it is applied
// identically to every path, so the RATIOS hold even if the absolute is off.
const CHARS_PER_TOKEN = 3.6;
const tok = (bytes) => Math.round(bytes / CHARS_PER_TOKEN);

const SPAN = 20;          // lines either side of a hit, the usual "read around it" move
const MAX_CLUSTERS = 3;   // a real agent reads a few promising spots, not all 40

// The search term is the word from the QUESTION. Using the real symbol name would be
// insider knowledge the agent does not have before it has read the file.
const TARGETS = [
  { name: 'link drawing loop', term: 'link' },
  { name: 'flare animation', term: 'flare' },
  { name: 'legend builder', term: 'legend' },
];

const src = fs.readFileSync(APP, 'utf8');
const lines = src.split('\n');
const fileBytes = Buffer.byteLength(src, 'utf8');

function grepCost(term) {
  const re = new RegExp(term, 'i');
  const hits = [];
  lines.forEach((l, i) => { if (re.test(l)) hits.push({ n: i + 1, text: l }); });
  // What `grep -n` would print back into context.
  const grepBytes = Buffer.byteLength(hits.map((h) => `${h.n}:${h.text}`).join('\n'), 'utf8');

  // Merge hits that sit within 25 lines of each other into one "place to look".
  const clusters = [];
  for (const h of hits) {
    const last = clusters[clusters.length - 1];
    if (last && h.n - last.end <= 25) { last.end = h.n; last.count++; }
    else clusters.push({ start: h.n, end: h.n, count: 1 });
  }
  // Densest clusters first - the ones an agent would actually open.
  const chosen = clusters.slice().sort((a, b) => b.count - a.count).slice(0, MAX_CLUSTERS);
  let spanBytes = 0;
  const spans = [];
  for (const c of chosen) {
    const a = Math.max(1, c.start - SPAN), b = Math.min(lines.length, c.end + SPAN);
    spanBytes += Buffer.byteLength(lines.slice(a - 1, b).join('\n'), 'utf8');
    spans.push(`${a}-${b}`);
  }
  return { hits: hits.length, clusters: clusters.length, grepBytes, spanBytes, spans, total: grepBytes + spanBytes };
}

// --- path C -----------------------------------------------------------------
// Only available once the code is visible to the indexer. The locate cost is the size
// of the MCP response, measured from the real call - it is NOT free, and context()
// output is repetitive (the `frame` reply repeats the same Const rows twenty times).
// Spans are the symbol's own start/end from the graph, so the read is exact.
const PATH_C = STATE === 'post-split' ? [
  { name: 'link drawing loop', symbol: 'frame',     start: 113, end: 304, locateBytes: 3600 },
  { name: 'flare animation',   symbol: 'frame',     start: 113, end: 304, locateBytes: 0 },   // same call answers both
  { name: 'legend builder',    symbol: 'loadGraph', start: 409, end: 507, locateBytes: 1250 },
] : null;

const NL = String.fromCharCode(10);
function spanBytes(a, b) {
  return Buffer.byteLength(lines.slice(a - 1, b).join(NL), 'utf8');
}

const rows = TARGETS.map((t) => {
  const g = grepCost(t.term);
  return { ...t, ...g };
});

const naiveTotal = fileBytes * TARGETS.length;   // one full read per question, worst case
const naiveOnce = fileBytes;                     // charitable: read once, answer all three
const grepTotal = rows.reduce((s, r) => s + r.total, 0);

let cRows = null, cTotal = null;
if (PATH_C) {
  const seen = new Set();
  cRows = PATH_C.map((c) => {
    // Two questions answered by one symbol are charged the read once, not twice.
    const dup = seen.has(c.symbol);
    seen.add(c.symbol);
    const read = dup ? 0 : spanBytes(c.start, c.end);
    return { ...c, readBytes: read, bytes: c.locateBytes + read };
  });
  cTotal = cRows.reduce((s, r) => s + r.bytes, 0);
}

const out = {
  state: STATE,
  file: path.relative(ROOT, APP).replace(/\\/g, '/'),
  fileLines: lines.length,
  fileBytes,
  paths: {
    A_naive_once: { bytes: naiveOnce, tokens: tok(naiveOnce) },
    A_naive_per_question: { bytes: naiveTotal, tokens: tok(naiveTotal) },
    B_grep: { bytes: grepTotal, tokens: tok(grepTotal) },
  },
  targets: rows.map((r) => ({
    target: r.name, term: r.term, hits: r.hits, clusters: r.clusters,
    grepBytes: r.grepBytes, spanBytes: r.spanBytes, spans: r.spans,
    bytes: r.total, tokens: tok(r.total),
  })),
};

if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(`\nLOOKUP COST  (${STATE})   ${out.file}   ${out.fileLines} lines / ${fileBytes.toLocaleString()} bytes`);
console.log(`tokens estimated at ${CHARS_PER_TOKEN} chars/token, applied identically to every path\n`);
console.log(`  ${pad('PATH', 34)}${num('BYTES', 10)}${num('~TOKENS', 10)}`);
console.log(`  ${'-'.repeat(54)}`);
console.log(`  ${pad('A  read the file once', 34)}${num(naiveOnce.toLocaleString(), 10)}${num(tok(naiveOnce).toLocaleString(), 10)}`);
console.log(`  ${pad('A  read it per question (x3)', 34)}${num(naiveTotal.toLocaleString(), 10)}${num(tok(naiveTotal).toLocaleString(), 10)}`);
console.log(`  ${pad('B  grep + read spans (3 targets)', 34)}${num(grepTotal.toLocaleString(), 10)}${num(tok(grepTotal).toLocaleString(), 10)}`);
if (cTotal !== null) {
  console.log(`  ${pad('C  graph locate + exact span', 34)}${num(cTotal.toLocaleString(), 10)}${num(tok(cTotal).toLocaleString(), 10)}`);
} else {
  console.log(`  ${pad('C  graph locate + exact span', 34)}${num('n/a', 10)}${num('n/a', 10)}   <- front-end invisible to the indexer`);
}
console.log(`\n  per target, path B:`);
for (const r of rows) {
  console.log(`    ${pad(r.name, 20)} ${num(r.hits, 4)} hits in ${num(r.clusters, 3)} places  ->  ${num(r.total.toLocaleString(), 8)} bytes  (${num(tok(r.total).toLocaleString(), 6)} tok)   spans ${r.spans.join(', ')}`);
}
if (cRows) {
  console.log(`${NL}  per target, path C:`);
  for (const r of cRows) {
    console.log(`    ${pad(r.name, 20)} ${pad(r.symbol + ':' + r.start + '-' + r.end, 22)} locate ${num(r.locateBytes.toLocaleString(), 6)} + read ${num(r.readBytes.toLocaleString(), 6)}  =  ${num(r.bytes.toLocaleString(), 7)} bytes`);
  }
}
console.log('');
