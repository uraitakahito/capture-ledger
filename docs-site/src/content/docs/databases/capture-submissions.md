---
title: capture_submissions
description: Records who a capture was submitted for, at the moment it is submitted.
---

**This records who a capture was submitted for, at the moment it is submitted.**

```ts file="src/db/migrations/004-capture-submissions-and-org-id.ts#capture-submissions-columns"

```

Where each capture's result manifest is was added in `014`:

```ts file="src/db/migrations/014-add-capture-submissions-manifest.ts#capture-submissions-manifest-columns"

```

## Why it is needed

**BrowserHive has no notion of an organization.** capture-ledger passes it a URL and some
settings, and gets back a `taskId`.

When the ledger is later filled from a `.result.json` in the bucket, **that
manifest carries nothing identifying an organization**. Writing it down at
submission time is the only source.

```
what capture-ledger knows          what BrowserHive knows
─────────────────          ──────────────────────
capture_targets.org_id ──┐      taskId
                         │      where the artifacts are
                         └──→   (no idea about organizations)
              capture_submissions
              maps task_id → org_id
```

Without this row the reconciler cannot say who an archive belongs to.

## How it is written

The level report handler (`src/api/crawls.ts`) writes a row for every reported
page that carries a `taskId` — failures included — together with where that
capture's `.result.json` was written:

```ts
submitted.map((r): Insertable<CaptureSubmissionsTable> => ({
  taskId: r.taskId,
  correlationId: r.correlationId ?? crawlId,
  orgId: crawl.orgId,
  submittedBy: crawl.requestedBy,
  manifestKey: manifests.get(r.taskId)?.key ?? null,
  manifestError: manifests.get(r.taskId)?.error ?? null,
}));
```

**capture-ledger never spells a manifest key.** BrowserHive (or the sink) answers
`Capture` with the location it wrote the manifest to, and the Windmill flow relays
it as `manifestLocation`. The handler keeps the key part when the location is in
the configured bucket. A capture that could not write its manifest is reported with
`manifestError` instead, and that reason lands here; so does a location in another
bucket, or one that is not `s3://` — the reporter does not get to choose where the
ledger reads.

A report that carries a `taskId` without exactly one of the two is refused with
400: accepting it would leave a capture with nothing to read.

A `taskId` is minted by BrowserHive and never reused, but a level can be reported
again, hence `onConflict … doNothing()`.

## How it is read

`reconcile.ts` reads it while filling the ledger from bucket manifests.

```
read taskId from .result.json
  → look up org_id and submitted_by in capture_submissions
  → register in archives, and queue tuples with that org_id and submitted_by
```

## Column notes

| Column           | Note                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_id`        | **Primary key.** BrowserHive's id, the join back to the result report                                                                              |
| `org_id`         | `not null`. **The reason this table exists**                                                                                                       |
| `submitted_by`   | The user who asked, when there was one. **NULL for scheduled runs that belong to an organization rather than a person**                            |
| `submitted_at`   | Default `now()`                                                                                                                                    |
| `manifest_key`   | Where the capture's `.result.json` is, minus the bucket, exactly as reported. NULL when there is a `manifest_error`, and for rows older than `014` |
| `manifest_error` | Why there is no manifest the ledger can read: the write failed, or the reported location is not in the configured bucket                           |

:::caution[`submitted_by` is not the result of authentication]
What fills this column is whatever the API request claimed as its subject
(see [Identity](/capture-ledger/archive-ledger/#identity)). **The development header
route verifies nothing** — with `CAPTURE_LEDGER_DEV_IDENTITY=1`, `X-Capture-ledger-Subject` is
taken at face value, so any name can land here. The JWT route does check the
signature and expiry.

It is still worth filling, because this value becomes the `owner` tuple on the
`capture_job`. An archive without one **cannot be deleted by anyone**:
[`can_delete`](/capture-ledger/archive-ledger/#the-authorization-model) reads
`owner from parent` and nothing else.
:::

:::note[The counts will not match the ledger]
Everything submitted lands here, but only captures that **produced an archive**
land in [`archives`](/capture-ledger/databases/archives/). A failed capture uploaded
nothing, so a gap is expected.
:::
