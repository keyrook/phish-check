/**
 * One page, end to end: capture → name the brand → compare domains.
 */
import { loadCatalog } from './catalog.mjs';
import { identify } from './identify.mjs';
import { judge } from './verdict.mjs';

let catalog;

/**
 * @param {{ finalUrl: string, screenshot: Buffer, signals: object }} page from capture()
 * @param {{ textOnly?: boolean }} options textOnly withholds the screenshot (the ablation)
 */
export async function checkCaptured(page, { textOnly = false } = {}) {
  catalog ??= loadCatalog();
  const claim = await identify(page.signals, textOnly ? null : page.screenshot);
  const decision = judge({ url: page.finalUrl, claim, catalog });
  return {
    url: page.finalUrl,
    ...decision,
    claim: {
      brand: claim.claimed_brand,
      confidence: claim.confidence,
      evidence: claim.evidence,
      ...(claim.parseError ? { parseError: true } : {}),
    },
    model: `${claim.provider}:${claim.model}`,
    modelMs: claim.modelMs,
    cached: claim.cached,
    usage: claim.usage,
  };
}
