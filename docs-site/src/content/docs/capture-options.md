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

`png`, `webp`, `html` and `mhtml` keep what the page drew or its text as it was, so a secret's value
cannot be replaced in them. A deployment that asks for any of them cannot run a crawl that sends a
secret to be hidden: `POST /api/crawls` refuses it with `400 formats that cannot hide secrets`
([per-crawl values](#per-crawl-values)), because BrowserHive would refuse every capture of that crawl.

## Read once, at startup

`CAPTURE_LEDGER_CAPTURE_FORMATS` is parsed when the API starts, not per crawl. A
misspelling stops the server with the bad value named. Parsed per crawl instead,
`waxz` would surface as a scheduled crawl failing at 3am with "no capture format
enabled" — a message that never mentions the setting that caused it.

## `links` is always requested

Every level of every crawl gets `links: true` whatever the environment says (writing
`links` there changes nothing). Without it the links cannot be counted, and "not counted"
looks as though the page had no links at all — a configuration mistake made
indistinguishable from a fact about the site.

A depth-0 crawl gets it too: it does not follow the links, but it counts them. Reading the
already loaded DOM adds no requests to the other end. The cost is one small JSON per page
in the bucket.

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

**That is why the scripts live here.** The only place that can hold a default is
the side that decides what a crawl runs, so capture-ledger keeps a `scripts` table
and pins its resolution onto the crawl.

The sources come from [capture-scripts](https://github.com/uraitakahito/capture-scripts),
pinned here as the `.upstream/capture-scripts` submodule. Its `catalog.json` carries what a
source cannot say about itself — the `id`, the `phase`, for a site script its `sites`, and whether it
runs by default (`default`). The order of its entries is the default run order.

```sh
# Import the scripts (catalog.json) and the receptacle's types. Idempotent: same bytes, same version.
pnpm run scripts import .upstream/capture-scripts
pnpm run scripts list                     # the newest version of each id, with its sites
pnpm run scripts list --seed https://laws.e-gov.go.jp/   # what a crawl from that seed runs by default (egov-law-search from capture-scripts included)
pnpm run scripts list autoscroll --all    # every version of one id
pnpm run scripts show autoscroll --version 1   # one version's source, disabled or not
pnpm run scripts types                    # the receptacle's (__bh) types, as imported

# One-offs and tuning still go in by hand.
pnpm run scripts add autoscroll --file ./autoscroll.js --options '{"maxSteps":60}'
pnpm run scripts add my-search --file ./my-search.ts --site www.example.com   # a site script
pnpm run scripts disable autoscroll       # out of the default set, still nameable (the next import restores the catalog)
```

`import` has **no opinion about options**, so it never replaces a version you tuned by
hand: same source, whatever the options, is the same version. Passing `--options` is an
opinion, and that does make a new version.

**Whether a script runs by default is the catalog’s call.** An entry with `"default": false` is
kept out of the default set: `import` disables every version of that id, so an older version cannot
step in as the default. An entry without `default` (or with `true`) has the imported version enabled.
`enable` and `disable` by hand last until the next `import`. Today only `autofetch` is out of the
default set (capture-scripts v0.9.0): name it in `scripts` to run it.

`import` also copies `types/host.d.ts` from the same directory — the types of the receptacle
`__bh` — into `host_types`, which likewise adds a version only when the bytes change. It is a copy
for people reading the scripts; the types a crawl compiles against are ts-compile-service's own
pin, reported as `compiledWith.hostTypes`. A directory without the file is imported without
types, and `import` says so.

`sha256` is a **generated column**: Postgres computes it from `source` and the
column cannot be written by hand. BrowserHive checks the two against each other
and rejects a mismatch with `INVALID_ARGUMENT`, so that check can never be
answering for capture-ledger's own arithmetic.

`phase` says which of BrowserHive's two injection points to use. `behavior` runs
after load, in the main frame, once; through the receptacle it can write lines to the
capture's log (`__bh.log`) and state its result once (`__bh.report`, one argument since
capture-scripts v0.7.0). `preload` runs **before navigation**, in every frame including
iframes, on every navigation, and **can neither write to the log nor report**. Reading
the lines back is covered in [Pages and their capture logs](/capture-ledger/archive-ledger/#pages-and-their-capture-logs).

### Site scripts (`sites`)

A script can carry `sites`: lowercase hostnames, IDN in punycode, with no port, scheme
or `*`. A script with `sites` is a **site script**, and a crawl runs it only when one of the
crawl's seeds is on one of those hosts. The seed's hostname is compared exactly and its port is
ignored, so `example.com` and `www.example.com` are different hosts. A script without `sites`
runs anywhere, as before. `sites` is part of a version, like `options`: changing it adds a
version. The `catalog.json` format `import` reads is `capture-scripts/6` (capture-scripts v0.13.0, which
added `archive`, whether a secret's value stays in the WARC, to the declaration of
[per-crawl values](#per-crawl-values)); `import` refuses older formats, and refuses a malformed hostname or
declaration before touching the database.

The example site script in capture-scripts is `egov-law-search`, for `laws.e-gov.go.jp` (from v0.4.0). On
[e-Gov Law Search](https://laws.e-gov.go.jp/) it searches law titles for the word in the required variable
`query` within the page and reports how many laws it found and their titles. Only a crawl seeded on e-Gov Law
Search runs it by default (without `query`, the request is a 400).

The rule is decided per crawl, from its seeds. A site script still runs on every page of a crawl
it was chosen for, including pages on other hosts the crawl reaches by following links. So a site
script checks `location.hostname` itself and does nothing elsewhere. In capture-scripts you write
`if (!onSite()) return;`, and `pnpm run build` writes the `sites` from `catalog.json` into that
comparison. A script you add with `scripts add` writes the comparison itself.

### What a crawl pins

`POST /api/crawls` resolves the scripts **once**, when the crawl starts, and stores
the result — id, version, phase, source, sha256, options, sites, params — on the crawl row. Later
levels reuse that; the registered scripts are never consulted again. Adding a version halfway
through a long crawl therefore cannot change what its later pages run. The crawl pins its
[per-crawl values](#per-crawl-values) the same way: `variables` with their values, `secrets` with the
Windmill variable each name was bound to and whether its value stays in the WARC.

| `scripts`                                                            | What runs                                                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| omitted                                                              | The newest version of every **enabled** id, in catalog order, keeping those without `sites` and those whose `sites` include a seed's hostname |
| `[{"catalog": "b"}, {"catalog": "a"}]`                               | Exactly those, **in that order** — order is the instruction                                                                                   |
| `[{"inline": {"name": "x", "phase": "behavior", "source": "…"}}]`    | The script you wrote, as `inline-x` version 1; never registered (below)                                                                       |
| `[]`                                                                 | Nothing. "Use the default" and "run nothing" are different intents                                                                            |
| an unknown id, or the same id twice                                  | **400**, naming them (`ids`); no crawl is started                                                                                             |
| a site script whose `sites` include no seed's hostname               | **400** `site scripts need a seed on their site`, naming them (`ids`, with their sites in `hint` and `hints`); no crawl is started            |
| omitted, while every enabled script is a site script for other hosts | **400** `no default scripts for these seeds` (`hint` and `hints` list them), not `no scripts are registered`                                  |

Each element is an object with exactly one key, `catalog` or `inline`.

For registered scripts, `GET /api/crawls/:id` reports the identity — id, version, phase,
sha256 — and the `sites`, and never the source. What ran in bytes is in the archive
(`behaviors/custom.jsonl` and `preload/scripts.jsonl`) and in the ledger
([Reading a version](#reading-a-version)). An inline entry
also carries `inline` (`name`, `phase` and the source's size in UTF-8 `bytes`), still without
the source: [capture-workbench](https://github.com/uraitakahito/capture-workbench) polls a running crawl every few seconds, and the source can be up to a
mebibyte. The source itself comes from `GET /api/crawls/:id/inline/:name`, as
`{ name, phase, source, sha256 }`. It is never registered, and the archive holds the compiled
JavaScript, so that route is the one place to get back what you wrote. Registered scripts answer 404
there.

When a crawl failed the type check, `GET /api/crawls/:id/diagnostics` re-reads its errors. The ledger
sends the scripts pinned on the crawl to ts-compile-service again, in the shape the webhook carried,
so the service checks the same set the flow's compile step did and returns the same errors — all of
them, by line and column, as `{ typescript, diagnostics: [{ script, line, col, code, message }] }`
(an error outside the scripts, in a type library, keeps its `file` instead of a `script`). A set that
type-checks answers with an empty `diagnostics` and the `hostTypes` it was checked against. The route
needs `CAPTURE_LEDGER_TS_COMPILE_URL` — capture-scheduler's compose publishes ts-compile on the host at
`127.0.0.1:28080` — and is not served without it. It changes nothing and calls only ts-compile-service,
so it is a GET with the same permission as the crawl's other routes; an unreachable service is a 503.

`POST /api/crawls/:id/inline/:name/fix` (body `{}`) asks Claude how to fix the inline script's type
errors, and **returns only a fix that passes the same check**. The ledger re-checks the crawl's scripts
first, then sends Claude the inline script with line numbers, the scripts that run with it (to read,
not to change), the errors and the host types (`host_types`), and asks for line-range replacements
and a one-line reason per error. It applies the replacements, refuses any that add
`// @ts-nocheck`, `@ts-ignore`, `@ts-expect-error`, `as any` or `: any`, add `import` or `export`
(the script would become a module and silently not run), or replace more than half the lines (three
are always allowed) — and checks the result with ts-compile-service together with the other scripts.
A failed check goes back to Claude once more (two rounds at most), appended to the same conversation.
Nothing else is sent: no page text, no variable values, no secrets. Only types are checked; whether the
script still does what it did is for you to read in the diff.

| Answer                                                  | When                                                                                              | Claude called |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------- |
| 200 `{ rounds, source, edits, notes, compiled, usage }` | a fix passed the check (`edits` holds each replaced range, `before` and `after`)                  | yes           |
| 409 `scripts compile`                                   | the scripts type-check now — nothing to fix                                                       | no            |
| 422 `no errors in this inline script`                   | the errors are elsewhere (another script or a lib file)                                           | no            |
| 429 `claude budget exhausted`                           | the organization reached this month's limit                                                       | no            |
| 422 `no fix passed the checks`                          | two rounds did not pass (with the last errors, and the refusals in `refusals` and `refusalHints`) | yes           |
| 422 `claude refused`                                    | the request was declined for safety reasons                                                       | yes           |
| 502 `claude failed` / 503 `ts-compile unreachable`      | the API or ts-compile-service did not answer                                                      | maybe         |

Each request that called Claude leaves one row in the `derivations` table (input digest, model, prompt
version, effort, rounds, output, usage and cost), never in the WACZ. The monthly limit per organization
adds those costs up (`CAPTURE_LEDGER_CLAUDE_BUDGET_USD`, 5 by default), and is shared with the summaries of
changes since last time on scheduled runs ([scheduled crawls](/capture-ledger/schedules/); those do send the
diff of a page's text). The route exists only when
`CAPTURE_LEDGER_ANTHROPIC_API_KEY` is set, and the API refuses to start with the key but without
`CAPTURE_LEDGER_TS_COMPILE_URL`. `usage` in the answer carries the tokens and the cost (`usd`).

Once the first level has been reported, each entry also carries `jsSha256` and
`compiledWith` (`{ typescript, hostTypes }`): the hash of the JavaScript that level ran,
and what produced it, as ts-compile-service answered and the flow reported
(`POST /api/crawls/:id/pages`, `compiled`). A registered script's `sha256` is over the
TypeScript; the archive holds JavaScript; this is the link between them, written by the
ledger from the report. Every level must report the same hashes — a different one is
answered with 409, because it means the compiler changed underneath a running crawl.
Before the first report both are `null`.

### Reading a version

The registered scripts' sources can be read over HTTP by whoever may start a crawl:

| Route                                    | Answers                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/scripts`                       | One row per id, site scripts and non-default scripts included: the version that runs by default (the newest enabled one), or else the newest version with `enabled: false`. `id`, `version`, `phase`, `sha256`, `sites`, `enabled`. A crawl with no `scripts` runs the `enabled` ones without `sites` and those on its seeds' hosts. Rows come in the default run order: catalog order, then anything not in the catalog by `id` |
| `GET /api/scripts/:id/versions`          | Every version of one id, newest first: `version`, `phase`, `sha256`, `sites`, `enabled`, `bytes`, `createdAt`. No source                                                                                                                                                                                                                                                                                                         |
| `GET /api/scripts/:id/versions/:version` | One version whole: the above plus `id`, `source` and `options`. Disabled versions too, since a past crawl may have run them                                                                                                                                                                                                                                                                                                      |
| `GET /api/host-types`                    | The newest receptacle types `import` copied: `version`, `sha256`, `createdAt`, `source`, `bytes`                                                                                                                                                                                                                                                                                                                                 |
| `POST /api/scripts/check`                | The variable declarations and errors of a script still being written: `params`, `diagnostics` ([per-crawl values](#per-crawl-values)). Absent where no ts-compile-service address is set                                                                                                                                                                                                                                         |

All of them ask the crawl route's question (`can_submit` on one of the caller's organizations). No
identity is a 401; no permission is a 404, the same answer as an id or version that does not exist.
A version that is not an integer of 1 or more is a 400 before anything else. `bytes` is the size in
UTF-8. `pnpm run scripts show --version` reads through the same function as the one-version route.

**Version numbers are reused.** `add` takes the newest version plus one, so removing the newest
version and adding again gives the same number to different bytes; capture-scheduler's e2e does
exactly that on every run. To tell whether a version is the one a crawl ran, compare its `sha256`
with the one on the crawl.

### Inline scripts

Besides naming registered scripts, a `scripts` element can carry a script written on the spot:

```json
{ "inline": { "name": "close-banner", "phase": "behavior", "source": "(() => {\n  …\n})();\n" } }
```

- **It is never registered.** The ledger pins it on the crawl row only, as
  `inline-<name>`, version 1, empty options, with a `sha256` the ledger computes from `source`
  (the same value the `scripts` table's generated column would hold). The copy has the same shape as a
  registered one, so the flow, the compiler and BrowserHive cannot tell them apart.
- **`inline-` is reserved for these.** Registered ids may not start with it: the CLI's `add` and
  `import` refuse it, and a database CHECK refuses it last. The archive keeps only the id and the
  JavaScript, so the prefix is what says whether a script was registered or written on the spot.
- **`name` matches `^[a-z][a-z0-9-]*$`, at most 64 characters with the prefix**, which is the id
  rule of ts-compile-service. Anything else is a 400 from `POST`.
- **It must type-check as strict TypeScript.** Each level starts with ts-compile-service checking it
  together with the registered scripts, and a single error fails the level (the first diagnostics end up in
  `error`, cut to the ledger's 2,000 characters; `GET /api/crawls/:id/diagnostics` re-reads them all). Wrap it in an IIFE: scripts of one level are checked as one program, so top-level names
  clash with each other and with DOM globals such as `name`. An `export` fails the level with `BH0006`,
  because it would be a syntax error in the page, where nothing then runs. To skip the type check,
  start with `// @ts-nocheck` (syntax is still checked).
- **It can read [Zod](https://zod.dev/).** Start with `import { z } from "zod"` or
  `import * as z from "zod/mini"`. ts-compile-service bundles only the names in use into the
  JavaScript, which adds about 85 KB per script (15 KB for `zod/mini`), and `behaviors/custom.jsonl`
  in the WACZ keeps it at that size. A crawl still succeeds when a value has the wrong shape, so use
  `safeParse` and `__bh.log.error` rather than `parse`. `preload` cannot use it (`BH0004`).
  capture-scripts' README has the details under "Zod".
- **The whole `POST /api/crawls` body is at most 1 MiB.** A larger one is a 413 before
  anything is checked.
- **`preload` has no host object (`__bh`).** The types show it; the page does not have it.

### Per-crawl values

A script can read values that differ from crawl to crawl — a search term, an account's token. A variable
is declared inside the script; a secret is declared in `params`.

**Variables** are declared with `defineParams` in the source. A name without `.optional()` is required.

```ts
import { z } from "zod";

const { query } = defineParams(z.object({ query: z.string().min(1).describe("法令名の検索語") }));
```

They are passed in the `POST /api/crawls` body as `variables` (name → string) and **are recorded**: pinned
on the crawl row, sent with every level, written by BrowserHive into the archive's `settings.variables`, and
returned by `GET /api/crawls/:id`.

**The ledger asks ts-compile-service before it creates the row.** It sends the scripts and the names of the
variables given (not the values) to `/compile`, and pins the declarations in the answer on the row. A missing
required name is a `400 missing variables`, with no row and no run; that decision is made in one place,
ts-compile-service (`BH0001`). A name nothing declares, and a value that does not fit the declaration (`.min`,
`.max`, `.length`, `z.enum`), are a 400 too. An ordinary type error is not refused here: the row is created
and the flow's compile step fails it, because a failed row is where the fix is asked for. A script whose
declaration cannot be read (`BH0002`) also gets a row, so the same step can say why. The forms a declaration
may take are under "Per-crawl values" in capture-scripts' README.

A registered script's variables are copied into `params` in `catalog.json` as well (`GET /api/scripts` returns
them as `params`), and the workbench builds its fields from them:

```json
{
  "name": "query",
  "kind": "variable",
  "required": true,
  "summary": "法令名の検索語",
  "schema": { "type": "string", "minLength": 1 }
}
```

`POST /api/scripts/check` (`{ source, phase }` → `{ params, diagnostics }`) reads the declaration of a script
still being written. It creates no row and takes no values. `BH0001` is left out of the errors: not having
passed a value yet is not a mistake while you are still writing.

**Secrets** (`kind: "secret"`) are declared in `params`, in `catalog.json` or alongside an inline script
(variables cannot be written there). They have no field in the body. The declaration binds the name to the Windmill
secret variable `f/waggle_secrets/<name>`, which someone puts there beforehand
(`wmill variable add <value> f/waggle_secrets/<name> --secret`; capture-scheduler's docs cover where and
how). When the crawl starts, the ledger asks Windmill — over the same URL and token as the webhook —
whether the variable exists and is a secret, **without reading the value** (`variables/get` with
`decrypt_secret=false`), and pins `{ path, editedAt }` on the row, with the declaration's `archive`. The value
is read only by the flow's `crawl_host`, right before the capture; it is never in the ledger, the webhook body
or `GET /api/crawls/:id`, and the archive's `settings.secrets` holds names only. A script that writes the value
into the capture's log (`__bh.log`, `__bh.report`, an exception's message) does not leak it either: BrowserHive
replaces it with `***` **whatever its length** before keeping the line, so it is not in the `.result.json`
or the log route for the page. Only the records are covered — the page's own JavaScript can read the value,
and the site that receives it has it. Before each later level the ledger re-reads `editedAt`; a change does not
stop the crawl, but is recorded as `rotated` (the depth that noticed it and the new time).

**In the WARC the value is hidden by default** (BrowserHive v29.0.0). When a script sends it over the network
(in a URL, a header, a body) or the site sends it back, BrowserHive replaces it with `***` in the WARC records
and outside them (the document URL, the page's text and title, the snapshots, the tree, `.links.json`). It
replaces the value and its encoded forms only, not anything derived from it (a hash, a ciphertext). A
declaration that should keep the value in the WARC says so:

```json
{
  "name": "api_token",
  "kind": "secret",
  "required": true,
  "summary": "サイトの API の鍵",
  "archive": "keep"
}
```

`archive` is written only on a secret, and `"keep"` is its only value; left out, the value is hidden. The
ledger copies it onto the row (`crawls.secrets[<name>].archive`) and sends, with every level, the names whose
value stays as `secret_archive` (name → `"keep"`, `{}` when none), which `crawl_host` passes to BrowserHive as
`secretArchive`. **Only names the crawl actually sends are in it**: a secret that is not `required` and is
missing from Windmill is not sent, and neither is its `keep` (BrowserHive refuses a `secretArchive` name that
`secrets` lacks, which would fail every capture of the crawl). `crawl_host` keeps only the names it resolved,
too. The archive records which secrets stayed (`settings.secretArchive`).

BrowserHive refuses the capture before taking it when a hidden secret breaks one of its rules, and names the
secret, never the value. The ledger does not see the values, so two of them surface only on the crawl's pages
(each page fails with BrowserHive's 400): a hidden value must be at least 8 characters long (UTF-16 code
units), and the URL to capture (a seed, for one) must not contain it. Keep a short value with `"keep"`, or
make it longer. The third rule the ledger checks first: a deployment whose `CAPTURE_LEDGER_CAPTURE_FORMATS`
has `png`, `webp`, `html` or `mhtml` gets `400 formats that cannot hide secrets` for a crawl that would send a
hidden secret (a `keep` one is fine). BrowserHive also refuses web storage values (`storageValues`) with a
hidden secret; capture-ledger never asks for them and BrowserHive's default is off, but a BrowserHive deployment
that turns them on (`BROWSERHIVE_STORAGE_VALUES`) fails every page of such a crawl.

Names match `^[a-z][a-z0-9_]*$` and are at most 64 characters; a crawl takes at most 32 variables; a value
is a string of at most 4,096 characters. A declaration never carries a default: an optional variable or a
secret is `undefined` when nothing was passed, and the script falls back in its own source.

| Answer                                                                           | When                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 missing variables` (`names`, `diagnostics`)                                 | A required variable was not passed (`diagnostics` holds the `BH0001` lines and columns)                                                     |
| `400 invalid variables` (`names`, `hint`, `hints`)                               | A value does not fit the declaration (too short for `.min`, not in `z.enum`, and so on)                                                     |
| `400 unknown variables` (`names`)                                                | A passed name that no script declares (not checked while a script whose declaration cannot be read is in the list)                          |
| `400 secrets cannot be passed as variables` (`names`)                            | A passed name is declared as a secret — it would end up in the archive                                                                      |
| `400 conflicting params` (`names`)                                               | Two scripts declare the same name as different kinds or different shapes, or one keeps a secret's value (`archive`) and the other hides it  |
| `400 invalid params` (`script`, `hint`, `hints`)                                 | An inline script's `params` break the declaration rules (the same rules `import` applies); variables cannot be written there                |
| `503 ts-compile unreachable`                                                     | ts-compile-service could not be asked (its 400 and 409 count too; the log has the body, which shows a version mismatch). Nothing is started |
| `400 unknown secrets` (`secrets: [{ name, path, declaredBy }]`, `hint`, `hints`) | A `required` secret is not in Windmill. A non-required one that is missing is simply not passed                                             |
| `400 not a secret variable` (`secrets`)                                          | The Windmill variable exists but is not marked secret                                                                                       |
| `400 secrets need the windmill webhook` (`names`)                                | A script declares a secret but this deployment's webhook URL is not a flow webhook                                                          |
| `503 windmill unreachable`                                                       | Windmill could not be asked; nothing is started                                                                                             |
| `400 formats that cannot hide secrets` (`formats`, `names`, `hint`, `hints`)     | A secret the crawl would send is hidden, and this deployment's formats include `png`, `webp`, `html` or `mhtml`                             |

None of these starts a crawl. `GET /api/crawls/:id` returns `variables` (with values) and `secrets`
(`[{ name, path, editedAt, rotated, archive }]`, in name order; `archive` is `"keep"` when the value stays in
the WARC and `null` when it is hidden).

### A refusal's sentence, for people and for programs (`hint`, `hints`)

A refusal that has a `hint` has `hints` as well. `hint` is the sentence to show a person, in Japanese, and
it is the same string it has always been. `hints` holds the same content one sentence at a time, as
`[{ key, params, text }]`, so that a client (capture-workbench, for one) can write the sentence in its own
language instead of recognizing the Japanese text.

| Field    | What it holds                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`   | The sentence as it appears in `hint`. Where `hint` joins several with `/`, each one has its own entry                                                                                                                     |
| `key`    | The kind of sentence, as `<group>.<meaning>` (`params.duplicateName`, `variables.tooShort`). Absent when the entry is not a sentence to translate: a command to run, a script id with its sites, a message from a library |
| `params` | Every value written into the sentence, by name: strings, numbers and arrays of strings (a value the sentence shows in quotes is the quoted string). Absent when the sentence has none                                     |

```json
{
  "error": "invalid variables",
  "names": ["query"],
  "hint": "query は 1 字以上",
  "hints": [
    {
      "key": "variables.tooShort",
      "params": { "name": "query", "min": 1 },
      "text": "query は 1 字以上"
    }
  ]
}
```

The keys, and the value names each key takes, are one table in the code: `HINT_KEYS` in `src/types/hint.ts`.
They are a promise to whoever reads them — a published key and its value names do not change, while the
wording of `text` may. The fix route's 422 `no fix passed the checks` gives its reasons the same way:
`refusals` holds the sentences and `refusalHints` the same entries, in the same order.

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

| Field             | Default                                                                       | Meaning                                                                   |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `rules`           | `[{ "follow": "same-origin" }]`                                               | Which links to follow, capture or skip                                    |
| `maxDepth`        | 2                                                                             | How far to follow                                                         |
| `maxPages`        | 30, never below the number of seeds                                           | Total pages                                                               |
| `perHostDelayMs`  | 2000                                                                          | Gap between pages on one host                                             |
| `hostParallelism` | 4                                                                             | Distinct hosts touched at once                                            |
| `scripts`         | every enabled id, newest version, unless it is a site script for another host | What runs in the page (above)                                             |
| `variables`       | none                                                                          | Per-crawl values the chosen scripts declared ([above](#per-crawl-values)) |
| `userAgent`       | none (the browser's own value)                                                | The `User-Agent` to send ([below](#per-crawl-user-agent))                 |

An unknown key is **400**, not silently dropped.

### Per-crawl User-Agent

`userAgent` is the `User-Agent` the crawl sends. Left out, or only spaces, the browser's own value goes out
(with `HeadlessChrome`, which some sites refuse). `{chrome}` stands for the browser's own value without Headless, so
`{chrome} BrowserHive` keeps working when the browser is upgraded; BrowserHive resolves it, and the ledger keeps the
text as typed. `GET /api/crawls/:id` returns that text (`null` when none was asked for), and the value actually sent
is in the archive's `settings.userAgent`.

The form is the same as BrowserHive's contract: anything else is refused with `400 userAgent must be printable ASCII, at most 512 characters`. What the text says is up to whoever asks for it.

The word `BrowserHive` changes two things. A site can only tell that BrowserHive took the page when the text has it: `{chrome}` alone reads like an ordinary Chrome. It also decides how robots.txt is read: under `BrowserHive` (its group first, then `*`) when present as a word (`NotBrowserHiveAtAll` does not count), and under `*` otherwise.
