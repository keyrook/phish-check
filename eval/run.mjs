/**
 *   npm run eval [-- options]
 *
 *   --capture-only   open the pages and save captures, call no model
 *   --recapture      reload real pages even when a capture is saved
 *   --mode M         vision | text | both (default both: the ablation)
 *   --max-calls N    make at most N new model calls, then score what exists
 *   --max-neurons N  Cloudflare: stop making new calls before N neurons are
 *                    spent in this run (Workers AI's free tier is 10,000 a day)
 *   --estimate       print the data a run would use, and stop
 *   --only a,b       just these page ids
 *
 * Each real sign-in page is opened once and saved under .tmp/captures (the
 * screenshot never leaves .tmp/). The model sees the screenshot and page text
 * but never the address, so one answer per page and mode serves two cases:
 *
 *   genuine  the page judged at the address it really came from
 *   spoof    the same pixels and text judged at a lookalike .test address,
 *            which is what a real-time phishing proxy (evilginx and the
 *            like) shows its victim: the real page, relayed from a host the
 *            attacker owns
 *
 * No lookalike page is built or served. Reruns read the saved captures and
 * the cached answers, so they cost no page loads and no model quota.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture, launch } from '../src/capture.mjs';
import { loadCatalog } from '../src/catalog.mjs';
import { buildMessages, identify } from '../src/identify.mjs';
import { cachePath, MissingKeyError, NetworkBlockedError, provider } from '../src/llm.mjs';
import { judge } from '../src/verdict.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CAPTURES = resolve(ROOT, '.tmp/captures');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const MODES = { vision: ['vision'], text: ['text'], both: ['vision', 'text'] }[option('mode', 'both')];
if (!MODES) throw new Error('--mode is vision, text or both');
let callsLeft = Number(option('max-calls', Infinity));
const maxNeurons = Number(option('max-neurons', Infinity));
let neuronsSpent = 0;
let costliest = { vision: 0, text: 0 };
// Workers AI reports neurons itself; otherwise price the tokens the same way.
const neuronsOf = (u) => u?.neurons ?? ((u?.prompt_tokens ?? 0) * 24_545 + (u?.completion_tokens ?? 0) * 77_273) / 1e6;

const catalog = loadCatalog();
const readJson = (f) => JSON.parse(readFileSync(resolve(ROOT, f), 'utf8'));

// ---------------------------------------------------------------- the cases

const pages = [
  ...readJson('eval/legit.json').pages.map((p) => ({ ...p, group: 'live' })),
  ...readJson('eval/hard.json').pages,
].map((p) => ({
  ...p,
  real: !p.fixture,
  open: p.fixture ? pathToFileURL(resolve(ROOT, 'eval/fixtures', p.fixture)).href : p.url,
  truth: p.brand === null ? 'benign' : 'genuine',
})).filter((p) => !option('only') || option('only').split(',').includes(p.id));

// Lookalike hosts in the shapes phishing kits use: the brand as a subdomain
// or a prefix of a domain the attacker registered. All under .test.
const SPOOF = [
  (s) => `accounts-${s}.verify-login.test`,
  (s) => `${s}.com-secure-signin.test`,
  (s) => `login.${s}-support.test`,
  (s) => `${s}-account-review.test`,
  (s) => `auth-${s}.cloud-portal.test`,
];
function spoofUrl(page, finalUrl, i) {
  const slug = page.id.replace(/[^a-z0-9]+/g, '');
  const u = new URL(finalUrl);
  return `https://${SPOOF[i % SPOOF.length](slug)}${u.pathname}`;
}

// ---------------------------------------------------------------- captures

function loadCapture(page) {
  const dir = resolve(CAPTURES, page.id);
  if (!existsSync(resolve(dir, 'page.json'))) return null;
  const meta = JSON.parse(readFileSync(resolve(dir, 'page.json'), 'utf8'));
  if (meta.error) return meta;
  return { ...meta, screenshot: readFileSync(resolve(dir, 'shot.jpg')) };
}

async function captureAll(todo) {
  if (!todo.length) return;
  console.log(`Opening ${todo.length} page(s)…`);
  const browser = await launch();
  try {
    const queue = [...todo];
    // A few at a time: quick enough, and gentle on the sites.
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (let page; (page = queue.shift());) {
        const dir = resolve(CAPTURES, page.id);
        mkdirSync(dir, { recursive: true });
        try {
          const c = await capture(browser, page.open);
          writeFileSync(resolve(dir, 'shot.jpg'), c.screenshot);
          writeFileSync(resolve(dir, 'page.json'), JSON.stringify({
            finalUrl: c.finalUrl, signals: c.signals, captureMs: c.captureMs,
            transferBytes: c.transferBytes, at: new Date().toISOString(),
          }, null, 1));
          console.log(`  ok   ${page.id}  ${(c.transferBytes / 1e6).toFixed(1)} MB  ${c.captureMs} ms`);
        } catch (err) {
          writeFileSync(resolve(dir, 'page.json'), JSON.stringify({ error: err.message.split('\n')[0], at: new Date().toISOString() }));
          console.log(`  FAIL ${page.id}  ${err.message.split('\n')[0]}`);
        }
      }
    }));
  } finally {
    await browser.close();
  }
}

// Pages that loaded but showed no sign-in page (bot walls, blank renders).
const EXCLUDED = readJson('eval/excluded.json').pages;

const todoCaptures = pages.filter((p) => flag('recapture') || !loadCapture(p));

// ---------------------------------------------------------------- estimate

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
function estimate() {
  const captured = pages.filter((p) => p.real).map(loadCapture).filter((c) => c && !c.error && c.transferBytes);
  const realTodo = todoCaptures.filter((p) => p.real).length;
  const perPage = captured.length ? captured.reduce((s, c) => s + c.transferBytes, 0) / captured.length : 3e6;
  let upload = 0;
  let calls = 0;
  for (const p of pages) {
    const c = loadCapture(p);
    for (const mode of MODES) {
      if (c?.error || EXCLUDED[p.id]) continue;
      // Not captured yet: assume the average screenshot so far.
      const shot = c?.screenshot ?? Buffer.alloc(captured.length ? 80_000 : 100_000);
      const body = JSON.stringify(buildMessages(c?.signals ?? {}, mode === 'vision' ? shot : null));
      if (!c || !isCached(c, mode)) { upload += body.length; calls++; }
    }
  }
  return { realTodo, perPage, pageBytes: realTodo * perPage, calls, upload, measured: captured.length };
}

/** Whether identify() would answer this from the cache, without calling. */
const isCached = (c, mode) =>
  existsSync(cachePath({ messages: buildMessages(c.signals, mode === 'vision' ? c.screenshot : null) }));

if (flag('estimate')) {
  const e = estimate();
  console.log(`Pages to open: ${e.realTodo} real × ~${mb(e.perPage)} (average of ${e.measured} measured) ≈ ${mb(e.pageBytes)}`);
  console.log(`Model calls to make: ${e.calls}, uploading ≈ ${mb(e.upload)} (answers are a few hundred bytes each)`);
  process.exit(0);
}

await captureAll(todoCaptures);
if (flag('capture-only')) {
  const e = estimate();
  console.log(`\nCaptured. A full run now makes ${e.calls} model call(s), uploading ≈ ${mb(e.upload)}.`);
  process.exit(0);
}

// ---------------------------------------------------------------- scoring

const rows = { vision: [], text: [] };
const skipped = [];
const modelErrors = [];
let stopped = null;
const MAX_CONSECUTIVE_ERRORS = 3;
let consecutiveErrors = 0;
console.log(`Asking ${provider().name}:${provider().model} (${MODES.join(' then ')})…`);

outer:
for (const mode of MODES) {
  for (const [i, page] of pages.entries()) {
    const c = loadCapture(page);
    if (!c || c.error || EXCLUDED[page.id]) {
      if (mode === MODES[0]) skipped.push({ id: page.id, why: EXCLUDED[page.id] ?? c?.error ?? 'not captured' });
      continue;
    }
    const fresh = !isCached(c, mode);
    if (fresh) {
      if (callsLeft <= 0) { stopped ??= 'the --max-calls budget ran out'; continue; }
      // Leave room for a call as costly as the costliest one so far.
      if (neuronsSpent + Math.max(costliest[mode], mode === 'vision' ? 80 : 25) > maxNeurons) {
        stopped ??= `the --max-neurons budget (${maxNeurons}) would be exceeded`;
        continue;
      }
      callsLeft--;
    }
    let claim;
    const asked = performance.now();
    try {
      claim = await identify(c.signals, mode === 'vision' ? c.screenshot : null);
      consecutiveErrors = 0;
    } catch (err) {
      if (err instanceof MissingKeyError || err instanceof NetworkBlockedError) {
        stopped = err.message;
        break outer;
      }
      const why = err.message.replace(/\s+/g, ' ').slice(0, 200);
      console.log(`  ${mode.padEnd(6)} ${page.id.padEnd(16)} ERROR after ${Math.round(performance.now() - asked)} ms: ${why}`);
      modelErrors.push({ id: `${page.id} (${mode})`, why });
      // A provider that fails several times running is down, not unlucky:
      // stop and say so instead of grinding through every page.
      if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        stopped = `${consecutiveErrors} model calls in a row failed; the last said: ${why}`;
        break outer;
      }
      continue;
    }
    if (fresh) {
      const n = neuronsOf(claim.usage);
      neuronsSpent += n;
      costliest[mode] = Math.max(costliest[mode], n);
      const cost = provider().name === 'cloudflare'
        ? `${n.toFixed(0)} neurons (run total ${neuronsSpent.toFixed(0)})`
        : `${claim.usage?.prompt_tokens ?? '?'} tokens in`;
      console.log(`  ${mode.padEnd(6)} ${page.id.padEnd(16)} ${String(claim.claimed_brand).padEnd(18)} ${claim.modelMs} ms  ${cost}`);
    }
    const realUrl = page.real ? c.finalUrl : page.url;
    const base = {
      id: page.id, group: page.group, truthBrand: page.brand,
      claimed: claim.claimed_brand, confidence: claim.confidence, evidence: claim.evidence,
      modelMs: claim.modelMs, usage: claim.usage,
      parse: claim.parseError ? 'unreadable' : claim.salvaged ? 'salvaged' : 'ok',
      captureMs: page.real ? c.captureMs : null,
    };
    const genuine = judge({ url: realUrl, claim, catalog });
    // Published without query or fragment: redirects leave session ids there.
    const shown = (u) => { const x = new URL(u); return `${x.origin}${x.pathname}`; };
    rows[mode].push({ ...base, case: 'genuine', truth: page.truth, url: shown(realUrl), ...genuine });
    if (page.real) {
      const url = spoofUrl(page, c.finalUrl, i);
      rows[mode].push({ ...base, case: 'spoof', group: `spoof:${page.group}`, truth: 'phish', url: shown(url), ...judge({ url, claim, catalog }) });
    }
  }
}

if (stopped) console.error(`\nStopped: ${stopped}`);
if (neuronsSpent && provider().name === 'cloudflare') console.log(`\nNeurons spent in this run: ${neuronsSpent.toFixed(0)}`);

// ---------------------------------------------------------------- metrics

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}
const slugOf = (name) => catalog.lookup(name ?? '')?.slug ?? null;
function brandRight(r) {
  if (r.truthBrand === null) return r.claimed === null;
  const truthSlug = catalog.brands.some((b) => b.slug === r.truthBrand) ? r.truthBrand : null;
  if (truthSlug) {
    const said = slugOf(r.claimed);
    // Google covers its products, Amazon covers AWS: the same sign-in.
    const site = (s) => catalog.brands.find((b) => b.slug === s)?.sites?.join();
    return said === truthSlug || (said && site(said) && site(said) === site(truthSlug));
  }
  return !!r.claimed && r.claimed.toLowerCase().replace(/[^a-z]/g, '').includes(r.truthBrand.toLowerCase().replace(/[^a-z]/g, ''));
}

function summarise(list) {
  const flagged = (r) => r.verdict === 'impersonation';
  const tp = list.filter((r) => r.truth === 'phish' && flagged(r)).length;
  const fn = list.filter((r) => r.truth === 'phish' && !flagged(r)).length;
  const fp = list.filter((r) => r.truth !== 'phish' && flagged(r)).length;
  const tn = list.filter((r) => r.truth !== 'phish' && !flagged(r)).length;
  const inScope = list.filter((r) => r.group === 'spoof:live');
  const live = list.filter((r) => r.group === 'live');
  const pages = list.filter((r) => r.case === 'genuine');
  const e2e = pages.filter((r) => r.captureMs != null).map((r) => r.captureMs + r.modelMs);
  const tokens = pages.map((r) => r.usage?.prompt_tokens).filter(Number.isFinite);
  return {
    pages: pages.length,
    cases: list.length,
    tp, fp, fn, tn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    recallInScope: inScope.length ? inScope.filter(flagged).length / inScope.length : null,
    inScope: inScope.length,
    fpr: fp + tn ? fp / (fp + tn) : null,
    liveConfirmed: live.length ? live.filter((r) => r.verdict === 'legit').length / live.length : null,
    live: live.length,
    brandAccuracy: pages.length ? pages.filter(brandRight).length / pages.length : null,
    latency: {
      captureP50: percentile(pages.map((r) => r.captureMs), 50),
      captureP95: percentile(pages.map((r) => r.captureMs), 95),
      modelP50: percentile(pages.map((r) => r.modelMs), 50),
      modelP95: percentile(pages.map((r) => r.modelMs), 95),
      endToEndP50: percentile(e2e, 50),
      endToEndP95: percentile(e2e, 95),
    },
    promptTokensMean: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : null,
    // Replies that were not valid JSON (cut off at the token limit, or
    // malformed): read field by field, or not readable at all.
    salvaged: pages.filter((r) => r.parse === 'salvaged').length,
    unreadable: pages.filter((r) => r.parse === 'unreadable').length,
    byGroup: Object.entries(Object.groupBy(list, (r) => r.group)).map(([group, rs]) => ({
      group,
      n: rs.length,
      legit: rs.filter((r) => r.verdict === 'legit').length,
      impersonation: rs.filter(flagged).length,
      unknown: rs.filter((r) => r.verdict === 'unknown').length,
    })),
  };
}

function failures(list) {
  return {
    falsePositives: list.filter((r) => r.truth !== 'phish' && r.verdict === 'impersonation'),
    liveNotConfirmed: list.filter((r) => r.group === 'live' && r.verdict === 'unknown'),
    missedInScope: list.filter((r) => r.group === 'spoof:live' && r.verdict !== 'impersonation'),
    wrongBrand: list.filter((r) => r.case === 'genuine' && !brandRight(r)),
  };
}

// ---------------------------------------------------------------- results

// One file per provider, so runs on different services sit side by side
// and every number names the service that produced it. A run of one mode
// keeps the other mode's earlier results for the same provider and model.
const p = provider();
const RESULTS_DIR = resolve(ROOT, 'eval/results');
mkdirSync(RESULTS_DIR, { recursive: true });
const resultFile = resolve(RESULTS_DIR, `${p.label}.json`);
const previous = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
const scoreable = pages.filter((pg) => { const c = loadCapture(pg); return c && !c.error && !EXCLUDED[pg.id]; }).length;
writeFileSync(resultFile, JSON.stringify({
  provider: p.label,
  model: p.model,
  modes: {
    ...(previous?.model === p.model ? previous.modes : {}),
    ...Object.fromEntries(MODES.filter((m) => rows[m].length).map((m) => [m, {
      at: new Date().toISOString(),
      complete: rows[m].filter((r) => r.case === 'genuine').length === scoreable,
      modelErrors: modelErrors.filter((e) => e.id.endsWith(`(${m})`)),
      summary: summarise(rows[m]),
      rows: rows[m],
    }])),
  },
}, null, 1) + '\n');

// ---------------------------------------------------------------- report

const SERVICE = { cloudflare: 'Cloudflare Workers AI', nvidia: 'NVIDIA API', groq: 'Groq' };
const MODE = { vision: 'screenshot + text', text: 'text only' };
const columns = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json')).sort().flatMap((f) => {
  const r = JSON.parse(readFileSync(resolve(RESULTS_DIR, f), 'utf8'));
  return ['vision', 'text'].filter((m) => r.modes[m]).map((m) => ({
    title: `${MODE[m]}, ${SERVICE[r.provider] ?? r.provider}`,
    model: r.model,
    ...r.modes[m],
  }));
});

const f = (x, d = 1) => (x == null ? '—' : `${(100 * x).toFixed(d)}%`);
const ms = (x) => (x == null ? '—' : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${x} ms`);
const md = [];
md.push('# Results', '', 'Generated by `npm run eval` from eval/results/*.json; do not edit by hand. Every column names the service that ran the model.', '');
md.push('| | ' + columns.map((c) => c.title).join(' | ') + ' |');
md.push('|---|' + columns.map(() => '---:').join('|') + '|');
const line = (label, get) => md.push(`| ${label} | ${columns.map((c) => get(c.summary, c)).join(' | ')} |`);
line('Model', (s, c) => `\`${c.model}\``);
line('Scored', (s, c) => `${c.at.slice(0, 16).replace('T', ' ')} UTC${c.complete ? '' : ' (incomplete)'}`);
line('Pages scored', (s) => s.pages);
line('Cases (genuine + spoofed)', (s) => s.cases);
line('Precision (flagged that were phish)', (s) => f(s.precision));
line('Recall, catalogued brands', (s) => `${f(s.recallInScope)} of ${s.inScope}`);
line('Recall, all spoofed pages', (s) => f(s.recall));
line('False-positive rate (genuine flagged)', (s) => f(s.fpr));
line('Real pages confirmed legit', (s) => `${f(s.liveConfirmed)} of ${s.live}`);
line('Brand named correctly', (s) => f(s.brandAccuracy));
line('Model latency p50 / p95', (s) => `${ms(s.latency.modelP50)} / ${ms(s.latency.modelP95)}`);
line('Page capture p50 / p95', (s) => `${ms(s.latency.captureP50)} / ${ms(s.latency.captureP95)}`);
line('End to end p50 / p95', (s) => `${ms(s.latency.endToEndP50)} / ${ms(s.latency.endToEndP95)}`);
line('Prompt tokens, mean', (s) => s.promptTokensMean ?? '—');
line('Replies not valid JSON: salvaged / unreadable', (s) => `${s.salvaged ?? 0} / ${s.unreadable ?? 0}`);
md.push('');
const item = (r) => `- \`${r.id}\` (${r.group}): claimed ${r.claimed ? `"${r.claimed}" ${r.confidence.toFixed(2)}` : 'no brand'} → ${r.verdict}. ${r.reasons.at(-1)}`;
const list = (title, rs) => md.push(`${title} (${rs.length})`, '', ...(rs.length ? rs.map(item) : ['- none']), '');
for (const c of columns) {
  md.push(`## ${c.title}`, '', '| group | n | legit | impersonation | unknown |', '|---|---:|---:|---:|---:|');
  for (const g of c.summary.byGroup) md.push(`| ${g.group} | ${g.n} | ${g.legit} | ${g.impersonation} | ${g.unknown} |`);
  md.push('');
  const fl = failures(c.rows);
  list('False positives: genuine pages flagged', fl.falsePositives);
  list('Real catalogued pages left unknown', fl.liveNotConfirmed);
  list('Spoofed catalogued pages missed', fl.missedInScope);
  list('Brand named wrongly', fl.wrongBrand);
  if (c.modelErrors.length) md.push('Model calls that failed', '', ...c.modelErrors.map((e) => `- \`${e.id}\`: ${e.why}`), '');
  if (!c.complete) md.push('**Incomplete:** not every scoreable page has an answer in this column; its numbers cover only the pages listed above.', '');
}
md.push('## Not scored', '', ...skipped.map((s) => `- \`${s.id}\`: ${s.why}`), '');
md.push(`Page loads for the captures: ${mb(pages.map(loadCapture).filter((c) => c?.transferBytes).reduce((sum, c) => sum + c.transferBytes, 0))} in all.`, '');

writeFileSync(resolve(ROOT, 'eval/RESULTS.md'), md.join('\n'));
console.log('\n' + md.join('\n'));
if (stopped) process.exitCode = 3;
