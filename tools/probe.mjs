// probe.mjs — sanity-check the vault index + recall extraction against real transcripts.
// Usage: node tools/probe.mjs
import fs from 'node:fs';
import path from 'node:path';
import { buildGraph, resolvePath } from '../lib/vault-index.mjs';
import { newestSession, replaySession, PROJECTS } from '../lib/recall.mjs';

const g = buildGraph();
const real = g.nodes.filter((n) => n.group !== 'missing').length;
console.log(`GRAPH  ${g.nodes.length} nodes (${real} real, ${g.phantomCount} phantom), ${g.links.length} links`);

// resolver spot-checks — the thing everything downstream depends on
const cases = [
  'C:\\AI\\Brain\\knowledge\\infra\\proxmox.md',
  'C:/AI/Brain/agents/hermes.md',
  '/c/AI/Brain/projects/hermes-on-proxmox.md',
  'C:\\AI\\Brain\\feedback\\pref-recon-mode.md',
  'C:\\Users\\mybur\\notes\\unrelated.md',
];
console.log('\nRESOLVER');
for (const c of cases) console.log(`  ${resolvePath(g, c) ?? '(no match)'}   <- ${c}`);

// how many sessions yield recall signal, and how strong
const files = [];
for (const d of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(PROJECTS, d.name))) {
    if (f.endsWith('.jsonl')) files.push(path.join(PROJECTS, d.name, f));
  }
}
files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
console.log(`\nTRANSCRIPTS ${files.length} found; scanning newest 12`);

const scored = [];
for (const f of files.slice(0, 12)) {
  let events = 0; const ids = new Set(); const tools = new Set();
  await replaySession(f, g, (h) => { events++; h.ids.forEach((i) => ids.add(i)); tools.add(h.tool); }, { stepMs: 0 });
  scored.push({ f, events, notes: ids.size, tools: [...tools] });
}
scored.sort((a, b) => b.events - a.events);
for (const s of scored) {
  const kb = Math.round(fs.statSync(s.f).size / 1024);
  console.log(`  ${String(s.events).padStart(4)} touches  ${String(s.notes).padStart(3)} notes  ${String(kb).padStart(5)}KB  ${path.basename(s.f).slice(0, 8)}  [${s.tools.join(',')}]`);
}
const best = scored[0];
console.log(`\nBEST REPLAY CANDIDATE: ${best ? path.basename(best.f) : 'none'}  (${best?.events} touches, ${best?.notes} distinct notes)`);
console.log(`LIVE SESSION: ${newestSession()?.path ?? 'none'}`);
