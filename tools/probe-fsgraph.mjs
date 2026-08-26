#!/usr/bin/env node
// probe-fsgraph.mjs — verify the FileSystem tree actually RENDERS correctly.
//
// Same reason probe-chronicle.mjs exists: requestAnimationFrame is paused in a hidden
// tab, so the in-app browser pane reports a 1x1 canvas and zero painted pixels. That
// is not evidence of a broken renderer and it is not evidence of a working one, so
// the geometry gets checked headlessly instead, against the real /api/graph payload
// and the renderer's own projection and fitAll code, copied verbatim from
// web/index.html (lines 264-274 and 515-534).
//
// What it asserts, in the order that matters:
//   1. every node projects on-screen after fitAll   — Jordan's standing invariant
//   2. the fs tree does not land on top of the vault disk
//   3. parents sit inboard of their children        — the tree reads outward
//   4. folders and files carry the right colours
//   5. no two nodes land on the same pixel
//
//   node tools/probe-fsgraph.mjs [WIDTHxHEIGHT ...]
import { getJSON } from '../lib/httpjson.mjs';

const PORT = Number(process.env.METIS_PORT || 8780);
const FS_FOLDER = '#4b8fe8', FS_FILE = '#7fd964';

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
  return { project, set, get state() { return { zoom, panX, panY }; } };
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
// ----------------------------------------------------------------------------

const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); };

// --- the Bash path scraper -------------------------------------------------
// Guarded here because it produced a real wrong branch: without a token-boundary
// check the drive-letter pattern matched the "e:/" inside `file:///C:/AI/...` and
// the tree grew a drive E: containing C:/AI/Lab/metis/lib. Found by reading the
// rendered tree, not by reading the code — so it gets an assertion.
{
  const fsx = await import('node:fs');
  const src = fsx.readFileSync(new URL('./fs-hook.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function pathsFromBash'), src.indexOf('function extract'));
  const scrape = new Function('MAX_PATHS', 'return ' + body.slice(0, body.lastIndexOf('}') + 1))(6);
  const cases = [
    ['file:// URL yields the real path', String.raw`node -e "import('file:///C:/AI/Lab/metis/lib/httpjson.mjs')"`, ['C:/AI/Lab/metis/lib/httpjson.mjs']],
    ['two plain paths', String.raw`cat C:/AI/Handoff/README.md && ls C:/AI/Bridge`, ['C:/AI/Handoff/README.md', 'C:/AI/Bridge']],
    ['git-bash spelling', String.raw`grep -n foo /c/AI/Brain/INDEX.md`, ['/c/AI/Brain/INDEX.md']],
    ['backslashes, quoted', String.raw`sed -i s/a/b/ "C:\AI\Lab\metis\server.mjs"`, [String.raw`C:\AI\Lab\metis\server.mjs`]],
    ['backslashes, bare', String.raw`type C:\AI\Brain\INDEX.md`, [String.raw`C:\AI\Brain\INDEX.md`]],
    ['a URL is not a path', String.raw`curl -s https://example.com/a/b`, []],
    ['no paths at all', String.raw`echo nothing here`, []],
  ];
  let bad = 0;
  for (const [label, cmd, want] of cases) {
    const got = scrape(cmd);
    if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; ok('scraper: ' + label, false, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  }
  if (!bad) ok('bash path scraper', true, `${cases.length}/${cases.length} cases, no phantom drive letters`);

  // The plausibility filter — the second half of the same defence. A command that
  // TALKS ABOUT a path (a commit message describing a bug) scrapes identically to one
  // that uses it, so scraped candidates are checked against the filesystem.
  const pbody = src.slice(src.indexOf('function plausible'), src.indexOf('function extract'));
  const plausible = new Function('fs', 'normalise', 'return ' + pbody.slice(0, pbody.lastIndexOf('}') + 1))(
    await import('node:fs'), (await import('../lib/fsgraph.mjs')).normalise);
  const pcases = [
    ['a real file passes', 'C:/AI/Lab/metis/server.mjs', true],
    ['a real directory passes', 'C:/AI/Brain', true],
    ['a file about to be written passes (parent exists)', 'C:/AI/Lab/metis/logs/not-yet.txt', true],
    ['prose "E:/" is rejected', 'E:/', false],
    ['an ellipsis segment is rejected', 'C:/AI/...', false],
    ['a made-up tree is rejected', 'C:/Nope/Nowhere/thing.txt', false],
  ];
  let pbad = 0;
  for (const [label, p, want] of pcases) {
    const got = !!plausible(p, 'C:/AI/Lab/metis');
    if (got !== want) { pbad++; ok('plausible: ' + label, false, `got ${got} want ${want}`); }
  }
  if (!pbad) ok('bash path plausibility filter', true, `${pcases.length}/${pcases.length} cases`);
}

const g = await getJSON(PORT, '/api/graph', 5000);
if (!g) { console.error('probe-fsgraph: Metis is not answering on ' + PORT); process.exit(2); }

const fsNodes = g.nodes.filter((n) => n.domain === 'fs');
const vaultNodes = g.nodes.filter((n) => n.domain === 'vault');
const byId = new Map(g.nodes.map((n) => [n.id, n]));

ok('fs nodes exist', fsNodes.length > 0, `${fsNodes.length} nodes`);
ok('every fs node has a position', fsNodes.every((n) => g.layout[n.id]),
   fsNodes.filter((n) => !g.layout[n.id]).map((n) => n.id).join(', ') || 'all positioned');
ok('FileSystem root is on the backbone',
   (g.backbone || []).some((l) => l.target === 'fs::root' && l.source === 'core'), 'core -> fs::root');
ok('tree links match node count',
   (g.systemLinks || []).filter((l) => l.kind === 'tree').length === fsNodes.length - 1,
   `${(g.systemLinks || []).filter((l) => l.kind === 'tree').length} links / ${fsNodes.length} nodes`);

// colour contract
const colOf = (n) => (n.kind === 'file' ? FS_FILE : FS_FOLDER);
ok('folders and files carry different colours',
   fsNodes.filter((n) => n.kind === 'file').every((n) => colOf(n) === FS_FILE)
   && fsNodes.filter((n) => n.kind !== 'file').every((n) => colOf(n) === FS_FOLDER),
   `${fsNodes.filter((n) => n.kind === 'file').length} green / ${fsNodes.filter((n) => n.kind !== 'file').length} blue`);

for (const [W, H] of sizes) {
  const cam = makeCam(W, H, g.focal || 600);
  fitAll(cam, g.nodes, g.layout, W, H);

  const proj = new Map();
  for (const n of g.nodes) { const p = g.layout[n.id]; if (p) proj.set(n.id, cam.project(p)); }

  // 1. nothing offscreen — the standing invariant
  const off = [...proj.entries()].filter(([, q]) => q[0] < 0 || q[0] > W || q[1] < 0 || q[1] > H);
  ok(`${W}x${H}: 0 nodes offscreen`, off.length === 0,
     off.length ? off.slice(0, 4).map(([id, q]) => `${id}@${Math.round(q[0])},${Math.round(q[1])}`).join(' ') : `${proj.size} nodes fitted`);

  // 2. the tree must not sit on top of the vault disk
  const vr = vaultNodes.map((n) => proj.get(n.id)).filter(Boolean);
  const cx = vr.reduce((s, q) => s + q[0], 0) / vr.length, cy = vr.reduce((s, q) => s + q[1], 0) / vr.length;
  const vaultR = Math.max(...vr.map((q) => Math.hypot(q[0] - cx, q[1] - cy)));
  const inside = fsNodes.map((n) => proj.get(n.id)).filter(Boolean)
    .filter((q) => Math.hypot(q[0] - cx, q[1] - cy) < vaultR * 0.92).length;
  ok(`${W}x${H}: fs tree clear of the vault disk`, inside === 0,
     `${inside} fs nodes inside the vault radius (${Math.round(vaultR)}px)`);

  // 3. children sit outboard of their parents — this is what makes the path readable
  const root = proj.get('fs::root');
  let inverted = 0, checked = 0;
  for (const l of (g.systemLinks || []).filter((x) => x.kind === 'tree')) {
    const a = proj.get(l.source), b = proj.get(l.target);
    if (!a || !b || !root || l.source === 'fs::root') continue;
    checked++;
    if (Math.hypot(b[0] - root[0], b[1] - root[1]) < Math.hypot(a[0] - root[0], a[1] - root[1])) inverted++;
  }
  ok(`${W}x${H}: children outboard of parents`, inverted === 0, `${inverted}/${checked} inverted`);

  // 5. no two nodes on the same pixel
  const seen = new Map(); let dup = 0;
  for (const [id, q] of proj) {
    const k = Math.round(q[0]) + ':' + Math.round(q[1]);
    if (seen.has(k)) dup++; else seen.set(k, id);
  }
  ok(`${W}x${H}: no coincident nodes`, dup === 0, `${dup} exact overlaps`);

  // reported, not asserted — spacing depends on how full the tree is
  const fp = fsNodes.map((n) => proj.get(n.id)).filter(Boolean);
  // Math.min of an empty list is Infinity, so a one-node tree printed "Infinitypx".
  // A metric that prints a number it does not have is worse than one that says n/a.
  const nn = fp.length > 1
    ? fp.map((q, i) => Math.min(...fp.filter((_, j) => j !== i).map((r) => Math.hypot(q[0] - r[0], q[1] - r[1])))).sort((a, b) => a - b)
    : [];
  const med = nn.length ? Math.round(nn[Math.floor(nn.length / 2)]) + 'px' : 'n/a (' + fp.length + ' node)';
  results.push({ name: `${W}x${H}: median fs spacing`, pass: null, detail: `${med} (zoom ${cam.state.zoom.toFixed(3)})` });

  // THE COST. A fourth structure in a fixed frame makes fitAll zoom out, and the
  // vault disk was deliberately grown to 393px on 2026-08-23. Measure what the tree
  // costs it rather than discovering later that the depth work was quietly undone.
  const cam2 = makeCam(W, H, g.focal || 600);
  fitAll(cam2, g.nodes.filter((n) => n.domain !== 'fs'), g.layout, W, H);
  const vr2 = vaultNodes.map((n) => cam2.project(g.layout[n.id])).filter(Boolean);
  const cx2 = vr2.reduce((s, q) => s + q[0], 0) / vr2.length, cy2 = vr2.reduce((s, q) => s + q[1], 0) / vr2.length;
  const vaultR2 = Math.max(...vr2.map((q) => Math.hypot(q[0] - cx2, q[1] - cy2)));
  const pct = Math.round((1 - vaultR / vaultR2) * 100);
  results.push({ name: `${W}x${H}: vault disk cost`, pass: null,
                 detail: `${Math.round(vaultR2)}px -> ${Math.round(vaultR)}px (-${pct}%) from adding the fs tree` });
}

const pass = results.filter((r) => r.pass === true).length;
const fail = results.filter((r) => r.pass === false);
for (const r of results) {
  const mark = r.pass === null ? '   ' : (r.pass ? ' ok' : 'FAIL');
  console.log(`${mark}  ${r.name.padEnd(42)} ${r.detail}`);
}
console.log(`\n${pass}/${pass + fail.length} assertions passed` + (fail.length ? ` — ${fail.length} FAILED` : ''));
process.exit(fail.length ? 1 : 0);
