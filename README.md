<p align="center">
  <img src="media/metis-title.svg" alt="METIS" width="560">
</p>

<p align="center"><b>A live, local window onto a markdown knowledge vault — and onto the AI agent working in it.</b></p>

Setup: see [SETUP.md](SETUP.md) — three commands by hand, or one paste into Claude Code.
Control: `node metis.mjs start | stop | restart | status | app` — the whole programme, one file.

A Node.js server (no framework, no database, no cloud) watches two things: a folder of
markdown notes with YAML frontmatter, and the session transcripts of a coding agent
(Claude Code). A browser GUI renders the vault as a 3D force-directed graph and lights up
each note the agent reads, in the order it reads them, while it works. A desk panel adds
notes, a focus timer, a schedule, and a todo list that both the human and the agent write.

Everything runs on `127.0.0.1:8780`, localhost only, by design.

## What is in here

| Area | Files | Job |
|---|---|---|
| Server | `server.mjs` | HTTP + SSE fan-out, search, replay, static serving |
| Indexing | `lib/vault-index.mjs`, `lib/search-index.mjs` | vault → `{nodes, links}` graph; ranked full-text search |
| Live following | `lib/recall.mjs`, `lib/activity.mjs` | tail the agent's transcript → per-note touch events; when each note was added/updated/accessed |
| Layout | `lib/layout.mjs` | 3D force layout, computed once and frozen so the map never reshuffles |
| FileSystem lens | `lib/fsgraph.mjs`, `lib/fslog.mjs`, `tools/fs-hook.mjs` | a second graph of every file path any tool touches, plus a diagnostic access log |
| Desk | `lib/desk.mjs`, `tools/todo-hook.mjs` | server-side desk state; shared todo list injected into new agent sessions |
| Session wiring | `tools/session-hook.mjs` | agent lifecycle hook: attaches each new session's transcript to the graph |
| GUI | `web/` | the app — canvas, chronicle ribbon, desk, installable as a PWA |
| Probes | `tools/probe-*.mjs` | headless render/behaviour checks that run the real drawing code |

`PROJECT.md` carries the architecture, the design decisions and their reasons, and the
phase-by-phase build log with verification evidence.

## Running it

```
node server.mjs
```

then open `http://127.0.0.1:8780`. The vault path and agent-hook wiring are documented in
`PROJECT.md`; the lifecycle hooks (`tools/session-hook.mjs`, `tools/fs-hook.mjs`,
`tools/todo-hook.mjs`) register in the agent's settings and fail soft — a dead server
never breaks the session riding on it.

## Privacy by construction

All personal state is user-local and never ships: desk contents, transcripts, access
logs, layout caches, and the curriculum file (`data/roadmap.json`) are gitignored. This
repository is a code snapshot published at the project's promotion to production; the
development history stays local.
