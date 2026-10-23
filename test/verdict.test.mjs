import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCatalog } from '../src/catalog.mjs';
import { parseClaim } from '../src/identify.mjs';
import { judge, siteOf } from '../src/verdict.mjs';

const catalog = loadCatalog();
const claim = (claimed_brand, confidence = 0.9) => ({ claimed_brand, confidence, evidence: ['logo'] });

test('a brand on one of its own domains is legit', () => {
  assert.equal(judge({ url: 'https://accounts.google.com/signin', claim: claim('Google'), catalog }).verdict, 'legit');
  assert.equal(judge({ url: 'https://login.live.com/', claim: claim('Microsoft account'), catalog }).verdict, 'legit');
  assert.equal(judge({ url: 'https://store.steampowered.com/login/', claim: claim('Steam'), catalog }).verdict, 'legit');
});

test('a catalogued brand on someone else\'s domain is impersonation', () => {
  const r = judge({ url: 'https://accounts-google.verify-login.test/signin', claim: claim('Google'), catalog });
  assert.equal(r.verdict, 'impersonation');
  assert.equal(r.site, 'verify-login.test');
  assert.match(r.reasons.at(-1), /google\.com/);
});

test('the brand as a subdomain of the attacker\'s domain does not count', () => {
  assert.equal(judge({ url: 'https://paypal.com.secure-signin.test/', claim: claim('PayPal'), catalog }).verdict, 'impersonation');
  assert.equal(judge({ url: 'https://google.com.evil.example/', claim: claim('Google'), catalog }).verdict, 'impersonation');
});

test('shared hosting is its own site, not the host\'s brand', () => {
  assert.equal(siteOf('https://paypal-login.github.io/'), 'paypal-login.github.io');
  assert.equal(judge({ url: 'https://github-login.github.io/', claim: claim('GitHub'), catalog }).verdict, 'impersonation');
});

test('no brand, low confidence or an uncatalogued brand is unknown, never impersonation', () => {
  assert.equal(judge({ url: 'https://x.test/', claim: claim(null, 0), catalog }).verdict, 'unknown');
  assert.equal(judge({ url: 'https://x.test/', claim: claim('Google', 0.3), catalog }).verdict, 'unknown');
  assert.equal(judge({ url: 'https://x.test/', claim: claim('Vietcombank'), catalog }).verdict, 'unknown');
  // In the catalog, but with no domains to compare against.
  assert.equal(judge({ url: 'https://x.test/', claim: claim('Facebook'), catalog }).verdict, 'unknown');
});

test('catalog lookup tolerates the words models add around a name', () => {
  for (const [said, slug] of [
    ['Google', 'google'], ['Google Workspace', 'google'], ['Microsoft 365', 'microsoft'],
    ['Apple ID', 'apple'], ['X (Twitter)', 'x'], ['Twitter', 'x'], ['Amazon Web Services', 'aws'],
  ]) assert.equal(catalog.lookup(said)?.slug, slug, said);
  assert.equal(catalog.lookup('Sign in with Google'), null);
  assert.equal(catalog.lookup(''), null);
});

test('parseClaim reads JSON wrapped in prose or fences, and normalises it', () => {
  assert.deepEqual(parseClaim('```json\n{"claimed_brand":"PayPal","confidence":0.92,"evidence":["logo"]}\n```'),
    { claimed_brand: 'PayPal', confidence: 0.92, evidence: ['logo'] });
  assert.equal(parseClaim('Sure! {"claimed_brand":"Google","confidence":95,"evidence":[]}').confidence, 0.95);
  for (const none of ['unknown', 'None', 'N/A', '', null]) {
    assert.equal(parseClaim(JSON.stringify({ claimed_brand: none, confidence: 0.8 })).claimed_brand, null, String(none));
  }
  assert.equal(parseClaim('no json here').parseError, true);
  assert.equal(parseClaim('{"claimed_brand":"Google","confidence":"high"}').confidence, 0);
});
