---
title: Schedules
description: The schedule table and the clock that turns inside the ledger every 30 seconds. Routes and health words.
---

**The clock for scheduled crawls lives in the ledger.** Every 30 seconds the API process reads the
schedule table (`crawl_schedules`) and starts one crawl from a schedule that is due. Windmill only
captures the levels it is asked to; it does not know when anything should run.

The screen is the Schedules tab in capture-workbench. This page covers the ledger's side.

## One tick

1. If a crawl is running, do nothing (only one crawl runs across the whole ledger).
2. Pick one schedule: those with a run-now request first, then the oldest due time.
3. A schedule starting on its due time waits for **quiet**: nothing starts until
   `CAPTURE_LEDGER_SCHEDULE_QUIET_MINUTES` (default 10) has passed since both the API started and the
   latest crawl started. Run-now does not wait.
4. Ask Windmill whether the declared secrets exist.
5. In one transaction, add the crawl row, its seed pages and its first level row ([crawl_levels](/capture-ledger/databases/crawl-levels/)), and move on to the next run.
6. Send the webhook, with the level key, after the commit.

| What happened                                                             | What follows                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| It collided with a running row                                            | Rollback. The due time does not move and the schedule stays queued. There is no "skipped" outcome                                                                                                                   |
| A secret is missing, Windmill cannot be asked, or the row cannot be added | A `failed` row is added and the schedule moves to its next run                                                                                                                                                      |
| The webhook could not be sent                                             | The same as a crawl started by hand: a 4xx (path, token) closes the row as `failed` at once; no connection, a timeout or a 5xx is sent again by the level clock, which gives up and closes the row after 10 minutes |
| The ledger was down                                                       | One run when it comes back. How many runs passed stays in `crawls.schedule_missed`                                                                                                                                  |

A row left running is not closed by the tick, so that a run that really is running does not get
closed. When that schedule's own latest run has been `running` for an hour or more, its health
becomes `stuck`, and the "close" button on the screen or `POST /api/crawls/:id/failed` closes it.
When a crawl started by hand is the one blocking, the schedule only shows `blocked`, and
`overdue` an hour after its due time ([Health words](#health-words)).

## The recipe is pinned

Creating a schedule runs the same checks as `POST /api/crawls`, and keeps what they resolved in
`recipe`, including a copy of each script's source. A new script version does not change what a run
does: `outdated` in the answer becomes `true`, and a person runs `repin`. Only secrets stay as
declarations and are asked of Windmill on every run.

A run's row also carries a digest of how it captured (`crawls.recipe_sha256`, `035`): the scripts' id,
version, phase, sha256 and options, the variables' values, the User-Agent and the names of the
declared secrets — only what can change a page's content. Seeds, rules, `maxDepth`, `maxPages` and
pacing are left out. Changes since last time compare only runs of one schedule whose digest is the
same (a run repinned with other variables is not compared with the runs before it).
`pnpm run changes:backfill` fills rows older than `035` (`--schedule <id>` for one schedule's runs).

## Routes

Every route is gated by `maySubmit`. The list answers an empty 200 and the rest answer 404. Every
action is a POST (capture-workbench only relays POST for writes).

| Route                            | What it does                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/schedules`            | The body is `{name, cron, request}`. `request` has the shape of `POST /api/crawls` and is refused for the same reasons. Cron takes 5 fields only, and is a 400 if any gap among the next 20 runs is under the minimum. The same name is a 409 |
| `GET /api/schedules`             | The schedules not deleted, with health and recent runs                                                                                                                                                                                        |
| `GET /api/schedules/:id`         | One schedule, shaped like an element of the list                                                                                                                                                                                              |
| `POST /api/schedules/:id/pause`  | Pause. A run-now request that is waiting goes too. A run in progress carries on                                                                                                                                                               |
| `POST /api/schedules/:id/resume` | Resume. The next run is computed from now, and the paused time does not count as missed. A schedule that is not paused is left alone                                                                                                          |
| `POST /api/schedules/:id/run`    | Run now. Answers 202 and the tick starts it. Works on a paused schedule                                                                                                                                                                       |
| `POST /api/schedules/:id/repin`  | Resolve the request again against the current ledger. Refused for the same reasons if a script has gone                                                                                                                                       |
| `POST /api/schedules/:id/delete` | Delete. The row stays, because crawl rows show its name                                                                                                                                                                                       |

`GET /api/crawls` and `GET /api/crawls/:id` also return `schedule` (`{id, name}` or `null`),
`scheduledFor`, and `scheduleMissed`.

## Health words

`health` is read from the top down. capture-workbench writes the sentences; the ledger only returns
the word.

| `health`  | Condition                                                                          |
| --------- | ---------------------------------------------------------------------------------- |
| `paused`  | Paused                                                                             |
| `stuck`   | The latest run has been `running` for an hour or more                              |
| `overdue` | An hour or more since the due time or the run-now request, and nothing has started |
| `failing` | The latest run's `state` is `failed`                                               |
| `blocked` | Due, but waiting on a running crawl or on quiet                                    |
| `ok`      | None of the above                                                                  |

`stuck` is separate because a daily schedule's next due time is about 24 hours away. Reading only
the due time, a run that stopped at 04:00 would say nothing until 05:00 the next morning.

## Changes since last time

When a scheduled run closes, capture-ledger's worker (every 30 seconds, one at a time) pairs it, page URL by
page URL, with the previous run of the same schedule whose recipe digest is the same, and compares the text
(CAPTURE-167). The compared line is the after-behaviors snapshot, or the document line when there is none.
Withheld pages are not compared.

1. **Compare (no Claude).** A page whose text digest (`archive_pages.text_sha256`) is the same is not opened.
   Only for a page that differs are both WACZ files read back from the store, and the line diff (with two
   lines of context) is kept in `page_changes`. The diff can be rebuilt from the two WACZ files. If every
   page is the same the run is `unchanged` and costs nothing.
2. **Summarize (one Claude call).** The diffs of the pages that differ are read together, and a weight per
   page (`none`, `minor`, `content`), a line per page and a line for the run are kept in the derived layer
   (`derivations`, `kind = 'change'`). Claude reads only the diff and two lines around it — never the whole
   text, a withheld document or a secret's value. Quotes are checked against the changed lines and marked
   when they are not there. **A summary is not evidence** (the two WACZ files and the diff are).

| State         | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `no_previous` | No earlier run of the same schedule with the same recipe                                  |
| `unchanged`   | Every page's text is the same (no WACZ read, no Claude)                                   |
| `diffed`      | The diff is kept. Without the key (`CAPTURE_LEDGER_ANTHROPIC_API_KEY`) the run stops here |
| `summarized`  | The summary is kept                                                                       |
| `budget_wait` | The organization's monthly limit (shared with the fixer) is reached; rechecked hourly     |
| `failed`      | Claude did not answer three times (1, 5 and 30 minutes apart), or refused                 |

Only runs closed within the last 48 hours are picked up. `recentRuns[].change` in the schedule answers
(`GET /api/schedules`) carries the state, the counts, the weight and the run's line. The details are read with
`GET /api/changes?before=` (the runs, newest first) and `GET /api/crawls/:id/changes` (per page: the diff, the
summary, and the WACZ before and after). Both need `can_submit`, and return only pages whose two WACZ files the
caller may view (`can_view`).

Both answers name the previous run as `prev` (`crawlId`, `startedAt`, `scheduledFor`; `null` when there is none).
In the answer for one run, `pages` are the pages with a diff and `unchanged` are the compared pairs without one (the
URL and the WACZ before and after). Besides pairs with the same text digest, `unchanged` holds pairs whose digests
differ only by blank lines and indentation (the tick keeps no diff for them). `pagesCompared` counts the pairs present
in both runs, not withheld, with a text digest on both sides (a page in only one run is not counted). It also counts
pairs with a WACZ the caller may not view, so `pages` plus `unchanged` equals it only for a caller who may view every
WACZ of the run (`restricted: false`).

## Settings

| Environment variable                           | Default | Effect                                                                          |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `CAPTURE_LEDGER_SCHEDULE_QUIET_MINUTES`        | `10`    | Quiet. So that nothing starts before `dev:up` reissues the token, or during e2e |
| `CAPTURE_LEDGER_SCHEDULE_MIN_INTERVAL_MINUTES` | `60`    | The minimum gap between runs                                                    |

A deployment with no crawl routes (the two webhook lines) has neither these routes nor the tick.
