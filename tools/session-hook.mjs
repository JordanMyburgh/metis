// session-hook.mjs — SessionStart. Wires every new Claude Code session to Metis.
//
// Three jobs, listed in the order that matters when one of them fails:
//   1. print the standing directive   — the only part the model ever sees
//   2. tell Metis which transcript to follow — the GUI is blind without it
//   3. start Metis if nothing is listening   — so job 2 has somewhere to land
//
// Job 1 must ALWAYS happen. Every failure path below still prints the directive: a
// dead server degrades the visualisation, never the rules. That ordering is the whole
// design — "no exceptions" cannot depend on a localhost port being up.
//
// Latency budget: when Metis is already running (the normal case) this is one TCP
// connect plus one POST, ~50ms. The wait loop only runs on the cold path, once.
//
// Registered in ~/.claude/settings.json as a SECOND SessionStart entry, alongside
// aether2's — never replacing it.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getJSON, getText } from '../lib/httpjson.mjs';

const PORT = Number(process.env.METIS_PORT || 8780);
const HOST = '127.0.0.1';
const ROOT = path.resolve(import.meta.dirname, '..');

const DIRECTIVE = `Metis is live for this session and is watching this conversation's transcript (http://127.0.0.1:8780). Metis has no chat of its own — this session IS how Metis is used and communicated with.

Standing rules for this session, no exceptions:
- Before answering anything about Jordan's projects, decisions, infrastructure, people or past work, grep the vault at C:\\AI\\Brain (map: INDEX.md). Do not answer from memory alone.
- Answer "is it in Metis?" / "did you get that from Metis?" with the node id (e.g. knowledge/infra/proxmox.md), never a bare yes/no. If it did not come from the vault, say where it did.
- Write durable new knowledge back per C:\\AI\\Brain\\SCHEMA.md, and commit the vault after a write session.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    const done = () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } };
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', done);
    process.stdin.on('error', () => resolve({}));
    setTimeout(done, 400);          // never hang the session on a stdin that never closes
  });
}

// A TCP connect is the only honest "is it up" check — a stale PID file lies.
function listening(ms) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: PORT, host: HOST });
    let settled = false;
    const end = (v) => { if (settled) return; settled = true; try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(ms);
    sock.once('connect', () => end(true));
    sock.once('timeout', () => end(false));
    sock.once('error', () => end(false));
  });
}

// Detached and unref'd: Metis must outlive the hook, the session, and the terminal.
function startMetis() {
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    return true;
  } catch { return false; }
}

async function tellMetis(body, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`http://${HOST}:${PORT}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    return r.ok;
  } catch { return false; } finally { clearTimeout(t); }
}

// --- pointer guards --------------------------------------------------------
// The POST below is last-writer-wins: whoever starts most recently owns the graph.
// That is right for a person opening a new conversation and wrong for everything
// else, because a session is spawned far more often than one is *held*. A nested
// `claude -p`, a subagent, a benchmark run or a scripted one-shot each yank the
// graph off the conversation Jordan is actually in — silently, since the directive
// still prints and nothing looks broken. Observed 2026-08-23: four benchmark runs
// in a scratchpad dir left /api/status following a throwaway transcript.
// Both guards fail OPEN — an unrecognised shape still attaches, exactly as before.

const BSLASH = String.fromCharCode(92);

// A session Claude Code spawned from inside another session inherits the host's id
// in its environment. A top-level session has no host but itself, so comparing the
// two separates "nested" from "new" without guessing at process trees.
function isNested(sessionId) {
  const host = process.env.CLAUDE_CODE_HOST_SESSION_ID || null;
  if (!host || !sessionId) return false;
  return host !== sessionId;
}

// Scratchpads and temp dirs are where throwaway sessions run. A conversation worth
// following is never rooted in one.
function isEphemeral(cwd) {
  if (!cwd) return false;
  const p = String(cwd).split(BSLASH).join('/').toLowerCase();
  return p.includes('/temp/') || p.includes('/scratchpad') || p.startsWith('/tmp/');
}

function emit(note, todos) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: [DIRECTIVE, note, todos].filter(Boolean).join('\n\n'),
    },
  }));
}

// --- the shared todo list --------------------------------------------------
// The desk's notes box is Jordan's alone. The todo list is the one part of the desk
// both sides write, so it has to REACH me rather than merely be readable: it goes into
// the session's opening context here, and tools/todo-hook.mjs re-injects it mid-session
// whenever it changes. Both channels write the rev they showed into the same cache, so
// the same list is never shown twice in a row.
const REV_CACHE = path.join(ROOT, '.todo-rev-cache.json');

// httpjson, not fetch — see the top of lib/httpjson.mjs. This runs immediately before
// process.exit(), which is exactly the shape that trips the undici/libuv assertion, and
// the thing at risk of truncation here is the standing directive itself.
async function fetchTodos(ms) {
  const d = await getJSON(PORT, '/api/todos', ms);
  if (!d) return null;
  if (!d.open) return { block: '', rev: d.rev || 0 };
  const block = await getText(PORT, '/api/todos?format=text', ms);
  return { block: (block || '').trim(), rev: d.rev || 0 };
}

function markRev(sessionId, rev) {
  if (!sessionId) return;
  let c = {};
  try { c = JSON.parse(fs.readFileSync(REV_CACHE, 'utf8')); } catch { /* first run */ }
  c[sessionId] = { rev, at: Date.now() };
  const ids = Object.keys(c);
  if (ids.length > 40) {
    const keep = ids.map((k) => [k, c[k].at || 0]).sort((a, b) => b[1] - a[1]).slice(0, 40);
    c = Object.fromEntries(keep.map(([k]) => [k, c[k]]));
  }
  try { fs.writeFileSync(REV_CACHE, `${JSON.stringify(c)}\n`, 'utf8'); } catch { /* never fail a session */ }
}

(async () => {
  let note = '';
  let sessionIdForRev = null;
  try {
    const input = await readStdin();
    const sessionId = input.session_id || null;
    sessionIdForRev = sessionId;
    const transcriptPath = input.transcript_path || null;

    let up = await listening(250);
    if (!up) {
      // The listener binds only after the vault scan and layout, ~1s cold.
      if (startMetis()) {
        for (let i = 0; i < 7 && !up; i++) { await sleep(300); up = await listening(150); }
      }
      if (!up) note = 'Note: the Metis GUI is not responding on 127.0.0.1:8780, so the graph is not following this session. The rules above still apply.';
    }

    if (up) {
      const cwd = input.cwd || null;
      const skip = isNested(sessionId) ? 'nested' : isEphemeral(cwd) ? 'ephemeral' : null;

      if (skip) {
        // Leave the pointer alone: Metis keeps following the real conversation.
        note = 'Note: this is a ' + skip + ' session, so Metis was left following the conversation it was already attached to. The rules above still apply.';
      } else {
        const ok = await tellMetis({ sessionId, transcriptPath, cwd, source: input.source || null }, 1200);
        if (!ok) note = 'Note: Metis is up but did not accept the session handoff, so the graph may be following a different transcript. The rules above still apply.';
      }
    }
  } catch (e) {
    note = `Note: the Metis session hook errored (${String((e && e.message) || e)}). The rules above still apply.`;
  }
  // Never let the todo list cost the session its directive: on any failure the block
  // is simply absent, the same way the graph is when the port is dead.
  let todos = '';
  try {
    const t = await fetchTodos(800);
    if (t) { todos = t.block; markRev(sessionIdForRev, t.rev); }
  } catch { /* ignore */ }
  emit(note, todos);
  process.exit(0);
})();
