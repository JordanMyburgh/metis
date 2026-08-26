// vault-index.mjs — walk the Brain vault, build {nodes, links} in memory.
//
// Parsing logic (frontmatter, id-vs-stem resolution, phantom nodes for unwritten
// wikilinks) is carried over from Lab project #1 `brain-viewer/indexer.mjs`, which
// was already tested against the real vault. Changes here vs that file:
//   - exports buildGraph() instead of writing graph.json to disk
//   - adds resolvePath(): absolute/relative file path -> node id, which the recall
//     tracker needs to map "Claude read this file" back onto a graph node
import fs from 'node:fs';
import path from 'node:path';
import { VAULT } from './config.mjs';

export { VAULT };
const IGNORE_DIRS = new Set(['.git', '.obsidian', '_assets', 'node_modules']);

const GROUP_OF = (rel) => {
  const top = rel.split('/')[0];
  if (top === 'journal' || top === 'reports') return 'output';
  if (['knowledge', 'projects', 'decisions', 'library', 'agents', 'feedback'].includes(top)) return top;
  return 'root';
};

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) walk(path.join(dir, e.name), acc); }
    else if (e.name.endsWith('.md')) acc.push(path.join(dir, e.name));
  }
  return acc;
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^\[/, '').replace(/\]$/, '').trim();
  }
  return fm;
}

export function buildGraph() {
  const files = walk(VAULT);
  const nodes = [];
  const byKey = new Map();   // id AND filename-stem -> node (first wins)
  const byRel = new Map();   // normalized relative path -> node id

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const fm = frontmatter(text);
    const rel = path.relative(VAULT, f).replace(/\\/g, '/');
    const stem = path.basename(f, '.md');
    const id = fm.id || rel.replace(/\.md$/, '');
    const node = {
      id,
      title: fm.title || stem,
      type: fm.type || (rel.includes('skills/') ? 'skill' : 'doc'),
      group: GROUP_OF(rel),
      tags: fm.tags || '',
      aliases: fm.aliases || '',
      status: fm.status || '',
      rel,
      wikilinks: [...text.matchAll(/\[\[([^\]|#]+)/g)].map((x) => x[1].trim()),
    };
    nodes.push(node);
    if (!byKey.has(id)) byKey.set(id, node);
    if (!byKey.has(stem)) byKey.set(stem, node);
    byRel.set(rel.toLowerCase(), id);
  }

  const links = [];
  const phantom = new Map();
  const seen = new Set();
  for (const n of nodes) {
    for (const t of n.wikilinks) {
      const target = byKey.get(t);
      let tid;
      if (target) {
        if (target.id === n.id) continue;
        tid = target.id;
      } else {
        if (!phantom.has(t)) {
          phantom.set(t, { id: t, title: t, type: 'missing', group: 'missing', tags: '', status: '', rel: null, degree: 0 });
        }
        tid = t;
      }
      const key = n.id + ' ' + tid;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: n.id, target: tid });
    }
  }
  nodes.push(...phantom.values());

  const degree = new Map();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  }
  for (const n of nodes) { n.degree = degree.get(n.id) || 0; delete n.wikilinks; }

  return {
    generated: new Date().toISOString(),
    vault: VAULT,
    nodes,
    links,
    phantomCount: phantom.size,
    byRel: Object.fromEntries(byRel),
  };
}

// Map a file path seen in a tool call back onto a graph node id.
// Accepts absolute Windows paths, forward/back slashes, and vault-relative paths.
export function resolvePath(graph, p) {
  if (!p) return null;
  let s = String(p).replace(/\\/g, '/').trim().replace(/^["']|["']$/g, '');
  const vl = VAULT.toLowerCase();
  const low = s.toLowerCase();
  const i = low.indexOf(vl);
  if (i >= 0) s = s.slice(i + VAULT.length).replace(/^\/+/, '');
  else if (low.includes('/ai/brain/')) s = s.slice(low.indexOf('/ai/brain/') + 10);
  else return null;
  const key = s.toLowerCase();
  return graph.byRel[key] || graph.byRel[key + '.md'] || null;
}
