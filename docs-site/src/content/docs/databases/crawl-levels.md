---
title: crawl_levels
description: The levels of a crawl. Each holds the Windmill job id as its level key, shared by dispatch, the level report and fail_crawl.
---

**One row is one level of a crawl.** The primary key is the crawl id and the depth. When the level is decided, the ledger picks a random id for the Windmill job and keeps it; that id (the level key) is at once the dispatch's `?job_id=`, the level report's `Idempotency-Key` and the `levelKey` in fail_crawl's body. How it behaves is in [Level keys](/capture-ledger/archive-ledger/#level-keys).

```ts file="src/db/migrations/038-crawl-levels.ts#crawl-levels"

```

## States

| State       | Meaning                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `pending`   | Not sent yet. The first level is made with the crawl row, later ones with the previous level's report     |
| `sent`      | Sent, but not known to be taken (timeout, no connection, 5xx). Sent again with the same level key         |
| `accepted`  | Taken by Windmill (a 2xx, or the `already exists` 400)                                                    |
| `reporting` | Its level report is being handled. `report_token` is the attempt's token, `lease_until` its lease (2 min) |
| `reported`  | The report is recorded. `answer` keeps the first answer, returned to a second report with the same key    |
| `abandoned` | Given up or closed (not taken within 10 minutes, the newest level's fail_crawl, a person's "close")       |

## It keeps the arguments

`args` is the level exactly as the webhook sends it (seeds, the copy of the secrets, variables, User-Agent and so on). Sending again, and sending a level that was never sent before the API restarted, need it. It holds no secret values (only names and Windmill variable paths).

## Counts are written per level

`pages_captured` and `pages_discovered` are **written** per level, and the totals on `crawls` are rewritten as the sum of the level rows. Nothing is added, so a level report that arrives twice does not pile up counts. A crawl started before level rows existed has none, and its totals on `crawls` stay as they are.

## The level clock

A tick inside the API reads the `pending` and `sent` rows every 30 seconds (a partial index on `next_attempt_at`) and sends them again; a level not taken 10 minutes after its row was made is given up, and the crawl is closed as `failed`. A level of a closed crawl is not sent and becomes `abandoned`. Expired keys of requests that start a crawl ([crawl_requests](/capture-ledger/databases/crawl-requests/)) are deleted here too.
