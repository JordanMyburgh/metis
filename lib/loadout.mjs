// loadout.mjs — the outer islands' roster, derived from what was actually CALLED.
//
// The tools island used to be filled from the embedded chat's `system`/`init` record.
// With the chat gone there is no init record to read: a Claude Code desktop transcript
// carries assistant / user / attachment lines and nothing that declares the session's
// roster. Measured across 244 transcripts and 19,672 lines on this machine: zero.
//
// So the roster comes from tool CALLS instead, and that is the better island anyway —
// it shows the tools this machine actually uses, not a declared list mostly untouched.
// The first scan seeds it from history (56 names / 10 MCP servers here); after that it
// grows live as new tools get called, and the cache makes boot instant.
//
// Connector servers (Gmail, Calendar) only ever appear as `mcp__<uuid>__<tool>` tool
// names — there is no entry for them in .claude.json — so deriving MCP nodes from tool
// names is the ONLY way those servers get a node to light up.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS } from './recall.mjs';

// Claude Code's own bookkeeping tools would just be noise on the island.
const SKIP = new Set(['TodoWrite', 'StructuredOutput']);

export class Loadout {
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.names = new Set();
    this.dirty = false;
    this.saveTimer = null;
  }

  get toolNames() { return [...this.names].sort(); }
  get size() { return this.names.size; }

  // Returns true when the roster actually changed, so the caller can decide whether
  // rebuilding the layout is worth it. Called on every tool_use, so it must be cheap.
  observe(name) {
    if (!name || SKIP.has(name) || this.names.has(name)) return false;
    this.names.add(name);
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 4000);   // calls arrive in bursts
    if (this.saveTimer.unref) this.saveTimer.unref();
    return true;
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (Array.isArray(d.tools) && d.tools.length) {
        for (const t of d.tools) if (!SKIP.has(t)) this.names.add(t);
        return { from: 'cache', count: this.names.size, scanned: d.scanned ?? null };
      }
    } catch { /* no cache yet — fall through to the history scan */ }
    const n = this.scanHistory();
    this.save();
    return { from: 'history', count: this.names.size, scanned: n };
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.names.size) return;
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify({
        tools: this.toolNames, updated: new Date().toISOString(),
      }, null, 2));
      this.dirty = false;
    } catch { /* a cache that cannot be written is a slow boot, not a broken one */ }
  }

  // One full pass over every transcript. ~1.5s for 244 files here, and it only runs
  // when the cache is missing.
  scanHistory(dir = PROJECTS) {
    let files = 0;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        if (!e.name.endsWith('.jsonl')) continue;
        files++;
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          // Cheap prefilter — most lines carry no tool call at all, and JSON.parse
          // on 19k lines is the whole cost of this scan.
          if (!line.includes('"tool_use"')) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          const c = j.message && j.message.content;
          if (!Array.isArray(c)) continue;
          for (const b of c) {
            if (b && b.type === 'tool_use' && b.name && !SKIP.has(b.name)) this.names.add(b.name);
          }
        }
      }
    }
    return files;
  }
}
