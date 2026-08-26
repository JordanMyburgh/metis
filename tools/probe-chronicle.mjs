// probe-chronicle.mjs — CLI sanity check for the chronicle ribbon.
//
// Companion to probe.mjs (which checks index + recall extraction). This one checks
// the OTHER half: that the ribbon actually draws the three lanes from real /api/activity
// data, in the right colours, at the right x positions.
//
// Why a probe and not a browser screenshot: requestAnimationFrame is paused while a
// tab is hidden, so a headless/background browser leaves both canvases at their
// pre-layout backing size and paints nothing. That is a property of the harness, not
// of the app — but it means "it looked right" is not available on demand. So this runs
// the REAL module source from web/index.html against a recording 2D context and
// asserts what was drawn. No copy of the drawing code lives here; if index.html
// changes, this tests the change.
//
//   node tools/probe-chronicle.mjs            (needs the server up on :8780)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const BASE = process.env.METIS_URL || 'http://127.0.0.1:8780';

// ---------------------------------------------------------------- recording canvas
function recordingCtx(rec) {
  const st = { fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    font: '', shadowColor: '', shadowBlur: 0, lineCap: 'butt' };
  let pen = [0, 0];
  return new Proxy(st, {
    get(t, k) {
      if (k in t) return t[k];
      switch (k) {
        case 'fillRect': return (x, y, w, h) =>
          rec.push({ op: 'fillRect', x, y, w, h, fill: t.fillStyle, alpha: t.globalAlpha });
        case 'fillText': return (s, x, y) =>
          rec.push({ op: 'fillText', text: s, x, y, fill: t.fillStyle });
        case 'moveTo': return (x, y) => { pen = [x, y]; };
        case 'lineTo': return (x, y) =>
          rec.push({ op: 'line', from: pen, to: [x, y], stroke: t.strokeStyle, alpha: t.globalAlpha });
        case 'stroke': case 'fill': case 'beginPath': case 'closePath':
        case 'clearRect': case 'setTransform': case 'setLineDash':
        case 'arc': case 'save': case 'restore':
          return () => {};
        default: return () => {};
      }
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

// ---------------------------------------------------------------- minimal DOM
const RECT = { '#ch-wrap': { width: 1252, height: 82 }, '#stage': { width: 1280, height: 720 } };
const rec = [];
const els = new Map();

function el(sel) {
  if (els.has(sel)) return els.get(sel);
  const box = RECT[sel] || { width: 100, height: 20 };
  const classes = new Set();
  const node = {
    sel, style: {}, dataset: {}, children: [], innerHTML: '', textContent: '',
    width: 0, height: 0,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; v ? classes.add(c) : classes.delete(c); return v; },
    },
    getContext: () => recordingCtx(rec),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: box.width, height: box.height }),
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {},
    appendChild() {}, prepend() {}, remove() {}, closest: () => null,
    querySelector: () => null, focus() {},
  };
  els.set(sel, node);
  return node;
}

globalThis.document = {
  querySelector: el,
  getElementById: (id) => el('#' + id),
  createElement: () => el('#tmp' + Math.random()),
  body: el('#body'),
  documentElement: el('#html'),
  activeElement: { tagName: 'BODY' },
  addEventListener() {}, visibilityState: 'visible',
};
globalThis.window = globalThis;
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.addEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = () => 0;      // the probe drives the draw itself
globalThis.ResizeObserver = class { observe() {} };
globalThis.EventSource = class { constructor() { this.onmessage = null; this.onerror = null; } close() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async (u) => {
  const r = await (await import('node:http')).default;
  const url = new URL(u, BASE);
  return new Promise((resolve, reject) => {
    r.get(url, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, json: async () => JSON.parse(b) }));
    }).on('error', reject);
  });
};

// ---------------------------------------------------------------- run the real module
const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: no module script in web/index.html'); process.exit(1); }
// The only edit to the source: a test export, appended. Everything above is verbatim.
const src = m[1] + '\n;globalThis.__CH={CH,chInit,drawChron,chBuckets,chTicks,chX,setChron,chFocus,chPick,chAccess,loadActivity};';

let ok = true;
const check = (name, pass, detail = '') => {
  console.log(`${pass ? '  ok  ' : '  FAIL'} ${name}${detail ? '   ' + detail : ''}`);
  if (!pass) ok = false;
};

try {
  new Function(src)();
} catch (e) {
  console.error('FAIL: module threw on load:', e.message);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 900));    // let the boot IIFE's fetches land

const { CH, drawChron, setChron, chFocus, chBuckets, chTicks } = globalThis.__CH;

console.log(`chronicle probe — ${BASE}`);
check('activity loaded', !!CH.lanes,
  CH.lanes ? `${CH.lanes.added.length} added · ${CH.lanes.updated.length} updated · ${CH.lanes.accessed.length} accessed` : 'no data — is the server up?');
if (!CH.lanes) process.exit(1);

setChron(true);
CH.dirty = true;
rec.length = 0;
drawChron();

const W = CH.W, LANES = { '#22ccff': 'ACCESSED', '#f2b85c': 'UPDATED', '#54e6a6': 'ADDED' };
check('canvas measured', W > 1000 && CH.H > 40, `${W}x${CH.H}`);

const bars = rec.filter((r) => r.op === 'fillRect');
for (const [col, label] of Object.entries(LANES)) {
  const mine = bars.filter((b) => b.fill === col);
  const xs = mine.map((b) => b.x);
  check(`${label} lane drew bars`, mine.length > 0, `${mine.length} bars, x ${Math.min(...xs)}..${Math.max(...xs)}`);
  check(`${label} bars inside the plot area`, mine.every((b) => b.x >= 76 && b.x <= W - 6), '');
}

const labels = rec.filter((r) => r.op === 'fillText').map((r) => r.text);
check('lane labels drawn', ['ACCESSED', 'UPDATED', 'ADDED'].every((l) => labels.includes(l)), labels.slice(0, 3).join(','));
check('time axis has ticks', chTicks().length >= 2, `${chTicks().length} gridlines`);

const nowLine = rec.filter((r) => r.op === 'line' && r.stroke === '#ff3344');
check('now marker at the right edge', nowLine.length === 1 && Math.abs(nowLine[0].from[0] - (W - 6)) < 3,
  nowLine.length ? `x=${nowLine[0].from[0].toFixed(1)} (edge ${W - 6})` : 'missing');

// focus: one note's own marks must be drawn full height, and the density dimmed
const target = [...CH.byId.keys()].find((id) => CH.byId.get(id).accessed) || CH.byId.keys().next().value;
chFocus(target); CH.dirty = true; rec.length = 0; drawChron();
// Density bars and focus ticks are both 2px wide; alpha is what separates them —
// the lane dims to .20 while a note is focused and its own marks stay at full.
const focusBars = rec.filter((r) => r.op === 'fillRect' && r.alpha === 1);
const dimmed = rec.filter((r) => r.op === 'fillRect' && r.alpha < 0.3);
check(`focus '${target}' drew its own marks`, focusBars.length > 0, `${focusBars.length} ticks`);
check('density dimmed while focused', dimmed.length > 0, `${dimmed.length} dimmed bars`);

// range switching must actually move the window
const before = CH.t0;
CH.range = 864e5; CH.dirty = true; rec.length = 0; drawChron();
check('range switch moves the domain', CH.t0 !== before,
  `${new Date(before).toISOString().slice(0, 10)} -> ${new Date(CH.t0).toISOString().slice(0, 10)}`);

console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
