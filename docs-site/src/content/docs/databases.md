---
title: Databases
description: The two Postgres instances behind capture-ledger and OpenFGA, and the tables in them.
---

The capture-ledger dev stack runs **two Postgres instances**. They hold different things
and are different databases.

| Container                   | Holds                                                                                  | Who touches it with SQL |
| --------------------------- | -------------------------------------------------------------------------------------- | ----------------------- |
| `postgres.capture-ledger`   | `crawls` / `archives` / `fga_outbox` and the rest ([below](#capture-ledgers-database)) | capture-ledger          |
| `openfga-db.capture-ledger` | `tuple` / `authorization_model` and the rest ([below](#openfgas-database))             | OpenFGA only            |

No table appears in both. The credentials do not cross either, and `openfga-db`
publishes no port, so reaching it takes `container exec`.

## Why they are separate

Sharing one instance would invite the assumption that a tuple can be written
inside capture-ledger's application transaction. **It cannot** — OpenFGA is written
through its HTTP API, never through SQL, so no transaction spans both.

Keeping them apart removes the room for that assumption. And it is precisely
what makes [`fga_outbox`](/capture-ledger/databases/fga-outbox/) necessary.

## The tables

### capture-ledger's database

| Table                                                                   | Role                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`capture_submissions`](/capture-ledger/databases/capture-submissions/) | What was submitted; the only source of organizations                                                                                                                                                                           |
| [`archives`](/capture-ledger/databases/archives/)                       | The ledger — captures that produced an archive                                                                                                                                                                                 |
| `archive_pages`                                                         | One row per line of an archive's page list (`pages/pages.jsonl`), read once for the crawl's replay bundle                                                                                                                      |
| [`fga_outbox`](/capture-ledger/databases/fga-outbox/)                   | Tuples waiting to reach OpenFGA                                                                                                                                                                                                |
| `crawls`                                                                | One row per crawl — its policy, state and stop reason, and its replay bundle and signature ([below](#the-replay-bundle-columns-of-crawls))                                                                                     |
| `crawl_pages`                                                           | One row per URL a crawl touched (pending ones too); also the dedup index, and the capture log's counts (`log_counts`)                                                                                                          |
| `crawl_decisions`                                                       | What a crawl's rules decided, per depth, rule and host name                                                                                                                                                                    |
| [`crawl_schedules`](/capture-ledger/databases/crawl-schedules/)         | Scheduled crawls — the clock's table; a run is a `crawls` row                                                                                                                                                                  |
| `scripts`                                                               | The scripts a crawl can name                                                                                                                                                                                                   |
| `host_types`                                                            | The receptacle (`__bh`) types, shown to script readers                                                                                                                                                                         |
| `derivations`                                                           | The derived layer — what Claude made (the fixer's proposals, the summaries of changes since last time), kept apart from the evidence with its model, prompt version and cost. An organization's monthly cap is counted from it |
| `kysely_migration` / `_lock`                                            | Kysely's own bookkeeping (below)                                                                                                                                                                                               |

### OpenFGA's database

| Table                                       | Role                                               |
| ------------------------------------------- | -------------------------------------------------- |
| [`tuple`](/capture-ledger/databases/tuple/) | The relationships themselves                       |
| `authorization_model`                       | The model — one row per version, immutable (below) |
| `changelog`                                 | History of writes (below)                          |
| `store`                                     | Namespaces; deletion is soft (below)               |
| `assertion`                                 | Unused (below)                                     |
| `goose_db_version`                          | OpenFGA's own schema migrations (below)            |

## The replay bundle columns of crawls

A crawl's [replay bundle](/capture-ledger/archive-ledger/#replay-bundles) is written to the store,
version by version; the `crawls` row keeps what the ledger needs to point at it (`027`) and to say
whether it is signed (`028`).

```ts file="src/db/migrations/027-replay-bundles.ts#crawls-replay-bundle-columns"

```

```ts file="src/db/migrations/028-replay-bundle-signatures.ts#crawls-replay-bundle-signature-columns"

```

| Column                     | What it holds                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `replay_bundle_next_rev`   | The next version number to hand out (from 1). Taken by a row update, which also locks the row                               |
| `replay_bundle_rev`        | The version the ledger points at — the newest one written. **Only moves forward**                                           |
| `replay_bundle_key`        | That version's `replay.json` key (`org/<orgId>/crawls/<crawlId>/r<rev>/replay.json`)                                        |
| `replay_bundle_pages`      | Lines in its `pages.json`                                                                                                   |
| `replay_bundle_built_at`   | When it was built (the ledger's clock)                                                                                      |
| `replay_bundle_error`      | Why the latest version could not be written; cleared by the next one written                                                |
| `replay_bundle_signed_rev` | The newest **signed** version. Moves forward on its own, apart from `replay_bundle_rev`                                     |
| `replay_bundle_digest_key` | That version's `replay-digest.json` key. Set together with `replay_bundle_signed_rev` (a CHECK keeps both null or both set) |
| `replay_bundle_sign_error` | Why the version the ledger points at was not signed. Null for a running crawl and with no signer configured                 |

`replay_bundle_sign_error` is written by the same update that moves `replay_bundle_rev`, so it
always speaks of the version pointed at. When `replay_bundle_signed_rev = replay_bundle_rev`, that
version is signed.

## Tables without a page of their own

These are **created by tooling and used by tooling**; capture-ledger rarely has to think
about them.

### The tables Kysely creates

`kysely_migration` / `kysely_migration_lock`.

The content is two columns — which migration ran, and when — and the `_lock`
table holds a single row.

### authorization_model

**The model. There is no update and no delete.** Every write mints a new id and
leaves the old rows in place; the whole model is serialized into
`serialized_protobuf`.

A Check that names an id evaluates against that version; omitting it always uses
the newest. **That is why `CAPTURE_LEDGER_FGA_MODEL_ID` is pinned** — without it, editing
the model would change every decision the moment it lands.

### changelog

**`tuple` only holds the current state** — deleted rows are gone. This table
keeps the history. `operation` is `0` for a write and `1` for a delete.

It exists for auditing (when a permission was granted and when it lapsed) and for
the Watch API.

### store

One OpenFGA can hold many stores. Tuples and models are partitioned by store, so
separate projects can share an instance.

:::caution[Deleting a store is a soft delete]
The API sets `deleted_at` and nothing else; `tuple` and `changelog` rows remain
(they just stop being visible through the API). Reclaiming the space takes SQL.
:::

### assertion

Where OpenFGA can store tests attached to a model — **capture-ledger does not use it.**
The tests live in `fga/model.fga.yaml` and run in-process via
`pnpm run fga:test`, with no server, which is why CI can verify them without
bringing the stack up.

### goose_db_version

OpenFGA's own schema migrations, filled by `pnpm run fga:migrate`. It plays the
same role as capture-ledger's `kysely_migration` — **each database tracking its own
migrations** is one more sign that they are separate things.

## Looking inside

```sh
# capture-ledger's — the host psql also works (5432 is published)
container exec postgres.capture-ledger psql -U capture_ledger -d capture_ledger -c "\dt"

# OpenFGA's — no published port, so container exec
container exec openfga-db.capture-ledger psql -U openfga -d openfga -c "\d tuple"
```

**Read OpenFGA's database if you like, but do not write to it.** A direct
`INSERT` or `UPDATE` will disagree with its cache and its `changelog`.
