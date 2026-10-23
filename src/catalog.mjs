/**
 * Finds a brand the model named in the snapshot of Keyrook Authenticator's
 * catalog (data/catalog.json, made by scripts/snapshot-catalog.mjs).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const squash = (s) => norm(s).replace(/ /g, '');

// Words a model adds around a brand name: "Microsoft account", "Apple ID".
const FILLER = new Set(['account', 'accounts', 'id', 'login', 'log', 'sign', 'signin', 'in', 'inc', 'corp', 'corporation', 'the', 'official', 'portal']);

export function loadCatalog(file = resolve(import.meta.dirname, '../data/catalog.json')) {
  const { brands } = JSON.parse(readFileSync(file, 'utf8'));
  const byKey = new Map();
  for (const b of brands) {
    // The first brand to claim a key keeps it: names before aliases.
    for (const k of [b.name, b.slug]) if (!byKey.has(squash(k))) byKey.set(squash(k), b);
  }
  for (const b of brands) {
    for (const a of b.aliases) if (a.length > 2 && !byKey.has(squash(a))) byKey.set(squash(a), b);
  }

  /** Returns the catalog entry for a brand name, or null. */
  function lookup(name) {
    if (!name) return null;
    const exact = byKey.get(squash(name));
    if (exact) return exact;
    const words = norm(name).split(' ').filter((w) => !FILLER.has(w));
    if (!words.length) return null;
    const trimmed = byKey.get(words.join(''));
    if (trimmed) return trimmed;
    // "Google Workspace" → Google, "Microsoft 365" → Microsoft: the longest
    // catalog name the claim starts with, matched on whole words.
    for (let n = words.length - 1; n > 0; n--) {
      const hit = byKey.get(words.slice(0, n).join(''));
      if (hit) return hit;
    }
    return null;
  }

  return { brands, lookup };
}
