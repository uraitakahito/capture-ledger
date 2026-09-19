---
title: Databases
description: The two Postgres instances behind capture-ledger and OpenFGA, and the sixteen tables in them.
---

The capture-ledger dev stack runs **two Postgres instances**. They hold different things
and are different databases.

| Container                   | Holds                                                                    | Who touches it with SQL |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------- |
| `postgres.capture-ledger`   | `capture_targets` / `archives` / `fga_outbox` and 7 more — **10 tables** | capture-ledger          |
| `openfga-db.capture-ledger` | `tuple` / `authorization_model` and 4 more — **6 tables**                | OpenFGA only            |

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

| Table                                                                   | Role                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| [`capture_targets`](/capture-ledger/databases/capture-targets/)         | What to capture                                        |
| [`capture_submissions`](/capture-ledger/databases/capture-submissions/) | What was submitted; the only source of organizations   |
| [`archives`](/capture-ledger/databases/archives/)                       | The ledger — captures that produced an archive         |
| [`fga_outbox`](/capture-ledger/databases/fga-outbox/)                   | Tuples waiting to reach OpenFGA                        |
| `crawls`                                                                | One row per crawl — its policy, state and stop reason  |
| `crawl_pages`                                                           | One row per page a crawl reached; also the dedup index |
| `kysely_migration` / `_lock`<br />`kysely_seed` / `_lock`               | Kysely's own bookkeeping (below)                       |

### OpenFGA's database

| Table                                       | Role                                               |
| ------------------------------------------- | -------------------------------------------------- |
| [`tuple`](/capture-ledger/databases/tuple/) | The relationships themselves                       |
| `authorization_model`                       | The model — one row per version, immutable (below) |
| `changelog`                                 | History of writes (below)                          |
| `store`                                     | Namespaces; deletion is soft (below)               |
| `assertion`                                 | Unused (below)                                     |
| `goose_db_version`                          | OpenFGA's own schema migrations (below)            |

## Tables without a page of their own

These are **created by tooling and used by tooling**; capture-ledger rarely has to think
about them.

### The four tables Kysely creates

`kysely_migration` / `kysely_migration_lock` / `kysely_seed` / `kysely_seed_lock`.

The content is two columns — which migration ran, and when — and the `_lock`
tables hold a single row each. The same runner is reused for migrations and seeds
with nothing but the table names changed.

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
