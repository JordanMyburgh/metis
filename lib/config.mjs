// config.mjs — machine-local settings, added 2026-08-26 so a clone can run anywhere.
// Precedence per value: environment variable > metis.config.json (repo root, gitignored,
// written by setup.mjs) > default. The defaults reproduce the original hardcoded values
// on the machine Metis was built on, so an unconfigured checkout behaves exactly as
// before this file existed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const CONFIG_FILE = path.join(ROOT, 'metis.config.json');

let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* absent = defaults */ }

const HOME_DIR = os.homedir().replace(/\\/g, '/');

function pick(envName, key, dflt) {
  const v = process.env[envName] || fileCfg[key] || dflt;
  return String(v).replace(/\\/g, '/').replace(/\/+$/, '');
}

// The vault of markdown notes the graph renders.
export const VAULT = pick('METIS_VAULT', 'vault', 'C:/AI/Brain');
// Where the agent's session transcripts live (Claude Code's projects dir).
export const PROJECTS = pick('METIS_PROJECTS', 'projects', `${HOME_DIR}/.claude/projects`);
// The user's home directory, used by the systems view.
export const HOME = pick('METIS_HOME', 'home', HOME_DIR);
// Optional: local model notes rendered as satellite nodes. Absent dir = empty, by design.
export const MODELVAULT = pick('METIS_MODELVAULT', 'modelVault', 'C:/AI/ModelVault');
// Roots the FileSystem lens accepts, ';'-separated.
export const FS_ROOTS = pick('METIS_FS_ROOTS', 'fsRoots', `C:/AI;${HOME_DIR}/.claude`);
