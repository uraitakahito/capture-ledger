---
title: archives
description: The ledger — one row per capture that produced an archive. The absence of an owner column is deliberate.
---

**The ledger: one row per capture that produced an archive.** It records where
each WACZ is, and it is what the signing endpoint looks up.

```ts file="src/db/migrations/002-create-archives.ts#archives-columns"

```

## The absence of an owner column is deliberate

There is no `owner_id` and no `org_id`. **Who may read an archive is a
relationship, and OpenFGA holds it.**

Two places answering the same question will eventually disagree. An `org_id`
here would make it possible to be in a state where the table says one
organization and OpenFGA says another.

Instead, registration queues tuples into
[`fga_outbox`](/capture-ledger/databases/fga-outbox/) and the relationship lives in
OpenFGA.

## Failed captures do not enter

```ts
if (report.status !== CaptureStatus.CAPTURE_STATUS_SUCCESS ||
    report.artifacts?.wacz === undefined) {
  log.warn(…, "capture produced no archive; not adding to the ledger");
  return { reason: "no-archive" };
}
```

**A failed capture uploaded nothing.** Recording it would have the signing
endpoint hand out URLs for objects that do not exist — authorization working
perfectly against a 404, which is the hardest kind of breakage to notice.

So the row count here will not match
[`capture_submissions`](/capture-ledger/databases/capture-submissions/). **The gap is
correct.**

## Why double registration cannot happen

Two paths fill the ledger.

- **the crawl** — admits what a level captured as soon as the flow reports it (fast)
- **the reconciler** — reads the manifest keys recorded in `capture_submissions` for captures the ledger lacks

**Both can reach the same capture, and either can be re-run.**

```ts
.onConflict((oc) => oc.columns(["bucket", "objectKey"]).doNothing())
```

`(bucket, object_key)` is UNIQUE, so that is a no-op rather than a duplicate. And
when nothing was inserted, no tuples are queued either — if the archive is
already in the ledger, its tuples went out the first time.

## Column notes

| Column                  | Note                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `id`                    | `gen_random_uuid()`. Becomes `archive:<id>` in OpenFGA                                          |
| `task_id`               | BrowserHive's task id                                                                           |
| `correlation_id`        | The thread tying capture-ledger's log lines to artifact filenames (8 hex digits per submission) |
| `bucket` / `object_key` | **Taken from the server's own report**, not reassembled from a filename                         |
| `wacz_complete`         | `false` means at least one body is missing — see below                                          |
| `captured_at`           | Capture time; listings are ordered by this, descending                                          |

### When `wacz_complete` is `false`

It is `CaptureResultReport.completeness.complete` verbatim. `false` means **the
archive is missing at least one body**:

- a URL only ever seen as a 304
- a body BrowserHive dropped for exceeding the size cap

The latter arrived in BrowserHive v1.11.0. **Before that, a capture that hit the
cap reported `true`.** It is `NULL` for captures from before the field existed,
or ones that were not recorded.

Worth knowing before handing an archive to wacz-validator.

## Indexes

```sql
archives_pkey                    PRIMARY KEY (id)
archives_bucket_object_key_key   UNIQUE (bucket, object_key)   -- blocks double registration
archives_captured_at_idx         (captured_at DESC)            -- newest first
archives_task_id_idx             (task_id)                     -- lookup from a report
```
