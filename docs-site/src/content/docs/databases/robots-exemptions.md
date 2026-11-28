---
title: robots_exemptions
description: Exemptions from robots.txt. An organization admin registers, per host and path pattern, "capture this even where robots.txt disallows it", with a reason, an expiry and the User-Agent to announce.
---

**One row is one exemption from robots.txt.** An organization admin registers "capture this path pattern on this host even where robots.txt disallows it" (`046`). How to register and revoke, and who may, is in [Exemptions from robots.txt](/capture-ledger/archive-ledger/#exemptions-from-robotstxt).

:::caution[In this version, crawls do not use it yet]
This version adds the table and the API only. Registering a row changes nothing: crawls keep obeying robots.txt as before. Crawls start reading the rows in the next version.
:::

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

Revoking only sets `revoked_at` and `revoked_by`. In the next version, page records and WACZ files point at the row's number, so the row stays. To extend an exemption, register a new row.

## Rows in effect

A row is in effect when it is not revoked (`revoked_at` is NULL) and not yet expired (`expires_at` is later than now). The API returns a `state` with each row (`active`, `expired` or `revoked`). A revoked row stays `revoked` after its expiry passes.

## What holds within one organization and host

- At most one row in effect per path pattern.
- One `user_agent` among the rows in effect (registering a different one is refused).

"In effect" changes with time, so a unique index cannot say this (an index predicate cannot hold the current time). The registering transaction takes an advisory lock (`pg_advisory_xact_lock`) on the organization and host, then looks at the rows in effect and inserts (`src/exemptions/store.ts`). It does not lock rows with `FOR UPDATE`, because with no rows yet there is nothing to lock and two simultaneous registrations would both pass. CI checks against a real Postgres that only one of several simultaneous registrations passes (`src/tools/robots-exemptions-smoke.ts`).

The shape of the strings (host, path pattern, User-Agent, reason, expiry) is checked by the API at registration (`src/exemptions/validate.ts`). The CHECK constraints cover only the columns with a fixed vocabulary and the lower bounds of the numbers.
