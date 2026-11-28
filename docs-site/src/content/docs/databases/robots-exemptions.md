---
title: robots_exemptions
description: Exemptions from robots.txt. An organization admin registers, per host and path pattern, "capture this even where robots.txt disallows it", with a reason, an expiry and the User-Agent to announce.
---

**One row is one exemption from robots.txt.** An organization admin registers "capture this path pattern on this host even where robots.txt disallows it" (`046`). How to register and revoke, and who may, is in [Exemptions from robots.txt](/capture-ledger/archive-ledger/#exemptions-from-robotstxt).

Each time a crawl starts a level, it looks up the rows in effect for that level in this table and hands them to the flow (`047`, `src/exemptions/dispatch.ts`). Which rows apply to which crawl is in [How rows reach a crawl](/capture-ledger/archive-ledger/#how-rows-reach-a-crawl).

```ts file="src/db/migrations/046-create-robots-exemptions.ts#robots-exemptions-columns"

```

| Column                                        | What it holds                                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                          | A serial number (bigserial). The API returns it as a string                                                                                                    |
| `org_id`                                      | The organization named in the request body. Only an admin of that organization can register                                                                    |
| `host`                                        | The `url.host` form (lower case, punycode, a non-default port kept); the same vocabulary as `crawl_pages.host`. No wildcards                                   |
| `path_pattern`                                | A path pattern written the way robots.txt writes one (`*` and a trailing `$`). Defaults to `/` (the whole host)                                                |
| `scope`                                       | `seeds` (seeds only) or `links` (followed links too). CHECK                                                                                                    |
| `applies_to`                                  | `all` (every crawl) or `human` (only crawls a person started). Defaults to `all`. CHECK                                                                        |
| `user_agent`                                  | The name to announce on this host: `BrowserHive/<version>` and one optional comment in parentheses. Strings that pose as a browser are refused at registration |
| `reason`                                      | The reason, 1 to 500 characters                                                                                                                                |
| `daily_limit`, `link_limit`                   | How many pages this row may exempt: per 24 hours (default 100), and among the followed links of one crawl (default 20). Both at least 1 (CHECK)                |
| `created_by`, `created_by_name`, `created_at` | Who registered it (the token's `sub`), their readable name at the time (NULL when unknown), and when                                                           |
| `expires_at`                                  | The expiry, at most 90 days after registration                                                                                                                 |
| `revoked_at`, `revoked_by`, `revoked_by_name` | When it was revoked, by whom, and their name. `revoked_at` and `revoked_by` are both set or both NULL (CHECK)                                                  |

The index is `(org_id, host)`: it serves an organization's list, and the look at the same organization and host when registering.

## Rows are never deleted

Revoking only sets `revoked_at` and `revoked_by`. Page records (`crawl_pages.robots_exemption_id`) and the declaration in WACZ files point at the row's number, so the row stays. To extend an exemption, register a new row.

## Rows in effect

A row is in effect when it is not revoked (`revoked_at` is NULL) and not yet expired (`expires_at` is later than now). The API returns a `state` with each row (`active`, `expired` or `revoked`). A revoked row stays `revoked` after its expiry passes.

## What holds within one organization and host

- At most one row in effect per path pattern.
- One `user_agent` among the rows in effect (registering a different one is refused).

"In effect" changes with time, so a unique index cannot say this (an index predicate cannot hold the current time). The registering transaction takes an advisory lock (`pg_advisory_xact_lock`) on the organization and host, then looks at the rows in effect and inserts (`src/exemptions/store.ts`). It does not lock rows with `FOR UPDATE`, because with no rows yet there is nothing to lock and two simultaneous registrations would both pass. CI checks against a real Postgres that only one of several simultaneous registrations passes (`src/tools/robots-exemptions-smoke.ts`).

The shape of the strings (host, path pattern, User-Agent, reason, expiry) is checked by the API at registration (`src/exemptions/validate.ts`). The CHECK constraints cover only the columns with a fixed vocabulary and the lower bounds of the numbers.

## The columns on the crawl side

`047` added one column to each of the crawl's two tables.

```ts file="src/db/migrations/047-add-robots-exemption-to-crawls.ts#crawls-exemption-eligibility"

```

`crawls.exemption_eligibility` says which rows may apply to the crawl: `none` (no row), `machine` (only rows whose `applies_to` is `all`) or `human` (all rows). It is decided once when the crawl starts and kept (`src/exemptions/eligibility.ts`), and never rewritten. Rows older than `047` hold `none`.

```ts file="src/db/migrations/047-add-robots-exemption-to-crawls.ts#crawl-pages-robots-exemption"

```

`crawl_pages.robots_exemption_id` holds the number of the exemption row, and only on a page that robots.txt disallowed and that row exempted. It is copied from `robotsExemptionId` in the level report. A page that was exempted and then failed to capture (`failed`) has it too. A page merely captured under the row's User-Agent (one robots.txt does not disallow) does not, and neither does a page skipped at a limit (`skip_reason` is `robots-exemption-limit`). Rows of this table are never deleted, so the reference keeps the default ON DELETE (a row a page points at cannot be deleted).

## Counting pages

A row's limits (`daily_limit`, `link_limit`) are counted through `crawl_pages.robots_exemption_id`. Each time a level starts, two numbers are counted and what is left is handed over.

- The 24-hour count: pages that carry the row's number and whose `finished_at` falls within the last 24 hours. The partial index `crawl_pages_robots_exemption_idx` (`(robots_exemption_id, finished_at)`, only rows that hold a number) serves it.
- The per-crawl link count: pages of that crawl at depth 1 or deeper that carry the row's number.

Neither looks at how the page ended. A page that failed to capture counts as a request sent to the other end. Only one crawl runs at a time, and a level starts after the previous level has been reported, so no page is "being exempted" while the count is taken. `usedLast24h` in the list API counts the same way as the first. CI checks against a real Postgres that the counting SQL runs and the numbers agree (`src/tools/robots-exemptions-smoke.ts`).
