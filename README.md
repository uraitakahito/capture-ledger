# capture-ledger

A capture orchestrator built on [BrowserHive](https://github.com/uraitakahito/browserhive).
It answers one question — **which URLs get captured** — and keeps the ledger of what
came back. Seeds are an explicit list or the enabled rows of a Postgres `capture_targets`
table; capture-ledger decides what is in scope and hands one level at a time to a
Windmill flow ([capture-scheduler](https://github.com/uraitakahito/capture-scheduler)),
which submits to BrowserHive and reports back. What produced an archive goes into an
archive ledger, and callers allowed to read an archive get a short-lived signed URL
for it.

## Documentation

Everything — quickstart, and guides (development environment, URL source, capture
options, archive ledger, architecture) — lives on the docs site:

- **English** — <https://uraitakahito.github.io/capture-ledger/>
- **日本語** — <https://uraitakahito.github.io/capture-ledger/ja/>

Anything about _how_ a page is captured — behaviors, WACZ, storage, the browser —
belongs to BrowserHive. Its docs are not published on the web; build them from the
BrowserHive checkout with `pnpm run docs:local`.

## Related Projects

- [capture-scheduler](https://github.com/uraitakahito/capture-scheduler) — the Windmill flow that submits each level to BrowserHive and reports back.
- [BrowserHive](https://github.com/uraitakahito/browserhive) — the capture server: drives the browser, builds the WACZ, writes to S3.
- [OpenFGA](https://openfga.dev/) — the authorization store behind the archive ledger.

## License

[Unlicense](./LICENSE).
