// httpjson.mjs — tiny localhost JSON client on node:http.
//
// Not fetch. fetch() is backed by undici, which keeps a pooled socket alive after the
// response resolves; a short-lived CLI or hook that calls process.exit() straight
// afterwards trips a libuv assertion on Windows:
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
//
// Measured here, not theorised: tools/filesearch.mjs printed a correct answer and
// then aborted with exit 127 every run. `agent: false` gives each request its own
// socket and closes it with the response, so the process exits cleanly — which for
// the PreToolUse hook is not cosmetic, since it runs on every single tool call.
//
// It also matches the house pattern: server.mjs is plain node:http, no dependencies.
import http from 'node:http';

const HOST = '127.0.0.1';

function request(method, port, path, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: HOST, port, path, method,
      agent: false,                       // no pool, no lingering handle
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length, Connection: 'close' }
        : { Connection: 'close' },
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: s }));
    });
    req.setTimeout(timeoutMs || 2500, () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, status: 0, text: '', error: String((e && e.message) || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function getJSON(port, path, timeoutMs) {
  const r = await request('GET', port, path, undefined, timeoutMs);
  if (!r.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

export async function getText(port, path, timeoutMs) {
  const r = await request('GET', port, path, undefined, timeoutMs);
  return r.ok ? r.text : null;
}

export async function postJSON(port, path, body, timeoutMs) {
  const r = await request('POST', port, path, body, timeoutMs);
  if (!r.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}
