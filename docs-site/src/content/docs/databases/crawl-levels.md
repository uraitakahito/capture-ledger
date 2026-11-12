---
title: crawl_levels
description: The levels of a crawl. Each holds the Windmill job id as its level key, shared by dispatch, the level report and fail_crawl.
---

**One row is one level of a crawl.** The primary key is the crawl id and the depth. When the level is decided, the ledger picks a random id for the Windmill job and keeps it; that id (the level key) is at once the dispatch's `?job_id=`, the level report's `Idempotency-Key` and the `levelKey` in fail_crawl's body. How it behaves is in [Level keys](/capture-ledger/archive-ledger/#level-keys).

```ts file="src/db/migrations/038-crawl-levels.ts#crawl-levels"

```

## States

| State       | Meaning                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending`   | Not sent yet. The first level is made with the crawl row, later ones with the previous level's report                                                                    |
| `sent`      | Sent, but not known to be taken (timeout, no connection, 5xx, 408, 429). Sent again with the same level key; a 4xx (path, token, arguments) makes it `abandoned` at once |
| `accepted`  | Taken by Windmill (a 2xx, or the `already exists` 400)                                                                                                                   |
| `reporting` | Its level report is being handled. `report_token` is the attempt's token, `lease_until` its lease (2 min)                                                                |
| `reported`  | The report is recorded. `answer` keeps the first answer, returned to a second report with the same key                                                                   |
| `abandoned` | Given up or closed (not taken within 10 minutes, the newest level's fail_crawl, a person's "close")                                                                      |

## It keeps the arguments

`args` is the level as the webhook sends it (the level's URLs `frontier`, scripts, variables, secret names with their Windmill variable paths, User-Agent and so on). Sending again, and sending a level that was never sent before the API restarted, need it. It holds no secret values. Nor does it keep the sink's token (the `artifactSink` bearer): the level clock makes a new one, with a new expiry, when it sends again.

## Counts are written per level

`pages_captured` and `pages_discovered` are **written** per level, and the totals on `crawls` are rewritten from the level rows. Nothing is added, so a level report that arrives twice does not pile up counts. The captured count is the sum of the levels. The link count (`crawls.pages_discovered`) is, when the crawl has a link record ([crawl_links](/capture-ledger/databases/crawl-links/)), the number of distinct URLs the rules let through, not the per-level sum. A crawl started before level rows existed has none, and its totals on `crawls` stay as they are.

## The level clock

A tick inside the API reads the `pending` and `sent` rows every 30 seconds (a partial index on `next_attempt_at`) and sends them again; a level not taken 10 minutes after its row was made is given up, and the crawl is closed as `failed`. A level of a closed crawl is not sent and becomes `abandoned`. Expired keys of requests that start a crawl ([crawl_requests](/capture-ledger/databases/crawl-requests/)) are deleted here too.
