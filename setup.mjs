#!/usr/bin/env node
// setup.mjs — bring a fresh clone of Metis to a working state. Idempotent: every
// step reports ok / done / skipped, and re-running never duplicates anything.
//
//   node setup.mjs --vault <path-to-markdown-vault> [options]
//
//   --vault <dir>      REQUIRED on first run: the folder of .md notes to render
//   --seed             if that folder is missing or has no .md files, create it with
//                      a few starter notes (never touches a vault that has notes)
//   --projects <dir>   agent transcript dir (default: ~/.claude/projects)
//   --hooks            register the 3 Claude Code hooks in ~/.claude/settings.json
//                      (backs the file up first; appends only what is missing)
//   --startup          (Windows) install a Startup shim so Metis starts at login
//   --start            start the server now, detached, and verify HTTP 200
//   --status           print what is configured/running and exit
//
// What it never does: overwrite an existing metis.config.json value you didn't pass,
// duplicate a hook entry, or touch settings.json without writing a dated backup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';

const ROOT = import.meta.dirname;
const CONFIG_FILE = path.join(ROOT, 'metis.config.json');
const PORT = Number(process.env.METIS_PORT || 8780);
const HOME = os.homedir();
const say = (s) => console.log(s);
const fail = (s) => { console.error('FAIL  ' + s); process.exit(2); };

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };

// ---------------------------------------------------------------- node version
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 20 || (maj === 20 && min < 11)) {
  fail(`Node ${process.versions.node} is too old: import.meta.dirname needs >= 20.11.`);
}
say(`ok    node ${process.versions.node}`);

// ---------------------------------------------------------------- config file
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }

const wantVault = opt('vault');
const wantProjects = opt('projects');
if (wantVault) cfg.vault = wantVault.replace(/\\/g, '/');
if (wantProjects) cfg.projects = wantProjects.replace(/\\/g, '/');

const vault = process.env.METIS_VAULT || cfg.vault || 'C:/AI/Brain';
if (flag('seed')) {
  const have = fs.existsSync(vault)
    ? fs.readdirSync(vault, { recursive: true }).filter((f) => String(f).endsWith('.md')).length
    : 0;
  if (have > 0) {
    say(`ok    seed skipped: vault already has ${have} markdown files`);
  } else {
    const seedDir = path.join(ROOT, 'seed');
    if (!fs.existsSync(seedDir)) fail(`seed folder missing from the repo: ${seedDir}`);
    fs.mkdirSync(vault, { recursive: true });
    const notes = fs.readdirSync(seedDir).filter((f) => f.endsWith('.md'));
    for (const f of notes) fs.copyFileSync(path.join(seedDir, f), path.join(vault, f));
    say(`done  seeded starter vault at ${vault} (${notes.length} notes)`);
  }
}
if (!fs.existsSync(vault)) {
  fail(`vault not found: ${vault}\n      pass --vault <dir> pointing at a folder of markdown notes,\n      or add --seed to create a starter vault there.`);
}
const mdCount = fs.readdirSync(vault, { recursive: true }).filter((f) => String(f).endsWith('.md')).length;
if (mdCount === 0) fail(`vault at ${vault} contains no .md files. Add --seed to create starter notes there.`);
say(`ok    vault ${vault} (${mdCount} markdown files)`);

const projects = process.env.METIS_PROJECTS || cfg.projects || path.join(HOME, '.claude', 'projects').replace(/\\/g, '/');
say(fs.existsSync(projects)
  ? `ok    transcripts ${projects}`
  : `note  transcripts dir does not exist yet (${projects}) — the graph runs without live recall until an agent session writes one`);

if (wantVault || wantProjects || !fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  say(`done  wrote ${path.basename(CONFIG_FILE)}`);
} else {
  say('ok    metis.config.json unchanged');
}

// ---------------------------------------------------------------- hooks
if (flag('hooks')) {
  const settingsPath = path.join(HOME, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    say(`skip  hooks: ${settingsPath} does not exist (is Claude Code installed?)`);
  } else {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    let settings;
    try { settings = JSON.parse(raw); } catch { fail(`hooks: ${settingsPath} is not valid JSON — fix it before setup touches it.`); }
    const stamp = new Date().toISOString().slice(0, 10);
    const backup = `${settingsPath}.pre-metis-setup-${stamp}`;
    if (!fs.existsSync(backup)) { fs.writeFileSync(backup, raw); say(`done  backup ${path.basename(backup)}`); }

    const tool = (f) => `node "${path.join(ROOT, 'tools', f).replace(/\\/g, '/')}"`;
    const wanted = [
      ['SessionStart', { hooks: [{ type: 'command', command: tool('session-hook.mjs'), timeout: 8, statusMessage: 'Attaching Metis to this session...' }] }],
      ['PreToolUse', { matcher: 'Read|Edit|Write|NotebookEdit|Grep|Glob|Bash', hooks: [{ type: 'command', command: tool('fs-hook.mjs'), timeout: 5, statusMessage: 'Recording file access in Metis...' }] }],
      ['UserPromptSubmit', { hooks: [{ type: 'command', command: tool('todo-hook.mjs'), timeout: 5, statusMessage: 'Checking the shared todo list...' }] }],
    ];
    settings.hooks = settings.hooks || {};
    let added = 0;
    for (const [event, entry] of wanted) {
      const groups = settings.hooks[event] = settings.hooks[event] || [];
      const present = groups.some((g) => (g.hooks || []).some((h) => /[\\/](session-hook|fs-hook|todo-hook)\.mjs/.test(h.command || '') && (h.command || '').includes(entry.hooks[0].command.match(/(session-hook|fs-hook|todo-hook)/)[0])));
      if (present) { say(`ok    hook ${event} already registered`); continue; }
      groups.push(entry); added++;
      say(`done  hook ${event} registered`);
    }
    if (added > 0) {
      const out = JSON.stringify(settings, null, 2) + '\n';
      JSON.parse(out); // refuse to write anything unparseable
      fs.writeFileSync(settingsPath, out);
      say(`done  ${added} hook(s) written to settings.json (backup kept)`);
    }
  }
}

// ---------------------------------------------------------------- startup shim (Windows)
if (flag('startup')) {
  if (process.platform !== 'win32') {
    say('skip  --startup is Windows-only');
  } else {
    const startupDir = path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const vbs = path.join(startupDir, 'start-metis.vbs');
    const ps1 = path.join(ROOT, 'tools', 'start-metis.ps1');
    const body = [
      "' start-metis.vbs - bring Metis up at login. Generated by setup.mjs.",
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run "powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File ""${ps1}""", 0, False`,
      'Set WshShell = Nothing', '',
    ].join('\r\n');
    const existing = fs.existsSync(vbs) ? fs.readFileSync(vbs, 'utf8') : '';
    if (existing === body) { say('ok    startup shim already current'); }
    else { fs.writeFileSync(vbs, body); say(`done  startup shim ${existing ? 'updated' : 'installed'}: ${vbs}`); }
  }
}

// ---------------------------------------------------------------- start + verify
function ping(ms) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', timeout: ms }, (res) => {
      resolve(res.statusCode === 200); res.resume();
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const up = await ping(400);
if (flag('status')) {
  say(up ? `ok    server is UP on 127.0.0.1:${PORT}` : `note  server is not running on :${PORT}`);
  process.exit(0);
}
if (flag('start')) {
  if (up) {
    say(`ok    server already up on 127.0.0.1:${PORT}`);
  } else {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    let alive = false;
    for (let i = 0; i < 10 && !alive; i++) { await new Promise((r) => setTimeout(r, 400)); alive = await ping(300); }
    if (!alive) fail(`server did not answer on :${PORT} within 4s — run "node server.mjs" in a terminal to see the error.`);
    say(`done  server started, HTTP 200 on http://127.0.0.1:${PORT}`);
  }
} else if (!up) {
  say(`next  start it: node server.mjs   (or rerun with --start)  ->  http://127.0.0.1:${PORT}`);
}
say('setup complete.');
