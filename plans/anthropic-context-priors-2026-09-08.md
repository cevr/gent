# Anthropic context updates: source evidence

Checked on 2026-09-08. Scope: the `@effect/ai-anthropic` serializer for later system messages. This note does not implement the repair.

## Verified defect and release state

Effect still replaces the top-level system blocks each time `prepareMessages` sees a system group. Only the last system group survives. The earlier system text disappears. The later text moves ahead of all conversation history. Adjacent system messages form one group; a user, assistant, or tool message separates groups. [R1:834, R1:2821; pinned current source](https://github.com/Effect-TS/effect/blob/88093b57951a1b597599fe4772ab690b36a95818/packages/ai/anthropic/src/AnthropicLanguageModel.ts#L834).

The verified remote `main` revision is `88093b57951a1b597599fe4772ab690b36a95818`. The release tag `@effect/ai-anthropic@4.0.0-rc.112` points to `2600f62f4532026928454dcea8d1c48557b3f942`. The function prefix through the system case is identical in those revisions. Its SHA-256 is `638414b47eaa5b9ea7937dce5dee8d0095b65119cb456331c82498d5867c34f5`. [Pinned release source](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/ai/anthropic/src/AnthropicLanguageModel.ts#L832).

The npm registry lists RCs 108 through 112. There is no newer published RC. The `rc` tag is `4.0.0-rc.112`; `latest` is the Effect 3 package `0.27.0`. The installed package is RC 112 and requires `effect: ^4.0.0-rc.112`. A published version update cannot fix this defect today. The source cache is clean. [I3; npm registry](https://registry.npmjs.org/@effect%2fai-anthropic).

The installed files already contain the parent's repair. They are not evidence of the original defect. The recorded patch changes both TypeScript source and exported JavaScript. Gent imports the JavaScript distribution. [I1-I3, P1]

## Small repair and its limits

Keep the top-level system blocks only when the system group has index zero. Emit later groups as user text at their original position. Wrap each message in `<host-context-update>` tags. Escape `&`, then `<`, then `>`. Copy each message's existing `cache_control` to its text block. This retains the initial prompt and earlier message bytes. Checking the group index also prevents a later system message from becoming top-level when no initial system exists. [I1:919, I2:263, P1]

Anthropic accepts consecutive user rows and combines them into one turn. A separate update row after an ordinary user row is valid. Text blocks accept `cache_control`. [Messages API](https://platform.claude.com/docs/en/api/messages/create).

The wrapper has user authority. Tags and escaping do not restore operator authority or prove the source of the text. Conflicting system instructions still take priority. Keep standing constraints in the initial system prompt or enforce them in the host. Treat this fallback as chronological context. [Authority rules](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages).

### Tool placement

Client tool results must immediately follow the assistant tool-use turn. All result blocks must precede text in the resulting user turn. An unresolved server tool imposes a further limit: the user turn must contain only client tool results. Consecutive user rows do not remove these rules. [Tool-result rules](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).

Here `S` means system context, `U` user text, `A` assistant tool calls, and `T` tool results. These are serializer assessments, not live API test results.

| Input order                     | Assessment                                                               |
| ------------------------------- | ------------------------------------------------------------------------ |
| `S0, S1, U`                     | Both initial blocks remain in top-level system, in order.                |
| `U, A, T, S1`                   | No initial system exists. The update remains a later user row.           |
| `S0, U, A, T-all, S1`           | Valid placement for completed client tools. Results precede update text. |
| `S0, U, A, S1, T`               | Invalid placement. The update precedes the required results.             |
| `S0, U, A-multiple, T1, S1, T2` | Invalid placement. The update splits one tool round's results.           |

The smallest Gent invariant is to append host updates only after all results in the current client-tool round. Preserve call IDs, results, and their order. The proposed patch does not repair malformed tool history. Do not silently move an update across tool results to hide a caller error. The current grouping code merges adjacent user/tool messages but keeps their block order. [R1:954, R1:2821, P1]

### Cache and model limits

Copying cache markers preserves caller intent. It does not guarantee a cache hit. Anthropic permits four breakpoints per request and requires a model-specific minimum prefix length. Historical updates must retain their bytes on replay. Do not accumulate a permanent marker on every update. [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Ordinary user text can change thinking-cache behavior. All Haiku models and earlier Opus/Sonnet models strip prior thinking when non-tool-result user content arrives. Opus 4.5+ and Sonnet 4.6+ retain thinking by default. The fallback can therefore preserve the request prefix while the provider still invalidates part of its cache. [Thinking and caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#caching-with-thinking-blocks).

Native mid-conversation system messages now exist on selected models: Fable 5/5.1, Mythos 5/5.1, Opus 4.8, and Opus 5. The feature needs no beta header. Sonnet 5 does not support it. The general API page still contains stale prose that says no system role exists, although its role schema includes system. Use the dedicated feature guide for capability and placement rules. Effect's current generated schema still allows only user and assistant roles. Native support requires separate model-aware adapter work. [R2:8463; dedicated guide](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages), [API reference](https://platform.claude.com/docs/en/api/messages/create).

## Validation required

The parent has added a real HTTP-body capture test in Gent. It checks API-key and OAuth paths for text, object, and streaming requests. It compares the initial system and prior message prefix. It checks escaping, the cache marker, a completed cell call/result, and absent initial system text. The test uses fake HTTP responses. It does not prove Anthropic acceptance or model obedience. Both auth paths use the same Effect language model. [G1:92, G2:166]

Before the next cache unit, retain these checks:

1. Check multiple initial and later system blocks. Check absent cache markers and cache TTL preservation.
2. Check one tool round with multiple results. Assert that updates follow every result. Reject or exclude updates between a call and its results at the producing boundary.
3. Check identical serialized history after restart and fork. Check that compaction starts a new baseline without replaying old updates twice.
4. Exercise the exported distribution through Gent. Run the full gate after patch and lock changes. Measure live cache usage separately from serializer correctness.

Upstream tests cover plain string tool results. They do not cover later system groups. This research inspected source and tests. It ran no product test and made no model request. [R3:491]

## Full local source receipts

| ID  | File                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `/Users/cvr/.cache/repo/effect-ts/effect/packages/ai/anthropic/src/AnthropicLanguageModel.ts`                                                             |
| R2  | `/Users/cvr/.cache/repo/effect-ts/effect/packages/ai/anthropic/src/Generated.ts`                                                                          |
| R3  | `/Users/cvr/.cache/repo/effect-ts/effect/packages/ai/anthropic/test/AnthropicLanguageModel.test.ts`                                                       |
| I1  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/node_modules/@effect/ai-anthropic/src/AnthropicLanguageModel.ts`  |
| I2  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/node_modules/@effect/ai-anthropic/dist/AnthropicLanguageModel.js` |
| I3  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/node_modules/@effect/ai-anthropic/package.json`                   |
| P1  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/patches/@effect%2Fai-anthropic@4.0.0-rc.112.patch`                                    |
| G1  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/anthropic/index.ts`                                           |
| G2  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/tests/anthropic/anthropic-extension-driver.test.ts`               |

Pinned sources: [generated roles](https://github.com/Effect-TS/effect/blob/88093b57951a1b597599fe4772ab690b36a95818/packages/ai/anthropic/src/Generated.ts#L8463), [tool-result test](https://github.com/Effect-TS/effect/blob/88093b57951a1b597599fe4772ab690b36a95818/packages/ai/anthropic/test/AnthropicLanguageModel.test.ts#L491).
