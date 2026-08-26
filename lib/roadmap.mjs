// lib/roadmap.mjs — the study roadmap: what to learn, in order, and what has been MARKED.
//
// Two files, deliberately. `data/roadmap.json` is the CURRICULUM — phases, topics,
// projects, cold gates, and the instruction brief for each. It is source, it is
// committed, and it changes only when the plan changes. `.roadmap.json` is PROGRESS —
// the marks. Personal working state for this machine, gitignored, like `.desk.json`.
//
// Splitting them lets the curriculum be edited (reword a topic, add a phase) without
// losing a year of marks, and lets progress be wiped without losing the plan.
//
// ---------------------------------------------------------------------------
// Why there is no toggle() any more (2026-08-24, Jordan's call)
//
// There used to be one, and the GUI had live checkboxes. He asked for them to be
// taken away: a cold gate you tick yourself is not a gate. Marking is now Claude's
// job, after looking at the work.
//
// The important part is that this is enforced HERE and not in the browser. A disabled
// checkbox is advice — anyone can re-enable it in devtools, and more to the point the
// endpoint behind it would still accept a bare tick. The server now has no way to set
// an item done except by supplying a score, so the rule holds however you reach it.
// Same principle as the FileSystem graph: a skill is advisory, a hook is enforcement.
//
// A score below the pass mark records the attempt and the feedback and leaves the item
// OPEN. That is the point — a 4/10 is a real result you can act on, not a failure to
// be hidden, and the item stays there to be resubmitted.
import fs from 'node:fs';

const EMPTY = () => ({ marks: {}, rev: 0 });
const PASS = 0.7;                       // 7 out of 10
const clampNum = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n)));

export class Roadmap {
  constructor(defFile, progressFile) {
    this.defFile = defFile;
    this.file = progressFile;
    this.def = null;
    this.state = EMPTY();
    this.loadDef();
    try {
      const raw = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      this.state = { ...EMPTY(), ...raw };
      if (!this.state.marks || typeof this.state.marks !== 'object') this.state.marks = {};
      if (typeof this.state.rev !== 'number') this.state.rev = 0;
      // Migration from the checkbox era: a bare `done` map of id -> timestamp. Those
      // ticks were self-awarded, so they are carried over as unscored marks rather
      // than silently promoted to passes they never earned.
      if (raw.done && typeof raw.done === 'object') {
        for (const [id, at] of Object.entries(raw.done)) {
          if (this.state.marks[id]) continue;
          this.state.marks[id] = { score: null, max: 10, passed: false, at: Number(at) || Date.now(),
                                   feedback: 'Ticked before marking existed — resubmit for a score.', by: 'legacy' };
        }
        delete this.state.done;
        this._write();
      }
    } catch { /* first run */ }
  }

  // Read from disk on every call rather than caching: the curriculum is a file Jordan
  // or I may edit mid-session, and a stale in-memory copy would silently render last
  // week's plan. It is ~50 KB — the read costs less than the confusion would.
  loadDef() {
    try {
      this.def = JSON.parse(fs.readFileSync(this.defFile, 'utf8'));
    } catch (e) {
      this.def = this.def || { id: 'none', title: 'Roadmap', phases: [], error: String(e.message) };
    }
    return this.def;
  }

  _write() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2)); } catch {}
  }

  // The only way an item can become done. Score is required and is what decides it —
  // there is deliberately no parameter here that just sets `passed`.
  mark(id, { score, max = 10, feedback = '', by = 'claude' } = {}) {
    const item = this.item(String(id || ''));
    if (!item) return null;
    if (score === null || score === undefined || Number.isNaN(Number(score)))
      throw new Error('score required — an item cannot be marked done without one');
    const m = clampNum(max, 1, 100);
    const s = clampNum(score, 0, m);
    const mark = {
      score: s, max: m, passed: s / m >= PASS,
      feedback: String(feedback || '').slice(0, 4000),
      at: Date.now(), by: String(by || 'claude').slice(0, 40),
    };
    this.state.marks[id] = mark;
    this.state.rev = (this.state.rev || 0) + 1;
    this._write();
    return { id, ...mark };
  }

  // Undo a mark entirely — for a marking mistake, or a curriculum change that makes an
  // old score meaningless. Not reachable from the GUI.
  unmark(id) {
    if (!this.state.marks[id]) return null;
    delete this.state.marks[id];
    this.state.rev = (this.state.rev || 0) + 1;
    this._write();
    return { id, cleared: true };
  }

  item(id) {
    for (const p of this.def.phases || []) {
      const hit = (p.items || []).find((i) => i.id === id);
      if (hit) return hit;
    }
    return null;
  }

  // Phases with progress folded in. `current` is the first phase not finished — the
  // one honest answer to "where am I", and what the panel opens on.
  snapshot() {
    this.loadDef();
    const marks = this.state.marks || {};
    const phases = (this.def.phases || []).map((p) => {
      const items = (p.items || []).map((i) => {
        const m = marks[i.id] || null;
        return { ...i, done: !!(m && m.passed), mark: m, attempted: !!m };
      });
      const total = items.length;
      const count = items.filter((i) => i.done).length;
      const gate = items.find((i) => i.kind === 'gate');
      // Average across everything scored so far in this phase, so a phase carries a
      // grade and not just a tally.
      const scored = items.filter((i) => i.mark && i.mark.score !== null);
      const avg = scored.length
        ? Math.round((scored.reduce((n, i) => n + (i.mark.score / i.mark.max), 0) / scored.length) * 100)
        : null;
      return {
        ...p, items, total, count,
        complete: total > 0 && count === total,
        // A phase is only really passed when its cold gate is marked. Topics read;
        // the gate is the one that proves it.
        gateDone: gate ? gate.done : false,
        avg,
        next: items.find((i) => !i.done)?.text || null,
      };
    });
    const total = phases.reduce((n, p) => n + p.total, 0);
    const count = phases.reduce((n, p) => n + p.count, 0);
    const current = phases.find((p) => !p.complete) || phases[phases.length - 1] || null;
    return {
      title: this.def.title || 'Roadmap',
      budget: this.def.budget || '',
      grading: this.def.grading || '',
      source: this.def.source || '',
      phases, total, count,
      pct: total ? Math.round((count / total) * 100) : 0,
      currentId: current ? current.id : null,
      rev: this.state.rev || 0,
    };
  }

  // Plain text, same reason as the desk's todoBlock: the consumer is a prompt, not a
  // parser. Two lines maximum — this would ride along on every session start, so it
  // earns its tokens by answering "where is he" and nothing else.
  block() {
    const s = this.snapshot();
    if (!s.total) return '';
    const cur = s.phases.find((p) => p.id === s.currentId);
    if (!cur) return '';
    const next = cur.next ? ` Next: ${cur.next}` : '';
    return `Study roadmap (Metis, ${s.count}/${s.total} passed, ${s.pct}%). Currently on Phase ${cur.n} — ${cur.title} (${cur.count}/${cur.total}${cur.avg !== null ? `, averaging ${cur.avg}%` : ''}).${next}`;
  }
}
