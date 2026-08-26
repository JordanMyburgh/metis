// stream-probe.mjs — dump the real shape of claude's stream-json events so the UI
// is built against what actually arrives, not what I assume arrives.
// Usage: node tools/stream-probe.mjs [model]
import { spawn } from 'node:child_process';

const model = process.argv[2] || 'haiku';
const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--model', model];
const p = spawn('claude', args, { cwd: 'C:/Users/mybur', stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });

let buf = '';
const seen = [];
p.stdout.on('data', (d) => {
  buf += d;
  const lines = buf.split('\n'); buf = lines.pop() ?? '';
  for (const l of lines) {
    if (!l.trim()) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const tag = `${j.type}${j.subtype ? '/' + j.subtype : ''}`;
    const rec = { tag, keys: Object.keys(j) };
    if (j.message && typeof j.message === 'object') {
      rec.msgKeys = Object.keys(j.message);
      if (j.message.model) rec.model = j.message.model;
      if (j.message.usage) rec.usage = j.message.usage;
    }
    for (const k of ['model', 'usage', 'total_cost_usd', 'num_turns', 'duration_ms', 'context', 'tokens']) {
      if (j[k] !== undefined && rec[k] === undefined) rec[k] = j[k];
    }
    seen.push(rec);
  }
});
p.stderr.on('data', (d) => process.stderr.write(String(d)));
p.on('close', (code) => {
  console.log('exit', code, '\n');
  for (const r of seen) {
    console.log(`--- ${r.tag}`);
    console.log('    keys:', r.keys.join(','));
    if (r.msgKeys) console.log('    message.keys:', r.msgKeys.join(','));
    if (r.model) console.log('    MODEL:', r.model);
    if (r.usage) console.log('    USAGE:', JSON.stringify(r.usage));
    for (const k of ['total_cost_usd', 'num_turns', 'duration_ms', 'context', 'tokens']) {
      if (r[k] !== undefined) console.log(`    ${k}:`, JSON.stringify(r[k]).slice(0, 300));
    }
  }
});
p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'say hi' }] } }) + '\n');
p.stdin.end();
