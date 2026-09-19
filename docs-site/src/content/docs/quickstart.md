---
title: Quickstart
description: Bring the Compose stack up, seed the capture_targets table, and start your first crawl.
---

The stack brings up everything capture-ledger needs — Postgres, SeaweedFS, two headless
Chromiums, and a BrowserHive in front of each, built from the
[pinned submodule](/capture-ledger/upgrading-browserhive/). It runs on
[Apple Container](https://github.com/apple/container), driven by
`container-compose`.

## 1. Register the DNS domain (once per machine)

```sh
sudo container system dns create capture-ledger
```

The project name is the DNS domain: containers become `<service>.capture-ledger`,
resolvable from each other **and from the host** — which is what lets capture-ledger
itself run on the host against this stack. Without it, container-compose falls
back to appending to the `/etc/hosts` **inside each container** via
`container exec` (your Mac's own `/etc/hosts` is never touched). That write
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
changed. The template already carries the development values; the only ones
you add are the two OpenFGA ids (§5). `-n` refuses to overwrite an existing
`.env`, so the ids you pasted survive a second run.

## 3. Start the stack

```sh
pnpm run stack:up
```

Before starting anything it checks the toolchain, the DNS domain (§1) and the
submodules (§2), and stops, naming whatever is missing.

The first build compiles BrowserHive and the Chromium image from source, so
expect several minutes. Check the state — until the stack is up, grpcurl reports
the failure itself:

```sh
grpcurl -plaintext -emit-defaults -import-path proto -proto browserhive/v1/capture.proto \
  localhost:50051 browserhive.v1.CaptureService/GetServerStatus \
  | jq '{busy, browser: .browser.url}'
# → { "busy": false, "browser": "http://chromium-1.capture-ledger:9222/" }
```

That is `browserhive-1`. The stack runs two — a BrowserHive drives exactly one
browser, so there is one per Chromium — and the second answers on `localhost:50052`.
`-emit-defaults` is what makes `busy: false` visible: grpcurl otherwise drops
fields at their default value, and an idle server would print `null`.

`-import-path proto -proto …` points grpcurl at the contract vendored in this
repo. BrowserHive does not serve reflection — a deliberate choice, not a gap:
enabling it would mean shipping a descriptor set and reading it at runtime,
making the `.proto` a runtime asset. So the `.proto` is how a caller learns the
service — the same file the client is generated from.

Both Chromiums are headless. To watch one render, open `chrome://inspect` in a
local Chrome and add `localhost:9222` and `localhost:9223` under _Configure…_.

## 4. Prepare the database

**There is no dev container.** capture-ledger runs on the host and reaches the stack by
name — `.env` already holds the connection strings:

```sh
pnpm install         # first time only
pnpm run db:migrate  # create the capture_targets table
pnpm run db:seed     # load the five sample URLs
```

To capture pages of your own, add them the same way. `--org acme` is the organization
the crawl in §7 claims, so the rows are visible to it:

```sh
pnpm run targets add https://example.com/ --org acme
```

The rest of the CLI (reading a file, listing, disabling) is in
[URL source](/capture-ledger/url-source/#adding-urls).

## 5. Prepare authorization

The archive API and the picker go through OpenFGA. **The store and model ids do
not exist until the model is deployed**, so they cannot live in compose. Run the
two commands and paste the result into `.env`:

```sh
pnpm run fga:migrate  # create the OpenFGA datastore
pnpm run fga:deploy   # push the model; prints the store id and model id
```

Copy the two printed lines into `CAPTURE_LEDGER_FGA_STORE_ID` and `CAPTURE_LEDGER_FGA_MODEL_ID`
in `.env`.

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

Once it is open, type your own name (the output of `whoami`) into `subject` and `acme` — the
organization you will claim when starting the crawl in §7 — into `organizations`, then press 読み込む
(Load). **At this point the picker says 見えるアーカイブが無い ("no archives visible to you"), and
that is normal**: rows appear after the crawl in §7. What each part of the screen does, and what its
messages mean, is in [Browsing archives](/capture-ledger/picker/).

If it says `401`, check that `CAPTURE_LEDGER_DEV_IDENTITY=1` is in `.env` — without it the resolver
admits nobody.

:::caution[A scheduler cannot reach a loopback bind]
The default bind is `127.0.0.1`, and **a container cannot reach it**. To let
capture-scheduler's Windmill run the daily crawl, start the API on all interfaces:

```sh
CAPTURE_LEDGER_API_HOST=0.0.0.0 pnpm run api
```

The container then points at bridge100 — `http://192.168.64.1:7070`. **A host
name will not resolve there.** That address is already capture-scheduler's default for
`CAPTURE_LEDGER_API_URL`, so `pnpm run windmill:capture-ledger-token` wires it up with nothing
to configure. Opening the API beyond loopback puts it in front of whatever
authentication you have configured — check that first.
:::

## 7. Start a crawl

Capturing is a crawl now: capture-ledger plans it, and a Windmill flow does the
submitting.

```sh
curl -X POST http://127.0.0.1:7070/api/crawls \
  -H 'content-type: application/json' \
  -H "X-Capture-ledger-Subject: $(whoami)" -H "X-Capture-ledger-Organizations: acme" \
  -d '{"fromTargets":{"limit":1}}'
# → 202 { "crawlId": "9072b625-…" }
```

`fromTargets` seeds the crawl from the rows §4 loaded, and defaults to depth 0 —
take them, follow nothing. That is what the old `POST /api/runs` did.

The rows are taken in insertion order, so `"limit": 1` is always the first sample
row. To capture only the URL you added in §4, name it as a seed instead:
`-d '{"seeds":["https://example.com/"],"maxDepth":0}'`. Seeds follow links two levels
deep by default; `maxDepth: 0` takes the page alone.

:::caution[This needs the scheduler stack]
`/api/crawls` is **only served when `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` and
`CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN` are both set** — capture-ledger no longer talks to
BrowserHive itself, so without somewhere to dispatch to there is nothing to
serve, and the route answers `404`. The flow lives in
[capture-scheduler](https://github.com/uraitakahito/capture-scheduler). Everything above this step
works without it; capturing does not.

Also note `can_submit`: a caller without the grant gets `404` too. See
[Archive ledger](/capture-ledger/archive-ledger/#who-may-start-one).
:::

## 8. See what came out

In the picker from §6, keep the identity you used in §7 (the output of `whoami`, and `acme`) and
press 読み込む (Load) again. Clicking a row opens
[replay](https://github.com/uraitakahito/replay) in a new tab. replay first lists the pages inside
that WACZ (Web Archive Collection Zipped — the file one captured page is packed into). **Click the
title and playback starts.**

The listing comes from the ledger (the `archives` table) and is **filtered by OpenFGA's
`can_view`**. You can also call the API directly:

```sh
curl -s -H "X-Capture-ledger-Subject: $(whoami)" -H "X-Capture-ledger-Organizations: acme" \
  http://127.0.0.1:7070/api/archives | jq '.archives[0]'
```

See [Archive ledger](/capture-ledger/archive-ledger/) for the whole surface, and
`GET /api/crawls/<crawlId>` for how the crawl itself ended.

### While it is still running

**A page reaches the ledger only after the flow reports the level it was in.**
If it is not in the picker, the level is either still open or the page failed.
There is nothing to poll for a capture in flight: a capture is one gRPC call, and
its result goes back to the caller — the Windmill run — and into the
`.result.json` manifest next to the artifacts. What a BrowserHive will tell you
is whether it is busy:

```sh
grpcurl -plaintext -emit-defaults -import-path proto -proto browserhive/v1/capture.proto \
  localhost:50051 browserhive.v1.CaptureService/GetServerStatus \
  | jq '{busy, browser: .browser.url}'
```

`"busy": true` means that browser is in the middle of a page; `localhost:50052`
is the other one.

Artifacts land in the bundled SeaweedFS bucket (`browserhive`). Naming and WACZ
contents are on BrowserHive's storage page.

## Next

- Serve and share archives, and the whole crawl API → [Archive ledger](/capture-ledger/archive-ledger/)
- Add your own URLs → [URL source](/capture-ledger/url-source/)
- Change what gets captured → [Capture options](/capture-ledger/capture-options/)
- Work without Compose → [Development environment](/capture-ledger/development-environment/)
