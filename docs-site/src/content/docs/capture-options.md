---
title: Capture options
description: How this deployment decides what BrowserHive captures — formats and signing come from the environment.
---

capture-ledger does not capture anything itself, and since the CLI was removed it does
not talk to BrowserHive either: the Windmill flow submits. What is left here is
**one decision** — which formats to ask for, and whether to require a signature —
and capture-ledger makes it from the environment, then puts it on every dispatch.

The split is the same one the crawl API draws: **the caller decides _when_,
capture-ledger decides _what_.** Formats are a property of the deployment, not of the
request, so they are deliberately not accepted from a caller.

## Formats

Set by `CAPTURE_LEDGER_CAPTURE_FORMATS`, a comma-separated list. The default is `wacz` —
this pipeline produces replayable archives and the other formats are incidental.

```sh
CAPTURE_LEDGER_CAPTURE_FORMATS=wacz   # png, webp, html, links, mhtml, wacz
CAPTURE_LEDGER_CAPTURE_SIGNING=1      # require a wacz-auth signature; needs wacz
```

| Value   | `captureFormats` key |
| ------- | -------------------- |
| `png`   | `png`                |
| `webp`  | `webp`               |
| `html`  | `html`               |
| `links` | `links`              |
| `mhtml` | `mhtml`              |
| `wacz`  | `wacz`               |

All six keys are sent explicitly on every dispatch — **unset and `false` are not
the same thing** to BrowserHive. At least one must be true, or the server
rejects the request.

## Read once, at startup

`CAPTURE_LEDGER_CAPTURE_FORMATS` is parsed when the API starts, not per crawl. A
misspelling stops the server with the bad value named. Parsed per crawl instead,
`waxz` would surface as a scheduled crawl failing at 3am with "no capture format
enabled" — a message that never mentions the setting that caused it.

## `links` is added when the crawl follows links

A crawl with `maxDepth` above 0 gets `links: true` whatever the environment says.
Without it the first level always stops, and it stops looking as though the page
had no links at all — a configuration mistake made indistinguishable from a fact
about the site.

A depth-0 crawl does not get it. Extracting links nobody will follow only costs
the other end and the bucket.

## Signing fails the capture rather than dropping the signature

`CAPTURE_LEDGER_CAPTURE_SIGNING=1` requires `wacz` in the format list, and capture-ledger refuses
to start on the combination rather than letting the server answer
`INVALID_ARGUMENT` later.

**If the server cannot obtain a signature, the capture fails.** BrowserHive
throws before it writes the zip, so an unsigned archive is never produced in
place of a signed one. That is the intended behaviour, and it has an operational
consequence worth stating plainly: turning signing on at a deployment with no
signing service configured makes **every** capture fail.

Leaving it off leaves the decision to the server's `--signing-policy`. A
deployment running `required` signs everything without capture-ledger saying anything.

The ledger records the outcome. `archives.signed` is `true` when a signature was
obtained, `null` when none was asked for — so "did this crawl produce
evidence-grade archives" is answerable without opening a single zip.

## What runs inside the page

From BrowserHive v11.0.0 the server has **no roster of its own**: there are no
built-in behaviors and no site-specific ones. Send nothing and nothing runs inside
the page — not even the receptacle. A capture still succeeds and still produces an
archive; it just never scrolled and never triggered lazy loading.

**That is why the catalog lives here.** The only place that can hold a default is
the side that decides what a crawl runs, so capture-ledger keeps a `scripts` table
and pins its resolution onto the crawl.

The sources come from [capture-scripts](https://github.com/uraitakahito/capture-scripts),
pinned here as the `.upstream/capture-scripts` submodule. Its `catalog.json` carries what a
source cannot say about itself — the `id` and the `phase`.

```sh
# Import the catalog. Idempotent: same bytes, same version.
pnpm run scripts import .upstream/capture-scripts
pnpm run scripts list                     # what a crawl with no scriptIds will run

# One-offs and tuning still go in by hand.
pnpm run scripts add autoscroll --file ./autoscroll.js --options '{"maxSteps":60}'
pnpm run scripts disable autofetch        # out of the default set, still nameable
```

`import` has **no opinion about options**, so it never replaces a version you tuned by
hand: same source, whatever the options, is the same version. Passing `--options` is an
opinion, and that does make a new version.

`sha256` is a **generated column**: Postgres computes it from `source` and the
column cannot be written by hand. BrowserHive checks the two against each other
and rejects a mismatch with `INVALID_ARGUMENT`, so that check can never be
answering for capture-ledger's own arithmetic.

`phase` says which of BrowserHive's two injection points to use. `behavior` runs
after load, in the main frame, once, and can report through the receptacle.
`preload` runs **before navigation**, in every frame including iframes, on every
navigation, and **cannot report at all**.

### What a crawl pins

`POST /api/crawls` resolves the catalog **once**, when the crawl starts, and stores
the result — id, version, phase, source, sha256, options — on the crawl row. Later
levels reuse that; the catalog is never consulted again. Adding a version halfway
through a long crawl therefore cannot change what its later pages run.

| `scriptIds`   | What runs                                                          |
| ------------- | ------------------------------------------------------------------ |
| omitted       | The newest version of every **enabled** id, `id`-order             |
| `["b", "a"]`  | Exactly those, **in that order** — order is the instruction        |
| `[]`          | Nothing. "Use the default" and "run nothing" are different intents |
| an unknown id | **400**, naming it; no crawl is started                            |

`GET /api/crawls/:id` reports the identity of each — id, version, phase, sha256 —
and never the source. What ran in bytes is in the archive (`behaviors/custom.jsonl`
and `preload/scripts.jsonl`) and in the catalog.

## What capture-ledger still does not decide

The old CLI mapped a flag onto every field of BrowserHive's `CaptureRequest`:
`--device-pixel-ratios`, `--operation-delay-ms`, `--dismiss-banners`,
`--accept-language`, `--session`. **None of those exist any more.** Beyond
`captureFormats`, `signing` and the scripts above, capture-ledger sends nothing
about how a page is rendered — everything unsent falls to whatever that BrowserHive
server is configured to do, which is what BrowserHive's own documentation describes.

## What a caller can still set, per crawl

Pacing and reach, in the `POST /api/crawls` body — see
[Archive ledger](/capture-ledger/archive-ledger/#following-links):

| Field             | Default                             | Meaning                            |
| ----------------- | ----------------------------------- | ---------------------------------- |
| `scope`           | `same-origin`                       | `same-host` relaxes it to the host |
| `maxDepth`        | 2, or 0 with `fromTargets`          | How far to follow                  |
| `maxPages`        | 30, never below the number of seeds | Total pages                        |
| `perHostDelayMs`  | 2000                                | Gap between pages on one host      |
| `hostParallelism` | 4                                   | Distinct hosts touched at once     |
| `scriptIds`       | every enabled id, newest version    | What runs in the page (above)      |

An unknown key is **400**, not silently dropped.
