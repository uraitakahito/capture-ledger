---
title: Quickstart
description: Bring the Compose stack up, prepare the database, and start your first crawl.
---

The stack brings up everything capture-ledger needs — Postgres, two headless
Chromiums, and a BrowserHive in front of each, built from the
[pinned submodule](/capture-ledger/upgrading-browserhive/). It runs on
[Apple Container](https://github.com/apple/container), driven by
`container-compose`.

The artifact store (SeaweedFS) is **not part of this stack**: it is one store shared by the
[Web Capture](https://uraitakahito.github.io/capture-ledger/#web-capture) repos, brought up by [seaweedfs](https://github.com/uraitakahito/seaweedfs) (§3).

## The short way

**Only §1 and §2 are by hand** (registering DNS needs `sudo`, so no tool can do it, and the
submodules and `.env` are a one-time thing right after cloning). After that, one command:

```sh
pnpm run dev:up
```

It brings up the startup steps in order; `pnpm run dev:up --dry-run` lists what each step runs,
without starting anything. **It prints each command before running it**, so reading the output
top to bottom gives you the steps §3–§7 spell out. When capture-scheduler's `doctor` is all ✓,
you can capture.

| Command                      | What it does                                                                |
| ---------------------------- | --------------------------------------------------------------------------- |
| `pnpm run dev:up --dry-run`  | print the list of steps. **Nothing is started**                             |
| `pnpm run dev:up --from api` | resume partway, after fixing whatever step it named when it failed          |
| `pnpm run dev:status`        | what is up right now. Changes nothing                                       |
| `pnpm run dev:down`          | what runs on the host, then both repos' containers (never the shared store) |

:::note[Repos to clone next door]
`dev:up` also runs commands in neighbouring repos (**it never writes files there**):
capture-scheduler (Windmill and the crawl flow),
[wacz-validator](https://github.com/uraitakahito/wacz-validator) (the validation daemon) and
[capture-workbench](https://github.com/uraitakahito/capture-workbench) (the web app you open locally while developing Web Capture). In the `--dry-run` list they are
the lines that start with `cd ../…`. If they are not next to capture-ledger, under the same parent directory, pass
`--scheduler`, `--validator` and `--workbench` with their paths; a missing one stops `dev:up` at
its step, by name. capture-scheduler also needs its DNS domain registered once —
see [capture-scheduler's quickstart](https://uraitakahito.github.io/capture-scheduler/quickstart/).
:::

**§3 onwards is the same steps done one at a time.** `dev:up` calls the scripts from §3–§7 and
has no implementation of its own. Only the validation daemon and the screen (§8) are started by
`dev:up` alone.

## 1. Register the DNS domain (once per machine)

```sh
sudo container system dns create capture-ledger
sudo container system dns create crawler-storage   # for the shared store
```

The project name is the DNS domain: containers become `<service>.capture-ledger`,
and the containers reach each other by that name (BrowserHive, for one, connects to
`chromium-1.capture-ledger`; the shared store is `seaweedfs.crawler-storage` the same way).
Without it, container-compose falls back to appending to the `/etc/hosts` **inside each
container** via `container exec` (your Mac's own `/etc/hosts` is never touched). That write
fails for the non-root containers here, and container-compose neither checks
the exit status nor prints anything — so only some services lose name
resolution, which is a hard symptom to trace back.

## 2. Fetch the upstream sources and copy the settings template

```sh
git submodule update --init --recursive   # upstream sources into .upstream/
cp -n .env.example .env                   # copy the settings template; never overwrites
```

The `.upstream/` submodules hold every upstream source, BrowserHive included.
Every build context points into them, so nothing builds while they are empty.

`.env` is a copy of `.env.example`: nothing is detected and no value is
changed. The template already carries the development values, and **there is
nothing for you to add by hand** — the two OpenFGA ids (§5) and the crawl
lines (§7) only exist once something has run, so **the tools write them into
`.env.local`** (node reads that after `.env`, so it wins where they overlap).
`-n` refuses to overwrite an existing `.env`, so your own edits survive a second run.

## 3. Start the shared store and the stack

There is one artifact store for all of Web Capture. Start it first if it is not already up (it lives in
the submodule, so you do not have to leave this repo):

```sh
sh .upstream/seaweedfs/scripts/stack.sh up
```

Then this repo's stack:

```sh
pnpm run stack:up
```

Before starting anything it checks the toolchain, the DNS domain (§1), the submodules (§2) and
**whether the shared store is up**, and stops, naming whatever is missing. Wiping and inspecting the
store are covered in
[its operations page](https://uraitakahito.github.io/seaweedfs/operations/).

The first build compiles BrowserHive and the Chromium image from source, so
expect several minutes. Check the state — until the stack is up, curl reports
the failure itself:

```sh
curl -fsS http://localhost:50051/status | jq '{busy, browser: .browser.url}'
# → { "busy": false, "browser": "http://chromium-1.capture-ledger:9222/" }
```

That is `browserhive-1`. The stack runs two — a BrowserHive drives exactly one
browser, so there is one per Chromium — and the second answers on `localhost:50052`.

`/status` is BrowserHive's HTTP API (JSON, since v12; plaintext in this stack).
Its contract is the OpenAPI document vendored in this repo
(`src/rpc/generated/browserhive/openapi.json`, copied from the submodule) — the
same file the ledger checks every `.result.json` manifest against.

Both Chromiums are headless. To watch one render, open `chrome://inspect` in a
local Chrome and add `localhost:9222` and `localhost:9223` under _Configure…_.

Then full-text search. The API does not start without it
([Full-text search](/capture-ledger/archive-ledger/#full-text-search)), so start OpenSearch —
only that service, **named**, or every container is recreated — and write its URL to
`.env.local`:

```sh
pnpm run stack:up --profile search opensearch
pnpm run search:connect   # waits for OpenSearch, then writes CAPTURE_LEDGER_OPENSEARCH_URL to .env.local
```

## 4. Prepare the database

```sh
pnpm install         # first time only
pnpm run db:migrate  # create the tables
pnpm run scripts import .upstream/capture-scripts  # what runs inside the page
```

:::caution[Do not forget the scripts]
BrowserHive has **no roster of its own**. With no scripts in the ledger, a crawl runs nothing inside
the page — no scrolling, no lazy loading — and still **produces a successful archive**.
`pnpm run scripts list` says what is in there.
:::

## 5. Prepare authorization

The archive API and the picker go through OpenFGA. **The store and model ids do
not exist until the model is deployed**, so they cannot live in compose or in the
template. Run the two commands:

```sh
pnpm run fga:migrate  # create the OpenFGA datastore
pnpm run fga:deploy   # push the model; writes the store id and model id to .env.local
```

`fga:deploy` prints the two lines and **writes them into `.env.local`. There is nothing to
copy.** It never touches `.env` — the boundary is that tools do not edit what a person wrote
([Two settings files](/capture-ledger/development-environment/#two-settings-files)).

The model id changes on every run (OpenFGA mints a new model even for identical content), so
**restart the API if it is already up**.

:::note[This step is not optional any more]
There is no longer a CLI that bypasses OpenFGA. Every way into capture-ledger is the
API, and the API needs these two ids.
:::

## 6. Start the API

The API — and the picker it serves at `/` — **runs on the host**. The stack has
no such service, for the same reason as §5: the OpenFGA ids do not exist until
after startup.

```sh
pnpm run api
open http://127.0.0.1:7070/
```

:::note[§7 stops this API and starts it again]
**Settings are read once, at startup.** §7's `pnpm run connect` and `pnpm run idp:bootstrap` write
lines into `.env.local`, and the process you are running now will never see them — you stop it with `Ctrl-C` and run the same
`pnpm run api` again. **A second one cannot run alongside it** (it exits with
`EADDRINUSE: address already in use 0.0.0.0:7070`).
**When you cannot tell what is still running**, `pnpm run dev:status` prints the pid and start
time, and `pnpm run dev:down` stops it — `container-compose down` only knows about containers,
so the API, which runs on the host, survives it.

This first run is here to show that the API works and the picker opens.
:::

Once it is open, type your own name (the output of `whoami`) into `subject` and `acme` — the
organization you will claim when starting the crawl in §7 — into `organizations`, then press 読み込む
(Load). **At this point the picker says 見えるアーカイブが無い ("no archives visible to you"), and
that is normal**: rows appear after the crawl in §7. What each part of the screen does, and what its
messages mean, is in [Browsing archives](/capture-ledger/picker/).

If there are no fields and it only says この API には名乗りの設定が無く…（全員 401） ("this API has no
identity configured — everyone gets 401"), check that `CAPTURE_LEDGER_DEV_IDENTITY=1` is in `.env` —
without it the resolver admits nobody.

## 7. Start a crawl

Capturing is a crawl: capture-ledger plans it, and a Windmill flow in
[capture-scheduler](https://github.com/uraitakahito/capture-scheduler) does the capturing.
**From here on you need capture-scheduler** — everything above this step works without it;
capturing does not.

### Once: connect capture-scheduler

The steps live in one place, [capture-scheduler's quickstart](https://uraitakahito.github.io/capture-scheduler/quickstart/)
(bring up Windmill, load the flow, hand over a token). Along the way,
capture-scheduler's `pnpm run windmill:bootstrap` writes **lines for this repo inside its
own repo**. **Fetching them is our job:**

```sh
pnpm run connect   # read the lines from ../capture-scheduler into this repo's .env.local
```

A command run over there never rewrites this repo's `.env` — a repo changing because of a command
typed somewhere else is not what the person typing it expects. These are the lines the API needs,
and **miss any one and no crawl runs to the end.** The last row does not come from
capture-scheduler: `pnpm run idp:bootstrap` (below) writes it.

| Line                                                                       | Why                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL`<br>`CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN` | Where crawls are dispatched. Without them `/api/crawls` does not exist at all and answers `404`                                                                                                                |
| `CAPTURE_LEDGER_API_HOST=0.0.0.0`                                          | The flow reports each level back to the API, and the report comes **from a container**. A `127.0.0.1` bind never receives it                                                                                   |
| `CAPTURE_LEDGER_OIDC_ISSUER`<br>`CAPTURE_LEDGER_OIDC_CLIENT_IDS`           | The flow identifies itself with a JWT. The API accepts **either** a JWT **or** the development headers, and these lines make it JWT — the picker then shows a token field in place of the two name fields (§8) |

Once `connect` has run, set up the local IdP (identity provider) and restart the API — it reads its
settings once, at startup. The IdP is [Floci](https://github.com/floci-io/floci), a local stand-in for
Amazon Cognito that §3's stack runs as the service `idp`
([The dev IdP](/capture-ledger/development-environment/#the-dev-idp-floci)):

```sh
pnpm run idp:bootstrap   # pool, app clients and your user; writes the last row into .env.local
pnpm run idp:grant       # lets the flow's app client and your user start crawls in acme
```

`idp:bootstrap` also writes a handoff file, `.dev/idp.env`, which capture-scheduler's
`windmill:capture-ledger-token` reads, so that step comes after this one (`dev:up` runs them in
that order). (Run `connect` again whenever you run `windmill:bootstrap` again: the
token has changed.) When the last line of its startup log says `crawl level reports: ready`, the lines
are in effect; `blocked` means the warnings above it name the missing lines
([Check the startup log](/capture-ledger/development-environment/#check-the-startup-log)). When
`pnpm run doctor`, near the end of capture-scheduler's quickstart, shows ✓ on every line, the two
are connected; the `pnpm run smoke` after it captures one page to prove it.

Once connected, the API also starts a crawl whenever a schedule falls due. There are none until
someone makes one, in capture-workbench's Schedules tab —
[Schedules](/capture-ledger/schedules/).

### Start one

Identify with a JWT. The headers from §6 do nothing on an API set up for JWTs.

```sh
TOKEN=$(pnpm run --silent idp:token)   # your user from idp:bootstrap, in acme
curl -X POST http://127.0.0.1:7070/api/crawls \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"seeds":["https://example.com/"],"maxDepth":0}'
# → 202 { "crawlId": "9072b625-…" }
```

`seeds` names the starting pages. Seeds follow links two levels deep by default; `maxDepth: 0` takes
the page alone.

To try a site script, seed `https://laws.e-gov.go.jp/` and add `"variables":{"query":"個人情報"}` to the body.
Without `scripts`, the registered script `egov-law-search` (for `laws.e-gov.go.jp`, from capture-scripts) joins the
default set and searches law titles for the word in `query` within the page. `query` is required; without it the
answer is `400 missing variables`
(see "Site scripts" in [Capture options](/capture-ledger/capture-options/)).

Ask `GET /api/crawls/<crawlId>`, with the same header, how the crawl ended. A failed crawl carries
`error` as `[step] message`, pages that could not be captured are in `failures` with their reasons and
page ids (`page`), and `lastJob` names the Windmill run of the last level dispatched (open it at
`http://127.0.0.1:8000/run/<lastJob.id>?workspace=crawler`). That page's capture log is what
`GET /api/crawls/<crawlId>/pages/<page>/log` returns
([Pages and their capture logs](/capture-ledger/archive-ledger/#pages-and-their-capture-logs)).

```sh
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/crawls/<crawlId> \
  | jq '{state, pagesCaptured, error, lastJob, failures}'
```

:::caution[There are two 404s]
A body of `Route POST:/api/crawls not found` means the route does not exist (the two webhook lines
are missing); `{"error":"not found"}` means the caller lacks `can_submit` (`pnpm run idp:grant` has not run).
Ask `GET /api/me` with the same token: its `canSubmit` is that answer.
See [Archive ledger](/capture-ledger/archive-ledger/#who-may-start-one).
:::

## 8. See what came out

The quickest look is the screen. `dev:up` starts it last, so just open it:

```sh
open http://127.0.0.1:7080/
```

[capture-workbench](https://github.com/uraitakahito/capture-workbench) is **one row per crawl**: state, pages
captured, how many WACZ, and links out to the run (Windmill) and to two viewers (“ReplayWeb.page ↗” on
[replayweb-server](https://github.com/uraitakahito/replayweb-server) and “Web Capture ↗” on
[capture-player](https://github.com/uraitakahito/capture-player)). On the archives
face, each row's 検証 (Validate) button reports **whether what was captured matches the WACZ
spec** — answered by [wacz-validator](https://github.com/uraitakahito/wacz-validator), which is
handed a URL the ledger signed, so **no store credentials are added anywhere**. The row's
**開く** (open) shows the archive's contents too — the file tree, lines, one line split into
fields, the WARC records and images; the records BrowserHive wrote for what it did not or could
not fetch (`WARC-Type: metadata`) appear there as well. **There is no token
to paste** — it signs in to the local IdP through its own app client, `workbench`. (Locally that is
not a boundary: Floci's admin API lets anything that reaches it create users and get tokens.)

What follows is the same thing by hand, which is what that screen calls.

The listing comes from the ledger (the `archives` table) and is **filtered by OpenFGA's
`can_view`**. Call the API directly with the token from §7:

```sh
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/archives | jq '.archives[0]'
```

To use the picker, paste a token for the same identity as §7 into the screen. The API's settings
stay as they are.

```sh
pnpm run --silent idp:token | pbcopy
open http://127.0.0.1:7070/
```

The API you gave the lines in §7 is set up for JWTs, so the picker shows a トークン (Token) field
in place of the two fields from §6. Paste the token and press 読み込む (Load): the line above the list
says you are viewing as your `sub` (the ID Floci gave your user — `idp:token` prints it) in `acme`, and the pages from the §7 crawl are listed.
The token lasts one hour. When the picker says 401 — このトークンは通らない… ("this token does not get
through"), get a new one with the same command and paste it — see
[Browsing archives](/capture-ledger/picker/#three-steps-jwt).

Clicking a row opens [replay](https://github.com/uraitakahito/replayweb-server) in a new tab. replay first
lists the pages inside that WACZ (Web Archive Collection Zipped — the file one captured page is
packed into). **Click the title and playback starts.**

See [Archive ledger](/capture-ledger/archive-ledger/) for the whole API.

### While it is still running

**A page reaches the ledger only after the flow reports the level it was in.**
If it is not in the picker, the level is either still open or the page failed.
There is nothing to poll for a capture in flight: a capture is one HTTP call
(`POST /captures`), and its result goes back to the caller — the Windmill run —
and into the `.result.json` manifest next to the artifacts. What a BrowserHive
will tell you is whether it is busy:

```sh
curl -fsS http://localhost:50051/status | jq '{busy, browser: .browser.url}'
```

`"busy": true` means that browser is in the middle of a page; `localhost:50052`
is the other one.

Artifacts land in the bundled SeaweedFS bucket (`browserhive`). Naming and WACZ
contents are on BrowserHive's storage page.

### When every crawl gets 409

Only one crawl runs at a time; a second one gets `409`. **A crawl whose level report never reached
the API stays `running` and blocks every later start with `409`** — the API was bound to
`127.0.0.1`, the address had gone stale, the JWT setting was switched off mid-crawl, the token had
gone stale, the run was cancelled in Windmill ([How a crawl row ends](/capture-ledger/archive-ledger/#how-a-crawl-row-ends)).
The `409` body names the crawl that is blocking; close it by that id:

```sh
# the 409 body: {"error":"a crawl is already in progress","crawlId":"9072b625-…","startedAt":"…"}
curl -X POST http://127.0.0.1:7070/api/crawls/<crawlId>/failed \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"the level report never arrived; closed by hand"}'
# → { "closed": true }
```

It closes running rows only, and it is the same route the flow uses to close a crawl when it
fails. What was missing, capture-scheduler's `pnpm run doctor` names. A `409` is not remembered
against the key (`Idempotency-Key`), so after closing the crawl you can send again with the same key
([Sending the same request twice still starts one crawl](/capture-ledger/archive-ledger/#sending-the-same-request-twice-still-starts-one-crawl)).

## Next

- Serve and share archives, and the whole crawl API → [Archive ledger](/capture-ledger/archive-ledger/)
- Capture on a timetable → [Schedules](/capture-ledger/schedules/)
- Change what gets captured → [Capture options](/capture-ledger/capture-options/)
- Work without Compose → [Development environment](/capture-ledger/development-environment/)
