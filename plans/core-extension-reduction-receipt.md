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

## Preserve cache usage

The user added prompt-cache work based on OpenCode v2. Before changing prompt policy, preserve the Effect provider's optional cache-read and cache-write counts in Gent's durable usage schema. Keep total input tokens unchanged. Invalid or absent normalized counts stay absent. Old events still decode. This adds no files, services, or exports.

The full gate passed. Live Herdr connected the TUI to a dedicated server with a temporary SQLite database. Luna ran a cell that retained 42, then used the value in a second turn to produce 43. Both turns reached idle. Ctrl+O showed preview, full, and collapsed levels. Four StreamEnded records contained the new fields. All four reported zero cache reads and writes. This proves counter delivery, not a cache improvement. The installed OpenAI adapter defaults an absent wire cache-read detail to zero; these are normalized provider counts, not raw HTTP evidence.

Source files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/response-to-prompt.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-turn-response.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/node_modules/@effect/ai-openai/src/OpenAiLanguageModel.ts` (normalization boundary)

Evidence:

- `/tmp/gent-cache-usage-gate.log`
- `/tmp/gent-cache-usage-herdr-preview.txt`
- `/tmp/gent-cache-usage-herdr-second-turn.txt`
- `/tmp/gent-cache-usage-herdr-full.txt`
- `/tmp/gent-cache-usage-live-counts.json`
- `/tmp/gent-cache-usage-check/state/data.db`

Session: `01a08419-8626-741f-bc8d-1e2f354d6658`. Total input counts: 7,297; 7,356; 7,390; 7,441. Total output counts: 442; 9; 25; 9.

Commit: `a09715d8`. The first commit hook timed out in the unchanged run-process test. All seven tests in that file passed on a focused rerun. The full commit checks then passed. Receipts: `/tmp/gent-cache-usage-commit.log`, `/tmp/gent-cache-usage-process-check.log`, and `/tmp/gent-cache-usage-commit-retry.log`.

## Keep Codex context updates in order

The Codex transport previously moved every system/developer row into the initial instructions. It now moves only the leading rows. Later updates stay in place as developer messages. Existing top-level instructions are retained. The legacy chat conversion uses the same instruction split, so the two paths share one rule.

HTTP boundary tests compare two successive bodies. The second adds a date update after a completed call/result pair. Initial instructions, old call ID, input, and result remain unchanged. A second test checks chat conversion with a late update. The full gate passed. Live Herdr ran Luna through two cell turns, retained 42, returned 43 on the next turn, and displayed preview/full/collapsed levels. The live session checks the normal provider path. The HTTP tests check chronological updates; Gent does not yet generate durable date changes.

This unit adds no files or exports to production. Date/catalog admission, other provider lowering, and explicit cache controls remain pending. No cache gain is claimed.

Source files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/openai/codex-transform.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/tests/openai/openai-codex-transform.test.ts`

Evidence:

- `/tmp/gent-cache-prefix-gate.log`
- `/tmp/gent-cache-prefix-herdr-preview.txt`
- `/tmp/gent-cache-prefix-herdr-full.txt`

## Route Codex cache requests by session

Provider hints now carry the durable session ID as an optional cache key. The OpenAI OAuth Responses driver sends it as `prompt_cache_key`. Two runtime turns retain the same ID. HTTP tests verify repeated and distinct keys. Google and Mistral requests omit this OpenAI field.

The full gate passed. Live Herdr ran two Luna cell turns in one kernel, returned 42 then 43, and showed all three disclosure levels. The TUI returned to the shell. Four saved usage records reported zero cache reads and writes. No cache gain is claimed.

The API-key compatibility adapter drops this field during serialization. This unit does not enable cache routing on that path. The remaining provider work must fix and test that boundary.

Source files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/driver.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/turn-source.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop/model-context.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/openai/index.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/tests/openai/openai-extension-driver.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/tests/openai-compatible-providers.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/node_modules/@effect/ai-openai-compat/src/OpenAiLanguageModel.ts`

Evidence:

- `/tmp/gent-cache-routing-gate.log`
- `/tmp/gent-cache-routing-herdr-preview.txt`
- `/tmp/gent-cache-routing-herdr-full.txt`
- `/tmp/gent-cache-routing-live-counts.json`
- `/tmp/gent-cache-routing-check/state/data.db`

Session: `01a0842f-6110-741d-891f-f6bcbf7f8d4d`.

Commit: `72c9c61a`. Commit checks passed. Log: `/tmp/gent-cache-routing-commit.log`.

## Preserve API-key cache routing on the wire

The OpenAI API-key driver now supplies the same session key. A pinned Bun patch copies that field through the compatibility adapter's Chat Completions serializer. The patch changes source and exported JavaScript. It preserves absence when no key is supplied. No package versions changed. Current upstream and the newest published RC still have the defect; see the linked adapter research note.

HTTP tests cover generation and streaming, repeated keys, distinct keys, omitted keys, endpoint, and authorization. Existing OAuth and Google/Mistral checks also pass. The full gate passed after test style and typing fixes.

Live Herdr ran two Luna cell turns, retained 42, returned 43, and showed preview/full/collapsed levels. This live run uses OAuth. The HTTP tests prove the API-key repair. No live API-key request or cache gain is claimed.

Source files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/package.json`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/bun.lock`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/patches/@effect%2Fai-openai-compat@4.0.0-rc.112.patch`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/openai/index.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/tests/openai/openai-extension-driver.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/plans/openai-compat-cache-key-priors-2026-09-08.md`

Evidence:

- `/tmp/gent-cache-compat-patch.log`
- `/tmp/gent-cache-compat-gate.log`
- `/tmp/gent-cache-compat-herdr-preview.txt`
- `/tmp/gent-cache-compat-herdr-full.txt`

Commit: `0b44e887`. Commit checks passed. Log: `/tmp/gent-cache-compat-commit.log`.

## Preserve Anthropic context order

A pinned patch repairs the Anthropic serializer. It retains the initial system group. It lowers later system groups to escaped user text at their original position. It also handles history that has no initial system message. It copies the existing cache control to the resulting text block. The patch changes both source and exported JavaScript. No package version or Gent runtime export changed.

The repair serves text generation, structured output, and streaming. HTTP tests exercise all three through the real API-key and OAuth extension layers. They compare initial instructions and the old message prefix, including a completed cell call/result. They check escaped update text, its cache marker, and absent initial system text. The full gate passed after test fixture, typing, and style fixes.

The fallback has user authority. It cannot override initial system constraints. It can change thinking-cache behavior on older models. The host must append updates after all client tool results and must respect unresolved server-tool rules. The serializer does not repair invalid tool history. Native model-aware system-role support remains separate work. See the provider research note for primary evidence.

Live Herdr ran two Luna cell turns, retained 42, returned 43, and showed preview/full/collapsed levels. This checks the normal TUI path. The HTTP tests check Anthropic conversion. No live Anthropic acceptance or cache gain is claimed.

Source counts remain 200 core files / 45,337 lines; 56 extension files / 9,411 lines; 7 SDK files / 1,050 lines; 143 TUI files / 22,833 lines; and 2 server files / 794 lines. Relative to the initial inventory, this is one production source file and 79 physical lines removed. No production source moved. These counts exclude dependency patches. This unit adds one patch file with 22 added source/distribution lines. It adds no Gent production source file, export, or package.

Source files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/package.json`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/bun.lock`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/patches/@effect%2Fai-anthropic@4.0.0-rc.112.patch`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/tests/anthropic/anthropic-extension-driver.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/plans/anthropic-context-priors-2026-09-08.md`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/plans/durable-context-admission-2026-09-08.md`

Evidence:

- `/tmp/gent-anthropic-context-patch.log`
- `/tmp/gent-anthropic-context-tests.log`
- `/tmp/gent-anthropic-context-gate.log`
- `/tmp/gent-anthropic-context-herdr-preview.txt`
- `/tmp/gent-anthropic-context-herdr-full.txt`
- `/tmp/gent-core-reduction-current.json`

Commit: `ffba72e7`. Commit checks passed. Log: `/tmp/gent-anthropic-context-commit.log`.

Pending visual defect: after the disclosure replay, the first prompt's second wrapped line lost its left border. The initial live view had a border on both lines. The full-view receipt above records the missing border. Reproduce this during the native-transcript unit. Check replay and committed scrollback rows, not only the live message component. Functional cell checks passed; this visual issue remains open.

## Let extensions select the model tool surface

The existing `turnProjection` hook now supports `ToolPolicyFragment.modelSet`. The last explicit set selects a subset of the final admitted host tools. An empty set selects none. Missing, denied, and filtered interactive tools stay unavailable. Selection retains the admitted capability and binding identities. No new hook kind or registry was added.

The cell extension uses that policy to include and select `cell`. It skips selection for external drivers and an explicit agent denial. It renders the host catalog through the existing `systemPrompt` hook. The hook receives admitted `hostTools`. The new public `getToolPrompt` accessor returns prompt text without execution metadata. The raw metadata accessor remains private. Projection hooks now see the resolved driver, including config overrides.

The turn resolver, policy compiler, and general prompt builder have no remaining `cell` name rule. Registering a tool with that name alone does not select it or bypass an allow list. The cell catalog is appended by its owning hook; earlier prompt rewrites remain intact. Kernel branch ownership and the worker build still belong to core and remain pending work.

Pure policy tests cover selection, empty selection, precedence, unknown names, duplicate names, denials, interactive filtering, and the removed name exception. RPC tests register an ordinary extension and run its `bridge` tool. One test uses direct tools. The other selects only the bridge. Both confirm the admitted host set and persisted tool result. Shipped-cell tests check the real catalog, host read calls, concurrency, allow lists, and external-driver dispatch. A lifetime fixture now loads the real cell extension instead of relying on the old name rule. Its child, reset, and branch checks pass. The full gate passed.

Live Herdr used Luna to read a fixture through `tools.call` inside the cell. A second turn reused the retained text and returned true. Preview and full views showed the nested read and retained binding. A separate directory disabled `@gent/cell`; Luna then called `read` directly and completed. The wrapped-prompt border defect reproduced during replay and remains open.

This unit adds no source files or packages. It adds one public function export and 31 net core source lines. The 12-line input-key formatter moved unchanged. The former 22-line catalog block moved into the cell hook with changes; its functionality was not deleted. Core now has 200 files / 45,368 lines. Other source counts stay at the preceding values. Across the work so far, production source is one file and 48 physical lines below the baseline. Dependency patches remain outside those source counts.

Source files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/capability/tool.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.utils.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/turn-resolve.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/code-cell/cell-extension.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/extensions/registry.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/extensions/cell-default-surface.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/extensions/compile-tool-policy.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop/turn-prompt-sections.test.ts`

Evidence:

- `/tmp/gent-model-surface-gate.log`
- `/tmp/gent-model-surface-tests.log`
- `/tmp/gent-model-surface-rpc-tests.log`
- `/tmp/gent-model-surface-lifetime-tests.log`
- `/tmp/gent-model-surface-herdr-preview.txt`
- `/tmp/gent-model-surface-herdr-full.txt`
- `/tmp/gent-model-surface-direct-herdr-preview.txt`
- `/tmp/gent-model-surface-direct-herdr-full.txt`
- `/tmp/gent-model-surface-direct/.gent/config.json`
- `/tmp/gent-model-surface-check/note.txt`
- `/tmp/gent-core-reduction-current.json`

## Child tracking through RPC — 2026-09-09

The TUI child tracker now uses the client's `session.events` stream. It no longer requires the server-only `EventStore` service in the client runtime. Child subscriptions use the child branch ID when available.

A saved parent completion can arrive before child history has finished loading. Completion now stops the live child subscription and folds saved child events through `StreamSynchronized`. It publishes the final snapshot before the terminal child state. This keeps child tools and text on replay. Stop clears entries and fiber references.

Three real RPC tests passed with 16 assertions. They verify live tool/text updates, completed history, failed history, branch filtering, and cleanup. Each test also confirms that the client runtime has no `EventStore`. The full gate passed. The initial test fixture lacked the RPC workspace identity and used an outdated `Stream.filterMap` result type. Both fixture errors were corrected before the gate passed.

Herdr ran two live Luna checks in pane `wZ:pH`. One called delegate from a cell. One used a direct delegate with the cell extension disabled. Both children read the fixture and returned the expected marker and first line. The collapsed, preview, and full levels remained usable. These UI checks show tool completion and output; the RPC tests prove the tracker snapshots. The known wrapped prompt border defect still appears after disclosure replay. It remains open for the native transcript work.

This unit adds 16 production lines and no production files or public core exports. Current production totals remain one file and 32 physical lines below the baseline. No code was moved in this unit. The private package still exists. The one-shot `-p` work remains queued after the cache work, with all normal tools, approvals, and child work retained.

Changed files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/hooks/use-child-sessions.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/services/child-session-tracker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/child-session-tracker.test.ts`

Other source receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/sdk/src/transport-headers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/server/rpc-handlers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/server/workspace-rpc.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/storage/event-storage.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/plans/inline-prompt-priors-2026-09-08.md`

Evidence:

- `/tmp/gent-child-tracker-tests.log`
- `/tmp/gent-child-tracker-gate.log`
- `/tmp/gent-child-tracker-herdr-live.txt`
- `/tmp/gent-child-tracker-herdr-preview.txt`
- `/tmp/gent-child-tracker-herdr-full.txt`
- `/tmp/gent-child-tracker-herdr-collapsed.txt`
- `/tmp/gent-child-tracker-direct-herdr-live.txt`
- `/tmp/gent-child-tracker-direct-herdr-preview.txt`
- `/tmp/gent-child-tracker-direct-herdr-full.txt`
- `/tmp/gent-model-surface-direct/.gent/config.json`
- `/tmp/gent-model-surface-check/note.txt`
- `/tmp/gent-core-reduction-current.json`

## Client protocol and SDK imports — 2026-09-09

Added `@gent/core/protocol` as an explicit entry point in the existing core package. It exposes 72 named client schemas, projections, and RPC declarations. It does not export storage tags, `EventStore`, `SessionRuntime`, or `RpcHandlersLive`. Core implementation files retain relative imports. The entry point has two package keys for extensionless and `.js` consumers. It has no wildcard export.

The SDK now imports shared client data through that entry point. Its 55 public value/type export declarations and aliases are unchanged. Host construction still uses the private package. TUI imports will move in the next sub-commit. Runtime/test contracts and private package removal remain incomplete.

The import guard accepts explicit protocol paths and rejects unknown core paths and protocol wildcards. Eight guard tests passed. Core and SDK type checking passed. The full gate passed. Loading the protocol module from Bun succeeded; the checked host tags were absent. Existing SDK/RPC tests passed through the changed imports.

Herdr ran the compiled TUI with live Luna in pane `wZ:pH`. It streamed `Checking protocol.`, called `read` from a cell, and returned `PROTOCOL-OK — surface verified`. The preview showed the file result. The full level showed cell source and nested tool output. The third toggle returned to collapsed output. The check did not prove a cache improvement or fix the known long-transcript border defect.

This sub-commit adds one production file and 57 net physical source lines: 71 core lines added and 14 SDK lines removed. These removed lines are import consolidation, not removed behavior. No implementation moved. Across the goal, production file count now equals the baseline and physical source lines are 25 above it. Package count is unchanged. This is a contract step toward private package removal, not a source reduction claim.

Changed code and contract files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/protocol.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/package.json`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/sdk/src/client.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/sdk/src/index.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/sdk/src/namespaced-client.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/sdk/src/runtime-boundary.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/sdk/src/server.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/tooling/src/core-public-exports.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/tooling/tests/core-public-exports.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/tsconfig.json`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/ARCHITECTURE.md`

The protocol file names each owning source module. The full caller inventory is saved in `/tmp/gent-core-consumer-current.json`. The bounded mechanical SDK migration used a Luna agent; root review checked the final imports and public names.

Evidence:

- `/tmp/gent-protocol-export-map.json`
- `/tmp/gent-protocol-core-typecheck.log`
- `/tmp/gent-sdk-protocol-typecheck.log`
- `/tmp/gent-protocol-guards-tests.log`
- `/tmp/gent-protocol-sdk-surface.json`
- `/tmp/gent-protocol-load.log`
- `/tmp/gent-protocol-sdk-gate.log`
- `/tmp/gent-protocol-sdk-herdr-live.txt`
- `/tmp/gent-protocol-sdk-herdr-preview.txt`
- `/tmp/gent-protocol-sdk-herdr-full.txt`
- `/tmp/gent-core-reduction-current.json`

## TUI protocol imports — 2026-09-09

Migrated 56 TUI source, test, and integration files to the supported protocol entry point. The mechanical check found zero mismatches in imported/re-exported names, aliases, type-only status, or code outside declarations. No mapped symbols remain on their old private modules. Model defaults, host services, and test construction still have private imports; those contracts remain incomplete.

The first gate found that the extension import rule treated the new protocol path as private in TUI client extensions. The rule now permits only the exact extensionless and `.js` protocol entry points in client extension files. Server extension implementations remain on the authoring API. Added fixtures reject server imports of protocol and reject nested protocol/internal paths in client extensions. The fixture suite passed: 36 tests and 79 assertions.

TUI type checking and the full gate passed. The changed session-feed integration and excluded headless-runner tests also passed: 10 tests and 26 assertions. Herdr ran live Luna in the compiled TUI. One cell called `context.status()` and `context.newWindow()`. The status result, scheduled window result, durable new-window marker, and `TUI-PROTOCOL-OK` appeared. Preview and full levels exposed the cell output/source. The third toggle returned to collapsed output. This does not prove cache savings or resolve the recorded native transcript border defect.

This unit removes three production source lines through import consolidation. It adds no production files, packages, or protocol exports. The new guard fixtures are test files. No implementation moved. Current production totals have the same file count as baseline and 22 more physical source lines. The private package still exists. Host/kernel lifecycle work remains before removal can finish.

The bounded mechanical TUI migration used a Luna agent. Root reviewed representative client, driver, and child-tracker diffs and checked every changed file with the declaration/body audit. The first run produced no source changes; root stopped that run and resumed the same task with a direct execution step.

Changed TUI source/test files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/integration/session-feed-boundary.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/app-bootstrap.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/client/agent-state.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/client/event-hub.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/client/session-state.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/composer-drafts.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/composer-state.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/composer.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/interaction-renderers/ask-user.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/interaction-renderers/option-list.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/message-picker.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/session-tree.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/tool-renderers/agent-tree.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/use-composer-controller.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/extensions/builtins/driver.client.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/extensions/client-facets.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/extensions/client-transport.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/headless-runner.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/hooks/use-child-sessions.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/router/index.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/routes/auth-state.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/routes/auth.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/routes/branch-picker.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/routes/session-controller.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/routes/session-ui-state.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/routes/session.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/services/child-session-tracker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/utils/format-error.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/utils/session-labels.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/agent-lifecycle.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/app-auth.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/app-bootstrap.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/auth-route.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/auth-state.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/autocomplete-effect-items.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/child-session-tracker.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/client-session-state.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/components/command-palette.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/components/interaction-renderers/ask-user.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/components/interaction-renderers/handoff.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/components/interaction-renderers/prompt.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/components/session-tree.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/extension-integration.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/extension-test-harness-boundary.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/extensions-resolve.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/headless-runner.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/local-health.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/render-harness-boundary.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/router.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/sdk-utilities.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/session-controller-state.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/use-session-feed.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/widgets-render.test.tsx`

Other changed files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/AGENTS.md`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/AGENTS.md`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/lint/no-direct-env.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/tooling/tests/fixtures.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/tooling/fixtures/packages/extensions/src/no-extension-internal-imports.invalid.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/tooling/fixtures/apps/tui/src/extensions/protocol-imports.valid.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/tooling/fixtures/apps/tui/src/extensions/protocol-imports.invalid.ts`

Evidence:

- `/tmp/gent-tui-protocol-audit.json`
- `/tmp/gent-tui-protocol-files.txt`
- `/tmp/gent-tui-protocol-typecheck.log`
- `/tmp/gent-tui-protocol-guards-tests.log`
- `/tmp/gent-tui-protocol-integration.log`
- `/tmp/gent-tui-protocol-gate.log`
- `/tmp/gent-tui-protocol-herdr-live.txt`
- `/tmp/gent-tui-protocol-herdr-preview.txt`
- `/tmp/gent-tui-protocol-herdr-full.txt`
- `/tmp/gent-tui-protocol-herdr-collapsed.txt`
- `/tmp/gent-core-reduction-current.json`
- `/tmp/gent-core-host-contract-audit.md`
- `/tmp/gent-native-border-audit.md`

Final collapse observation: `/tmp/gent-tui-protocol-herdr-collapsed.txt` and `/tmp/gent-tui-protocol-herdr-after-collapse.txt` show `TUI-PROTOCOL-OKTUI-PROTOCOL-OK` on one line and two worked-time rows. The cause is not yet proved. It can involve repeated display or two turns joined without separation. Keep this as an open native transcript check beside the wrapped border defect. The live run proves the context calls and marker appeared; it does not prove correct final scrollback layout.

## Whole-message scrollback and user borders — 2026-09-09

User messages now use the native OpenTUI heavy left border. Removed the repeated border text, measured-height signal, and size callback. A fresh scrollback snapshot no longer depends on a later reactive height update to draw the border.

The long live prompt then exposed missing lines where the old renderer split one item between saved rows and the live view. NativeTranscript now sends whole items to scrollback after streaming settles and the view overflows. Removed partial-row counts, partial fingerprints, row-slice snapshot options, and the clipped duplicate live subtree. The session feed still owns all transcript data. Disclosure and resize can rebuild the display. Streaming remains in the live view until settlement; incremental one-shot streaming and preservation of unrelated terminal history across replay remain separate work.

The new native-buffer test failed with the old user border at widths 32 and 65. It passes with the fix. The final focused suite passed 19 tests with 415 assertions. It checks every nonblank snapshot row's first native cell, all 24 numbered prompt lines and the answer exactly once, all disclosure levels, and resize in both directions. Images, queued labels, hard/soft wrapping, and Unicode are included. The test reads native cells because OpenTUI's test recorder slices UTF-16 text by terminal-column width. The full gate passed. A test-only ternary violated the repository style rule on an earlier gate attempt and was removed before the final pass.

Herdr used live Luna in pane `wZ:pH` with a 24-line Unicode prompt and a cell read. Before whole-item commits, the collapsed capture stopped at ROW-17 and preview stopped during ROW-19. The same live check after the change retains ROW-01 through ROW-24 and every continuation border. Collapsed, preview, full, and return-to-collapsed captures all pass the saved row/border audit. The final answer is BORDER-OK.

The separate context-window check still shows two answers joined after a later stream. Source inspection found that `ensureAssistantMessage` appends new streams to the previous assistant without using `StreamStarted.messageId`. This is a session-feed identity defect, not yet fixed. The status result and durable new-window marker still appear. Continue with a separate feed change and real stream/replay tests. Do not report all transcript defects resolved.

This unit removes 49 production source lines: 6 from message-list and 43 from native-transcript. It adds no production files, packages, or exports. No implementation moved. Across the goal, production file count equals baseline and physical source lines are 27 below baseline.

Changed files:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/message-list.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/components/native-transcript.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/message-list-render.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/ARCHITECTURE.md`

Other source receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/render-harness-boundary.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/native-transcript-mouse.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/@opentui/core/lib/border.d.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/@opentui/core/renderables/Box.d.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/@opentui/core/buffer.d.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/@opentui/core/testing.js`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/node_modules/@opentui/solid/index.js`

Evidence:

- `/tmp/gent-user-border-before.log`
- `/tmp/gent-user-border-after.log`
- `/tmp/gent-user-border-gate.log`
- `/tmp/gent-user-border-prompt.txt`
- `/tmp/gent-user-border-process.json`
- `/tmp/gent-user-border-herdr-collapsed.txt`
- `/tmp/gent-user-border-herdr-preview.txt`
- `/tmp/gent-user-border-herdr-complete-collapsed.txt`
- `/tmp/gent-user-border-herdr-complete-preview.txt`
- `/tmp/gent-user-border-herdr-complete-full.txt`
- `/tmp/gent-user-border-herdr-complete-return.txt`
- `/tmp/gent-user-border-herdr-audit.json`
- `/tmp/gent-user-border-window-collapsed.txt`
- `/tmp/gent-user-border-window-preview.txt`
- `/tmp/gent-user-border-window-full.txt`
- `/tmp/gent-core-reduction-current.json`

## Session feed response ownership (2026-09-09)

The live feed appended all response chunks to its last assistant row. A context-window follow-up therefore rendered `WINDOW-CHECK-OKWINDOW-CHECK-OK` as one answer. Each model stream now uses the shared durable answer-ID rule from its input message and step. Historical events without identity receive one local ID per stream. Completion and branch reset clear the active target.

Tool start events use the owning assistant ID or parent call ID. Tool results locate their call across message rows. Ephemeral child stream starts preserve their input-message and step identity. This keeps child activity from redirecting a parent result to the last row.

The answer-ID function moved from loop utilities to the message domain. The supported protocol adds one named export. No new package entry, production file, or service was added. Three function lines moved; they were not deleted. Production line changes for this unit: {"packages/core": 4, "packages/extensions": 0, "packages/sdk": 0, "apps/tui": 35, "apps/server": 0}.

Validation:

- Full `bun run gate` passed after all source and test edits.
- Focused feed tests plus the real RPC/render integration: 13 passed, 54 assertions.
- Live Luna through Herdr: `context.status()` and `context.newWindow()` produced the status output and marker. The later automatic response reproduced the two-response case. Both `FEED-WINDOW-OK` answers remained separate, with 8-second and 2-second completion rows. Collapsed, preview, full, and return views retained the output.
- Live cell delegation read the fixture through a child. The parent cell, nested operation, and child completed. Expanded output contained `CHILD-FEED-OK`; the parent rendered `PARENT-FEED-OK`.
- Added tests compare the live event path with a completed snapshot plus buffered replay. They assert response identities, separate contents, and late tool ownership. Existing legacy-ID and nested-operation tests pass. These tests do not prove mid-stream reconnect hydration; that path still needs an explicit audit before one-shot completion work.

Evidence:

- `/tmp/gent-feed-identity-gate.log`
- `/tmp/gent-feed-identity-integration.log`
- `/tmp/gent-feed-identity-herdr-collapsed.txt`
- `/tmp/gent-feed-identity-herdr-preview.txt`
- `/tmp/gent-feed-identity-herdr-full.txt`
- `/tmp/gent-feed-identity-herdr-return.txt`
- `/tmp/gent-feed-identity-herdr-followup.txt`
- `/tmp/gent-feed-identity-herdr-child-preview.txt`
- `/tmp/gent-feed-identity-herdr-child-full.txt`

Source receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/apps/tui/tests/use-session-feed.test.tsx`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/message.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/protocol.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.utils.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-runner.ephemeral.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop-continuation.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop-turn-stream.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop/cell-recovery.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop/external-turn.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop/interactions.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop/streaming.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop/tool-projection-reconciliation.test.ts`

## Actor-owned loop scope (2026-09-09)

The behavior factory previously allocated an unattached scope. The actor now allocates one child scope per rebuild and provides it to the behavior. `Effect.acquireUseRelease` closes the child if construction or handle publication fails or is interrupted. Successful construction transfers ownership after `handleRef` is set. The existing loop close path still closes that scope. The actor scope also owns the child, so actor shutdown provides a second lifetime boundary.

This is a prerequisite for branch resources. It does not advertise a new resource scope. Cell and model-context services still have explicit construction in the behavior. No kernel implementation moved in this unit.

Validation:

- Full `bun run gate` passed.
- Focused cell-lifetime and recovery-race tests: 5 passed, 46 assertions. These cover cell persistence across RPC requests, branch isolation, worker closure, and serialized rebuild behavior. No new failure-injection test was added for this scope transfer.
- Live Herdr Luna session retained `actorScopeProbe = 41` across requests. The next cell printed `42` without redefining it. Collapsed, preview, and full cards retained both values.
- During a 60-second cell wait, Ctrl+C produced the cancelled-cell card and interruption row. A later cell ran and the assistant returned `SCOPE-RECOVERED` in the same session.

Size: +14 production lines, 0 files added or deleted, 0 moved implementation lines, 0 package or export changes. Core source now has 201 files and 45,457 physical lines.

Evidence:

- `/tmp/gent-actor-scope-gate.log`
- `/tmp/gent-actor-scope-tests.log`
- `/tmp/gent-actor-scope-herdr-retained.txt`
- `/tmp/gent-actor-scope-herdr-preview.txt`
- `/tmp/gent-actor-scope-herdr-full.txt`
- `/tmp/gent-actor-scope-herdr-running.txt`
- `/tmp/gent-actor-scope-herdr-cancelled.txt`
- `/tmp/gent-actor-scope-herdr-recovered.txt`

Source receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/runtime/agent-loop/recovery-race.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/effect/src/Scope.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/ARCHITECTURE.md`

The next branch-resource change must reuse graph admission and generation leases. The current graph host captures `baseContext` once. A branch resource must not retain a process-publication service after that publication retires. Keep construction dependencies on stable host services and branch resources; provide generation-bound tool authority per call. Verify this boundary before wiring resources into turn profiles. This is a design constraint from the source audit, not an implemented feature.

Audit sources:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/extensions/resource-host/resource-graph-host.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/live-profile.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.turn-profile.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/resource.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/code-cell/cell-execution.ts`

## Default model switched to Sonnet 5 (2026-09-09)

The user asked for Sonnet 5. `DEFAULT_MODEL_ID` is now
`anthropic/claude-sonnet-5`, replacing `openai/gpt-5.6-luna`. The Anthropic
driver takes any model name, so the switch needed no driver change. Claude Code
OAuth credentials are present in the keychain.

`MODEL_CONTEXT_WINDOWS` gained a `anthropic/claude-sonnet-5` entry at 1,000,000
tokens. This entry is load-bearing, not cosmetic: `e2e-layer.ts` indexes that
table by `DEFAULT_MODEL_ID` to shrink the window for compaction tests.

One test changed. `auth-rpc.test.ts` asserted that provider `openai` was
required for `main`. Its subject is driver-override resolution by session cwd,
not the shipped model, so it now derives the provider from `DEFAULT_MODEL_ID`.
The assertion states the real invariant and no longer breaks on a model change.

Validation:

- Full `bun run gate` passed. `/tmp/gent-sonnet5-gate.log`.
- The changed test was proved to still catch its regression. Replacing
  `configService.get(Option.getOrUndefined(cwd))` with `configService.get(undefined)`
  in `rpc-handlers.ts:574` made it fail; the source was restored with
  `git checkout` and re-verified.
- Live Herdr: a cell printed 42 and the model replied `SONNET5-OK`. The status
  line read `Claude Sonnet 5`. Tool call ids carry the Anthropic `toolu_` prefix,
  which confirms the Anthropic driver ran.
- Collapsed, preview, and full disclosure all rendered, and returned to collapsed.
- A cell binding survived across turns: `sonnetProbe = 41` in one turn, then
  `sonnetProbe + 1` returned 42 in the next without redefinition.

Known limit, not fixed here: `ANTHROPIC_EFFORT` in
`packages/extensions/src/anthropic/index.ts` maps `xhigh` and `max` down to
`"high"`. Its comment says Anthropic caps at `high`. That is now stale — Sonnet 5
accepts `xhigh` and `max`. `main` runs `reasoningEffort: "max"`, so it currently
requests `high`. Raising this cap is a separate change with its own gate.

Size: 2 production lines changed, 1 test file updated, 0 files added or deleted.

Evidence:

- `/tmp/gent-sonnet5-gate.log`
- `/tmp/gent-sonnet5-build.log`
- `/tmp/gent-sonnet5-herdr-collapsed.txt`
- `/tmp/gent-sonnet5-herdr-preview.txt`
- `/tmp/gent-sonnet5-herdr-full.txt`
- `/tmp/gent-sonnet5-herdr-reuse.txt`

Source receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/agent.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/context-estimation.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/tests/server/auth-rpc.test.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/test-utils/e2e-layer.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/anthropic/index.ts`

## Reasoning effort cap: investigated, not a gent defect (2026-09-09)

The prior entry recorded `ANTHROPIC_EFFORT` clamping `xhigh` and `max` to
`"high"` as a stale cap worth raising. That conclusion was wrong. The clamp is
an upstream SDK limit.

`@effect/ai-anthropic@4.0.0-rc.112` carries two different effort types. The wire
schema in `Generated.d.ts` is `EffortLevel = "low" | "medium" | "high" | "max"`.
The config type gent passes through `AnthropicLanguageModel.layer` is narrower:
`output_config.effort?: "low" | "medium" | "high" | null`.

Proved by probe, not by reading. Widening the map to emit `"max"` fails
typecheck:

```
src/anthropic/index.ts(78,73): error TS2322:
  Type '"max"' is not assignable to type '"high" | "low" | "medium" | null | undefined'.
```

The probe was reverted with `git checkout`. Only the comment changed: it now
names the two types, the version checked, and the condition that would lift the
clamp. `main` continues to request `high` while running `reasoningEffort: "max"`.

Raising this needs an upstream change to the `AnthropicLanguageModel` config
type, or a local patch. Neither is worth carrying for one effort level; revisit
when the package updates.

Validation: full `bun run gate` passed. `/tmp/gent-effort-gate.log`.

Size: comment only. 0 behavior change, 0 files added or deleted.

Source receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/anthropic/index.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/.bun/@effect+ai-anthropic@4.0.0-rc.112+11eac7cfbf53fc55/node_modules/@effect/ai-anthropic/dist/AnthropicLanguageModel.d.ts:148`
- `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/.bun/@effect+ai-anthropic@4.0.0-rc.112+11eac7cfbf53fc55/node_modules/@effect/ai-anthropic/dist/Generated.d.ts:1236`

## Resource graph host replaced by a scoped profile build (2026-09-13)

Commits `282cf346`, `5a89367e`, `19072506`, `d39487a6`, `ff1cc573`.

- The resource graph host, plan, diff, leases, generation ids, and the binding
  resource vector are gone. `SessionProfileCache` builds each extension's process
  resources into a child scope in `sortExtensionsByScope` order; a failed build
  reports the extension as failed at `startup` and the profile stays live.
- `ResourceContribution` carries a branded `ResourceId` only; tool binding
  identity is five fields. `DynamicNonReplayable` left `ToolBindingSource`
  (101 persisted rows, all `Static`, decode unchanged; `Schema.Struct` ignores
  the dropped `resources` key).
- Guardrail `core-retired-reconciler` fails if any retired identifier or module
  returns under `packages/(core|extensions|sdk)/src` or `apps/*/src`.
- Three message-part projections with no shipped consumer removed.

Net: 494 files, +15723/−19637 versus `main` at `ff1cc573`.

## Context compaction behind an extension-owned seam (2026-09-13)

- Core keeps `runtime/model-context-compactor.ts`: the `ModelContextCompactor`
  service, the durable summary record schemas, and the helpers status and the
  TUI read. The loop resolves the compactor with `Effect.serviceOption`; absent,
  it projects the plain window and reports the omission as before.
- The summariser (prompt, source selection, path record, integrity checks)
  moved to `packages/extensions/src/compaction/model-compaction.ts`. The new
  `@gent/compaction` builtin registers it as a process resource. `partToText`
  now lives in `domain/message-part-display.ts`.
- Tests moved with the code: the summariser unit test and its RPC acceptance
  test are under `packages/extensions/tests/compaction/`. The degrade test now
  stubs the seam with a compactor that fails `SummaryGenerationFailed`; the
  provider is called once and the notice still names the omission.
- `runtime/model-compaction.ts` (913 lines) left core.

## Dead surface and a binary source file (2026-09-13)

Commit `a99e19c5`.

- `SessionMutations` lost `createChildSession`, `deleteBranch`, `deleteMessages`,
  their validators and host stubs. Zero shipped callers; the extension surface
  had already dropped them (`extension-surface-locks.test.ts` pins that).
  Subject tests went with them; `session-delete.test.ts` creates its child
  sessions through `SessionCommands.createSession` and the storage fixture.
- `AgentRestarted` event tag removed: no producer, no consumer.
- `runtime/session-profile.ts` held a literal NUL byte as the cache key
  separator. `grep` treats such a file as binary and prints nothing for it, so
  every audit grep this session silently skipped the file (the explorer even
  reported `sortExtensionsByScope` as unused while the file imports it). The
  separator is now the `\u0000` escape.
- Storage-level `BranchStorage.deleteBranch` and `MessageStorage.deleteMessages`
  now have no shipped caller either. Left for a later pass: restart tests use
  them as vehicles and their cascade semantics have their own storage tests.

## Host context collapsed into the extension facets (2026-09-13)

Commit `92b6aefa`, 14 files, +245/−411.

- `domain/extension-host-context.ts` and `ExtensionHostError` are gone.
  `ExtensionHostContext` is now the host-side precursor in
  `domain/extension-services.ts`: identity fields plus the same `Agent`,
  `Session`, `Interaction` facets an extension sees. The host builds them with
  `ExtensionServiceError` directly; the forwarding table that renamed
  `ctx.session.x` to `Session.x` and swapped error types is deleted.
- `extensionServicesFromHostContext` keeps three things: the tool call id on
  `Agent.start`, workspace pinning on `Session` calls, and the ambient `Files`,
  `FileLock`, `State` services. The pinning is load-bearing: the background
  shell test failed without it, because a completion notice queued from a
  background fiber after the turn landed in the wrong workspace.
- `ExtensionHostAgentService` is the one residual host-only shape: `start`
  takes the owning tool call. The test harness no longer builds both spellings.

TUI check: cell turn counted files, `ctx.Session.renameCurrent` renamed the
session to `warehouse-count` (verified in `sessions`), clean exit.

## Project instructions moved into an extension (2026-09-13)

- `ConfigService.loadInstructions`, `RuntimeProfile.instructions`,
  `SessionProfile.instructions` and the `customInstructions` prompt option are
  gone from core (−96 lines). Core never reads `AGENTS.md`.
- `packages/extensions/src/instructions/index.ts` is a `turnProjection` hook:
  it reads the same six locations plus the `~/.claude/CLAUDE.md` fallback through
  `ctx.Files` and returns the `project-instructions` section at priority 70, so
  its place after `# Environment` is unchanged.
- Behaviour change: instructions are read per turn instead of once per profile.
  The RPC acceptance test edits `AGENTS.md` between two turns and asserts the
  second system prompt carries the new text and the first did not.
- Tests moved: three `prompt.test.ts` cases about custom instructions became
  five extension tests (order, empty-file fallback, Claude user fallback, no
  section, per-turn reload through the shipped preset).

## Submit paths and config agent overrides (2026-09-13)

- `8ecf50d4`: the three submit handlers admit a turn through one helper that
  takes the reservation function; eleven identical close-then-fail catch sites
  became one combinator (−48 lines net). A bulk regex first rewrote the new
  combinator into a self-call; typecheck and lint passed and every agent-loop
  test chunk hung. The touched chunk is now run directly before the gate.
- `agents` on `UserConfig`: per-agent `AgentRunOverrides` from `.gent/config.json`,
  applied in `turn-resolve` before the run's own overrides. `modelId` now flows
  through `applyAgentOverrides` like every other override, so the resolved
  agent carries its model and the loop reads one place. The five config
  mutations that Live and Test each implemented twice are one table of pure
  transitions; the positional four-argument constructor helper is gone.
- Testbed for the model gamut: `/private/tmp/gent-gamut` (ledgerline, a
  Bun ledger with a red suite and six tasks). `bun gamut.ts use <preset>` pins
  the orchestrator in `.gent/config.json` and writes the worker and reviewer
  roster into `AGENTS.md`, which the orchestrator must pass as `delegate`
  overrides.
- Gamut run (sol-luna, 2026-09-13): orchestrator on `openai/gpt-5.6-sol`,
  six workers on `openai/gpt-5.6-luna` plus two follow-ups, all six README
  tasks landed: 18 tests pass, typecheck clean, orchestrator report per task.
  The first attempt fanned out to 20 children: `@gent/instructions` puts the
  same `AGENTS.md` in front of every child, and "you are the orchestrator"
  made each worker delegate again. The testbed now defines the role by tool
  presence and every roster entry passes `overrides.deniedTools` for the
  delegation tools. Harness candidate: a delegated child should lose the
  delegation tools by default (prime-agent gives subagents no spawn tool),
  so a project prompt cannot recurse.

## Delegation depth and the output mirror (2026-09-13)

- `ff4ca16e`: `delegate` denies `delegate`, `agent-child` and `agent-children`
  to every child. The gamut roster no longer carries `deniedTools`; the
  harness owns the rule, as prime-agent's subagents own no spawn tool.
- Child output was written a second time to `/tmp/gent/outputs/<agent>_<session>_<ts>.md`
  and the path threaded through `AgentRunSuccess`, `AgentRunSucceeded`, the
  child-completion notice, the delegate result and the TUI child tracker.
  Nothing read the file: the parent reads the session through `read_session`,
  and the TUI stored the path without showing it. The mirror, the optional
  `FileSystem` in the metadata runtime, the `reasoning` return that only fed
  the file, and the `savedPath` field on both schemas are gone. The test that
  asserted the file's contents is deleted; the delivery test no longer expects
  a "Full output" line.

## Retry taxonomy (2026-09-13)

- `runtime/retry.ts` classified failures by thirteen lowercase substrings
  ("429", "500", "overloaded", ...), a `{ status }` cause shape and a
  `{ headers: Headers }` cause with an HTTP-date `retry-after`. Both provider
  libraries map every HTTP failure to a typed `AiError` with `isRetryable` and
  `retryAfter`, so none of those shapes reach the retry. The one raw value
  that does is a mid-stream error event, which the libraries pass through
  unchanged; it carries a wire identifier, not a status or a header.
- Now: typed `AiError` → its own `isRetryable`; a raw cause → a schema of
  the five transient wire identifiers; anything else escapes. 201 → 124
  lines, one exported function plus the default config. The four internals
  the tests reached (`isRetryable`, `getRetryAfterOption`, `getRetryDelay`,
  the jitter constant) are private; six tests drive `retryProviderCall`
  through `TestClock` instead.

## Branch-tool seam in one file (2026-09-13)

- `BranchToolLayer` was a second `Context.Reference` bound at both roots to
  `CurrentBranchToolFeature.branchLayer`; the loop now reads the feature and
  takes its factory. The child root binds the feature itself, so the guard
  test that builds the child's branch layer and looks for `BranchToolWork`
  still fails on an unwired child. `branch-tool-layer.ts` and
  `branch-tool-work.ts` folded into `branch-tool-feature.ts`: three files,
  two references and one derived binding became one file and one reference.

## Host context: one constructor, absence handled once (2026-09-13)

- `make-extension-host-context.ts` carried a hand-written "unavailable"
  adapter for each of ten services (44 dying stubs, every method of every
  interface, most never reached by the facade), a fourteen-field explicit
  deps record with its own constructor used only by one test, an ambient
  constructor with an `overrides` merge, a `Context.Reference` for the host
  platform that nothing bound, and a `capabilityContext` that `forRun`
  accepted and never read. 520 → 330 lines.
- Now one constructor takes the registry, the host platform and the loop's
  follow-up queue; every other facet is `Effect.serviceOption` wrapped by one
  helper that runs the call or dies naming the service. The absence test
  ("ApprovalService not available") is unchanged. The survivor test builds
  the context over real SQLite storage instead of a 76-line stub record; five
  service interfaces that only the stubs named are no longer exported.
- Closed without change: the continuation budget in
  `agent-loop.turn-execution.ts` is one helper with two callers and a bounded
  count; deleting it brings back the "empty reply reads as an answer" bug.
  The branch summary is read by the TUI branch picker, so `summarizeBranch`
  stays; `BranchSummarized` is a write-only event but removing a persisted
  tag risks replay decode, so it stays too.

## SessionCommands carries only request-id commands (2026-09-13)

- `deleteSession` and `updateSessionReasoningLevel` on `SessionCommands` were
  one-line delegations to `SessionMutations`; the RPC handlers and the two
  tests now call `SessionMutations` directly. The five `Effect.fn` wrappers
  whose bodies were `yield* dedupX(input)` added a span over a span; the
  deduped functions are the service. −70 lines, one fewer error alias.

## Callerless storage deletes and the TUI's own output mirror (2026-09-13)

- `BranchStorage.deleteBranch` and `MessageStorage.deleteMessages` had no
  shipped caller: session deletion cascades through `SessionMutations`, and
  branch or message deletion never reached a product surface. The two tests
  that used them as a vehicle for "the row vanished under us" issue the
  `DELETE` themselves; the two that tested them as a subject are gone, the
  foreign-key half of the branch test stays. −95 lines.
- `apps/tui/src/utils/shell.ts` carried its own `saveFullOutput` writing to
  `~/tool-output`; it now calls the one in `domain/output-buffer.ts` that the
  bash tool uses, so every truncated output lands in one place.

## Interrupted admission and early-ending cell scripts (2026-09-13)

- Gamut run 4 (opus-sonnet): the orchestrator issued six background
  `delegate` calls from one cell op via `Promise.all`; the fifth and sixth
  hit the four-child cap, the promise rejected, the script ended with four
  host calls in flight, and the worker died with "Cell ended with pending
  host calls". The host tore down the cell scope, which interrupted the four
  admitted `AgentRunner.start` calls between the durable admission and
  `ChildCompletionDelivery.watch`. Four children ran, nobody delivered them,
  the parent stayed idle with two tasks queued.
- `AgentRunner.start` is now `Effect.uninterruptible`: admission and the
  watcher stand or fall together. Regression test gates admission inside a
  wrapped `SessionRuntime`, interrupts the caller at that point, and asserts
  the child completion still lands (fails by timeout without the fix).
- The cell worker waits for pending host calls to settle before reporting
  the script's result instead of failing the worker. The 33-call limit test
  now replies to the 32 in-flight calls and reads the script's own failure.
- New RPC acceptance test `delegate-background-child.test.ts` drives
  background delegation through the real runner and waits for the
  child-completion message and the parent's follow-up turn.

## Every child is a session (2026-09-13)

- `agent-runner.ephemeral.ts`, `ephemeral-root.ts`, and `agent-runner.run-spec.ts`
  are gone (−770 lines of core). The ephemeral runtime rebuilt a second
  composition root per helper run: parent context snapshot, in-memory SQLite,
  its own event store and publisher, `Layer.fresh`, and a resource rebuild that
  skipped process lifecycle. It existed for `/btw` and `read_session` only.
- `RunSpec.persistence` is replaced by `visibility: "parent" | "private"`. A
  private run is admitted like any child but writes no `AgentRunSpawned`,
  publishes no `AgentRunSucceeded`/`AgentRunFailed`, and deletes its own
  session (loop terminated, rows cascaded, live events dropped) once the
  answer is read. `history: "inherit"` copies the parent branch's visible
  messages into the child branch before the prompt.
- Foreground `delegate` no longer chooses a persistence; every foreground
  child is a session and the result carries its `session://` ref.
  `getDurableAgentRunSessionId` is deleted with the choice.
- The platform-duplication guard "AgentRunner must use the ephemeral child
  root preset" and the two `ephemeral-root.ts` suppression entries are gone.
- Tests: the ephemeral service-propagation suite (five tests) and two
  ephemeral-persistence tests in `agent-runner.test.ts` are deleted; the
  inherit test now asserts the private child's session is gone afterwards.

## Branch summarization removed (2026-09-13)

- On every branch switch the server built a prompt from the last 50
  messages, resolved the default model, streamed a summary, wrote
  `branches.summary`, and published `BranchSummarized`. The TUI never passed
  `summarize`, so the default fired a model call on each switch. The only
  reader was the branch picker line suffix. No event consumer.
- Deleted: `SessionCommands.summarizeBranch` and its model/registry/platform
  dependencies, `BranchSummarized`, `BranchStorage.updateBranchSummary`, the
  `summary` field on `Branch` and its row, the `summarize` flag on
  `SwitchBranchInput` and the TUI client, `branch-summary.test.ts`.
  Existing databases keep the unused column. −296 lines.
- Feature note: the branch picker now shows name and message count only. A
  model-written branch summary is extension work (a branch-switch hook plus
  a widget), not loop work.

## The turn receipt carries usage (2026-09-13)

- `agent-runner.metadata.ts` (175 lines) rebuilt a child's usage and tool
  calls by scanning every event on its branch after the fact. The loop
  already had the totals in hand at the append site.
- `TurnCompleted.usage` is populated from the turn's metrics when every step
  reported a usable count; `TurnMetrics` gained `steps` and `usageKnown`.
  Run results and child completions take usage from the receipt, text from
  the branch's last assistant message (`latestAssistantText`), and tool
  calls from tool-call/tool-result parts (`messagesToolCalls`), two pure
  projections in `message-part-display.ts`.
- Tests: the "agent runner metadata" suite (147 lines of event fixtures)
  became two pure projection cases and two loop-level receipt cases in
  `session-metrics.test.ts` (known sum equals the stream totals; a step
  without usage leaves the receipt absent). The cell foreground test still
  reads `metadata.toolCalls` unchanged.

## One runner file (2026-09-13)

- `agent-runner.durable.ts` (460 lines) and `agent-runner.ts` were one
  module split by a 50-line `DurableAgentRunRuntime` interface with one
  adapter. The runner re-mapped `StorageError`/`EventStoreError` to
  `AgentRunError` at four call sites, re-provided services the durable half
  had already yielded, and wrapped two event constructors in named helpers.
- Now `agent-runner.ts` alone: `admitChildSession` (exported, module-level
  `Effect.fn` that yields its services; the one admission path for `start`,
  `run`, and the cell recovery test) and `getSessionDepth`; `inspect`,
  `cancel`, `list`, `start`, `run` in the layer. Errors become
  `AgentRunError` once, at the source (`asAgentRunError`).
  `AgentRunSucceeded`/`AgentRunFailed` are built inline from one receipt
  record. `inspect` no longer opens a transaction or re-reads the branch
  row: the start row and the session row are the ownership check.
- Deleted: `AgentRunnerConfig` (`baseSections` was never read;
  `timeoutMs` had one test and no caller), `runWithTimeout`,
  `publishAgentSwitch` (an `AgentSwitched main→agent` event nobody
  consumed), and the `BootstrapError` branch in `makeAgentRuntimeLayer`.
  `InProcessRunner` is a plain `Layer`. `read_session` drops its
  "ephemeral runs are not persisted" hint: every run is a session now.
- Tests: the timeout case is gone with the config; three admission tests
  call `admitChildSession` and `AgentRunnerService` directly.

## A child run is a user message (2026-09-13)

- `AgentRunner.run` sent its prompt through a private path: `SessionRuntime.runPrompt` →
  the `Run` actor op → `reserveRunStartOrQueueFollowUp` → `awaitTurnCompletion`, a
  second admission and a second wait beside the one every other caller used
  (`sendUserMessage` → `SubmitAndWait`). Now `run` admits the child and sends
  its prompt as a user message with command id `agent-run:<sessionId>`; the
  receipt is read back by that message id. Deleted: `runPrompt`,
  `RunPromptInput`/`RunPromptPayload`, `runPromptThroughActor`, the `Run` op,
  `runTurn`, `reserveRunStartOrQueueFollowUp` (a copy of
  `reserveStartOrQueueFollowUp` without the queue cap).
- `SubmitAndWait` waited on an event-store subscription opened after the turn
  started; a test store with an empty `subscribe` could never satisfy it, and a
  batched follow-up whose id was absorbed never produced its `TurnCompleted`.
  The one wait is now state-based: `awaitTurnCompletion(handle, baseline,
messageId)` returns when the loop no longer holds the message (not starting,
  running, waiting, or queued), or when the turn or persistence fails.
  `RespondInteraction` shares it. `waitForMessageTurnCompleted`,
  `waitForIdleAfterEpoch`, `TurnBaseline`, and `AgentLoopState.stateEpoch`
  are gone; the failure epoch is the only counter left. The actor no longer
  needs `EventStore`.
- Found on the way: a retried submit of a message whose turn had already
  run was re-admitted and streamed a duplicate reply; the old wait only
  hid it by returning at the receipt, while the retry was still deduped as
  in flight. `admitTurn` now refuses a message with `turnDurationMs` set, for
  every submit op.
- Tests: eight `runPrompt` sites send user messages with a command id; the
  agent-loop `runAgentLoop` helper submits through `SubmitAndWait`; the six
  queue tests that relied on `Run` returning early for a busy loop now
  `submitAgentLoop` the queued message and wait for `Idle` before asserting
  on the drained queue.

## The streaming output buffer is a bash-tool concern (2026-09-13)

- `domain/output-buffer.ts` (207 lines) mixed three things: pure head/tail
  projections used by the loop, the TUI, and `read_session`; a streaming
  `OutputBuffer` class used only by the bash tool; and `saveFullOutput`, a
  filesystem helper used by the bash tool and the TUI's `!` shell.
- Now: `domain/head-tail.ts` keeps `headTail`, `formatHeadTail`,
  `headTailChars` (pure); `utils/save-output.ts` keeps `saveFullOutput`;
  `OutputBuffer` lives in `packages/extensions/src/exec-tools/output-buffer.ts`
  beside its one caller and is no longer public extension API. Its tests
  moved with it.

## No projection barrel (2026-09-13)

- `domain/message-part-projection.ts` re-exported five modules under one
  name, so 24 importers named a barrel instead of the module that owns the
  function. The barrel is gone; every importer names the owner
  (`message-part-display`, `prompt-to-response`, `response-to-prompt`,
  `response-part-normalization`, `message-image-conversion`). Two exports
  that only the barrel re-exported (`dataUrlToBytes`,
  `UrlBackedImageNotSupportedError`) are module-private now.

## Confirm and review are prompt-tool concerns (2026-09-13)

- `PromptPresenter` was a core Tag (65 lines) plus a runtime Live layer
  (144 lines) wired in `dependencies.ts` and exposed as three facet methods
  (`present`, `confirm`, `review`) on `ctx.Interaction`. Two consumers: the
  `prompt` tool used all three; the `goal` tool used `present`.
- `confirm` was one `approve` call with a `mode: "confirm"` metadata; `review`
  was a file write plus one `approve` call with `mode: "review"`. Both are now
  inline in `interaction-tools/prompt.ts` over `ctx.Interaction.approve`,
  `ctx.Files`, and `ctx.cwd`. The Tag, the Live layer, and the wiring are
  deleted. `ctx.Interaction` keeps `approve` and `present`.
- `present` (a hidden assistant message stored in a transaction, then
  delivered) stays a host facet: it needs `MessageStorage`, `EventPublisher`,
  and `SqlClient`, none of which an extension may reach. It is implemented in
  `make-extension-host-context.ts` over the facets already resolved there and
  now has a runtime test in `ambient-host-context.test.ts`.
- Six test stubs lost their `confirm`/`review` lines; the prompt-tool tests
  now exercise the real file write under `.gent/prompts/`.

## File discovery is a grep-tool concern (2026-09-13)

- `domain/file-index.ts` plus `runtime/file-index/{index,native-adapter,fallback-adapter}.ts`
  (418 lines) sat behind a one-method Tag whose only production caller was
  `fs-tools/grep.ts`, reached through a `Files.listFiles` facet. Core wired the
  layer in `dependencies.ts`, exposed a `fileIndexLayer` override, and every test
  composition root restated the fallback layer.
- Now `packages/extensions/src/fs-tools/file-index.ts` owns the Tag, both
  adapters, and `FileIndexLive({ home })`; the extension registers it as a
  process-scoped resource and `GrepTool` yields the Tag. `Files.listFiles`, the
  override, the three root restatements, and the `@ff-labs/fff-bun` dependency
  leave core. Tests moved to `packages/extensions/tests/fs-tools/file-index.test.ts`;
  the grep test provides the fallback layer directly.

## Fixtures live in test-utils (2026-09-13)

- `debug/provider.ts` (step builders for `LanguageModelLayers.sequence`) and
  `debug/session.ts` (`seedDebugSession`, a storage fixture behind
  `--debug`) were a third top-level core directory that the dead-export
  guard already exempted as test helpers. They are now
  `test-utils/sequence-steps.ts` and `test-utils/debug-session.ts`; the
  46 importers name the new paths and the `debug/` exemption is gone.
- `ApprovalService.LiveAutoResolve` had no caller anywhere in the repo
  (22 lines, a fourth way to build the one service). Deleted.

## One test root preset (2026-09-13)

- `in-process-layer.ts`, `e2e-layer.ts`, and `extension-harness.ts` each
  restated the `/tmp` environment, the five stub layers (`Auth`,
  `ApprovalService`, `ConfigService`, `ModelRegistry`, `Permission`), the
  deterministic server identity, a `test-agents` extension, and a
  dies-except-run agent runner stub.
- `test-utils/test-root.ts` now owns `testEnvironment`, `testIdentity`,
  `testOverrides()` (fresh layers per call, since the approval stub carries a
  decision queue), `testAgentsExtension`, and `stubAgentRunnerLayer`; the
  three roots are deltas over it.

## SessionCommands folded into SessionMutations (2026-09-13)

- `server/session-commands.ts` (331 lines) was a second service over the
  same four session mutations plus `createSession`: it re-wrapped each
  `SessionMutations` call in a request-id deduper and forwarded `sendMessage`
  to the runtime. Every RPC handler went through it; nothing else did.
- `SessionMutations` now owns `createSession` and the in-process dedup
  (`makeRequestDeduper` keyed on the request id, durable replay unchanged).
  `message.send` keeps one local deduper next to its handler in
  `rpc-handlers.ts`. `SessionCommandsDedupControl` is gone; the cache-eviction
  test became "durable createSession result survives a fresh process cache".
- Regression probes: handler dedup off fails two tests, durable replay off
  fails two, log-on-failure fails one. Test fixture dir renamed to
  `tests/server/session-mutations/`.

## The summary record belongs to the compaction extension (2026-09-13)

- `runtime/model-context-compactor.ts` carried the durable summary record
  (`ModelCompactionDetails`, `CompactionPaths`, the `model-compaction`
  customType, four predicates, `latestCompactionRevision`) and the six-case
  `ModelCompactionFailure` union. The loop used two of them: "is this failure
  recoverable" and "which revision is newest", both derivable by the compactor.
- The seam now says it: `ModelCompactionError` is `{ modelId, reason,
recoverable }` and `ModelCompactionResult` carries `revision`. Everything
  else lives in `packages/extensions/src/compaction/summary-record.ts`; the
  branch-tools barrel drops nine names and gains `UsageSchema`. The TUI never
  imported the core names; it matches the customType string.

## Two stand-in defaults removed (2026-09-13)

- `make-extension-host-context.ts` carried a 25-line `unavailableExtensionPlatform`
  stub behind an optional `host`. The one production caller always passes a
  host; only eight test sites omitted it and silently got a platform whose
  `runProcess` fails. `host` is required now and the tests pass
  `testHostFacts().host`, the stub test-utils already owned.
- `Permission.Test()` was `Permission.Live()` with no rules and the default
  allow action. Deleted; the thirteen callers name the live constructor.

## Dead surface: prompt-to-response, process probes, state cells (2026-09-13)

- `domain/prompt-to-response.ts` (98 lines) converted persisted messages
  back into provider `Response` parts. No production caller; the loop uses
  `response-to-prompt` and `response-part-normalization` directly. Deleted
  with its image-conversion half and the `ai-transcript` re-export block.
- `ctx.Process.{signalPid,isPortFree,isPidAlive,commandCandidates}` and
  `ctx.Files.readDirectory` threaded through six layers (GentPlatform, the
  Bun adapter, host-platform, ExtensionHostPlatform, the services, three
  stubs) to reach no extension. Deleted at every layer; extensions that list
  directories already use `FileSystem`.
- `defineStateResource` / `ExtensionState` wrapped a `Ref` in four methods
  for one example. The example and docs now show `defineResource` with
  `Layer.effect(Tag, Ref.make(...))`, which is the same thing said once.

## Server discovery and observability belong to the composition root (2026-09-13)

- `server/server-lock.ts` and `server/build-fingerprint.ts` (270 lines) had
  no caller inside core; the SDK, the TUI, and `apps/server` read them, and
  the lock test already lived in `packages/sdk/tests`. Both moved to
  `packages/sdk/src` and the SDK index exports the discovery names.
- `runtime/{logger,tracer,log-paths}.ts` (412 lines) were reached only from
  `buildServerRoot`, and carried seven OpenTelemetry dependencies the loop
  never calls. `ServerRootConfig.observability` is now a required layer the
  root supplies: the SDK and `apps/server` pass `GentObservability(cwd)`,
  the test roots pass `Layer.empty`. The seven dependencies left core.

## Output files belong to the bash tool; `utils/` is gone (2026-09-13)

- `utils/save-output.ts` wrote truncated command output under
  `/tmp/gent/outputs`; its callers were `exec-tools/bash.ts` and the TUI's
  local shell. It now lives in `exec-tools` and `@gent/extensions` exports it.
  The `api` barrel loses the name.
- `utils/run-process.ts` was the directory's last file; it is
  `runtime/run-process.ts` now and core has no `utils/` directory.
- `testHostFacts` and `testExtensionHostContext` carried byte-identical host
  platform stubs; `testExtensionHostPlatform(home)` is the one.
- `fake-fetch` stays in core test-utils: under `packages/extensions/tests`
  the test-only lint forbids its `runPromise`, and a shipped `src/` home would
  be worse.

## The message store searches its own index (2026-09-13)

- `storage/search-storage.ts` (121 lines) was a one-method Tag whose only
  production reader was the `ctx.Session.search` facet, itself used by one
  tool. `MessageStorage` already wrote `messages_fts` on every insert and
  `SessionStorage` pruned it on delete; the reader lived in a third module.
  `MessageStorage.searchMessages` now reads the index the same store writes.
  One Tag, one layer line, and one facet binding fewer.

## One integration root (2026-09-13)

- `in-process-layer.ts` restated the E2E root with two differences: the
  stub tool runner and a debug model. `E2ELayerConfig.toolRunner: "test"`
  carries the first; `baseLocalLayer` and `baseLocalLayerWithProvider` are
  now adapters over `createE2ELayer` and their eight callers are unchanged.

## The persona is the agents extension's (2026-09-13)

- `domain/prompt.ts` held the IDENTITY, WORK, COMMUNICATION, and BOUNDARIES
  prose that says what a Gent agent is. Core states how a turn ends and
  nothing about who is taking it; the `@gent/agents` extension, which already
  ships the one `main` agent, now contributes the four sections through a
  `turnProjection` hook. Core writes only the `environment` section.
  `buildSystemPrompt` had no production caller and is gone. A deployment
  that ships no agents extension gets no persona, which is the rule.
- `extensions/branch-tools.ts` re-exported `CurrentBranchToolFeature` and
  `noBranchTools`; no file outside named either.

## The debug fixture seeds from the composition root (2026-09-13)

- `test-utils/debug-session.ts` (337 lines) was never test-only: the SDK's
  owned server and `apps/server` both seeded it for `--debug`. Both roots
  already import `@gent/sdk`, so the seeder lives there and the SDK exports
  `seedDebugSession`. Core loses a debug scenario it never ran.

## Compaction's questions to tools are the extension's (2026-09-13)

- `domain/inner-operation-receipts.ts` and `domain/retained-bindings.ts`
  declared two Tags no core file yields. The cell extension provides them
  from its branch layer and the compaction extension reads them by
  `serviceOption`. The seam is between two extensions, so the contract lives
  with the asker: `extensions/src/compaction/tool-contracts.ts`. Core loses
  66 lines and two names from the `branch-tools` barrel.

## One receipt shape for the four durable mutations (2026-09-13)

- `SessionOperationStorage` had four get/save pairs (`getCreateSession`,
  `saveCreateBranch`, …) that differed only in operation name and codec, and
  `session-mutations-live.ts` repeated the same pre-check, in-transaction
  re-check, and save around each. The storage now has `getReceipt` and
  `saveReceipt` over a `DurableOperation<A>` descriptor, and the mutations
  have one `once(operation, input, subject, work)` helper. Validation reads
  moved inside the guarded work: the replay-after-restart tests pin that a
  receipt wins before any current-state lookup. Net −69 lines.
- Eight test-utils names no other file named lost their `export`.

## The window notice belongs to whoever opens the window (2026-09-13)

- `runtime/model-context-window.ts` told the model to call
  `context.newWindow()` and `context.read(...)`, which are cell tools. The
  feature-independence guard was green only because the coupling was a
  string. `ContextDirective.NewWindow` now carries a `notice`; the cell's
  context host fills it and core's marker keeps whatever it was given.
- `resolveTurnSource` took two persistence callbacks and the call site
  re-provided four services into one of them. The external tool run now
  carries its services from resolve time and persists its own result, so
  the seam has one callback. Line-neutral; one concept fewer at the seam.
- Rejected from the fourth explorer pass: the session-tree walk in the
  mutations (a second recursive query costs what the BFS costs); the child
  completion prose (it states the loop's own contract, and a formatter
  parameter widens the seam); `ProcessLocalToolReplay` width (every method
  has a caller); continuation prompts on the turn profile (line-neutral,
  rejected before).

## Scaffolding for consumers that never arrived (2026-09-13)

- `SystemPromptInput.driverSource`, `driverToolSurface`, and `sections`
  were written by the loop and read by no hook; `ExternalDriverContribution.
toolSurface` was set by no driver. The codemode prompt slot they were
  built for does not exist. All four are gone, with `resolveDriverToolSurface`
  and `ResolvedTurn.driverSource`.
- `BranchStorage.countMessages`, `SessionStorage.getLastSessionByCwd`, and
  `InteractionStorage.deletePending` had no production caller; the `-c`
  flag filters client-side and pending rows clear through `resolve`.
- `ServerIdentity.Test` had no reader (tests use `testIdentity()`); the
  `permissionLayer` override was dead because the turn profile provides
  `Permission` per turn; `sendUserMessage` re-assigned three fields it had
  already set; `persistAssistantParts*` took an `agentName` it never read.

## One operation for a tool outcome (2026-09-13)

- `persistToolParts` followed by `reconcileToolProjections` with the same
  four arguments was written five times across the turn engine and the
  tool executor; the two were never useful apart. `recordToolOutcome` is
  the one operation and the reconciler is no longer exported.
- Core's `toResponseFinishReason` had one caller, its own test; the ACP
  extension already carries the identical mapping for its own use.

## Two session RPCs no client called (2026-09-13)

- `session.getTree` was declared on the TUI client and wired, and read by
  nothing; `session.getChildren` was called only by a core test. Both are
  gone with `SessionTreeNode`, `SessionQueries.getSessionTree`, and their
  barrel names in the protocol, SDK, and TUI client.
- Kept: `session.delete` (a store you cannot delete from is a missing
  capability, and any RPC client can call it) and `runtime.status` (the
  only probe of the connection tracker; the lifecycle tests use it).

## Columns every writer filled with a constant (2026-09-13)

- `interaction_requests.type` was always `"approval"` and no reader
  selected it; the cell's check that it equalled `"approval"` could never
  fail. `content_chunks.part_type` was written from a decode of the same
  JSON it sat beside and never read. Migration 016 drops both, plus
  `idx_messages_branch` (a prefix of `idx_messages_branch_created`) and
  `idx_tool_call_bindings_tool_call` (bindings are read by full key). The
  queue row now decodes the one column it uses.
- Deferred: `messages_fts.branch_id`/`role` are write-only but FTS5 cannot
  drop a column; a rebuild costs more than two unread columns.

## Sixth pass, group A: surface nobody calls (2026-09-13)

The sixth explorer pass found nine candidates. This commit takes the dead
ones. `buildTurnPrompt` had no production caller (both production paths
already compose `compileSystemPrompt(buildTurnPromptSections(...))`, and
the prompt test now writes the same line). `getSingleText` and
`messageText` were `.parts` adapters used only by `agent-loop.state.ts`,
which now says `.parts` like every other caller. `messagePartsReasoningLines`
is unexported. `AgentLoopQueueStorage.clearQueueState` was a DELETE no one
ran (branch cascade clears the row); the pure `clearQueueState` in the
state module ignored its parameter and had no caller;
`resolveSessionEnvironmentOrFail` was test-only; `RequestDeduper.invalidate`
and `invalidateKey` had no reader, so the deduper is a plain function.
`DependencyOverrides.eventStoreMode` had one writer that wrote the default,
so the field and `makeBaseEventStoreLayer` are gone.

## Sixth pass, group B: one way to drop an absent field (2026-09-13)

Twenty sites wrote the same four-line `Option.match(x, { onNone: () => ({}),
onSome: (v) => ({ k: v }) })` to omit an undefined key before a schema
constructor. `config-service.ts` already held the general form privately as
`definedFields`. It is now `omitUndefined` in `domain/guards.ts`, on the
extension api barrel, and every site is one object literal.
`turn-resolve.ts` `applyAgentOverrides` went from 31 lines to 12. The
duplicate `isRecord` in `model-registry.ts` uses the shared guard.
`context-estimation.ts` held one estimator whose only consumer,
`model-context.ts`, already declared the same JSON encoder and the same
chars/4 rule; `estimateTokens` now lives beside the other two estimators
and the file is gone.

## Sixth pass, group C: one adapter per seam (2026-09-13)

`ApprovalService` had two constructors and an optional storage: `Live`
(memory only) had no production caller, and `LiveWithStorage` took an
adapter that `dependencies.ts` built from `InteractionStorage`. The service
now yields `InteractionStorage` itself and builds that adapter once;
`InteractionServiceConfig.storage` is required, and the dead `onRespond`,
`autoResolve`, and four storage-absent guards are gone. Tests that used the
memory constructor provide `InteractionStorage` like production does.
`persistAssistantParts` and `persistToolParts` restated five fields to add
a role literal; `persistMessageParts` is exported with a role-discriminated
parts type and every caller names the role. `ctx.State.changed` lost the
`{ sessionId?, branchId? }` params every caller passed as `{}`; it reports
the context it already holds. `ctx.Session.listMessages` had no production
caller and is gone from the facet, host binding, and stubs; the surface-lock
test and `docs/extensions.md` follow.

## Sixth pass, group D: two Tags with one reader (2026-09-13)

`SessionQueries` and `InteractionCommands` were one-method services whose
only reader was `rpc-handlers.ts`. `server-root.ts` also wired
`InteractionCommands.Live` on top of `SessionQueries.Live`, an edge the
file never used. Both are now exported `Effect.fn`s, `getSessionSnapshot`
and `respondInteraction`, that yield the storage and runtime services they
need; the handler calls them directly, `AppServicesLive` and its build step
are gone, and the interaction input is the wire schema's type instead of a
second interface.

## Seventh pass, group E: names with no reader (2026-09-13)

`server/rpcs.ts` re-exported 37 transport-contract schemas "for the SDK
and tests"; every importer of the module named only `GentRpcs`, and the
SDK reaches the same schemas through `protocol.ts`. The block is gone,
`ExtensionRpcs` is file-private, and the guard immediately found two
schemas (`ExtensionActivationPhase`, `ExtensionManifestInfo`) the block had
been keeping alive; both are demoted. `hasAgentOverrides` guarded an early
return whose slow path computes the same `AgentDefinition` (nine optional
fields, no transforms), so the guard and the function are gone.
`estimateSystemPromptTokens` was a rename of `estimateTextTokens`, which
`estimateToolSchemaTokens` already called directly. The two handler
aliases `cleanupLoop` and `currentRuntimeState` are inlined; `GetState`
had already bypassed the second.

## Seventh pass, group F: the last test-utils edge and a base64 index (2026-09-13)

`server/dependencies.ts` was the one production file in core that imported
`test-utils/`: `providerMode` mapped a four-case string to a debug
`LanguageModelLayers` layer, while the SDK root already maps its own spec
to the same layers and hands core `languageModelLayerOverride`. The
server app now does the same in `apps/server/src/main.ts`, so
`providerMode`, the string resolution, and the import are gone;
`makeModelResolverLayer` is one `Option.match`. `messagePartImage` built a
full `data:` base64 string that only `messagePartSearchText` read, and
that reader wrote every pasted image verbatim into `messages_fts`; the
projection is now `{ mediaType }`, the search token is the media type, and
`filePartDataToDisplay` is deleted. The four single-part helpers
(`messagePartText`/`Reasoning`/`Image`/`ToolCall`) had one consumer, the
TUI's segment builder, which now switches on `part.type`; the helpers are
file-private and `protocol.ts` drops the four names.

## Harness fix between passes: the output cap and the replayed continuation (2026-09-13)

Gamut runs 16a and 16 (sonnet-sonnet at `c50961e5`) ended with no
delegation: steps 5, 6, and 7 each stopped at exactly 4,096 output tokens
with zero tool calls. Every model request carried `maxTokens: 4096`, the
same constant the context projection reserves, and a Sonnet orchestrator
writing one cell with six delegate prompts never fit. The truncated tool
call was discarded, the leading text ("Let me delegate the 6 tasks
concurrently.") was reported as the reply, and the turn completed. The
hint is gone (`a28acda4`): each provider adapter already falls back to the
model's own output limit when the hint is absent. A step that finishes
with reason `length` and no tool call now spends a continuation with a
"retry in smaller steps" prompt. The second bug in the same run: the
continuation prompt is persisted as a user message with no `TurnCompleted`
of its own, so the incomplete-turn resume replayed it after the assistant
reply and Anthropic rejected the transcript as assistant prefill.
Continuation messages are excluded from that resume. Both regressions are
pinned by tests that fail with the fix disabled.

## Eighth pass: one projection, no computed-then-ignored fields (2026-09-13)

`domain/response-to-prompt.ts` (`27e28c62`) carried two spellings of the
assistant part union, two `undefined`-returning wrappers over the Option
projections, and three prompt builders that only tests called; one
projection remains and the image conversion is inlined into its `file`
arm (`message-image-conversion.ts` deleted). `ToolOutput.type` was set at
every call site and read by none. `ProjectionError` had no thrower;
`ToolCallRecoveryOutcome.Incomplete` had no constructor. Core is 29,039
LOC at `27e28c62`.

## Ninth pass: structural identity and seams with no adapter (2026-09-13)

Two commits. `59495bd5`: the two 24-arm `AgentEvent.match` tables for
session and branch identity become structural reads with the two named
exceptions; `NotFoundError.entity` (15 writers, 0 readers),
`InvalidStateError.operation`, and `DriverFailureRef` (one variant never
built, the tag printed as a constant) are gone; `CacheLoad` is the
`Option` it was; `ExtensionHostSearchResult` is the storage row it copied;
`getToolEffect` is folded into its one test-helper caller. `082ed5ed`:
prompt section markers (emitted into every prompt for a codemode slot that
no longer exists, parsed by nothing) deleted with `withSectionMarkers`
from the public API; `evaluatePermissionRules` loses `defaultAction`
(production always passed `"allow"`); `RequestInput.extensionId` (30 test
writers, 0 production) deleted, tests bind through `defineRequests` or
`bindRequestCapabilityExtension`. `Permission.Live(rules)` stays: it is
the rules-only adapter and the user asked for test variants as statics on
the Tag. Core is 28,887 LOC at `082ed5ed`.

## Tenth pass: one loop, one dispatch, one profile (2026-09-13)

`setupBuiltinExtensions`/`setupDiscoveredExtensions` collapsed into
`setupExtensions` over a single `DiscoveredExtension` shape
(`DiscoveredBuiltinExtension` deleted); the five `SessionRuntime` actor
methods share `actorCommand`; `buildProfileCatalog` +
`RuntimeProfileCatalog` + `sessionProfileFromCatalog` + `RuntimeProfile` +
`compileBaseSections` became `buildSessionProfile` returning
`SessionProfile` (now declared in `profile.ts`); `RunSpec.tags` and
`ModelContextProjection.truncated` deleted (the one production reader of
`truncated`, in the compaction extension, reads `omittedMessageIds`).
Kept `Usage.cacheReadTokens`/`cacheWriteTokens`: a product metric on
every receipt, not a dead field. Core is 28,719 LOC at this commit.

## Eleventh pass: snapshot fields with no reader (2026-09-13)

`SessionRuntimeMetrics.tokens`/`toolCalls`/`retries` deleted with the two
fold arms that fed them (the TUI reads `costUsd`, `lastInputTokens`,
`turns`, `durationMs`); `ResolvedSessionServices` collapsed to the
registry; the three `*ForMutation` `Effect.fn` wrappers became arrows;
`AssistantDraft` deleted in favour of `toolCallsFromMessage`; the
`usageOption` and `inputOption` double wraps and the twice-built usage
default folded. Eleventh-pass NO FINDING: migration squash (010 is a
recorded no-op, an anti-squash policy), ToolCallSucceeded/Failed tags
(persisted wire), ModelContextError role pairs (diagnostics),
compileCapabilityWinners/Entries (different keys), AgentLoopBehavior
members, AgentLoopTurnProfile fields, ChildCompletionDelivery.deliver,
TurnStepResult stop literals, initialQueueFailure. Core is 28,646 LOC.

## Twelfth pass: one turn profile from the session context (2026-09-13)

`SessionEnvironment`, `ResolvedSessionEnvironment`, `ActiveRuntimeBindings`
and their three builders collapsed into `resolveTurnProfile`, which returns
`AgentLoopTurnProfile` directly (the behavior no longer remaps seven fields);
the dead `agentName` threading through the session context and
`MakeExtensionHostContextRunInfo` deleted (no writer); `buildQueuedTurnItem`
became two inline literals; the three per-component entity-id decoders
became `decodeComponent(schema, label)`; `terminateRuntimeSession` reuses
`listWorkspaceLoops`; the tool-runner re-export of
`attachToolBindingIdentity` dropped. Skipped: moving `replayHook` +
`registerContributions` into the e2e layer (net-zero move). Core is 28,477
LOC at `db7538aa`.

## Thirteenth pass: single-shape helpers around the composition root (2026-09-13)

The three session-mutation runtime helpers inlined (services yielded once,
captured context gone); `respondInteraction`/`queueFollowUp`/
`dequeueFollowUp` routed through `actorCommand`; the seven
override-or-live `make*Layer` helpers in `dependencies.ts` replaced by the
override expression at each call site; never-set options deleted
(`InProcessLayerConfig.branchTools`, the debug-slow provider mode,
`createWorkerEnv` `includeAuthFiles`/`extra`); `RpcHarnessConfig` is
`Omit<E2ELayerConfig, "toolRunner">`; the session-runtime re-exports of
the runtime state schema, `followUpMessageIdForSource`, and the
wide-event envelope types dropped. Thirteenth-pass NO FINDING: `FileLockService.currentSize`
(eviction is not observable through `withLock`; the map-size assertions are
the only proof of the invariant), `selectWithLatestUser`/`selectWithoutUser`
(different overflow semantics), per-variant event re-exports (both
spellings live), TurnMetrics fields, Submit/SubmitDurable split,
extension-hooks and turn-persistence single-call helpers (each names a
real step). Core is 28,326 LOC at `2f15ebf4`.

## Fourteenth pass: one branch command shape, fewer single-importer files (2026-09-13)

`agent-loop.protocol.ts`: five identical field records and eleven
hand-written mirror types collapsed into `BranchCommandFields` plus types
derived from the schemas; the five branch-command handlers share one
`branchCommand` prelude; `executeTools` binds the replay key and assistant
message id once; `decodeComponent` owns the percent-decode guard
(`9262996b`). `session-queries.ts` and `interaction-commands.ts` folded
into `rpc-handlers.ts`, `turn-pricing.ts` into the turn execution, the
runtime-context capture into the behavior; `SessionMutations` takes the
transport input types directly and `createSessionBranch.parentBranchId`
(never set) is gone; `PlatformErrorSchema` deleted, no RPC path produced
it (`6413ac1f`). Fourteenth-pass NO FINDING: `resolveTurnSource` split
(line-neutral), `persistAssistantPartsLocal`/`persistToolPartsLocal`
(different roles and id functions), the three `current-*` context files
(different lifetimes), Live/Test actor builders, `agent-loop.actor-state.ts`
and `agent-loop.queue.ts` merges (coherent modules with one importer),
docblocks (every one states a why), `ExtensionProtocolError` (tests match
its tag). Core is 28,119 LOC, 4 files fewer.

## Fifteenth pass: the test-only resource assembly path (2026-09-13)

`buildExtensionLayers` and `buildResourceServiceLayer` deleted (the
ephemeral runtime's lifecycle-skip path; only tests called them, and they
now read the registry off the profile's own context); the declaration-time
`resolveExtensions` and the `config`/`resolved`/`extensionSectionInputs`
fields nothing read are gone, and `RuntimeProfileInputs.config` with them;
`persistAuthTo` is shared by the model resolver and provider auth; the four
interaction codec wrappers are one `jsonCodec` helper; the `ToolName`,
`CommandId`, `ActorId` brands and the `trackingApprovalService` /
`testObservability` test-utils are deleted. Fifteenth-pass NO FINDING:
`ConfigService.set`/`addPermissionRule` (no production caller, but the
write vehicle for the config merge tests; a client write RPC is the honest
fix), `RuntimeEnvironment.Test` (same reasoning as `Permission.Live`), the
small domain files (each states a layering rule), `request-dedup` tuning
knobs (the LRU proof), storage methods (all traced to shipped callers). Core
is 27940 LOC at 09d3290d.

## Sixteenth pass: one queue advance, one failure report (2026-09-13)

`agent-loop.worker.ts`: the five copies of "take the next admitted turn
or park idle" and "resume the parked interaction turn" are `advanceOrIdle`
and `resumeWaiting`; callers keep their own take/beginTurn ordering. The
three response collectors share `reportStreamFailure`; the pre-output
retry guard is unconditional (its only caller always set it), so
`retryPreOutputFailures` is gone. Tool-binding identity yields
`GentPlatform` for its hash instead of six closures threaded through
`resolveTurnContext`/`resolveTurnSource`; `captureCurrentToolBinding`
takes the tool name it reads (`8ec4a87a`). `ProjectionTurnContext`
deleted (hooks take `ExtensionTurnContext`; the cwd/home/ids wrapper had
no reader); `compileToolPolicy` takes the turn's `interactive` flag, not
a `RunContext` copy; `setStartingState` and the exported
`persistRuntimeState` dropped from the queue; `requireAgent` folded into
`requireCurrentAgent`; `makeRunSpec` is `omitUndefined` (`d3b3f3ff`).
Sixteenth-pass NO FINDING: the compactor's `hash` parameter stays (it
crosses the extension seam). Core is 27,790 LOC at `d3b3f3ff`.

## Seventeenth pass: server and storage (2026-09-13)

Storage: eight identical `mapError` closures are `storageError` in
`domain/storage-error.ts` (a StorageError passes through), and the
tool-call-binding read mapper is that function; the four `Model.Class`
tables plus `SqlModel.makeRepository` blocks existed for one insert each
while every other statement was raw SQL, so the inserts are raw SQL
(`fcf100d6`). Server: twelve handlers share `rpc(method, effect, fields,
requestId)` for the wide-event tap and boundary; `once` delivers the
envelope it produced and returns `{ result, fresh }`; `createBranchResult`
(an identity) and `CreateBranchResult` deleted; `RequestIdSchema` and
`ListAuthProvidersInput` aliases gone with their docblocks moved to the
owning schemas; `summarizeToolOutput` deleted in favour of
`summarizeOutput(part.result)` (`81df9093`). Seventeenth-pass NO
FINDING: `session-utils.ts`/`extension-health.ts` merges (line-neutral),
`ConnectionTracker`/`ServerIdentity` (real optional services), every RPC
entry has a shipped client except `session.delete`, `searchMessages` and
the relationship/operation storage methods (all traced to shipped callers),
`SqliteStorage` Live/Memory/Test (three real implementations), the
`inWorkspace` forwarders (a generic mapper needs `as`). Test-vehicle-only,
left for the user: the `session.delete` chain (~120 LOC, a real product
capability with no client), `DependencyOverrides.modelRegistryLayer`,
`makeServerRootLayer`. Explorer verdict: one more storage pass at most;
providers/ and domain/ are clean. Core is 27,656 LOC.

## Eighteenth pass: whole-core sweep (2026-09-13)

Cross-directory patterns the directory passes could not see: six
"message from an unknown cause" helpers and two open-coded copies are
`causeMessage` in `domain/guards.ts`; three JSON codec constructions use
`encodeToolOutput` and the permission evaluator stops rebuilding a codec
per check. Precision items: `RuntimeProfileDeclarations.cwd` (its only
caller had already computed it), `ToolCapability.native` (a self-reference
nothing read), `RequestCapability.public: true` (a constant nothing
branched on), the queue-storage copy of `emptyLoopQueueState`, the
`forRun` argument that restated its default plus the omit-vs-undefined
`runInfo` match nothing observed, `RuntimeEnvironment.Test` (byte-identical
to `Live`; 17 test files retargeted), the `testOverrides()` spread that
three of its four keys overwrote, and `storageErrorExcept` for the two
pass-through storage mappers (`2d13729b`). Eighteenth-pass NO FINDING:
`extensions/api.ts` and `branch-tools.ts` (every name has a consumer, guard
enforced), `test-utils/` (single importers are cross-package contracts;
`core-internal` is a symlink so its importers count), `retry.ts` (importers
use extensionless specifiers), the model-context trio, driver-registry,
resource-layer, membrane, project-trust, wide-event shim, and the
single-importer types that cross a layer. Explorer verdict: "this is the
last broad sweep worth running"; the remaining core is schema
declarations, actor protocol, and distinct service implementations.
Core is 27610 LOC.

## Nineteenth pass: repeated blocks across files (2026-09-13)

The confirmation explorer refuted "nothing left" with a cross-file
repeated-block search, which the directory and concept passes could not
see. `ExtensionEventSink` re-exposed `EventPublisher.publish` under a
second Tag nothing yielded; `config-service.ts` carried three copies of
the exists → read → decode pipeline (now `readConfigFile` plus an
empty-on-error and an error-typed wrapper); the fifteen-line message
chunk SELECT and the nine session columns were spelled out at seven sites
(now `MESSAGE_CHUNK_SELECT` and `SESSION_COLUMNS` in `sqlite/rows.ts`,
interpolated with `sql.literal`); `agent-loop.protocol.ts` had thirteen
identical `id` closures (now `branchTarget`/`messageTarget`);
`makeMemoryEventStore` and `EventStoreLive` shared registry, serialized
delivery, publish, subscribe and removeSession (now `makeEventStore`
with an `append`/`load`/`open` backend); `ExtensionHostRunProcessOptions`
was a byte copy of `RunProcessOptions` (`5bcfab0e`). Skipped: routing
`extension.request` through the `rpc` helper (it sets wide-event fields
before the effect runs; the helper sets them after). Explorer verdict:
"Continue — one final pass, then stop"; this was that pass. Left for the
user (test-vehicle-only): the `session.delete` chain (~120 LOC, no
client), `DependencyOverrides.modelRegistryLayer`, `makeServerRootLayer`.
Core is 27,495 LOC.

## Cell prompt, cell labels, and the agents pane (2026-09-13)

The user asked whether Bun subsumes any builtin extension and whether
the prompt teaches the cell well. An explorer audit found no tool that
raw Bun replaces cleanly: `read` owns line numbers, `write`/`edit` own
the FileLock and the diff render, `bash` owns 25 guardrail patterns and
the session trailer, `webfetch` owns HTML→markdown, `grep` owns the
gitignore-aware FileIndex. The real gaps were in the prompt: it never
said the cell is unsandboxed, steered shell to `Bun.$` (which bypasses
the bash guardrails), never asked for small results, and dropped the
delegate guidelines (the catalog prints descriptions only). `6de94c57`
fixes the prompt and adds `describeCellCode`, a static classifier
(host tools, `Bun.$`/`Bun.spawn` commands, `Bun.file`/`Bun.write`
paths, globs, fetch hosts) so a cell with no receipts reads
"$ bun test · read package.json" instead of "1 cell". `Bun.Glob` stays
out of the prompt because a guardrail greps for it; the prompt points
at the grep tool instead. A prime-agent study (cloned to the
scratchpad) showed the same approach: a scored code-preview picker,
`✓ python · preview · ↑ 1 ↓ 1 lines · 12ms`, `◇◈◆◈` for running, and
an agents view with `Running (n)` headings, `•` dots, and a
`Session · Model · Activity · Cost · Age` grid. The transcript glyphs
and the docked agents pane now follow that language (this commit).
Not done: per-cell durations (the TUI `ToolCall` carries no timing),
a persistent subagent tray above the composer, and a model column on
every row (the listing deliberately avoids per-row detail reads).

## Twentieth pass: concept census against prime-agent (2026-09-13)

Explorer verdict: "Stop — no findings". The census counted 54 Tags,
13 tables, 24 event variants, 14 actor messages, and 3 hook kinds, and
every mechanical candidate (head-tail helpers, `listSessions`,
`branch.getTree`, `BranchCreated`/`SessionStarted`, 25 test-only
exports, 36 files under 60 lines, storage methods, thin Tags) was
refuted by a shipped consumer, most of them in `apps/tui`. Lesson
recorded: reduction greps must include `apps/`. prime-agent's core is
52,439 LOC against gent's 27,495; its RLM kernel is a facade over a
larger session manager, and the concepts gent has that it lacks are
the durability ones (persisted actor messages, queue and operation
tables, resumable event log). The three parked items closed: the
`session.delete` chain now has a client (Ctrl+X in the agents pane,
two-press confirm, prime-agent parity), `makeServerRootLayer` is
deleted, `DependencyOverrides.modelRegistryLayer` is a real seam
(`ModelRegistry.Test` is a second adapter next to `authLayer` and
`configServiceLayer`). A live check found that the pane's per-row
detail read spawned the row's loop actor and made stored sessions show
as idle; detail reads are now limited to live rows. Open design note
for the user: `session.getSnapshot` spawning an entity is right when a
client is about to use the session and wrong for a listing; a
durable-only read path would need a new concept.

## Twenty-first pass: durability, tray, read-only requests (2026-09-13)

User directive: "add durability, read for snapshot is good and lets do
1 2 and 3". Five gate-green commits:

- `2e997821` durations. `toolCallDurations(events)` in
  `domain/message-part-display.ts` derives each cell's wall time from the
  `ToolCallStarted` → `ToolCallSucceeded/Failed` envelope gap, so no new
  persisted field. `getSessionSnapshot` reads the branch's events inside
  the same transaction and `ToolInteraction` carries `durationMs`. The TUI
  feed stamps `startedAt` live and the row reads `✓ … · 1.2s`; group
  headers sum finished cells. Verified: `68ms` / `7ms` survive `gent -c`.
- `c102fef9` tray. `SubagentTray` in the `above-input` slot renders
  `● N running   ◐ N idle   ○ N inactive` from the same `ListAgents` rows
  as the pane, counting only the current session's subtree (new
  `parentSessionId` on `AgentRowEntry`). Hidden while the pane is open or
  the subtree is empty.
- `36ac6903` read-only requests. The turn worker holds the side-mutation
  permit for the whole turn, so every extension request blocked until the
  turn ended (the pane showed "loading…" for minutes). `request({ readonly:
true })` skips the permit; `CompiledRpcRegistry.isReadonly` answers the
  handler. Only `ListAgents` is marked; `btw.progress`, `goal.get`, and the
  skills list/get-content requests are candidates not yet marked.
- `32b84303` live status in the listing. `listActiveLoops` now reads each
  loop's registered `SessionRuntimeState` through effect-encore's
  `stateOf`, so the live half of the catalog carries `Running`/`Idle`
  without a per-row snapshot. `SessionRuntime.listActiveLoops` and
  `ActiveLoop` deleted (the host context was the only caller). Follow-up:
  the address needs a placeholder `ShardId`; an upstream
  `stateOf(entityType, entityId)` helper would remove it (opened as
  effect-encore PR #66, `ActorStateKey`, same day; merged, released as 0.31.0,
  and adopted: `loopStateAddress` is gone).
- `d0d8118c` tray poller. Receipts arrive only at spawn/success/failure,
  so counts went stale mid-run; a 2s `Schedule.spaced` refresh runs while
  the subtree is non-empty and the pane is closed.

Gamut run 30 (sonnet-sonnet at `32b84303`): 5 children, 5/5 receipts, 18
tests green in 2m59s, $0.83, no continuation. Live check showed
`● 1 running` mid-spawn and `◐ 5 idle` after. Gamut run 31 (opus-luna
at `d0d8118c`): 5 Luna children, 5/5 receipts, 19 tests green in 8m11s,
$1.26, no continuation; the poller kept `● 2 running` current mid-turn.

## /model: a session-scoped model setting (2026-09-14)

User directive: "we need a slash command to change the models", then
"be sure to use the herdr cli to test the TUI and test the model changing
flow" and "lets not use modals - only panes". Two commits on main
(`07ef2ef5`, `acf2e2e8`), built in a Rift and fast-forwarded.

A session now carries `modelId` next to `reasoningLevel` (migration
`017_session_model`). One mutation, `session.updateSettings`, replaces
`session.updateReasoningLevel` and sends both settings whole; the event
`SessionSettingsUpdated` and `SessionSnapshot` carry both. In
`turn-resolve.ts` the session's model wins over the agent definition,
config `agents[name]`, and run-spec overrides; the acceptance test in
`message-send.test.ts` proves a set-then-clear round trip against a
config override.

The TUI's `/model` opens a docked pane under the composer (same chrome
as the agents pane, no overlay): typed filter, current model marked `●`,
Enter selects. `/model <id or name>` resolves an exact id or a unique
substring through `resolveModelQuery`; `/model default` clears. The pane
lists only models whose provider has a registered driver (103 rows, not
the 7,753 models.dev entries); the narrowing lives in the TUI because
`model.list` is a catalogue cache ten test files depend on. The footer
shows the session's model before the next turn streams.

Two latent defects surfaced by the live run. `setError` set an agent
status nothing rendered, so every slash-command error was invisible;
the footer now shows it in red in place of the phase word. The migration
"already applied" detector read only the SqlError's generic message and
missed "duplicate column name" on the cause; the equal-time-order test
now exercises it through migration 017.

herdr run (pane `wZ:p18`, opus-luna testbed): picker opened, `luna`
filtered to one row, Enter switched the footer to GPT-5.6 Luna at once,
the next turn's `StreamEnded.model` was `openai/gpt-5.6-luna`, the
`sessions.model_id` column held it, `gent -c` reloaded with the setting,
`/model anthropic/claude-sonnet-5` set Sonnet 5, `/model claude` showed
the 14-candidate error, `/model default` cleared and the next turn ran on
Opus from config. Known gap: right after clearing, the footer falls back
to the last streamed model until the next turn, because the client cannot
resolve the config default itself.

## Resolved settings on the snapshot; `/think` shares the pane (2026-09-13, `73bd6d94`)

`SessionSnapshot` carries `resolvedModelId` and `resolvedReasoningLevel`.
`resolveSessionSettings` in `turn-resolve.ts` is the one place that folds
session setting > config `agents[name]` > agent definition; the turn and
the snapshot both call it, and `resolveReasoning` in `agent-loop.utils.ts`
is gone. `getSessionSnapshot` resolves the session's registry by cwd
through `resolveRegistryForCwd`, which the handler's
`resolveSessionRegistry` now reuses. The TUI no longer guesses from the
last streamed model: `AgentState.lastModelId` and `resolveModelInfo` are
deleted; `model()` reads session setting, then the resolved id;
`modelInfo()` is a lookup. Every settings write refreshes the snapshot.

`SettingsPicker` replaces `ModelPicker`: one docked pane with row builders
`modelRows` and `reasoningRows` (`default` plus the seven core levels, the
resolved level shown on the default row). `/think` with no argument opens
it; `/think <level>` accepts every core level plus `default`/`off`.

herdr run (pane `wZ:p18`, opus-luna testbed, config Opus at `low`): a fresh
session's footer read `Claude Opus 5 · low` before any turn; `/model luna`
→ `GPT-5.6 Luna`; `/model default` → `Claude Opus 5` at once (the gap from
the previous section is closed); `/think` opened `Reasoning · 8`, typing
`xh` + Enter set `xhigh`; `/think default` returned to `low`; one turn ran
on `anthropic/claude-opus-5` per `StreamEnded.model`.

Receipts: `packages/core/src/runtime/agent/turn-resolve.ts`,
`packages/core/src/server/rpc-handlers.ts`,
`packages/core/src/server/transport-contract.ts`,
`apps/tui/src/components/settings-picker.tsx`,
`apps/tui/src/client/context.tsx`, `apps/tui/src/routes/session.tsx`,
`packages/core/tests/server/message-send.test.ts`,
`apps/tui/tests/components/settings-picker.test.tsx`.

## `metrics.lastModelId` dropped (2026-09-13, `4fd4700a`)

The snapshot's `resolvedModelId` names what the next turn uses, so the
agents-pane detail reads it and the metrics fold no longer tracks the last
streamed model. Five files, 3 insertions, 15 deletions.

Gamut run 32 (opus-luna, at `73bd6d94`): Opus root at `low`, 5 Luna
children, 5 spawn + 5 success receipts, 18 tests green in 7m32s, $0.69, no
continuation. Every child's `StreamEnded.model` was `openai/gpt-5.6-luna`
with an empty `sessions.model_id`, so children still take the caller's
`overrides` rather than a session setting; the root stayed on
`anthropic/claude-opus-5`. Opus reported the 9 pre-existing Cents typecheck
errors and did not touch them.

## Prior-art pass (2026-09-14, `8598c184` → `cb422a69`)

Seven commits from the ledger `plans/prior-art-review-2026-09-13.md`,
merged fast-forward; 90 files, +1,080 −2,746; core 27,412 LOC
(`packages/core/src`, was 27,495).

| Commit     | Ledger     | Change                                                                                                                                               |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1d7124d9` | R2, R3, R5 | `instructions` folded into `agents`; `webfetch` and `search_sessions` removed; cell guideline names `~/.gent/data.db`; turndown and linkedom dropped |
| `fc134b9e` | R4         | `RetryPolicy` on `ModelDriverContribution.retry`; the loop keeps "re-run the step"                                                                   |
| `fb9ad41f` | A2, A5     | durable `model-change` user message on a model switch; A5 verified, no change                                                                        |
| `e9808c2e` | A1         | tool results capped at 8,000 chars with a `context.read` locator                                                                                     |
| `d7dbf8e7` | R1         | permission rules, `/permissions` pane, `permission.*` RPCs removed; bash guardrails ask once                                                         |
| `41c971aa` | R7, A4     | `classifyStep` → `StepOutcome`; policy and persistence match on it; `StreamEnded.outcome`                                                            |
| `cb422a69` | Q4         | ARCHITECTURE.md Rules are sixteen numbered invariants with receipts plus a known-gaps list                                                           |

R6 (agents-view server half) rejected: the live catalog
(`ExtensionContext.Session.listActiveLoops`) and the stored catalog
(`session.list`) differ after a restart. A3 (typed fan-in) stays a known gap.
`agent-runner.ts` and `agent-loop.handlers.ts` are actor command handlers,
not the stream fold; they did not shrink with R7.

Gamut run 33 (opus-luna, at `cb422a69`, gate for the pass): Opus root at
`low`, 5 Luna children, 18 tests green in 5m04s, $1.92, no continuation.
`StreamEnded.outcome` on the root: 15 `ToolCalls`, 1 `Answered`; on the
children: 26 `ToolCalls`, 5 `Answered`. Opus resolved two merges itself and
reported the 9 pre-existing Cents typecheck errors.

Files: `packages/core/src/runtime/agent/agent-loop.turn-execution.ts`,
`packages/core/src/domain/event.ts`, `packages/core/src/domain/driver.ts`,
`packages/core/src/runtime/retry.ts`,
`packages/core/src/providers/ai-transcript.ts`,
`packages/core/src/server/session-mutations-live.ts`,
`packages/extensions/src/agents.ts`, `packages/extensions/src/exec-tools/bash.ts`,
`packages/core/tests/runtime/agent-loop/step-outcome.test.ts`,
`ARCHITECTURE.md`, `plans/prior-art-review-2026-09-13.md`.

## Compaction handoff, step cost, handler collapse (2026-09-14, `be77fe38` → `0753abbe`)

Four commits in the Rift `compaction-session-context`; 40 files, +1,228
−2,491; core 27,472 LOC (`packages/core/src`, was 27,412: the window
projection gained `projectContextWindow`), extensions 15,790 LOC (was
16,495); `packages/extensions/src/compaction/` 306 lines (was 1,038).

| Commit     | Change                                                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fa36c0bc` | subagents tray takes fx's `<name> working · <task>` rows, hides when nothing runs                                                                                                                                                            |
| `363bedda` | compaction hands off: one durable user-role `context-window` marker with `summarized { firstMessageId, lastMessageId, count }`; the notice names the session id, branch id, and id range; `context.history` joins the cell; failures degrade |
| `3cfb483d` | the "Worked for" row tallies `StreamEnded.outcome` per turn: steps, tool calls, cost                                                                                                                                                         |
| `0753abbe` | one admission path (`reserveAndStart`) in the actor handlers, pure `foldSessionMetrics`; handlers 902 → 844                                                                                                                                  |

Gone with `363bedda`: `summary-record.ts` (source revisions, path record,
source replacement), `cellInnerOperationReceipts`, `SummaryPersister`,
`ModelCompactionResult`, `compactedRevision`, the `CompactionCard`, and the
receipt-driven `model-compaction-dispatch` test. `handoffMessageId` (a
`MessageId`) replaces the revision on the ledger status, the projection
event, the snapshot metrics, and the TUI status label.

Runner (`agent-runner.ts`) is 575 lines (was 562): the two child prompt
submissions share `promptChild`; nothing else moved. ARCHITECTURE.md
invariant 17 records the handoff; the known gap for the handlers now names
the recovery reads that remain there.

Files: `packages/core/src/runtime/model-context-window.ts`,
`packages/core/src/runtime/model-context-compactor.ts`,
`packages/core/src/runtime/agent/turn-source.ts`,
`packages/extensions/src/compaction/model-compaction.ts`,
`packages/extensions/src/cell/cell-context-host.ts`,
`packages/extensions/src/cell/cell-tool.ts`,
`apps/tui/src/components/message-list.tsx`,
`apps/tui/src/components/session-event-label.ts`,
`apps/tui/src/hooks/use-session-feed.ts`,
`packages/core/src/runtime/agent/agent-loop.handlers.ts`,
`packages/core/src/runtime/agent/agent-loop.state.ts`,
`packages/extensions/tests/compaction/model-compaction.test.ts`,
`packages/core/tests/runtime/agent-loop/session-metrics-fold.test.ts`.

Gamut run 34 (opus-luna, at `0753abbe`, gate for the pass): Opus root at
`low`, 8 Luna children (6 tasks + 2 checks), 8 spawn + 8 success receipts,
17 tests green in 5m36s, $0.82, no continuation. Root outcomes: 6
`ToolCalls`, 1 `Answered`. The "Worked for" row read
`Worked for 5m 36s · 7 steps · 6 tool calls · $0.819`in the terminal, and
the tray showed two`main working · Task N …` rows under the status line
mid-turn. No handoff fired: the root peaked at 6,878 estimated tokens
against a 1,000,000 limit, so the compaction-after-spill measurement stays
"none needed on the gamut"; the live store holds one compaction ever
(2026-09-13, before the spill), 2,790 projections peaking at 46,919 tokens,
and no compaction since the spill landed.

## Recovery reads behind the behavior; A3 rejected (2026-09-14)

`incompleteUserTurn` and `hasPriorHistory` are members of
`AgentLoopBehavior` (`packages/core/src/runtime/agent/agent-loop.behavior.ts`);
the actor handlers hold no storage scan of their own. Handlers 844 → 804
lines, behavior 509 → 552. The loop, runner, and runtime suites pass (145
tests). ARCHITECTURE.md drops the handler gap.

A3 (typed fan-in) is rejected: `Promise.all` over foreground `delegate`
calls is the fan-in, `background: true` returns a handle whose completion
lands as a user message, and gamut run 34 ran six delegates in one cell
without a `collect`. Recorded in `ARCHITECTURE.md` known gaps and the
ledger status table.

## Adjustable context window; mid-turn handoff (2026-09-14, `424497ad` → `736235db`)

`AgentDefinition.contextLength` and `AgentRunOverrides.contextLength` set the
input window per agent from `.gent/config.json` `agents.<name>` or a
`delegate` override; `resolveTurnSource` prefers it over the model catalog's
limit. Gamut run 35 (opus-luna, `424497ad`, `contextLength: 20000`, ~8.5k
input tokens after the 7.5k system+tool reserve and the 4k reply reserve)
killed the root and five of eleven children with `ModelContextProjectionError`
and an empty message: a turn with several large steps after its only user
message had no history before the anchor, so the projection failed with
`BudgetExceeded` instead of handing off.

`b3b2a1c7`: `handoffAnchorWithinTurn` (`runtime/model-context.ts`) anchors
the handoff at a step boundary inside the turn and keeps the newest steps
that fit half the budget; `handoffPlan` in `turn-source.ts` picks it when the
projection fails with `BudgetExceeded`. `ModelContextProjectionError` now
names its failure tag. Test: "a turn whose own steps overflow hands off at a
step boundary" (`tests/runtime/agent-loop/model-compaction.test.ts`, proven
to fail without the override path).

Gamut run 36 (opus-luna, `b3b2a1c7`, 20k window): 7 sessions, 13 handoffs,
0 errors, 5 of 6 children completed, 16 testbed tests green. One Luna child
looped: 53 steps, 12 handoffs, no edit. Its summaries were accurate (goal,
files, the store-test conflict, "no edits made") but with ~4.4k tokens of
usable tail it re-inspected the repo after each handoff. Two harness gaps
surfaced: the bindings note listed ~90 retained cell names on every handoff,
and `estimateTokens` counted a 16k-char cell result at its stored size while
the model sees the 8k spill. `736235db` fixes the estimate
(`boundToolResultForModel` in the budget). The bindings note stays open.
The run was stopped by hand after 13 minutes.
