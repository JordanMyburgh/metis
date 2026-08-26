# Setting up Metis

Zero dependencies. One requirement to run: **Node.js 20.11 or newer** (`import.meta.dirname`).
Getting the code needs `git` — or grab the repo as a zip; the server runs fine without
git (vault-activity colouring just falls back to file times).

## Quickstart (human)

```
git clone https://github.com/JordanMyburgh/metis
cd metis
node setup.mjs --vault "C:\path\to\your\markdown\vault" --start
```

Open `http://127.0.0.1:8780`. That is a working Metis: the graph renders your vault.

Day-to-day control is one file: `node metis.mjs start | stop | restart | status | app`
(`stop` shuts the server down gracefully and closes the app window; `app` opens the
installed PWA window).
As run above, the server lives until shutdown — `--startup` and `--hooks` are what make
it permanent (start at login + any new Claude Code session restarts a dead server).

No vault yet? Point `--vault` where you want one and add `--seed` — setup creates the
folder with four starter notes. It never seeds into a folder that already has notes.

Optional integrations, each idempotent and re-runnable:

| Flag | What it does |
|---|---|
| `--seed` | Creates the vault folder with four starter notes when it is missing or has no `.md` files (a vault with notes is left untouched) |
| `--hooks` | Registers the 3 Claude Code lifecycle hooks in `~/.claude/settings.json` (dated backup written first; only missing entries are appended) |
| `--startup` | Windows: installs a Startup shim so Metis starts at login |
| `--status` | Prints what is configured and whether the server is up |

Configuration precedence per value: env var (`METIS_VAULT`, `METIS_PROJECTS`,
`METIS_HOME`, `METIS_MODELVAULT`, `METIS_FS_ROOTS`, `METIS_PORT`) →
`metis.config.json` (written by setup, gitignored) → defaults.

## One-shot prompt (agent)

Paste this into Claude Code on the target machine, fill the four fields at the bottom first:

```
Set up Metis (github.com/JordanMyburgh/metis) on this machine and prove it works.

Starting state: Metis is not installed. Node.js may or may not be present. My markdown
note vault is at [VAULT_PATH] - it may not exist yet.

Target state: the Metis server runs on http://127.0.0.1:8780, rendering that vault as a
live graph, and /api/status returns HTTP 200.

Do these in order:
1. Verify `node --version` is 20.11 or newer and `git --version` runs. If either is
   missing (or node is too old), STOP and give me the install commands for my OS - do
   not install them yourself.
2. git clone https://github.com/JordanMyburgh/metis into [INSTALL_DIR].
3. Read README.md and SETUP.md in the clone before running anything.
4. Run: node setup.mjs --vault "[VAULT_PATH]" --start
   Add --seed to that command if [VAULT_PATH] does not exist or has no .md files -
   it creates the folder with four starter notes.
5. Verify /api/status returns HTTP 200 and report the note count it indexed.
6. Only if "hooks" is yes below: rerun setup.mjs with --hooks, then show me the path of
   the settings.json backup it created and exactly which hook entries it added.
7. Only if "startup" is yes below (Windows only): rerun setup.mjs with --startup.

Rules:
- MUST NOT edit any file inside the cloned repo - configuration goes through setup.mjs
  flags only.
- MUST NOT touch ~/.claude/settings.json except via setup.mjs --hooks.
- MUST NOT install any npm package - Metis has zero dependencies by design; if
  something appears to need one, stop and report it instead.
- NEVER expose the server beyond 127.0.0.1.
- Stop and ask before deleting or overwriting any existing file.

Done when: /api/status is HTTP 200, http://127.0.0.1:8780 loads the graph, and you have
reported node version, vault path, indexed note count, and which optional integrations
were installed.

Permanence: yes/yes = Metis survives reboot (starts at login; any new Claude Code
session restarts a dead server). no/no = runs until shutdown, then stays down.

hooks: [yes/no]
startup: [yes/no]
[VAULT_PATH]: [absolute path to your markdown vault - or where you want one created]
[INSTALL_DIR]: [absolute path where the repo should live]
```

## Troubleshooting

- **Port already in use** — something else owns 8780: set `METIS_PORT` and rerun.
- **Blank graph** — the vault path has no `.md` files; setup refuses this up front.
  Rerun with `--seed` to start from the four starter notes.
- **No live recall** — normal until an agent session writes a transcript under the
  projects dir; the graph itself works without it.
- **Hooks registered but nothing attaches** — hooks fire on NEW sessions only; start a
  fresh Claude Code session after `--hooks`.
