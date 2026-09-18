# Test fold map — apps/tui

Before: 90 test/helper files (88 test files run by `bun run test`), 695 tests, 14.21 s.

One test file per source concern under `apps/tui/src/`. The target directory
mirrors `src/`: a concern under `src/extensions/` gets
`tests/extensions/<concern>.test.tsx`.

## Rule 4 — file-global effects

None. No test file in `apps/tui/tests/` uses `mock.module`, a top-level
`beforeAll`/`afterAll`/`afterEach`/`beforeEach`, a `process.env` write, or
`setSystemTime`. No exception is needed.

## Rule 5 — files named in package.json

`tests/headless-cli-exit.test.ts` and `tests/headless-runner.test.ts` are named
in the `test` and `test:e2e` scripts of `apps/tui/package.json`. Both keep
their names and are not folded.

## Rule 6 — helper modules

| Helper                                     | Importers                                               | Action                                        |
| ------------------------------------------ | ------------------------------------------------------- | --------------------------------------------- |
| `tests/render-harness-boundary.tsx`        | many, plus `integration/` and `packages/tooling/tests/` | keep                                          |
| `tests/helpers-boundary.ts`                | many                                                    | keep                                          |
| `tests/run-effect-boundary.ts`             | many, plus `packages/extensions/tests/`                 | keep                                          |
| `tests/extension-test-harness-boundary.ts` | many                                                    | keep                                          |
| `tests/scrollback-hold-boundary.ts`        | 1 after the message-list fold                           | keep — see the note below                     |
| `tests/herdr-test-server-boundary.ts`      | 1 (`herdr.test.ts`)                                     | fold into `tests/extensions/builtins.test.ts` |

`tests/scrollback-hold-boundary.ts` became a single-importer helper once
`message-list.test.tsx` absorbed both of its callers, so rule 6 would fold it.
It stays a separate file anyway. It holds a real Promise boundary
(`Effect.runPromiseWith` around the renderer's `settle`), and the
`gent/no-promise-control-flow-in-tests` lint rule exempts a file only by its
`-boundary.ts` suffix (`lint/no-direct-env.ts:107`). Folding it into a
`.test.tsx` file makes the gate fail. The fold was made and reverted.

## Map

### tests/ (root concerns)

| Target                                 | Sources                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/app.test.tsx`                   | `app-auth.test.tsx`, `app-bootstrap.test.ts`, `widgets-render.test.tsx`                                                                                                                                                                                          |
| `tests/auth.test.tsx`                  | `auth-route.test.tsx`, `auth-state.test.ts`                                                                                                                                                                                                                      |
| `tests/autocomplete.test.ts`           | `autocomplete-frecency-cross-writer`, `autocomplete-frecency-durability`, `autocomplete-frecency-seam`, `autocomplete-frecency-store`, `autocomplete-frecency`, `autocomplete-ranking`                                                                           |
| `tests/client.test.tsx`                | `agent-lifecycle.test.ts`, `child-session-tracker.test.ts`, `client-provider-contract.test.tsx`, `client-session-metrics.test.tsx`, `client-session-state.test.tsx`, `session-settings-state.test.ts`, `use-child-sessions.test.ts`, `use-session-feed.test.tsx` |
| `tests/commands.test.tsx`              | `slash-commands.test.ts`, `components/command-palette.test.tsx`                                                                                                                                                                                                  |
| `tests/composer.test.tsx`              | `composer-frame-anchor.test.tsx`, `composer-render.test.tsx`, `paste-indicator.test.ts`, `shell.test.ts`, `components/autocomplete-popup.test.tsx`, `components/composer-ghost.test.tsx`, `components/composer-slash-enter.test.tsx`                             |
| `tests/headless.test.ts`               | `headless-runner.test.ts` stays (rule 5); no other source                                                                                                                                                                                                        |
| `tests/interaction-renderers.test.tsx` | `components/interaction-renderers/ask-user`, `.../handoff`, `.../prompt`                                                                                                                                                                                         |
| `tests/mermaid.test.ts`                | `mermaid.test.ts`, `mermaid-viewer-state.test.ts`                                                                                                                                                                                                                |
| `tests/message-list.test.tsx`          | `message-list-render.test.tsx`, `native-transcript-commit`, `native-transcript-fingerprint`, `native-transcript-markdown`, `native-transcript-mouse`, `reasoning-text.test.ts`, `session-event-indicator.test.ts`, `split-footer-height.test.ts`                 |
| `tests/ops.test.ts`                    | `client-logs.test.ts`, `local-health.test.ts`                                                                                                                                                                                                                    |
| `tests/os.test.ts`                     | `external-editor.test.ts`                                                                                                                                                                                                                                        |
| `tests/pickers.test.tsx`               | `components/pickers.test.tsx`, `components/settings-picker.test.tsx`, `prompt-search-render.test.tsx`                                                                                                                                                            |
| `tests/session.test.tsx`               | `composer-interaction-state.test.ts`, `model-query.test.ts`, `prompt-history.test.ts`, `prompt-history-store.test.ts`, `session-controller-state.test.ts`, `session-labels.test.ts`, `session-labels-order.test.ts`, `session-ui-state.test.ts`                  |
| `tests/theme.test.ts`                  | `theme-view.test.ts`, `components/theme-picker.test.tsx` → `.tsx`                                                                                                                                                                                                |
| `tests/tool-renderers.test.ts`         | `edit-utils.test.ts`                                                                                                                                                                                                                                             |
| `tests/ui.test.tsx`                    | `components/select-list.test.tsx`, `components/docked-pane-frame.test.tsx`                                                                                                                                                                                       |
| `tests/utils.test.ts`                  | `context-window.test.ts`, `file-refs.test.ts`, `format-duration.test.ts`, `format-error.test.ts`, `format-tool.test.ts`, `generic-format.test.ts`, `message-list-utils.test.ts`, `truncate.test.ts`                                                              |

`tests/sdk-utilities.test.ts` imports no `src/` file; it covers
`@gent/sdk` + `@gent/core/protocol` message projection, exercised by the TUI
message list. It folds into `tests/message-list.test.tsx`.

`tests/extension-lifecycle.test.ts` imports no `src/` file; it covers the
`ClientLifecycle.addCleanup` ordering contract that
`src/extensions/client-facets.ts` owns. It folds into
`tests/extensions/client-facets.test.ts`.

### tests/extensions/ (src/extensions concerns)

| Target                                         | Sources                                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/extensions/agents.client.test.tsx`      | `components/agents-controller.test.ts`, `components/agents-pane.test.tsx`, `components/subagent-tray.test.tsx`, `components/pane-stale-reply.test.ts`                                    |
| `tests/extensions/btw.client.test.tsx`         | `side-question-pane.test.tsx`                                                                                                                                                            |
| `tests/extensions/builtins.test.ts`            | `file-tag.test.ts` (the `getFileTag` half of the old `autocomplete.test.ts`), `driver-transport.test.ts`, `file-finder-db-dir.test.ts`, `herdr.test.ts`, `herdr-test-server-boundary.ts` |
| `tests/extensions/client-facets.test.ts`       | `client-runtime.test.ts`, `client-session-resource.test.ts`, `extension-lifecycle.test.ts`                                                                                               |
| `tests/extensions/loader-boundary.test.ts`     | `autocomplete-contribution-order.test.ts`, `autocomplete-effect-items.test.ts`, `extension-effect-setup.test.ts`, `extension-integration.test.ts`, `extensions-resolve.test.ts`          |
| `tests/extensions/thread-view.client.test.tsx` | `components/thread-view.test.tsx`                                                                                                                                                        |
| `tests/extensions/wake.client.test.tsx`        | `components/wake-tray.test.tsx`                                                                                                                                                          |

`tests/components/` is removed when empty.

## Source concerns with no test file

`client.tsx` covers `main.tsx`; `terminal.tsx`, `text-width-adapter.ts`,
`workspace.tsx` and `host.tsx` have no test file of their own and gain none.

## Pre-fold normalization

Two rewrites ran over every file in `apps/tui/tests/` before the first fold,
because both block an import merge:

1. `from "bun:test"` → `from "effect-bun-test"`. `effect-bun-test` re-exports
   `describe`, `test` and `expect` from `bun:test` unchanged, so the two
   specifiers name the same values; the fold tool otherwise reports a duplicate
   identifier for each one. `tests/render-harness-boundary.tsx` is excluded:
   it imports `afterEach`, which `effect-bun-test` does not re-export.
2. `from "../src/x.js"` → `from "../src/x"`. Both resolve (the repo uses
   `moduleResolution: "bundler"`), but the fold tool treats them as two
   specifiers and imports the same name twice.

## Renames

| Target                                 | Name                                             | New name                                                     | Why                                                                                            |
| -------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `tests/utils.test.ts`                  | `absent`, `nullValue`                            | —                                                            | identical in `format-tool` and `message-list-utils`; one copy kept                             |
| `tests/session.test.ts`                | `theme`, `contextLabels`                         | `themeOrder`, `contextLabelsOrder`                           | different values in `session-labels` and `session-labels-order`                                |
| `tests/autocomplete.test.ts`           | `NOW`, `orEmpty`, `ids`                          | —                                                            | identical across the frecency and ranking sections; one copy kept                              |
| `tests/autocomplete.test.ts`           | `skills`, `commands`                             | `skillsRanking`, `commandsRanking`                           | different corpora in `autocomplete-frecency` and `autocomplete-ranking`                        |
| `tests/interaction-renderers.test.tsx` | `interaction`                                    | —                                                            | identical in all three renderer sections; one copy kept                                        |
| `tests/composer.test.tsx`              | `Contribute`                                     | `ContributePopup`, `ContributeGhost`, `ContributeSlashEnter` | four different contribution harnesses                                                          |
| `tests/composer.test.tsx`              | `TestComposer`                                   | `TestComposerGhost`, `TestComposerSlashEnter`                | three different controller mocks                                                               |
| `tests/composer.test.tsx`              | `RegisterCommands`                               | `RegisterCommandsGhost`, `RegisterCommandsSlashEnter`        | different command registries                                                                   |
| `tests/message-list.test.tsx`          | `absent`, `syntaxStyle`, `assistant`, `longBody` | —                                                            | identical across the transcript sections; one copy kept                                        |
| `tests/message-list.test.tsx`          | `transcript`                                     | `transcriptCommit`                                           | different props in `native-transcript-fingerprint` and `native-transcript-commit`              |
| `tests/message-list.test.tsx`          | `Message` (the type from `src/message-list`)     | `ListMessage`                                                | the protocol `Message` class and the render union share the name; the type-only one is aliased |

| `tests/auth.test.tsx` | `apiMethod`, `oauthMethod` | `apiMethodRoute`, `oauthMethodRoute` | different labels in `auth-state` and `auth-route` |
| `tests/client.test.tsx` | `absent`, `nullValue`, `ClientProbe` | — | identical across the client sections; one copy kept |
| `tests/client.test.tsx` | `waitFor` | `waitForFeed` | different attempt budgets and error types |
| `tests/client.test.tsx` | `requireClient` | `requireClientSessionState` | different error types |
| `tests/client.test.tsx` | `SessionSnapshot` (import) | — | `@gent/sdk` re-exports the `@gent/core/protocol` value; both sections now import it from the protocol |
| `tests/app.test.tsx` | `absent`, `nullValue` | — | identical in all three sections; one copy kept |
| `tests/app.test.tsx` | `Session` (import) | — | same re-export; normalized to `@gent/core/protocol` |
| `tests/app.test.tsx` | `renderFrame` (import) | — | `helpers-boundary` re-exports it from `render-harness-boundary`; both sections now import it from the harness |

| `tests/extensions/agents.client.test.tsx` | `row` | `rowPane`, `rowStaleReply` | three different `AgentRowEntry` shapes |
| `tests/extensions/loader-boundary.test.ts` | `absent`, `ids`, `skillsModule` | — | identical across the sections; one copy kept |
| `tests/extensions/loader-boundary.test.ts` | `commands` | `commandsSeam` | different corpora in `autocomplete-contribution-order` and `autocomplete-frecency-seam` |
| `tests/extensions/loader-boundary.test.ts` | `loadTuiExtensions` (import) | — | the integration section declares a wrapper of the same name; the plain import is dropped, `_loadTuiExtensions` remains |
| `tests/extensions/builtins.test.ts` | `SessionId` (import) | — | `@gent/core/extensions/api` re-exports the `@gent/core/protocol` value; one import kept |

## Timing

`bun run test` in `apps/tui`: 14.21 s before, 10 s to 18 s after (the run
varies by several seconds between repeats at `--parallel=3`).

Rule 9: the slowest folded file is `tests/app.test.tsx` at 4.71 s on its own,
then `tests/client.test.tsx` at 4.27 s and `tests/composer.test.tsx` at
3.27 s. No file approaches the 60 s threshold, so no describe is split back
out.

## Fold-tool gaps found

1. **An `import` inside a template literal is treated as a real import.**
   `extension-integration.test.ts` and `extension-effect-setup.test.ts` write
   fixture extension modules to disk as template literals. The tool deleted
   those `import` lines from inside the strings and hoisted them to the file
   head, which broke five fixtures and added a bogus
   `../../../src/extensions/client-facets` specifier. Both sections were
   restored from `git show` with only the genuine top-level imports removed.
2. **A pre-existing target file's own content is dropped.** The first fold
   named `tests/autocomplete.test.ts` as the target without also listing it as
   a source, and its 15 `getFileTag` tests disappeared. They were recovered as
   `tests/file-tag.test.ts` and folded into `tests/extensions/builtins.test.ts`.
   Always list an existing target as its own first source.
3. **`packages/tooling/tests/` path mentions are not repointed.** The tool
   rewrites `.md` files and `packages/tooling/src/` only. Two tooling tests
   named moved files and were fixed by hand.
4. **A `@effect-diagnostics-next-line` suppression is separated from its
   import.** The merge lifts the import but leaves the comment behind, and the
   guard then fails on the orphan. Four orphans were dropped and the two
   surviving node-builtin imports regained their suppression.
5. **Renaming a colliding name can hit an object shorthand key.** In
   `session.test.ts`, `theme` was both a local const and a shorthand property
   (`{ theme }`), so a word-boundary rename silently renamed the property too
   and broke the call. A rename must write `theme: themeOrder`. Renaming can
   also reach a string literal: two `test(...)` names in
   `autocomplete.test.ts` were rewritten before being restored.
