// models.mjs — local model (Ollama) visibility and VRAM control.
//
// Why this exists: Jordan builds and tests on the same 8 GB card the local models
// run on. Hermes's fallback chain can pull a model into VRAM at any moment, and a
// loaded model sits there until its keep_alive expires. This module lets the GUI
// answer "what is eating my VRAM right now" and free it with one click — the same
// authority `ollama ps` / `ollama stop` give the terminal, no more.
//
// Talks to Ollama's native API (127.0.0.1:11434), not /v1 — /v1 is the
// OpenAI-compat shim and has no ps/keep_alive. Nothing here installs, pulls or
// deletes a model: create/rm stay in the terminal, deliberately. Showing a button
// that can delete 33 GB of models is how 33 GB of models get deleted by a cat.
import { execFile } from 'node:child_process';

const OLLAMA = 'http://127.0.0.1:11434';

function ollama(pathname, init) {
  return fetch(OLLAMA + pathname, init).then((r) => {
    if (!r.ok) throw new Error(`ollama ${pathname}: HTTP ${r.status}`);
    return r.json().catch(() => ({}));   // /api/generate replies NDJSON-ish; body unused
  });
}

// nvidia-smi is the truth for the WHOLE card, not just Ollama's share — games,
// browsers and CUDA experiments all show up. Absent (driver update, AMD box) the
// panel simply loses the bar, not the model list.
function gpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        const [name, total, used] = String(out).trim().split(',').map((s) => s.trim());
        resolve({ name, totalMB: Number(total), usedMB: Number(used) });
      });
  });
}

// One snapshot the GUI can render directly: every installed model, which of them
// are resident, and what the card looks like. size on disk vs size_vram are
// different numbers — a spilled model (KV cache past VRAM) reports size > size_vram,
// which is exactly the condition worth surfacing.
export async function snapshot() {
  const [tags, ps, card] = await Promise.all([
    ollama('/api/tags').catch(() => null),
    ollama('/api/ps').catch(() => null),
    gpu(),
  ]);
  if (!tags) return { up: false, gpu: card, models: [] };
  const loaded = new Map((ps?.models || []).map((m) => [m.name, m]));
  const models = (tags.models || []).map((m) => {
    const live = loaded.get(m.name);
    return {
      name: m.name,
      diskBytes: m.size,
      loaded: !!live,
      // size = total resident footprint, size_vram = the GPU part. The gap is CPU spill.
      totalBytes: live ? live.size : 0,
      vramBytes: live ? live.size_vram : 0,
      context: live ? live.context_length : null,
      until: live ? live.expires_at : null,
    };
  }).sort((a, b) => Number(b.loaded) - Number(a.loaded) || b.diskBytes - a.diskBytes);
  return { up: true, gpu: card, models };
}

// keep_alive 0 = unload now. This is `ollama stop` over HTTP: the model leaves
// memory, the manifest stays on disk, nothing is lost.
export function unload(name) {
  return ollama('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, keep_alive: 0 }),
  });
}

// Warm a model ahead of need (evening prep: load it once, then use it). Default
// keep_alive matches Ollama's own 5m rather than inventing a new policy here.
export function load(name, keepAlive = '5m') {
  return ollama('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, keep_alive: keepAlive }),
  });
}
