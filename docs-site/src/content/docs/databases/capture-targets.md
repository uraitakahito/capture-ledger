---
title: capture_targets
description: The list of what to capture — the answer to the one question capture-ledger asks.
---

**The list of what to capture.** The answer to the one question capture-ledger asks —
which URLs get captured — lives here. `POST /api/crawls` with `fromTargets`
seeds a crawl from the enabled rows of this table, filtered to the caller's
organization.

```ts file="src/db/migrations/001-create-capture-targets.ts#capture-targets-columns"

```

## Column notes

| Column                      | Note                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | `BIGSERIAL`, insertion order, which the loader's `ORDER BY` preserves                                                                                         |
| `url`                       | `CHECK (url <> '' AND url = btrim(url))` and `CHECK (url ~* '^https?://')` — the database rejects empties, padding and non-http(s) values                     |
| `url_hash`                  | **Generated column**: `digest(url, 'sha256')`, stored. It backs the unique index and is never read directly                                                   |
| `labels`                    | `TEXT[]`. **Not read any more** — the crawl seeds itself with `url` alone, so labels reach neither BrowserHive nor artifact filenames                         |
| `enabled`                   | Covered by the partial index `capture_targets_enabled_id_idx`; disabled rows cost nothing                                                                     |
| `org_id`                    | Which organization this URL belongs to. **No default** — every `INSERT` names it. `fromTargets` filters on it, so a crawl only ever seeds from its own tenant |
| `created_at` / `updated_at` | Default `now()`. There is no auto-update trigger yet                                                                                                          |

:::note[Why the unique index is not on `url` itself]
Long URLs can exceed an index's size limit. **Indexing the fixed 32-byte SHA-256
instead** removes that worry, and because it is a generated column the
application never has to hash anything.
:::

## Indexes

```sql
capture_targets_pkey              PRIMARY KEY (id)
capture_targets_org_url_hash_key  UNIQUE (org_id, url_hash)  -- one organization cannot hold the same URL twice
capture_targets_enabled_id_idx    (id) WHERE enabled         -- partial
```

`capture_targets_enabled_id_idx` is **partial** because every read carries `WHERE enabled`.
Indexing disabled rows would only waste space.

## Adding rows

```sh
pnpm run targets add https://example.com/ --org acme
```

A development CLI that writes straight to this table. In the database, a second row
with the same URL for one organization is rejected by
`capture_targets_org_url_hash_key`; another organization may target the same URL.
The rest of the CLI, and the SQL to do it by hand, are in
[URL source](/capture-ledger/url-source/#adding-urls).
