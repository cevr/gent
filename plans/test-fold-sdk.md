# Test fold — `packages/sdk`

Goal: one test file per source concern (rule 1). `packages/sdk/src/` holds six
files.

## Map

| Source                                  | Test file after the fold       | Folded in                                                                   |
| --------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `packages/sdk/src/server.ts`            | `tests/server.test.ts`         | `build-fingerprint.test.ts`, `launch-config.test.ts`, `server-lock.test.ts` |
| `packages/sdk/src/client.ts`            | `tests/client.test.ts`         | `client.test.ts` (kept), `server-options.test.ts`                           |
| `packages/sdk/src/logger.ts`            | `tests/logger.test.ts`         | `logger.test.ts` (kept), `tracer.test.ts`                                   |
| `packages/sdk/src/index.ts`             | `tests/index.test.ts`          | `public-surface.test.ts` renamed                                            |
| `packages/sdk/src/namespaced-client.ts` | no file of its own — see below |                                                                             |
| `packages/sdk/src/runtime-boundary.ts`  | no test today — none added     |                                                                             |

`GentTracerLive` lives in `packages/sdk/src/logger.ts`, so `tracer.test.ts`
folds into `logger.test.ts`.

`packages/sdk/src/namespaced-client.ts` is exercised by two tests that already
sit in `client.test.ts`: `namespaced client exposes every RPC key from
GentRpcs` and `namespaced client attaches workspace header to RPC effects`.
`Gent` in `client.ts` is the only constructor of a namespaced client, so the
client test file is the file that exercises the concern most (rule 1). The
tests stay there; no new file is cut out of an existing one.

## Rule 4 — file-global effects

No sdk test file uses `mock.module`, a top-level `beforeAll`/`afterAll`/
`afterEach`, a `process.env` write, or `setSystemTime`. No exception.

## Rule 3 — renames

No top-level name is declared in two files of the same fold group. No rename.

Two describe blocks have near names but different tests:
`describe("BuildFingerprint")` from `build-fingerprint.test.ts` and
`describe("Build Fingerprint")` from `server-lock.test.ts`. Both are kept as
written; no `describe` + test name pair repeats.

## Duplicate import resolved by hand

`client.test.ts` imported `extractText` from `../src/index` and
`server-options.test.ts` imported it from `../src/client`. `index.ts`
re-exports the same binding, so the merged file declared the name twice. Both
helper imports in `client.test.ts` now come from `../src/client`, and the
`Message` type alone comes from `../src/index`.

## Rule 8 — path strings

`packages/tooling/src/guards.ts` holds an approved-suppression entry keyed by
`packages/sdk/tests/server-lock.test.ts`. It now names
`packages/sdk/tests/server.test.ts`. No other file names a removed sdk test.

## Counts

- Files before: 8.
- Files after: 4.
- Tests before: 58 pass, 0 fail, 326 `expect()` calls.
- Tests after: 58 pass, 0 fail, 326 `expect()` calls.
- Wall time before: 4.73 s.
- Wall time after: 5.22 / 5.34 / 4.32 s over three runs.
- Slowest folded file on its own: `client.test.ts`, 4.57 s for 13 tests. It
  starts a real server per option test. No split is needed (rule 9).
