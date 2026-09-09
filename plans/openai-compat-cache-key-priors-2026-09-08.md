# OpenAI-compatible cache-key serializer

Research date: 2026-09-08. Scope: the dropped `prompt_cache_key` in `@effect/ai-openai-compat`. No package, lock file, patch, or product source was changed.

Use Gent's existing Bun package-patch mechanism for this defect. Add explicit key forwarding to the adapter. Keep the OpenAI API-key route on its current endpoint for this unit. No published upgrade or current upstream fix removes the defect. [R1-R4, G1]

## Versions and source proof

| Source                  | Verified result                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| npm dist-tags           | `rc = 4.0.0-rc.112`; `latest = 4.0.0-beta.107`; `beta = 4.0.0-beta.0`                                   |
| Full npm version list   | Ends at `4.0.0-rc.112`. No newer published RC exists.                                                   |
| Published peer range    | `@effect/ai-openai-compat@4.0.0-rc.112` requires `effect: ^4.0.0-rc.112`.                               |
| Release tag             | `refs/tags/@effect/ai-openai-compat@4.0.0-rc.112` points to `2600f62f4532026928454dcea8d1c48557b3f942`. |
| Current official `main` | `88093b57951a1b597599fe4772ab690b36a95818`. It still has the same defect.                               |
| Installed package       | `4.0.0-rc.112`. The package exports `dist/*.js`, not `src/*.ts`.                                        |

Registry checks used `npm view @effect/ai-openai-compat dist-tags --json`, `versions --json`, and the exact version's `peerDependencies` and `dist` fields. The published tarball SHA-1 is `544946df13378a710c6790d194f5a8a386e7b54d`. [Registry metadata](https://registry.npmjs.org/@effect%2Fai-openai-compat), [release source](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/ai/openai-compat/src/OpenAiLanguageModel.ts#L1545).

The block from `const toChatCompletionsRequest` through `extractCustomRequestProperties` is byte-identical in the release commit, installed source, and current main. Its SHA-256 is `a158196e79b59748bbe73ded78456511bd5cef205a47921931d85af9713102ee`. Its first line is 1545 in the release, 1615 in the installed source, and 1534 on current main. [Current source](https://github.com/Effect-TS/effect/blob/88093b57951a1b597599fe4772ab690b36a95818/packages/ai/openai-compat/src/OpenAiLanguageModel.ts#L1534), [R1, I1].

`okra repo fetch --json Effect-TS/effect` refreshed a clean cache from `145d8e1013220425b8edf34f7011c73f73e1cdcf` to the main revision above. The cache remained clean. No cache with user edits was changed.

## Cause and repair boundary

The high-level config accepts `prompt_cache_key`. Request preparation includes it in a Responses-shaped object. `toChatCompletionsRequest` removes all known Responses properties from its custom-property pass. It then copies selected known fields into a Chat Completions object. It never copies the key. `prompt_cache_retention` has the same omission, but retention policy is outside this repair. [R1, R2, I1]

The lower HTTP client sends the completed payload with `bodyJsonUnsafe` to `/chat/completions`. Its request type has a string index signature. Thus one explicit conditional copy of `payload.prompt_cache_key` is sufficient at this boundary. No schema cast or alternate HTTP transport is required. Preserve absence when the value is `undefined`. The current API accepts a string or null. [R2:177-238, R2:1028-1046, OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create#prompt_cache_key).

Patch both `src/OpenAiLanguageModel.ts` and the exported `dist/OpenAiLanguageModel.js`. A source-only patch has no runtime effect in Gent. Keep the known-property filter. Do not forward every filtered Responses property. Do not use the deprecated `user` field to work around a dropped key. Gent already records package patches in root `patchedDependencies`; its current patch is for OpenTUI. [I1-I3, G1]

Gent also needs to supply the key in the OpenAI API-key configuration. At inspection, `buildOpenAiCompatConfig` did not map `hints.cacheKey`. The OpenAI API-key branch used that builder. Only `buildOpenAiResponsesConfig` mapped the key. Add the mapping in the OpenAI owner. Keep the shared Google/Mistral configuration free of OpenAI-only fields. [G2:23-38, G3:63-78, G3:185-190, G5]

## Alternatives

| Choice                             | Assessment                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact-version package patch        | Smallest complete repair. Preserves the current endpoint, prompt conversion, model selection, and tool behavior. Carry a wire-body regression. Remove the patch after a published upstream release passes that regression.        |
| Published package update           | Not available. The newest RC is already installed. Current main is also unfixed. A GitHub dependency ref would not solve this defect.                                                                                             |
| OpenAI-only native Responses route | Technically possible with the installed `@effect/ai-openai@4.0.0-rc.112`. Its request builder spreads API config directly, and Gent already uses it for OAuth. This is a separate endpoint migration, not a necessary key repair. |

For a later native Responses migration, use the native API client with the API key and the official `/v1/responses` endpoint. Do not apply the Codex OAuth URL/header transform. Keep Google and Mistral on their compatible clients. Retain `store: false` and validate manual history, tool IDs/results, reasoning, image inputs, structured output, and stream usage. Gent's API-key driver currently accepts the base model catalog without the OAuth model filter; a blanket switch has not been shown to preserve every accepted model. Verify endpoint and feature support per model or retain a compatible fallback. [G2, G3, G4, I4, OpenAI migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses).

Current OpenAI guidance also says GPT-6 Astra tool calling requires Responses. That is a separate model-support reason to plan a selective migration. It does not alter the confirmed cache-key defect in Chat Completions. [Official model guidance](https://developers.openai.com/api/docs/guides/latest-model).

## Tests and completion evidence

Upstream compatible-model tests check `vendor_setting` forwarding. Compatible-client tests check `provider_feature` forwarding. Neither exercises the filtered cache key. The native OpenAI test covers cache-key forwarding, but uses a different request path. [R3-R5]

Required regression checks:

1. Capture the actual HTTP JSON from the installed package for both `generateText` and `streamText`. With a configured key, assert the exact key at `/chat/completions`. With no key, assert that the field is absent. The key-only patch must not add Responses-only fields.
2. Through Gent's OpenAI API-key driver, send the same key twice and a different key once. Assert the three request bodies. Keep its API-key auth and endpoint checks. Run the existing OAuth key test and Google/Mistral no-key tests. [G4, G5]
3. Verify tool-call/result conversion and cache-read usage still work. Keep the test at the HTTP boundary so it exercises the exported distribution file. Run the full gate after the package patch and lock update.
4. A live cache hit is useful measurement. It is not required to prove this serializer fix: routing keys do not guarantee a provider cache hit. The wire-body assertion is the direct proof.

This research compared source bytes and inspected tests. It ran no product test and made no model request. No fix was implemented.

## Full local source receipts

| ID  | File                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `/Users/cvr/.cache/repo/effect-ts/effect/packages/ai/openai-compat/src/OpenAiLanguageModel.ts`                                                             |
| R2  | `/Users/cvr/.cache/repo/effect-ts/effect/packages/ai/openai-compat/src/OpenAiClient.ts`                                                                    |
| R3  | `/Users/cvr/.cache/repo/effect-ts/effect/packages/ai/openai-compat/test/OpenAiLanguageModel.test.ts`                                                       |
| R4  | `/Users/cvr/.cache/repo/effect-ts/effect/packages/ai/openai-compat/test/OpenAiClient.test.ts`                                                              |
| R5  | `/Users/cvr/.cache/repo/effect-ts/effect/packages/ai/openai/test/OpenAiLanguageModel.test.ts`                                                              |
| I1  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/node_modules/@effect/ai-openai-compat/src/OpenAiLanguageModel.ts`  |
| I2  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/node_modules/@effect/ai-openai-compat/dist/OpenAiLanguageModel.js` |
| I3  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/node_modules/@effect/ai-openai-compat/package.json`                |
| I4  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/node_modules/@effect/ai-openai/src/OpenAiLanguageModel.ts`         |
| G1  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/package.json`                                                                          |
| G2  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/openai-compatible-driver.ts`                                   |
| G3  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/src/openai/index.ts`                                               |
| G4  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/tests/openai/openai-extension-driver.test.ts`                      |
| G5  | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction/packages/extensions/tests/openai-compatible-providers.test.ts`                         |

Pinned tests: [compatible model](https://github.com/Effect-TS/effect/blob/88093b57951a1b597599fe4772ab690b36a95818/packages/ai/openai-compat/test/OpenAiLanguageModel.test.ts#L160), [compatible client](https://github.com/Effect-TS/effect/blob/88093b57951a1b597599fe4772ab690b36a95818/packages/ai/openai-compat/test/OpenAiClient.test.ts#L38), and [native OpenAI](https://github.com/Effect-TS/effect/blob/88093b57951a1b597599fe4772ab690b36a95818/packages/ai/openai/test/OpenAiLanguageModel.test.ts#L34).
