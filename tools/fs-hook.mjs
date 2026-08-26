#!/usr/bin/env node
// fs-hook.mjs — PreToolUse. The enforcement half of the FileSearch system.
//
// The brief was "never open a file except through FileSearch". A skill cannot deliver
// that on its own: a skill is markdown loaded into the model's context, so it is
// advisory, and Read/Grep/Glob/Bash keep working whether or not the model remembered
// the rule. A hook is different — the harness runs it on EVERY matching tool call,
// including calls made by other skills and by subagents, and nothing in the model's
// context can skip it.
//
// So the split is: tools/filesearch.mjs supplies INTENT (the reason, the search
// ladder, fuzzy lookups); this supplies COVERAGE (every path any tool touches, no
// exceptions). Both POST the same /api/fs/touch, so the tree and the log see one
// consistent stream and neither can quietly miss a file.
//
// Hard rules for this file, in order of importance:
//   1. It must never block a tool call. 700ms ceiling, then it gives up.
//   2. It must never fail a tool call. Every path exits 0 with empty stdout.
//   3. It must never lose a line. If Metis is down, the entry goes to the spool.
//
// Registered in ~/.claude/settings.json as an ADDITIONAL PreToolUse entry, alongside
// the gitnexus one — never replacing it.
import fs from 'node:fs';
import path from 'node:path';
import { spoolAppend } from '../lib/fslog.mjs';
import { normalise } from '../lib/fsgraph.mjs';
import { postJSON } from '../lib/httpjson.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const PORT = Number(process.env.METIS_PORT || 8780);
const MAX_PATHS = 6;
const DEADLINE_MS = 700;

// Metis's own log and cache files are written BY this machinery. Recording them would
// fill the tree with the instrument rather than what it is measuring.
const IGNORE = [/[\\/]logs[\\/]metis_file_access/i, /\.fs-graph\.json$/i, /[\\/]\.git[\\/]/i];
const ignored = (p) => IGNORE.some((r) => r.test(p));

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    // A payload that arrives but does not parse used to vanish silently — correct for
    // rule 2, invisible for debugging. Hand the raw length back so the caller can
    // spool a diagnostic instead of the hook just appearing to do nothing.
    const done = () => {
      try { resolve(JSON.parse(s || '{}')); }
      catch (e) { resolve({ __badInput: String((e && e.message) || e), __len: s.length }); }
    };
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', done);
    process.stdin.on('error', () => resolve({}));
    setTimeout(done, 250);          // never hang a tool call on a stdin that never closes
  });
}

// Bash is the leaky one: the path is inside a command string, not a named field. This
// is deliberately a best-effort scrape — a missed path costs one node on the tree, a
// wrong guess costs a wrong node, so it only accepts things that are unambiguously
// path-shaped (a drive letter, or a git-bash /c/ prefix).
function pathsFromBash(cmd) {
  const out = [];
  // The drive letter must sit at a TOKEN BOUNDARY. Without the leading guard this
  // matched the "e:/" inside `file:///C:/AI/...` and produced a node for a drive E:
  // containing C:/AI/... — a confidently wrong branch, found by reading the rendered
  // tree. A `file://` scheme is stripped rather than matched around.
  const s = String(cmd || '').replace(/file:\/\/\/?/gi, ' ');
  const re = /(^|[\s"'`=(,;|&<>])((?:[A-Za-z]:[\\/]|\/[a-zA-Z]\/)[^\s"'`|;&<>()]*)/g;
  let m;
  while ((m = re.exec(s)) && out.length < MAX_PATHS * 3) {
    const p = m[2].replace(/[.,:;]+$/, '');
    if (p.length > 3 && !out.includes(p)) out.push(p);
  }
  return out;
}

// Bash-scraped paths are GUESSES and have to earn their place; a path named in a
// Read/Edit/Write input is authoritative and does not go through this.
//
// The failure this exists for: a commit message that *described* the earlier phantom-
// drive bug contained the literal text `E:/ -> C: -> AI`, and the scraper dutifully
// turned that prose into a branch. Scraping a shell command cannot tell a path being
// USED from a path being TALKED ABOUT — so ask the filesystem instead of the grammar.
//
// Keep a scraped path only if it, or its parent directory, actually exists. A file
// about to be written does not exist yet but its folder does, so real writes survive;
// prose almost never lands on a real directory. And reject dot-only segments — `...`
// is not a filename on any filesystem, it is an ellipsis.
function plausible(p, cwd) {
  const abs = normalise(p, cwd);
  if (!abs) return false;
  if (abs.split('/').some((seg) => /^\.{3,}$/.test(seg))) return false;
  try { if (fs.existsSync(abs)) return true; } catch { /* fall through */ }
  const parent = abs.slice(0, abs.lastIndexOf('/'));
  if (!parent || /^[A-Za-z]:$/.test(parent)) return false;   // a bare drive root is not evidence
  try { return fs.existsSync(parent); } catch { return false; }
}

function extract(tool, input, cwd) {
  const i = input || {};
  const out = [];
  const push = (v) => { if (v && typeof v === 'string' && !out.includes(v)) out.push(v); };
  switch (tool) {
    case 'Read': case 'Edit': case 'Write': push(i.file_path); break;
    case 'NotebookEdit': push(i.notebook_path || i.file_path); break;
    // A Grep/Glob names the directory it swept, not a file. That directory IS the
    // access — it is what "where did you look" means for a search.
    case 'Glob': case 'Grep': push(i.path || cwd); break;
    case 'Bash': for (const p of pathsFromBash(i.command)) if (plausible(p, cwd)) push(p); break;
    default: push(i.file_path || i.path); break;
  }
  return out.filter((p) => !ignored(p)).slice(0, MAX_PATHS);
}

(async () => {
  let payload = null;
  try {
    const input = await readStdin();
    if (input.__badInput) {
      spoolAppend(LOG_DIR, {
        via: 'hook:PreToolUse', trigger: 'malformed-input', method: null, requested: null,
        resolved: null, ok: false, ms: 0,
        error: `hook stdin did not parse as JSON (${input.__len} bytes): ${input.__badInput}`,
      });
      return process.exit(0);
    }
    const tool = input.tool_name || null;
    const cwd = input.cwd || process.cwd();
    const paths = extract(tool, input.tool_input, cwd);
    if (!paths.length) return process.exit(0);

    payload = {
      paths, cwd,
      via: 'hook:PreToolUse',
      tool,
      trigger: 'tool-call:' + (tool || 'unknown'),
      // A hook sees WHAT was opened but never WHY — only the FileSearch skill can
      // supply that. Say so rather than inventing a reason.
      reason: null,
      methods: [{ name: 'direct', ok: true, ms: 0, note: 'path supplied by the tool call' }],
      method: 'direct',
      requested: paths.join(' , '),
      ok: true,
      ms: 0,
      session: input.session_id || null,
    };

    const r = await postJSON(PORT, '/api/fs/touch', payload, DEADLINE_MS);
    if (!r) throw new Error('metis did not answer');
  } catch {
    // Metis unreachable or slow. Rule 3: the line survives anyway.
    if (payload) { try { spoolAppend(LOG_DIR, { ...payload, error: 'metis offline — spooled' }); } catch { /* rule 2 */ } }
  }
  process.exit(0);   // rule 2: this hook never fails a tool call, on any path
})();
