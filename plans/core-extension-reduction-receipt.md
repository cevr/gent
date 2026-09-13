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
