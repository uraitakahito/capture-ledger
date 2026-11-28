---
title: Archive ledger
description: How capture-ledger records which WACZ exists, who may read it, and how it hands out signed URLs without ever giving away a bucket credential
---

capture-ledger keeps a **ledger** of the archives BrowserHive produced, and issues
short-lived signed URLs for them to callers who are allowed to read them.

The parts:

|              | Holds                                        | Where                     |
| ------------ | -------------------------------------------- | ------------------------- |
| `archives`   | Where each WACZ is — bucket, key, provenance | capture-ledger's Postgres |
| OpenFGA      | Who may read what, as relationships          | its own Postgres          |
| `fga_outbox` | Tuples waiting to be delivered to OpenFGA    | capture-ledger's Postgres |

There is deliberately no owner column on `archives`. Who may read an archive is
a relationship, and keeping a second copy of that answer next to the first is
how the two start disagreeing.

## Why the outbox exists

Inserting an archive row and writing its relationship tuples touch two
different systems — Postgres and OpenFGA's HTTP API — and no transaction spans
both. Done independently, one can land without the other, and both halves are
bad: an archive nobody can reach, or a permission pointing at a row that was
rolled back.

So the tuple write is _recorded_ as an outbox row **inside the same transaction
as the archive**. Either both land or neither does. A worker delivers it
afterwards and retries until OpenFGA accepts it.

Delivery is at-least-once, and a tuple that is already there counts as
delivered.

:::caution[OpenFGA writes are transactional across the batch]
If any tuple in a write already exists, the _entire_ request is rejected and
nothing is written — including the tuples that were new. So a batch failure
cannot simply be read as "already delivered": the worker retries tuple by tuple
in that case, or the new tuples would be lost silently.
:::

## Filling the ledger

Two paths, on purpose. (There used to be a third — the CLI polled `GetCapture`
for each capture it had submitted. Both the CLI and capture-ledger's gRPC client are
gone; the Windmill flow submits now.)

**Crawling** — a crawl registers what it captured as soon as the flow reports a
level (`src/crawl/admit-level.ts`). The level report carries where each capture's
`.result.json` was written, not the result itself, so the handler reads that
manifest back — at exactly the reported key — before registering. This is the fast
path: a page is in the ledger within one round trip of being taken.

**Reconciling** — `pnpm run fga:reconcile` registers captures that were reported
but did not make it into the ledger: reading the manifest failed, or writing the row
did. It reads the `capture_submissions` rows that carry a `manifest_key` and have no
archive yet, and fetches exactly those keys. **It does not walk the bucket.** No key
is ever reconstructed: BrowserHive (or the sink) answers each `Capture` with the
location it wrote the manifest to, the Windmill flow relays it, and the level report
records it.

`--since-days <n>` limits it to captures reported in the last `n` days:

```sh
pnpm run fga:reconcile --since-days 30
```

Each run reports `pending`, `registered`, `skipped` (a manifest the ledger does not
admit, such as a timed-out or failed capture with no archive), `missing` (nothing at the
reported key) and `counted` (pages whose capture-log counts it filled in because they had
not been read yet — see [Pages and their capture logs](#pages-and-their-capture-logs)).

**What it cannot pick up**, by construction:

- **A capture whose level report never arrived** — capture-ledger was down, or the
  flow failed before reporting. There is no `capture_submissions` row, so neither the
  organization nor the manifest key is known. Walking the bucket did not help either:
  such a manifest had no attribution and was only counted as `unattributed`.
- **A capture reported with `manifestError`.** There is no key to read. If the write
  finished after BrowserHive stopped waiting for it, the manifest exists but is not
  reachable from here.

:::note[The crawl path used to be missing]
The crawl wrote only to `crawl_pages` and `capture_submissions`; it put
**nothing in the ledger**. Crawled pages did not exist until someone ran
reconcile — they showed up in neither the picker nor search. The process that
captured them could have written the ledger itself, and instead waited for the
sweeper.
:::

Crawling is for latency. Reconciling is for correctness. A ledger with holes
nobody notices is worse than no ledger, because the holes only surface much
later as "why can't I see this archive?".

```sh
pnpm run fga:reconcile   # fill gaps from the recorded manifest keys
pnpm run fga:drain       # deliver queued tuples (the API also does this on a timer)
```

Only successful captures enter the ledger. A failed one uploaded nothing, and
recording it would let the API hand out a URL for an object that is not there —
authorization working perfectly on a 404.

**"Failed" is the flow's word, not the bucket's.** The report relays what the
flow made of BrowserHive's answer; the manifest is what BrowserHive itself wrote
next to the artifacts, and where the two disagree the manifest wins. So the
level handler looks the manifest up for **every** page that carried a task id,
and corrects the `crawl_pages` row when the manifest says the capture succeeded.

**One capture is never picked up that way: one the flow cut off.** If the flow's
deadline (`crawl_host` in [capture-scheduler](https://github.com/uraitakahito/capture-scheduler), the
Windmill flows that run crawls) runs out mid-capture, BrowserHive tears the
page down and writes a manifest whose `errorDetails.type` is `cancelled`. But the flow
never got the answer, so the report carries neither a `taskId` nor a manifest location.
There is no `capture_submissions` row, neither the level handler nor reconcile can reach
that manifest, the page stays failed (the reason is the passed deadline), and its capture
log cannot be read either (`not-captured`). A run of those in the bucket means the flow's
deadline is shorter than the pages it is being asked to capture, and the fix is on the
flow's side.

### Attribution

A manifest says nothing about organizations; BrowserHive has no such concept.
So `capture-ledger` writes a `capture_submissions` row (task id → organization) when the
level is reported, and the reconciler reads it back. That row is written for
every page carrying a task id — including the ones reported as failures, for the
reason just above. Encoding the organization inside `correlationId` instead was
rejected: a convention held only by agreement is broken by the first caller who
submits a capture by hand.

## Handing out URLs

`capture-api` serves the archive endpoints below. All require an identity; see below.

```sh
# One archive
curl -X POST http://localhost:7070/api/archives/<id>/url
# → { "url": "http://…?X-Amz-Signature=…", "expiresIn": 300 }

# The ones you may see, newest first (each row carries a screenshot hint)
curl http://localhost:7070/api/archives

# One archive's stage screenshot (WebP; see "Stage screenshots" below)
curl -o after-load.webp http://localhost:7070/api/archives/<id>/screenshots/after-load

# The captures of one URL, newest first (see "URL history and comparing two archives" below)
curl 'http://localhost:7070/api/history?url=https://www.apple.com/'

# The text diff of two captures of the same URL (<id> is now, since is before)
curl 'http://localhost:7070/api/archives/<id>/changes?since=<earlier id>'

# Have Claude summarize that diff (only where the key is set)
curl -X POST http://localhost:7070/api/archives/<id>/changes/summary \
  -H 'content-type: application/json' -d '{"since":"<earlier id>"}'
```

The shape of every request is a JSON Schema on the route, so the checking is
the contract rather than a description of it:

|                                                            |                           |                                                                                                     |
| ---------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /api/archives/:id/url`                               | `id`                      | a UUID — anything else is **400**, before authorization runs                                        |
| `GET /api/archives`                                        | `before`                  | an ISO 8601 timestamp — anything else is **400**. Omit it to start from the newest                  |
| `GET /api/archives/:id/screenshots/:stage`                 | `id`, `stage`             | a UUID, and `after-load` or `after-behaviors` — anything else is **400**, before authorization runs |
| `GET /api/history`                                         | `url`                     | at least one character; **400** when it does not read as an http(s) URL                             |
|                                                            | `before`                  | an ISO 8601 timestamp — anything else is **400**. Omit it to start from the newest                  |
| `GET /api/archives/:id/changes`                            | `id`, `since`             | both UUIDs, `since` required — anything else is **400**, before authorization runs                  |
| `POST /api/archives/:id/changes/summary`                   | `id`, `since` in the body | the same                                                                                            |
| `GET /api/crawls`                                          | `state`                   | `running` / `succeeded` / `failed` — anything else is **400**                                       |
|                                                            | `before`                  | an ISO 8601 timestamp — anything else is **400**. Omit it to start from the newest                  |
| `GET /api/crawls/:id/pages`                                | `after`                   | the previous answer's `next`: digits only, at most 18 — anything else is **400**                    |
|                                                            | `limit`                   | 1 to 500, default 100 — anything else is **400**                                                    |
| `GET /api/crawls/:id/pages/:page/log`                      | `page`                    | a page id: digits only, at most 18 — anything else is **400**, before authorization runs            |
| `GET /api/crawls/:id/pages/:page/trace`                    | `page`                    | the same                                                                                            |
| `GET /api/crawls/:id/pages/:page/trace/failure-screenshot` | `page`                    | the same                                                                                            |

`before` is a cursor: pass the `capturedAt` (or, for crawls, the `startedAt`) of the
last row you were given. `GET /api/history` is the exception: pass the answer's `next`.
Unknown query parameters are neither rejected nor dropped: they stay and are ignored.
The ones that refuse them with a 400 are `GET /api/search` (the full-text search), `GET /api/changes`,
`GET /api/history` and `GET /api/archives/:id/changes` (`POST /api/archives/:id/changes/summary`
refuses unknown keys in its body with a 400).

The crawl list is gated on `maySubmit`, not on a per-row `can_view` the way archives
are: the authorization model has no `crawl` type. `maySubmit` lets a caller through when
`can_submit` holds in any one of its organizations (`src/api/authorization.ts`), and the list
then returns the rows of every organization, so granting `submitter` is **trust that crosses
organizations**. A caller without the permission gets neither 403 nor 404 but an
**empty array**, and every row carries its `orgId` so the caller can say what it is
seeing. Rows carry both `state` and `stopReason`: `succeeded` only says that a page was
captured, so the state alone cannot tell a full walk (`completed`) from a crawl that was cut
(`max_depth`, `max_pages`) or one that found no link to follow (`no_links`). Rows also carry `maxDepth`, which tells a crawl that never meant
to follow links (depth 0).

**A `succeeded` crawl captured at least one page.** A crawl that ends with none (every page
failed or was skipped by robots) closes as `failed`, with `stopReason` `failed` and an `error`
saying how many pages failed and were skipped, and the first reason. The row also carries what
that sentence is made of, for a caller that reads it by machine: `errorKey` names the sentence
(`crawl.nothingCaptured`, `crawl.nothingCapturedBecause`, or `crawl.nothingCapturedBackfilled`
for a row an old migration closed) and `errorParams` holds the values in it (`failed`,
`skipped`, and `reason` when there is one). Both are null when the `error` is not a sentence the
ledger wrote itself — a failure the flow reported, a reason a person typed. A key and the names
of its values do not change once released. A crawl that lost only
some pages stays `succeeded`, and `pagesFailed` says how many; `failures` on
`GET /api/crawls/:id` gives the reasons (the latest 5).

`waczCount` is how many WACZ that crawl produced. `archives.crawl_id` is empty on rows
from before the column was added, so the count goes through `crawl_pages.task_id`.

A caller who may not read an archive gets **404, not 403**. A 403 would confirm
that the id names a real archive — the enumeration leak OWASP API1:2023
(Broken Object Level Authorization) warns about. "You may not see it" and "it
does not exist" have to be indistinguishable.

:::note[The signing call is the only enforcement point]
S3 checks a signature and nothing else, so once a URL is signed the decision is
made and cannot be withdrawn. Every check that is not immediately before
signing is advisory. This is also why the expiry is short: a signed URL cannot
be revoked, so its lifetime is the irreducible gap between removing someone's
access and that access actually ending.
:::

The single-archive check runs at `HIGHER_CONSISTENCY` — a cached "allow" here
would hand out a URL valid for its whole lifetime. The list does not: appearing
in a list grants nothing, since fetching any of them still has to pass the
strongly consistent check.

### Stage screenshots

This endpoint returns one stage screenshot of an archive: a picture of the capture page's viewport, in WebP (CAPTURE-8).
The picture is a WARC `resource` record inside the BrowserHive WACZ, written from BrowserHive v30.2.0 by a deployment
set to take them. The stages are `after-load` and `after-behaviors`.

```sh
curl -o after-load.webp http://localhost:7070/api/archives/<id>/screenshots/after-load
# → 200 image/webp (the body is the picture)
```

**capture-ledger does not keep the pictures.** When it inspects a WACZ ([replay bundles](#what-goes-in)), it reads
`browserhive:capture.screenshots[]` in `datapackage.json` and the index lines, works out where each picture's record
(one gzip member) sits inside the WACZ, and writes that place to `archive_screenshots` (`041`). The place is checked
on the spot by decoding it. This endpoint reads the place with **one Range read from the store**, decodes the gzip
member, checks it again (Record-ID, stage, `image/webp`, size, the WebP header) and returns it. The bytes are the
ones BrowserHive captured.

The archive list (`GET /api/archives`) and a crawl's page rows (`GET /api/crawls/:id/pages` and the rest) carry
`screenshot`, a hint about the one picture after load.

| `screenshot`                                | Meaning                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `{ "stage": "after-load", "bytes": 47692 }` | There is a picture; this endpoint returns it                                                                                          |
| `{ "stage": "after-load", "skipped": "…" }` | BrowserHive left it out; the reason as the WACZ says it (`secret`, `withheld`, `disabled`, `task-budget`, `failed`)                   |
| `{ "stage": "after-load", "problem": "…" }` | The field is there but the place could not be found (`no-index-line`, `warc-not-stored`, `record-mismatch`, …)                        |
| `null`                                      | No record: a WACZ without the field (before v30.2.0 and so on), one not inspected yet, a capture outside a crawl, a page without WACZ |

Authorization is the WACZ's own `can_view`, at higher consistency. The reasons for refusing are not told apart.

| Answer                                            | When                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 200 `image/webp`                                  | The picture, with `x-content-type-options: nosniff`, `content-security-policy: sandbox` and `cache-control: private, max-age=300, immutable`   |
| 400                                               | `id` is not a UUID, or the stage is unknown (before authorization runs)                                                                        |
| 401 `{ "error": "unauthenticated" }`              | No identity                                                                                                                                    |
| 404 `{ "error": "not found" }`                    | Not allowed, no row, a stage left out, a stage whose place was not found, or the WACZ is not in the store. The first four never read the store |
| 502 `{ "error": "storage unreachable" }`          | The store cannot be reached, or answered a different length than asked                                                                         |
| 502 `{ "error": "screenshot too large" }`         | The recorded length is over the cap (1 MiB of picture); the store is not read                                                                  |
| 502 `{ "error": "screenshot record unreadable" }` | What was read is not the named picture                                                                                                         |

`max-age=300` matches the lifetime of a signed URL: after access is withdrawn, the picture stays in the browser for
that long. A WACZ is never rewritten, so a URL's picture never changes (`immutable`). **The picture is a record inside the
WACZ; in a signed WACZ it is under the signature.**

### URL history and comparing two archives

These endpoints list the captures of one URL and compare the text of any two of them on the spot (CAPTURE-462).
The "URL history" view of capture-workbench's Changes tab reads them. The automatic comparison of scheduled runs
([changes since last time](/capture-ledger/schedules/#changes-since-last-time)) only compares a run with the
previous run of the same schedule and the same recipe. Here a person picks two captures, which may differ in
date and in recipe. Nothing is stored: the result can be rebuilt from the two WACZ files at any time.

**A caller gets in with `can_submit`, and each capture is filtered by `can_view`.** The list asks in one
batch with the default consistency (like the archive list); the diff and the summary ask about each of the two
captures with higher consistency. They return text out of a WACZ, so a permission revoked a moment ago must not
pass. Until both are known to be viewable, neither the archive rows nor the store are read.

#### `GET /api/history?url=<URL>&before=<timestamp>`

The URL is normalized by the function that normalizes crawl seeds (`parseHttpUrl`) before the lookup, so
`https://www.apple.com` finds the captures of `https://www.apple.com/`. The fragment is dropped; a trailing
slash on the path and the order of the query are left as they are. `url` in the answer is the normalized URL.

```jsonc
{
  "url": "https://www.apple.com/",
  "archives": [
    {
      "id": "<uuid>",
      "capturedAt": "2026-11-20T19:00:32.000Z",
      "objectKey": "….browserhive.wacz",
      "crawlId": "<uuid>", // null for an old row with no crawl
      "origin": {
        "kind": "schedule",
        "scheduleId": "<uuid>",
        "scheduleName": "Five sites every morning",
      },
      "recipeSha256": "<64 hex>", // null when unknown
      "browserhiveVersion": "32.0.0", // null when unknown
      "text": { "stage": "after-behaviors", "sha256": "<64 hex>", "chars": 6543 },
      "notComparable": null,
    },
  ],
  "next": null, // pass it as before to read on; null when there is no more
}
```

- Rows are ordered by capture time, newest first, at most `HISTORY_PAGE_SIZE` (`src/changes/history.ts`) per
  call. Only viewable rows are returned, so there can be fewer. **Whether there is more is told by `next`**
  (it is a timestamp even when no row of this page was viewable).
- `origin.kind` is `schedule` for a scheduled run, `manual` for a crawl started by hand, and `unknown` when the
  capture belongs to no crawl.
- `text` is the compared line, chosen as the automatic comparison chooses it: the after-behaviors snapshot, or
  the document line when there is none (`stage` is `null`). Whether a capture differs from the one before it
  shows in the `text.sha256` of neighbouring rows. capture-ledger does not count that itself, so that it never
  tells whether a capture the caller may not view has the same text.
- A row that cannot be compared has `text: null` and a reason in `notComparable`, checked in this order:

| `notComparable` | Meaning                                                      |
| --------------- | ------------------------------------------------------------ |
| `not_inspected` | Not inspected yet (`archives.inspected_at` is NULL)          |
| `withheld`      | The text of the compared line was withheld by policy         |
| `no_text`       | There is no compared line, or it has no text digest recorded |

A caller who may not start crawls gets a 200 with an empty `archives`. A `url` that does not read as an http(s)
URL is 400 `{ "error": "invalid url" }`.

The lookup uses the index on `archives.source_url_hash`, the generated column of `042`
([archives](/capture-ledger/databases/archives/)).

#### `GET /api/archives/:id/changes?since=<id of the earlier capture>`

`:id` is "now" and `since` is "before".

```jsonc
{
  "url": "https://www.apple.com/",
  "state": "diffed", // "same" | "diffed" | "not_comparable"
  "reason": null, // only for not_comparable
  "sameBy": null, // only for same: "digest" | "lines"
  "added": 33,
  "removed": 39,
  "hunks": [[" a context line", "-a removed line", "+an added line"]],
  "recipeDiffers": true, // null when either recipe is unknown
  "stageDiffers": false,
  "before": {
    "archiveId": "<uuid>",
    "objectKey": "…",
    "sourceUrl": "…",
    "capturedAt": "…",
    "browserhiveVersion": "28.0.1",
    "stage": "after-behaviors",
  },
  "after": {
    "archiveId": "<uuid>",
    "objectKey": "…",
    "sourceUrl": "…",
    "capturedAt": "…",
    "browserhiveVersion": "32.0.0",
    "stage": "after-behaviors",
  },
  "summary": null, // when there is one: { "evidence": false, "model": "…", "promptVersion": "change-pair-v1", "usd": 0.0123 }
  "significance": null,
  "headline": null,
  "quotes": [],
}
```

The comparison is the automatic one: split into lines, trim both ends, drop blank lines, and build a diff with
two lines of context.

| `state`          | Meaning                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `same`           | No diff. `sameBy: "digest"` means the text digests are equal (**the store is not read**); `"lines"` means only blank lines and indentation differed |
| `diffed`         | There is a diff. `hunks` has the shape of a page in `GET /api/crawls/:id/changes`                                                                   |
| `not_comparable` | Cannot be compared; `reason` says why. "Now" is checked first, and the first reason found is given                                                  |

| `reason`        | Meaning                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_inspected` | As `notComparable` in the list                                                                                                                                                  |
| `withheld`      | The same                                                                                                                                                                        |
| `no_text`       | The same                                                                                                                                                                        |
| `wacz_missing`  | The WACZ is not in the store                                                                                                                                                    |
| `too_large`     | The product of the two line counts exceeds `MAX_LINE_PRODUCT` (`src/changes/compare.ts`), or the unpacked `pages.jsonl` exceeds `ENTRY_MAX_BYTES` (`src/archive/wacz-range.ts`) |

- `recipeDiffers` is `true` when the recipe digests of the two crawls (`crawls.recipe_sha256`) differ. The
  automatic comparison only pairs runs with the same recipe; this one compares the two anyway and says so.
- `stageDiffers` is `true` when the kinds of the compared lines differ (one is the after-behaviors snapshot,
  the other the document line). `before.stage` and `after.stage` name each compared line (`null` for the
  document line).
- `summary`, `significance`, `headline` and `quotes` are filled only when a summary of the same diff is in the
  derived layer (`derivations`). This GET never calls Claude. **A summary is not evidence**
  (`evidence: false`).

**The WACZ is not read whole.** Only for two captures whose text digests differ, the tail of each WACZ
(`TAIL_BYTES`, in the same file) is fetched once, and the zip directory and `pages/pages.jsonl` are read out of
it. Whatever did not fit is fetched with further Range reads. The size of the WACZ comes from
`archives.wacz_bytes`; the store is not asked. Each comparison logs one line with the number of requests to
the store and the bytes fetched (`Archive pair compared`).

| Answer                                   | When                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 200                                      | Compared (two captures that cannot be compared are also a 200, with the reason)                                     |
| 400                                      | `id` or `since` is not a UUID, `since` is missing, or an unknown parameter (before authorization runs)              |
| 401 `{ "error": "unauthenticated" }`     | No identity                                                                                                         |
| 404 `{ "error": "not found" }`           | The caller may not start crawls, may not view one of the two, or one does not exist. The reasons are not told apart |
| 422 `{ "error": "different url" }`       | The `source_url` of the two differ                                                                                  |
| 502 `{ "error": "storage unreachable" }` | The store did not answer, or answered a length other than the one asked                                             |

#### `POST /api/archives/:id/changes/summary`

The body is `{ "since": "<id of the earlier capture>" }`. It has Claude summarize the diff of the same two
captures as the GET above. **A deployment without the key (`CAPTURE_LEDGER_ANTHROPIC_API_KEY`) does not have
this endpoint** (404).

It uses the function and the place (`kind = 'change'` in the derived layer) of the automatic summary, but its
own rubric (version `change-pair-v1`). The automatic summary's rubric assumes "the previous run and this run of
the same schedule and the same recipe", while two captures a person picks may differ in schedule, in recipe and
in the kind of line compared. Claude reads only the diff lines, two lines around them, and how the two captures
were taken (`recipeDiffers` and `stageDiffers`, the same as in the answer). When either is true, the rubric
tells it not to decide whether a difference comes from the site or from the recipe.

- **The same diff is never paid for twice.** When a summary with the same input digest and the same rubric
  version exists, it is returned without calling Claude (`reused: true`). A summary left by the automatic
  comparison matches too, when the diff is the same.
- The cost is counted against the organization of the crawl that made the "now" capture. The monthly limit
  (`CAPTURE_LEDGER_CLAUDE_BUDGET_USD`) is shared with the automatic summaries and with the script fixer.
- The stored row has `archive_id` set to the "now" capture, `target` set to `{ archiveId, prevArchiveId }`,
  and `created_by` set to the caller.
- When Claude does not answer or refuses, nothing is retried automatically (ask again). An attempt that was
  paid for counts against the monthly limit.

The answer is the GET's answer plus `reused` (`true` or `false`), and `summary` is always filled.

| Answer                                                                | When                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 200                                                                   | The summary is returned                                                      |
| 400, 401, 404, 502 `storage unreachable`                              | As the GET above                                                             |
| 422 `{ "error": "different url" }`                                    | As the GET above                                                             |
| 422 `{ "error": "nothing to summarize" }`                             | There is no diff (`state` is not `diffed`). Claude is not called             |
| 422 `{ "error": "no organization" }`                                  | The "now" capture belongs to no crawl, so there is no organization to charge |
| 429 `{ "error": "claude budget exhausted", "spentUsd", "budgetUsd" }` | The organization's monthly limit is reached. Claude is not called            |
| 422 `{ "error": "claude refused" }`                                   | Claude refused                                                               |
| 502 `{ "error": "claude failed" }`                                    | Claude did not answer, or the answer did not read in the agreed shape        |

## Starting a crawl

A crawl's seeds come with its request, so whoever asks decides what to capture: a person on
[capture-workbench](https://github.com/uraitakahito/capture-workbench)'s screen, or a schedule (`crawl_schedules`), which holds its request and falls due
on the ledger's own clock ([Schedules](/capture-ledger/schedules/)). The boundary is one endpoint
that starts a crawl, and one that reports on it.

```sh
curl -X POST http://localhost:7070/api/crawls \
     -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" \
     -d '{"seeds":["https://example.com/"],"maxDepth":2}'
# → 202 { "crawlId": "9072b625-…" }

curl http://localhost:7070/api/crawls/9072b625-…
# → { "state": "succeeded", "stopReason": "max_depth",
#     "seeds": ["https://…"], "pagesCaptured": 5, "pagesDiscovered": 5, "pagesFailed": 0, … }
```

A crawl runs level by level and can take tens of minutes, so there is no
synchronous form of this call. **202 means accepted, not finished.** The `crawls`
row is where the outcome lives.

:::note[Why `state` and not `status`]
Both words are used in this workspace, so the rule is worth stating: **a column
that can hold an in-progress value is called `state`.** `crawls.state` and
`crawl_pages.state` both can (`running`, `pending`); the wire's
`PageReport.status` cannot (`captured` / `failed` / `skipped` only), which is why
that one keeps `status` even though it is written into `crawl_pages.state`.
:::

### One crawl at a time

A second crawl started while one is running gets **409**, and the guarantee is a
partial unique index rather than an application flag:

```sql
CREATE UNIQUE INDEX crawls_single_active_idx ON crawls ((true)) WHERE state = 'running'
```

The reason is politeness. Per-host spacing is enforced inside one flow run, and
two crawls cannot see each other's timing, so the same host would quietly be hit
at twice the rate. A flag in the process would hold only until the day a second
process appears; Postgres holds it regardless. The route's only job is to
translate the constraint violation into a 409.

:::caution[A schedule and a manual crawl block each other]
There is one constraint, so a schedule that falls due while someone is crawling by hand waits:
its due time does not move, and it starts once the running crawl has ended
([Schedules](/capture-ledger/schedules/)). **This is right on the politeness argument** (both
would hit the same hosts).

:::

### Sending the same request twice still starts one crawl

**`POST /api/crawls` requires an `Idempotency-Key` header** (missing or malformed is a 400; 1 to 255
visible ASCII characters). The ledger remembers the first crawl it started for each organization and
key (`crawl_requests`), and answers a repeat with the same key with the same `crawlId` and a 202,
without starting a second one. A caller that sends again after a dropped response sends **the same
key**.

| What arrives                 | Answer                                                       |
| ---------------------------- | ------------------------------------------------------------ |
| a new key                    | as usual (202, 400, 409, …)                                  |
| a remembered key, same body  | the first 202 (same `crawlId`); no level is sent again       |
| a remembered key, other body | 422: a key that names two requests makes either answer a lie |
| no key                       | 400                                                          |

- **Only a started crawl (202) is remembered.** A 409 for a running crawl and a 400 for the body are
  not, so the same key starts a crawl once the running one has ended (or once the body is fixed).
- The bodies are compared with their keys sorted (a different key order in the JSON is the same request).
- A key lasts 24 hours. The next request that starts a crawl and the level clock delete older keys, and the same string
  can start a new crawl.
- The key row goes in the same transaction as the `crawls` row and its seed pages. When two
  requests with the same key arrive together, the second waits on the key's primary key for the
  first to commit and returns the first answer.
- **The key is checked after identity.** A request that does not identify itself is a 401 even
  without a key (capture-scheduler's doctor sends `{}` without identifying itself and expects a 401,
  to see that the endpoint exists).

capture-workbench's "Start" and capture-scheduler's smoke and e2e send a key. A scheduled run does not
go through the API and uses no key (the clock's `skip locked` keeps it from running twice; see
[Schedules](/capture-ledger/schedules/)). The table is [crawl_requests](/capture-ledger/databases/crawl-requests/).

### How a crawl row ends

A `running` row is closed in exactly three ways, and each one only touches a row whose
`state` is still `running`:

- **The level report says no level follows.** When a report leaves zero pages for the next
  level, the row closes; if no page was captured at all, it closes as `failed`.
- **`POST /api/crawls/:id/failed`.** The flow's closing step calls it when a level fails, with
  the failed level's `depth` and `levelKey`; it closes only for the newest level's key, and a
  failure from an older level's flow gets `{"closed": false}`. A person can call the same route
  without a key, and it closes as before.
- **Windmill did not take a level.** A 4xx from the webhook (a wrong flow path, token or
  argument; not 408 or 429) gets the same answer however often it is sent, so the row closes as
  `failed` at once, with the message on it. No connection, a timeout (10 seconds by default) or a
  5xx may still have been taken by Windmill, so the row is not closed: the ledger sends three times
  on the spot (at once, then after 2 and 4 seconds), the level clock (every 30 seconds) keeps
  sending with the same level key, and only when the level is still not taken 10 minutes after its
  row was made does the row close ([Level keys](#level-keys)).

Nothing closes a row by time once its level has been taken. The closing step uses the same
token and the same address as the level report, so a **stale token (401)**, a caller without
`can_submit` (**404**), or an API that cannot be reached makes both fail, and the row stays
`running`. Cancelling the run in Windmill means the closing step never runs. If the ledger goes
down after adding the row but before the webhook has been sent, the level row remains, and the
level clock sends it once the API is up again.

A row that blocks is named by the body of the **409** (`crawlId`, `startedAt`), and `lastJobId`
leads from it to the Windmill run. Close it with `POST /api/crawls/:id/failed`, or, when the
schedule's health is `stuck` or `overdue`, with the "close" button on the schedules tab of
capture-workbench.

Closing does not stop a flow that is still alive. That level finishes capturing and reports, but
**the ledger only records its pages and makes no next level** (CAPTURE-77). A closed row is never
turned back into `succeeded`, and counts never pile up (they are rewritten as the sum of the level
rows).

### Level keys

When the ledger decides a level (the first one in the same transaction as the crawl row, later
ones in the same transaction as the previous level's report), it makes a level row
([`crawl_levels`](/capture-ledger/databases/crawl-levels/)) and picks a random id for the Windmill
job. That id is **the level key**.

- **Sending:** the webhook gets `?job_id=<level key>`, and the flow gets it as the `level_key`
  argument. Windmill refuses a second job with an id it already has
  (`400 Bad request: Job with id … already exists`), so sending again after a timeout still gives
  one flow (that 400 counts as taken).
- **Reporting:** the flow puts the level key in the `Idempotency-Key` of the level report
  (`POST /api/crawls/:id/pages`).

| Level report that arrives                          | Answer                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| no key                                             | 400                                                                       |
| no level row (a crawl started before level rows)   | 422                                                                       |
| not this level's key                               | 422                                                                       |
| a level already reported                           | **the first answer (200)**; nothing is written and no level is sent again |
| a level being reported (within its 2-minute lease) | 409 (left to the flow's retry)                                            |
| a closed level or a closed crawl                   | 200; its pages are recorded and no next level is made                     |

The same level report arrives twice after a dropped response is retried by report_level, after
the flow is run again by hand with the same arguments, or after Windmill reruns a job whose worker
stopped. Windmill's "restart from this step" (`jobs/restart`) is not available in the Community
Edition (enterprise version only; checked on 2026-11-12).

A report is not handled in one transaction (it reads the store on the way). The level becomes
"reporting" with an attempt token and a 2-minute lease, and the final commit (the next level's
pages, reported, the rewritten totals, the next level row) goes through only while that token is
still the level's. When a second attempt takes over an expired lease and the late first attempt
finishes too, only one of them can write (the late one gets 409). The next level is read from the
`pending` rows at depth n+1, not from the rows inserted this time, so a second attempt does not read
the crawl as finished half-way. Before reading the store, closing the reported pages and writing
their [attribution](/capture-ledger/databases/capture-submissions/) go in one transaction of their
own, so a page is never left closed without the row that `reconcile` reads.

### What a caller may send

`seeds`, a non-empty array, is required: without it the answer is **400**. Alongside it:
`rules`, `maxDepth`, `maxPages`, `perHostDelayMs`,
`hostParallelism`, `scripts` (what runs in the page), `variables` (per-crawl values the
scripts declared — see [Capture options](/capture-ledger/capture-options/#per-crawl-values)) and
`userAgent` and `recordRandom` (see the same page).
An unknown key is **400**, not silently dropped.

Capture formats are deliberately not accepted from the caller: they are part of
what this deployment does, so they come from the environment.

```sh
CAPTURE_LEDGER_CAPTURE_FORMATS=wacz   # comma separated: png,webp,html,links,mhtml,wacz
CAPTURE_LEDGER_CAPTURE_SIGNING=1      # require a wacz-auth signature; needs wacz
```

Both are read and checked **at startup**, so a misspelling stops the server with
the bad value named. Read per-crawl instead, a typo would surface as a scheduled
crawl failing at 3am with "no capture format enabled" — a message that never
mentions the setting that caused it. See
[Capture options](/capture-ledger/capture-options/).

### Who calls this

capture-workbench's screen, and anything else holding a token. A schedule does not call it: the
ledger's own clock starts each run, from what the schedule pinned when it passed the same checks
([Schedules](/capture-ledger/schedules/)).

The split is deliberate: **what to capture is held by a schedule (`crawl_schedules`) or by the
crawl started from the screen, and when a schedule falls due is the ledger's to decide.** The
Windmill in [capture-scheduler](https://github.com/uraitakahito/capture-scheduler) only does the
capturing: capture-ledger reaches its flow through `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` and hands it
one level at a time.

Two things a caller has to get right:

- **409 is not a failure.** It means a crawl is already going. Retrying cannot
  help — the answer stays the same until that crawl ends.
- **202 is not the end.** A crawl that fails still answered 202. Anything that
  stops at the 202 reports success for failed captures.

Running a crawl means running with a JWT — the flow reports each level back with a
Bearer token, so this holds for a crawl you start by hand too. Setting
`CAPTURE_LEDGER_OIDC_ISSUER` makes the JWT resolver take over, and the dev header stops working.
JWT beating the dev header is the point (a deployment with both configured must not fall to the
weaker one). The browser picker follows suit: under a JWT setup it asks for a token to paste
([Browsing archives](/capture-ledger/picker/)).

### Who may start one

`can_submit` on the organization, checked at `HIGHER_CONSISTENCY` so a revoked
grant takes effect immediately. A caller who may not gets **404**, for the same
reason the archive routes do.

The grant is **stored**, and that is the whole point:

```sh
pnpm run fga:grant submitter alice acme
# alice は acme のクロールを始められます (書いた: user:alice submitter organization:acme)
pnpm run fga:revoke submitter alice acme
# alice は acme のクロールを始められません (消した: user:alice submitter organization:acme)
```

The last line says whether that user may now start crawls for that organization (始められます, yes;
始められません, no). It is the answer to the same question the API asks (`can_submit`), asked again
after the write — not inferred from what was written. Revoking `submitter` from someone who also
holds `admin` still says 始められます, and adds ほかの関係で許されています ("another relation allows it")
in the parentheses, which otherwise say what was written (書いた) or deleted (消した).

The user is whatever the caller's identity says: under the dev header, the name it claims; under
JWT, the token's `sub` — not a user name. Locally, `pnpm run idp:grant` grants `submitter` on
`acme` to your [Floci](https://github.com/floci-io/floci) user's `sub` and to the app client ID the Windmill flow uses.

To check from the caller's side, ask `GET /api/me`. It answers only about the caller: the name and
organizations as resolved from the token (or headers), and `canSubmit`, the answer to the same
question the crawl routes ask:

```sh
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/me
# → {"subject":"<sub>","organizations":["acme"],"canSubmit":true,"name":"alice","client":"cli","machine":false}
```

A crawl route's 404 cannot tell "not allowed" from "no such route". This one answers
`canSubmit: false` instead of 404. `name`, `client` and `machine` are the same values a crawl row
keeps ([Recording who started it, and from where](#recording-who-started-it-and-from-where)).

### Recording who started it, and from where

Besides the subject that started it (`requested_by`, the ID used for authorization), `POST /api/crawls`
keeps three readable copies on the row. `GET /api/crawls` (the list) and `GET /api/crawls/:id` (one
crawl) return them under the same names.

| Field             | Where it comes from                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `requestedByName` | The token's `username` for a person; the app client's name for a machine (client credentials)                                              |
| `requestedClient` | Which app client the token belongs to. The name is the one written as `name=ID` in `CAPTURE_LEDGER_OIDC_CLIENT_IDS` (tokens carry no name) |
| `requestedActor`  | The name the caller wrote in the `X-Capture-ledger-Actor` header. **Declared, not verified**                                               |

Unknown values are `null` (an app client with no name, and rows older than these fields). A scheduled
run carries the schedule creator's name (`null` for schedules created before that name was kept), and
its app client and declared name are `null` ([Whose run it is](/capture-ledger/schedules/#whose-run-it-is)).
On the development-header path the name and the app client are `null`, while a declared name is still
kept when the header is sent. **None of the three is used for authorization.** When several callers
share one app client — the seats of an AI agent, for example — the token cannot say which one it was,
so a caller may add its own name in a header. Anyone can write any name, so capture-workbench labels it
as declared.

```sh
curl -X POST http://127.0.0.1:7070/api/crawls \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" -H 'x-capture-ledger-actor: swe-seat-1' \
  -d '{"seeds":["https://example.com/"],"maxDepth":0}'
```

The header takes up to 64 characters: letters, digits, `.`, `_` and `-`, starting with a letter or
digit. Anything else is a **400**, and no row is created. An empty header is the same as no header
(nothing declared). The header is not part of the
`Idempotency-Key` comparison (the digest covers the body only).

Membership cannot stand in for it. Organizations arrive as contextual tuples
built from the caller's own token, so a rule like `can_submit: member` reduces to
asking a caller who claims membership whether they are a member — always yes.
This was written that way first, and the round-trip caught it: a subject naming
an organization it had no relationship with got a 202.

The split is about where authority sits. **Who you are** — and which
organizations you belong to — is the identity provider's to assert, so it is
never stored. **What you may do** is OpenFGA's, so it is. `grant` refuses to
write `member` for exactly this reason: two homes for one fact means no answer
when they disagree.

One grant is enough to start a crawl. The crawl is attributed to the **first**
organization on the caller's identity, which need not be the one that gave the grant.

## Following links

The same endpoint, with a depth above 0, walks the links out from its seeds.
Windmill runs the walking; capture-ledger decides which links to take, what has been seen,
and when to stop. The links come from BrowserHive's `.links.json`: the `<a href>` of the top
document and of the frames its script can read (same-origin `frame` and `iframe` documents,
BrowserHive v29.1.0 and later). Links inside frames from other origins are not read.

```sh
curl -X POST http://localhost:7070/api/crawls \
     -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" \
     -d '{"seeds":["https://example.com/"],"maxDepth":2,"perHostDelayMs":2000}'
# → 202 { "crawlId": "9072b625-…" }

curl http://localhost:7070/api/crawls/9072b625-…
# → { "state": "succeeded", "stopReason": "max_pages",
#     "pagesCaptured": 6, "pagesDiscovered": 76, … }
```

Nothing here is served unless `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` and `_TOKEN` are both set.
One without the other stops the server at startup — a half-configured webhook fails
only after someone asks for a crawl, by which time a row is already open.

### Not overloading the other end

Three settings, all per crawl:

|                   | default |                                                                      |
| ----------------- | ------- | -------------------------------------------------------------------- |
| `perHostDelayMs`  | 2000    | between **finishing** one page on a host and **submitting** the next |
| `hostParallelism` | 4       | how many distinct hosts are touched at once                          |
| `maxPages`        | 30      | total pages, seed included                                           |

The delay is measured from the finish, not the submit, and that is the whole point.
How long a capture takes is not known up front — one page is two seconds, the next
is two minutes — so a gap measured from the submit says nothing about the gap the
other end feels: the next request can land the moment the previous capture ends.
The gap has to sit after the capture completes for the other end to feel it.

One capture is also not one request. The browser fetches sub-resources, so a page is
a burst of dozens from the far side. 2000 ms is chosen against that, and a
`Crawl-delay` in robots.txt wins if it is longer — a value the other end states is
not ours to shorten.

A page robots.txt disallows is skipped. Only a page that matches an
[exemption row](#exemptions-from-robotstxt) registered by an organization admin is captured anyway, and
even then robots.txt is read, `Crawl-delay` holds, and the delay on a host with an exempted page never
goes below 2000 ms. Each row has a limit per 24 hours and per crawl.

:::note[The pacing is measured, not assumed]
`crawl_pages` stores `submitted_at` and `finished_at` per page precisely so this can
be checked afterwards rather than believed:

```sql
SELECT lag(finished_at) OVER w AS prev, submitted_at
FROM crawl_pages WHERE crawl_id = $1
WINDOW w AS (PARTITION BY host ORDER BY submitted_at);
```

Every gap must be at least `per_host_delay_ms`, and none may be negative. A negative
gap means two captures on one host overlapped. Both failures look exactly like "it
ran fast" without the timestamps.
:::

### Where it stops, and why

`stopReason` is one of `completed`, `no_links`, `max_depth`, `max_pages`, or `failed`. Without it
a finished crawl cannot say whether it followed everything or was cut off. `no_links` is a crawl
asked to follow links (depth 1 or more) that ended with no link the rules let through — it never
got past its seeds. A depth-0 crawl with no links is `completed`: it was not asked to follow. `max_depth` and
`max_pages` are set only when links not yet captured were left over (reaching a limit with
nothing left is `completed`). With the default of 30 pages, `max_pages` is the ordinary
outcome — that is deliberate, so the limit is visible in normal use rather than a surprise.

`pagesCaptured` is the number of pages captured, seeds included. `pagesDiscovered` is the
number of **distinct URLs** the rules let through among the links on the captured pages, counted
for a depth-0 crawl too. It includes URLs that were not captured (deferred by robots, cut by a
limit). Seeds are not counted (a link back to a seed is not a discovery). Only a crawl whose
`linksRecorded` is `false` (one from before links were kept one row each) still has the per-level
sum, which counts a URL twice when two levels find it. `pagesFailed` is the number of pages that
could not be captured. The breakdown (captured, cut by the page or depth limit, dropped by a rule)
is on `GET /api/crawls/:id/links`, and what the rules and robots dropped is on
`GET /api/crawls/:id/decisions`.

### What gets followed

A crawl takes a list of **rules**. Each rule is an object with one key — the action —
whose value is what it matches:

```json
"rules": [
  { "skip": "ads.example.com" },
  { "skip": "https://www.example.com/search" },
  { "follow": "same-site" },
  { "capture": "any" }
]
```

| Action    | A link it matches is                 |
| --------- | ------------------------------------ |
| `follow`  | captured, and its own links are read |
| `capture` | captured; its links are not read     |
| `skip`    | not captured                         |

| Pattern                                        | Matches                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `same-origin`, `same-host`, `same-site`, `any` | Compared with the seeds: the same origin, the same host (port included), the same registrable domain, or everything                                                  |
| A lower-case host name (`ads.example.com`)     | That host and every subdomain under it, at a label boundary — not `badads.example.com`                                                                               |
| An `http(s)` URL                               | Every URL that starts with it once normalised (lower-case host, no default port). A plain prefix: `/search` matches `/searching` too; end it with `/` for a boundary |

**Rules are tried from the top, and the first one that matches decides. A link no rule
matches is skipped.** Rules are numbered from 1, as a screen numbers its rows. Leave
`rules` out and the crawl gets `[{ "follow": "same-origin" }]` — same origin as a seed,
nothing outside it. The rules are fixed on the crawl as read: a URL pattern is stored
normalised.

`same-site` is decided by the Public Suffix List in the `tldts` version the lockfile
pins, **private section included**, so `foo.github.io` and `bar.github.io` are different
sites. An IP address or `localhost` is a site of its own.

A rule list that would do something other than what it says is refused before the crawl
starts, with a **400** that names the problem:

| `error`                         | When                                                | Names                          |
| ------------------------------- | --------------------------------------------------- | ------------------------------ |
| `invalid rule patterns`         | A pattern is none of the three kinds                | `rules: [{ rule, pattern }]`   |
| `rules that can never match`    | An earlier rule matches every URL a later one would | `rules: [{ rule, coveredBy }]` |
| `seeds the rules do not follow` | A seed lands on `capture`, `skip` or no rule at all | `seeds: [url]`                 |

The shape — 1 to 32 rules, one key each, a pattern of at most 2048 characters — is the
schema's 400. "Can never match" is only claimed when it is certain: `any` covers
everything; `same-site` covers `same-host`, which covers `same-origin`; a domain covers its
subdomains, and `same-site` covers a domain on a seed's site; a URL prefix is covered by a
shorter prefix, or by a scope or domain its own URL falls in. Refusing a correct list
would be worse than letting a dead rule through.

`GET /api/crawl-rules/check` runs the same checks without starting anything — a `GET`,
because it writes nothing:

```sh
curl 'http://localhost:7070/api/crawl-rules/check?seed=https://www.example.com/&rule=follow:same-site&rule=skip:ads.example.com'
# → { "seeds": [{ "url": "https://www.example.com/", "valid": true, "site": "example.com", "followed": true }],
#     "rules": [{ "rule": 1, "action": "follow", "kind": "scope", "pattern": "same-site" },
#               { "rule": 2, "action": "skip", "kind": "domain", "pattern": "ads.example.com", "coveredBy": 1 }],
#     "ok": false }
```

Before any rule is tried, `rel="nofollow"` is honoured and only `http(s)` links are
considered. Links on a page that is not `follow` are not read at all — and a page is
judged both by the URL it was asked for and by the **final** URL it landed on after
redirects, so a link that redirects off-site cannot widen the crawl. Fragments are dropped — `#section` is a position
inside a page, not another page — but nothing else is normalised: a reordered query
string is a different URL to plenty of real servers, and taking the wrong page is
worse than taking one twice.

Deduplication is a unique index on `(crawl_id, url_hash)`, with `url_hash` a
generated `digest(url, 'sha256')` column. Discovered links are
inserted with `ON CONFLICT DO NOTHING` and **the rows that actually landed become the
next level** — so recording and deciding cannot drift apart. BrowserHive's
`rejectDuplicateUrls` is not a substitute: it only knows about pending and processing
tasks and forgets completed URLs.

### What the rules decided

Each level's report records how many distinct URLs every rule took on every host —
`crawl_decisions`, one row per depth, rule and host name. Reporting the same level again
replaces its rows instead of adding to them. Links on a page that is not `follow` are
not read, so they are not counted.

```sh
curl http://localhost:7070/api/crawls/9072b625-…/decisions
# → { "rules": [ …as fixed on the crawl… ],
#     "decisions": [{ "depth": 1, "rule": 1, "action": "skip", "hostname": "ads.example.com",
#                     "links": 12, "samples": ["https://ads.example.com/…", …] }, …],
#     "robots": [{ "hostname": "www.example.com", "pages": 1, "limited": 0,
#                  "samples": ["https://www.example.com/private"] }],
#     "robotsOverridden": [{ "exemptionId": "7", "hostname": "www.example.com", "pages": 2, "failed": 0,
#                            "samples": ["https://www.example.com/status/1", …] }] }

curl 'http://localhost:7070/api/decisions?domain=ads.example.com&days=90&action=skip'
# → { "decisions": [{ "crawlId": "…", "startedAt": "…", "seeds": [ … ], "rule": 1, "action": "skip",
#                     "pattern": "ads.example.com", "hostname": "ads.example.com", "links": 12 }, …],
#     "truncated": false }
```

Rule `0` is a link no rule matched. `robots` lists the pages robots.txt kept the crawl from
taking, so "why was this not captured" has one place to look. `limited` is how many of them matched an
[exemption row](#exemptions-from-robotstxt) that had nothing left (the page's reason is
`robots-exemption-limit`). `robotsOverridden` lists the pages robots.txt disallowed and an exemption row
exempted, per row and host name: `pages` were captured, `failed` were exempted and then failed to capture,
and a row's limits count both. Host names drop the port.
The domain query covers the host and its subdomains at a label boundary, newest crawl
first; `days` defaults to 90 and `action` to `skip`, and `truncated` says when the answer
was cut at 500 rows. Windmill keeps a run's details for 30 days at most; these rows last as
long as the crawl does.

### Every link, one row

The level report keeps every link found on a captured page, with what became of it, in
[`crawl_links`](/capture-ledger/databases/crawl-links/). It replaces the rows of this level's pages in
the same transaction that inserts the next level's pages.

```sh
curl http://localhost:7070/api/crawls/9072b625-…/links
# → { "crawlId": "…", "recorded": true,
#     "summary": { "captured": 29, "failed": 0, "skipped": 0, "pending": 0,
#                  "maxPages": 28, "maxDepth": 3, "closed": 0, "skip": 69, "nofollow": 0, "hosts": 17 },
#     "pages": [{ "id": "754", "parent": null, "depth": 0, "url": "https://…/", "title": "…", "state": "captured",
#                 "reason": null, "out": { "followed": 9, "known": 0, "maxPages": 0, "maxDepth": 0,
#                                          "closed": 0, "skip": 5, "nofollow": 0 }, "in": 0 }, …],
#     "bundles": [{ "from": "757", "outcome": "max_pages", "urls": 14 }, …],
#     "hosts": [{ "hostname": "jfdb.jp", "urls": 45 }, …],
#     "cross": [["755", "763"], …], "crossTruncated": false }

curl http://localhost:7070/api/crawls/9072b625-…/links/757
# → { "out": [{ "seq": 0, "url": "https://…/tv/trick3.htm", "text": "…", "rule": 1,
#               "outcome": "followed", "to": "781" }, …],
#     "in":  [{ "from": "754", "text": "…" }] }
```

`summary` says **what became of the distinct URLs the crawl found (seeds excluded)**. `captured`,
`failed`, `skipped` and `pending` are the states of the URLs that got a row; `maxPages`, `maxDepth` and
`closed` are why a URL the rules let through did not get one; `skip` counts the URLs a rule dropped
(`hosts` is how many host names they span). A URL counts once however many pages link to it, and a URL
with no row counts under the `outcome` of the first link that found it (shallowest level, then page id,
then position on the page). `pages[].out` and `in` count that page's links out and in, `bundles` groups
the URLs with no row by the page that first found them and the reason, and `cross` lists the edges that
are not in the tree (links to a page that already had a row; cut at 2,000, and `crossTruncated` says so).

A crawl with no link record (one from before this table) answers `recorded: false` with only its pages
and their parents (the tree). `pnpm run links:backfill --write` fills the crawls whose `.links.json`
are still in the store.

### Pages and their capture logs

Every URL a crawl touched is a `crawl_pages` row — still pending, captured, failed or
skipped — and two routes read them. Both are gated like `GET /api/crawls/:id`: `maySubmit`,
with a 404 for a caller without it, as for a crawl or a page that does not exist.

```sh
curl 'http://localhost:7070/api/crawls/9072b625-…/pages?limit=100'
# → { "pages": [{ "id": "1234", "url": "https://…", "depth": 0, "state": "captured", "reason": null,
#                 "taskId": "6f1c…", "archiveId": "a1b2…",
#                 "capturedAt": "2026-11-04T05:12:09.812Z", "bundledRev": 1,
#                 "logCounts": { "debug": 0, "info": 12, "warn": 1, "error": 0, "dropped": 0 },
#                 "robotsExemptionId": null,
#                 "screenshot": { "stage": "after-load", "bytes": 47692 } }, …],
#     "next": "1300" }

curl http://localhost:7070/api/crawls/9072b625-…/pages/1234/log
# → { "page": { …the same shape… },
#     "log": { "lines": [{ "at": "2026-11-04T05:12:04.551Z", "ms": 4522, "dpr": 1, "source": "script",
#                          "script": "egov-law-search", "level": "info", "msg": "…", "data": { … } }, …],
#              "counts": { "debug": 0, "info": 12, "warn": 1, "error": 0 }, "dropped": 0 },
#     "reason": null }
```

The list comes in the order the pages entered the crawl, `limit` at a time; pass the
previous answer's `next` as `after` for the rest (`next` is `null` at the end). The
continuation is in the body rather than a header because [capture-workbench](https://github.com/uraitakahito/capture-workbench)'s relay passes on
only the status, the content type and the body. `id` is the `bigserial` as a string, and
`reason` is `skip_reason`, so it says why a page failed as well as why it was skipped.
`robotsExemptionId` is the number (a string) of the [exemption row](#exemptions-from-robotstxt) that
exempted a page robots.txt disallowed. A page that was exempted and then failed to capture has it too; a
page that was not exempted has `null`. A page that matched a row with nothing left has `state` `skipped`
and `reason` `robots-exemption-limit`, and no number.

**capture-ledger does not keep the lines.** They are the capture's log — what the page's
scripts wrote (`__bh.log`, `__bh.report`, the exceptions they threw), the captured page's own
console, and BrowserHive's own events — which BrowserHive (from v24.0.0) puts in its answer and in
the `.result.json` next to the artifacts, with secret values replaced by `***` whatever their
length. The log route reads that file from the store each time and returns `log` exactly as
written, in the order the lines arrived. Only the counts are copied, into
`crawl_pages.log_counts`, when the level is registered (or by reconcile, when that could not read
the manifest), so the list reads no files. The copy is taken before the archive is admitted: a
timed-out or failed capture produced no WACZ and is not in the ledger, yet its lines and counts are
there — and those are the pages whose lines you most want. `logCounts` is `null` exactly when the
counts were not read from the capture's `.result.json`. Read its keys by name; their order is not
fixed (`jsonb` reorders them).

When the lines cannot be read the answer is still 200, with `"log": null` and a `reason`:

| `reason`           | Why                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `not-captured`     | No capture answer: no `taskId` (pending, skipped, cut by the flow's deadline, or refused) |
| `no-manifest`      | There was an answer, but no `.result.json` location was recorded (`manifestError`)        |
| `manifest-missing` | Nothing at the recorded location                                                          |
| `manifest-invalid` | The file is not JSON, or does not match the contract (`readManifest` refused it)          |
| `no-log`           | The file has no `log` — BrowserHive before v24.0.0 wrote it                               |

A store that cannot be reached is a 502. Each entry of `failures` in `GET /api/crawls/:id`
carries the page's `page` id, so a failure leads straight to its lines.

Two holes remain. A `timeout`, `connection` or `internal` failure is captured once more and only
the second attempt's `taskId` is recorded, so the first attempt's log is in the store but cannot be
reached from here. And the gate is `maySubmit`, which does not look at organizations: whoever may
start crawls can read every crawl's lines — what the scripts reported and what the captured pages
printed — just as with `GET /api/crawls/:id`.

### One capture's trace

One route returns what happened, and when, during a single capture. The "trace" view of
[capture-workbench](https://github.com/uraitakahito/capture-workbench) reads it.

```sh
curl http://localhost:7070/api/crawls/9072b625-…/pages/1234/trace
# → { "page": { …same shape as the list…, "submittedAt": "2026-11-04T05:12:00.012Z", "finishedAt": "2026-11-04T05:12:15.201Z" },
#     "archive": { "id": "a1b2…", "objectKey": "…/….browserhive.wacz" },
#     "capture": { "status": "success", "timestamp": "2026-11-04T05:12:15.108Z", "captureProcessingTimeMs": 14873,
#                  "httpStatusCode": 200, "settle": { "endedBy": "deadline", "waitedMs": 3105, … }, "waczStats": { … },
#                  "screenshots": [ { "stage": "after-load", "url": "urn:browserhive:screenshot:after-load:https://…/",
#                                     "date": "2026-11-04T05:12:09.120Z", "record": "urn:uuid:5b0c…", "bytes": 48213 },
#                                   { "stage": "after-behaviors", "skipped": "task-budget" } ],
#                  "failureScreenshot": false },
#     "log": { …the same object the log route returns… },
#     "trace": { "lines": [ { "kind": "request", "id": "3246.2", "hop": 0, "url": "https://…/app.js", "ms": 670,
#                              "durationMs": 97, "outcome": "finished", … }, … ],
#                "counts": { "finished": 12, "pending": 1, … }, "dropped": 0 },
#     "reason": null }
```

**capture-ledger keeps none of this.** As with the log, each call reads the capture's `.result.json` from the store.

- `page` is the list's shape plus the submit and finish times the flow measured (`submitted_at` and `finished_at` of
  `crawl_pages`).
- `capture` picks the members of `.result.json` a timeline needs: `status`, `timestamp`, `captureProcessingTimeMs`,
  `httpStatusCode`, `errorDetails`, `settle`, `waczStats`, `completeness`, `document`, `windowsNotOpened`,
  `screenshots` and `random`. Nested objects are passed through as written, and a member the capture does not have is absent
  (`failureScreenshot` is the one exception, described below). `timestamp` is when the
  capture ended, so `timestamp − captureProcessingTimeMs` is when it began. That can differ by tens of milliseconds
  from the origin of the log's `ms` (the first line's `at − ms`).
- `archive` is the WACZ's id and its key in the store. **The key is returned only when the caller may view that
  WACZ (`can_view`)**; otherwise `objectKey` is `null`. A capture without a WACZ (a timeout or a failure) has
  `archive: null`.
- A `.result.json` without a `log` (BrowserHive before v24.0.0) only makes `log` `null`; `capture` is still returned.
- `trace` is what happened to each request during the capture (one line per exchange: its start, response, timing,
  duration and outcome). BrowserHive writes it into `.result.json` from v30.0.0, for a capture that asked for a WACZ —
  a timed-out or failed capture has it too (with no WACZ, so no line names a record). capture-ledger does not pick
  members of a line; it passes the lines through as written, and their shape is BrowserHive's contract
  (`CaptureTraceLine` in the copy at `src/rpc/generated/browserhive/openapi.json`). For earlier captures, and for
  captures that did not ask for a WACZ, it is `null`. From BrowserHive v30.1.0 the same lines are also inside the BrowserHive WACZ,
  in `trace/events.jsonl` (each line gains a leading `profile`; [BrowserHive WACZ Profile](https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/) 1.23.0). **The lines inside the BrowserHive WACZ are
  the ones under the signature; the lines in this answer are a copy of them.**
- `capture.screenshots` says what became of each stage screenshot (a WebP picture of the captured page's viewport).
  BrowserHive writes it into `.result.json` from v30.2.0, for a capture that succeeded and built a WACZ (WACZ Profile
  1.24.0). A stage whose picture was kept names its record inside the BrowserHive WACZ (`url`, `date`, `record`, `bytes`); a stage
  whose picture was not kept carries only the reason (`skipped`). capture-ledger does not pick members of an entry; it
  passes the entries through as written, and their shape is BrowserHive's contract (`StageScreenshot` in the copy).
  **The pictures themselves are not in this answer.** They are inside the BrowserHive WACZ, and whoever may view the WACZ
  (`can_view`) reads them through the [stage screenshot endpoint](#stage-screenshots). For earlier captures, and for captures that did not succeed, the member is absent.
- `capture.random` sums up the random values BrowserHive noted for the page's JS (the crawl's
  [`recordRandom`](/capture-ledger/capture-options/#recording-random-values)). BrowserHive writes it into `.result.json` from
  v31.1.0, for a capture that succeeded and built a WACZ, whether or not the crawl asked: a capture that recorded has
  `recorded: true` with `documents`, `draws` and `truncated`; one that did not has `recorded: false` and the reason
  (`skipped`: `not-requested`, `withheld` or `failed`). capture-ledger passes it through as written; its shape is
  BrowserHive's contract (`CaptureRandom` in the copy). The values themselves are inside the BrowserHive WACZ, in
  `random/values.jsonl`, and the same summary is in its `datapackage.json` as `browserhive:capture.random` (WACZ Profile
  1.26.0). For earlier captures, and for captures that did not succeed, the member is absent.
- `capture.failureScreenshot` is a boolean: whether there is a screenshot of the capture's failure **that the caller
  can be given**. The member of the same name in `.result.json` is a location in the store (`s3://…`), and
  **the location is never returned**. The picture comes from [the route below](#the-screenshot-of-a-failure). It is
  `true` only when `.result.json` names a location inside the configured bucket and the caller belongs to the
  organization the capture was submitted for (the same decision the route below makes). It is `false` for a capture
  without the member, for one that names a location outside the configured bucket or one that is not `s3://`, and
  **for a caller from another organization** — who is still given the rest of the trace as before.

BrowserHive takes pictures only when its deployment says so (`BROWSERHIVE_STAGE_SCREENSHOTS`, off by default). With it
off, every entry of `screenshots` is `skipped: "disabled"` and no capture has a screenshot of its failure. This
repository's development stack turns it on (BrowserHive's environment in `docker-compose.yml`). Even when on, a capture
that was given a secret, or whose policies (`no-archive`, `no-body`, a content-type policy) matched a document, an image
or media, keeps no picture.

When it cannot be read the answer is still 200, with `capture`, `log` and `trace` `null` and a `reason`. The reasons
are the first four of the log route (`not-captured`, `no-manifest`, `manifest-missing`, `manifest-invalid`); there is
no `no-log`. A store that cannot be reached is a 502.

The gate is `maySubmit`, as for the log: whoever may start crawls can read any crawl's trace. That is wider than
the permission to read a WACZ (`can_view`), so only the WACZ's key is narrowed by `can_view`. **This answer is not
covered by a signature.** For evidence, the records inside the BrowserHive WACZ are the source.

### The screenshot of a failure

One route returns the picture (WebP) a failed capture's page was showing in its viewport when it failed. From
BrowserHive v30.2.0, a deployment that takes pictures puts it in the store next to the capture's other files, as
`.failure.webp`.

```sh
curl http://localhost:7070/api/crawls/9072b625-…/pages/1234/trace/failure-screenshot
# → { "contentType": "image/webp", "base64": "UklGR…" }
```

The answer is JSON and the picture is base64, because capture-workbench's `/api/*` relay passes only text answers.

**Only a capture that failed while it was working on the page has one.** The picture is put when the document came
back 4xx or 5xx, and when the capture failed after the document had arrived (a per-operation timeout, a failing
script), provided the capture's overall budget had time left. **A capture whose load timed out before the document
reached the page has none** (there is no saying which document the picture would be of). Neither has a capture that ran
out of its overall budget, was cancelled by its caller, lost its renderer or failed on a policy, nor one that keeps
no pictures (the conditions above). Ask this route only when the trace answer's `capture.failureScreenshot` is
`true`.

capture-ledger keeps no picture. It reads `.result.json` along the same path as the trace, then reads the location its
`failureScreenshot` names.

- It does not compose the key. The key is the named location with the bucket removed. **The bucket is checked against
  the configured one**, and a different bucket is not read (so that `.result.json` cannot choose what is read).
- It asks the store for the size before reading, and **does not read anything over 1 MiB**.
- If what it read does not begin as a WebP (`RIFF`…`WEBP`), it is not returned.

| Answer                                                      | When                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200 `{ "contentType": "image/webp", "base64": "…" }`        | the picture was returned                                                                                                                                                                                                                                                                                                         |
| 400                                                         | `id` is not a UUID, or `page` is not digits only, at most 18 (before authorization runs)                                                                                                                                                                                                                                         |
| 401 `{ "error": "unauthenticated" }`                        | no identity                                                                                                                                                                                                                                                                                                                      |
| 404 `{ "error": "not found" }`                              | there is no capture whose picture can be returned: authorization fails, no such page, the page has no capture answer, `.result.json` cannot be read, it names no picture, the location is outside the configured bucket or is not `s3://`, or the store has nothing there. **The reasons are not told apart** (the log has them) |
| 502 `{ "error": "storage unreachable" }`                    | the store cannot be reached                                                                                                                                                                                                                                                                                                      |
| 502 `{ "error": "failure screenshot too large" }`           | what is at the location is over 1 MiB                                                                                                                                                                                                                                                                                            |
| 502 `{ "error": "failure screenshot is not a WebP image" }` | what is at the location is not a WebP                                                                                                                                                                                                                                                                                            |

**The gate is narrower than the trace's.** The picture is what the captured page showed, so it is held to the same
line as the contents of a WACZ. A WACZ is narrowed by `can_view`, but a failed capture has no WACZ, so there is no
archive to ask about. The route therefore requires `maySubmit` **and that the caller belongs to the organization the
capture was submitted for** (`org_id` of [`capture_submissions`](/capture-ledger/databases/capture-submissions/)).
The row capture-ledger recorded decides the organization; the caller cannot choose it. A caller outside it gets the
same 404 as a page that does not exist, so "exists but not for you" cannot be told from "does not exist". The trace
answer's `capture.failureScreenshot` is decided on the same line, so a caller outside the organization is told `false`.

**The picture is a file outside the WACZ and is not covered by a signature.** It holds whatever the page showed, and
nothing can be taken out of it afterwards.

## Exemptions from robots.txt

Crawls obey robots.txt ([Not overloading the other end](#not-overloading-the-other-end)). For pages that still have to be captured — keeping a public post as evidence, say — an organization admin can register "capture this path pattern on this host even where robots.txt disallows it", with a reason, an expiry and the User-Agent to announce. The rows live in [`robots_exemptions`](/capture-ledger/databases/robots-exemptions/).

:::note[From v0.117.0, rows take effect on crawls]
v0.116.0 added the table and the API only. From v0.117.0, capture-ledger looks up the rows in effect each time it starts a level and hands them to the flow as the `robots_exemptions` argument ([How rows reach a crawl](#how-rows-reach-a-crawl)). The flow in capture-scheduler is what judges a page against robots.txt and the path pattern, so **this needs a capture-scheduler version that judges exemptions**. An older flow has no such input and drops the argument silently: rows may be registered, and crawls still obey robots.txt as before.
:::

What stays out is decided too: nothing here gets around a login wall, a CAPTCHA or a rate limit, and a User-Agent that poses as a browser is not accepted. Whoever registers a row checks the other side's terms of service separately.

### What a row says

| Field                     | What it holds                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orgId`                   | Whose exemption it is. Named in the body (the caller's first organization is not assumed)                                                                                                         |
| `host`                    | The host, as `example.test` or `example.test:8443`; no scheme, path or wildcard. Stored in the `url.host` form (lower case, punycode)                                                             |
| `pathPattern`             | A path pattern written the way robots.txt writes one (`*` and a trailing `$`). `/` (the whole host) when omitted. One line starting with `/`, ASCII without spaces or `#`, at most 256 characters |
| `scope`                   | `seeds` (seeds only) or `links` (followed links too)                                                                                                                                              |
| `appliesTo`               | `all` (every crawl; the default) or `human` (only crawls a person started)                                                                                                                        |
| `userAgent`               | The name to announce on this host (below)                                                                                                                                                         |
| `reason`                  | The reason, 1 to 500 characters                                                                                                                                                                   |
| `expiresAt`               | The expiry: an ISO 8601 date-time with an offset, later than now and within 90 days. To extend, register a new row                                                                                |
| `dailyLimit`, `linkLimit` | How many pages this row may exempt: per 24 hours (1 to 10000, default 100), and among the followed links of one crawl (1 to 1000, default 20)                                                     |

Within one organization and host, at most one row is in effect per path pattern, and the rows in effect share one User-Agent. A registration that breaks either is refused with 409.

### How rows reach a crawl

A row applies **only to a page that robots.txt disallows and whose URL path matches the row's pattern**. robots.txt is still read, and `Crawl-delay` still holds. Nothing changes for a page that is not disallowed (except that the host is captured under the row's User-Agent; see below).

**Which crawls.** Only rows of the crawl's organization (`crawls.org_id`) apply. On top of that, an "eligibility" is decided once when the crawl starts and kept on its row (`crawls.exemption_eligibility`).

| Eligibility | Rows that apply                 | Which crawls                                                                                                                                                          |
| ----------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human`     | All rows                        | A person started it with `POST /api/crawls` and may start crawls (`can_submit`) in the crawl's organization                                                           |
| `machine`   | Rows whose `appliesTo` is `all` | A machine subject (a client-credentials token) started it, or it is a scheduled run ([Whose run it is](/capture-ledger/schedules/#whose-run-it-is); run-now included) |
| `none`      | None (robots.txt is obeyed)     | The subject has no `can_submit` in the crawl's organization, or the crawl was started over the header identity path (`CAPTURE_LEDGER_DEV_IDENTITY=1`)                 |

Eligibility is asked separately because the crawl's organization is the first one the caller presents, which is not necessarily the one that allowed the start ([Who may start one](#who-may-start-one)). A subject presenting A and B and allowed only in B starts a crawl that belongs to A; having no permission in A, it gets `none`, and A's rows do not apply. The question is about one organization, the crawl's, and only stored relations answer it (the caller's claimed memberships are not passed along).

**Scope and depth.** A row whose `scope` is `seeds` applies to seeds (depth 0) only; a `links` row applies to seeds and to followed links.

**What is left.** For each row, what is left is counted when a level starts and handed over with it: `dailyLimit` minus the pages that row exempted in the last 24 hours and, from depth 1 on, the smaller of that and `linkLimit` minus the followed links that row exempted in this crawl. **A page that was exempted and then failed to capture counts too** (the request reached the other end). When nothing is left, a page that matches the pattern is skipped with the reason `robots-exemption-limit`.

**The User-Agent.** On a host with a row in effect for the level, every page is captured under the row's `userAgent`, including pages robots.txt does not disallow (the crawl's own `userAgent` is not used on that host). The name robots.txt is matched against follows from it. Where a page was exempted, the per-host delay never goes below 2000 ms.

**Revoking and expiry take effect from the next level that starts.** The rows looked up are kept on the level's row ([`crawl_levels`](/capture-ledger/databases/crawl-levels/), `args`), and a resend of a level (for up to 10 minutes) sends the kept arguments as they are. A level already started is not affected. A running crawl loses the row from its next level. Revoking every row makes every crawl obey robots.txt from its next level.

**The record.** An exempted page keeps the row's number on its page row (`robotsExemptionId` in [Pages and their capture logs](#pages-and-their-capture-logs), `robotsOverridden` in [What the rules decided](#what-the-rules-decided)). The WACZ keeps the declaration the flow attached to the capture request (BrowserHive's `robotsOverride`) in `datapackage.json`, under `browserhive:capture.robotsOverride`. The declaration is seven fields built from the row.

| Field         | Contents                                                             |
| ------------- | -------------------------------------------------------------------- |
| `exemptionId` | The row's number                                                     |
| `reason`      | The row's reason                                                     |
| `pathPattern` | The row's path pattern                                               |
| `scope`       | The row's scope                                                      |
| `grantedBy`   | The registrant's readable name, or the subject's ID when it has none |
| `grantedAt`   | When it was registered (ISO 8601 in UTC, ending in `Z`)              |
| `expiresAt`   | The expiry (same form)                                               |

The declaration is the requester's (capture-ledger's) statement; BrowserHive writes it without checking it. BrowserHive accepts it from v32.2.0. When the deployment's formats do not include WACZ, the flow attaches no declaration (the number on the page row stays).

### The User-Agent does not pretend

`userAgent` is required, and its form is limited to the tool's name and one comment in parentheses that holds nothing but the URL of a page describing it.

```text
BrowserHive/1.0
BrowserHive/1.0 (+https://example.test/bot)
```

- It starts with `BrowserHive/<version>`; the version is letters, digits and `.+-`, at most 32 characters.
- One optional comment, which is exactly one `+https://…` (or `+http://…`) URL. Free text is not accepted: it would let the string line up the name of another crawler or of a browser (`(compatible; Googlebot)`).
- At most 512 characters in all.
- Nowhere in it, the URL included, may the name of a browser or of a well-known crawler appear (`mozilla`, `chrome`, `safari`, `applewebkit`, `gecko`, `firefox`, `msie`, `trident`, `crios`, `fxios`, `compatible`, `google`, `bingbot`, `twitterbot`, `facebookexternalhit`, `applebot` and the like, in any case; `{chrome}`; the words `edg`, `edge`, `edga`, `edgios`, `opr`, `opera`).
- The path of the URL may not hold a letter followed by `/` and a digit. That is the form of a product token (`/Edg/131.0`), and a date or number segment (`/docs/2024`) cannot be told from it, so it is refused as well.

### API

```sh
# The list (rows in effect, expired rows, revoked rows)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/robots-exemptions
# → { "exemptions": [ { "id": "7", "orgId": "acme", "host": "example.test", …, "state": "active", "usedLast24h": 3 } ] }

# Register
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:7070/api/robots-exemptions \
  -d '{"orgId":"acme","host":"example.test","pathPattern":"/*/status/*","scope":"seeds",
       "userAgent":"BrowserHive/1.0 (+https://example.test/bot)",
       "reason":"keep a public post as evidence","expiresAt":"2026-12-28T00:00:00+09:00"}'
# → 201 and the registered row

# Revoke (the row stays; its state becomes revoked)
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/robots-exemptions/7/revoke
# → 200 and the revoked row
```

A row carries `id` (a string), `orgId`, `host`, `pathPattern`, `scope`, `appliesTo`, `userAgent`, `reason`, `dailyLimit`, `linkLimit`, `createdBy`, `createdByName`, `createdAt`, `expiresAt`, `revokedAt`, `revokedBy`, `revokedByName` and `state`. `state` is one of `active` (in effect), `expired` (past its expiry) and `revoked`. Only rows in the list carry `usedLast24h`: the number of pages that row exempted from robots.txt in the last 24 hours, the number `dailyLimit` is compared with (a page that was exempted and then failed to capture is included).

| Answer | When                                                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | No identity                                                                                                                                                                                                                  |
| 403    | Registering or revoking was asked by a machine identity, over the header identity path, or by someone who is not an admin of that organization (the phrases are below)                                                       |
| 400    | The body is wrong. `{ "error": "<why>", "field": "<field name>" }` names the first problem found. An unknown key is a 400 too                                                                                                |
| 404    | Revoking a row that does not exist. A row outside the caller's organizations gets the same answer (its existence is not revealed)                                                                                            |
| 409    | Registering overlaps a row in effect (same path pattern; the answer carries that row's `id`) or uses a different User-Agent (the answer carries the current `userAgent`). Revoking a row already revoked, or already expired |

The `error` of a 403 is a fixed phrase.

| Phrase                                                       | Meaning                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `not an organization admin`                                  | Not an admin of that organization (the same phrase when the body's `orgId` is not one of the caller's organizations) |
| `machine identities cannot manage robots exemptions`         | A machine identity (a client credentials token) cannot register or revoke                                            |
| `robots exemptions are not available with header identities` | Registering and revoking are not available over the header identity path (`CAPTURE_LEDGER_DEV_IDENTITY=1`)           |

### Who may register

- **Reading** (`GET`) is for callers with `can_submit` (may start crawls) in one of their organizations. Only those organizations' rows come back; with no such organization the list is empty.
- **Registering and revoking** is for an **admin** of that organization, and for people only. This is narrower than `can_submit`: the relation `admin` stored in OpenFGA is asked directly (the caller's claimed membership is not passed along).

Grant admin with:

```sh
pnpm run fga:grant admin <user> <org>
```

`<user>` is the caller's subject (with a JWT, the token's `sub`). An admin also has `can_submit`, so granting it lets that person start the organization's crawls too.

Machine identities and the header path are refused for these reasons. Adding an exemption is a person's decision and is not left to a tool (the narrow scope of an AI agent is refused earlier, by [the scope gate](/capture-ledger/development-environment/)). On the header path the subject itself is the caller's claim, so naming an admin's subject would pass the check. To try registering locally, use the JWT path (Floci).

## Full-text search

**Required.** The API reads `CAPTURE_LEDGER_OPENSEARCH_URL` with its other required
settings and, at startup, asks OpenSearch for the index (creating it, mapping
included, when it is missing). Without the URL, or when OpenSearch does not answer,
the API does not start. Search used to be optional: without the URL the endpoints
were not served, the crawl flow's index step took the 404 as "skipped", and every
check stayed green with no search at all.

In development `pnpm run dev:up` starts it. The step `search` starts only the
`opensearch` service of the compose profile `search` (named — without the name every
container is recreated), and the step `search-connect` waits for the cluster health
to reach yellow and writes the URL to `.env.local`. `pnpm run dev:status` says whether
it answers and how many documents the index holds; `pnpm run dev:down` stops it.

```sh
# OpenSearch alone (what the step search starts; the step skips it when 9200 answers)
pnpm run stack:up --profile search opensearch
pnpm run search:connect
# Or resume dev:up from the step search (the steps after it run too)
pnpm run dev:up --from search
```

```sh
# Index one crawl's worth (the crawl flow's last step calls this)
curl -X POST .../api/crawls/<id>/index
# → 202 { "pending": 6, "indexed": 6, "failed": 0, "pages": 12 }
# → 503 { "error": "search unavailable", … } when OpenSearch does not answer

# Query
curl ".../api/search?q=responsive"
# → { "hits": [ { "archiveId": "…", "stage": "after-load", "url": "…", "title": "responsive", … } ], "total": 2 }
```

`pending` is the crawl's archives not indexed yet and `failed` those that did not go
in. A failed archive keeps an empty `indexed_at`, so calling the endpoint again — or
`pnpm run search:reindex` — picks it up; nothing retries on its own. The crawl flow
treats `failed` above 0, a 404 and a 503 as errors.

### The text comes out of the archive

BrowserHive writes `title` and `text` into the WACZ's `pages/pages.jsonl`. The
`text` is `document.body.innerText` — **the rendered body**, not the HTML. capture-ledger
indexes that as-is. Re-deriving it from HTML would let the index disagree with
what the archive signed for.

`textWithheld` (BrowserHive's `DocumentWithheld`: `url-policy`, `content-type`,
`no-archive`, `deny` or `unattributed`) travels with it. Drop it and
**a capture that came back empty** looks identical to **a body policy refused to
store**. The first is a fault worth investigating; the second is normal.

BrowserHive writes one line of the page list for each point at which it
snapshotted the page (`after-load` once the page has loaded, `after-behaviors`
after the scripts). The line's `url` is the snapshot's urn, shaped like
`urn:browserhive:snapshot:after-load:https://…` with the document's URL at the
end. capture-ledger indexes each line as its own hit and puts the point in
`stage`. When both the before-search and after-search points of one archive
match, you get two hits. Authorization is per archive, so both get the same
answer.

From WACZ Profile 1.18.0 the first line is always the captured document's: it
has no `stage`, its `url` is the requested URL, and its title and text were read
after the scripts — close to the `after-behaviors` line again. Indexing both
would make one archive answer twice for the same words, so capture-ledger leaves
the document's line out when the archive has snapshot lines. A capture with no
snapshot at all (a withheld document, say) has only the document's line; that
line is indexed, and its `stage` is `null`.

### The index does not know who may see what

Search asks OpenSearch, then asks OpenFGA `can_view` about what came back and
drops the rest — the same shape as `GET /api/archives`.

Copying orgs or permissions into the index would filter in one query and be
faster, but then **the index becomes an authority on authorization, and one fact
has two homes**. Fix one and both still look like they work, so an authorization
bypass stays silent.

:::caution[No paging]
Ask for 50 and you may get 30: hits you may not see are dropped after the query.
`total` is the number of hits returned, not the index's raw count — the raw count
would tell how many matches sit in archives you may not see (it was returned before
CAPTURE-53). Counting only what you may see in the index means filtering before
counting, which is the "put permissions in the index" option above.
:::

### Rebuilding the index

```sh
pnpm run search:reindex                # every archive
pnpm run search:reindex --crawl <id>   # one crawl's archives
```

It clears `archives.indexed_at` and indexes the archives again, reading the ledger,
the store and OpenSearch directly (no access token). Run it when OpenSearch was
recreated — the compose service has no volume, so the index starts empty while the
ledger still says "indexed" — or after dropping the index:

```sh
# Only when you changed the mapping or the analyzer: drop the index first
curl -X DELETE http://127.0.0.1:9200/capture-pages
```

Index state is the single `archives.indexed_at` column and no body text is stored
(everything needed is derivable from the ledger row and S3). That makes changing
the analyzer or mapping a cheap decision.

capture-ledger puts the mapping down **only when it creates the index**. Change
the mapping or the analyzer and re-index without dropping the index, and the
documents land in the old mapping while OpenSearch guesses the type of any new
field (with no error).

The analyzer today is the built-in `cjk` (bigram). Kuromoji needs a plugin
install and does not run on the stock image — swap in a custom image when you
need it, then rebuild as above.

## Replay bundles

A crawl leaves one WACZ per page it captured. **A replay bundle binds them back together**: after a
level, capture-ledger writes the crawl's bundle to the store — a `replay.json` that lists every WACZ
of the crawl, and a `pages.json` that holds every line of their page lists — so that
[replay](https://github.com/uraitakahito/replayweb-player) opens the whole crawl as one archive, and a link
leads from a page in one WACZ to a page in another. The format (version 1) is replayweb-player's
`docs/replay-bundle.md`.

```sh
# For the crawl flow: after it reports a level, before it indexes the level
curl -X POST .../api/crawls/<id>/replay-bundle -H 'content-type: application/json' -d '{"depth":1}'
# → 200 { "rev": 3, "pages": 18, "members": 6, "skipped": 0, "failed": 0, "error": null,
#         "signed": false, "signError": null, "digestKey": null }
```

Each call writes a **new version** (`rev`). The crawl row hands out the number
(`crawls.replay_bundle_next_rev`, one per call, from 1), and the two objects go under
`org/<orgId>/crawls/<crawlId>/r<rev>/` in the configured bucket — the one the WACZs are in — as
`application/json`. A version is written once and never rewritten. The crawl points at the newest
version written (`crawls.replay_bundle_rev`), and **that pointer only moves forward**: the next level
is dispatched from inside the previous level's report, so the bundle for level N can finish after the
one for level N+1, and it must not take the crawl back. The body's `depth` is only recorded
(`replayBundle.depth` in `replay.json`). It is not the version, because rebuilding writes the same
depth twice.

| Field       | Meaning                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `rev`       | The version written (or tried). `null` when no WACZ went in and nothing was written                                                       |
| `pages`     | Lines in `pages.json` (`totalPages`)                                                                                                      |
| `members`   | WACZs in `resources`                                                                                                                      |
| `skipped`   | WACZs left out because they recorded nothing (below)                                                                                      |
| `failed`    | WACZs that could not be read (not in the store, not a zip, store unreachable); the next bundle tries again                                |
| `error`     | Why the bundle could not be written, or `null`                                                                                            |
| `signed`    | Whether it was signed and `replay-digest.json` written ([signing a replay bundle](#signing-a-replay-bundle))                              |
| `signError` | Why a finished crawl's bundle was not signed. `null` when it was signed, when the crawl is still running, or when no signer is configured |
| `digestKey` | The key of the `replay-digest.json` written, or `null`                                                                                    |

**A failed write is still a 200.** The reason goes into `error` and into
`crawls.replay_bundle_error`, until a later version is written. A bundle is derived from what was
captured; failing the flow's step would mark the crawl failed while its next level is already
running. 401, 404 (no `can_submit`, or no such crawl) and 400 (an id that is not a UUID, a body other
than `{depth}`) are as for the index endpoint.

### What goes in

The crawl's archives, by `archives.crawl_id` — filled when a capture is admitted (reconcile finds the
crawl through `crawl_pages.task_id`). An archive not inspected yet (`inspected_at` empty) is read
once: its sha256 and size (`resources[].hash` carries the sha256), whether `indexes/index.cdxj` is
empty, and the lines of `pages/pages.jsonl`, which go into `archive_pages` so later versions do not
read the WACZ again. A document line also gets `keys` — the requested URL and BrowserHive's
`document.url` (after redirects, from the capture's `.result.json`), normalized the way
`parseHttpUrl` does — which is what replayweb-player looks a page up by. Snapshot lines have none.

Each line also gets the sha256 and length of its `text` and the reason it was withheld
(`textWithheld`), and the archive gets the BrowserHive and Chrome versions from `browserhive:capture.build.version` and
`browserhive:capture.browser.product` in `datapackage.json`
(`035`). Changes since last time ([scheduled crawls](/capture-ledger/schedules/)) can then call a page
unchanged without opening its WACZ. The text itself is not kept in capture-ledger's database.
`pnpm run changes:backfill` fills rows older than `035`.

The same inspection also writes where the stage screenshots are, to `archive_screenshots` (`041`; see
[Stage screenshots](#stage-screenshots)). It is a separate transaction after the inspection, so a failure there does not
undo the inspection: the mark (`archives.screenshots_recorded_at`) stays empty, and `pnpm run screenshots:backfill` fills
it along with archives inspected before `041` (`--verify` writes nothing and checks the written places with Range reads
against the store).

A WACZ that recorded nothing — an empty index, or `waczStats.totalRecorded` of 0 — is left out
(`skipped`; its name and sha256 stay in `replayBundle.skippedResources`): replay would ask for a zero-length range and keep re-reading the JSON on the store's
answer, a 416. `resources` starts with the seeds' WACZs, then goes by depth and capture time — a
fixed order, not a hint: the three WACZs replay tries for something a page does not hold are picked
by name, not by this order. `initialPages`, the list replay shows first, holds 25 lines of
`pages.json` — document lines and the DOM snapshot lines (after-load and after-behaviors) alike: the
first 25 in the order replayweb-player's `/q/` answers without a query (depth, then time, then `id`). Seeds come
first, and replay reads the second page of the list from `/q/`'s 26th line, so the two meet with no
gap. A snapshot line's `isSeed` is its document line's (true at depth 0): when seeds and non-seeds
are mixed, replay lists only the `isSeed` lines by default. A line without an `id` (in a WACZ that is not a BrowserHive WACZ) gets
`<filename>#<its position>`, because replayweb-player cannot read a line whose `id` is not a string.

### Reading it back

`GET /api/crawls` and `GET /api/crawls/:id` carry `replayBundle`:
`{ key, rev, pages, builtAt, error, signedRev, digestKey, signError }` for the version the crawl
points at (`key` is the object key of its `replay.json`), or `null` when nothing was written and
nothing failed. A failure before the first version is written shows as `error` alone. `signedRev`
and `digestKey` are the newest signed version and the key of its `replay-digest.json`; **they move
forward on their own, apart from the pointer**. When `signedRev === rev`, the bundle the crawl
points at is signed. `signError` says why the pointed-at version was not signed (`null` for a
running crawl's version and on a deployment with no signer). Each page of `GET /api/crawls/:id/pages` carries
`capturedAt` and `bundledRev`, the first version that holds its WACZ: the page is in the bundle the
crawl points at when `bundledRev ≤ replayBundle.rev`.

```
http://127.0.0.1:8899/?source=/wacz/<replayBundle.key>
```

### Rebuilding a bundle

```sh
pnpm run replay-bundle:rebuild --crawl <id>
```

It writes a new version the same way, reading the ledger and the store directly (no access token).
Run it when a bundle missed something: a capture reconcile admitted after the last level, a level
whose bundle could not be written, or a crawl from before migration `027` — for that one it first
links the crawl's archives to the crawl through `crawl_pages.task_id`. It decides on signing
exactly as the API does, so **this is also how a finished crawl whose bundle went unsigned gets
signed** (it writes a new version and signs that). It exits 1 when the bundle could not be
written, when a WACZ could not be read, or when the signature did not come.

:::caution[One object lists every key of the crawl]
The bucket is read anonymously through replayweb-player's `/wacz/`, so a bundle lists every WACZ key of the
crawl in one place — the exposure each WACZ already has, gathered together. After
`pnpm run store:wipe`, `replay_bundle_key` points at nothing.
:::

### Signing a replay bundle

The bundle of a finished crawl is signed (CAPTURE-61). capture-ledger sends the sha256 of the
`replay.json` bytes to the `/sign` of [wacz-signer](https://github.com/uraitakahito/wacz-signer),
**checks the signature itself before storing it**, and writes `replay-digest.json` next to the
bundle. It has the shape of a WACZ's `datapackage-digest.json` —
`{ "path": "replay.json", "hash": "sha256:…", "signedData": { … } }` — where `hash` is the value
capture-ledger computed and `signedData` is wacz-signer's answer as it came: its nine fields
(`hash`, `created`, `software`, `version`, `signature`, `domain`, `domainCert`, `timeSignature`,
`timestampCert`).

A bundle is signed only when all three hold:

- a signer is configured (see [signer settings](#signer-settings))
- the crawl is over (`succeeded` or `failed`). The state is read in the `returning` of the update
  that hands out the version number, under the crawl row's lock — the state at the moment the
  version's contents were read
- no WACZ of the crawl is left uninspected. A WACZ that could not be inspected is not in the
  bundle, so signing would claim "these are all of the crawl's WACZs"

The bundles written level by level while a crawl runs are not signed. When a crawl is closed by
`POST /api/crawls/:id/failed`, or because its next level could not be dispatched, **capture-ledger
writes one more bundle after closing it** — closing brings no further level report, so nobody
else would (a flow that is still alive can send one anyway: [How a crawl row ends](#how-a-crawl-row-ends)).
A level report does not turn a closed crawl back into `succeeded` (the condition sits inside the row update).

The write order is `pages.json` → `replay-digest.json` → `replay.json`: by the time the entry
point appears, the digest that covers it is there too. The signature is requested outside the
transaction that hands out the version, so the crawl row is not locked while the TSA answers.

**An unsigned bundle is still written** (replay still opens it). When wacz-signer does not answer,
cannot reach its TSA (`502`), returns a signature that fails the check, or a WACZ is still
uninspected, the reason goes into `signError` and `crawls.replay_bundle_sign_error`. To sign again,
use [the rebuild tool](#rebuilding-a-bundle): it writes a new version and signs it. A digest is
never added to an earlier version's place — a version's objects are written once.

#### What it proves

The signature covers the bytes of `replay.json`, and everything worth proving about the crawl is
written inside it:

| Field                                                 | What it is                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `resources[].hash`                                    | Each WACZ's sha256 (counted when capture-ledger read it)    |
| `replayBundle.pagesHash`                              | The sha256 of the `pages.json` bytes                        |
| `replayBundle.skippedResources`                       | Name and sha256 of each WACZ left out for recording nothing |
| `replayBundle.crawlState`, `stopReason`, `finishedAt` | The crawl's state when the version was handed out           |
| `replayBundle.crawlId`, `rev`, `pagesQueryUrl`        | Which crawl, which version, and where it was put            |

So one signature lets a third party check **which WACZs, with which contents, belong to the
crawl**, and **in which state the crawl ended**. The format's `version` stays 1: fields were only
added, and replay does not read `replayBundle`.

#### What it does not prove

- **`builtAt` is only a claim of the ledger's clock.** The one trustworthy time is the
  timestamp's genTime, set by the TSA. `finishedAt` is the ledger's clock too
- "These are all of the crawl's WACZs" means as far as capture-ledger knew at that moment. A capture
  whose report never arrived (taken before a level failed) is not in it; one that reconcile admits
  later goes into the next version once you rebuild
- The signatures inside the WACZs (each WACZ's `datapackage-digest.json`) are not checked. The
  bundle's signature goes as far as "the WACZ bytes are the ones the bundle names"
- `skippedResources` holds names and hashes only, not locations
- The dev CA and TSA are for development and trusted by no one. Whom to trust is decided by
  whoever checks, through the anchors (roots) they choose
- genTime itself is not proven true. A leaked TSA key can still mint a backdated token within its
  own validity — a limit left in RFC 3161, closed only by an independent time source

#### Signer settings

| Variable                                 | Meaning                                                               |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `CAPTURE_LEDGER_SIGNER_URL`              | wacz-signer's `/sign`                                                 |
| `CAPTURE_LEDGER_SIGNER_TOKEN`            | Its bearer token                                                      |
| `CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR`     | The root the signing chain must reach (a PEM file)                    |
| `CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR` | The root the TSA's chain must reach (a PEM file)                      |
| `CAPTURE_LEDGER_SIGNER_TIMEOUT_MS`       | How long to wait for a signature (10 s; wacz-signer waits on its TSA) |
| `CAPTURE_LEDGER_OPENSSL_BIN`             | The openssl that checks the timestamp (`openssl` on `PATH`)           |

**The first four go together.** With all four, bundles are signed; with none, they are not;
**with some, the process refuses to start** — without the anchors a signature cannot be checked
before it is stored, and without the URL the anchors check nothing. It also refuses to start when
`CAPTURE_LEDGER_CAPTURE_SIGNING=1` (signed WACZs) is set and the four are not. At startup it reads
the anchors (refusing a file it cannot read or that holds no certificate) and checks that openssl
has `ts -attime` (the LibreSSL at macOS's `/usr/bin/openssl` does not). The rebuild tool decides
the same way. The dev values are in `.env.example`.

The check before storing is a copy of BrowserHive's (`src/replay-bundle/verify-signed-data.ts`):
the signature is recorded only when **all four stages** — signature, chain, domain, timestamp —
are ok. Unlike the original, a stage with no anchor and a signature with no timestamp do not pass
as `skipped`. It also requires the answer's `signedData.hash` to be the hash capture-ledger
computed. The timestamp is checked against the configured TSA root, **never against a certificate
carried inside the timestamp**. Certificate validity is judged at the timestamp's genTime, not now
(signing certificates are short-lived; by the time anyone checks, they have usually expired).

#### Checking a bundle

```sh
pnpm run replay-bundle:verify --crawl <id>
pnpm run replay-bundle:verify --crawl <id> --rev 5
pnpm run replay-bundle:verify --crawl <id> --rev 5 --dir ./r5
```

From the top: the version the crawl points at (from the store), a named version, a local copy.

| Name        | What it checks                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `place`     | `crawlId`, `rev`, `pagesQueryUrl` and `resources[].crawlId` in `replay.json` match the place named |
| `digest`    | `replay-digest.json` names `replay.json`, and sha256(replay.json) = `hash` = `signedData.hash`     |
| `signature` | The four stages (the same check as before storing, over the hash it computed itself)               |
| `pages`     | sha256(pages.json) = `replayBundle.pagesHash`                                                      |
| `wacz`      | Each WACZ, streamed and hashed, equals `resources[].hash` (one line per WACZ)                      |

**It exits 0 only when every line is ok.** A failure does not stop the rest; every mismatch is
named. Reading from the store, it looks up the crawl's organization and version in the ledger
(`--rev` defaults to the version the crawl points at, and it mentions the signed version when that
differs) and reads the configured bucket. A local copy (`--dir`) is a directory holding the three
objects and each WACZ under its `resources[].name`; `--crawl` and `--rev` say which place it is a
copy of (call r3's objects r5 and `place` fails). The anchors default to
`CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR` and `CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR`; `--trust-anchor`
and `--timestamp-anchor` override them.

#### Checking it as a third party

Without capture-ledger. Everything is read through replayweb-player's `/wacz/` (the bucket's anonymous read),
and the anchors are the checker's choice (in dev, `insecure-dev-ca.crt` and
`insecure-dev-tsa-ca.crt` from BrowserHive's `dev-stack/signing-ca/`).

Each step is its own block, with no `#` comments inside, so every block pastes into bash and zsh
alike — by default zsh does not read a pasted `#` as a comment (without
`setopt interactivecomments`, a comment becomes `command not found: #`, and an `'` inside it
swallows the lines that follow).

**1. Fetch the three objects** (`<org>`, `<crawl>` and `<rev>` name the place to check)

```sh
B=http://127.0.0.1:8899/wacz/org/<org>/crawls/<crawl>/r<rev>
curl -fsSO "$B/replay.json"; curl -fsSO "$B/pages.json"; curl -fsSO "$B/replay-digest.json"
```

**2. sha256 of replay.json = the digest's `hash` = `signedData.hash`** (and `path` is `replay.json`)

```sh
echo "sha256:$(shasum -a 256 replay.json | cut -d' ' -f1)"
jq -r '.path, .hash, .signedData.hash' replay-digest.json
```

**3. The place and the crawl's state** (inside the signature)

```sh
jq '.replayBundle | {crawlId, rev, crawlState, stopReason, finishedAt, pagesHash}' replay.json
```

**4. sha256 of pages.json = `pagesHash`**

```sh
echo "sha256:$(shasum -a 256 pages.json | cut -d' ' -f1)"
```

**5. Each WACZ's sha256 = `resources[].hash`** (both columns of a line match). The variable is
`src`, not `path`: in zsh, `path` is tied to `PATH`, and reading into it makes `curl` and `shasum`
vanish.

```sh
jq -r '.resources[] | "\(.hash) \(.path)"' replay.json | while read -r hash src; do
  echo "$hash sha256:$(curl -fsS "http://127.0.0.1:8899$src" | shasum -a 256 | cut -d' ' -f1)"
done
```

**6. Signature, chain and domain** (the signing root is your choice)

```sh
wacz-signer verify --file replay-digest.json --root insecure-dev-ca.crt
```

**7. The timestamp, against a TSA root of your choice**

```sh
jq -r .signedData.timeSignature replay-digest.json | base64 -d > token.tsr
jq -j .signedData.signature replay-digest.json > signature.b64
openssl ts -verify -data signature.b64 -in token.tsr -CAfile insecure-dev-tsa-ca.crt
```

**Step 6 alone is not enough.** `wacz-signer verify` checks the signature against the
`signedData.hash` field, so it never asks whether that field is the hash of `replay.json` (step 2
does). It treats the last certificate inside the timestamp as the TSA's root, so a timestamp from
a self-made TSA passes (step 7 does not). A stage it was given no root for is `skipped`, and it
still says `valid`. To run step 7 after the TSA certificate has expired, pass the timestamp's own
time (`Time stamp` in `openssl ts -reply -in token.tsr -text`, as epoch seconds) to `-attime`.
LibreSSL (macOS's `/usr/bin/openssl`) has no `-attime`; use OpenSSL.

## Picking an archive in a browser

`capture-api` also serves a picker at `/` — the list above, rendered, with each
row opening the archive in [replay](https://github.com/uraitakahito/replayweb-player). **How to use the
screen — what to enter under each way the API identifies callers, and what its messages mean — is in
[Browsing archives](/capture-ledger/picker/).** This section covers only the design behind it.

The screen is built for the way the API identifies callers at startup (`selectIdentity`): two name
fields under the dev header, a token field under JWT, and only a notice when neither is configured.
The browser cannot tell "no name given" from "this API wants a JWT" — both are a `401` with
`{"error":"unauthenticated"}` — so the API, which knows, decides when it renders the HTML
(`pickerView` in `src/api/picker.ts`). The picker gets no tokens. Locally they come from
Floci, whose admin API lets anyone who reaches it create users,
so it is published only on `127.0.0.1`; a screen reachable on `0.0.0.0` that got tokens on its own
would let anyone on the network be anyone.

The picker hands replayweb-player the `objectKey` and nothing else:

```
http://127.0.0.1:8899/?source=/wacz/<objectKey>
```

(Shown unencoded: the link encodes each segment of the key, and then the whole path once more as a
query value — see [Browsing archives](/capture-ledger/picker/#after-clicking-a-row).)

Not the signed URL. A signed URL points straight at S3, which is a different
origin from the viewer, so the browser would need CORS on the bucket. The
object key goes through replayweb-player's own upstream (`/wacz/`), so the picker needs
nothing else from replayweb-player.

:::caution[The list is filtered; the read is not]
`can_view` decides what appears in the picker. It does **not** guard
`/wacz/<key>` — anyone who knows a key can read it, because that path is served
by the bucket's anonymous read. The filtering decides what you are shown, not
what you could fetch. The same holds for replayweb-player's `/q/<dir>/pages`, which answers
the page lookups of a crawl's [replay bundle](#replay-bundles) from that read.

Closing that gap means handing out the signed URL instead and setting CORS on
the bucket, which is a separate change.
:::

## Identity

Authenticating the caller is a separate problem from authorizing them. The production identity
provider (IdP) is Amazon Cognito (decided 2026-11-11); local development uses
Floci, a Cognito emulator — see
[The dev IdP](/capture-ledger/development-environment/#the-dev-idp-floci). What the authorization
layer needs is small — a subject and the organizations they belong to — so that shape is fixed
and the verification behind it is swappable.

**By default nobody is authenticated and every request is 401.** For local
development, `CAPTURE_LEDGER_DEV_IDENTITY=1` enables a resolver that trusts two
headers:

```sh
curl -X POST http://localhost:7070/api/archives/<id>/url \
  -H 'X-Capture-ledger-Subject: bob' \
  -H 'X-Capture-ledger-Organizations: acme'
```

Anyone who can reach the port can claim to be anyone. It refuses to run unless
switched on explicitly, and the server warns loudly at startup.

**The API is now the only route in.** There used to be a second one for the CLI,
which read `CAPTURE_LEDGER_DEV_SUBJECT` and `CAPTURE_LEDGER_DEV_ORGANIZATIONS` from `.env`
instead of headers. Both variables went with it — they are no longer declared in
`.env.example`.

What the identity is _for_ has not changed: it becomes
`capture_submissions.submitted_by` and the `owner` tuple on the `capture_job`,
and while those are empty **not even the person who asked for the archive can
delete it** (`can_delete` reads `owner from parent` and nothing else).

Every route ends at one place — `src/api/identity.ts` picking a resolver, and
`src/config/identity.ts` turning verified claims into an `Identity`. Under JWT the subject is the
token's `sub` (for a person, the ID the IdP gave them; for a machine, its app client ID) and the
organizations are its `cognito:groups`. Callers see nothing but the `Identity` type.

Membership is **not** stored in OpenFGA. It is passed per request as a
contextual tuple built from the caller's identity, so joining or leaving an
organization never has to be synchronised into the authorization store. The
cost is that revocation waits for the token to expire — which is why tokens
should be short-lived. The exception is a machine token (client credentials, where `sub` equals
`client_id`): it carries no groups, so the API takes the organizations where that subject has
`can_submit` in OpenFGA (`submitterOrganizations` in `src/api/authorization.ts`).

## The authorization model

Four types, with ownership flowing downwards: **organization → job → archive**.

| Type           | Relations                                             |
| -------------- | ----------------------------------------------------- |
| `user`         | —                                                     |
| `organization` | `member` / `admin`                                    |
| `capture_job`  | `owner` / `parent` (organization) / `member`          |
| `archive`      | `parent` (job) / `viewer` / `can_view` / `can_delete` |

The signing endpoint asks exactly one question — `can_view` — and there are
three ways to reach it.

```
define can_view: viewer or owner from parent or member from parent
```

| Path                 | Who                               | Where it comes from                   |
| -------------------- | --------------------------------- | ------------------------------------- |
| `viewer`             | someone outside the organization  | a tuple (**always with an expiry**)   |
| `owner from parent`  | whoever asked for the job         | a tuple                               |
| `member from parent` | anyone in the owning organization | a **contextual tuple** from the token |

Deleting belongs to the owner alone (`can_delete: owner from parent`). **A
member of the organization can look but not destroy.**

:::note[`capture_job.member` is the missing hop]
It looks as though `archive` could reach `organization#member` directly. It
cannot: **`from` traverses exactly one edge**, and `archive#parent` points at a
`capture_job`, which puts organization membership two hops away.

```
type capture_job
  relations
    define parent: [organization]
    define member: member from parent   # ← the hop that closes the gap
```

:::

### A share lapses on its own

Nothing outside the organization can be shared without an expiry, because the
type of `viewer` is conditioned.

```
define viewer: [user with non_expired_grant, organization#member]

condition non_expired_grant(current_time: timestamp, grant_time: timestamp, grant_duration: duration) {
  current_time < grant_time + grant_duration
}
```

`current_time` is supplied on every Check, so **nothing has to sweep expired
tuples**. The tuple stays; the condition simply stops holding. A sweeper falling
behind cannot leave a hole open.

### What the assertions hold down

Each assertion in `fga/model.fga.yaml` names a way someone could be let in who should not be.
The viewing side asks the questions below; the starting side (only an organization's submitters
and admins can start a capture, and only for that organization) sits in the same file.

| #   | Question                                                        |
| --- | --------------------------------------------------------------- |
| 1   | the owner of the job can view what it produced                  |
| 2   | a member of the owning organization **can view but not delete** |
| 3   | an unrelated user sees nothing                                  |
| 4   | **membership in another organization grants nothing**           |
| 5   | a direct share is visible inside its window                     |
| 6   | **the same share has lapsed after its window**                  |
| 7   | a shared archive still cannot be deleted by the recipient       |

5 and 6 use **the identical tuple** and differ only in `current_time`.

### Verifying and deploying

`fga/model.fga` is the source of truth, with assertions in
`fga/model.fga.yaml` that run in CI:

```sh
pnpm run fga:test    # assertions, no server needed
pnpm run fga:deploy  # push the model, write the ids to pin into .env.local
```

`fga:deploy` prints `CAPTURE_LEDGER_FGA_STORE_ID` and `CAPTURE_LEDGER_FGA_MODEL_ID`, and writes
them into `.env.local` (it never touches `.env`). **Pin the
model id.** Models are immutable and every write mints a new one; a client that
omits the id evaluates against whatever is newest, so editing the model would
change every decision the moment it lands. Bumping the variable is what makes
that switch deliberate.

## Setup

```sh
git submodule update --init --recursive
cp -n .env.example .env       # the settings template, verbatim
pnpm run stack:up
pnpm run fga:migrate          # OpenFGA's schema (see below)
pnpm run db:migrate
pnpm run fga:deploy           # → writes the two ids into .env.local (nothing to paste)
pnpm run api
```

Everything reads `.env` and then `.env.local` — the `pnpm run` scripts pass two
`--env-file-if-exists` flags, and **the later one wins**. Of the mandatory variables (`REQUIRED_ENV`),
`CAPTURE_LEDGER_FGA_STORE_ID` and `CAPTURE_LEDGER_FGA_MODEL_ID` do not exist until `fga:deploy`
has run, which is why that step comes before `api`. `src/tools/check-env.ts`
keeps `.env.example` in step with what the code actually reads.

:::caution[`fga:migrate` is a separate step]
The `openfga` image is distroless, so it cannot run a shell retry loop as its
entrypoint the way seaweedfs does, and container-compose has no one-shot
service. The server starts fine against an unmigrated database and answers
**500 on everything, including `/healthz`**, until this has run.

Its datastore is also configured with command-line flags rather than env vars:
container-compose injects Docker-link-style variables that OpenFGA's config
loader picks up and misreads — supplying the datastore through the environment
made it panic with `storage engine '192.168.64.202' is unsupported`, the
database container's IP.
:::
