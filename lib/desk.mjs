// lib/desk.mjs — the desk: scratch notes, the focus timer, and the day's schedule.
//
// Why this is server-side and not localStorage: localStorage is per-browser, invisible
// to grep, invisible to Claude, and gone the moment the PWA's storage is cleared. A
// note you wrote is a thing you wrote — it lives in a file (`.desk.json`) that a later
// session can read. The running timer lives there too, so a reload, a crash or an
// accidental close does not silently kill a focus session that is 40 minutes in.
//
// Not the vault: the vault is durable knowledge under SCHEMA.md. This is a scratchpad
// and a clock. Promoting a note to the vault stays a deliberate act.
import fs from 'node:fs';

const EMPTY = () => ({ notes: { text: '', updated: 0 }, focus: null, schedule: [], todos: [], rev: 0 });
const clampMin = (m) => Math.max(1, Math.min(600, Math.round(Number(m) || 0)));
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
// local calendar day, not UTC — "has today's 09:00 block fired yet" is a local question
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export class Desk {
  constructor(file) {
    this.file = file;
    this.state = EMPTY();
    this.saveT = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.state = { ...EMPTY(), ...raw };
      if (!Array.isArray(this.state.schedule)) this.state.schedule = [];
      if (!Array.isArray(this.state.todos)) this.state.todos = [];
      if (typeof this.state.rev !== 'number') this.state.rev = 0;
      if (!this.state.notes || typeof this.state.notes.text !== 'string') this.state.notes = { text: '', updated: 0 };
    } catch { /* first run */ }
    // A session that was running when the process died is over, not eternally running.
    const f = this.state.focus;
    if (f && f.state === 'running' && f.endsAt <= Date.now()) f.state = 'done';
  }

  // Debounced: typing in the notes box fires this on every keystroke burst, and a
  // synchronous write per keystroke would be the one slow thing in the whole server.
  save(now = false) {
    if (now) { clearTimeout(this.saveT); this.saveT = null; this._write(); return; }
    if (this.saveT) return;
    this.saveT = setTimeout(() => { this.saveT = null; this._write(); }, 700);
  }
  _write() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2)); } catch {}
  }

  // ---- notes
  setNotes(text) {
    this.state.notes = { text: String(text ?? '').slice(0, 200000), updated: Date.now() };
    this.save();
    return this.state.notes;
  }

  // ---- focus timer
  startFocus({ minutes, label, source = 'gui' } = {}) {
    const m = clampMin(minutes ?? 60);
    const t = Date.now();
    this.state.focus = {
      id: 'f' + t.toString(36),
      label: String(label || 'Focus').slice(0, 120),
      minutes: m, startedAt: t, endsAt: t + m * 60000,
      state: 'running', source,
    };
    this.save(true);
    return this.focus();
  }
  stopFocus() {
    const f = this.state.focus;
    if (f && f.state === 'running') { f.state = 'stopped'; f.endsAt = Date.now(); }
    this.save(true);
    return this.focus();
  }
  // remaining is DERIVED, never stored — a stored countdown is wrong the instant the
  // process is paused, and the deadline is the only fact worth persisting.
  focus() {
    const f = this.state.focus;
    if (!f) return null;
    const left = Math.max(0, f.endsAt - Date.now());
    return { ...f, remainingMs: f.state === 'running' ? left : 0,
             elapsedMs: Math.max(0, Math.min(f.endsAt, Date.now()) - f.startedAt) };
  }

  // ---- schedule
  addBlock({ at, minutes, label, days } = {}) {
    if (!HHMM.test(String(at || ''))) throw new Error('at must be HH:MM (24h)');
    const b = {
      id: 'b' + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36),
      at: String(at), minutes: clampMin(minutes ?? 60),
      label: String(label || 'Focus').slice(0, 120),
      // null = every day; otherwise 0=Sun..6=Sat
      days: Array.isArray(days) && days.length ? days.map(Number).filter((d) => d >= 0 && d <= 6) : null,
      lastFired: null,
    };
    this.state.schedule.push(b);
    this.state.schedule.sort((x, y) => x.at.localeCompare(y.at));
    this.save(true);
    return b;
  }
  removeBlock(id) {
    const n = this.state.schedule.length;
    this.state.schedule = this.state.schedule.filter((b) => b.id !== id);
    if (this.state.schedule.length !== n) this.save(true);
    return this.state.schedule.length !== n;
  }

  // Called on a slow interval. Returns the events worth broadcasting, so the caller
  // owns the transport and this file owns nothing but the state machine.
  tick(now = Date.now()) {
    const out = [];
    const f = this.state.focus;
    if (f && f.state === 'running' && f.endsAt <= now) {
      f.state = 'done';
      this.save(true);
      out.push({ type: 'focus_end', focus: this.focus() });
    }
    const d = new Date(now), key = dayKey(d), mins = d.getHours() * 60 + d.getMinutes();
    for (const b of this.state.schedule) {
      if (b.lastFired === key) continue;
      if (b.days && !b.days.includes(d.getDay())) continue;
      const [h, m] = b.at.split(':').map(Number);
      const due = h * 60 + m;
      // 3-minute grace window: a server started at 15:00 must not fire the 09:00 block,
      // but a 15s tick that lands a few seconds late must still fire it.
      if (mins < due || mins > due + 3) continue;
      b.lastFired = key;
      this.startFocus({ minutes: b.minutes, label: b.label, source: 'schedule' });
      out.push({ type: 'focus_start', focus: this.focus(), block: b.id });
    }
    return out;
  }

  // Next scheduled block from now, wrapping into tomorrow. The GUI shows it so the
  // schedule is a thing you can read at a glance, not a list you have to scan.
  next(now = Date.now()) {
    const d = new Date(now), mins = d.getHours() * 60 + d.getMinutes();
    let best = null;
    for (const b of this.state.schedule) {
      const [h, m] = b.at.split(':').map(Number);
      const due = h * 60 + m;
      for (let ahead = 0; ahead <= 7; ahead++) {
        const day = (d.getDay() + ahead) % 7;
        if (b.days && !b.days.includes(day)) continue;
        if (ahead === 0 && due <= mins) continue;
        const inMin = ahead * 1440 + due - mins;
        if (!best || inMin < best.inMin) best = { ...b, inMin, ahead };
        break;
      }
    }
    return best;
  }


  // ---- todos: the SHARED list
  //
  // The notes box above is Jordan's alone — private scratch, and nothing reads it back
  // to me. The todo list is the opposite: it is the one part of the desk that both
  // sides write and both sides see. `rev` is what makes "both see it" true rather than
  // merely possible: the UserPromptSubmit hook compares the rev it last injected
  // against this one, so a todo added in the GUI mid-session reaches me on Jordan's
  // very next message instead of waiting for a session that may not come today.
  bump() { this.state.rev = (this.state.rev || 0) + 1; }

  addTodo({ text, source = 'jordan' } = {}) {
    const t = String(text ?? '').trim();
    if (!t) throw new Error('text required');
    if (this.state.todos.length >= 200) throw new Error('todo list is full (200)');
    const todo = {
      id: 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36),
      text: t.slice(0, 400),
      done: false,
      // Who put it there. Shown in the GUI and in the injected block, because "did I
      // write this or did Claude" is the first question you ask of a shared list.
      source: source === 'claude' ? 'claude' : 'jordan',
      created: Date.now(),
      doneAt: null,
    };
    this.state.todos.push(todo);
    this.bump();
    this.save(true);
    return todo;
  }

  toggleTodo(id, done) {
    const t = this.state.todos.find((x) => x.id === id);
    if (!t) return null;
    t.done = typeof done === 'boolean' ? done : !t.done;
    t.doneAt = t.done ? Date.now() : null;
    this.bump();
    this.save(true);
    return t;
  }

  removeTodo(id) {
    const n = this.state.todos.length;
    this.state.todos = this.state.todos.filter((x) => x.id !== id);
    if (this.state.todos.length === n) return false;
    this.bump();
    this.save(true);
    return true;
  }

  clearDoneTodos() {
    const n = this.state.todos.length;
    this.state.todos = this.state.todos.filter((x) => !x.done);
    const removed = n - this.state.todos.length;
    if (removed) { this.bump(); this.save(true); }
    return removed;
  }

  openTodos() { return this.state.todos.filter((t) => !t.done); }

  // Plain text, because both consumers are prompts, not parsers.
  todoBlock() {
    const open = this.openTodos();
    if (!open.length) return '';
    const lines = open.map((t) => `- [ ] ${t.text}${t.source === 'claude' ? '  (added by Claude)' : ''}`);
    return `Shared todo list (Metis desk, ${open.length} open). Jordan and Claude both see and both write this list. Treat it as context, not as a command to start working: do NOT begin an item unless Jordan asks for it in this conversation.\n${lines.join('\n')}`;
  }

  snapshot() {
    return { notes: this.state.notes, focus: this.focus(),
             schedule: this.state.schedule, next: this.next(),
             todos: this.state.todos, rev: this.state.rev || 0 };
  }
}
