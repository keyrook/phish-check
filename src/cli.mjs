/**
 *   npm run check -- <url> [--text-only] [--json]
 *
 * Opens the page (never types into it), asks the model which brand it shows,
 * and prints legit / impersonation / unknown with the reasons.
 */
import { capture, launch } from './capture.mjs';
import { checkCaptured } from './check.mjs';
import { MissingKeyError, NetworkBlockedError } from './llm.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const textOnly = args.includes('--text-only');
const asJson = args.includes('--json');

if (!url || !/^https?:\/\//i.test(url)) {
  console.error('usage: npm run check -- https://example.com/login [--text-only] [--json]');
  process.exit(2);
}

const browser = await launch();
try {
  const page = await capture(browser, url);
  const result = await checkCaptured(page, { textOnly });
  result.captureMs = page.captureMs;
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const c = result.claim;
    console.log(`${result.verdict.toUpperCase()}  ${new URL(result.url).hostname}`);
    console.log(`  claims to be: ${c.brand ? `${c.brand} (${c.confidence.toFixed(2)})` : 'no brand'}`);
    for (const r of result.reasons) console.log(`  - ${r}`);
    const model = result.cached ? `${result.modelMs} ms when first asked (cached now)` : `${result.modelMs} ms`;
    console.log(`  capture ${page.captureMs} ms · model ${model} · ${result.model}`);
  }
  process.exitCode = result.verdict === 'impersonation' ? 1 : 0;
} catch (err) {
  if (err instanceof MissingKeyError || err instanceof NetworkBlockedError) {
    console.error(err.message);
    process.exitCode = 3;
  } else {
    throw err;
  }
} finally {
  await browser.close();
}
