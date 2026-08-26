// make-icons.mjs — emit every Metis icon (SVG + PNG) from one shared constellation.
//
// The icon is the app's own subject: a small knowledge graph. One bright core,
// six satellites, links between them, on the same --void black the canvas uses.
// Geometry lives here once so the maskable, padded and favicon variants can
// never drift apart.
//
// Zero dependencies, no browser, no native module. The PNG path rasterises the
// same geometry analytically — signed distance per pixel, 2x supersampled — and
// writes the file with a hand-rolled encoder. That matters because a build step
// that needs Chrome or `sharp` is a build step nobody can rerun in two years.
//
// Usage: node tools/make-icons.mjs        (writes web/*.svg and web/*.png)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(process.cwd(), 'web');
if (!fs.existsSync(OUT)) { console.error('run me from the metis root (web/ not found)'); process.exit(1); }

// Palette lifted verbatim from index.html's :root.
const C = {
  void: '#050508', line2: '#2a3850', link: '#7ba0d2',
  cyan: '#22ccff', violet: '#b888ff', amber: '#f2b85c',
  green: '#54e6a6', magenta: '#ff4d9d', dim: '#4aa8c8',
  coreHot: '#d4f4ff', coreCold: '#0a7ba8',
};

// Angles are deliberately jittered off a clean 60 degree ring — a perfect
// hexagon reads as a logo, an irregular one reads as a graph.
const SATS = [
  { deg: -72, r: 140, rad: 17, col: C.violet },
  { deg: -12, r: 152, rad: 15, col: C.cyan },
  { deg: 48, r: 128, rad: 18, col: C.amber },
  { deg: 116, r: 146, rad: 16, col: C.green },
  { deg: 182, r: 134, rad: 15, col: C.magenta },
  { deg: 250, r: 124, rad: 14, col: C.dim },
];
// Rim links, by satellite index — these are what stop it reading as a star.
const RIM = [[0, 1], [1, 2], [2, 3], [4, 5]];

// Six nodes turn to mush at 16px, so the favicon keeps three fat ones.
// Sized for 32px: at scale 1.0 these land ~3.4px across, the floor for a
// coloured dot to survive downsampling. The 512-space values look oversized
// on purpose — nothing ever renders this variant large.
const FAV = [
  { deg: -66, r: 118, rad: 54, col: C.violet },
  { deg: 54, r: 118, rad: 54, col: C.amber },
  { deg: 174, r: 118, rad: 54, col: C.green },
];

const CX = 256, CY = 256, BOX = 512;
const place = (s) => {
  const a = (s.deg * Math.PI) / 180;
  return { ...s, x: +(CX + s.r * Math.cos(a)).toFixed(1), y: +(CY + s.r * Math.sin(a)).toFixed(1) };
};
// Apply the variant's scale about the centre, in 512-space.
const scaled = (sats, k) => sats.map(place).map((p) => ({
  ...p, x: CX + (p.x - CX) * k, y: CY + (p.y - CY) * k, rad: p.rad * k,
}));

/* =============================================================== SVG output */
function defs() {
  return `  <defs>
    <radialGradient id="glow" cx="50%" cy="46%" r="54%">
      <stop offset="0%" stop-color="${C.cyan}" stop-opacity=".22"/>
      <stop offset="55%" stop-color="${C.cyan}" stop-opacity=".06"/>
      <stop offset="100%" stop-color="${C.cyan}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="core" cx="38%" cy="32%" r="76%">
      <stop offset="0%" stop-color="${C.coreHot}"/>
      <stop offset="42%" stop-color="${C.cyan}"/>
      <stop offset="100%" stop-color="${C.coreCold}"/>
    </radialGradient>
    <filter id="soft" x="-70%" y="-70%" width="240%" height="240%">
      <feGaussianBlur stdDeviation="13"/>
    </filter>
  </defs>`;
}

function constellationSvg(k, sats, coreR) {
  const P = scaled(sats, k);
  const cr = coreR * k;
  const links = [
    ...P.map((p) => `<line x1="${CX}" y1="${CY}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}"/>`),
    ...RIM.filter(([a, b]) => a < P.length && b < P.length).map(([a, b]) =>
      `<line x1="${P[a].x.toFixed(1)}" y1="${P[a].y.toFixed(1)}" x2="${P[b].x.toFixed(1)}" y2="${P[b].y.toFixed(1)}" stroke-opacity=".16"/>`),
  ].join('\n      ');
  const halos = P.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(p.rad * 1.9).toFixed(1)}" fill="${p.col}" opacity=".17" filter="url(#soft)"/>`).join('\n      ');
  const dots = P.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.rad.toFixed(1)}" fill="${p.col}"/>`).join('\n      ');
  return `  <g stroke="${C.link}" stroke-opacity=".30" stroke-width="${(3.5 * k).toFixed(2)}" stroke-linecap="round">
      ${links}
  </g>
  <g>
      ${halos}
  </g>
  <circle cx="${CX}" cy="${CY}" r="${(cr * 2.3).toFixed(1)}" fill="${C.cyan}" opacity=".22" filter="url(#soft)"/>
  <g>
      ${dots}
  </g>
  <circle cx="${CX}" cy="${CY}" r="${cr.toFixed(1)}" fill="url(#core)"/>
  <circle cx="${CX}" cy="${CY}" r="${(cr + 13 * k).toFixed(1)}" fill="none" stroke="${C.cyan}" stroke-opacity=".42" stroke-width="${(2.5 * k).toFixed(2)}"/>`;
}

const svgDoc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">\n${defs()}\n${body}\n</svg>\n`;

const VARIANTS = {
  // Full bleed. Android/Windows crop maskable icons to a circle of r=40%
  // (204.8px here); the furthest satellite edge lands at 167px, well inside.
  maskable: { round: 0, scale: 0.72, sats: SATS, coreR: 34, border: false },
  // Padded square with the app's own hairline border.
  any: { round: 112, scale: 0.84, sats: SATS, coreR: 34, border: true },
  favicon: { round: 96, scale: 1.0, sats: FAV, coreR: 72, border: false },
};

function toSvg(v) {
  const rr = v.round ? ` rx="${v.round}" ry="${v.round}"` : '';
  const border = v.border
    ? `\n  <rect x="1.25" y="1.25" width="509.5" height="509.5" rx="${v.round - 1}" ry="${v.round - 1}" fill="none" stroke="${C.line2}" stroke-width="2.5"/>`
    : '';
  return svgDoc(
    `  <rect width="512" height="512"${rr} fill="${C.void}"/>
  <rect width="512" height="512"${rr} fill="url(#glow)"/>
${constellationSvg(v.scale, v.sats, v.coreR)}${border}`);
}

/* ================================================== analytic PNG rasteriser */
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Distance from point to segment — the whole line renderer.
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  let t = L === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / L;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function sdRoundRect(px, py, size, r) {
  const qx = Math.abs(px - size / 2) - (size / 2 - r);
  const qy = Math.abs(py - size / 2) - (size / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// Coverage from a signed distance, in pixel units. This is the anti-aliasing.
const cov = (sd) => clamp01(0.5 - sd);

function raster(size, v) {
  const SS = 2, N = size * SS, S = (size * SS) / BOX;   // 512-space -> device px
  const P = scaled(v.sats, v.scale).map((p) => ({ ...p, x: p.x * S, y: p.y * S, rad: p.rad * S }));
  const cx = CX * S, cy = CY * S, coreR = v.coreR * v.scale * S;
  const linkW = (3.5 * v.scale * S) / 2;
  const round = v.round * S, glowR = 0.54 * BOX * S;
  const gcx = 0.5 * BOX * S, gcy = 0.46 * BOX * S;

  const VOID = hex(C.void), LINK = hex(C.link), CYAN = hex(C.cyan);
  const HOT = hex(C.coreHot), COLD = hex(C.coreCold), LINE2 = hex(C.line2);
  const sats = P.map((p) => ({ ...p, rgb: hex(p.col) }));
  const rims = RIM.filter(([a, b]) => a < P.length && b < P.length);

  const acc = new Float32Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = x + 0.5, py = y + 0.5;

      // --- background plate (alpha comes from the rounded-rect mask) ---
      const plate = round > 0 ? cov(sdRoundRect(px, py, N, round)) : 1;
      if (plate <= 0) { continue; }
      let r = VOID[0], g = VOID[1], b = VOID[2];

      // --- centre glow: smooth falloff, standing in for the SVG gradient ---
      const gd = Math.hypot(px - gcx, py - gcy) / glowR;
      if (gd < 1) {
        const a = 0.22 * Math.pow(1 - gd, 2.1);
        r += (CYAN[0] - r) * a; g += (CYAN[1] - g) * a; b += (CYAN[2] - b) * a;
      }

      // --- links: centre spokes then rim, both anti-aliased ---
      const lay = (col, a) => { if (a > 0) { r += (col[0] - r) * a; g += (col[1] - g) * a; b += (col[2] - b) * a; } };
      for (const p of sats) lay(LINK, 0.30 * cov(distSeg(px, py, cx, cy, p.x, p.y) - linkW));
      for (const [i, j] of rims) lay(LINK, 0.16 * cov(distSeg(px, py, sats[i].x, sats[i].y, sats[j].x, sats[j].y) - linkW));

      // --- soft halos (a squared falloff reads the same as the SVG's blur) ---
      for (const p of sats) {
        const d = Math.hypot(px - p.x, py - p.y) / (p.rad * 2.6);
        if (d < 1) lay(p.rgb, 0.17 * Math.pow(1 - d, 2));
      }
      const cd = Math.hypot(px - cx, py - cy) / (coreR * 2.9);
      if (cd < 1) lay(CYAN, 0.22 * Math.pow(1 - cd, 2));

      // --- satellite discs ---
      for (const p of sats) lay(p.rgb, cov(Math.hypot(px - p.x, py - p.y) - p.rad));

      // --- core, with its off-centre highlight ---
      const ca = cov(Math.hypot(px - cx, py - cy) - coreR);
      if (ca > 0) {
        const t = clamp01(Math.hypot(px - (cx - 0.24 * coreR), py - (cy - 0.36 * coreR)) / (coreR * 1.5));
        const col = t < 0.42 ? mix(HOT, CYAN, t / 0.42) : mix(CYAN, COLD, (t - 0.42) / 0.58);
        lay(col, ca);
      }
      // --- core ring ---
      const ringR = coreR + 13 * v.scale * S, ringW = (2.5 * v.scale * S) / 2;
      lay(CYAN, 0.42 * cov(Math.abs(Math.hypot(px - cx, py - cy) - ringR) - ringW));

      // --- hairline border, hugging the plate edge ---
      if (v.border) lay(LINE2, cov(Math.abs(sdRoundRect(px, py, N, round) + 1.25 * S) - 1.25 * S));

      const o = (y * N + x) * 4;
      acc[o] = r; acc[o + 1] = g; acc[o + 2] = b; acc[o + 3] = plate * 255;
    }
  }

  // --- box-downsample the supersampled buffer ---
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const o = ((y * SS + dy) * N + (x * SS + dx)) * 4;
          r += acc[o]; g += acc[o + 1]; b += acc[o + 2]; a += acc[o + 3];
        }
      }
      const k = SS * SS, o = (y * size + x) * 4;
      out[o] = Math.round(r / k); out[o + 1] = Math.round(g / k);
      out[o + 2] = Math.round(b / k); out[o + 3] = Math.round(a / k);
    }
  }
  return out;
}

/* ------------------------------------------------- minimal PNG encoder (RGBA) */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
  return t;
})();
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                                    // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;                                          // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ============================================================== write it all */
const svgs = [['icon.svg', 'any'], ['icon-maskable.svg', 'maskable'], ['favicon.svg', 'favicon']];
for (const [name, v] of svgs) {
  fs.writeFileSync(path.join(OUT, name), toSvg(VARIANTS[v]));
  console.log(`  ${name}`);
}

const pngs = [
  ['icon-192.png', 192, 'any'], ['icon-512.png', 512, 'any'],
  ['icon-maskable-192.png', 192, 'maskable'], ['icon-maskable-512.png', 512, 'maskable'],
  ['icon-180.png', 180, 'any'], ['favicon-32.png', 32, 'favicon'],
];
for (const [name, size, v] of pngs) {
  const buf = encodePng(raster(size, VARIANTS[v]), size);
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`  ${name.padEnd(24)} ${size}x${size}  ${(buf.length / 1024).toFixed(1)}KB`);
}
console.log(`\n${svgs.length} svg + ${pngs.length} png written to web/`);
