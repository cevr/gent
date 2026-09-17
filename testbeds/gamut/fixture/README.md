# ledgerline

A small personal-finance ledger: CSV import, rule-based categorisation, SQLite
storage, monthly reports, a CLI and a JSON API. Bun + TypeScript, no runtime deps.

```
bun install
bun test
bun run cli import fixtures/march.csv
bun run cli categorize
bun run cli report 2026-03
bun run serve
```

## Layout

| Path | Owns |
| --- | --- |
| `src/domain/money.ts` | integer-cent money, parse and format |
| `src/domain/transaction.ts` | transaction shape, validation, stable ids |
| `src/import/csv.ts` | RFC 4180 reader and header mapping |
| `src/rules/categorize.ts` | rule engine and default rules |
| `src/store/sqlite.ts` | `LedgerStore` on `bun:sqlite` |
| `src/report/monthly.ts` | monthly aggregation and rendering |
| `src/cli.ts` | commands; `importCsv` and `applyRules` are reused by the API |
| `src/api/server.ts` | `Bun.serve` JSON API |

## Open tasks

Tasks 1 to 3 are failing tests. Tasks 4 to 6 are additions with no test yet. Each is self-contained.

1. `parseAmount("0.5")` returns 5 cents. One-digit fractions are tenths.
2. `parseCsv` drops a doubled quote inside a quoted field. `"say ""hi"""` must yield `say "hi"`.
3. `monthOf("2026-03-01")` returns `2026-3`, so every report is empty. Months are zero-padded.
4. Rent and utilities have no rule. Add rules so `Landlord LLC` lands in `housing`; add a test.
5. The API has no test. Add `tests/api.test.ts` that imports the fixture over HTTP and reads `/report/2026-03`.
6. `LedgerStore.list` builds two query strings. Collapse to one prepared statement without changing behaviour.
