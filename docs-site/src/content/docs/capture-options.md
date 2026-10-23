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
source cannot say about itself — the `id`, the `phase`, and for a site script its `sites`.

```sh
# Import the catalog and the receptacle's types. Idempotent: same bytes, same version.
pnpm run scripts import .upstream/capture-scripts
pnpm run scripts list                     # the newest version of each id, with its sites
pnpm run scripts list --seed https://example.com/   # what a crawl from that seed runs by default
pnpm run scripts list autoscroll --all    # every version of one id
pnpm run scripts show autoscroll --version 1   # one version's source, disabled or not
pnpm run scripts types                    # the receptacle's (__bh) types, as imported

# One-offs and tuning still go in by hand.
pnpm run scripts add autoscroll --file ./autoscroll.js --options '{"maxSteps":60}'
pnpm run scripts add example-title --file ./example-title.ts --site example.com   # a site script
pnpm run scripts disable autofetch        # out of the default set, still nameable
```

`import` has **no opinion about options**, so it never replaces a version you tuned by
hand: same source, whatever the options, is the same version. Passing `--options` is an
opinion, and that does make a new version.

`import` also copies the catalog directory's `types/host.d.ts` — the types of the receptacle
`__bh` — into `host_types`, which likewise adds a version only when the bytes change. It is a copy
for people reading the catalog; the types a crawl compiles against are ts-compile-service's own
pin, reported as `compiledWith.hostTypes`. A directory without the file is imported without
types, and `import` says so.

`sha256` is a **generated column**: Postgres computes it from `source` and the
column cannot be written by hand. BrowserHive checks the two against each other
and rejects a mismatch with `INVALID_ARGUMENT`, so that check can never be
answering for capture-ledger's own arithmetic.

`phase` says which of BrowserHive's two injection points to use. `behavior` runs
after load, in the main frame, once, and can report through the receptacle.
`preload` runs **before navigation**, in every frame including iframes, on every
navigation, and **cannot report at all**.

### Site scripts (`sites`)

A catalog entry can carry `sites`: lowercase hostnames, IDN in punycode, with no port, scheme
or `*`. A script with `sites` is a **site script**, and a crawl runs it only when one of the
crawl's seeds is on one of those hosts. The seed's hostname is compared exactly and its port is
ignored, so `example.com` and `www.example.com` are different hosts. A script without `sites`
runs anywhere, as before. `sites` is part of a version, like `options`: changing it adds a
version. The catalog format that can carry it is `capture-scripts/2` (capture-scripts v0.3.0);
`import` refuses `capture-scripts/1`, and refuses a malformed hostname before touching the database.

The rule is decided per crawl, from its seeds. A site script still runs on every page of a crawl
it was chosen for, including pages on other hosts the crawl reaches by following links. So a site
script checks `location.hostname` itself and does nothing elsewhere; capture-scripts' check
makes sure each hostname appears in the source.

### What a crawl pins

`POST /api/crawls` resolves the catalog **once**, when the crawl starts, and stores
the result — id, version, phase, source, sha256, options, sites — on the crawl row. Later
levels reuse that; the catalog is never consulted again. Adding a version halfway
through a long crawl therefore cannot change what its later pages run.

| `scripts`                                                            | What runs                                                                                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| omitted                                                              | The newest version of every **enabled** id, `id`-order, keeping those without `sites` and those whose `sites` include a seed's hostname |
| `[{"catalog": "b"}, {"catalog": "a"}]`                               | Exactly those, **in that order** — order is the instruction                                                                             |
| `[{"inline": {"name": "x", "phase": "behavior", "source": "…"}}]`    | The script you wrote, as `inline-x` version 1; never enters the catalog (below)                                                         |
| `[]`                                                                 | Nothing. "Use the default" and "run nothing" are different intents                                                                      |
| an unknown id, or the same id twice                                  | **400**, naming them (`ids`); no crawl is started                                                                                       |
| a site script whose `sites` include no seed's hostname               | **400** `site scripts need a seed on their site`, naming them (`ids`, with their sites in `hint`); no crawl is started                  |
| omitted, while every enabled script is a site script for other hosts | **400** `no default scripts for these seeds` (`hint` lists them), not "the catalog is empty"                                            |

Each element is an object with exactly one key, `catalog` or `inline`.

For catalog entries, `GET /api/crawls/:id` reports the identity — id, version, phase,
sha256 — and the `sites`, and never the source. What ran in bytes is in the archive
(`behaviors/custom.jsonl` and `preload/scripts.jsonl`) and in the catalog
([Reading a version](#reading-a-version)). An inline entry
also carries `inline` (`name`, `phase` and the source's size in UTF-8 `bytes`), still without
the source: a screen polls a running crawl every few seconds, and the source can be up to a
mebibyte. The source itself comes from `GET /api/crawls/:id/inline/:name`, as
`{ name, phase, source, sha256 }`. It is not in the catalog, and the archive holds the compiled
JavaScript, so that route is the one place to get back what you wrote. Catalog entries answer 404
there.

Once the first level has been reported, each entry also carries `jsSha256` and
`compiledWith` (`{ typescript, hostTypes }`): the hash of the JavaScript that level ran,
and what produced it, as ts-compile-service answered and the flow reported
(`POST /api/crawls/:id/pages`, `compiled`). The catalog's `sha256` is over the
TypeScript; the archive holds JavaScript; this is the link between them, written by the
ledger from the report. Every level must report the same hashes — a different one is
answered with 409, because it means the compiler changed underneath a running crawl.
Before the first report both are `null`.

### Reading a version

The catalog's sources can be read over HTTP by whoever may start a crawl:

| Route                                    | Answers                                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/scripts`                       | The newest version of every enabled id, site scripts included: `id`, `version`, `phase`, `sha256`, `sites`. A crawl with no `scripts` runs those without `sites` and those on its seeds' hosts |
| `GET /api/scripts/:id/versions`          | Every version of one id, newest first: `version`, `phase`, `sha256`, `sites`, `enabled`, `bytes`, `createdAt`. No source                                                                       |
| `GET /api/scripts/:id/versions/:version` | One version whole: the above plus `id`, `source` and `options`. Disabled versions too, since a past crawl may have run them                                                                    |
| `GET /api/host-types`                    | The newest receptacle types `import` copied: `version`, `sha256`, `createdAt`, `source`, `bytes`                                                                                               |

All four ask the crawl route's question (`can_submit` on one of the caller's organizations). No
identity is a 401; no permission is a 404, the same answer as an id or version that does not exist.
A version that is not an integer of 1 or more is a 400 before anything else. `bytes` is the size in
UTF-8. `pnpm run scripts show --version` reads through the same function as the one-version route.

**Version numbers are reused.** `add` takes the newest version plus one, so removing the newest
version and adding again gives the same number to different bytes; capture-scheduler's e2e does
exactly that on every run. To tell whether a version is the one a crawl ran, compare its `sha256`
with the one on the crawl.

### Inline scripts

Besides naming catalog entries, a `scripts` element can carry a script written on the spot:

```json
{ "inline": { "name": "close-banner", "phase": "behavior", "source": "(() => {\n  …\n})();\n" } }
```

- **It never enters the catalog.** The ledger pins it on the crawl row only, as
  `inline-<name>`, version 1, empty options, with a `sha256` the ledger computes from `source`
  (the same value the catalog's generated column would hold). The copy has the same shape as a
  catalog one, so the flow, the compiler and BrowserHive cannot tell them apart.
- **`inline-` is reserved for these.** Catalog ids may not start with it: the CLI's `add` and
  `import` refuse it, and a database CHECK refuses it last. The archive keeps only the id and the
  JavaScript, so the prefix is what says whether a script came from the catalog.
- **`name` matches `^[a-z][a-z0-9-]*$`, at most 64 characters with the prefix**, which is the id
  rule of ts-compile-service. Anything else is a 400 from `POST`.
- **It must type-check as strict TypeScript.** Each level starts with ts-compile-service checking it
  together with the catalog scripts, and a single error fails the level (the diagnostics end up in
  `error`). Wrap it in an IIFE: scripts of one level are checked as one program, so top-level names
  clash with each other and with DOM globals such as `name`. An `export` type-checks but is a syntax
  error in the page, where nothing then runs. To skip the type check, start with `// @ts-nocheck`
  (syntax is still checked).
- **The whole `POST /api/crawls` body is at most 1 MiB.** A larger one is a 413 before
  anything is checked.
- **`preload` has no host object (`__bh`).** The types show it; the page does not have it.

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

| Field             | Default                                                                       | Meaning                            |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------- |
| `scope`           | `same-origin`                                                                 | `same-host` relaxes it to the host |
| `maxDepth`        | 2, or 0 with `fromTargets`                                                    | How far to follow                  |
| `maxPages`        | 30, never below the number of seeds                                           | Total pages                        |
| `perHostDelayMs`  | 2000                                                                          | Gap between pages on one host      |
| `hostParallelism` | 4                                                                             | Distinct hosts touched at once     |
| `scripts`         | every enabled id, newest version, unless it is a site script for another host | What runs in the page (above)      |

An unknown key is **400**, not silently dropped.
