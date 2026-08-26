// search-index.mjs — token-cheap full-text search over the vault.
//
// Why this exists: without it, finding a note means Grep (dumps every matching
// line, full paths, no ranking) followed by one Read per candidate — expensive in
// tokens and it says nothing about which candidate is actually the right note.
// This returns a short ranked list with a snippet, so most questions resolve
// without a Read at all.
//
// Built from the same graph the visualisation already holds in memory, so a search
// hit and a lit node are always the same id — there is no second resolver to drift
// out of sync with vault-index.mjs's. Zero dependencies, matching the rest of this
// project: at ~100 notes a hand-rolled inverted index outperforms the latency of
// spinning up sqlite, and there is nothing here a real search engine would do better.
import fs from 'node:fs';
import path from 'node:path';
import { VAULT } from './vault-index.mjs';

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was',
  'were', 'be', 'been', 'this', 'that', 'these', 'those', 'with', 'as', 'it', 'at',
  'by', 'from', 'not', 'no', 'into', 'than', 'then', 'so', 'if', 'but', 'its', 'over',
  'under', 'via', 'per', 'vs', 'you', 'your', 'i', 'we', 'my',
]);

// Hyphenated compounds (e.g. "iscsi-games-drive") stay whole — splitting them would
// lose the exact term Jordan types when he names a note after its own id.
function tokenize(s) {
  const raw = String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) || [];
  return raw.filter((t) => t.length > 1 && !STOP.has(t));
}

function termCounts(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const HEADING_RE = /^#{1,6}\s+(.+)$/gm;

// One entry per node backed by a real file — phantom wikilink targets (no `rel`)
// have nothing to search inside and are skipped.
function buildEntry(node) {
  if (!node.rel) return null;
  const abs = path.join(VAULT, node.rel);
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const body = raw.replace(FRONTMATTER_RE, '');
  const headings = [...body.matchAll(HEADING_RE)].map((m) => m[1]).join(' ');

  return {
    id: node.id, title: node.title, rel: node.rel, group: node.group,
    tags: node.tags || '', status: node.status || '', abs, body,
    fields: {
      title: termCounts(tokenize(node.title)),
      id: termCounts(tokenize(node.id)),
      alias: termCounts(tokenize(node.aliases || '')),
      tag: termCounts(tokenize(node.tags || '')),
      heading: termCounts(tokenize(headings)),
      body: termCounts(tokenize(body)),
    },
  };
}

export function buildIndex(graph) {
  const entries = graph.nodes.map(buildEntry).filter(Boolean);
  return { entries, builtAt: Date.now(), vaultNodeCount: graph.nodes.length };
}

// Field weight is what separates "the note is ABOUT this term" (title/id/alias/tag)
// from "the note happens to mention it" (body). Capped per-field count: the 4th hit
// of a term in one note says nothing the 3rd didn't, so more copies stop paying.
const WEIGHT = { title: 9, id: 9, alias: 7, tag: 5, heading: 3, body: 1 };
const CAP = 3;

function scoreEntry(entry, qTokens, qPhrase) {
  let score = 0;
  let matched = 0;
  for (const qt of qTokens) {
    let hit = false;
    for (const field of Object.keys(WEIGHT)) {
      const counts = entry.fields[field];
      const c = counts.get(qt);
      if (c) { score += WEIGHT[field] * Math.min(c, CAP); hit = true; continue; }
      // Prefix credit at reduced weight so a partial term ("prox") still surfaces
      // the note ("proxmox") without a typo-tolerant matcher.
      for (const [tok, cnt] of counts) {
        if (tok.length > qt.length + 1 && tok.startsWith(qt)) {
          score += (WEIGHT[field] * Math.min(cnt, CAP)) / 4;
          hit = true;
          break;
        }
      }
    }
    if (hit) matched++;
  }
  if (!matched) return 0;
  // Reward covering more of the query over hammering one term repeatedly.
  score *= 1 + 0.5 * (matched / qTokens.length);
  if (qPhrase.length > 2) {
    const t = entry.title.toLowerCase();
    if (t.includes(qPhrase)) score += 30;
    else if (entry.body.toLowerCase().includes(qPhrase)) score += 8;
  }
  return score;
}

function snippet(entry, qTokens) {
  const lower = entry.body.toLowerCase();
  let at = -1;
  for (const qt of qTokens) { at = lower.indexOf(qt); if (at >= 0) break; }
  if (at < 0) {
    const lede = entry.body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    return (lede || '').slice(0, 160);
  }
  const start = Math.max(0, at - 70);
  const end = Math.min(entry.body.length, at + 110);
  let s = entry.body.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < entry.body.length) s += '…';
  return s;
}

// opts: limit (default 8, max 25), group (exact match), tag (substring).
export function search(index, query, opts = {}) {
  const t0 = Date.now();
  const limit = Math.max(1, Math.min(Number(opts.limit) || 8, 25));
  const qPhrase = String(query || '').toLowerCase().trim();
  const qTokens = [...new Set(tokenize(qPhrase))];

  let pool = index.entries;
  if (opts.group) pool = pool.filter((e) => e.group === opts.group);
  if (opts.tag) {
    const t = String(opts.tag).toLowerCase();
    pool = pool.filter((e) => e.tags.toLowerCase().includes(t));
  }

  if (!qTokens.length) return { query, tookMs: Date.now() - t0, count: 0, total: pool.length, hits: [] };

  const scored = [];
  for (const e of pool) {
    const s = scoreEntry(e, qTokens, qPhrase);
    if (s > 0) scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s || a.e.id.localeCompare(b.e.id));

  const hits = scored.slice(0, limit).map(({ e, s }) => ({
    id: e.id, title: e.title, rel: e.rel, abs: e.abs, group: e.group, tags: e.tags,
    score: Math.round(s * 10) / 10, snippet: snippet(e, qTokens),
  }));
  return { query, tookMs: Date.now() - t0, count: hits.length, total: scored.length, hits };
}
