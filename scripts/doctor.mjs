/**
 *   npm run doctor
 *
 * Checks the provider before an evaluation spends quota: the settings are
 * there (the key is never printed), the model is still offered, and one
 * screenshot + text request comes back as a brand claim. That request is the
 * eval's own request for the GitHub page, so its cached answer is reused
 * there rather than wasted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { identify } from '../src/identify.mjs';
import { MissingKeyError, NetworkBlockedError, provider } from '../src/llm.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const p = provider();
console.log(`provider  ${p.name}`);
console.log(`model     ${p.model}`);
console.log(`endpoint  ${p.url.replace(/accounts\/[^/]+/, 'accounts/<id>')}`);
console.log(`key       ${p.key ? 'set' : 'MISSING'}`);
if (!p.key) {
  console.error(`\n${p.keyName} is not set: ${p.keyHelp}, then put it in .env`);
  process.exit(3);
}

// Groq lists what it serves; a model that has been retired is gone from it.
if (p.name === 'groq') {
  const res = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${p.key}` } });
  const text = await res.text();
  if (res.status === 403 && /access denied|network settings/i.test(text)) {
    console.error('\nGroq chặn mạng này — bật 4G, hoặc đặt PROVIDER=cloudflare trong .env');
    process.exit(4);
  }
  if (!res.ok) {
    console.error(`\nGroq /models answered ${res.status}: ${text.slice(0, 200)}`);
    process.exit(1);
  }
  const ids = JSON.parse(text).data.map((m) => m.id);
  const listed = ids.includes(p.model);
  console.log(`listed    ${listed ? 'yes' : 'NO'}`);
  if (!listed) {
    const vision = ids.filter((id) => /llama-4|vision|scout|maverick/i.test(id));
    console.error(`\n${p.model} is not offered on this key any more.`);
    console.error(`Llama 4 / vision-looking models it does offer: ${vision.join(', ') || 'none'}`);
    console.error('Set PROVIDER=cloudflare (same model as @cf/meta/llama-4-scout-17b-16e-instruct) in .env.');
    process.exit(5);
  }
}

const dir = resolve(ROOT, '.tmp/captures/github');
if (!existsSync(resolve(dir, 'shot.jpg'))) {
  console.log('\nNo GitHub capture yet (npm run eval -- --capture-only --only github); skipping the image test.');
  process.exit(0);
}
const page = JSON.parse(readFileSync(resolve(dir, 'page.json'), 'utf8'));
try {
  const claim = await identify(page.signals, readFileSync(resolve(dir, 'shot.jpg')));
  console.log(`\nimage + text request on github.com/login:`);
  console.log(`  claimed   ${claim.claimed_brand ?? 'no brand'} (${claim.confidence})`);
  console.log(`  evidence  ${claim.evidence.join('; ')}`);
  console.log(`  json mode ${claim.jsonMode ? 'accepted' : 'not used (parsed from text)'}`);
  console.log(`  latency   ${claim.modelMs} ms${claim.cached ? ' (cached answer)' : ''}`);
  if (claim.usage) console.log(`  tokens    ${claim.usage.prompt_tokens} in, ${claim.usage.completion_tokens} out`);
  if (claim.parseError) process.exitCode = 1;
} catch (err) {
  if (err instanceof NetworkBlockedError || err instanceof MissingKeyError) {
    console.error(`\n${err.message}`);
    process.exit(4);
  }
  console.error(`\nThe image request failed: ${err.message}`);
  process.exit(1);
}
