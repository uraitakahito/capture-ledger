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
admit, such as a cancelled capture with no archive) and `missing` (nothing at the
reported key).

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

**One disagreement never resolves that way: a cancelled capture.** If the flow's
deadline runs out mid-capture, BrowserHive (since v9.1.0) tears the page down and
writes a manifest of its own saying `ERROR_TYPE_CANCELLED`. There are no
artifacts to find, so the page stays failed — correctly. A run of those in the
bucket means the flow's deadline is shorter than the pages it is being asked to
capture, and the fix is on the flow's side.

### Attribution

A manifest says nothing about organizations; BrowserHive has no such concept.
So `capture-ledger` writes a `capture_submissions` row (task id → organization) when the
level is reported, and the reconciler reads it back. That row is written for
every page carrying a task id — including the ones reported as failures, for the
reason just above. Encoding the organization inside `correlationId` instead was
rejected: a convention held only by agreement is broken by the first caller who
submits a capture by hand.

## Handing out URLs

`capture-api` serves two endpoints for archives. Both require an identity; see below.

```sh
# One archive
curl -X POST http://localhost:7070/api/archives/<id>/url
# → { "url": "http://…?X-Amz-Signature=…", "expiresIn": 300 }

# The ones you may see, newest first
curl http://localhost:7070/api/archives
```

The shape of both requests is a JSON Schema on the route, so the checking is
the contract rather than a description of it:

|                              |          |                                                                                    |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `POST /api/archives/:id/url` | `id`     | a UUID — anything else is **400**, before authorization runs                       |
| `GET /api/archives`          | `before` | an ISO 8601 timestamp — anything else is **400**. Omit it to start from the newest |

`before` is a cursor: pass the `capturedAt` of the last row you were given.
Unknown query parameters are dropped rather than rejected.

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

## Starting a crawl

Deciding _when_ to capture belongs outside capture-ledger — a scheduler does that.
Deciding _what_ to submit and _how_ stays here. So the boundary is one endpoint
that starts a crawl, and one that reports on it.

There used to be a second pair, `POST /api/runs` and `GET /api/runs/:id`, for
"capture every enabled row of `capture_targets` once". **That is now a crawl with
`fromTargets` and a depth of 0.** One concept, one table, one set of guarantees.

```sh
# From an explicit list of seeds.
curl -X POST http://localhost:7070/api/crawls \
     -H 'content-type: application/json' \
     -d '{"seeds":["https://example.com/"],"maxDepth":2}'
# → 202 { "crawlId": "9072b625-…" }

# Or from the target list — this is what the old run did.
curl -X POST http://localhost:7070/api/crawls \
     -H 'content-type: application/json' -d '{"fromTargets":{"limit":5}}'

curl http://localhost:7070/api/crawls/9072b625-…
# → { "state": "succeeded", "stopReason": "max_depth",
#     "seeds": ["https://…"], "pagesCaptured": 5, "pagesDiscovered": 5, … }
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

### From the target list

`fromTargets` seeds the crawl from the enabled rows of
[`capture_targets`](/capture-ledger/databases/capture-targets/), and `limit` takes the
first _n_ of them. Two things differ from the rest of the endpoint:

- **`maxDepth` defaults to 0** — do not follow anything. That is what the old run
  meant. An explicit value still wins, so "take the target list and follow two
  levels out from each" is expressible.
- **`maxPages` is never lower than the number of seeds.** The ordinary default of
  30 would silently truncate a longer target list.

The rows are filtered by the caller's organization. A crawl carries one `org_id`,
so mixing another organization's targets into it would leave attribution
unanswerable. A caller with no enabled targets gets **400**, not an empty crawl —
`crawls.seeds` has a `CHECK (array_length(seeds, 1) >= 1)` and a seedless crawl
could never start.

:::note[`fromTargets` always ends in `max_depth`]
Depth 0 means the first level is also the last, so `stopReason` is `max_depth`
every time. That is not a fault — it is the shape of the request.
:::

Two consequences of folding runs into crawls, worth knowing before the first
scheduled one:

- **The daily sweep is now paced.** The old run submitted every target at once;
  a crawl honours `perHostDelayMs` and `hostParallelism` like any other. Kinder
  to the other end, and slower.
- **Pages from the target list now reach full-text search**, because they are
  `crawl_pages` rows and the search index joins through them.

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

:::caution[The daily crawl and a manual one now block each other]
There used to be two constraints — one for runs, one for crawls — and a scheduled
run could start while someone was crawling by hand. There is one now, so it
cannot. **This is right on the politeness argument** (both would hit the same
hosts), but the practical cost is that a scheduled crawl is skipped more often
than a scheduled run used to be.

A crawl whose dispatch dies also leaves its row `running`, which blocks the next
one. `GET` returns `startedAt` so you can judge; clearing it is a manual act.
:::

### What a caller may send

Exactly one of `seeds` (a non-empty array) or `fromTargets` — **both is 400 and
neither is 400**, with the two reported differently, because they are different
mistakes. Alongside them: `scope`, `maxDepth`, `maxPages`, `perHostDelayMs`,
`hostParallelism`. An unknown key is **400**, not silently dropped.

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

Nothing in capture-ledger does. The scheduler lives in its own repo —
[capture-scheduler](https://github.com/uraitakahito/capture-scheduler) — which runs a Windmill instance
whose only job is to call this endpoint on a cron (`trigger_crawl.ts`). The same
Windmill also runs the flow that does the capturing, which capture-ledger reaches through
`CAPTURE_LEDGER_CRAWL_WEBHOOK_URL`.

The split is deliberate: **capture-scheduler decides when, capture-ledger decides what.** That is
why the body takes no capture formats, and why `fromTargets` submits whatever
`capture_targets` says rather than a list the caller supplies.

Two things a caller has to get right, and capture-scheduler's script exists to encode them:

- **409 is not a failure.** It means a crawl is already going. Retrying cannot
  help — the answer stays the same until that crawl ends.
- **202 is not the end.** A crawl that fails still answered 202. Anything that
  stops at the 202 reports success for failed captures.

Running with a scheduler means running with a JWT, and that has a cost worth
knowing: setting `CAPTURE_LEDGER_OIDC_ISSUER` makes the JWT resolver take over, so the
**browser picker starts returning 401**. JWT beating the dev header is the point
(a deployment with both configured must not fall to the weaker one), so the two
are used in turn, not together.

### Who may start one

`can_submit` on the organization, checked at `HIGHER_CONSISTENCY` so a revoked
grant takes effect immediately. A caller who may not gets **404**, for the same
reason the archive routes do.

The grant is **stored**, and that is the whole point:

```sh
pnpm run fga:grant submitter alice acme
pnpm run fga:revoke submitter alice acme
```

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
organization on the caller's identity, and `fromTargets` reads only that
organization's rows — so a `submitter` cannot pull another tenant's targets into
a crawl of their own.

## Following links

The same endpoint, with a depth above 0, walks the links out from its seeds.
Windmill runs the walking; capture-ledger decides what is in scope, what has been seen,
and when to stop.

```sh
curl -X POST http://localhost:7070/api/crawls \
     -H 'content-type: application/json' \
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

`stopReason` is one of `completed`, `max_depth`, `max_pages`, or `failed`. Without it
a finished crawl cannot say whether it followed everything or was cut off. With the
default of 30 pages, `max_pages` is the ordinary outcome — that is deliberate, so the
limit is visible in normal use rather than a surprise.

`pagesDiscovered` and `pagesCaptured` are separate counts. The difference is what
scope, robots, and the caps threw away.

### What gets followed

Same origin as the seed by default (`scope: "same-host"` relaxes it to the host).
Judged against the **final** URL, after redirects. `rel="nofollow"` is honoured, and
only `http(s)` links are considered. Fragments are dropped — `#section` is a position
inside a page, not another page — but nothing else is normalised: a reordered query
string is a different URL to plenty of real servers, and taking the wrong page is
worse than taking one twice.

Deduplication is a unique index on `(crawl_id, url_hash)`, with `url_hash` the same
generated `digest(url, 'sha256')` column `capture_targets` uses. Discovered links are
inserted with `ON CONFLICT DO NOTHING` and **the rows that actually landed become the
next level** — so recording and deciding cannot drift apart. BrowserHive's
`rejectDuplicateUrls` is not a substitute: it only knows about pending and processing
tasks and forgets completed URLs.

## Full-text search

Off by default. A deployment may have no index, so unless `CAPTURE_LEDGER_OPENSEARCH_URL`
is set the endpoints are **not served at all** (you get a 404 — the capability
genuinely is not there, so that is the right answer).

```sh
pnpm run stack:up --profile search
# and CAPTURE_LEDGER_OPENSEARCH_URL=http://127.0.0.1:9200 in .env
```

```sh
# Index one crawl's worth (the crawl flow calls this on its own)
curl -X POST .../api/crawls/<id>/index
# → 202 { "indexed": 6, "pages": 6 }

# Query
curl ".../api/search?q=responsive"
# → { "hits": [ { "archiveId": "…", "url": "…", "title": "responsive", … } ], "total": 3 }
```

### The text comes out of the archive

BrowserHive writes `title` and `text` into the WACZ's `pages/pages.jsonl`. The
`text` is `document.body.innerText` — **the rendered body**, not the HTML. capture-ledger
indexes that as-is. Re-deriving it from HTML would let the index disagree with
what the archive signed for.

`textWithheld` (`url-policy` / `content-type`) travels with it. Drop it and
**a capture that came back empty** looks identical to **a body policy refused to
store**. The first is a fault worth investigating; the second is normal.

### The index does not know who may see what

Search asks OpenSearch, then asks OpenFGA `can_view` about what came back and
drops the rest — the same shape as `GET /api/archives`.

Copying orgs or permissions into the index would filter in one query and be
faster, but then **the index becomes an authority on authorization, and one fact
has two homes**. Fix one and both still look like they work, so an authorization
bypass stays silent.

:::caution[Counts and paging are not exact]
`total` is the index's raw count and **includes what authorization dropped**. Ask
for 50 and you may get 30. Counting only what you may see means filtering before
counting, which is the "put permissions in the index" option above. We take one
authority over exact numbers.
:::

### Rebuilding is one statement

```sql
UPDATE archives SET indexed_at = NULL;
```

Index state is the single `archives.indexed_at` column and no body text is stored
(everything needed is derivable from the ledger row and S3). That makes changing
the analyzer or mapping a cheap decision.

The analyzer today is the built-in `cjk` (bigram). Kuromoji needs a plugin
install and does not run on the stock image — swap in a custom image when you
need it, then rebuild with the statement above.

## Picking an archive in a browser

`capture-api` also serves a picker at `/` — the list above, rendered, with each
row opening the archive in [replay](https://github.com/uraitakahito/replay).

```sh
pnpm run api                  # host-side; the stack has no capture-api service
open http://127.0.0.1:7070/
```

This needs a filled-in `.env` — see [Setup](#setup). Without
`CAPTURE_LEDGER_DEV_IDENTITY=1` the API still starts, but the resolver denies everyone
and the picker stays empty on a `401`.

The picker hands replay the `objectKey` and nothing else:

```
http://127.0.0.1:8899/?source=/wacz/<objectKey>
```

Not the signed URL. A signed URL points straight at S3, which is a different
origin from the viewer, so the browser would need CORS on the bucket. The
object key goes through replay's own upstream, so **replay needs no change at
all**.

:::caution[The list is filtered; the read is not]
`can_view` decides what appears in the picker. It does **not** guard
`/wacz/<key>` — anyone who knows a key can read it, because that path is served
by the bucket's anonymous read. The filtering decides what you are shown, not
what you could fetch.

Closing that gap means handing out the signed URL instead and setting CORS on
the bucket, which is a separate change.
:::

## Identity

Authenticating the caller is a separate problem from authorizing them, and the
identity provider has not been chosen. What the authorization layer needs is
small — a subject and the organizations they belong to — so that shape is fixed
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
`src/config/identity.ts` turning verified claims into an `Identity`. That is the
only thing an identity provider replaces; callers see nothing but the `Identity`
type.

Membership is **not** stored in OpenFGA. It is passed per request as a
contextual tuple built from the caller's identity, so joining or leaving an
organization never has to be synchronised into the authorization store. The
cost is that revocation waits for the token to expire — which is why tokens
should be short-lived.

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

Each of the seven in `fga/model.fga.yaml` names a way someone could be let in
who should not be.

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
pnpm run fga:deploy  # push the model, print the ids to pin
```

`fga:deploy` prints `CAPTURE_LEDGER_FGA_STORE_ID` and `CAPTURE_LEDGER_FGA_MODEL_ID`. **Pin the
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
pnpm run fga:deploy           # → paste the two ids it prints into .env
pnpm run api
```

Everything reads `.env` — the `pnpm run` scripts pass
`--env-file-if-exists=.env`. Seven variables are mandatory and two of them
(`CAPTURE_LEDGER_FGA_STORE_ID`, `CAPTURE_LEDGER_FGA_MODEL_ID`) do not exist until `fga:deploy`
has run, which is why that step comes before `api`. `scripts/check-env.mjs`
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
