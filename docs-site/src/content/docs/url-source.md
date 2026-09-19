---
title: URL source
description: The capture_targets table capture-ledger reads, and how to manage it.
---

capture-ledger's entire input is one Postgres table. **The API never inserts into it** —
populating `capture_targets` is the caller's job, whether that is a manual `INSERT`, an
external pipeline, or the bundled seed. For development there is also a small CLI,
`pnpm run targets`, that adds rows for you (see [Adding URLs](#adding-urls)).

## The query

A crawl started with `fromTargets` is this, and nothing more:

```sql
SELECT url FROM capture_targets WHERE enabled AND org_id = $1 ORDER BY id ASC [LIMIT $2]
```

`ORDER BY id ASC` means rows are seeded in insertion order, and
`fromTargets.limit` takes the first _n_ — so a smoke test always exercises the
same URLs. The `org_id` filter is what keeps a crawl inside one tenant: a crawl
carries a single organization, so seeding it from another one's rows would leave
attribution unanswerable.

## Schema

```ts file="src/db/migrations/001-create-capture-targets.ts#capture-targets-columns"

```

| Column                      | Notes                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | `BIGSERIAL` primary key. Insertion order, preserved by the loader's `ORDER BY`.                                                                                 |
| `url`                       | `CHECK (url <> '' AND url = btrim(url))` and `CHECK (url ~* '^https?://')` — the database rejects empty, untrimmed and non-http(s) values, so no caller has to. |
| `url_hash`                  | Generated `digest(url, 'sha256')` (pgcrypto), stored. Backs the unique index; nothing reads it directly.                                                        |
| `labels`                    | `TEXT[]`. **Nothing reads them any more** — see below.                                                                                                          |
| `enabled`                   | The hot path is `WHERE enabled`, covered by the partial index `capture_targets_enabled_id_idx`. Disabled rows cost nothing.                                     |
| `org_id`                    | Which organization's target this is. **No default** — every `INSERT` names it, or `NOT NULL` rejects the row. `fromTargets` filters on it.                      |
| `created_at` / `updated_at` | `now()` defaults. No auto-update trigger today.                                                                                                                 |

`capture_targets_org_url_hash_key` is unique on `(org_id, url_hash)`: within one
organization the same URL cannot be enqueued twice, while two organizations can each
target the same URL.

## Labels

:::caution[Labels no longer travel]
The column is still here, the seed still fills it, and the ledger still has a
`labels` column of its own — but **the crawl path selects `url` alone** and
submits with an empty label list. So labels reach neither BrowserHive nor the
artifact filenames today. Treat the column as annotation on the target row, not
as something that will show up downstream.
:::

They were free-form and ended up in the artifact filename, which made them the
natural place for an external key: BrowserHive escapes anything that would
collide with the filename's structure, so `_`, `.`, `/`, spaces and non-ASCII all
survived the round trip, with the whole artifact name limited to 255 UTF-8 bytes.
The bundled fixture still uses a securities code alongside a company name:

```ts
{ url: "https://www.ana.co.jp/group/", labels: ["9202", "ANAHoldings"] }
```

## Adding URLs

In development, use the CLI. It writes straight to the database — there is no API
call and no authorization — and it always asks which organization the rows belong to:

```sh
pnpm run targets add https://example.com/ --org acme
pnpm run targets add https://example.com/ https://example.org/docs --org acme --label demo
pnpm run targets add - --org acme < my-urls.txt   # one URL per line; blank and # lines are skipped
pnpm run targets list --org acme                  # add --json for machine-readable output
pnpm run targets disable 6                        # out of rotation, history kept (enable 6 undoes it)
pnpm run targets rm 6
```

It reads URLs with the same parser the crawl uses for its seeds, and stores them
the same way (without the fragment), so anything it accepts will also be readable at
capture time. **If even one URL is unreadable, it adds nothing** and names it.
Adding a URL that is already there but disabled re-enables it. Pass labels one at a
time (`--label a --label b`): in `--label a b`, `b` is read as a URL, and since it is
not one, nothing is added.

From SQL, name the organization yourself:

```sql
INSERT INTO capture_targets (url, org_id, labels) VALUES
  ('https://example.com/', 'acme', ARRAY['example']),
  ('https://example.org/', 'acme', ARRAY['example', 'org'])
ON CONFLICT (org_id, url_hash) DO NOTHING;
```

Always name `org_id`. It has no default, so a row without it is rejected by
`NOT NULL` — and a crawl only seeds from the caller's own organization.

To take a URL out of rotation without losing its history, disable it
(`pnpm run targets disable <id>`, or `enabled = false`) rather than deleting the row.

## Migrations

Migration files live under `src/db/migrations/<NNN>-<description>.ts` and export
`up(db)` / `down(db)`. The runner is a thin wrapper around Kysely's `Migrator`
with `FileMigrationProvider`; applied IDs are tracked in the `kysely_migration`
table (`kysely_migration_lock` guards concurrent runs), so re-running
`pnpm run db:migrate` is a no-op once current.

```sh
pnpm run db:migrate       # apply
pnpm run db:migrate:down  # revert the last one
```

To add one:

1. Pick the next ordinal, e.g. `002-add-priority.ts`.
2. Implement `up` and `down` with the schema builder, or ``sql`…`.execute(db)``
   for what it does not cover — extensions, generated columns, `CHECK`
   expressions referencing other columns.
3. Round-trip locally: `pnpm run db:migrate && pnpm run db:migrate:down && pnpm run db:migrate`.
   CI runs the same round trip.
4. Commit the migration and the code that depends on it together.

Seeds have the same shape under `src/db/seeds/` but use a separate `kysely_seed`
table, so they can be applied and reverted independently.
