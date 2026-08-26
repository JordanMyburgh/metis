// fsgraph.mjs — the FileSystem backbone: a live tree of every path Metis has touched.
//
// The vault shell answers "what do I know". The islands answer "what am I plugged
// into". Neither answers "what did I just open", which is the question you actually
// ask when you want to check whether the agent went to the right file. This is that
// fourth structure: one permanent root, a node per drive/folder/file, created the
// first time a path is touched and never invented ahead of time.
//
// Why a tree and not another island cloud: the islands carry category by POSITION on
// a sphere, which is right for a flat roster (62 tools, no relationships). A file
// system's whole content IS the parent/child relation, so it gets a radial layout
// where reading outward from the centre reads the path.
//
// Bounded on purpose. The islands are naturally bounded (you have as many skills as
// you have); a file tree is not, and Jordan's standing invariant is that NO node is
// ever culled from the render. Those two facts collide, so the bound is enforced HERE,
// at the graph, by evicting cold leaves — never at draw time by hiding a node that
// exists. Every eviction is reported to the caller and logged; silent truncation
// would read as "we saw everything" when we did not.
import fs from 'node:fs';
import path from 'node:path';

export const FS_ROOT = 'fs::root';

// The cap is set from measurement, not taste. Swept at 1529x1112 with the chronicle
// open, against the real node set, after the equal-area ring fix below:
//
//   cap   median gap   min gap   vault disk   cost vs no tree
//    80      16px        6px       404px         -0%
//   120      14px        4px       392px         -3%
//   160      14px        3px       385px         -5%
//   240      11px        2px       362px        -11%
//
// 120 is the knee. It holds the vault disk at ~392px — the size the 2026-08-23 depth
// work deliberately grew it to — while keeping the tree's median spacing at half the
// vault's own 28.8px, which is legible for a dense sub-structure. Past 160 the vault
// starts paying real money for files that are already in the log anyway.
//
// Raise it with METIS_FS_MAX when you want a bigger picture and accept a smaller map.
const MAX_NODES = Number(process.env.METIS_FS_MAX || 120);

// ------------------------------------------------------------------ path parsing
// One canonical spelling per path, or the same file lands on two nodes. Windows is
// case-insensitive on disk but case-preserving in its API, so the node KEY is folded
// and the display name keeps whatever spelling arrived first.
export function normalise(p, cwd) {
  if (!p) return null;
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  s = s.replace(/\\/g, '/');
  const gb = /^\/([a-zA-Z])\/(.*)$/.exec(s);      // git-bash spelling: /c/AI -> C:/AI
  if (gb) s = gb[1].toUpperCase() + ':/' + gb[2];
  const unc = /^\/\/[^/]+\/[^/]+/.test(s);
  // "C:foo" is a DRIVE-RELATIVE path in Windows, and path.resolve(cwd, "C:foo") will
  // happily invent cwd/foo for it. Nothing legitimate produces that spelling here, so
  // the only way it arrives is mangled input — and a confidently wrong node is worse
  // than no node on a tree whose entire job is showing which file was really opened.
  // Reject it; the caller logs it as unresolvable.
  if (/^[a-zA-Z]:[^/]/.test(s)) return null;
  if (!unc && !/^[a-zA-Z]:\//.test(s)) {
    if (!cwd) return null;                        // relative with nothing to resolve against
    s = path.resolve(cwd, s).replace(/\\/g, '/');
  }
  if (/^[a-zA-Z]:\//.test(s)) s = s[0].toUpperCase() + s.slice(1);
  s = s.replace(/\/{2,}/g, (m, i) => (i === 0 ? m : '/')).replace(/(.)\/$/, '$1');
  if (/^[a-zA-Z]:$/.test(s)) s += '/';            // "C:" alone is the drive, keep it distinct
  return s;
}

// The chain a path implies, drive first: C: -> AI -> Lab -> metis -> server.mjs
export function chainOf(abs) {
  const unc = /^\/\/([^/]+)\/([^/]+)(.*)$/.exec(abs);
  let head, rest;
  if (unc) { head = '//' + unc[1] + '/' + unc[2]; rest = unc[3] || ''; }
  else {
    const m = /^([a-zA-Z]:)\/?(.*)$/.exec(abs);
    if (!m) return [];
    head = m[1] + '/'; rest = m[2] || '';
  }
  const segs = rest.split('/').filter(Boolean);
  const out = [{ path: head, name: head.replace(/\/$/, ''), kind: 'drive' }];
  let cur = head.replace(/\/$/, '');
  for (const s of segs) { cur = cur + '/' + s; out.push({ path: cur, name: s, kind: null }); }
  return out;
}

const idOf = (p) => 'fs::' + p.toLowerCase().replace(/(.)\/$/, '$1');

// Extension is a guess; stat() is the truth. A path that does not exist yet (a file
// about to be written) still earns a node — it was genuinely requested.
function kindOf(p, hint) {
  try { return fs.statSync(p).isDirectory() ? 'dir' : 'file'; } catch { /* not on disk */ }
  if (hint) return hint;
  return /\/[^/]*\.[^/.]{1,12}$/.test(p) ? 'file' : 'dir';
}

export class FsGraph {
  constructor(cacheFile, opts) {
    this.file = cacheFile;
    this.max = (opts && opts.max) || MAX_NODES;
    this.nodes = new Map();
    this.evicted = 0;
    this.load();
    this.ensureRoot();
  }

  ensureRoot() {
    if (this.nodes.has(FS_ROOT)) return;
    this.nodes.set(FS_ROOT, {
      id: FS_ROOT, path: '', name: 'FileSystem', kind: 'root', depth: 0,
      parent: null, exists: true, hits: 0, first: Date.now(), last: Date.now(),
    });
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const n of d.nodes || []) this.nodes.set(n.id, n);
      this.evicted = d.evicted || 0;
    } catch { /* first run */ }
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({
        v: 1, updated: Date.now(), evicted: this.evicted, nodes: [...this.nodes.values()],
      }), 'utf8');
    } catch { /* read-only fs is survivable */ }
  }

  // ------------------------------------------------------------ the one mutation
  // Walk the hierarchy, create what is missing, and return exactly which ids were
  // born on this call — the GUI flares those, and the log records them verbatim.
  touch(rawPath, opts) {
    const o = opts || {};
    const ts = o.ts || Date.now();
    const abs = normalise(rawPath, o.cwd || null);
    if (!abs) return { ok: false, reason: 'unresolvable', requested: rawPath, created: [], chain: [] };
    const segs = chainOf(abs);
    if (!segs.length) return { ok: false, reason: 'not-a-path', requested: rawPath, created: [], chain: [] };

    const created = [];
    const chain = [FS_ROOT];
    let parent = FS_ROOT;

    segs.forEach((seg, i) => {
      const id = idOf(seg.path);
      const leaf = i === segs.length - 1;
      let n = this.nodes.get(id);
      if (!n) {
        n = {
          id, path: seg.path, name: seg.name,
          kind: seg.kind || kindOf(seg.path, leaf ? (o.kindHint || null) : 'dir'),
          depth: i + 1, parent, exists: fs.existsSync(seg.path),
          hits: 0, first: ts, last: ts,
        };
        this.nodes.set(id, n);
        created.push(id);
      }
      // A node first seen as an intermediate IS a folder — an earlier extension guess
      // loses to the structural fact. And a leaf we now know more about upgrades.
      if (!leaf && n.kind === 'file') n.kind = 'dir';
      n.last = ts;
      // Re-stat anything still marked missing, at every level — not just the leaf.
      // PreToolUse fires BEFORE the tool runs, so a file being written is correctly
      // "missing" at capture time and correctly exists a moment later. Without this
      // the tree keeps calling a file it watched me create a phantom.
      if (n.exists === false) n.exists = fs.existsSync(seg.path);
      if (leaf) n.hits++;
      chain.push(id);
      parent = id;
    });

    // Never evict what this very call was asked to remember. The LRU pass below only
    // considers files, and the tree runs folder-heavy (116 folders / 3 files at the cap
    // on 2026-08-24), so going one node over the cap could drain every file candidate
    // including the leaf just touched - and then target was undefined and .id threw
    // inside an async request handler, which takes the whole server down.
    const pruned = this.prune(new Set(chain));
    const target = this.nodes.get(chain[chain.length - 1]);
    // Belt and braces: a miss here must degrade, not kill the process.
    if (!target) return { ok: false, requested: rawPath, resolved: abs, reason: 'evicted', pruned, chain };
    const root = this.nodes.get(FS_ROOT);
    root.hits++; root.last = ts;
    return {
      ok: true, requested: rawPath, resolved: abs, id: target.id, kind: target.kind,
      exists: target.exists, created, pruned, chain, depth: target.depth,
    };
  }

  // Least-recently-touched FILES go first, then folders left holding nothing. The
  // root and any folder with living children are never evicted, so the tree stays a
  // tree — you never get an orphan hanging off nothing.
  // A folder whose last touched file was evicted is skeleton — it says a directory was
  // visited but nothing in it survives, which is exactly the shape that crowds the tree
  // out. Measured after a stress run: 82 folders holding only 37 files. So the sweep is
  // unconditional, not gated on being over the cap. Folders directly requested by name
  // (hits > 0) are kept — those were the answer to a lookup, not scaffolding.
  sweepEmpty() {
    const gone = [];
    let again = true;
    while (again) {
      again = false;
      const kids = this.childCount();
      for (const n of [...this.nodes.values()]) {
        if (n.id === FS_ROOT || n.hits > 0) continue;
        if (n.kind !== 'dir' && n.kind !== 'drive') continue;
        if ((kids.get(n.id) || 0) > 0) continue;
        this.nodes.delete(n.id); gone.push(n.id); again = true;
      }
    }
    return gone;
  }

  prune(keep) {
    if (this.nodes.size <= this.max) return this.sweepEmpty();
    const gone = [];
    const kids = this.childCount();
    const cold = [...this.nodes.values()]
      .filter((n) => n.kind === 'file' && !(kids.get(n.id) > 0) && !(keep && keep.has(n.id)))
      .sort((a, b) => a.last - b.last);
    while (this.nodes.size > this.max && cold.length) {
      const n = cold.shift();
      this.nodes.delete(n.id); gone.push(n.id);
    }
    gone.push(...this.sweepEmpty());
    this.evicted += gone.length;
    return gone;
  }

  childCount() {
    const c = new Map();
    for (const n of this.nodes.values()) if (n.parent) c.set(n.parent, (c.get(n.parent) || 0) + 1);
    return c;
  }

  childrenOf() {
    const m = new Map();
    for (const n of this.nodes.values()) {
      if (!n.parent || !this.nodes.has(n.parent)) continue;
      if (!m.has(n.parent)) m.set(n.parent, []);
      m.get(n.parent).push(n);
    }
    for (const list of m.values()) list.sort((a, b) => (a.path < b.path ? -1 : 1));
    return m;
  }

  // ------------------------------------------------------------ graph projection
  // A node captured by PreToolUse is stat'd BEFORE the tool runs, so a file about to be
  // written is correctly "missing" at that instant — and stays flagged until something
  // touches it again, which for a file I wrote once and never reopened is never. Re-stat
  // the flagged ones when the graph is read. Bounded, and only ever over the missing
  // set, so the normal case costs nothing.
  refreshMissing(limit = 60) {
    let n = 0;
    for (const node of this.nodes.values()) {
      if (node.exists !== false || !node.path) continue;
      if (n++ >= limit) break;
      if (fs.existsSync(node.path)) node.exists = true;
    }
    return n;
  }

  graphNodes() {
    this.refreshMissing();
    const kids = this.childCount();
    return [...this.nodes.values()].map((n) => ({
      id: n.id, title: n.name, path: n.path, domain: 'fs',
      kind: n.kind === 'root' ? 'gateway' : n.kind,
      degree: kids.get(n.id) || 0, hits: n.hits, exists: n.exists, depth: n.depth, last: n.last,
    }));
  }

  graphLinks() {
    const out = [];
    for (const n of this.nodes.values()) {
      if (!n.parent || !this.nodes.has(n.parent)) continue;
      out.push({ source: n.parent, target: n.id, kind: 'tree' });
    }
    return out;
  }

  counts() {
    let dirs = 0, files = 0;
    for (const n of this.nodes.values()) {
      if (n.kind === 'file') files++;
      else if (n.kind !== 'root') dirs++;
    }
    return { total: this.nodes.size, dirs, files, evicted: this.evicted, max: this.max };
  }

  // ------------------------------------------------------------ radial layout
  // The camera is fixed top-down (pitch +PI/2), so the SCREEN plane is world X-Z and
  // world Y is depth. Laying the tree out as a sunburst in X-Z therefore reads as a
  // clean radial diagram on screen, while Y lifts each level toward the camera so it
  // still has genuine perspective instead of being a flat decal.
  //
  // Wedges are proportional to subtree leaf count, so a folder with 30 files gets 30x
  // the arc of a folder with one, and siblings never pile onto the same spoke.
  layout(anchor, opts) {
    const o = opts || {};
    const span = o.span === undefined ? Math.PI * 1.35 : o.span;
    const rot = o.rot === undefined ? Math.PI * 0.5 : o.rot;
    const R = o.R === undefined ? 210 : o.R;
    const lift = o.lift === undefined ? 150 : o.lift;

    const pos = {};
    if (!this.nodes.size) return pos;
    const children = this.childrenOf();

    const weight = new Map();
    const weigh = (id) => {
      if (weight.has(id)) return weight.get(id);
      const kids = children.get(id) || [];
      weight.set(id, 1);                                   // cycle guard, overwritten below
      const w = kids.length ? kids.reduce((s, k) => s + weigh(k.id), 0) : 1;
      weight.set(id, w);
      return w;
    };
    weigh(FS_ROOT);

    let maxD = 1;
    for (const n of this.nodes.values()) if (n.depth > maxD) maxD = n.depth;

    // EQUAL-AREA RINGS. A plain sunburst puts every node of a depth on one thin ring,
    // and a file tree is bottom-heavy — most nodes sit at the deepest two or three
    // levels, so those rings carry hundreds of points each while the inner rings carry
    // four. Measured at 240 nodes: median nearest-neighbour gap 7px, minimum 1px, on a
    // disc with room for ~32px. The fix is the same one the vault shell uses for its
    // notes — allocate radius by RANK, not by level, so each depth gets a band whose
    // AREA matches its population:
    //
    //     r(d) = R * sqrt( nodes at depth <= d / nodes total )
    //
    // sqrt because the area of a sector out to r goes as r². A depth holding half the
    // tree now gets a thick band instead of a line, and the band is then filled across
    // its whole thickness rather than at one radius.
    const perDepth = new Map();
    for (const n of this.nodes.values()) if (n.depth > 0) perDepth.set(n.depth, (perDepth.get(n.depth) || 0) + 1);
    const cum = new Map();
    let running = 0;
    for (let d = 1; d <= maxD; d++) { running += perDepth.get(d) || 0; cum.set(d, running); }
    const totalN = running || 1;
    const ringOuter = (d) => R * Math.sqrt(Math.min(1, (cum.get(d) || 0) / totalN));
    const ringInner = (d) => (d <= 1 ? R * 0.16 : ringOuter(d - 1));

    pos[FS_ROOT] = anchor.slice();
    const walk = (id, a0, a1) => {
      const kids = children.get(id) || [];
      if (!kids.length) return;
      // Arc stays weight-proportional — it is the area-correct answer, and blending in
      // an equal share was measured making things worse (median 8px -> 4px), because it
      // takes arc away from exactly the crowded folders where most nodes live.
      const total = kids.reduce((s, k) => s + weigh(k.id), 0) || 1;

      let a = a0;
      kids.forEach((k, i) => {
        const w = (weigh(k.id) / total) * (a1 - a0);
        const mid = a + w / 2;
        // Fill the depth's whole band, not its inner edge. (i*7)%rows is a fixed
        // permutation, not randomness — same tree, same picture every reload.
        const lo = ringInner(k.depth), hi = ringOuter(k.depth);
        const rows = Math.max(1, Math.min(6, Math.ceil(kids.length / 3)));
        const band = rows > 1 ? ((i * 7) % rows) / (rows - 1) : 0.5;
        const rho = lo + (hi - lo) * (0.14 + 0.72 * band);
        const t = k.depth / maxD;
        pos[k.id] = [
          Math.round((anchor[0] + rho * Math.cos(mid)) * 10) / 10,
          Math.round((anchor[1] - lift * t) * 10) / 10,      // deeper = nearer the camera
          Math.round((anchor[2] + rho * Math.sin(mid)) * 10) / 10,
        ];
        walk(k.id, a + w * 0.06, a + w * 0.94);              // 6% gutter between subtrees
        a += w;
      });
    };
    walk(FS_ROOT, rot - span / 2, rot + span / 2);
    return pos;
  }

  // ------------------------------------------------------------ text rendering
  // "Show the file graph" has to work in a terminal too, not only in the GUI.
  ascii(opts) {
    const o = opts || {};
    const hot = new Set(o.hot || []);
    const children = this.childrenOf();
    const out = [];
    const walk = (id, prefix, last) => {
      const n = this.nodes.get(id);
      if (!n) return;
      const kids = children.get(id) || [];
      const isHot = hot.has(id);
      const glyph = n.kind === 'root' ? '#' : (n.kind === 'file' ? '*' : '+');
      const mark = isHot ? ' <== ACCESSED' : '';
      const miss = n.exists === false ? ' (missing)' : '';
      const tail = n.kind === 'file' && n.hits ? '  x' + n.hits : '';
      const branch = prefix === null ? '' : prefix + (last ? '`-- ' : '|-- ');
      out.push(branch + glyph + ' ' + n.name + miss + tail + mark);
      const nextPrefix = prefix === null ? '' : prefix + (last ? '    ' : '|   ');
      kids.forEach((k, i) => walk(k.id, nextPrefix, i === kids.length - 1));
    };
    walk(FS_ROOT, null, true);
    return out.join('\n');
  }

  mermaid(opts) {
    const o = opts || {};
    const hot = new Set(o.hot || []);
    const children = this.childrenOf();
    const seq = new Map();
    let i = 0;
    const key = (id) => {
      if (!seq.has(id)) seq.set(id, 'n' + (i++));
      return seq.get(id);
    };
    const lines = ['graph LR'];
    const esc = (s) => String(s).replace(/"/g, "'");
    const decl = [];
    const cls = { dir: [], file: [], hot: [], root: [] };
    for (const n of this.nodes.values()) {
      const k = key(n.id);
      const shape = n.kind === 'file' ? ['(["', '"])'] : ['["', '"]'];
      decl.push('  ' + k + shape[0] + esc(n.name) + shape[1]);
      const bucket = hot.has(n.id) ? 'hot' : (n.kind === 'root' ? 'root' : (n.kind === 'file' ? 'file' : 'dir'));
      cls[bucket].push(k);
    }
    lines.push(...decl);
    for (const [pid, kids] of children) for (const k of kids) lines.push('  ' + key(pid) + ' --> ' + key(k.id));
    lines.push('  classDef dir fill:#12233d,stroke:#4b8fe8,color:#cfe2ff;');
    lines.push('  classDef file fill:#14301c,stroke:#7fd964,color:#dcf7cf;');
    lines.push('  classDef hot fill:#4a2f05,stroke:#ffb020,color:#ffe9c2,stroke-width:2px;');
    lines.push('  classDef root fill:#1b1b26,stroke:#9db2c8,color:#eaf4ff,stroke-width:2px;');
    for (const [name, ids] of Object.entries(cls)) if (ids.length) lines.push('  class ' + ids.join(',') + ' ' + name + ';');
    return lines.join('\n');
  }
}
