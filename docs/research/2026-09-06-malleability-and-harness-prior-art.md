# Malleability and harness prior art

Research date: 2026-09-06. Status: source research and bounded FX experiments.
This is not an implementation plan approval or a review of the pending migration.

## Direction

Use FX as the UI/UX standard. Keep Gent's typed, Effect-based runtime.
Study live replacement separately from prompt customization and source self-modification.
Do not treat a plugin loader, a reload command, and a safe live dependency graph as the same feature.

Recommendations below are design proposals. Source observations and executed checks are marked separately.

## Source snapshots

The repo skill refreshed all five repositories with `okra repo fetch --json`.
The findings refer to these snapshots, not to a moving default branch.

| Project          | Commit                                     | Local source root                                     |
| ---------------- | ------------------------------------------ | ----------------------------------------------------- |
| FX               | `e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f` | `/Users/cvr/.cache/repo/vercel-labs/fx`               |
| DeepSeek Harness | `d347e703908d0406b7a7ef80e3a0e594d86b2215` | `/Users/cvr/.cache/repo/deepseek-ai/deepseek-harness` |
| Exo              | `cc4461e2ff27786eab7d122c391db8bb21e663fb` | `/Users/cvr/.cache/repo/exoharness/exo`               |
| OpenCode         | `337fd144d2ba144743368f78d9579a99cce175bd` | `/Users/cvr/.cache/repo/anomalyco/opencode`           |
| Pi               | `9767ba275f3e9a5ee0f5c5342249b629ab1b2282` | `/Users/cvr/.cache/repo/earendil-works/pi`            |

Gent was read from the existing dirty Rift at
`/Users/cvr/Developer/personal/.rifts/gent/deps-malleability`.
Its HEAD is `1786245eef29e0af4121d60a15ec641b58827410`.
The observed Gent source includes uncommitted changes. HEAD alone does not identify it.

## What malleability must mean for Gent

Separate three levels:

1. **Customization:** change instructions, tool selection, models, and UI contributions.
2. **Live composition:** add, replace, or remove a running capability without stale users or leaked resources.
3. **Self-modification:** change the harness implementation itself, then validate and recover it.

These are working definitions for this comparison, not a standard taxonomy.

The [spatiotemporal composability paper, v1](https://arxiv.org/abs/2608.25512v1)
distinguishes reversible component effects from reactive dependency requirements.
Its context discipline mediates both. It does not establish that arbitrary filesystem,
database, or remote-service effects can be undone by closing an Effect scope.

The paper gives the lifecycle model in section 4.2.2 (PDF pages 35–38).
Section 5.1.3 (pages 61–63) describes its implementation. Section 5.2.2
(pages 67–68) covers hot module replacement. Section 7.3 (page 79) describes
clean-slate reload: state that must survive belongs in a longer-lived dependency.
Section 6.3 (page 72) separates language-level access control from a sandbox
for untrusted code. These are important limits on what Gent should promise.
[Paper PDF](https://arxiv.org/pdf/2608.25512v1).

### Gent's current base

Observed source:

- A resource declares a process lifetime, a Layer, and optional start/stop Effects.
  It has no explicit resource ID, revision, or live dependency list in this interface.
- Startup creates an owned scope for each extension with resource lifecycle work.
  Failed startup closes that scope and records a failed extension.
- Extension resolution compiles an immutable capability snapshot.

Thus Gent already has useful cleanup and publication boundaries. A live replacement
protocol still needs an explicit contract. Do not infer that contract from TypeScript's
erased requirement types or from the word `Resource`.

Local evidence:

- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/domain/resource.ts:69`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/extensions/activation.ts:367`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/extensions/registry.ts:367`
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/docs/malleability.md:1`

## DeepSeek Harness: reactive composition, not just plugin discovery

**Observed:** Cordis derives a dependency epoch from the UIDs of the providers that
satisfy a component's requirements. Missing requirements make that epoch inactive.
A changed epoch starts an unload/reload transition. An in-progress transition keeps
ownership until it settles. A stale load checks its epoch before executing plugin
code. Unload runs registered disposers and then decides whether to reload.
[Fiber implementation](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/vendor/cordis/src/fiber.ts#L597-L698).

**Observed:** the loader distinguishes patchable configuration from replacement.
It keeps previous options and attempts structural recovery after a failed change.
Rollback failure is a separate error. This restores runtime structure; it does not
make remote requests or database writes transactional.
[Entry update](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/vendor/loader/src/config/entry.ts#L141-L302),
[group update](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/vendor/loader/src/config/group.ts#L59-L129).

**Recommendation:** take the provider-epoch and serialized lifecycle rules. Keep
Effect as Gent's resource owner. Do not put a second dependency runtime beside
Effect merely to obtain a reload command. A new Effect Context does not update
service values that an existing component already captured. Rebuild the affected
dependent generation, or use an explicit host lookup boundary.

**Policy change to consider:** retain the last valid desired graph for malformed
configuration. For a valid graph whose optional provider is absent, keep only the
affected component inactive with a visible reason. Reactivate it when its required
provider becomes available. Fail startup when a required application root cannot
run. This is a proposal to refine Gent's current reject-missing-requirements plan.
It is not behavior that Gent currently implements.

Local source receipts:

- `/Users/cvr/.cache/repo/deepseek-ai/deepseek-harness/vendor/cordis/src/fiber.ts:597`
- `/Users/cvr/.cache/repo/deepseek-ai/deepseek-harness/vendor/loader/src/config/entry.ts:141`
- `/Users/cvr/.cache/repo/deepseek-ai/deepseek-harness/vendor/loader/src/config/group.ts:59`

## Exo: replace execution while preserving durable control

**Observed:** durable agent/conversation configuration is separate from the executor.
The executor also has process-local configuration caches. A stored configuration
change is therefore not proof that every running executor has applied it.
[Configuration cache](https://github.com/exoharness/exo/blob/cc4461e2ff27786eab7d122c391db8bb21e663fb/crates/executor/src/harness_config.rs#L11-L78),
[executor](https://github.com/exoharness/exo/blob/cc4461e2ff27786eab7d122c391db8bb21e663fb/crates/executor/src/harness_executor.rs#L60-L207).

**Observed:** tool modules use stable IDs and support replacement from local source
or pinned commits. The docs say successful changes become available on the next
model round. Modules run as trusted code in the harness process. Running a shell
command in a sandbox does not sandbox the module that requested it.
[Tool management and trust](https://github.com/exoharness/exo/blob/cc4461e2ff27786eab7d122c391db8bb21e663fb/exoharness/docs/tools.md#L9-L142),
[module staging](https://github.com/exoharness/exo/blob/cc4461e2ff27786eab7d122c391db8bb21e663fb/exoharness/typescript/harness/tool-modules.ts#L101-L297).

**Observed:** scheduler recovery redelivers unconfirmed wakeups after a crash.
The source states an at-least-once delivery contract. A successful external effect
can therefore precede a repeated notification.
[Recovery path](https://github.com/exoharness/exo/blob/cc4461e2ff27786eab7d122c391db8bb21e663fb/crates/executor/src/scheduler_runtime.rs#L46-L121).

**Recommendation:** retain durable desired state and repair control outside a
replaceable execution component. Record both desired and applied revisions. Treat
replay as duplicate-prone at external boundaries. Require stable operation IDs.
Do not copy self-modification as unrestricted host code execution. A source change,
a sandbox snapshot, and restoration of durable agent history are different operations.

**Observed self-rebuild limit:** the tool queues an update and starts a detached
job. The guardian builds before it stops running services. A build failure exits
before restart. This protects the running services, but leaves source edits and
partial build output in place. The detached job can write a side-channel outcome
file even when the CLI cannot append the durable conversation outcome.
This is failure containment, not automatic rollback.
[Rebuild tool](https://github.com/exoharness/exo/blob/cc4461e2ff27786eab7d122c391db8bb21e663fb/exo/tools/guardian-tools.ts#L40-L159),
[deferred job](https://github.com/exoharness/exo/blob/cc4461e2ff27786eab7d122c391db8bb21e663fb/exo/scripts/deferred-rebuild-and-restart#L1-L72),
[build-before-restart control](https://github.com/exoharness/exo/blob/cc4461e2ff27786eab7d122c391db8bb21e663fb/exo/scripts/exo-service-guardian#L488-L521).

Local source receipts:

- `/Users/cvr/.cache/repo/exoharness/exo/crates/executor/src/harness_config.rs:11`
- `/Users/cvr/.cache/repo/exoharness/exo/crates/executor/src/harness_executor.rs:60`
- `/Users/cvr/.cache/repo/exoharness/exo/exoharness/docs/tools.md:9`
- `/Users/cvr/.cache/repo/exoharness/exo/exoharness/typescript/harness/tool-modules.ts:101`
- `/Users/cvr/.cache/repo/exoharness/exo/crates/executor/src/scheduler_runtime.rs:46`
- `/Users/cvr/.cache/repo/exoharness/exo/exo/tools/guardian-tools.ts:40`
- `/Users/cvr/.cache/repo/exoharness/exo/exo/scripts/deferred-rebuild-and-restart:1`
- `/Users/cvr/.cache/repo/exoharness/exo/exo/scripts/exo-service-guardian:103`

## FX: the visual standard and a narrow live-reload reference

### Source findings

**The kernel is smaller than the CLI product.** The JavaScript agent surface exposes
`prompt`, `checkpoint`, and `close`. It rejects concurrent prompts and checkpoints
during an active turn. Closing cancels active work and waits for runtime exit.
The terminal has a separate creation surface. This is a useful separation to retain
in Gent; it is not a reason to embed a second agent loop.
[Implementation](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/sdk/fx-sdk.js#L1424-L1446),
[native/Wasm entry points](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/sdk/node.js#L330-L345).

**A stream is a controlled interface, not an unbounded event log.** The SDK limits
unread events and bytes. It pauses the producer at capacity. One turn has one
consumer. Iterator close cancels the turn. Host tools receive cancellation, but the
host remains responsible for stopping their external work.
[Queue and cancellation](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/sdk/fx-sdk.js#L1530-L1585),
[host tool contract](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/sdk/README.md#L139-L148).

**MCP reload is more instructive than a generic reload flag.** FX reuses healthy
servers with equal configuration. It prepares changed servers before swapping the
published set. A required candidate failure can retain the current set. That fallback
does not apply when authority has been reduced. Retiring owners reject new users,
signal cancellation, and wait for existing users. The wait is not itself proof that
all uncooperative external work stops within a deadline.
[Reconciliation](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/src/core/mcp/mcp_runtime.zig#L686-L827),
[lease and retirement](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/src/core/mcp/mcp_runtime.zig#L375-L427).

**Names are not enough to bind an advertised tool.** The source tests retain a healthy
connection generation across an unchanged reload. A changed server configuration
invalidates the old advertised binding, even when the tool name stays the same.
This is a useful Gent acceptance test for a model turn that outlives a reload.
[Source tests, inspected but not executed in this pass](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/src/core/mcp/mcp_runtime.zig#L8334-L8404).

### UI/UX rules to carry into Gent

These are the proposed standard, not a new Gent implementation.

| Area             | FX evidence                                                                         | Gent rule                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Overall layout   | Live startup uses a small heading, transcript space, composer, and short status row | Default to one transcript column. Do not add a permanent dashboard or side panel.                             |
| Hierarchy        | Neutral palette, brighter selected text, subdued metadata                           | Use weight, spacing, and symbols before adding color.                                                         |
| User turns       | A strong `┃` rail and bold prompt text                                              | Give user input one clear marker. Avoid nested chat cards.                                                    |
| Composer         | Footer row allocation is explicit and tested, including steering banners            | Keep input stable as output, pickers, and activity change.                                                    |
| Menus            | Command, settings, and MCP menus use the same inline region and key hints           | One keyboard model: move, filter or switch category, confirm, close.                                          |
| Tools            | Separate expanded/compact projections and a full transcript surface                 | Make detail available without forcing it into every main transcript row. Do not silently hide failure states. |
| Diffs            | Added/deleted markers carry green/red; line text stays neutral                      | Use color only where it adds semantic information. Preserve signs and line numbers.                           |
| Narrow terminals | The observed command menu truncated descriptions and kept navigation visible        | Clip secondary text first. Keep the active control and escape route visible.                                  |
| Model context    | Display projection and checkpoint context have separate roles                       | Compaction must not rewrite the user's visible conversation.                                                  |

Source evidence:

- [Palette and diff markers](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/src/ui/render.zig#L16-L133).
- [User-turn rail](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/src/ui/assistant/user_message_card.zig#L10-L34).
- [Footer allocation](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/src/ui/render_engine/footer_layout.zig#L3-L108).
- [Tool projection states](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/src/ui/transcript/tool_group_projection.zig#L120-L143).
- [Full transcript source associations](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/src/ui/full_transcript_screen.zig#L38-L64).
- [Documented display/context separation](https://github.com/vercel-labs/fx/blob/e3b6fe0229e7dbddc654e84a6e60498d1bd9a21f/README.md).

A compact target layout:

```text
gent  ·  session

┃ User request

  Assistant response
  Tool activity and short result

────────────────────────────────────────
┃ Draft input
────────────────────────────────────────
model · activity · context       key hints
```

This sketch captures hierarchy only. It does not prescribe a second session state
store, a new renderer, or a second transport.

### Executed FX checks

Built the pinned checkout with Zig 0.16.0. The built binary reported `0.0.8`.
The source commit above is the precise version receipt.

| Check                         | Result                                                                      | Receipt                                                          |
| ----------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Native ReleaseSafe build      | Passed                                                                      | `/tmp/gent-research-fx-build.log`                                |
| Node-API core build           | Passed                                                                      | `/tmp/gent-research-fx-napi-build.log`                           |
| Footer layout tests           | 9 passed                                                                    | `/tmp/gent-research-fx-footer-tests.log`                         |
| CLI help tests                | 13 passed, 112 filtered out                                                 | `/tmp/gent-research-fx-cli-tests.log`                            |
| Default SDK import            | No network or optional adapter activation                                   | `/tmp/gent-research-fx-import.log`                               |
| Output framing                | UTF-8 fragmentation, isolation, order, malformed and bounded records passed | `/tmp/gent-research-fx-output-tests.log`                         |
| Native retry/cancellation     | Bounded retry and both cancellation paths passed                            | `/tmp/gent-research-fx-test-agent-transport-retry.log`           |
| Native pre-fetch cancellation | Stale publication blocked; later prompt recovered                           | `/tmp/gent-research-fx-test-native-core-cancel-before-fetch.log` |
| Live Herdr inspection         | Startup, help, settings, empty MCP browser, clean quit                      | `/tmp/gent-fx-research.cYnDry/`                                  |

The live pane used an empty temporary workspace, no `HOME`, no provider key, disabled
keychain access, host-managed auth, and disabled automatic upgrades. The visible
history-unavailable notice was expected. No login, model request, or MCP server
connection was made. The test pane was closed after a clean FX exit.

Terminal captures:

- `/tmp/gent-fx-research.cYnDry/startup.ansi`
- `/tmp/gent-fx-research.cYnDry/help.ansi`
- `/tmp/gent-fx-research.cYnDry/settings.ansi`
- `/tmp/gent-fx-research.cYnDry/mcp.ansi`

The frame benchmark ran 100 samples at each of 80x24, 120x40, and 200x80.
Combined p95 values were 0.079 ms, 0.037 ms, and 0.423 ms. Its reported 200x80
threshold passed. This is a local synthetic frame result, not terminal input latency,
model speed, or a comparison with Gent. The benchmark excludes terminal writer I/O.

Receipt:
`/tmp/gent-fx-research.cYnDry/render-lab-full/run-2026-09-06T060747-582Z-bench/benchmark.json`.

Limits: the direct standalone theme-module test did not compile because an import
crossed that test invocation's module root. This is not evidence of an FX product
failure. The tmux-driven visual suite was not run because tmux was unavailable.
Live streaming, long-history replay, permission decisions, and provider changes were
not exercised in the Herdr pane. Those remain source observations or later tests.

### FX local source index

- `/Users/cvr/.cache/repo/vercel-labs/fx/README.md`
- `/Users/cvr/.cache/repo/vercel-labs/fx/sdk/README.md`
- `/Users/cvr/.cache/repo/vercel-labs/fx/sdk/node.js:330`
- `/Users/cvr/.cache/repo/vercel-labs/fx/sdk/fx-sdk.js:1424`
- `/Users/cvr/.cache/repo/vercel-labs/fx/sdk/core-output.js`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/core/mcp/mcp_runtime.zig:375`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render.zig:16`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/assistant/user_message_card.zig:10`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/render_engine/footer_layout.zig:3`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/transcript/tool_group_projection.zig:120`
- `/Users/cvr/.cache/repo/vercel-labs/fx/src/ui/full_transcript_screen.zig:38`
- `/Users/cvr/.cache/repo/vercel-labs/fx/tests/e2e/render-lab/index.ts:1290`
- `/Users/cvr/.cache/repo/vercel-labs/fx/tests/e2e/cli.test.ts:315`
- `/Users/cvr/.cache/repo/vercel-labs/fx/sdk/tests/test-default-import.mjs`
- `/Users/cvr/.cache/repo/vercel-labs/fx/sdk/tests/test-core-output.mjs`
- `/Users/cvr/.cache/repo/vercel-labs/fx/sdk/tests/test-agent-transport-retry.mjs`
- `/Users/cvr/.cache/repo/vercel-labs/fx/sdk/tests/test-native-core-cancel-before-fetch.mjs`

## Pi: durable execution and explicit extension invalidation

**Observed:** this Pi snapshot has a durable lane engine. It is not only a small
in-memory prompt loop. The driver reads persisted assistant, tool, deferred,
compaction, retry, and navigation states. A lane serializes session mutations.
It runs providers, tools, hooks, and timers outside that mutation lock.
[Driver](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/drive.ts#L28-L105),
[lane mutation boundary](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/lane.ts#L290-L381).

**Observed:** steering and follow-up input have distinct queues and admission
rules. Steering has priority at the next boundary. Follow-up waits until no
projected trigger remains. The boundary preserves inbox order.
This is a useful product contract: input that changes current work is not the same
as input that starts later work.
[Boundary rules](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/runtime/drive/boundary.ts#L75-L145).

**Observed:** extension loading stages registrations. Invalidation marks old
contexts stale and removes tracked event subscriptions. Session reload emits
shutdown, invalidates the old runner, reloads resources, rebuilds the runtime,
then emits startup. This does not prove that arbitrary extension timers or sockets
are reclaimed. Such resources still need explicit ownership and cleanup.
[Loader invalidation](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/extensions/loader.ts#L149-L245),
[staged registration](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/extensions/loader.ts#L445-L476),
[reload order](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2818-L2843).

**Observed:** Pi gates project resources through project trust. An undecided
headless request does not receive trust. This is not a sandbox for trusted code.
Its shared runtime also does not imply equal UI support: RPC implements only a
subset of extension UI operations. Some custom surfaces are no-ops or defaults.
[Trust decision](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/project-trust.ts#L12-L96),
[RPC UI support](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L136-L311).

**Recommendation:** keep Gent's durable actor. Take Pi's explicit input queues,
stale-context checks, and staged registrations as acceptance-test ideas. State
which surfaces each client supports. Keep canonical tool data separate from its
terminal renderer. Do not add a second durable lane engine or promise that a
terminal-only custom component works over RPC.

Local source receipts:

- `/Users/cvr/.cache/repo/earendil-works/pi/packages/agent/src/harness/runtime/drive.ts:28`
- `/Users/cvr/.cache/repo/earendil-works/pi/packages/agent/src/harness/runtime/lane.ts:290`
- `/Users/cvr/.cache/repo/earendil-works/pi/packages/agent/src/harness/runtime/drive/boundary.ts:75`
- `/Users/cvr/.cache/repo/earendil-works/pi/packages/coding-agent/src/core/extensions/loader.ts:149`
- `/Users/cvr/.cache/repo/earendil-works/pi/packages/coding-agent/src/core/agent-session.ts:2818`
- `/Users/cvr/.cache/repo/earendil-works/pi/packages/coding-agent/src/core/project-trust.ts:12`
- `/Users/cvr/.cache/repo/earendil-works/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:136`

## OpenCode: replay invariants and clear runtime ownership

**Observed:** its durable event store checks aggregate identity, event identity,
sequence, and duplicate replay data. Projection and event writes share a database
transaction. Replay checks a contiguous history from one aggregate. The durable
stream reads stored history and then waits for live changes.
[Commit rules](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/core/src/event.ts#L205-L364),
[replay and stream](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/core/src/event.ts#L441-L604).

**Observed:** provider adapters normalize output into typed runtime events.
The processor tracks tool state. Cleanup waits briefly for outstanding calls,
then writes an interrupted terminal state for unfinished calls. A terminal marker
is useful evidence. It is not proof that an external process stopped.
[Stream adapter](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/llm/ai-sdk.ts#L77-L289),
[tool cleanup](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/processor.ts#L553-L611).

**Observed:** current plugins have ordered hooks and scope-owned disposal.
Instance reload disposes the old context and boots a new one. The V2 plugin
documents propose finer domain rebuilds, but explicitly describe a target plan.
Do not cite that plan as a shipped live-resource protocol.
[Current plugin lifecycle](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/plugin/index.ts#L219-L308),
[instance reload](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/project/instance-store.ts#L108-L145),
[V2 status](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/plugin/src/v2/effect/PLAN.md#L1-L16).

**Observed:** pending permission and question requests use in-memory Deferred
maps. Scope close fails those requests. Those maps are not durable continuations.
Gent already persists pending interactions and can restore them after restart.
Do not replace that contract with a waiting fiber.
[Permission lifecycle](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/permission/index.ts#L42-L167),
[question lifecycle](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/question/index.ts#L37-L112).
Gent's local contract is in
`/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/ARCHITECTURE.md:178`.

**Recommendation:** use replay, normalized-event, interrupted-tool, and bounded
compaction tests to find concrete Gent gaps. Keep branch actors and durable
interactions. Do not import OpenCode's full provider catalog, plugin installer,
or whole-instance reload as defaults. Its bounded recent-tail compaction is
useful prior art, but a summary must not replace Gent's durable history.
[Tail selection](https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/compaction.ts#L115-L163).

Local source receipts:

- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/core/src/event.ts:205`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/llm/ai-sdk.ts:77`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:553`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/plugin/index.ts:219`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/project/instance-store.ts:108`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/v2/effect/PLAN.md:1`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/permission/index.ts:42`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/question/index.ts:37`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/compaction.ts:115`

## Synthesis for Gent

This table gives recommendations, not additional claims about the source projects.

| Source            | Take into Gent                                                                           | Do not infer or copy                                                        |
| ----------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| FX                | Visual hierarchy; stable input region; compact tool summaries; generation-bound tool use | A second kernel; automatic cancellation of external work                    |
| DeepSeek / Cordis | Provider epochs; explicit dependencies; serialized resource transitions                  | Context access as a sandbox; automatic rollback of all effects              |
| Exo               | Durable desired/applied revisions; repair control outside the replaced process           | Source rollback from a successful restart; trusted modules as isolated code |
| Pi                | Stale-context rejection; staged registrations; steering versus follow-up                 | A second execution engine; equal UI support on every client                 |
| OpenCode          | Replay invariants; typed stream boundary; interrupted-tool and compaction tests          | Volatile approval state; full-instance reload for a small resource change   |

### Proposed live-resource contract

Keep the existing `SessionRuntime` and durable branch actor. Add a resource
reconciliation owner only when this protocol is ready to test. Do not wrap the
agent loop in another state machine. A local Effect Machine may own resource
transitions. Existing Encore ownership should retain durable commands and recovery.
These choices follow Gent's current direction in
`/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/docs/malleability.md`.

1. Record a stable resource ID, desired revision, and explicit requirements.
   Keep availability separate from authorization.
2. Validate a pure desired graph. Reject duplicate IDs and cycles without changing
   the active graph. Define missing-provider policy separately.
3. Prepare replacements in owned scopes. Do not allow preparation to publish
   partial registrations. Report non-reversible preparation effects explicitly.
4. Publish one resolved generation. Give each advertised tool an owner generation,
   not only a name. Reject stale bindings instead of routing them to new code.
5. Stop new admission to retiring owners. Drain or cancel active users under a
   stated deadline. Rebuild dependents that captured an old service value.
6. Close retired scopes. Record cleanup failure and any required repair.
   Retain the old generation on failure only if it remains valid and authorized.
7. Persist desired and applied revisions with a stable command ID. After a crash,
   reconcile again without repeating a non-idempotent external effect.

This is a protocol outline, not proof of atomic replacement. Some resources cannot
run two generations at once. Those require stop-before-start and an explicit
unavailable interval. A failed stop must not produce a false success receipt.
Authorization revocation must stop new use immediately; rollback must not restore
revoked authority. Compensation for external work is a separate operation.

### First decision experiments

Run these before a broad implementation. Use real Gent services inside the test
boundary and deterministic model signals where needed.

| Order | Experiment                                    | Required evidence                                                                                                                       |
| ----- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Pure desired-graph planner                    | Deterministic order; duplicate/cycle rejection; explicit missing-provider behavior; unchanged graph is a no-op                          |
| 2     | Replace a provider during a blocked tool call | Old call retains its owner; no new call enters a retired owner; stale advertised binding fails; captured dependents rebuild once        |
| 3     | Fail preparation, stop, and compensation      | No partial catalog publication; cleanup outcome is visible; revoked authority never returns; external writes are not called rolled back |
| 4     | Crash after desired state is stored           | Restart reaches one applied revision; command replay is duplicate-safe; durable pending interactions remain available                   |
| 5     | FX-shaped Gent transcript prototype           | Stable composer at 80x24 and 120x40; streaming does not move input; compact/expanded tool views share identity; failure remains visible |

After these tests, compare Gent's existing event replay and compaction behavior
with the OpenCode and Pi invariants. Do not add a parallel event store just to
match another project's structure.

### Research limits

Only FX was built and exercised. DeepSeek, Exo, OpenCode, and Pi findings come
from pinned source. No paid model request ran. No Gent runtime code changed.
No full migration review ran. No commit or push was made.

The final full Gent gate passed. The first run failed one ACP boundary test.
The isolated file then passed all 24 tests. The full gate also passed on rerun.
No runtime fix was made. This is evidence of an intermittent failure, not a
diagnosis of its cause. Keep it visible for the later implementation review.

Validation receipts:

- `/tmp/gent-malleability-research-gate.log` — first run, one test failure.
- `/tmp/gent-malleability-research-acp-recheck.log` — isolated file, 24 passed.
- `/tmp/gent-malleability-research-gate-recheck.log` — full gate, exit 0.
- `/Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/extensions/tests/acp-agents/acp-agents.test.ts:636` — intermittent assertion site.

The report's format check passed. All local receipt paths exist.
All 42 pinned GitHub source links resolved to local files with
valid cited line bounds. The new-file whitespace check produced no diagnostics.

The FX source and ANSI captures define this pass's UI evidence. They do not prove
accessibility, long-session behavior, or parity with Gent. A later prototype should
test those cases against the FX standard without importing FX's execution engine.

Background source notes, retained as secondary research receipts:

- `/tmp/gent-malleability-deepseek-exo-research.md`
- `/tmp/gent-opencode-research.md`
- `/tmp/gent-pi-research.md`

The consolidated findings and permanent source links are in this document.
Temporary logs and notes can disappear. They are not required to interpret the
recommendations, but they record what this research pass actually inspected.

### Reproduce the bounded FX checks

Use the pinned FX checkout from the source table. These commands do not require
a model request. The two native transport tests inject a local fake transport.

```sh
zig build -Doptimize=ReleaseSafe
zig build libfx-napi -Dnapi-surface=core -Doptimize=ReleaseSafe
zig test src/ui/render_engine/footer_layout.zig
node sdk/tests/test-default-import.mjs
node sdk/tests/test-core-output.mjs
env -u HOME -u AI_GATEWAY_API_KEY -u VERCEL_OIDC_TOKEN node sdk/tests/test-agent-transport-retry.mjs
env -u HOME -u AI_GATEWAY_API_KEY -u VERCEL_OIDC_TOKEN node sdk/tests/test-native-core-cancel-before-fetch.mjs
env -u HOME -u AI_GATEWAY_API_KEY -u VERCEL_OIDC_TOKEN FX_E2E_DISABLE_DOTENV=1 bun test tests/e2e/cli.test.ts -t 'cli: help'
```

The frame benchmark command runs from the FX `tests/e2e` directory. Choose a
new temporary output directory for each research pass.

```sh
env -u HOME -u AI_GATEWAY_API_KEY -u VERCEL_OIDC_TOKEN FX_E2E_DISABLE_DOTENV=1 bun run render-lab -- --scenario buffer-system-frame-bench --runs 100 --sizes 80x24,120x40,200x80 --out /tmp/gent-fx-research.cYnDry/render-lab-full
```
