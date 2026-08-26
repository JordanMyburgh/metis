#!/usr/bin/env node
// probe-categories.mjs — verify the CATEGORY NETWORKS render and route correctly.
//
// Same reason probe-fsgraph.mjs and probe-chronicle.mjs exist: requestAnimationFrame
// is paused in a hidden tab, so the in-app browser pane reports a 1x1 canvas and zero
// painted pixels. That is evidence of nothing either way, so the geometry and the
// routing get checked headlessly against the real /api/graph payload, using the
// renderer's own projection and fitAll copied verbatim from web/index.html.
//
// What it asserts, in the order that matters:
//   1. every node still projects on-screen after fitAll   — Jordan's standing invariant
//   2. every vault category is a real network: gateway + backbone spur
//   3. the flare route is core -> gateway -> node, and it is the SHORTEST one
//   4. category clusters do not overlap each other, the core, or the outer islands
//   5. every note sits inside its own category's cloud
//   6. link colour is derivable from the category at each end
//
//   node tools/probe-categories.mjs [WIDTHxHEIGHT ...]
import { getJSON } from '../lib/httpjson.mjs';

const PORT = Number(process.env.METIS_PORT || 8780);

const sizes = process.argv.slice(2).filter((a) => /^\d+x\d+$/.test(a)).map((a) => a.split('x').map(Number));
if (!sizes.length) sizes.push([1529, 1112], [1430, 1011], [1149, 1044], [820, 700]);

// --- renderer code, verbatim ------------------------------------------------
const HOME = { yaw: 1.240, pitch: Math.PI / 2 };
function makeCam(W, H, FOCAL) {
  let zoom = 1, panX = 0, panY = 0;
  const CY = Math.cos(HOME.yaw), SY = Math.sin(HOME.yaw);
  const CP = Math.cos(HOME.pitch), SP = Math.sin(HOME.pitch);
  let VS = zoom * (Math.min(W, H) / 620);
  const project = (p) => {
    const x = p[0] * CY - p[2] * SY, z0 = p[0] * SY + p[2] * CY;
    const y = p[1] * CP - z0 * SP; const z = p[1] * SP + z0 * CP;
    let den = FOCAL + z; if (den < 140) den = 140;
    const f = FOCAL / den * VS;
    return [W / 2 + panX + x * f, H / 2 + panY + y * f, z, f];
  };
  const set = (z, px, py) => { zoom = z; panX = px; panY = py; VS = zoom * (Math.min(W, H) / 620); };
  return { project, set };
}
function fitAll(cam, nodes, layout, W, H, margin = 78, chron = true) {
  cam.set(1, 0, 0);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, n = 0;
  for (const nd of nodes) {
    const p = layout[nd.id]; if (!p) continue;
    const q = cam.project(p), dx = q[0] - W / 2, dy = q[1] - H / 2;
    if (dx < minX) minX = dx; if (dx > maxX) maxX = dx;
    if (dy < minY) minY = dy; if (dy > maxY) maxY = dy; n++;
  }
  if (!n) return;
  const hx = Math.max(1, (maxX - minX) / 2), hy = Math.max(1, (maxY - minY) / 2);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const bot = chron ? 116 : 0;
  const zoom = Math.max(0.05, Math.min(3.4, Math.min((W / 2 - margin) / hx, ((H - bot) / 2 - margin) / hy)));
  cam.set(zoom, -cx * zoom, -cy * zoom - bot / 2);
}
// Colour table, verbatim from web/index.html
const COLORS = {
  knowledge: '#22ccff', feedback: '#f2b85c', library: '#b888ff', projects: '#54e6a6',
  agents: '#ff3344', decisions: '#ff4d9d', output: '#4a6a8a', root: '#6a7a94', missing: '#8a3b52',
};
const ISLAND_COL = { vault: '#22ccff', mcp: '#54e6a6', skills: '#b888ff', tools: '#f2b85c', fs: '#4b8fe8', core: '#ff3344' };
const FS_FOLDER = '#4b8fe8', FS_FILE = '#7fd964', FS_MISSING = '#8a6b3b';
const nodeCol = (n) => (n.domain === 'fs'
  ? (n.exists === false ? FS_MISSING : (n.kind === 'file' ? FS_FILE : FS_FOLDER))
  : (n.domain === 'vault' ? (COLORS[n.group] || '#6a7a94') : (ISLAND_COL[n.domain] || '#6a7a94')));
// ----------------------------------------------------------------------------

const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); };

const g = await getJSON(PORT, '/api/graph', 5000);
if (!g) { console.error('probe-categories: Metis is not answering on ' + PORT); process.exit(2); }

const byId = new Map(g.nodes.map((n) => [n.id, n]));
const vaultNotes = g.nodes.filter((n) => n.domain === 'vault' && n.kind !== 'gateway');
const cats = g.categories || {};
const catIds = Object.keys(cats);

// ---------------------------------------------------------------- 1. every node on screen
for (const [W, H] of sizes) {
  const cam = makeCam(W, H, g.focal || 600);
  fitAll(cam, g.nodes, g.layout, W, H);
  let off = 0, worst = '';
  for (const n of g.nodes) {
    const p = g.layout[n.id]; if (!p) continue;
    const q = cam.project(p);
    if (q[0] < 0 || q[0] > W || q[1] < 0 || q[1] > H) {
      off++;
      if (!worst) worst = `${n.id} at ${Math.round(q[0])},${Math.round(q[1])}`;
    }
  }
  ok(`${W}x${H}: every node on screen`, off === 0, off ? `${off} off-screen, first ${worst}` : `${g.nodes.length} nodes framed`);
}

// ---------------------------------------------------------------- 2. each category is a network
{
  const missingGw = catIds.filter((c) => !byId.has(`cat::${c}`));
  ok('every category has a gateway', missingGw.length === 0,
    missingGw.length ? missingGw.join(',') : `${catIds.length} gateways`);

  const spurs = new Set(g.backbone.filter((l) => l.source === 'core').map((l) => l.target));
  const noSpur = catIds.filter((c) => !spurs.has(`cat::${c}`));
  ok('every category hangs off the core backbone', noSpur.length === 0,
    noSpur.length ? noSpur.join(',') : `${catIds.length} spurs`);

  const orphan = vaultNotes.filter((n) => !cats[n.group]);
  ok('every note belongs to a placed category', orphan.length === 0,
    orphan.length ? orphan.slice(0, 3).map((n) => n.id).join(',') : `${vaultNotes.length} notes`);
}

// ---------------------------------------------------------------- 3. routing
const adj = new Map();
for (const l of [...g.links, ...g.systemLinks, ...g.backbone]) {
  if (!byId.has(l.source) || !byId.has(l.target)) continue;
  if (!adj.has(l.source)) adj.set(l.source, []);
  if (!adj.has(l.target)) adj.set(l.target, []);
  adj.get(l.source).push(l.target);
  adj.get(l.target).push(l.source);
}
function route(a, b) {
  if (a === b) return [a];
  const prev = new Map([[a, a]]);
  const q = [a];
  for (let h = 0; h < q.length; h++) {
    for (const v of adj.get(q[h]) || []) {
      if (prev.has(v)) continue;
      prev.set(v, q[h]);
      if (v === b) {
        const o = [v];
        let x = q[h];
        while (x !== a) { o.push(x); x = prev.get(x); }
        o.push(a);
        return o.reverse();
      }
      q.push(v);
    }
  }
  return null;
}
{
  let bad = 0, unreachable = 0, firstBad = '';
  for (const n of vaultNotes) {
    const p = route('core', n.id);
    if (!p) { unreachable++; continue; }
    if (p.length !== 3 || p[1] !== `cat::${n.group}`) {
      bad++;
      if (!firstBad) firstBad = `${n.id}: ${p.join(' -> ')}`;
    }
  }
  ok('every note routes core -> its category -> itself', bad === 0 && unreachable === 0,
    (bad || unreachable) ? `${bad} wrong (${firstBad}), ${unreachable} unreachable` : `${vaultNotes.length} notes, all 2 hops`);

  // The example Jordan actually named.
  if (byId.has('tools::Bash')) {
    const p = route('core', 'tools::Bash');
    ok('the Bash example routes CLAUDE -> TOOLS -> Bash',
      !!p && p.length === 3 && p[1] === 'tools::gateway', p ? p.join(' -> ') : 'unreachable');
  } else {
    ok('the Bash example routes CLAUDE -> TOOLS -> Bash', false, 'no tools::Bash node in the loadout');
  }

  const hosts = g.nodes.filter((n) => ['mcp', 'skills', 'tools'].includes(n.domain) && n.kind !== 'gateway');
  let hbad = 0;
  for (const n of hosts) {
    const p = route('core', n.id);
    if (!p || p.length !== 3 || p[1] !== `${n.domain}::gateway`) hbad++;
  }
  ok('every mcp/skill/tool routes through its own gateway', hbad === 0,
    hbad ? `${hbad} wrong` : `${hosts.length} hosts, all 2 hops`);
}

// ---------------------------------------------------------------- 4. clusters stay apart
{
  const [W, H] = sizes[0];
  const cam = makeCam(W, H, g.focal || 600);
  fitAll(cam, g.nodes, g.layout, W, H);

  // On-screen bounding circle of each category, measured from where its notes land.
  const circles = [];
  for (const c of catIds) {
    const pts = vaultNotes.filter((n) => n.group === c).map((n) => cam.project(g.layout[n.id]));
    const gwPos = g.layout[`cat::${c}`];
    if (!pts.length || !gwPos) continue;
    const gw = cam.project(gwPos);
    const r = Math.max(...pts.map((p) => Math.hypot(p[0] - gw[0], p[1] - gw[1])));
    circles.push({ c, x: gw[0], y: gw[1], r });
  }

  let worst = 1e9, wp = '';
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const A = circles[i], B = circles[j];
      const gap = Math.hypot(A.x - B.x, A.y - B.y) - (A.r + B.r);
      if (gap < worst) { worst = gap; wp = `${A.c} <-> ${B.c}`; }
    }
  }
  ok('category clusters do not overlap each other', worst > 0, `tightest ${wp}: ${Math.round(worst)}px`);

  // ...nor the core, which is drawn as an accretion disk out to ~94 world units.
  const core = cam.project(g.layout.core || [0, 0, 0]);
  const edge = cam.project([94, 0, 0]);
  const coreR = Math.abs(edge[0] - core[0]);
  let nearest = 1e9, np = '';
  for (const C of circles) {
    const d = Math.hypot(C.x - core[0], C.y - core[1]) - C.r;
    if (d < nearest) { nearest = d; np = C.c; }
  }
  ok('category clusters clear the core disk', nearest > coreR,
    `nearest ${np}: ${Math.round(nearest)}px vs core ~${Math.round(coreR)}px`);

  // ...nor the outer islands.
  let ibad = 0, idet = '';
  for (const dom of ['mcp', 'skills', 'tools']) {
    const pts = g.nodes.filter((n) => n.domain === dom && g.layout[n.id]).map((n) => cam.project(g.layout[n.id]));
    if (!pts.length) continue;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const r = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy)));
    for (const C of circles) {
      const gap = Math.hypot(C.x - cx, C.y - cy) - (C.r + r);
      if (gap < 0) { ibad++; if (!idet) idet = `${C.c} overlaps ${dom} by ${Math.round(-gap)}px`; }
    }
  }
  ok('category clusters clear the outer islands', ibad === 0, ibad ? idet : 'all clear');
}

// ---------------------------------------------------------------- 5. notes inside their cloud
{
  let out = 0, firstOut = '';
  for (const n of vaultNotes) {
    const cat = cats[n.group];
    const p = g.layout[n.id];
    if (!cat || !p) continue;
    const d = Math.hypot(p[0] - cat.anchor[0], p[1] - cat.anchor[1], p[2] - cat.anchor[2]);
    if (d > cat.radius) { out++; if (!firstOut) firstOut = `${n.id} at ${Math.round(d)} > ${cat.radius}`; }
  }
  ok('every note sits inside its category cloud', out === 0,
    out ? `${out} outside, first ${firstOut}` : `${vaultNotes.length} notes`);
}

// ---------------------------------------------------------------- 6. link colour
{
  // A link's colour must be derivable from its endpoints alone — that is the contract
  // the renderer's colour bucketing relies on, and the thing that would silently break
  // if a group were ever added to the vault without a colour.
  let uncoloured = 0, crossing = 0, firstBad = '';
  for (const l of g.links) {
    const a = byId.get(l.source), b = byId.get(l.target);
    if (!a || !b) continue;
    if (nodeCol(a) !== nodeCol(b)) crossing++;
    for (const n of [a, b]) {
      if (n.domain === 'vault' && !COLORS[n.group]) {
        uncoloured++;
        if (!firstBad) firstBad = `${n.id} is group "${n.group}" which has no colour`;
      }
    }
  }
  ok('every vault link takes its colour from its endpoints', uncoloured === 0,
    uncoloured ? `${uncoloured} endpoints uncoloured, first ${firstBad}` : `${g.links.length} links, ${crossing} cross-category`);

  const spokes = g.systemLinks.filter((l) => String(l.source).startsWith('cat::'));
  let sbad = 0;
  for (const l of spokes) {
    const t = byId.get(l.target);
    if (!t || nodeCol(t) !== (COLORS[t.group] || '#6a7a94')) sbad++;
  }
  ok('category spokes wear their host category colour', sbad === 0,
    sbad ? `${sbad} wrong` : `${spokes.length} spokes`);
  ok('every note has a spoke to its gateway', spokes.length === vaultNotes.length,
    `${spokes.length} spokes for ${vaultNotes.length} notes`);
}

// ---------------------------------------------------------------- report
const pass = results.filter((r) => r.pass).length;
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
