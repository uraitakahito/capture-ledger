---
title: crawl_links
description: Every link found on a captured page, one row each, with what became of it. The source of a crawl's link structure.
---

**One row is one link found on a captured page.** The primary key is the page the link was on (`from_page`) and its position on that page (`seq`). The level report reads each page's `.links.json`, applies the rules and the limits, and keeps the decision it made right there. `.links.json` lives outside the WACZ and goes away when the store is rebuilt, so "which link on which page was not captured, and why" stays only here. Reading it is in [Every link, one row](/capture-ledger/archive-ledger/#every-link-one-row).

```ts file="src/db/migrations/039-create-crawl-links.ts#crawl-links-columns"

```

## Outcomes

| `outcome`   | Meaning                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `followed`  | Entered the next level. The target's `crawl_pages` row has this page as its `discovered_from` (a tree edge)                        |
| `known`     | A row already exists: a link to a captured page, back to a seed, to a URL another page found first in the same level, or to itself |
| `max_pages` | The rules let it through, but the page limit kept it out                                                                           |
| `max_depth` | The rules let it through, but the depth limit kept it out                                                                          |
| `closed`    | The rules let it through, but the crawl was closed (a level report that arrived after the crawl was closed)                        |
| `skip`      | A rule dropped it. `rule` `0` means no rule matched                                                                                |
| `nofollow`  | `rel="nofollow"`, so it was set aside before any rule ran. `rule` is NULL                                                          |

A pure function (`src/crawl/link-outcomes.ts`) decides, from the target's `crawl_pages` row (URL → the page that found it). It is not told what entered the next level, so reporting a level again, or backfilling later, writes the same rows.

## What makes a row

- **A second link that differs only after `#` is not written.** Normalized, it is the same URL. When one URL appears both with and without `nofollow`, the one without is kept.
- **Pages whose links are not read have no rows**: capture-only targets, and pages redirected out of the followed range (their `.links.json` exists and is not read).
- **Up to 2,000 links per page.** The rest are not written; the count goes to the log.

## Replaced by the level report

Inside its final transaction, after the next level's pages are inserted, the level report **deletes this level's pages' rows and inserts them again**. A level report that arrives twice does not add rows.

## Crawls with no record

A crawl with no links and a crawl from before this table both have no rows. `crawls.links_recorded_at` tells them apart: NULL means no record. `pnpm run links:backfill --write` fills earlier crawls by reading `.links.json` back from the store (a crawl missing any `.links.json` is skipped). Without `--write` it only counts.

## The link count on the list

For a crawl with a record, `crawls.pages_discovered` is the number of distinct URLs the rules let through (seeds are not counted). A crawl with no record keeps the per-level sum.
