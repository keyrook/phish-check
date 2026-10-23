/**
 * The decision, in plain code: does the page's registrable domain belong to
 * the brand the page claims to be?
 *
 *   legit          the claimed brand signs in on this domain
 *   impersonation  the page claims a catalogued brand, on a domain that brand
 *                  does not use
 *   unknown        no brand, low confidence, a brand outside the catalog, or
 *                  a catalogued brand with no known domains
 */
import { getDomain } from 'tldts';

export const MIN_CONFIDENCE = 0.5;

/** eTLD+1, treating hosting suffixes (github.io, pages.dev) as public. */
export function siteOf(hostnameOrUrl) {
  const host = hostnameOrUrl.includes('://') ? new URL(hostnameOrUrl).hostname : hostnameOrUrl;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

export function judge({ url, claim, catalog, minConfidence = MIN_CONFIDENCE }) {
  const site = siteOf(url);
  const said = claim.claimed_brand;
  const seen = claim.evidence?.length ? ` (${claim.evidence.slice(0, 3).join('; ')})` : '';

  if (!said) {
    return { verdict: 'unknown', site, brand: null, reasons: ['The page shows no brand the model could name.'] };
  }
  if (claim.confidence < minConfidence) {
    return {
      verdict: 'unknown', site, brand: null,
      reasons: [`The model leans towards "${said}" but only at ${claim.confidence.toFixed(2)}, below ${minConfidence}.`],
    };
  }
  const brand = catalog.lookup(said);
  if (!brand) {
    return { verdict: 'unknown', site, brand: null, reasons: [`The page presents itself as "${said}", which is not in the catalog, so there is nothing to compare its domain with.`] };
  }
  const sites = brand.sites ?? brand.domains.map(siteOf);
  if (!sites.length) {
    return { verdict: 'unknown', site, brand: brand.slug, reasons: [`The page presents itself as ${brand.name}, but the catalog lists no domains for ${brand.name}.`] };
  }
  if (sites.includes(site)) {
    return {
      verdict: 'legit', site, brand: brand.slug,
      reasons: [`The page presents itself as ${brand.name}${seen}, and ${site} is one of ${brand.name}'s domains.`],
    };
  }
  return {
    verdict: 'impersonation', site, brand: brand.slug,
    reasons: [
      `The page presents itself as ${brand.name} at ${claim.confidence.toFixed(2)}${seen}.`,
      `It is served from ${site}, but ${brand.name} signs in on ${sites.join(', ')}.`,
    ],
  };
}
