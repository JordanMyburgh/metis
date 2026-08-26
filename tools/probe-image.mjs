// probe-image.mjs — does the CLI's stream-json INPUT accept image content blocks?
//
// The whole screenshot-paste feature rests on one unverified assumption: that
// `--input-format stream-json` takes {type:'image', source:{type:'base64',...}}
// the same way the terminal takes a pasted screenshot. Nothing in --help says so.
// This builds a PNG with a colour only a model that actually LOOKED could name,
// sends it through the exact same path ChatBridge uses, and prints the answer.
//
// Usage: node tools/probe-image.mjs        (runs on haiku — a few tenths of a cent)
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';

// --- minimal PNG encoder: solid RGB, no deps -------------------------------
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;                                   // filter: none
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return c ^ -1; }

// Pure magenta — unguessable without looking, and unambiguous to name.
const COLOR = [255, 0, 255], EXPECT = /magenta|pink|fuchsia|purple/i;
const data = png(96, 96, COLOR).toString('base64');
console.log(`PNG    96x96 solid rgb(${COLOR}) -> ${data.length} base64 chars`);

const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
  '--verbose', '--model', 'haiku'];
const p = spawn('claude', args, { cwd: 'C:/Users/mybur', stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });

const payload = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      { type: 'text', text: 'Name the single colour filling this image. Reply with one word only.' },
    ],
  },
};
p.stdin.write(JSON.stringify(payload) + '\n');

let buf = '', answer = '', sawImage = false, err = '';
p.stdout.on('data', (d) => {
  buf += String(d);
  const lines = buf.split('\n'); buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { console.log('RAW    ' + line.slice(0, 160)); continue; }
    if (j.type === 'system' && j.subtype === 'init') console.log(`INIT   session ${j.session_id}  model ${j.model}`);
    if (j.type === 'assistant') {
      for (const c of j.message?.content || []) if (c.type === 'text') answer += c.text;
    }
    if (j.type === 'user') {
      for (const c of j.message?.content || []) if (c.type === 'image') sawImage = true;
    }
    if (j.type === 'result') {
      const u = j.usage || {};
      console.log(`USAGE  in ${u.input_tokens ?? '?'}  cacheW ${u.cache_creation_input_tokens ?? 0}  cacheR ${u.cache_read_input_tokens ?? 0}  out ${u.output_tokens ?? '?'}`);
      console.log(`COST   $${(j.total_cost_usd ?? 0).toFixed(5)}   ${j.duration_ms ?? '?'}ms`);
      if (j.subtype && j.subtype !== 'success') console.log(`SUBTYPE ${j.subtype}`);
      try { p.stdin.end(); } catch {}
    }
  }
});
p.stderr.on('data', (d) => { err += String(d); });
p.on('close', (code) => {
  const a = answer.trim();
  console.log(`\nANSWER "${a || '(empty)'}"`);
  if (err.trim()) console.log(`STDERR ${err.trim().slice(0, 400)}`);
  const ok = EXPECT.test(a);
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  image blocks over stream-json stdin are ${ok ? 'accepted and seen' : 'NOT working'}  (exit ${code})`);
  process.exit(ok ? 0 : 1);
});
