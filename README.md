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

Models are reached through any OpenAI-compatible chat-completions endpoint over plain `fetch`, switched in `.env`. Groq and Cloudflare Workers AI both host Llama 4 Scout. Requests are throttled under the free-tier limits. Every answer is cached on disk under a hash of the exact request, so a rerun costs no quota.

## Use

Node 22. `playwright` is pinned to 1.63.0 and uses the Chromium build already in Playwright's cache; set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` when installing if you do not want it to fetch one.

```bash
npm install
```

```bash
cp .env.example .env   # then put a Groq key (or Cloudflare account ID and token) in it
```

```bash
npm run check -- https://github.com/login
```

```
LEGIT  github.com
  claims to be: GitHub (0.95)
  ...
```

`--text-only` withholds the screenshot; `--json` prints the full result. The exit code is 1 for `impersonation`.

```bash
npm run eval
```

This reproduces the table below. The first run opens every page in [eval/legit.json](eval/legit.json) and [eval/hard.json](eval/hard.json) and saves the captures under `.tmp/`, which git ignores. Later runs reuse them, so they make no page loads and no model calls. `npm run eval -- --estimate` prints how much data a run will use before it starts.

## Results

_Pending: filled in from the first full `npm run eval`. Every number here will come from [eval/RESULTS.md](eval/RESULTS.md), never from an estimate._

## How the evaluation is built

- **Real pages, opened only.** [eval/legit.json](eval/legit.json) has one sign-in page for every brand that the catalog marks `popular` and lists domains for, where the brand has a web sign-in page. The set was chosen by that rule, not picked for the results. Nothing is typed or submitted.
- **Each page judged twice from one answer.** The model never sees the address, so one answer per page serves two cases. Judged at its real address, the page should come out `legit`. Judged at a lookalike `.test` address such as `accounts-google.verify-login.test`, the same answer should come out `impersonation`. That second case is the real-time proxy attack above: the victim sees the genuine page on the attacker's domain. No lookalike page is built or served, and the repo contains none.
- **Hard cases** ([eval/hard.json](eval/hard.json)):
  - Brands that are in the catalog with no domains (Facebook, Instagram, OpenAI…)
  - Brands not in the catalog at all (Wells Fargo, Vietcombank, Zalo…)
  - Three local pages that name no service (a generic sign-in, a generic 2FA prompt, a generic webmail login)
  - Real sign-in pages that live on a domain the catalog does not list, such as Microsoft's work-account page on microsoftonline.com
- **Ablation.** The same captures are scored with the screenshot and without it (text only).

## Limits

_To be completed with what the run shows. Known before running:_

- **It measures the relay attack, not hand-made clones.** A spoofed case reuses the real page's pixels. A crude clone that looks different from the real page is not measured here.
- **The spoofed cases share answers with the genuine ones.** In this setup, recall on spoofed pages equals how often the model names the brand correctly at confidence ≥ 0.5. The two results are not independent.
- **The catalog decides what can be caught.** A brand with no domains in the catalog can never be flagged. A brand with a wrong domain makes its real page look like an impersonation.
- **Headless browsers meet bot checks.** Some sites show a "confirm you're human" page to headless Chromium (PayPal did). That page still carries the brand, but it is not the page a person sees.
- **Confidence is the model's own.** The 0.5 threshold was set before the run and not tuned on these results.
- **The screenshot goes to a third-party API.** It is taken before anything is typed, so it holds no password or code. It is still a picture of the page the user is on.

## Built with Llama

Built with Llama. The model is Meta's Llama 4 Scout (`llama-4-scout-17b-16e-instruct`), used through a hosted API. Llama 4 is licensed under the Llama 4 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved.

## Licence

The code is MIT. [data/catalog.json](data/catalog.json) is a snapshot of the brand catalog in [keyrook/keyrook-authenticator](https://github.com/keyrook/keyrook-authenticator), by the same author, made with `npm run catalog`.
