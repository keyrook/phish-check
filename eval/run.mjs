/**
 *   npm run eval [-- options]
 *
 *   --capture-only   open the pages and save captures, call no model
 *   --recapture      reload real pages even when a capture is saved
 *   --mode M         vision | text | both (default both: the ablation)
 *   --max-calls N    make at most N new model calls, then score what exists
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
      if (c?.error) continue;
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

outer:
for (const mode of MODES) {
  for (const [i, page] of pages.entries()) {
    const c = loadCapture(page);
    if (!c || c.error) {
      if (mode === MODES[0]) skipped.push({ id: page.id, why: c?.error ?? 'not captured' });
      continue;
    }
    if (!isCached(c, mode)) {
      if (callsLeft <= 0) { stopped ??= 'the --max-calls budget ran out'; continue; }
      callsLeft--;
    }
    let claim;
    try {
      claim = await identify(c.signals, mode === 'vision' ? c.screenshot : null);
    } catch (err) {
      if (err instanceof MissingKeyError || err instanceof NetworkBlockedError) {
        stopped = err.message;
        break outer;
      }
      modelErrors.push({ id: `${page.id} (${mode})`, why: err.message.slice(0, 160) });
      continue;
    }
    const realUrl = page.real ? c.finalUrl : page.url;
    const base = {
      id: page.id, group: page.group, truthBrand: page.brand,
      claimed: claim.claimed_brand, confidence: claim.confidence, evidence: claim.evidence,
      modelMs: claim.modelMs, usage: claim.usage,
      captureMs: page.real ? c.captureMs : null,
    };
    const genuine = judge({ url: realUrl, claim, catalog });
    rows[mode].push({ ...base, case: 'genuine', truth: page.truth, url: realUrl, ...genuine });
    if (page.real) {
      const url = spoofUrl(page, c.finalUrl, i);
      rows[mode].push({ ...base, case: 'spoof', group: `spoof:${page.group}`, truth: 'phish', url, ...judge({ url, claim, catalog }) });
    }
  }
}

if (stopped) console.error(`\nStopped: ${stopped}`);

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

const p = provider();
const results = {
  model: p.model,
  provider: p.name,
  at: new Date().toISOString(),
  complete: !stopped && !modelErrors.length,
  skipped,
  modelErrors,
  modes: Object.fromEntries(MODES.filter((m) => rows[m].length).map((m) => [m, summarise(rows[m])])),
  dataBytes: {
    pageLoads: pages.map(loadCapture).filter((c) => c?.transferBytes).reduce((s, c) => s + c.transferBytes, 0),
  },
};

// ---------------------------------------------------------------- report

const f = (x, d = 1) => (x == null ? '—' : `${(100 * x).toFixed(d)}%`);
const ms = (x) => (x == null ? '—' : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${x} ms`);
const md = [];
md.push(`# Results`, '', `Model \`${results.model}\` via ${results.provider}, run ${results.at.slice(0, 10)}. Generated by \`npm run eval\`; do not edit by hand.`, '');
md.push('| | ' + Object.keys(results.modes).map((m) => (m === 'vision' ? 'screenshot + text' : 'text only')).join(' | ') + ' |');
md.push('|---|' + Object.keys(results.modes).map(() => '---:').join('|') + '|');
const line = (label, get) => md.push(`| ${label} | ${Object.values(results.modes).map(get).join(' | ')} |`);
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
md.push('');
for (const [mode, s] of Object.entries(results.modes)) {
  md.push(`## By group (${mode === 'vision' ? 'screenshot + text' : 'text only'})`, '', '| group | n | legit | impersonation | unknown |', '|---|---:|---:|---:|---:|');
  for (const g of s.byGroup) md.push(`| ${g.group} | ${g.n} | ${g.legit} | ${g.impersonation} | ${g.unknown} |`);
  md.push('');
  const fl = failures(rows[mode]);
  const item = (r) => `- \`${r.id}\` (${r.group}): claimed ${r.claimed ? `"${r.claimed}" ${r.confidence.toFixed(2)}` : 'no brand'} → ${r.verdict}. ${r.reasons.at(-1)}`;
  md.push(`### Failures (${mode === 'vision' ? 'screenshot + text' : 'text only'})`, '');
  md.push(`False positives: genuine pages flagged (${fl.falsePositives.length})`, '', ...(fl.falsePositives.map(item).length ? fl.falsePositives.map(item) : ['- none']), '');
  md.push(`Real catalogued pages left unknown (${fl.liveNotConfirmed.length})`, '', ...(fl.liveNotConfirmed.map(item).length ? fl.liveNotConfirmed.map(item) : ['- none']), '');
  md.push(`Spoofed catalogued pages missed (${fl.missedInScope.length})`, '', ...(fl.missedInScope.map(item).length ? fl.missedInScope.map(item) : ['- none']), '');
  md.push(`Brand named wrongly (${fl.wrongBrand.length})`, '', ...(fl.wrongBrand.map(item).length ? fl.wrongBrand.map(item) : ['- none']), '');
}
if (skipped.length || modelErrors.length) {
  md.push('## Not scored', '', ...[...skipped, ...modelErrors].map((s) => `- \`${s.id}\`: ${s.why}`), '');
}
if (!results.complete) md.push(`**Incomplete run**${stopped ? `: ${stopped}` : ''}. These numbers cover only what was scored.`, '');
md.push(`Page loads for the captures: ${mb(results.dataBytes.pageLoads)} in all.`, '');

writeFileSync(resolve(ROOT, 'eval/results.json'), JSON.stringify({ ...results, rows }, null, 1) + '\n');
writeFileSync(resolve(ROOT, 'eval/RESULTS.md'), md.join('\n'));
console.log('\n' + md.join('\n'));
if (stopped) process.exitCode = 3;
