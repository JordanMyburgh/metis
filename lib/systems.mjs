// systems.mjs — enumerate the networks OUTSIDE the vault.
//
// Topology model (Jordan's): the vault is the agent's own LAN, wrapped around the
// core. MCP servers, skills and tools are separate buildings' networks, each with
// its own internal structure, reached over a backbone. Category is carried by
// POSITION (which island a node sits on), never by node shape — shapes at 100+
// nodes occlude each other into a blob.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.mjs';

const CLAUDE_JSON = path.join(HOME, '.claude.json');
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function mcpServers() {
  const d = readJSON(CLAUDE_JSON);
  const names = new Set();
  if (d) {
    if (d.mcpServers) for (const k of Object.keys(d.mcpServers)) names.add(k);
    if (d.projects) for (const proj of Object.values(d.projects)) {
      if (proj && proj.mcpServers) for (const k of Object.keys(proj.mcpServers)) names.add(k);
    }
  }
  return [...names];
}

function skills() {
  try {
    return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

// Islands are anchored by where they should land ON SCREEN, not by raw world XYZ.
// The camera never rotates (HOME: yaw 1.240, pitch +PI/2), so screen space is the
// only frame anyone actually looks at, and stating anchors in world coordinates
// meant every tweak was a guess. atScreen() does the conversion once, exactly.
//
// `depth` is world Y — the axis the camera looks down. It was near-zero for all
// three islands, which is why the map read flat: everything sat at the same
// distance, so perspective had nothing to work with. Staggering it (tools near,
// mcp mid, skills far) makes each island render at its own scale, and atScreen()
// divides the offset back out so the island still lands where it is asked to.
// Clock positions are unchanged — spatial memory beats optimal packing.
//
// The islands are kept INSIDE the vault disk's vertical extent and pushed out to
// the left and right instead. This is the whole reason the map got bigger: the
// stage is a ~1.7:1 letterbox (the chat rail owns the right edge), fitAll() zooms
// to whichever axis binds first, and the old ring of islands at 3/7/11 o'clock made
// the content square, so height bound and half the width went unused. Placed like
// this the two axes bind together and the vault gets ~60% more room at no cost.
const HOME_CY = Math.cos(1.240), HOME_SY = Math.sin(1.240);
const FOCAL = 600;                       // must match layout.mjs

function atScreen(right, down, depth, screenRadius) {
  const f = FOCAL / (FOCAL + depth);     // perspective shrinks a deep island...
  const u = right / f, v = down / f;     // ...so pre-divide, and it lands as asked
  return {
    anchor: [
      Math.round(u * HOME_CY - v * HOME_SY),   // world X
      depth,                                   // world Y IS depth at pitch +PI/2
      Math.round(-u * HOME_SY - v * HOME_CY),  // world Z
    ],
    radius: Math.round(screenRadius / f),      // cloud keeps its on-screen size too
    // The screen-space inputs, kept: the moon ring needs each island's BEARING and
    // angular width to leave a gap in the orbit where that island lives.
    screen: [right, down], screenR: screenRadius,
  };
}

// Which WORLD azimuth fans toward a given SCREEN direction at the fixed HOME yaw.
// The fs tree is a sunburst in the X-Z plane (= the screen plane at pitch +PI/2), and
// it has to fan AWAY from the map centre or it grows back over the vault. Deriving the
// angle instead of hard-coding it means the fan still points right if the pose changes.
//   sx ∝ cos(θ + yaw),  sy ∝ -sin(θ + yaw)   ⇒   θ = atan2(-down, right) - yaw
export function fanAzimuth(right, down) { return Math.atan2(-down, right) - 1.240; }

// 2026-08-24: the fs tree was asked to move ~75 degrees to the LEFT of the 4-5 o'clock
// slot it held. From the lower-right, "left" means sweeping along the BOTTOM (4:30 ->
// 7:00) rather than up through tools' corner, so the turn is clockwise on screen.
// Anchor and fan both turn by the same angle, which preserves the fan's ~22 degree
// downward tilt relative to the anchor direction — the tree still fans AWAY from the
// map centre instead of back over the vault. Tuning the move is this one number.
const FS_TURN_DEG = 75;

// Rotate a SCREEN vector leftward by `deg`. Screen y grows downward, so a leftward
// (clockwise-on-screen) turn is the plain rotation matrix applied to (right, down).
function turnLeft(right, down, deg = FS_TURN_DEG) {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return [right * c - down * s, right * s + down * c];
}

export const ISLANDS = {
  vault:  { label: 'vault',  color: '#22ccff', anchor: null, radius: 0 },   // shell around core
  //                                right  down  depth  cloud        clock (top-down view)
  // mcp and skills sit on the SAME side, one above the other, because the gitnexus
  // skills genuinely depend on the gitnexus MCP server and those peer links have to
  // be readable. Split across opposite corners they were the longest lines on screen,
  // crossing everything else for no reason. tools takes the whole other side: it has
  // 5x the nodes, so it earns the space.
  mcp:    { label: 'mcp',    color: '#54e6a6', ...atScreen(-435, -215,   30,  80) },  // 10 o'clock
  skills: { label: 'skills', color: '#b888ff', ...atScreen(-410,  225,  180,  80) },  //  8 o'clock, FURTHEST
  tools:  { label: 'tools',  color: '#f2b85c', ...atScreen( 455,  -30, -150,  80) },  //  3 o'clock, NEAREST
  // The FileSystem tree takes the empty lower-right corner (tools owns upper-right,
  // skills lower-left) and fans DOWN-RIGHT, away from everything. It gets a bigger
  // cloud radius than the others because it is a hierarchy, not a roster: its whole
  // content is the parent→child relation, and that needs room to read.
  // Depth -60, not +90. The renderer dims by depth as dep = 1-(z+330)/900 with a floor
  // of 0.55, so a tree anchored at +90 computes 0.533 and CLAMPS — every node in it
  // renders at the floor, the whole structure reads dimmer than the other islands, and
  // the lift below buys no visible depth at all because the clamp eats it. Confirmed on
  // a real Chrome screenshot, not inferred. At -60 the tree spans dep 0.70..0.80, so it
  // is both brighter and actually shaded front-to-back. atScreen() pre-divides by the
  // perspective factor, so moving it in depth does NOT move it on screen.
  // turnLeft(400, 170) = (-61, 430) — 6 o'clock, a touch past bottom-left.
  fs:     { label: 'fs',     color: '#4b8fe8', ...atScreen(...turnLeft(400, 170), -60, 195) },  // was 4-5 o'clock
  // Local models take high noon, slightly right — the one empty slot left (mcp 10,
  // skills 8, tools 3, fs 6; the legend hangs top-right of the FRAME, not the stage).
  // Magenta: no other domain uses it, and "what is on the GPU" deserves to read as
  // its own kind of thing, not as a variant of tools. Membership = installed models
  // (changes rarely, rebuilt with the graph); which of them is RESIDENT right now is
  // a live overlay the client paints from SSE — see 'models' broadcasts in server.mjs.
  // Models are MOONS (Jordan, 2026-08-25): not an island cluster but an orbital RING
  // around the whole map. anchor:null means the island layouter skips them — the ring
  // is computed below in buildSystems and overlaid onto layout.pos by the server.
  models: { label: 'models', color: '#ff6ec7', anchor: null, radius: 0 },
};

// The fs sunburst's fan: centred down (and slightly left) on screen, ~207° wide. Wider than this and
// the far edges curl back over the vault disk; narrower and a busy folder crowds.
//
// `lift` is small on purpose. It is the depth spread that makes the tree read 3D, but
// depth is also what INFLATES a node's projected offset — at lift 150 the deepest
// files projected ~28% further out than the anchor, which pushed the fitted bounding
// box out and made fitAll zoom the whole map out with it. Measured at 1529x1112, the
// tree cost the vault disk 405px -> 329px (-19%), and that disk was deliberately grown
// to ~393px on 2026-08-23. At lift 90 with the radius scaling below it costs ~7%.
export const FS_FAN = { rot: fanAzimuth(...turnLeft(1, 1)), span: Math.PI * 1.15, lift: 90 };

// The cloud radius grows with population, exactly like the island clouds do — 30 nodes
// on a 400-node-sized disk is wasted frame, and 400 nodes on a 30-node disk is a blob.
// Cubed so density stays even, clamped so neither end runs away.
export function fsRadius(base, n) {
  const k = Math.sqrt(Math.max(1, n) / 90);
  return Math.round(base * Math.max(0.55, Math.min(1.75, k)));
}

// Model names are written loosely everywhere they appear — `stealth/ox-alpha` in a
// shim stamp, `ox-alpha` as a self-chosen ModelVault folder, `qwen3-4b-64k:latest`
// in Ollama. One suffix-tolerant matcher, exported so the server's hermes-watcher
// resolves a touch to the same moon this builder created.
const canon = (s) => String(s).toLowerCase().replace(/[/:]/g, '_');
export function nameMatches(a, b) {
  const c = canon(a), f = canon(b);
  return c === f || c.endsWith('_' + f) || f.endsWith('_' + c) || c.endsWith(f) || f.endsWith(c);
}

export function buildSystems(liveInit) {
  const nodes = [];
  const links = [];
  const backbone = [];

  const mcp = mcpServers();
  // .claude.json only lists locally-registered servers. Connectors (Gmail, Calendar)
  // arrive as tools named mcp__<server>__<tool> and had no node, so 37 of their tool
  // calls could never light anything. Derive the missing servers from the live loadout.
  if (liveInit && Array.isArray(liveInit.toolNames)) {
    const have = new Set(mcp);
    for (const t of liveInit.toolNames) {
      const m = /^mcp__(.+?)__/.exec(t || '');
      if (m && !have.has(m[1])) { have.add(m[1]); mcp.push(m[1]); }
    }
  }
  const sk = skills();
  const tools = (liveInit && Array.isArray(liveInit.toolNames)) ? liveInit.toolNames : [];
  // Installed Ollama models, passed in by the server (enumeration is async HTTP, and
  // this builder is sync by design — the server owns the polling, we own the shape).
  const models = (liveInit && Array.isArray(liveInit.modelNames)) ? liveInit.modelNames : [];

  // Each island gets a gateway — the single node the backbone terminates on,
  // exactly like a site router rather than every host having its own WAN link.
  for (const [dom, list] of [['mcp', mcp], ['skills', sk], ['tools', tools]]) {
    if (!list.length) continue;
    const gw = `${dom}::gateway`;
    nodes.push({ id: gw, title: dom.toUpperCase(), domain: dom, kind: 'gateway', degree: list.length });
    backbone.push({ source: 'core', target: gw, kind: 'backbone' });
    for (const name of list) {
      const id = `${dom}::${name}`;
      nodes.push({ id, title: name, domain: dom, kind: 'host', degree: 1 });
      links.push({ source: gw, target: id, kind: 'local' });
    }
  }

  // Real cross-island topology: the gitnexus-* skills belong to the gitnexus MCP
  // server. That is an actual dependency, not decoration.
  for (const s of sk) {
    const m = mcp.find((x) => s === x || s.startsWith(x + '-'));
    if (m) links.push({ source: `skills::${s}`, target: `mcp::${m}`, kind: 'peer' });
  }

  // ---- MOONS. Claude's graph is Earth; every model is a moon on an orbital RING
  // outside everything else, each tethered to the core by one faint line (route()
  // therefore sends a moon's query pulse moon -> Earth -> note, which is the right
  // picture). Each moon carries its ModelVault notes as SATELLITES — the model's own
  // isolated memory, rendered just outside its moon on the ring's far side.
  //
  // Draft by design (Jordan, 2026-08-25): real local-AI work waits on better
  // hardware; this exists so that when a model IS used, what it did is visible and
  // diagnosable. Adding a moon re-spaces the ring — even spacing beats frozen
  // positions at this population.
  const mvNotes = (liveInit && liveInit.mvNotes) || {};
  const moonPos = {};
  // A ModelVault folder is proof a model existed and did work — it keeps its moon
  // (and its notes) across restarts, even when the model is not installed locally
  // and has not run yet this session. Without this, a cloud model's moon died with
  // every server restart because remoteSeen is in-memory only.
  const moonNames = [...models];
  for (const folder of Object.keys(mvNotes)) {
    if (!moonNames.some((m) => nameMatches(m, folder))) moonNames.push(folder);
  }
  if (moonNames.length) {
    const RING = 545;                          // screen px — outside the fs tree and every island
    const sorted = [...moonNames].sort();      // stable order = stable ring

    // The orbit is a ring WITH GAPS: a moon must never sit in the middle of another
    // clustered network (Jordan, 2026-08-25). Exclusion arcs are derived from the
    // same ISLANDS constants the clusters are built from — move an island and its
    // gap moves with it, no magic numbers. Each island blocks the bearing it lives
    // on, +- the angle its cloud subtends from the centre (plus padding); the fs
    // tree is a wide fan, so it gets a wide fixed gap on its bearing.
    const excl = [];
    for (const [key, isl] of Object.entries(ISLANDS)) {
      if (!isl.screen) continue;
      const th = Math.atan2(isl.screen[1], isl.screen[0]);
      const d = Math.hypot(isl.screen[0], isl.screen[1]) || 1;
      const hw = key === 'fs' ? 1.05 : Math.atan2((isl.screenR || 80) + 45, d) + 0.06;
      excl.push([th, hw]);
    }
    const norm = (a) => { let x = a % (2 * Math.PI); if (x < 0) x += 2 * Math.PI; return x; };
    const blocked = (th) => excl.some(([c, hw]) => {
      let dth = Math.abs(norm(th) - norm(c));
      if (dth > Math.PI) dth = 2 * Math.PI - dth;
      return dth < hw;
    });
    // Free arcs, sampled finely; moons then spread evenly across the free set.
    const STEPS = 720;
    const free = [];
    for (let s = 0; s < STEPS; s++) {
      const th = (s / STEPS) * 2 * Math.PI - Math.PI / 2;
      if (!blocked(th)) free.push(th);
    }
    const bearing = (i, n) => free.length
      ? free[Math.floor(((i + 0.5) / n) * free.length)]
      : (i / n) * 2 * Math.PI - Math.PI / 2;   // degenerate fallback: plain ring
    // A model names its own folder loosely (ox-alpha for stealth/ox-alpha), so the
    // match is suffix-tolerant both ways rather than exact.
    const satsFor = (name) => {
      const out = [];
      for (const [folder, files] of Object.entries(mvNotes)) {
        if (nameMatches(name, folder)) out.push(...files.map((rel) => ({ folder, rel })));
      }
      return out;
    };
    sorted.forEach((name, i) => {
      const th = bearing(i, sorted.length);
      const id = `models::${name}`;
      const sats = satsFor(name);
      nodes.push({ id, title: name, domain: 'models', kind: 'moon', degree: 2 + sats.length });
      links.push({ source: 'core', target: id, kind: 'local' });   // faint tether, not backbone
      moonPos[id] = atScreen(RING * Math.cos(th), RING * Math.sin(th), 0, 0).anchor;
      sats.forEach((s, j) => {
        const sid = `mv::${s.folder}/${s.rel.replace(/\\/g, '/')}`;
        nodes.push({ id: sid, title: s.rel.replace(/\\/g, '/').split('/').pop(),
                     domain: 'models', kind: 'mvnote', degree: 1 });
        links.push({ source: id, target: sid, kind: 'local' });
        // fan the satellites just OUTSIDE the ring, centred on their moon's bearing
        const a = th + (j - (sats.length - 1) / 2) * (0.10 / Math.max(1, Math.sqrt(sats.length / 3)));
        const rr = RING + 36 + 12 * (j % 2);
        moonPos[sid] = atScreen(rr * Math.cos(a), rr * Math.sin(a), 0, 0).anchor;
      });
    });
  }

  // counts.models counts MOONS (folder-born ones included) — it feeds the map's
  // status line, and the map shows 14 when 14 orbit. Installed-locally lives in
  // /api/models, which asks Ollama directly.
  return { nodes, links, backbone, moonPos, counts: { mcp: mcp.length, skills: sk.length, tools: tools.length, models: moonNames.length } };
}

// ---------------------------------------------------------------- VAULT CATEGORIES
// Every vault category is now its own NETWORK, on exactly the same terms as
// mcp/skills/tools: one gateway hanging off the core backbone, its own cluster of
// notes around it, its own colour on every line inside it.
//
// Before this the vault was a single shell and category was carried by node colour
// alone. Two things were unreadable as a result: a link BETWEEN two categories looked
// identical to a link inside one, so the map could not answer "how tied is feedback to
// knowledge"; and a flare into a note told you a note lit up but not which part of the
// brain it lived in.
//
// The ring sits INSIDE the old shell's footprint (outer edge ~300px against the old
// disk's 393px), so the outer islands keep their clearance and gain a little.
const CAT_RING = 212;        // screen radius of the ring the category gateways sit on
const CAT_CLOUD_CAP = 78;    // no cluster grows past this, however big the category
// Fixed per-slot depth stagger. Same trick as the islands: without it every cluster
// renders at one scale and the ring reads as a flat dial rather than a volume.
const CAT_DEPTHS = [-45, 35, -15, 60, -62, 10, 48, -28, 22];

// Fixed order, NOT count-sorted — the ring must not rotate under Jordan every time a
// note is written. A category the vault grows later appends to the end and nothing
// already placed moves. `missing` is last on purpose: phantom targets for wikilinks
// that were never written are real information, but they are not a part of the brain.
export const CAT_ORDER = ['knowledge', 'feedback', 'library', 'projects', 'agents',
  'decisions', 'output', 'root', 'missing'];

// Angular width is proportional to sqrt(count), not one equal slot per category.
// `feedback` has 14x the notes of `decisions`; equal slots either crush feedback into
// a knot or spend a ninth of the ring on a category with two notes in it. sqrt rather
// than linear because the cluster is a DISC — area, not arc, is what has to grow.
export function vaultCategories(counts) {
  const known = CAT_ORDER.filter((g) => counts[g]);
  const extra = Object.keys(counts).filter((g) => !CAT_ORDER.includes(g)).sort();
  const present = known.concat(extra);
  const wt = present.map((g) => Math.sqrt(counts[g]));
  const total = wt.reduce((a, b) => a + b, 0) || 1;
  const out = {};
  let acc = 0;
  present.forEach((g, i) => {
    const share = wt[i] / total;
    const mid = (acc + share / 2) * Math.PI * 2 - Math.PI / 2;   // slot centre, from 12 o'clock
    acc += share;
    // Half the slot's arc length is the largest cloud that cannot touch its neighbour;
    // 0.82 of that leaves a visible gap so the ring reads as nine things, not one donut.
    const fit = share * Math.PI * CAT_RING * 0.82;
    out[g] = {
      ...atScreen(Math.cos(mid) * CAT_RING, Math.sin(mid) * CAT_RING,
        CAT_DEPTHS[i % CAT_DEPTHS.length],
        Math.min(CAT_CLOUD_CAP, Math.max(26, fit))),
      count: counts[g], angle: mid,
    };
  });
  return out;
}

// The gateway is the node the backbone terminates on — a site router, not a WAN link
// per host. Same shape as the island gateways so the renderer needs no special case.
export function buildVaultGateways(counts) {
  const nodes = [], backbone = [];
  for (const g of Object.keys(counts)) {
    const id = `cat::${g}`;
    nodes.push({ id, title: g.toUpperCase(), domain: 'vault', group: g, kind: 'gateway', degree: counts[g] });
    backbone.push({ source: 'core', target: id, kind: 'backbone' });
  }
  return { nodes, backbone };
}
