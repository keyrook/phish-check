/**
 * A chat-completions client for any OpenAI-compatible endpoint, over plain
 * fetch. The provider is picked in .env; the key never leaves this module
 * except in the Authorization header, and is never printed.
 *
 * Free tiers are small, so every call is throttled and every answer is cached
 * on disk under a hash of the exact request: a rerun over the same input costs
 * nothing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CACHE_DIR = resolve(ROOT, '.tmp/llm-cache');

try {
  process.loadEnvFile(resolve(ROOT, '.env'));
} catch {
  // No .env: the environment may already carry the settings.
}

const PROVIDERS = {
  groq: (env) => ({
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: env.GROQ_API_KEY,
    keyName: 'GROQ_API_KEY',
    keyHelp: 'create one at https://console.groq.com → API Keys',
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
  }),
  cloudflare: (env) => ({
    url: `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`,
    key: env.CF_ACCOUNT_ID ? env.CF_API_TOKEN : undefined,
    keyName: 'CF_ACCOUNT_ID and CF_API_TOKEN',
    keyHelp: 'Cloudflare dashboard → Workers AI → "Use REST API" gives both',
    model: '@cf/meta/llama-4-scout-17b-16e-instruct',
  }),
  // Anything else that speaks the same protocol.
  openai: (env) => ({
    url: `${env.OPENAI_BASE_URL?.replace(/\/$/, '')}/chat/completions`,
    key: env.OPENAI_BASE_URL ? env.OPENAI_API_KEY : undefined,
    keyName: 'OPENAI_BASE_URL and OPENAI_API_KEY',
    keyHelp: 'set both in .env',
    model: undefined,
  }),
};

export function provider(env = process.env) {
  const name = (env.PROVIDER || 'cloudflare').toLowerCase();
  const make = PROVIDERS[name];
  if (!make) throw new Error(`Unknown PROVIDER "${name}" (expected ${Object.keys(PROVIDERS).join(', ')})`);
  const p = make(env);
  const model = env.MODEL || p.model;
  if (!model) throw new Error('Set MODEL in .env');
  // Which service answered, for labelling results: an OpenAI-compatible
  // endpoint is named after its host (integrate.api.nvidia.com → nvidia).
  let label = name;
  if (name === 'openai' && env.OPENAI_BASE_URL) {
    const host = new URL(env.OPENAI_BASE_URL).hostname;
    label = /nvidia/.test(host) ? 'nvidia' : host;
  }
  // Under the free tiers' per-minute caps (Groq: 30) with room to spare.
  const rpm = Number(env.RPM) || 20;
  return { name, label, ...p, model, rpm };
}

export class MissingKeyError extends Error {}

/**
 * The provider refuses this network outright (Groq answers some IP ranges
 * with 403 "Access denied. Please check your network settings."). Retrying
 * cannot help, and it is not a model failure, so callers stop.
 */
export class NetworkBlockedError extends Error {}

let nextSlot = 0;
async function throttle(rpm) {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 60_000 / rpm;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const requestBody = ({ messages, maxTokens = 400 }, p) =>
  ({ model: p.model, messages, temperature: 0, max_tokens: maxTokens });

/** Where the answer to this exact request is (or would be) cached. */
export function cachePath({ messages, json = true, maxTokens = 400 }, p = provider()) {
  const key = createHash('sha256')
    .update(JSON.stringify({ provider: p.name, url: p.url, ...requestBody({ messages, maxTokens }, p), json }))
    .digest('hex');
  return resolve(CACHE_DIR, `${key}.json`);
}
const jsonModeRejected = new Set();

/**
 * Sends one chat request. Returns { content, latencyMs, usage, cached }.
 * `latencyMs` is always the latency measured when the call was really made,
 * so a cached answer still reports a real number.
 */
export async function chat({ messages, json = true, maxTokens = 400 }, p = provider()) {
  const body = requestBody({ messages, maxTokens }, p);
  const file = cachePath({ messages, json, maxTokens }, p);
  try {
    return { ...JSON.parse(readFileSync(file, 'utf8')), cached: true };
  } catch {
    // Not cached yet.
  }

  if (!p.key) throw new MissingKeyError(`${p.keyName} is not set: ${p.keyHelp}, then put it in .env`);

  let useJsonMode = json && !jsonModeRejected.has(p.url);
  for (let attempt = 0; ; attempt++) {
    await throttle(p.rpm);
    const started = performance.now();
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(useJsonMode ? { ...body, response_format: { type: 'json_object' } } : body),
      signal: AbortSignal.timeout(90_000),
    }).catch((err) => {
      throw new Error(`${p.name}: no answer (${err.name === 'TimeoutError' ? 'timed out after 90 s' : err.message})`);
    });
    const latencyMs = Math.round(performance.now() - started);
    const text = await res.text();

    if (res.ok) {
      const data = JSON.parse(text);
      // Cloudflare's native routes wrap the answer in { result }; the
      // OpenAI-compatible route should not, but accept both.
      const choice = (data.choices ?? data.result?.choices)?.[0];
      const entry = {
        provider: p.name,
        model: p.model,
        content: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason,
        usage: data.usage ?? data.result?.usage ?? null,
        latencyMs,
        jsonMode: useJsonMode,
        at: new Date().toISOString(),
      };
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify(entry, null, 1));
      return { ...entry, cached: false };
    }

    const detail = text.slice(0, 400);
    if (res.status === 403 && /access denied|network settings/i.test(detail)) {
      throw new NetworkBlockedError(p.name === 'groq'
        ? 'Groq chặn mạng này — bật 4G, hoặc đặt PROVIDER=cloudflare trong .env'
        : `${p.name} blocks this network (403): ${detail}`);
    }
    // Some endpoints refuse JSON mode together with images: drop it, parse
    // the reply defensively instead, and stop asking for it.
    if ((res.status === 400 || res.status === 422) && useJsonMode && /response_format|json|unsupported|extra/i.test(detail)) {
      jsonModeRejected.add(p.url);
      useJsonMode = false;
      continue;
    }
    // A rate limit clears by waiting. A server error is retried once only:
    // Workers AI can take a minute to fail, and a provider that is down
    // should surface quickly, not after minutes of silent retries.
    if ((res.status === 429 && attempt < 3) || (res.status >= 500 && attempt < 1)) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * (attempt + 1));
      continue;
    }
    const err = new Error(`${p.name} ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
}
