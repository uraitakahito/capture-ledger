---
title: Development environment
description: Prerequisites, daily commands, running without Compose, and troubleshooting.
---

## Prerequisites

- **Node.js 24** (the version in `.nvmrc`). `nvm use` if you have nvm.
- **pnpm 11** — the version pinned by `packageManager`. `corepack enable` installs it.
- **[Apple Container](https://github.com/apple/container)** and
  **container-compose** (both via Homebrew) — required for the stack, not for
  host-only development. macOS only.
- **`curl`** and **`git`** on PATH.
- A **Postgres** at `DATABASE_URL`. The Compose stack brings one up.
- For an end-to-end capture, a **BrowserHive** and the Windmill flow that drives
  it. capture-ledger no longer holds a BrowserHive address — it dispatches to
  `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` instead, and the flow lives in
  [capture-scheduler](https://github.com/uraitakahito/capture-scheduler). The stack still builds
  BrowserHive because the flow needs one; see
  [Upgrading BrowserHive](/capture-ledger/upgrading-browserhive/) for the pinned version.

## First-time setup

```sh
git clone https://github.com/<you>/capture-ledger.git
cd capture-ledger
nvm use
pnpm install
sudo container system dns create capture-ledger   # once per machine
git submodule update --init --recursive           # upstream sources into .upstream/
cp -n .env.example .env                           # the settings template, verbatim
pnpm run check       # audit + typecheck + lint + format:check + env + tests
```

Start the stack with `pnpm run stack:up`, never with `container-compose`
directly: before starting anything it checks whether the shared store is up, the toolchain, the
`capture-ledger` DNS domain and the `.upstream/` submodules that every build
context points at, and stops, naming whatever is missing.

The artifact store (SeaweedFS) is not part of this stack. It is one store shared by the three
crawler repos (`seaweedfs.crawler-storage`), started from the submodule:

```sh
sudo container system dns create crawler-storage   # once per machine
sh .upstream/seaweedfs/scripts/stack.sh up
```

Emptying it, looking inside, and recreating it are documented in one place,
[seaweedfs's Operations page](https://uraitakahito.github.io/seaweedfs/operations/)
(`pnpm run store:wipe` empties this repo's bucket).

### Environment variables

The code reads them through three different mechanisms:
`required()`/`optional()` in `src/config/`, commander's `.env()` (so they also
show up in `--help`), and plain `process.env[…]` — the last of which reaches
into `scripts/` too. `pnpm run check-env` counts them. Seven are mandatory.

`.env.example` is the single list, and `.env` is a verbatim copy of it
(`cp -n .env.example .env`); nothing generates `.env`, because a second list
drifts from the first. The two OpenFGA ids do not exist until something has run,
so the template carries only their names — `pnpm run fga:deploy` writes them into
`.env.local`; see [Archive ledger](/capture-ledger/archive-ledger/#setup).

`scripts/check-env.mjs` (part of `pnpm run check`, and a step of its own in CI)
compares the names the code reads against the names `.env.example` declares, in
both directions. A stale template is worse than no template: it gets trusted,
so when something is missing there is nothing left to suspect.

### Two settings files

Every runnable script hands node `.env` and then `.env.local` (two
`--env-file-if-exists` flags). **The later one wins**, so a name present in both
takes its value from `.env.local`.

| File         | Owner     | What is in it                                                 |
| ------------ | --------- | ------------------------------------------------------------- |
| `.env`       | you       | a copy of `.env.example`. **The only one you edit by hand**   |
| `.env.local` | the tools | values that only exist once something has run; git ignores it |

Two tools write it: `pnpm run fga:deploy` (the OpenFGA store and model ids) and
`pnpm run connect` (the four lines capture-scheduler hands over — quickstart §7).
They are split because they have different owners: when a tool reorders or drops
a line a person wrote, nobody can tell afterwards what happened.

**The first line of the API's startup log says which one is winning:**

```text
config: .env (16 names), .env.local (6 names) — .env.local wins for CAPTURE_LEDGER_FGA_STORE_ID, … (a value set in the shell beats the files)
```

When "I edited `.env` and nothing changed", look for the name on that line: if it
is there, `.env.local` is winning. When you suspect a stale `.env.local`, the
fastest fix is to **regenerate it** — both `fga:deploy` and `connect` are safe to
repeat.

The line prints **names only, never values**: tokens are among them, and the
explanation of where a value came from does not need the value. A value set in
the shell beats both files.

### An empty value is not the same as no value

`FOO=` in a `.env` file sets `FOO` to the empty string; omitting the line leaves
it unset. Those are different states, and POSIX gives them different syntax —
`${FOO:-default}` falls back on either, `${FOO-default}` only on unset.

This repo picks the first meaning everywhere: **empty means absent**. Read env
through `optional()` (or `need()`), never through `process.env[…] ?? default`,
which is the second meaning and would keep the empty string.

Because a variable that is _set to empty_ is almost always a typo rather than an
intent, the startup guard in `src/config/env.ts` **refuses to run** and names it,
rather than quietly falling back. That is worth doing: an empty value used to be
strictly worse than a missing one — `DATABASE_URL=` passed commander's mandatory
check, the API started, `/healthz` answered 200, and the first query failed with
a SASL error that never mentioned `DATABASE_URL`.

So `.env.example` has only three kinds of line:

```sh
NAME=value     # pass a value
#NAME=value    # show the default; uncomment and edit to use it
#NAME=         # no value until something has run (a tool writes it to .env.local)
```

A bare `NAME=` is allowed **only for the seven required variables**, whose
emptiness is reported as "missing" by `collectEnv`. `check-env.mjs` enforces
that rule too.

## Daily commands

| Command                                   | What it does                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm run dev:up`                         | The 14 startup steps, in order. `--dry-run` lists them; `--from <step>` resumes.                                   |
| `pnpm run dev:status`                     | What is up right now. **Changes nothing.**                                                                         |
| `pnpm run dev:down`                       | The two host processes, then both repos' containers. Never the shared store.                                       |
| `pnpm run api`                            | Build, then run the API (`tsc` then `node dist/api/server.js`).                                                    |
| `pnpm run build`                          | Emit JS/d.ts to `dist/` via `tsconfig.build.json`.                                                                 |
| `pnpm run typecheck`                      | `tsc --noEmit`, including tests and `*.config.ts`.                                                                 |
| `pnpm run lint` / `lint:fix`              | ESLint flat config (typescript-eslint recommendedTypeChecked).                                                     |
| `pnpm run format` / `format:check`        | Prettier. `.prettierignore` skips `dist/` and `src/rpc/generated/`.                                                |
| `pnpm test` / `test:watch`                | Vitest unit tests under `test/`.                                                                                   |
| `pnpm run audit`                          | Known vulnerabilities in `pnpm-lock.yaml`. CI also runs it daily.                                                  |
| `pnpm run check`                          | audit + typecheck + lint + format:check + test. Run before pushing.                                                |
| `pnpm run db:migrate` / `db:migrate:down` | Kysely migrations against `DATABASE_URL`.                                                                          |
| `pnpm run db:seed` / `db:seed:down`       | Kysely seeds from `src/db/seeds/`.                                                                                 |
| `pnpm run targets`                        | Add, list, disable or remove capture targets (`capture_targets`). A dev tool that writes to the database directly. |
| `pnpm run proto:generate`                 | Regenerate `src/rpc/generated/` from the vendored `.proto` (buf).                                                  |
| `pnpm run proto:check`                    | Generate, then `git diff --exit-code` (CI drift gate).                                                             |
| `pnpm run proto:sync`                     | Re-copy the `.proto` from the pinned submodule.                                                                    |
| `pnpm run site:dev` / `site:build`        | This documentation site.                                                                                           |
| `pnpm run site:check`                     | Build the site and verify its references.                                                                          |
| `pnpm run docs:shots`                     | Retake the screenshots the docs embed (no stack needed).                                                           |

### Two things run on the host, not in the stack

**`pnpm run oidc:issuer` (9099) and `pnpm run api` (7070) are host processes**, not containers.

Which means **`container-compose down` does not stop them**. That is what caused
`EADDRINUSE: address already in use 127.0.0.1:9099` on 2026-09-20: an issuer started the day
before, in another terminal, was still holding the port. It shows up as "I took the stack down
and the port is still busy".

```sh
pnpm run dev:status   # pid, start time, port. Changes nothing
pnpm run dev:down     # the two host processes, then both repos' containers
```

`dev:down` first checks whether **whoever holds the port is ours**: the command line has to be
running this repo's entry, and the process's cwd has to be this repo's root. Anything else it
**names instead of stopping** — pids get recycled, so a pid looked up from a port must never be
killed on sight.

## Working against the stack

```sh
pnpm run stack:up
# grpcurl reads the vendored contract; GetServerStatus is the readiness probe.
# browserhive-2 is the same on localhost:50052.
until grpcurl -plaintext -import-path proto -proto browserhive/v1/capture.proto \
  localhost:50051 browserhive.v1.CaptureService/GetServerStatus >/dev/null 2>&1; do sleep 1; done
```

**There is no dev container.** container-compose has exactly four subcommands —
`up`, `down`, `build`, `version` — so there is no `exec` to drop into. It does
not need one: capture-ledger runs on the host against the containerised stack,
through the ports that stack publishes on `127.0.0.1`. The connection string comes
with the template, so the copied `.env` already has it:

```sh
DATABASE_URL=postgres://capture_ledger:capture_ledger@127.0.0.1:5432/capture_ledger
```

:::danger[Do not use the container name from the host]
The platform DNS does resolve `<service>.capture-ledger` from the host — but **resolving is
not reaching**. macOS 26 stops binaries that Apple did not sign (that includes `node`) from
opening TCP connections to the container subnet, so the name resolves and the connection
then fails with `EHOSTUNREACH`. `/usr/bin/curl` **is** signed by Apple and gets through,
which makes this easy to misdiagnose: the same URL answers for `curl` and fails for `node`.
There is no switch for this in System Settings — `node` is not even listed.

Code that runs **inside** a container (`scripts/prod-smoke.sh`) keeps using the names;
container-to-container traffic is not affected.
:::

There is no BrowserHive address here any more. The two gRPC endpoints the stack
publishes, `localhost:50051` and `localhost:50052` — one BrowserHive per Chromium —
are for grpcurl and for the flow, not for capture-ledger.

The `pnpm run` scripts read that `.env` themselves
(`node --env-file-if-exists=.env`) — no shell `export` needed. **Variables
already in the environment win**, so `DATABASE_URL=... pnpm run db:migrate`
points one run at a different database. Invoking `node dist/...` directly does
not load it; pass what you need yourself there.

Postgres is also published on `127.0.0.1:5432`, so `localhost` works too.

Coming from Docker Compose, the everyday commands map like this:

| Docker Compose                      | In this stack                                 |
| ----------------------------------- | --------------------------------------------- |
| `docker compose up -d --build`      | `pnpm run stack:up`                           |
| `docker compose down`               | `pnpm run stack:down`                         |
| `docker compose ps`                 | `container ls`                                |
| `docker compose logs browserhive-1` | `container logs browserhive-1.capture-ledger` |
| `docker compose exec <svc> sh`      | `container exec -it <svc>.capture-ledger sh`  |
| `docker compose run --rm <svc> …`   | `container run --rm <image> …`                |

Starting and stopping are the two that are not `container-compose`, because `scripts/stack.sh`
passes three things along: the signing profile and its env file as a pair, the submodule versions
(an image built without them is one BrowserHive refuses to start), and the checks it runs first.

Both Chromiums are **headless**. To watch one render, open
`chrome://inspect` in a local Chrome, add `localhost:9222` and `localhost:9223`
under _Configure…_, and inspect the target.

## Production smoke test

```sh
./scripts/prod-smoke.sh
```

It brings the stack up, polls `GetServerStatus` until both BrowserHives answer, builds
`capture-ledger:latest`, then runs migrate → seed → the API with `container run --rm`,
asks the API for `/healthz`, tears the stack down through an `EXIT` trap, and
forwards the exit code as its own.

**It no longer captures anything.** capture-ledger does not speak gRPC to BrowserHive,
so what this script proves is that the image boots: migrations apply, the seed
lands, the API answers. The capture path is covered end to end by capture-scheduler's
`pnpm run test:e2e`, which needs Windmill as well.

The one-shot jobs are plain `container run` calls because container-compose has
no `run` subcommand. That also retires the old
`--profile run --exit-code-from capture-ledger` workaround: the Docker Compose behaviour
it worked around — aborting the whole stack on the migrator's legitimate exit 0
— has no equivalent here.

## Working against an external Postgres

```sh
DATABASE_URL=postgres://user:pass@db.host:5432/capture_ledger \
  pnpm run db:migrate

DATABASE_URL=postgres://user:pass@db.host:5432/capture_ledger \
CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=https://windmill.example/api/w/…/jobs/run/f/f/waggle/crawl_level \
CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=… \
  pnpm run api
```

The `…` in the webhook URL is the Windmill workspace id (`crawler` in the
bundled setup). The tail, `f/waggle/crawl_level`, is the path of the flow, and
capture-scheduler is what decides it. **A wrong name does not stop the API from
starting, and `POST /api/crawls` still answers `202`.** It only shows afterwards:
the crawl ends as `failed`, and the API log carries
`crawl webhook → 404 Not found: flow not found`.

For Postgres TLS, encode the parameters in `DATABASE_URL` (e.g.
`?sslmode=require`).

**BrowserHive's TLS is not configured here any more.** The flow holds that
channel, so its CA lives on the Windmill side — the variable
`u/admin/browserhive_tls_ca`, where an empty string means plaintext.

## Setting up an identity locally

There is one entry point for identity — the API — and it **denies everyone by
default.**

| Path                 | Default | Dev header                      | JWT                          |
| -------------------- | ------- | ------------------------------- | ---------------------------- |
| API (`/api`, picker) | deny    | `CAPTURE_LEDGER_DEV_IDENTITY=1` | `CAPTURE_LEDGER_OIDC_ISSUER` |

There used to be a second row for the CLI, reading `CAPTURE_LEDGER_DEV_SUBJECT` and
`CAPTURE_LEDGER_OIDC_TOKEN` from the environment. Both went with it, and are no longer
declared in `.env.example` — **claiming a subject is the caller's job now.**

**The JWT path wins over the dev header.** When both are set, an environment must not
fall back to the weaker one, where anyone who reaches the port can be anyone. The picker
changes its fields to match whichever one the API started with — two name fields under the dev
header, a token field under JWT ([Browsing archives](/capture-ledger/picker/)).

### The dev issuer

Setting `CAPTURE_LEDGER_OIDC_ISSUER` makes the API run **the same verification code
production will run** — signature, `iss` / `aud`, expiry, and the JWKS fetch. Until a
real IdP is chosen, the bundled issuer stands in for one.

```bash
pnpm run oidc:issuer                                   # listens on :9099
export CAPTURE_LEDGER_OIDC_ISSUER=http://127.0.0.1:9099
TOKEN=$(pnpm run oidc:token --subject alice --org acme)
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/crawls
```

The token does not belong in `.env` — the API is what reads it, and the caller
is what puts it in the `Authorization` header.

Changing `--subject` lets you produce **both "a person submitted this" and "a service
submitted this"**. In the second case the OpenFGA owner tuple becomes
`user:<service>`, and no person can delete the archive — you can walk into that
authorization gap here, before real authentication exists.

:::caution[Development only]
`POST /token` mints a token for anyone who asks, which is why it warns on startup. The
key lives only inside the issuer process and **is regenerated on every start**, and its name
(`kid`) changes with it, so the API refetches the keys as soon as it sees a new token and
previously minted tokens stop verifying. That is key rotation, reproduced — no need to restart
the API.
:::

### Moving to a real IdP

Only the values of `CAPTURE_LEDGER_OIDC_ISSUER` and `CAPTURE_LEDGER_OIDC_AUDIENCE` change.
`jwtIdentityResolver` does not change at all.

Note that **the JWKS-over-HTTP path cannot be covered by unit tests**. Swapping
`createRemoteJWKSet` for a local key leaves the suite green, so walking through this
section is what guards it instead.

The spelling of the organizations claim differs per IdP (`groups` / `roles` / something
custom). There is one place to change: `ORGANIZATIONS_CLAIM` in `src/config/identity.ts`,
which the API reads through `identityFromClaims`.

### Check the startup log

When the API starts, its **last line** says where it listens, how callers identify themselves, and
whether crawl level reports can get through (`src/api/startup-notes.ts`).

```text
Archive API listening on 0.0.0.0:7070 — identity: JWT (http://127.0.0.1:9099); crawl level reports: ready
```

| `crawl level reports` | Meaning                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`               | Level reports get through — the API listens where containers can reach it, and accepts JWTs                                                                 |
| `blocked`             | They do not. The warnings above it name the missing lines (`CAPTURE_LEDGER_API_HOST=0.0.0.0` and `CAPTURE_LEDGER_OIDC_ISSUER`); crawls would stay `running` |
| `off`                 | There is no crawl route (the two webhook lines are missing)                                                                                                 |

Three more warnings exist: no identity is configured at all (every request is `401`), the API
trusts the dev header while listening beyond `127.0.0.1` (anyone who can reach the port can act as
anyone; the picker makes the same call and shows a red notice at the top), and a sink is configured while the API listens on `127.0.0.1` (BrowserHive's containers
cannot `PUT`). The `CAPTURE_LEDGER_DEV_IDENTITY=1` warning appears only when the header is actually
in effect — with a JWT setup it says, at info level, that the variable is ignored.

## Troubleshooting

- **A container will not come up** — `container ls` shows what is running and
  `container logs <svc>.capture-ledger` shows why. For Chromium,
  `curl http://localhost:9222/json/version` tells you whether CDP is answering.
- **Names do not resolve** — check that `container system dns ls` lists
  `capture-ledger`, and that no service in `docker-compose.yml` has a `container_name:`
  key (it suppresses the DNS naming).
- **BrowserHive exits at boot** — its startup `HeadBucket` is fatal. Check that
  `WAIT_FOR_S3` is set on the service and that SeaweedFS logged
  `Bucket browserhive ready.`
- **`/api/crawls` answers 404 to everyone** — either the caller lacks
  `can_submit`, or the route was never registered because
  `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` is unset. The startup log says which
  (`… is not set — /api/crawls is not served`).
- **Crawls stay `running` (level reports do not arrive, or get `401`)** — if the last line of
  the API's startup log says `crawl level reports: blocked`, the warnings above it name the
  missing lines ([Check the startup log](#check-the-startup-log)).
- **The docs build cannot read the BrowserHive pin** — run
  `git submodule update --init --recursive`.

### Crawling something you control

The stack ships a fixture origin — [fixtures](https://github.com/uraitakahito/fixtures) —
behind a profile, so a crawl can be exercised without pointing it at a stranger's
site:

```sh
pnpm run stack:up --profile capture-fixtures
```

It publishes no port; `capture-fixtures.capture-ledger:8080` resolves from containers and from the
host alike. `/links/hub` is the seed to use — every `/links/*` page is that page
with exactly one thing changed, which is what lets a crawler applying the wrong
rule be told apart from one that is simply broken.

fixtures also keeps a request log, and that is the point of using it:

```sh
curl -s http://capture-fixtures.capture-ledger:8080/__request-counts
```

`crawl_pages` says what capture-ledger _recorded_; the log says what the fixture was
_actually asked for_. "The crawler honoured robots" is a claim only the second one
can settle — a page missing from the ledger might never have been fetched, or might
have been fetched and dropped.

fixtures is vendored directly at `.upstream/fixtures` rather than through
`.upstream/browserhive`, which carries its own much older copy. The two pins move
for different reasons and neither should wait on the other.

### Signing an archive

Signing needs two things at once: `wacz-signer` and `tsa` running, and BrowserHive
knowing where to ask. **One line turns on both.**

```sh
# .env
CAPTURE_LEDGER_CAPTURE_SIGNING=1
```

`pnpm run stack:up` reads that line and adds `--profile signing` (which starts
`wacz-signer` and `tsa`) together with `--env-file signing.env` (which tells
BrowserHive where to ask). It prints what it added, so the reason `wacz-signer` is
running is never a mystery.

**There is no way to pass one without the other**, and that is the point. The
settings used to live in three places that did not know about each other — the
`.env` flag, the profile, and four `BROWSERHIVE_SIGNING_*` entries hardcoded into
`docker-compose.yml`. Turning signing on without starting the profile made every
capture fail with `ENOTFOUND wacz-signer.capture-ledger`, which reads like a DNS fault and is
not one: the name is correct, the service simply was not running.

The signing settings cannot go back into `docker-compose.yml`, not even blanked
out. This is [the empty-value trap](#an-empty-value-is-not-the-same-as-no-value)
again, one level out: BrowserHive branches on `signing.url === undefined`, but
commander decides with `envVar in process.env`, so `- BROWSERHIVE_SIGNING_URL=`
counts as _set_. The result is `fetch("")` and `TypeError: Failed to parse URL
from ` — an error that never names the variable, exactly like the `DATABASE_URL=`
story above. With the entry genuinely absent, BrowserHive says `no signing
service is configured on this server`.

Signing is fail-closed: a capture that asked for a signature and could not get
one fails rather than producing an unsigned archive.

### Sending artifacts through the sink

By default BrowserHive writes each artifact into its own bucket. The sink is the
other path: capture-ledger hands every crawl a one-off URL and token, and BrowserHive
`PUT`s each artifact to capture-ledger instead (`src/api/sink.ts`), so BrowserHive
never holds a key that can write for every tenant. Two variables turn it on, **and
only together** — with just one of them set, the API refuses to start:

```sh
CAPTURE_LEDGER_API_HOST=0.0.0.0 \
CAPTURE_LEDGER_SINK_ORIGIN=http://$(container network inspect default | jq -r '.[0].status.ipv4Gateway'):7070 \
CAPTURE_LEDGER_SINK_SECRET=$(openssl rand -hex 32) \
  pnpm run api
```

Setting them on the command line leaves `.env` alone: Node's `--env-file-if-exists`
does not override a variable the shell has already set.

The origin is **the address BrowserHive's containers reach the API at**, not the one
you use. On the dev stack that is the host as seen from the container network — the
gateway of the `default` network, which the command above reads (`192.168.66.1` on the
machine this was written on; it changes when the network is recreated, so do not copy
it) — and the API has to listen on `0.0.0.0`: bound to loopback, it refuses the
containers. A wrong origin fails captures with an error that starts with
the sink URL (`http://…/api/sink/…: …`).

**Then check where the artifacts landed**, because this path can also be skipped
without a sound. A crawl started with the sink on records
`crawls.artifact_key_prefix` (`org/<orgId>/<YYYY-MM>/`), and the `object_key` of
each of its archives must start with it. A flat `<taskId>_<crawlId>.wacz` means
BrowserHive wrote into its own bucket: the crawl still succeeds, and nothing else
says so. That is how the sink went unused from the day it was added — the webhook
body in `src/crawl/dispatch.ts` was written out by hand and never carried
`artifact_sink`. It is now built from a mapping the type checker keeps complete, and
capture-scheduler's end-to-end test asks the API whether it serves the sink (an
unauthenticated `PUT` answers 401 if it does, 404 if not) and, when it does, requires
every archive of its crawl to sit under the prefix.

## Retaking the screenshots

The pictures in [Browsing archives](/capture-ledger/picker/) are generated by
`scripts/docs-shots.mjs`. None was taken by hand: a screenshot is a copy of the screen, and a copy is
out of date from the day the screen changes.

```sh
./node_modules/.bin/puppeteer browsers install chrome   # first time only (fetches the Chrome it drives)
pnpm run docs:shots
```

No stack is needed. The script starts only the real screen (`src/api/picker.ts`) and a stand-in API
that returns sample data (`/api/archives` and `/api/me`). The screen changes with the way the API
identifies callers, so it starts one pair per way — dev header, JWT, none configured, and the dev
header listening on `0.0.0.0`. The colour scheme (light), language, time zone and the sample timestamps
are fixed, so the pictures come out the same on any machine, and retaking them without changing
anything produces no diff.

**Retake them whenever `src/api/picker.ts` changes.** The sha256 of the source at the time of shooting
is recorded in `docs-site/src/assets/picker/shots-manifest.json`, and `pnpm run site:check` fails when
it differs from the current source — a comment-only change included. The script writes the manifest;
do not edit it by hand.

## Repo conventions

- Source under `src/`, tests under `test/`, one concern per module.
- `src/rpc/generated/` is generated and committed; never edit it by hand.
- Prettier and ESLint are authoritative — run `pnpm run check` before pushing.
- Documentation lives in `docs-site/`, in English and Japanese. Adding an
  English page without its Japanese counterpart fails `pnpm run site:check`.
