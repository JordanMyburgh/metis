#!/usr/bin/env node
// metis.mjs — the one file that starts and stops the whole programme.
//
//   node metis.mjs start      start the server (detached), verify HTTP 200
//   node metis.mjs stop       graceful shutdown via POST /api/shutdown; on Windows
//                             also closes the Metis app window if one is open
//   node metis.mjs restart    stop then start
//   node metis.mjs status     is it up, what is it following, node counts
//   node metis.mjs app        (Windows) open the installed PWA window as well
//
// Port comes from METIS_PORT (default 8780), same as the server. This file only
// talks HTTP + spawns; all configuration lives in setup.mjs / metis.config.json.
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.METIS_PORT || 8780);
const cmd = (process.argv[2] || '').toLowerCase();
const say = (s) => console.log(s);

function req(method, p, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve({ code: res.statusCode, data: JSON.parse(body || '{}') }); } catch { resolve({ code: res.statusCode, data: {} }); } });
    });
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.on('error', () => resolve(null));
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
  if (await req('GET', '/api/status')) { say(`ok    already up on http://127.0.0.1:${PORT}`); return true; }
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    if (await req('GET', '/api/status', 500)) { say(`done  server up on http://127.0.0.1:${PORT}`); return true; }
  }
  say(`FAIL  server did not answer on :${PORT} within 5s — run "node server.mjs" in a terminal to see why`);
  return false;
}

function closeAppWindow() {
  // Best-effort, Windows only: close the PWA window titled 'Metis…'. CloseMainWindow
  // is a polite WM_CLOSE, never a process kill — other browser windows are untouched.
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      "$p = Get-Process brave,chrome,msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'Metis*' }; if ($p) { $null = $p.CloseMainWindow(); 'closed' } else { 'none' }"],
      { timeout: 8000, windowsHide: true }, (err, out) => resolve(!err && String(out).includes('closed')));
  });
}

async function stop() {
  const r = await req('POST', '/api/shutdown');
  if (!r) { say(`ok    nothing listening on :${PORT}`); }
  else {
    for (let i = 0; i < 10 && await req('GET', '/api/status', 400); i++) await sleep(300);
    say((await req('GET', '/api/status', 400)) ? `FAIL  server still answering on :${PORT}` : 'done  server stopped');
  }
  if (await closeAppWindow()) say('done  app window closed');
  return true;
}

async function status() {
  const r = await req('GET', '/api/status');
  if (!r) { say(`down  nothing on http://127.0.0.1:${PORT}`); return; }
  const d = r.data;
  say(`up    http://127.0.0.1:${PORT}`);
  say(`      clients ${d.clients} | pinned ${d.pinned ? 'yes' : 'no'} | following ${d.live ? path.basename(String(d.live)).slice(0, 16) : 'nothing'}`);
  if (d.counts) say(`      islands ${Object.entries(d.counts).map(([k, v]) => `${k}:${v}`).join(' ')}`);
}

function openApp() {
  if (process.platform !== 'win32') { say('skip  app window launch is Windows-only; open the URL in a browser'); return; }
  const ps1 = path.join(ROOT, 'tools', 'start-metis.ps1');
  const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Front'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  say('done  app launch handed to tools/start-metis.ps1 (window in front)');
}

switch (cmd) {
  case 'start': await start(); break;
  case 'stop': await stop(); break;
  case 'restart': await stop(); await start(); break;
  case 'status': await status(); break;
  case 'app': if (await start()) openApp(); break;
  default:
    say('usage: node metis.mjs start | stop | restart | status | app');
    process.exit(cmd ? 2 : 0);
}
