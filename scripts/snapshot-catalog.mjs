/**
 * Copies Keyrook Authenticator's brand catalog into data/catalog.json.
 *
 *   node scripts/snapshot-catalog.mjs [path/to/catalog.ts]
 *
 * The catalog is a generated TypeScript file whose only code is one array
 * literal. We cut that literal out and evaluate it in an empty VM context, so
 * nothing else in the file (or the repo it lives in) runs, and the source repo
 * is only ever read.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { getDomain } from 'tldts';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(process.argv[2] ??
  process.env.CATALOG_SRC ??
  resolve(ROOT, '../authenticator-x/packages/core/src/brand/catalog.ts'));

const text = readFileSync(SRC, 'utf8');
const start = text.indexOf('export const CATALOG');
const open = text.indexOf('[', text.indexOf('=', start));
const close = text.lastIndexOf('] as const;');
if (start < 0 || open < 0 || close < open) throw new Error(`No CATALOG array in ${SRC}`);

const entries = vm.runInNewContext(`(${text.slice(open, close + 1)})`, Object.create(null), { timeout: 1000 });

const brands = entries.map(({ slug, name, domains, aliases, popular }) => ({
  slug,
  name,
  domains,
  // What a page on any of those hosts resolves to after the public-suffix rule:
  // accounts.google.com and google.com are both google.com.
  sites: [...new Set(domains.map((d) => getDomain(d, { allowPrivateDomains: true }) ?? d))],
  aliases,
  popular: Boolean(popular),
}));

const out = resolve(ROOT, 'data/catalog.json');
writeFileSync(out, JSON.stringify({
  source: 'keyrook/keyrook-authenticator packages/core/src/brand/catalog.ts',
  count: brands.length,
  withDomains: brands.filter((b) => b.domains.length).length,
  brands,
}, null, 1) + '\n');
console.log(`${brands.length} brands (${brands.filter((b) => b.domains.length).length} with domains) → ${out}`);
