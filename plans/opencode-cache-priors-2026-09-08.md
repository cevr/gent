# OpenCode v2 prompt cache research

Research date: 2026-09-08. This note records source findings and proposed Gent work. It does not claim measured Gent cache savings.

## Source revision

- Official repository: [anomalyco/opencode](https://github.com/anomalyco/opencode).
- Remote ref: `refs/heads/v2`.
- Verified commit: `08e28fb915d7a4d64add09150fc4ee7d63a796ef`.
- Commit subject: `refactor(codemode): name the data boundary and prepare tools once (#48021)`.
- Commit date reported by Git: `2026-09-08 21:35:36 -0500`.
- `git ls-remote --heads https://github.com/anomalyco/opencode.git v2` returned this commit twice during research.
- `okra repo fetch --json anomalyco/opencode@v2` failed with Git exit 128. The shared cache already contained a clean `dev` checkout at `/Users/cvr/.cache/repo/anomalyco/opencode`. Native `git fetch origin v2` succeeded. A Git archive of the exact commit supplied `/tmp/gent-opencode-v2-08e28fb915d7a`. The `dev` checkout stayed unchanged.
- Gent source root: `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction`. Gent HEAD during research: `d3b672149c78252f4fd2af3f8b960eaf9bfb104c`. The parent agent has concurrent, uncommitted cache-counter work.

## Findings to adopt

### 1. Keep the outer code tool constant

OpenCode gives `execute` an invariant description and input schema. It delivers the changing host catalog through its instruction system. Direct tools are sorted by name. `execute` follows them. Gent can retain its single `cell` tool and apply the same separation. OpenCode itself can expose direct tools, so its full tool surface is not Gent's target.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/codemode/tool.ts:60-78` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/codemode/tool.ts#L60-L78).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/tool.ts:220-248` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/tool.ts#L220-L248).

The catalog sorts namespaces and tool paths. Its changed renderer emits additions, replacements, or removals. It uses a full replacement when that is shorter or when a partial catalog changes shape. Registration order alone must not create a context change. Gent does not need OpenCode's catalog budget or search interface to get this cache benefit.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/codemode/catalog.ts:54-77` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/codemode/catalog.ts#L54-L77).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/codemode/instructions.ts:34-142` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/codemode/instructions.ts#L34-L142).

### 2. Save a baseline and append context changes

OpenCode combines ordered, keyed instruction sources. Each source has a typed JSON codec, a read operation, and initial/change/removal renderers. It hashes canonical JSON. An equal value produces no delta. A temporary read failure retains the saved value. An explicit removal differs from a missing source or JSON `null`.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/instructions/index.ts:27-56,142-191,243-250` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/instructions/index.ts#L27-L56).

The built-in date source reads the host's local calendar day with `DateTime.nowAsDate` and `toDateString()`. It renders the first date separately from a later date change. The runner reads sources at each model-step boundary. It commits an update only when values change. It saves the rendered update text in the durable event. The projected message has type `system` and stays at that history position. The initial instruction values stay unchanged until a new context epoch.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/instructions/builtins.ts:47-54` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/instructions/builtins.ts#L47-L54).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/runner/llm.ts:191-208` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/runner/llm.ts#L191-L208).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/instruction-state.ts:38-60,89-117,164-174` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/instruction-state.ts#L38-L60).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/message-updater.ts:129-140` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/message-updater.ts#L129-L140).

The request order is the agent system block, the saved instruction baseline block, then chronological history. Source order within the baseline is built-ins, code catalog, discovered instructions, skills, references, MCP instructions, and API context entries. Initial values are saved; initial text is rendered with the current source renderer. A source-code or renderer change can therefore still change baseline bytes.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/model-request.ts:89-108` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/model-request.ts#L89-L108).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/context.ts:130-173` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/context.ts#L130-L173).

### 3. Keep old calls and results unchanged

Stable definitions and stable history are separate requirements. OpenCode reuses each saved call's ID, name, and input. It uses the same ID for the result. Provider-bound metadata is reused only when compatible with the destination model. New calls still need new IDs. Never rename or renumber old calls to make a new request look uniform.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/runner/to-llm-message.ts:104-199` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/runner/to-llm-message.ts#L104-L199).

OpenCode normalizes missing/empty tool results at the provider boundary. Its normalizer keeps valid history unchanged. Mistral needs deterministic ID conversion for invalid IDs. This is a protocol exception, not a reason to change stored call IDs. Image removal, model switches, history repairs, plugin request hooks, and compaction can still change a request prefix.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/tool-history.ts:6-83` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/tool-history.ts#L6-L83).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/protocols/mistral-chat.ts:235-251` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/protocols/mistral-chat.ts#L235-L251).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/model-request.ts:127-197,299-347` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/model-request.ts#L299-L347).

### 4. Place cache boundaries at reusable parts

OpenCode's default policy marks the last tool, the first system block, the last distinct system block, and the final message. A message with only tool results can receive the final marker. Manual hints consume the same four-marker budget. Tool hints take priority, then system hints, then message hints. The Anthropic adapter caps emitted markers and reports dropped markers.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/cache-policy.ts:5-12,53-110,143-157` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/cache-policy.ts#L143-L157).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/protocols/anthropic-messages.ts:490-506,1110-1139` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/protocols/anthropic-messages.ts#L1110-L1139).

OpenCode retains definitions on the final allowed model step. It sets `toolChoice` to `none`. Its runtime also rejects forbidden execution. Bedrock Converse has no native `none`; OpenCode retains definitions and omits that choice. Keeping the schema alone does not enforce execution policy.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/runner/llm.ts:221-241` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/runner/llm.ts#L221-L241).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/runner/step.ts:82-93` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/runner/step.ts#L82-L93).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/protocols/bedrock-converse.ts:428-439` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/protocols/bedrock-converse.ts#L428-L439).

OpenCode supplies a stable session cache key. A fork uses its immediate source session's key. A TODO states that nested fork lineage is not yet durable. This is useful prior work, not complete fork-cache reuse.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/model-request.ts:217-218,339-340` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/model-request.ts#L339-L340).

### 5. Make compaction an explicit baseline boundary

Successful compaction advances the instruction epoch. It copies current instruction values into the new baseline. History then starts at the selected checkpoint. Provider-context recovery filters superseded system updates. A new baseline can change the prefix. Do not promise cache continuity across compaction.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/instruction-state.ts:139-153` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/instruction-state.ts#L139-L153).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/projector.ts:691-696` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/projector.ts#L691-L696).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/history.ts:78-107` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/history.ts#L78-L107).

## Provider checks and discrepancies

Anthropic caches prefixes in tool, system, then message order. A change invalidates the following prefix. It supports at most four explicit markers. Its 20-block lookup finds earlier cache writes; it does not create a cache entry for an unmarked stable prefix. Put a marker at the stable boundary. Check read/write token counts. [Official Anthropic cache documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Native chronological system messages have model and placement limits. They cannot split a local call from its result. Current docs explicitly exclude Claude Sonnet 5. OpenCode's family regex and test include Sonnet 5, so do not copy that heuristic. Use an explicit provider capability. A fallback must retain temporal position and identify its lower authority. [Official Anthropic system-message documentation](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages).

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/protocols/anthropic-messages.ts:810-892` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/protocols/anthropic-messages.ts#L810-L892).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/test/provider/anthropic-messages.test.ts:198-221` — [pinned test](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/test/provider/anthropic-messages.test.ts#L198-L221).

OpenCode lowers chronological system messages to in-order `developer` messages on Responses. Its opaque AI SDK path uses escaped `<system-update>` user text. Chat, Gemini, and Bedrock also use the wrapped-user path. Provider code owns this distinction. Untrusted tool output must remain tool output.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/protocols/open-responses.ts:613-622` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/protocols/open-responses.ts#L613-L622).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/protocols/shared.ts:125-160` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/protocols/shared.ts#L125-L160).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/aisdk.ts:462-478` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/aisdk.ts#L462-L478).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/protocols/openai-chat.ts:532-574` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/protocols/openai-chat.ts#L532-L574).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/protocols/gemini.ts:325` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/protocols/gemini.ts#L325).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/protocols/bedrock-converse.ts:331` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/protocols/bedrock-converse.ts#L331).

OpenCode skips automatic inline hints on OpenAI and Gemini. It also leaves OpenRouter's default policy alone. This OpenAI rule is incomplete for current models. GPT-5.6 and later support explicit `prompt_cache_breakpoint`, `prompt_cache_options.mode`, `30m` TTL, and `cache_write_tokens`. A stable cache key influences routing but does not guarantee a hit. Current guidance also recommends explicit tool-result boundaries for forks. Keep provider policy versioned by actual capability. Do not apply the Anthropic marker cap to OpenAI. [Official OpenAI cache documentation](https://developers.openai.com/api/docs/guides/prompt-caching).

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/cache-policy.ts:36-44,143-146` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/cache-policy.ts#L36-L44).

## Gent's current path

| Current behavior                                                                                                                                                                        | Full local receipt                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The profile captures a UTC date when it builds. It does not refresh that date per turn. A long-lived profile can show yesterday's date. A rebuilt profile can change the system prefix. | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/profile.ts:225-239`                                                                                                                      |
| The environment section includes the date at priority 60. Project instructions follow at priority 70. A date change affects the prefix before project instructions and history.         | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/prompt.ts:29-33,61-98`                                                                                                                    |
| The native model gets only `cell` when that tool is active. Policy-selected host tools remain inside the cell.                                                                          | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/turn-resolve.ts:50-61`                                                                                                             |
| The sorted host catalog is rebuilt in the system prompt each turn at priority 43. A catalog change changes the prefix.                                                                  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/agent-loop.utils.ts:83-102`                                                                                                        |
| Final extension system-prompt hooks run after section compilation. A new baseline design must include this existing contract.                                                           | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/runtime/agent/turn-resolve.ts:308-331`                                                                                                           |
| Transcript conversion preserves chronological system rows as `Prompt.systemMessage`. The provider adapter decides their actual position.                                                | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/providers/ai-transcript.ts:29-36,119-157`                                                                                                        |
| The Codex transformer lifts every system/developer input item into top-level instructions. A late system row would change the prompt start.                                             | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/openai/codex-transform.ts:99-152,174-208`                                                                                                  |
| Installed Effect Anthropic groups chronological system rows. Each group overwrites the same top-level `system` variable. A late system row can replace the initial system prompt.       | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/.bun/@effect+ai-anthropic@4.0.0-rc.112+11eac7cfbf53fc55/node_modules/@effect/ai-anthropic/src/AnthropicLanguageModel.ts:918-935,2886-2918`            |
| Installed Effect Anthropic accepts system/user/tool-result cache hints. It computes but discards assistant cache hints.                                                                 | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/.bun/@effect+ai-anthropic@4.0.0-rc.112+11eac7cfbf53fc55/node_modules/@effect/ai-anthropic/src/AnthropicLanguageModel.ts:929-961,1024-1048,1081-1086`  |
| Installed Effect Responses preserves system-message position before the Gent Codex rewrite. It already has a `prompt_cache_breakpoint` path.                                            | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/node_modules/.bun/@effect+ai-openai@4.0.0-rc.112+11eac7cfbf53fc55/node_modules/@effect/ai-openai/src/OpenAiLanguageModel.ts:929-940,3037`                          |
| The parent agent's current edits preserve optional cache-read and cache-write counts. Inclusive input totals stay unchanged.                                                            | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/response-to-prompt.ts:8-31`; `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/core/src/domain/event.ts:34-40` |

## Ranked adoption sequence

These are design recommendations from the source trace. They are not implemented by this research note.

1. Keep the provider counts and capture two successive serialized requests. Compare the longest identical prefix. Exclude transport-only request IDs from that comparison. Retain the wire bodies for a focused regression test. A local count of equal characters is a structural check, not a paid-token saving.
2. Add one generic branch-owned context admission step at prompt assembly. Feed it ordered, keyed context from the existing projection and section pipeline. Save the initial rendered baseline and the current values. Append a saved change message only when a value changes. Commit the change and its admitted state together. Date and host catalog must use this same mechanism. Keep calendar rules and catalog descriptions in their owning contributions. Do not add model tools or a second prompt registry for them.
3. Add provider-owned lowering for chronological context before enabling step 2 in production. Preserve the initial system prompt. Preserve each update's history position. Use native authority only on supported routes. Keep an escaped user-context fallback explicit. Verify Codex OAuth, Anthropic API key, and Anthropic OAuth wire bodies. A core-only message test cannot detect either current adapter failure.
4. Keep the `cell` name, description, and schema stable. Deliver catalog changes through admitted context. Keep old call IDs, inputs, results, and compatible metadata stable. Put capability-specific cache hints at static and history boundaries. Retain tool definitions when generation disallows calls, while enforcing execution denial in the runtime. Select a stable cache key from durable session or fork lineage. Do not replace stable keys with random per-request values.
5. Verify restart, fork, compaction, and provider-switch behavior before claiming savings. Then compare a real unchanged-prefix request with its continuation. Report provider, model, input total, cache read, cache write, and latency. Use the full Gent gate between code units. Do not convert a cache miss into a correctness failure; eviction and minimum lengths can cause misses.

The smallest useful core abstraction is durable context admission. It owns identity, order, saved baseline bytes, change detection, and history placement. Extension code owns content. Provider code owns serialization and cache hints. The existing `turnProjection` and final system-prompt hook must reach that single assembly point. A date-only state flag would not handle catalogs, live extension changes, restart, or compaction.

## Required invariants and tests

| Case                                    | Required result                                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same day, same catalog                  | No context event. Identical tool definitions and baseline bytes. Previous request history is an exact prefix.                                                           |
| Date rollover during a tool loop        | One date update after completed tool results. Earlier messages and baseline remain unchanged. Specify the date time zone.                                               |
| Duplicate retry or concurrent admission | One durable update. No skipped change after a failed admission. No duplicate update after retry.                                                                        |
| Catalog registration reorder            | No update. Stable descriptions and schemas.                                                                                                                             |
| Catalog add, change, remove             | One explicit change message. Actual dispatch policy uses the same selected catalog. The outer `cell` definition stays unchanged.                                        |
| Restart or profile rebuild              | Reuse saved baseline and update text. Do not regenerate historical dates or call IDs. An unavailable source retains the admitted value.                                 |
| Fork and nested fork                    | Define the baseline at the fork boundary. Keep copied history unchanged. Save cache-key lineage. Check that newer state cannot be overridden by an older copied update. |
| Compaction success                      | Establish one new baseline from current values. Remove superseded deltas from the model view. Keep authoritative context outside a lossy summary.                       |
| Compaction failure                      | Retain the previous baseline, history, and admitted values.                                                                                                             |
| Provider or model switch                | Preserve meaning and temporal order. Drop only incompatible provider metadata. Do not send unsupported system roles or cache parameters.                                |
| Cache-marker budget                     | Count actual serialized markers, including provider transforms and caller hints. A tool-result-only tail receives a valid marker where supported.                       |
| Final allowed step                      | Keep the tool definition. Deny execution through runtime policy.                                                                                                        |
| Cache usage                             | Preserve missing counts as missing. Keep zero as zero. Input total already includes cached tokens. Do not count cache reads twice.                                      |

OpenCode has relevant tests. They were read, not run in this research task. Recorded-provider tests include saved responses; this task did not refresh them.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/test/instructions/builtins.test.ts:39-83` — day rollover and same-day no-op. [Pinned test](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/test/instructions/builtins.test.ts#L39-L83).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/test/instruction-state.test.ts:137-252,354-446` — saved changes, no-op admission, chronological rows, and unavailable sources. [Pinned test](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/test/instruction-state.test.ts#L137-L252).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/test/codemode/instructions.test.ts:46-120` — catalog deltas and stable registration order. [Pinned test](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/test/codemode/instructions.test.ts#L46-L120).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/test/session-runner.test.ts:1529-1549,1626-1674,4724-4749` — fork values, identical request prefixes, durable updates, and final-step definitions. The fork test explicitly seeds newest values while retaining an older chronological update. Gent must choose and test its own consistent fork semantics. [Pinned tests](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/test/session-runner.test.ts#L1626-L1674).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/test/cache-policy.test.ts:52-176,218-309` — serialized markers, provider selection, deduplication, and cap. [Pinned test](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/test/cache-policy.test.ts#L52-L176).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/test/provider/anthropic-messages-cache.recorded.test.ts:73-108` — second-request cache read and a long tool conversation. [Pinned test](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/test/provider/anthropic-messages-cache.recorded.test.ts#L73-L108).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/test/provider/openai-responses-cache.recorded.test.ts:37-44` — second-request cached tokens on `gpt-4.1-mini`. This does not validate current GPT-5.6 cache policy. [Pinned test](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/test/provider/openai-responses-cache.recorded.test.ts#L37-L44).

OpenCode's usage adapter distinguishes uncached input, cache reads, and cache writes. Its AI layer uses an inclusive input total. Gent's optional read/write counters can support cache measurement without changing the meaning of its existing input total.

- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/core/src/session/usage.ts:11-18` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/core/src/session/usage.ts#L11-L18).
- `/tmp/gent-opencode-v2-08e28fb915d7a/packages/ai/src/protocols/anthropic-messages.ts:1194-1221` — [pinned source](https://github.com/anomalyco/opencode/blob/08e28fb915d7a4d64add09150fc4ee7d63a796ef/packages/ai/src/protocols/anthropic-messages.ts#L1194-L1221).
