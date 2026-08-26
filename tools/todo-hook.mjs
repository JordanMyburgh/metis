#!/usr/bin/env node
// todo-hook.mjs — UserPromptSubmit. Re-injects the shared todo list, but only when it
// has actually changed since the last time this session was shown it.
//
// Why this exists at all: session-hook.mjs already puts the open todos into the opening
// context, which covers "Claude sees them at the start". It does not cover the case the
// shared list is actually FOR — Jordan ticks something off, or adds "check X", while a
// conversation is already running. Without this hook that todo waits for a session that
// may not happen today, and a list only one side can see in time is not a shared list.
//
// The cost of being wrong here is paid on every single prompt, so the design is:
//   - one localhost GET, 500ms hard ceiling, and silence on any failure
//   - output NOTHING unless `rev` moved. An unchanged list re-injected every turn would
//     be pure token tax, and worse, it would train me to ignore the block.
//   - never a non-zero exit, never a blocking decision. A todo list must not be able to
//     stop Jordan sending a message.
//
// `rev` is bumped by lib/desk.mjs on every add/toggle/remove/clear. session-hook.mjs
// writes the same cache file after ITS injection, so the first prompt of a session is
// silent rather than showing the identical list twice.
//
// httpjson, not fetch — for the reason written at the top of lib/httpjson.mjs. The
// first version of this file used fetch and tripped that exact libuv assertion on the
// run that had output to write, which is the run where a truncated stdout would matter.
//
// Registered as a SECOND UserPromptSubmit entry in ~/.claude/settings.json, alongside
// aether2's — never replacing it.
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, getText } from '../lib/httpjson.mjs';

const PORT = Number(process.env.METIS_PORT || 8780);
const ROOT = path.resolve(import.meta.dirname, '..');
const REV_CACHE = path.join(ROOT, '.todo-rev-cache.json');
const BUDGET_MS = 500;

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    const done = () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } };
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', done);
    process.stdin.on('error', () => resolve({}));
    setTimeout(done, 200);          // never hang a prompt on a stdin that never closes
  });
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(REV_CACHE, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  const ids = Object.keys(c);
  if (ids.length > 40) {
    const keep = ids.map((k) => [k, c[k].at || 0]).sort((a, b) => b[1] - a[1]).slice(0, 40);
    c = Object.fromEntries(keep.map(([k]) => [k, c[k]]));
  }
  try { fs.writeFileSync(REV_CACHE, `${JSON.stringify(c)}\n`, 'utf8'); } catch { /* ignore */ }
}

// Printing nothing is a valid UserPromptSubmit result and means "no extra context",
// which is the right answer on almost every turn. No process.exit(): with agent:false
// the loop drains on its own, and exiting by hand is what truncates a piped write.
function emit(context) {
  if (!context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
}

(async () => {
  const started = Date.now();
  const input = await readStdin();
  const sessionId = input.session_id || null;
  if (!sessionId) return;

  const d = await getJSON(PORT, '/api/todos', BUDGET_MS);
  if (!d) return;                                 // Metis down: say nothing, cost nothing
  const rev = Number(d.rev) || 0;

  const cache = loadCache();
  const seen = Number(cache[sessionId]?.rev);

  // First prompt of a session with no cache entry: seed and stay silent. Either
  // session-hook already showed the list, or Metis was down when it tried — and a
  // duplicate block is a worse failure than a delayed one.
  if (!Number.isFinite(seen)) { cache[sessionId] = { rev, at: Date.now() }; saveCache(cache); return; }
  if (rev === seen) return;

  cache[sessionId] = { rev, at: Date.now() };
  saveCache(cache);

  // The list emptied, or everything got ticked off. Worth one line — otherwise I would
  // keep acting on a list that no longer exists.
  if (!d.open) {
    emit('The shared todo list (Metis desk) is now empty — every item has been ticked off or removed.');
    return;
  }

  const left = BUDGET_MS - (Date.now() - started);
  const block = left > 60 ? await getText(PORT, '/api/todos?format=text', left) : null;
  if (!block || !block.trim()) return;
  emit(`The shared todo list changed since you were last shown it.\n${block.trim()}`);
})();
