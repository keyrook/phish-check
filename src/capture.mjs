/**
 * Opens a page headless and records what a person would see: a screenshot of
 * the first screen, and the visible text that names a brand — title,
 * headings, form labels, buttons, image alt text and logo hints.
 *
 * Nothing is typed and nothing is submitted.
 */
import { chromium } from 'playwright';

export const VIEWPORT = { width: 1280, height: 800 };

/** Runs inside every frame of the page; login forms often live in iframes. */
function readFrame() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const text = (el) => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const all = (sel) => [...document.querySelectorAll(sel)].filter(visible);
  const file = (src) => {
    try {
      return new URL(src, location.href).pathname.split('/').pop() ?? '';
    } catch {
      return '';
    }
  };

  return {
    title: document.title,
    siteName: document.querySelector('meta[property="og:site_name"]')?.content ??
      document.querySelector('meta[name="application-name"]')?.content ?? '',
    headings: all('h1,h2,h3,[role=heading]').map(text),
    labels: all('label,legend').map(text),
    fields: all('input:not([type=hidden]),textarea,select').map((i) => [
      i.type,
      i.getAttribute('autocomplete') === 'one-time-code' ? 'one-time-code' : '',
      i.placeholder,
      i.getAttribute('aria-label'),
    ].filter(Boolean).join(' ')),
    buttons: all('button,[role=button],input[type=submit],input[type=button]')
      .map((b) => text(b) || b.value || b.getAttribute('aria-label') || ''),
    imageAlts: all('img[alt]').map((i) => i.alt.trim()),
    logoHints: [
      ...all('img').map((i) => file(i.currentSrc || i.src)).filter((f) => /logo|brand|mark/i.test(f)),
      ...all('svg').map((s) => s.getAttribute('aria-label') || s.querySelector('title')?.textContent || ''),
      ...all('[class*=logo i],[id*=logo i]').map((el) => el.getAttribute('aria-label') || el.title || ''),
    ],
    favicon: file(document.querySelector('link[rel~="icon"]')?.href ?? ''),
    bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
  };
}

const LIMITS = { headings: 8, labels: 10, fields: 10, buttons: 12, imageAlts: 10, logoHints: 8 };
const clip = (s, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

function merge(frames) {
  const [top = { title: '', siteName: '', favicon: '', bodyText: '' }, ...rest] = frames;
  const out = { title: top.title, siteName: top.siteName, favicon: top.favicon };
  for (const [k, n] of Object.entries(LIMITS)) {
    out[k] = [...new Set(frames.flatMap((f) => f[k]).map((s) => clip(s.trim())).filter(Boolean))].slice(0, n);
  }
  out.bodyText = [top.bodyText, ...rest.map((f) => f.bodyText)].filter(Boolean).join(' | ').slice(0, 800);
  return out;
}

export async function launch({ hostRules } = {}) {
  return chromium.launch({
    headless: true,
    args: hostRules ? [`--host-resolver-rules=${hostRules}`] : [],
  });
}

/**
 * Returns { finalUrl, screenshot (JPEG Buffer), signals, captureMs }.
 * `finalUrl` is where redirects ended: the page the person would type into.
 */
export async function capture(browser, url, { settleMs = 2500 } = {}) {
  const started = performance.now();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  });
  try {
    const page = await context.newPage();
    // Bytes over the wire, so the data cost of a run is measured, not guessed.
    let transferBytes = 0;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.loadingFinished', (e) => { transferBytes += e.encodedDataLength; });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(settleMs);

    const frames = [];
    for (const frame of page.frames()) {
      const read = await frame.evaluate(readFrame).catch(() => null);
      if (read) frames.push(read);
    }
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
    return {
      finalUrl: page.url(),
      screenshot,
      signals: merge(frames),
      captureMs: Math.round(performance.now() - started),
      transferBytes,
    };
  } finally {
    await context.close();
  }
}
