# Core extension reduction: execution receipt

Goal started 2026-09-08. Status: in progress.

Plan: [core-extension-reduction-2026-09-08.md](core-extension-reduction-2026-09-08.md).
Source baseline: `a3c424d550ad1da91b35bdcb84c8c85bf7bb8e2d`.
Workspace: `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction`.
Branch: `refactor/core-extension-reduction`.

## Baseline

Physical TypeScript/TSX lines include comments and blank lines. Core includes its source test utilities and debug helpers. Markdown is excluded. Count each real source tree once; core-internal points to core/src.

| Source tree             | Files |  Lines |
| ----------------------- | ----: | -----: |
| packages/core/src       |   201 | 45,419 |
| packages/extensions/src |    56 |  9,402 |
| packages/sdk/src        |     7 |  1,050 |
| apps/tui/src            |   143 | 22,839 |
| apps/server/src         |     2 |    794 |

The core package has two export keys for one authoring surface: `./extensions/api` and `./extensions/api.js`. The separate private package has two wildcard keys. No public runtime, protocol, or testing entry point exists yet.

## Commit sequence

1. Remove core-internal imports from core's own implementation tests.
2. Remove unnecessary TUI helper APIs from core. Define and adopt client schemas and the small host/testing contracts. Delete the private package after the last consumer moves.
3. Replace the fixed cell selection with a typed extension tool-surface seam.
4. Add branch resources under the existing actor scope. Make the kernel use ordinary extension declarations and lifetime rules.
5. Move product defaults and context policy. Audit and remove redundant internal paths and files.

The remaining units may need more than one logical commit. Each code commit must pass the full gate and a live Herdr check before the next unit. Review and record the actual paths changed. Record deleted lines separately from moved lines.

## Core implementation test imports

Changed 833 module specifiers in 133 files under packages/core/tests. Each now resolves directly to the owning core source file. The mechanical comparison matched the original source with only path replacement. A duplicate ids import in model-context.test.ts appeared after paths converged; it was merged. Test bodies and fixtures were retained. Production source counts and export counts are unchanged.

Validation: core typecheck passed. The full gate passed after the duplicate-import fix. A direct TUI build selected the Rift binary. Live Herdr ran Luna, evaluated `6 * 7` in a cell, displayed 42 in preview, and reached idle with CORE-IMPORTS-GREEN.

Evidence:

- `/tmp/gent-core-test-imports-files.txt` lists every changed test file by full path.
- `/tmp/gent-core-test-imports-gate.log`
- `/tmp/gent-core-reduction-build.log`
- `/tmp/gent-core-test-imports-herdr.txt`

## Remove the unused multi-range excerpt API

Read and edit had used windowItems only for a fixed first-three/last-three preview. Both now use the existing headTail helper. Removed windowing.ts and its tests, including the extra TUI test of the same pure function. Existing output-buffer tests cover head/tail boundaries. Two renderer tests now check the actual compact read/edit bodies and their omitted-lines markers.

The full gate passed. Live Herdr checked cell read/edit and a direct-tool profile with @gent/cell disabled. Ctrl+O cycled collapsed, preview, full, and collapsed. Full read showed line numbers. Full edit showed the actual replacement. The ten-line file changed from line-NN to row-NN and retained its final newline. FX preview uses its own bounded output view; the renderer tests exercise the compact component bodies.

This unit deletes three files. Production source drops by one file and 104 physical lines. It moves no production code and adds no exports.

Source files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/tool-renderers/read.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/tool-renderers/edit.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/output-buffer.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/message-list-render.test.tsx`

Evidence:

- `/tmp/gent-excerpt-reduction-gate.log`
- `/tmp/gent-excerpt-render-tests.log` (16 tests, 88 assertions)
- `/tmp/gent-excerpt-reduction-preview.txt`
- `/tmp/gent-excerpt-reduction-full.txt`
- `/tmp/gent-excerpt-direct-collapsed.txt`
- `/tmp/gent-excerpt-direct-preview.txt`
- `/tmp/gent-excerpt-direct-full.txt`
- `/tmp/gent-core-renderer-check/sample.txt`
