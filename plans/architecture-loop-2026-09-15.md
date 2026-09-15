# Per-package architecture loop (2026-09-15 →)

Goal (user): run `/improve-codebase-architecture` on each package until no
more findings, compared against opencode v2 (Effect) and pi (minimalism);
add and remove while keeping capabilities. Effect-native, actor model, lean
core, fully extensible. Baseline `74b1b5d5`: core 27.6k, tui 24.1k,
extensions 16.5k, tooling 2.3k, sdk 2.0k, server 0.7k, e2e 0.3k src LOC.
pi has no `v2` branch on its origin; opencode's `v2` worktree is the prior
the Effect comparison uses.

Each row: the finding, the deletion-test verdict after my own read, and
what happened. A pass ends for a package when a run yields nothing Strong
or Worth exploring.

## sdk / server / tooling / e2e — pass 1

| #   | Finding                                                                                                                                     | Verdict                                                             | Status                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| S1a | `apps/server/src/debug/scenario.ts` (520) unreachable: `GENT_DEBUG_MODE` read once, set nowhere; `debug-failing`/`debug-slow` had no setter | confirmed by grep                                                   | landed `0ec4f226`                                                                          |
| S1b | `apps/server/src/main.ts` re-implements `Gent.server` (SDK) as a second root                                                                | real; fixed port + idle shutdown must move onto `GentServerOptions` | open                                                                                       |
| S2  | six `packages/e2e` files (1,110 LOC) spawn no process and sit outside the gate                                                              | confirmed (`transportCases` has one direct case)                    | open                                                                                       |
| S3  | workspace id hashed twice (`transport-headers.ts` vs `platform.hash`)                                                                       | real, but `client.ts` uses it as a default parameter                | open, Worth exploring                                                                      |
| S4  | `shipped-extensions.ts` alias used by one of the two roots it claims to serve                                                               | pass-through                                                        | landed `0ec4f226`                                                                          |
| S5  | four tooling guard suites never ran (`package.json` named five files); six assertions had drifted to `code-cell`                            | confirmed                                                           | landed `0ec4f226` (`./tests/`; a lint fixture under `fixtures/` must stay out of the glob) |
| S6  | suppression inventory carried four kinds oxlint already bans, and scanned block disables twice                                              | confirmed (zero occurrences of each dead kind)                      | landed `0ec4f226`                                                                          |
| S7  | `core-dead-exports` scans core only; sdk surface pinned by a name snapshot                                                                  | Worth exploring                                                     | open                                                                                       |
| S8  | `runtime-boundary.ts` four-line trampoline for the `runPromise` lint rule                                                                   | Speculative; rule is load-bearing                                   | rejected                                                                                   |

## tui — pass 1

| #   | Finding                                                                                                                           | Verdict                                                      | Status                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| T1  | `use-session-feed.ts` re-projects what `session.getSnapshot` already returns as `ProjectedMessage` (~500 LOC parallel projection) | Strong; pi single-sources, opencode duplicates and is larger | open, needs regression tests for `4cf16681`/`89dbd731` first |
| T2  | `atom-solid/` (684) has no production consumer beyond a `RegistryProvider` mount and one `Result` type                            | confirmed by grep                                            | in flight (rift `tui-dead`)                                  |
| T3  | six panes hand-write the same keyboard/scroll/filter block; `filter-list-state.ts` too shallow                                    | Strong; pi has one `showSelector`                            | open                                                         |
| T4  | `composerSurface`, `ClientComposer`, `paletteLevel` seams have zero adapters                                                      | confirmed by grep                                            | in flight (rift `tui-dead`)                                  |
| T5  | 180-LOC router with history for two routes; branch picker is a boot-time pane                                                     | Strong                                                       | open, after T3                                               |
| T6  | four-way client context split re-merged by every consumer                                                                         | Worth exploring; order with T1                               | open                                                         |
| T7  | auth is 1,236 LOC + 1,706 test LOC for an ops-time flow                                                                           | Worth exploring; High risk; after T3                         | open                                                         |
| T8  | child-session tracker is a third live-agent catalog                                                                               | Worth exploring; latency to measure                          | open                                                         |

## core — pass 1

| #   | Finding                                                                                                                                                                             | Verdict                                                                                                                                                                                                                       | Status                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| C1  | turn position inferred by probing 200 message ids; three stacked replay mechanisms (durable bindings, process-local map, persisted results); pi/opencode write the position durably | Strong; the structural one                                                                                                                                                                                                    | open, own Rift with gamut gate |
| C2  | `SessionRuntime` is a validating pass-through to the actor                                                                                                                          | **rejected**: eight in-core consumers (`agent-runner`, `child-completion`, `session-mutations-live`, `rpc-handlers`, tests) plus the extension host; it is the actor client, and the message-id/commandId minting lives there | —                              |
| C3  | `StepResult.Stop` re-encodes `StepOutcome` as three booleans                                                                                                                        | **rejected as stated**: the booleans are the turn-level end state after continuation policy (a `Failed` step can `Continue`), and `TurnCompleted` carries them; a `TurnEnding` tag would save ~40 LOC, not 120                | —                              |
| C4  | `Session`/`Files` facets facaded twice (`extension-services.ts` + `make-extension-host-context.ts`)                                                                                 | Worth exploring                                                                                                                                                                                                               | open                           |
| C5  | queue is three untagged arrays; `startsWith("follow-up:")` policy in `agent-loop.state.ts:119`; both priors use one tagged inbox                                                    | Strong on the prefix check; the merge heuristic is product behaviour                                                                                                                                                          | open                           |
| C6  | six single-importer modules (2,970 LOC) in the turn path                                                                                                                            | Worth exploring; both priors accept flat files                                                                                                                                                                                | open, after C1                 |
| C7  | `AgentRunnerService` Tag has one adapter; child policy (depth, visibility, caps) in core                                                                                            | Worth exploring; Tag removal Strong                                                                                                                                                                                           | open                           |
| C8  | `transactWithEvent` twice; `makeInteractionService` factory with one instance                                                                                                       | **rejected**: the two helpers differ in shape (fixed events vs mutation-decided envelope); inlining the factory costs a 343-line test rewrite for ~30 LOC                                                                     | —                              |

## extensions — pass 1

The agent's original E5/E7/E8 text was lost with the transcript; the rows
below record what was verified and acted on.

| #   | Finding                                                                                                                         | Verdict                                                                              | Status                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| E1  | `promptGuidelines` on read/grep/bash repeated the same "use the fs tools" prose three times                                     | confirmed                                                                            | landed `56ca6bcc` (one bash guideline; read/grep carry none)                             |
| E2  | bash read-only detection was a prefix check; compound commands (`ls; rm`, `$(...)`, `xargs`, `-exec`) slipped past as read-only | Strong                                                                               | landed `56ca6bcc` (`classifyBashCommand`: every segment read-only and no hidden command) |
| E3  | anthropic and openai provider modules each own a credential cache with the same persist/invalidate shape                        | Strong; one `makeCredentialCache<C>` behind both Tags                                | landed `7746f9d0`                                                                        |
| E4  | ACP adapter could sit on the vendor SDK instead of the hand-rolled protocol half                                                | Worth exploring; do not delete ACP (see [[project-acp-adapter-fills-external-seam]]) | open                                                                                     |
| E5  | (text lost)                                                                                                                     | —                                                                                    | re-run on pass 2                                                                         |
| E6  | eight cell test files gated on `process.platform === "darwin"` although the cell has no darwin-only dependency                  | confirmed (suite green ungated)                                                      | landed `56ca6bcc`                                                                        |
| E7  | (text lost)                                                                                                                     | —                                                                                    | re-run on pass 2                                                                         |
| E8  | (text lost)                                                                                                                     | —                                                                                    | re-run on pass 2                                                                         |
| E+  | model compaction sent whole messages to the summarizer; one oversized tool result starved the older turns                       | Strong (found while reading E1)                                                      | landed `c5858158` (`MODEL_COMPACTION_MESSAGE_CHARS` clip per message)                    |

## tui — markdown history (user request, 2026-09-15)

`NativeTranscript` committed items with the synchronous
`writeSolidToScrollback`, before opentui's async tree-sitter highlight
concealed `##` and backticks; opencode awaits `ScrollbackSurface.settle()`
first. Landed `629e300c`: surface render, settle, commit, serialized on one
fiber chain with the replay reset. Verified in pane `wZ:p18` on session
`01a0a3c8-9c97-759e-ac97-4edefea5384f`.
