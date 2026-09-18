# Test fold — `packages/tooling`

Goal: one test file per source concern (rule 1), and for `guards.ts` one file
with a banner per guard section (rule 7).

## Source concerns

| Source                                     | Test file after the fold                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `packages/tooling/src/guards.ts`           | `packages/tooling/tests/guards.test.ts`                                      |
| `packages/tooling/src/fixture-runner.ts`   | `packages/tooling/tests/fixture-runner.test.ts`                              |
| `packages/tooling/src/check-guardrails.ts` | no test today — none added                                                   |
| `packages/tooling/src/test-log-preload.ts` | no test today — none added (it is the `--preload` module of the test script) |

## Map

`guards.test.ts` gets these 16 files, in the order of the sections in
`packages/tooling/src/guards.ts`:

| Old test file                           | Guard section in `guards.ts`    |
| --------------------------------------- | ------------------------------- |
| `blanket-eslint-disable.test.ts`        | `blanket-eslint-disable`        |
| `core-alias-test-layers.test.ts`        | `core-alias-test-layers`        |
| `core-child-session-depth.test.ts`      | `core-child-session-depth`      |
| `core-feature-independence.test.ts`     | `core-feature-independence`     |
| `core-process-runner.test.ts`           | `core-process-runner`           |
| `core-retired-reconciler.test.ts`       | `core-retired-reconciler`       |
| `core-unadapted-seams.test.ts`          | `core-unadapted-seams`          |
| `e2e-fixture-imports.test.ts`           | `e2e-fixture-imports`           |
| `hook-guard-order.test.ts`              | `hook-guard-order`              |
| `lint-config-guards.test.ts`            | `lint-config-guards`            |
| `platform-duplication-guards.test.ts`   | `platform-duplication-guards`   |
| `steering-file-paths.test.ts`           | `steering-file-paths`           |
| `tui-session-identity.test.ts`          | `tui-session-identity`          |
| `diagnostic-suppression-anchor.test.ts` | `diagnostic-suppression-anchor` |
| `suppression-inventory.test.ts`         | `suppression-inventory`         |
| `export-consumers.test.ts`              | `export-consumers`              |

`fixture-runner.test.ts` is `fixtures.test.ts` renamed. It is the only test of
`packages/tooling/src/fixture-runner.ts`, so it keeps its own file.

`testbeds/gamut/tests/gamut-testbed.test.ts` stays where it is (rule 7). The
`packages/tooling` test script runs it from that path.

## Rule 4 — file-global effects

No tooling test file uses `mock.module`, a top-level `beforeAll`/`afterAll`/
`afterEach`, a `process.env` write, or `setSystemTime`. No exception.

## Rule 3 — renames

Three helper names are declared in more than one file. The section stem is the
suffix. The least-used copy is renamed.

| Name         | Kept in                  | Renamed copies                                                                                                |
| ------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `FILE`       | `core-alias-test-layers` | `FILE_SUPPRESSION_ANCHOR` (diagnostic-suppression-anchor), `FILE_TUI_IDENTITY` (tui-session-identity)         |
| `messagesOf` | `hook-guard-order`       | `messagesOfSteeringPath` (steering-file-paths), `messagesOfSuppressionAnchor` (diagnostic-suppression-anchor) |
| `linesOf`    | `steering-file-paths`    | `linesOfSuppressionAnchor` (diagnostic-suppression-anchor), `linesOfTuiIdentity` (tui-session-identity)       |

## Rule 8 — fixture path strings

Tooling tests pass path strings to the guard functions. A guard parses the
string; it never reads the file. Most strings are invented samples
(`widget.ts`, `thing.ts`, `example.ts`) that must NOT name a real file. Only
the strings that name a guard's own exemption have to stay true, and the fold
moved the file each of those named. Four were repointed at
`packages/tooling/tests/guards.test.ts`:

| Site                                                       | Was                                     |
| ---------------------------------------------------------- | --------------------------------------- |
| `guards.ts` `SELF` (diagnostic-suppression-anchor)         | `diagnostic-suppression-anchor.test.ts` |
| `guards.ts` `DESCRIBES_THE_MARKER` (suppression-inventory) | `diagnostic-suppression-anchor.test.ts` |
| `guards.ts` `collectGentVariableUses` skip                 | `tests/lint-config-guards` prefix       |
| `guards.test.ts` process-runner and suppression assertions | the two old test file names             |

The `.oxlintrc.json` override for `effect/noNodeBuiltinImport` named
`packages/tooling/tests/fixtures.test.ts`; it now names
`packages/tooling/tests/fixture-runner.test.ts`. The
`an override must match a tracked file` guard failed until it was fixed.

Every remaining path string was checked against the working tree. All 55 that
name a real file still resolve; all 66 that name a sample are still absent.

## Counts

- Files before: 17 in `packages/tooling/tests`, 18 with the gamut testbed.
- Files after: 2 in `packages/tooling/tests`, 3 with the gamut testbed.
- Tests before: 261 pass, 0 fail, 497 `expect()` calls.
- Tests after: 261 pass, 0 fail, 497 `expect()` calls.
- Wall time before: 532 ms.
- Wall time after: 341 / 326 / 326 ms over three runs.
- Slowest folded file on its own: `guards.test.ts`, 47 ms for 215 tests. No
  split is needed (rule 9).
