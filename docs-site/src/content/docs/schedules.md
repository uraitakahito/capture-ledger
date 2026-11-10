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
5. In one transaction, add the crawl row and its seed pages, and move on to the next run.
6. Send the webhook after the commit.

| What happened                                                             | What follows                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| It collided with a running row                                            | Rollback. The due time does not move and the schedule stays queued. There is no "skipped" outcome |
| A secret is missing, Windmill cannot be asked, or the row cannot be added | A `failed` row is added and the schedule moves to its next run                                    |
| The webhook could not be sent                                             | The row is closed as `failed` (the same as a crawl started by hand)                               |
| The ledger was down                                                       | One run when it comes back. How many runs passed stays in `crawls.schedule_missed`                |

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

## Settings

| Environment variable                           | Default | Effect                                                                          |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `CAPTURE_LEDGER_SCHEDULE_QUIET_MINUTES`        | `10`    | Quiet. So that nothing starts before `dev:up` reissues the token, or during e2e |
| `CAPTURE_LEDGER_SCHEDULE_MIN_INTERVAL_MINUTES` | `60`    | The minimum gap between runs                                                    |

A deployment with no crawl routes (the two webhook lines) has neither these routes nor the tick.
