---
title: crawl_schedules
description: Scheduled crawls. The table the clock reads; a run is a crawls row.
---

**One row is one schedule.** The tick inside the API reads this table every 30 seconds. How it behaves is in [Schedules](/capture-ledger/schedules/).

```ts file="src/db/migrations/032-create-crawl-schedules.ts#crawl-schedules-columns"

```

## There is no table of runs

**A run is a `crawls` row.** A few columns on `crawls` are all it takes: the rows already say when a capture happened and when it did not. A separate table of runs would say the same thing twice.

| `crawls` column         | Meaning                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `schedule_id`           | Which schedule this is a run of. `NULL` for a crawl started by hand                                     |
| `scheduled_for`         | When it was due. `NULL` for run-now and for a crawl started by hand                                     |
| `schedule_missed`       | How many runs were merged into this one                                                                 |
| `run_requested_by`      | The subject who pressed run-now (`045`). `NULL` for a due run and for a crawl started by hand           |
| `run_requested_by_name` | Its readable name (`045`). For display; the run's subject (`requested_by`) stays the schedule's creator |

## Who created it, and who pressed run-now

Besides the `032` columns, a schedule row has three more (`045`). All are for display.

| Column                  | Meaning                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `created_by_name`       | The readable name at creation, copied to a run's `requested_by_name`. `NULL` for rows older than `045`                                     |
| `run_requested_by`      | The subject who pressed the waiting run-now. Set with `run_requested_at`, and cleared with it when the run starts, on pause, and on delete |
| `run_requested_by_name` | Its readable name                                                                                                                          |

## request and recipe

| Column    | What it holds                                                                         | Who reads it |
| --------- | ------------------------------------------------------------------------------------- | ------------ |
| `request` | The form's contents, shaped like `POST /api/crawls`                                   | Repin        |
| `recipe`  | How to capture, resolved and pinned, including a copy of each capture script's source | The tick     |

Secrets stay as declarations in `recipe` and are asked of Windmill on every run, so that a deleted variable does not get as far as the flow.

## Rows are not deleted

Deleting a schedule only sets `deleted_at`. Crawl rows show the schedule's name, so removing the row would leave them pointing at nothing. Names are unique among rows that are not deleted, so a deleted name can be used again.
