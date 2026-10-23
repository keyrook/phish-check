# phish-check

Does this login page belong to the brand it shows?

phish-check opens a page and asks Llama 4 Scout which brand the page claims to be. It then checks, in plain code, whether the page's domain is one that brand actually signs in on. The answer is `legit`, `impersonation` or `unknown`, with the reasons.

It is a prototype for [Keyrook Authenticator](https://github.com/keyrook/keyrook-authenticator), a browser extension that keeps 2FA codes. It answers one question: before the extension hands over a code, can it tell that the page is not who it says it is?

## Why

Two-factor codes do not stop real-time phishing. A reverse proxy such as evilginx sits between the victim and the real site and relays the genuine login page, pixel for pixel, from a domain the attacker owns. The victim types their password and then the 6-digit TOTP code. The proxy forwards both to the real site within seconds and keeps the session. The code is valid, so the real site accepts it.

The page in that attack looks right; only the domain is wrong. People are bad at noticing that. Software that holds the codes is well placed to notice. Keyrook Authenticator ships to about 100 users today. If it knows which brand a page is pretending to be, it can refuse to fill a Google code into a page that is not on google.com.

## How it works

```
URL ─► Playwright (headless Chromium)
         │  screenshot of the first screen (1280×800 JPEG)
         │  visible text that names a brand: title, headings, labels,
         │  buttons, image alt text, logo hints (all frames)
         ▼
       Llama 4 Scout ─► {"claimed_brand": "Google", "confidence": 0.95, "evidence": [...]}
         │              (never shown the URL; "no brand" is a valid answer)
         ▼
       Brand catalog (Keyrook's, 522 brands) ─► Google signs in on google.com
         │
         ▼
       Page's registrable domain (eTLD+1, via tldts) == one of the brand's?
         yes → legit      no → impersonation
         no brand / low confidence / brand not catalogued → unknown
```

Three choices matter:

- **The model never decides the verdict.** It only names the brand the page claims. The comparison with the domain is ordinary code in [src/verdict.mjs](src/verdict.mjs). Text on a hostile page can try to instruct the model. At worst that hides the brand, which gives `unknown`. It cannot argue the page into `legit`.
- **The model is not shown the address.** It judges what the person sees, not where the page lives. That keeps the claim independent of the thing it is checked against.
- **`unknown` is a first-class answer.** A page with no brand, a brand outside the catalog, or a low-confidence guess is never called `impersonation`. For a 2FA tool, a wrong block is costly: it teaches people to ignore the warning.

Models are reached through any OpenAI-compatible chat-completions endpoint over plain `fetch`, switched in `.env`. Cloudflare Workers AI hosts Llama 4 Scout. Groq was the first choice, but on 2026-10-23 its model list for a free key had no Llama 4 Scout and no Meta chat model at all. Requests are throttled under the free-tier limits. Every answer is cached on disk under a hash of the exact request, so a rerun costs no quota.

## Use

Node 22. `playwright` is pinned to 1.63.0 and uses the Chromium build already in Playwright's cache; set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` when installing if you do not want it to fetch one.

```bash
npm install
```

```bash
cp .env.example .env   # then put a Cloudflare account ID and API token in it
```

```bash
npm run doctor         # checks the settings and makes one real request before you spend quota
```

```bash
npm run check -- https://github.com/login --text-only
```

```
LEGIT  github.com
  claims to be: GitHub (1.00)
  - The page presents itself as GitHub (GitHub; Sign in to GitHub; Site name: GitHub), and github.com is one of GitHub's domains.
  capture 5576 ms · model 6765 ms when first asked (cached now) · cloudflare:@cf/meta/llama-4-scout-17b-16e-instruct
```

`--text-only` withholds the screenshot; `--json` prints the full result. The exit code is 1 for `impersonation`.

```bash
npm run eval
```

This reproduces the table below. The first run opens every page in [eval/legit.json](eval/legit.json) and [eval/hard.json](eval/hard.json) and saves the captures under `.tmp/`, which git ignores. Later runs reuse them, so they make no page loads and no model calls. `npm run eval -- --estimate` prints how much data a run will use before it starts.

## Results

Measured on 2026-10-23 with Llama 4 Scout (`@cf/meta/llama-4-scout-17b-16e-instruct`) on Cloudflare Workers AI. Every number is copied from [eval/RESULTS.md](eval/RESULTS.md), which `npm run eval` writes, and that file also lists every failure.

74 real pages were scored: 58 popular catalogued brands, 7 brands the catalog has no domains for, 6 brands outside the catalog and 3 pages with no brand. Each page was judged at its real address and, if it is a real page, at a lookalike address too: 145 cases.

| Text only (no screenshot) | |
|---|---:|
| Precision: flagged pages that were spoofed | 90.3% (56 of 62) |
| Recall: spoofed pages of catalogued brands caught | 96.6% (56 of 58) |
| Recall: all spoofed pages caught | 78.9% (56 of 71) |
| False-positive rate: genuine pages flagged | 8.1% (6 of 74) |
| Real catalogued pages confirmed `legit` | 86.2% (50 of 58) |
| Brand named correctly | 95.9% (71 of 74) |
| Model latency p50 / p95 | 10.0 s / 16.5 s |
| Page capture p50 / p95 | 8.5 s / 15.9 s |
| End to end p50 / p95 | 19.8 s / 27.3 s |

**Screenshot + text: not measured yet.** On 2026-10-23 Workers AI failed every request that carried an image after about 65 s: 503 "Unknown internal error" or 499 "Client Closed Request". It failed at every size tried (1280, 768 and 336 px wide), with and without JSON mode, on both its OpenAI-compatible and native routes. Text-only requests to the same model kept working. One image request did succeed earlier that evening: the GitHub page, in 57.7 s and 2,299 prompt tokens, named correctly. One success is not a result, so the screenshot column, and with it the ablation, stays empty until it has been run on all 74 pages.

What the failures were:

- **All six false positives were catalog gaps, not model errors.** In each case the model named the right brand, but the sign-in page was on a domain the catalog does not list:
  - Wise signs in on wise.com; the catalog has wise.design.
  - Notion on notion.com; the catalog has notion.so.
  - VK on vk.ru; the catalog has vk.com.
  - Shopee Vietnam on shopee.vn; the catalog has shopee.com.
  - Microsoft's work accounts on microsoftonline.com.
  - Anthropic's console is now platform.claude.com, branded "Claude Platform". The model called it Claude, whose catalog domain is claude.ai.
- **Two spoofed catalogued pages were missed.**
  - Cursor's sign-in page names Cursor only in its pixels; the extracted text is "Sign in / Email / Continue with email". Text alone has nothing to go on, and the screenshot is exactly what would catch it.
  - NordVPN's page calls itself "Nord Account". The model said "Nord", which the catalog does not match to "NordVPN".
- **The hard cases did what they were designed to do.** The 7 brands with no catalog domains, the 6 brands outside the catalog (TPBank, BIDV and Zalo among them) and the 3 unbranded pages all came out `unknown`. The model named every one of those brands correctly. None was flagged. Their spoofed versions also came out `unknown`, which means they were not caught. That is the price of never guessing, and it is why recall over all spoofed pages is 78.9%.

## How the evaluation is built

- **Real pages, opened only.** [eval/legit.json](eval/legit.json) has one sign-in page for every brand that the catalog marks `popular` and lists domains for, where the brand has a web sign-in page. The set was chosen by that rule, not picked for the results. Nothing is typed or submitted.
- **Each page judged twice from one answer.** The model never sees the address, so one answer per page serves two cases. Judged at its real address, the page should come out `legit`. Judged at a lookalike `.test` address such as `accounts-google.verify-login.test`, the same answer should come out `impersonation`. That second case is the real-time proxy attack above: the victim sees the genuine page on the attacker's domain. No lookalike page is built or served, and the repo contains none.
- **Hard cases** ([eval/hard.json](eval/hard.json)):
  - Brands that are in the catalog with no domains (Facebook, Instagram, OpenAI…)
  - Brands not in the catalog at all (Wells Fargo, Bank of America, TPBank, BIDV, Zalo…)
  - Three local pages that name no service (a generic sign-in, a generic 2FA prompt, a generic webmail login)
  - Real sign-in pages that live on a domain the catalog does not list, such as Microsoft's work-account page on microsoftonline.com
- **Ablation.** The same captures are scored with the screenshot and without it (text only).
- **Pages that were not sign-in pages are excluded by a fixed rule.** A page is scored only if its screenshot shows a sign-in form or sign-in choices. Every capture was checked by eye before any model answer existed. Bot walls, CDN "Access Denied" pages and blank renders are listed with the reason in [eval/excluded.json](eval/excluded.json). Pages that did not load at all are listed in the results with the browser's error.

## Limits

- **It measures the relay attack, not hand-made clones.** A spoofed case reuses the real page's pixels. A crude clone that looks different from the real page is not measured here.
- **The spoofed cases share answers with the genuine ones.** In this setup, recall on spoofed pages equals how often the model names the brand correctly at confidence ≥ 0.5. The two results are not independent.
- **The catalog decides what can be caught, and today it is the weakest part.** It caused every false positive above. A brand with no domains in the catalog can never be flagged, and popular ones have none: Facebook, Instagram, OpenAI, Figma and Vercel. Before the extension blocks anything, the catalog needs every domain each brand really signs in on, country domains included (shopee.vn, vk.ru).
- **Headless browsers meet bot checks.** 12 of the 73 popular brands' sign-in pages, and Adobe's, showed headless Chromium a bot wall, an error or a blank page instead of sign-in (PayPal, GitLab, Shopify, Slack…). They are excluded, so the results say nothing about those brands. Reddit, Roblox and Steam refused connections from the network the captures were taken on, and Vietcombank's page failed to load headless. In the extension this should mostly go away, because the page is already open in the user's own browser.
- **Confidence is the model's own.** The 0.5 threshold was set before the run and not tuned on these results.
- **Too slow to sit in front of a code today.** A text-only answer took 10 s at the median on Workers AI's free tier. Capturing a page headless took another 8.5 s, and the extension would not need to do that. Ten seconds is too long to make someone wait for their code. A faster host, a smaller first pass, or checking while the page loads rather than when the code is requested are the obvious next steps; none has been measured.
- **The screenshot goes to a third-party API.** It is taken before anything is typed, so it holds no password or code. It is still a picture of the page the user is on.

## Built with Llama

Built with Llama. The model is Meta's Llama 4 Scout (`llama-4-scout-17b-16e-instruct`), used through a hosted API. Llama 4 is licensed under the Llama 4 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved.

## Licence

The code is MIT. [data/catalog.json](data/catalog.json) is a snapshot of the brand catalog in [keyrook/keyrook-authenticator](https://github.com/keyrook/keyrook-authenticator), by the same author, made with `npm run catalog`.
