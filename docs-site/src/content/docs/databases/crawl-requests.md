---
title: crawl_requests
description: Keys of requests that start a crawl (Idempotency-Key). For each organization and key, the answer of the first crawl started.
---

**One row is one key of a request that started a crawl.** `POST /api/crawls` remembers the answer of the first crawl it started for each organization and key, answers a repeat with the same key with that answer, and does not start a second crawl. How it behaves is in [Sending the same request twice still starts one crawl](/capture-ledger/archive-ledger/#sending-the-same-request-twice-still-starts-one-crawl).

```ts file="src/db/migrations/037-crawl-requests.ts#crawl-requests"

```

| Column           | What it holds                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `org_id`, `key`  | The primary key. The organization is the caller's first one; the same string in another organization does not mix |
| `request_sha256` | The body's digest (the sha256 of the JSON with its keys sorted). A different one is a 422                         |
| `crawl_id`       | The crawl started. Deleting the crawl deletes the key                                                             |
| `answer`         | The 202 body returned (`{ "crawlId": … }`)                                                                        |
| `created_at`     | Where the key's 24 hours start                                                                                    |

## Only a started crawl is remembered

A 409 for a running crawl and a 400 for the body are not remembered. If they were, sending again
with the same key would not start a crawl even after the running one ended or the body was fixed.

## How rows go

The next request that starts a crawl, and the level clock ([crawl_levels](/capture-ledger/databases/crawl-levels/)), delete rows older than 24 hours (the `created_at` index). A
scheduled run does not go through the API and makes no row here.
