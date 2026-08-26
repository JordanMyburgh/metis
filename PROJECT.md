# Metis — Build (promoted from Lab 2026-08-26)

**PROMOTED 2026-08-26 on Jordan's call ("Metis is a done project"):** moved `C:\AI\Lab\metis` → `C:\AI\Build\metis`. Stable base, live daily via three settings.json hooks + the filesearch skill; further work is features on a promoted system, not experiments. All hook/skill/launch references updated the same day; server verified back up on :8780 from the new path.

Live 3D view of the Brain vault, with **recall visualisation** (which notes Claude touched, in what order) and a **native vault search** (`/api/search`, ranked hits instead of raw grep lines) whose results fire the same visualisation. The embedded Claude chat described below in the design-decisions section was removed 2026-08-22 — see `knowledge/infra/metis.md` in the vault, "The GUI has no chat".

Ground-up rebuild, decided 2026-08-22. Supersedes nothing — `brain-viewer` (Lab #1, promoted to Build, running on :8890) stays untouched and keeps working.

## Why rebuild rather than extend brain-viewer

`brain-viewer` is architecturally a *viewer*: index → `graph.json` → 34-line static file server. Metis is a live *instrument* — streaming events, a persistent subprocess, stateful recall replay. Bolting that onto a static server is more awkward than starting clean, and brain-viewer is already promoted to Build and auto-starts at login via a script on the do-not-touch list.

**Carried over, not rewritten:** `lib/vault-index.mjs` is `brain-viewer/indexer.mjs` — it had already solved frontmatter parsing, id-vs-filename-stem resolution and phantom nodes for unwritten wikilinks. Changes: exports `buildGraph()` instead of writing a file, and adds `resolvePath()` (file path → node id) which recall needs.

## Layout

| File | Job |
|---|---|
| `server.mjs` | http on **:8780**, 127.0.0.1 only. SSE fan-out, search, replay, reindex, static. |
| `lib/vault-index.mjs` | vault → `{nodes, links}` + path resolver |
| `lib/layout.mjs` | 3D force layout, **computed once and frozen** to `.layout-cache.json` |
| `lib/recall.mjs` | tails the live session transcript → vault-touch events; also replays past ones |
| `lib/activity.mjs` | **when** each note was added / updated / accessed — git, mtime and the recall ledger |
| `lib/search-index.mjs` | ranked full-text index over the vault (title/id/alias/tag/heading/body, weighted); zero deps |
| `lib/desk.mjs` | the **desk** — the shared todo list, scratch notes, the focus timer, the schedule. State machine only; the server owns the transport |
| `tools/todo-hook.mjs` | `UserPromptSubmit` — re-injects the shared todo list, but only when its `rev` moved |
| `web/index.html` | the app — canvas, chronicle ribbon, key panel, legend, pose readout. (v1 deleted 2026-08-22; `/v2.html` aliases here) |
| `tools/probe.mjs` | CLI sanity check for index + recall extraction |
| `tools/probe-chronicle.mjs` | CLI sanity check for the chronicle ribbon — runs the real draw code headlessly |
| `tools/search.mjs` | CLI for `/api/search` — `node tools/search.mjs <query> [--limit N] [--group G] [--tag T]` |
| `lib/fsgraph.mjs` | the **FileSystem tree** — path normalising, node creation, LRU eviction, equal-area radial layout, ASCII + Mermaid |
| `lib/fslog.mjs` | the file-access diagnostic log — fixed schema, rotation, spool drain, table formatting |
| `lib/httpjson.mjs` | localhost JSON over `node:http` (**not** fetch — see the fs section) |
| `tools/filesearch.mjs` | the FileSearch executable: the lookup ladder, logging, graph update |
| `tools/fs-hook.mjs` | `PreToolUse` capture — every path any tool touches; never blocks, never fails, never loses a line |
| `tools/fs-report.mjs` | `graph` / `log` / `stats` in a terminal; works with Metis down |
| `tools/probe-fsgraph.mjs` | headless render check for the tree — 21 assertions across 4 window sizes |
| `tools/probe-categories.mjs` | headless render check for the **category networks** — 17 assertions: framing, gateways, routing, cluster separation, link colour |
| `tools/start-metis.ps1` | login bring-up: server if the port is dead, then the PWA maximised and sent to the back of the z-order |

Ports on this machine: **8770** aether2, **8890** brain-viewer, **8780** metis.

## Three design decisions

**1. Transcript, not a settings.json hook.** The session JSONL is appended live and already contains every `tool_use` with inputs. So recall works with **zero config changes** and cannot break the aether2/gitnexus hooks. A `PreToolUse` hook would only cut ~1s of latency; it stays as a later upgrade, not a dependency.
> **Partly reversed 2026-08-23.** True for *vault recall*, which the transcript already carried. Not true for the FileSystem tree: the transcript has no reason field and no node for a non-vault path, so a `PreToolUse` hook was added for **coverage**, not speed. Registered as a second entry alongside gitnexus's, never replacing it.

**2. Layout frozen after one run.** Obsidian re-simulates every load, so the map moves under you. aether2 deliberately doesn't (`galaxy/layout.ts`: *"stable across reloads so the galaxy doesn't reshuffle"*). Metis runs the sim once, caches positions keyed by a hash of the graph shape, and recomputes only when notes/links change — organic clustering **and** spatial memory.

**3. Chat is a transport, not a wrapper.** No system prompt, no preamble, no re-injected context; one long-lived process with stdin held open; on crash, respawn with `--resume <session_id>`. Talking through the GUI costs exactly what talking in the terminal costs.
> Measured on this machine: a **cold start is $0.2415** for a one-word reply — almost entirely prefix. Avoiding a second one is the module's whole job.

## Phase log

| Phase | Status | Evidence |
|---|---|---|
| 1 prototype — index, layout, recall, chat, server, UI | DONE 2026-08-22 | see verification below |
| 2 refine — chronicle ribbon (added/updated/accessed) | DONE 2026-08-22 | `probe-chronicle.mjs` → 14/14 PASS |
| 2 refine — native search (`/api/search`, `tools/search.mjs`), search-driven firing | DONE 2026-08-23 | ranked hits verified against real queries; SSE `touch` with `tool:'search'` confirmed live, no `backfill` flag; ~7KB raw-grep-lines vs ~1KB ranked-hits measured on the same query |
| 2 refine — **FileSystem tree + FileSearch + access log** | DONE 2026-08-23 | `probe-fsgraph.mjs` → 21/21 across 4 sizes; real-Chrome screenshot; cap swept and chosen on numbers |
| 2 refine — **category networks, routed flare, coloured links, login bring-up** | DONE 2026-08-23 | `probe-categories.mjs` → 17/17; cold-start bring-up verified from the Startup `.vbs` |
| 2 refine — **the desk: notes, focus timer, schedule** | DONE 2026-08-23 | `.desk.json` round-trips notes + a 60m session across a reload; `POST /api/focus/start` from a terminal lit the panel over SSE |
| 2 refine — **USED-ONLY filter** (`used` / u) | DONE 2026-08-23 | 337 nodes, 13 touched, 16 shown, 321 culled (95.3%) via the `data-touched`/`data-shown` seam |
| 2 refine — **shared todo list** + both injection channels | DONE 2026-08-24 | UTF-8 round-trip verified (2 em dashes, 0 U+FFFD); hook silent → injects on `rev` change → silent, exit 0, stderr empty, 0.18s |
| 2 refine — **session picker accuracy** + per-session USED | DONE 2026-08-24 | 289 files on disk → 76 real conversations listed, by title; `/api/session-touches` drove a 317-of-342 cull in the GUI |
| 2 refine — node click-through, remaining filters | TODO | |
| 3 test | PARTIAL | recall verified; chat verified at CLI + one GUI round-trip |
| promote → `C:\AI\Build` | DONE 2026-08-26 | Jordan's call ("a done project"); the two open phase-2 rows above become feature work on the promoted system |

## Verified 2026-08-22 (measured, not assumed)

- `node tools/probe.mjs` → graph **100 nodes (86 real, 14 phantom), 271 links**; resolver maps all 4 vault path forms and correctly rejects non-vault paths.
- Server boots: layout computed, `maxRadius 239` (inside the 680 focal depth — no camera-plane crossing).
- Browser: **no console errors**; graph/SSE/live-session/legend/40-session picker all populate.
- Live transcript auto-detected as the running session.
- **Replay of `f5561a07` → 17 touch events**, matching the probe's independent count. Feed shows real notes (`proxmox`, `proxmox-hardware`, `iscsi-games-drive`).
- Canvas render sampled directly: **3,860 painted samples**, bbox 702×453, centred within 43px of a 1634×1393 backing store. Flare/trail painting confirmed by **6,288 cyan pixels** during replay.
- Chat transport proven separately at the CLI (`PONG`, exit 0, session id + cost telemetry captured).

### Screenshot paste — verified 2026-08-22

- `node tools/probe-image.mjs` → **PASS**. This was the load-bearing unknown: nothing in `--help`
  says `--input-format stream-json` takes image blocks. The probe encodes a solid-magenta PNG from
  scratch (no deps), sends it as `{type:'image',source:{type:'base64',...}}` down the same stdin
  ChatBridge uses, and asks for the colour. Answer: **"Magenta"** — accepted *and* actually seen.
- End-to-end through the GUI on a throwaway instance (`METIS_PORT=8781`, so the live 8780 session
  was never disturbed): synthetic clipboard paste → thumbnail staged → send → **model read
  `METIS-OK-7431` off the pasted pixels**.
- **Image-only turns work** (empty caption, 2 images) — model answered `AAA` / `CCC`, one per image,
  confirming order is preserved.
- **Downscale measured**: a 4000×2200 paste lands at **1568×862** (long edge capped, aspect intact).
  Vision downscales past ~1568px anyway, so this is free in fidelity and saves ~8MB of base64 per 4K shot.
- Composer layout re-measured with the strip open: transcript ends 595, ctxtrack 596–599, imgbar
  599–659, barrow 659–699, metarow 700–721 — **no overlap**.
- Error paths return JSON instead of a dead socket: **400** `text or images required` (also when every
  image is filtered out by media-type), **413** `message too large` at the 32MB ceiling. `readBody`
  used to `req.destroy()` on overflow, which surfaced in the browser as a bare "Failed to fetch";
  it now drains and flags so the route can answer. `send()` also checks `r.ok` now — a non-2xx used
  to sail through as success and leave the composer stuck on "sending".

### Chronicle — when a note was added, updated, accessed (2026-08-22)

The graph answers *what connects to what*. It could not answer *when*. The chronicle is a
bottom-docked ribbon with three lanes on one shared time axis — ACCESSED (cyan), UPDATED
(amber), ADDED (green) — plus range buttons (24H / 7D / 30D / ALL) and a red **now** marker.
Toggle with the top-bar button or `c`; the choice is remembered.

**None of the three timestamps is the obvious `stat()` call, and that is the whole point.**

| lane | source | why not the obvious one |
|---|---|---|
| ADDED | first commit that introduced the path (`git log --diff-filter=A`, one pass) | **NOT `birthtime`.** Measured 2026-08-22: `INDEX.md` and `agents/claude-charter.md` are from 10 July, and both reported a birthtime of the minute they were last edited — a rename-based save (`sed -i`, most editors' atomic write) gives the file a brand-new creation time. Git history is the only record that survives an edit. Uncommitted notes have no add commit, so they fall back to mtime and are counted in the header as *n uncommitted*. |
| UPDATED | `mtime` | **NOT the last commit date.** The vault is committed in batches at the end of a write session, so a note edited five minutes ago and not yet committed has still been updated. |
| ACCESSED | Metis's own recall stream, persisted to `.activity-cache.json` | Nothing on disk records this. NTFS last-access updates are off by default on Windows, and if they were on they would count Obsidian's indexer and every grep as a read. `RecallTracker` already extracted "Claude opened this note" — it was throwing it away after 200 events. |

- **Interaction ties the two views together.** Hover a node on the graph → its three marks light
  full-height in the ribbon and the header prints the exact stamps; the hover tooltip gained
  `acc / upd / add` relative times. Hover a bar → the notes behind it. **Click a bar → those notes
  flare on the map**, so a moment in time resolves back to the notes it touched.
- Density is drawn as bars, not one tick per event: at vault scale individual ticks smear into a
  solid block. Focus dims the density to .20 so a single note stays legible against it.
- `fitAll()` now reserves the bottom 116px while the ribbon is open — otherwise `home` parked the
  lowest notes underneath it.
- Island nodes (mcp / skills / tools) have no file, so they get an access time and **nothing else**.
  That is the truth rather than a zero.

**Verified by `node tools/probe-chronicle.mjs` → 14/14 PASS**, against live `/api/activity`:
89 notes, 107 access events, canvas 1252×82, all three lanes drawing inside the plot area,
lane labels present, 7 gridlines, now-marker at x=1245.5 of a 1246px edge, focus on
`claude-charter` drawing its own 3 marks with 15 density bars dimmed, and the range switch
moving the domain 15/08 → 21/08.

Sample of the real data — three genuinely different timestamps for one note, which is exactly
the case birthtime would have got wrong:

```
id                      added             updated           accessed
claude-charter          2026-07-10 13:12  2026-08-22 22:56  2026-08-22 22:55
```

**Why a CLI probe and not a screenshot.** `requestAnimationFrame` is paused while a tab is
hidden, so in the background browser pane both canvases stayed at their pre-layout backing size
(the main canvas measured 1×1) and painted nothing — an rAF probe confirmed zero frames in
600ms. That is a harness property, not an app bug, but it means "it looked right" was not
available. `probe-chronicle.mjs` therefore extracts the **real** module source from
`web/index.html`, runs it against a recording 2D context with a minimal DOM, and asserts what
was drawn. No copy of the drawing code lives in the probe: if `index.html` changes, the probe
tests the change. **The ribbon has not yet been seen by a human eye — that is the one
outstanding check.**

**Bug found and fixed in passing:** `esc()` was called by the `graph_changed` handler
(`add.slice(0,3).map(esc)`) but was never defined anywhere in the file — so every time a note
was added while the GUI was open, the handler threw `ReferenceError` and the "+1 note" message
never appeared. Now defined next to `ev()`.

**Robustness fix found by the same investigation:** the ribbon canvas re-measured only from
inside the rAF loop, so a window resized while the tab was hidden would come back sized for the
old layout. It now also listens on `resize` and carries a `ResizeObserver`, matching `#stage`.

### Known issues / not yet done

- **Browser-pane screenshots capture at the wrong scale** (content appears in a corner). Rendering was verified by sampling canvas pixels instead. Environment quirk, not an app bug — needs confirming in a real browser.
- Chat streams whole assistant messages, not token-by-token. Fine, but not as live as it could be.
- **Recall follows the session the SessionStart hook reports** (pinned by id/path, with retry — the
  transcript does not exist yet when the hook fires). Before pinning it followed newest-mtime, which
  meant whichever session wrote last stole the graph.
- **Every answer reports provenance** (`from metis:` node ids, or an explicit \"nothing — answered from context\").
  \"No lights\" used to be ambiguous between *retrieved nothing* and *recall broken*.
- **No camera rotation.** Orientation is fixed; both mouse buttons pan, wheel zooms, `home`/`h` re-fits.
  `fitAll()` computes zoom+pan from the node bounding box with a 78px margin — verified 0 nodes and
  0 labels offscreen at 1149x1044, 1520x1300, 820x700 and 600x1100.

### Depth pass — 2026-08-23

Jordan: *"a little cluttered... I always want to see all nodes so I can see if you're calling info
correctly. Can we make it more 3D and spread out from this perspective?"* The camera stays fixed —
the answer had to come from the geometry and the ink, not from letting the pose move.

Two root causes, both measurable:

1. **Nothing had depth.** At pitch +PI/2 the depth axis IS world Y, and the islands were deliberately
   near-coplanar in Y (-40 / +26 / +34) so they'd read from any angle. With no Y spread, perspective
   had nothing to work with: the whole scene sat in a 1.59x size band.
2. **The vault shell was a knot.** 130-210 is 75 units thick, and radius was mapped linearly from the
   sim's radius — whose values bunch near p95 — so most of 106 notes landed on the outer rim.

Changes: focal 680 -> 600; shell 130-300 with radius from **rank**, cube-rooted so density is even
through the volume; island clouds scale with population (62 tools no longer share a radius with 12
skills) and sit on a thick shell; islands staggered in depth (tools near, mcp mid, skills far) and
anchored in **screen space** via `atScreen()` rather than raw XYZ; `mcp` and `skills` moved to the
same side so their real peer links stop crossing the map; gateway->host spokes moved to their own
0.09-alpha pass. Renderer: background-coloured **occlusion halo** under every node so near nodes cut
the ones behind them, depth-alpha floor **0.55** (was 0.14), minimum node radius 1.8px, and labels
collected and drawn in one priority pass (flare/hover > gateway > hub) with box-collision rejection.

**Invariant, from Jordan directly: no node is ever culled, filtered or faded out.** The graph is how
he audits which notes I actually read. Only label TEXT yields when it is crowded; the dot never does.

Measured at his window (1529x1112, chronicle open), old vs new:

| | before | after |
|---|---|---|
| vault disk radius | 254px | **393px** |
| vault node spacing (median nearest-neighbour) | 17.3px | **28.8px** |
| tools node spacing (median / min) | 14.8 / 3.8px | **19.6 / 8.1px** |
| near-to-far size range | 1.59x | **2.45x** |
| content bbox aspect | 1.09 (square, wasted the stage's width) | **1.91** |

Re-verified `fitAll()`: **0 nodes offscreen** at 1529x1112, 1430x1011, 1149x1044 and 820x700, with a
28-58px clear gap between the vault disk and the nearest island at every size.
- **Tool, MCP and skill calls flare their own island nodes** (`tools::<Name>`, `mcp::<server>`,
  `skills::<name>`). Connector servers (Gmail, Calendar) are derived from live tool names, so their 37
  tools now have a server node to light. ~~Remaining gap: reads of non-vault files (Lab, Bridge, code) still light nothing.~~ **CLOSED 2026-08-23** by the FileSystem tree.
- **New vault notes appear live.** `fs.watch` on `C:\AI\Brain` (700ms debounce, `.md` only) rebuilds the
  graph and flares the newcomer. `mergeLayout()` keeps every existing position and places only the new
  node at its neighbours' centroid — verified: **0 existing nodes moved** when a note was added.
- Node click-through (open note in Obsidian) not carried over from brain-viewer yet.
- No auth on :8780. It binds 127.0.0.1 only and should stay that way. Since the chat was removed the
  server only ever READS (transcripts, the vault, `.claude.json`) — it no longer drives an agent, so an
  exposed port would be a disclosure problem rather than a remote-code-execution one.
- **Chat tool scope:** the embedded session runs with `--add-dir C:/AI` (override with `METIS_ADD_DIRS`, `;`-separated).
  cwd is `C:\Users\mybur`, so the user profile was always reachable; `C:\AI` was not, and every read of the
  vault/Lab failed. `C:\Gitnexus` is deliberately NOT granted. Not using `bypassPermissions`: this session is
  driven by an HTTP endpoint. This CLI build has no `--permission-prompt-tool` and the stream carries no
  control_request, so an interactive approve/deny UI is not possible — refusals are surfaced as a card instead.
- `launch.json` carries the `metis` entry (port 8780). Backups in `C:\AI\Archive\config-backups\2026-08-22\`:
  `launch.json.bak` (before the entry existed) and `launch.json.pre-metis-rename.bak` (before the cortex->metis rename).
- **Named Metis 2026-08-22** (was `cortex`). The name is a cross-agent contract, not just a label — the vault note
  `C:\AI\Brain\knowledge\infra\metis.md` defines what "add this to Metis" vs "the Metis GUI" resolve to, and
  `~\.claude\CLAUDE.md` + Hermes' MEMORY.md carry the same lines so every agent resolves it identically.

### The chat was removed — 2026-08-22

The right-hand dock embedded its own Claude session. **It is gone**, along with `lib/chat.mjs`,
`/api/chat`, `/api/model` and `/api/models` (all 404 now). It duplicated — worse — what the Claude Code
desktop app already does, and the duplication cost two conversations and two contexts to keep in sync.

**Every Claude Code session is the interface now.** `tools/session-hook.mjs` runs on `SessionStart` and:

1. **injects the standing directive** (consult the vault, cite node ids, write findings back). This is
   the enforcement lever — CLAUDE.md is advisory, a hook fires every time.
2. **POSTs `/api/session`** so the graph follows *that* conversation.
3. **starts Metis if 8780 is dead.** Measured: **598ms** cold (nothing listening -> server up -> session
   attached, no warning emitted), **250ms** when already running. This replaces the Task Scheduler job.

The directive prints on **every** failure path, including the ones where the server never answers. A
dead server degrades the picture, never the rules — "no exceptions" cannot depend on a localhost port.

Registered as a **second** entry in `settings.json`'s SessionStart array. The patch refused to write
unless all 5 pre-existing hooks (2 gitnexus, 3 aether2) survived the diff byte-identically; verified
after: SessionStart holds 2 groups, aether2's first.

**What removing the chat cost, and how it was replaced.** The tools island was fed by the embedded
session's `system`/`init` record. A desktop-app transcript has no such record — measured across 244
transcripts and 19,672 lines: **zero**. So `lib/loadout.mjs` derives the roster from tool calls actually
observed, seeded from history and grown live as new tools get used.

- Seed: **55 tools** from 244 transcripts (~1.5s, cached to `.loadout-cache.json`; boot is instant after).
- **mcp went 4 -> 12.** Connector servers (Gmail, Calendar) only ever appear as `mcp__<uuid>__<tool>`
  tool names and are absent from `.claude.json`, so tool-name derivation is the only thing that can give
  them a node. The island is now *richer* than the chat-fed version.
- `RecallTracker` gained an `onTool` callback that fires for **every** `tool_use`, not just ones that
  light a node. Without it a newly-used tool could never earn its node: no node means no hit, no hit
  means no observation, so the island could only ever show what it already showed.

Verified end-to-end with no chat in the loop: a `Grep` of `C:\AI\Brain\knowledge\infra` lit
`tools::Grep`, its **results** lit `proxmox` / `iscsi-games-drive` / `proxmox-hardware` /
`home-network-gear`, a follow-up `Read` lit `tools::Read` + `proxmox`, and an MCP call lit both
`tools::mcp__Claude_Browser__javascript_tool` and `mcp::Claude_Browser`. Composer, dock and rail are
gone; `#stage` measured **1280px of a 1280px viewport** (was 900), legend back to `right:14px`, zero
console errors. The top bar's cost tag — which only ever showed the embedded chat's spend — became an
**attached / detached** indicator: detached means no hook reported and recall is guessing at newest-wins.

### Installable as a desktop app — verified 2026-08-22

Metis installs as a standalone Windows app (own window, own taskbar icon, no address
bar) through Edge's **⋯ → Apps → Install this site as an app**. No packaging step,
no Electron.

- `web/manifest.webmanifest` — standalone display, `#050508` theme/background so the
  window chrome matches the canvas instead of flashing white on launch.
- **Icons are generated, not drawn**: `node tools/make-icons.mjs` emits 3 SVG + 6 PNG
  from one shared constellation — the app's own subject, a graph. Zero dependencies:
  the PNG path rasterises analytically (signed distance per pixel, 2× supersampled)
  and encodes with a hand-rolled encoder, so it needs neither a browser nor `sharp`.
  Geometry lives in one place, so the maskable/padded/favicon variants cannot drift.
- **Maskable safe zone respected**: Android/Windows crop maskable icons to a circle of
  r=40% (204.8px at 512); the furthest satellite edge lands at **167px**.
- The favicon is a *different* variant on purpose — six nodes turn to mush at 32px, so
  it carries three fat ones. First cut rendered nodes under 2px and read as grey fuzz.
- **MIME map extended** (`.webmanifest`, `.png`, `.ico`). This was load-bearing: the
  static handler falls back to `application/octet-stream`, and Chrome silently ignores
  a manifest served that way — no error, just no install.
- Verified in-browser: manifest fetched as `application/manifest+json`, all 5 declared
  icons decode at their stated sizes, secure context true, 192/512/maskable all present.

**Not shipped: a service worker.** Measured — with manifest, icons and secure context
all in place, `beforeinstallprompt` does **not** fire (Chromium 148, 0 workers), so the
automatic address-bar install button needs one. A network-only worker would satisfy it,
but the embedded browser pane blocks `register()` outright (plain `fetch('/sw.js')`
returns 200/972 bytes; `register()` throws "unknown error when fetching the script"),
so it could not be verified here. Shipping an unverifiable worker that intercepts
navigations on the daily-driver GUI was the worse trade — the Edge menu install works
today without it. Revisit in a real browser if the one-click install is wanted.

### FileSystem tree + FileSearch + access log — 2026-08-23

Jordan's brief: a permanent `FileSystem` root, folder/file nodes created on the fly, folders and
files in different colours, the node being accessed in an accent colour, and a structured log kept
in sync with the graph. Full write-up: `knowledge/infra/metis-filesystem-graph.md` in the vault.

**The brief's one flaw, corrected rather than shipped.** It asked for `FileSearch` as a skill that
is *the only* way to open a file. A skill cannot enforce that — it is markdown loaded into context,
so it is advisory, and Read/Grep/Glob/Bash keep working regardless. Built as two halves instead:
`tools/filesearch.mjs` (intent — the reason, the ladder, fuzzy lookup) and `tools/fs-hook.mjs`
(coverage — a `PreToolUse` hook the harness runs on every tool call, including subagents'). Both
POST `/api/fs/touch`; one writer, one schema.

Measured, not assumed:

- **`fetch` is unusable in a short-lived CLI/hook here.** undici holds a pooled socket past the
  response, so `process.exit()` trips `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
  src\win\async.c` and the tool exits **127** after printing a correct answer. Every lookup did it.
  `lib/httpjson.mjs` is plain `node:http` with `agent:false`. Mattered most for the hook — it runs
  on every tool call.
- **`rg` here is a bash function, not a binary** (Claude Code's shim re-enters `claude.exe` with
  `ARGV0=rg`); `spawnSync` gets ENOENT and `where.exe rg` finds nothing. Resolved at runtime
  (`$METIS_RG` -> PATH -> VS Code's vendored copy, discovered because it lives under a build-hash
  folder) and cached to `.rg-path.json`. `fd` is absent. **Worth installing properly:
  `winget install BurntSushi.ripgrep.MSVC`.**
- **Ladder order must follow query shape.** The vault index answers *which note is ABOUT x*;
  ripgrep answers *where is the FILE x*. `make-icons` with the index first resolved to
  `knowledge/infra/metis.md` — correct topic answer, useless file answer. No whitespace ->
  ripgrep first; a phrase -> index first. An existing concrete path short-circuits to `direct`.
- **A plain sunburst crowds**: every node of a depth on one ring, and a file tree is bottom-heavy —
  240 nodes gave a median nearest-neighbour gap of **7px, min 1px**. Fixed with **equal-area rings**
  (`r(d) = R*sqrt(nodes at depth <= d / total)`, the vault shell's rank trick) plus radial banding:
  **14-15px median, 0 coincident**. Blending an equal arc share per child was tried and measured
  *worse* (8px -> 4px) — it starves exactly the crowded folders where most nodes live.
- **Anchored at depth +90 the whole tree clamped to the 0.55 depth-alpha floor** and read dimmer
  than every island, with the depth lift buying nothing. Moved to **-60** (spans 0.70-0.80). Caught
  on a real Chrome screenshot, not by reading the code.
- **Cap 120 nodes** (`METIS_FS_MAX`), evicting cold *files* only — never a folder with children,
  never the root, every eviction logged. Swept at 1529x1112: 80 -> 16px gap / -0% vault disk,
  **120 -> 14px / -3%**, 160 -> 14px / -5%, 240 -> 11px / -11%. 120 keeps the vault disk at the
  ~392px the 2026-08-23 depth pass grew it to. The log holds the long tail; the map need not.

`node tools/probe-fsgraph.mjs` -> **21/21** at 1529x1112, 1430x1011, 1149x1044, 820x700: 0 nodes
offscreen, tree clear of the vault disk, every child outboard of its parent, no coincident nodes.
Confirmed visually in a real Chrome: blue folders, green files, amber accent on `server.mjs`, cyan
access trail arriving.

Found in passing, unrelated: **`C:\AI\Handoff\README.md` does not exist** though the charter
references it — the tree flagged it dim-brown for "requested but not on disk".

## Run it

```
node C:\AI\Lab\metis\server.mjs      # then open http://127.0.0.1:8780
node C:\AI\Lab\metis\tools\probe.mjs # CLI sanity check, no server needed
node C:\AI\Lab\metis\tools\probe-chronicle.mjs # chronicle ribbon (needs the server up)
node C:\AI\Lab\metis\tools\probe-image.mjs # does stream-json stdin accept image blocks?
node C:\AI\Lab\metis\tools\make-icons.mjs  # regenerate every app icon (svg + png)
node C:\AI\Lab\metis\tools\probe-fsgraph.mjs  # FileSystem tree render check (server up)

# FileSearch — the only official file lookup. --why/--trigger are what no hook can infer:
node C:\AI\Lab\metis\tools\filesearch.mjs "<path or query>" --trigger user-message --why "..."
node C:\AI\Lab\metis\tools\fs-report.mjs graph           # ASCII tree (--format mermaid|json)
node C:\AI\Lab\metis\tools\fs-report.mjs log --limit 25  # access log as a table
node C:\AI\Lab\metis\tools\fs-report.mjs stats

# The SessionStart hook, run by hand (normally settings.json fires it):
echo {"session_id":"x","transcript_path":"<path>"} | node C:\AI\Lab\metis\tools\session-hook.mjs
```

### Models tab — local VRAM control (2026-08-25)

`m` / the `models` toolbar button opens a right-rail panel that shares the roadmap's
slot (they toggle like tabs — different-day questions, never read together). Live
proxy over Ollama's native API via `lib/models.mjs`: every installed model, which are
resident, VRAM vs CPU spill per model (spill rows go red), plus an nvidia-smi card
bar with a red line at 90%. Buttons: **unload** (keep_alive 0 — frees VRAM now, disk
untouched) and **warm** (pre-load ~5 min). Install/delete deliberately stay in the
terminal. Routes: GET `/api/models`, POST `/api/models/unload|load`. Polls 5 s only
while open. Purpose: the Hermes fallback lane (`qwen3-4b-64k`) can grab the card at
any moment; this is the kill switch so daytime building keeps the VRAM.

Verified 2026-08-25: API round trip (warm qwen3:0.6b → loaded 2.7 GB → unload →
gone), panel renders 13 models + card bar, tab exclusivity with roadmap, no console
errors.

### Models island — residency on the graph (2026-08-25)

Local models are now a first-class island (magenta, 12-1 o'clock, gateway + one node
per installed model) alongside mcp/skills/tools/fs. Membership comes from an awaited
Ollama snapshot at boot (island absent if Ollama is down; back on /api/reindex);
RESIDENCY is a client overlay: the server polls every 5 s and broadcasts a 'models'
SSE frame only when the loaded set or its VRAM split changes. A newly loaded model
fires a pulse core → MODELS → node and then holds a steady magenta glow with its
label pinned; unload drops it dark with a ticker line. LIVEM (a Set beside `flare`)
is the state carrier — a flare answers "what was just touched", LIVEM answers "what
is on the GPU", so it holds instead of decaying.

Debug note for posterity: ev() ticker lines self-remove after 11 s — checking for
one later than that "proves" a working feature broken. Verified with tight timing:
"model loaded qwen3:0.6b 2.5 GB VRAM" observed in #hud within the window, SSE frame
confirmed both at the server (curl listener) and inside the page (probe EventSource).

### Moons — per-model query attribution + vault write-guard (2026-08-25)

Jordan's model: Claude's graph is Earth, each model is a MOON. Three changes:

1. **Attribution.** The hermes plugin stamps every shim line with the serving model;
   a dedicated watcher in server.mjs tails `.hermes-transcripts\` independently of
   the main tracker and broadcasts touches with `origin: models::<model>`. The GUI
   fires the pulse FROM that moon (magenta), flares the moon while its model works,
   names the model in the ticker, and leaves the core heartbeat alone — Earth's
   pulse is Claude's only. Hermes registrations no longer steal the graph pin. A
   cloud model seen working earns a moon on first sighting (`stealth/ox-alpha` was
   the first). Island pushed further out + wider (atScreen 165,-345 r95) — a moon
   reads as a moon only with space around it.
2. **Watcher one-shot bug (found by test, not review).** Seek-to-end on every file
   switch skipped `-z` sessions entirely: a one-shot writes its first tool lines in
   the same flush that CREATES the file. Fix: seek-to-end only at watcher startup;
   a file that appears while watching reads from byte 0. Verified after fix:
   page-level capture shows the origin frame AND the rendered HUD line
   "stealth/ox-alpha ▸ read_file → INDEX".
3. **Vault write-guard.** The vault is READ-ONLY for models (Jordan's rule): the
   plugin's `pre_tool_call` hook vetoes write-shaped tools + write-flavoured
   terminal commands that mention C:\AI\Brain; the refusal message redirects to
   the model's own store `C:\AI\ModelVault\<model>\`. Verified: commanded vault
   write blocked verbatim (no file, git clean); vault read + ModelVault write both
   passed (`ModelVault\ox-alpha\notes\ollama-vault-summary.md`).

### Moon ring + ModelVault satellites (2026-08-25, draft by design)

The models left their island: 14 moons on an ORBITAL RING (screen r=545, outside
everything), each tethered to the core by one faint line, labels always on (kind
'moon' gets gateway label priority). Each moon carries its ModelVault notes as
satellite nodes just outside the ring (`mv::<folder>/<rel>`), scanned fresh from
C:\AI\ModelVault on every systems rebuild. A ModelVault FOLDER alone earns a moon —
proof the model existed — which is how ox-alpha survives server restarts even though
remoteSeen is in-memory. One suffix-tolerant nameMatches() (exported from
systems.mjs) bridges the three loose spellings of a model name: shim stamp
(stealth/ox-alpha), folder (ox-alpha), ollama tag (qwen3-4b-64k:latest); the
hermes-watcher resolves each touch to an existing moon through it.

Call-lines: MOONL map in app.js — persistent faint magenta chords moon -> every
node that model touched this session. Deliberately straight (the routed pulse shows
the journey; this layer shows the SET) and deliberately not decaying: it is the
diagnosis layer, cleared on reload; the shim transcripts stay the durable record.

Jordan's framing, verbatim intent: draft until better hardware; exists so "when I
do use a model we can see whats being used and dignose what it did."

Verified: 14 moons at exactly r=545, satellite at 581, core tethers 13+1, old
models::gateway gone; live run resolved shim stamp stealth/ox-alpha to the
folder-born moon (frame origin models::ox-alpha) and rendered the hud line; zero JS
errors. NOT visually verified (pane hidden, no screenshot): the ring aesthetics and
the call-line chords — code path exercised via the same touch branch.

### Ring gaps (2026-08-25) — moons never sit inside another network

Jordan: "make it so the moons don't sit in the middle of a clustered network."
The orbit keeps its single radius but is no longer uniform: exclusion arcs are
DERIVED from the ISLANDS constants themselves — each island blocks its bearing
+- the angle its cloud subtends from centre (atScreen now returns its screen-space
inputs to make that computable), the fs fan gets a wide fixed gap — and moons are
distributed evenly over the free arcs only. Move an island and its gap moves with
it. Verified numerically: 14 moon bearings vs 4 blocked arcs, zero overlaps
(fs 38-158deg holds moons at 30 and 173; tools 337-15deg holds 330 and 19).
counts.models now counts moons (14), not installed models (13) — the map line
should describe the map.

**CV-gate 2026-08-26: scored 11/14 (headline) on the vault rubric. Learning doc: Brain reports/2026-08-26-metis-learning-doc.md.**
