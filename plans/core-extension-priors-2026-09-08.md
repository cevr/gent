# Gent core and extension boundary

Read-only research. Date: 2026-09-08. No implementation or validation commands ran.

Keep one branch actor. Give extensions explicit execution and resource contracts. Remove `core-internal` through small named entrypoints. Do not replace it with another source wildcard. These are design recommendations, not completed changes.

**Revisions**

Gent source was read at `fac992e95224b59b4d2554d67eed9d45dd3b3302`. The branch then reached `bfc03d7577f8941b69d4c59f749f0a4e8069938b`. `git diff --name-only fac992e95224b59b4d2554d67eed9d45dd3b3302 HEAD -- packages apps` was empty. The existing prior-art note uses an older Gent baseline and an older remote Prime pin. Its artifact recommendations must not serve as a current implementation receipt. [G1]

| Source                  | Existing cache pin                         | Remote HEAD checked for this review        |
| ----------------------- | ------------------------------------------ | ------------------------------------------ |
| Prime Agent             | `a3b3e753490d0a6ed180e905200c1a6690d78608` | `f771dfcedd684d1afff84ca2c6fa95c7a21efbc2` |
| pi, `earendil-works/pi` | `9767ba275f3e9a5ee0f5c5342249b629ab1b2282` | `6160683a4a8012f0d1cd30c145df18b4ca6f5176` |

`git ls-remote <official repository> HEAD` supplied each remote pin. The cache stayed unchanged. Selected files from each remote pin were downloaded to `/tmp/gent-extension-prior-sources/`.

**Primary-source findings**

1. pi separates model/tool iteration from coding-session policy. The loop receives context conversion, context transformation, next-turn preparation, stop decisions, and queue readers. It validates tool arguments before the preflight hook. It also has a result hook. Thus the small interface supplies useful insertion points without knowing a coding command or named tool. The cached and current code use this same division. [PI1], [PI2], [PC1]

2. pi does not make resource lifetime disappear. Its guide delays background resource startup until a session or operation needs it. Its reload path awaits shutdown, invalidates the old runner, rebuilds the runtime, and emits session start. The loader removes tracked event subscriptions when it invalidates a runtime. The runner checks context validity. This supports host-owned lifetime and stale-use checks. It does not prove the stronger resource graph semantics that Gent now has. [PI3], [PI4], [PI5]

3. Hook failure rules differ by operation. Current pi chains tool-result changes and reports their failures. A tool-call hook can stop admission. Its exception reaches the loop's tool preparation path. The next-turn stop callback explicitly has a no-throw contract. Do not replace typed operations with one generic event emitter or one catch-and-continue rule. [PI2], [PI6]

4. Prime retains the same broad loop/host division. Its low-level loop receives tool hooks, context conversion, steering, follow-up, and continuation callbacks. The separate RLM host contract owns child creation, completion recording, release, deletion, and disposal. Cached and current Prime both retain this host. A kernel variable or model prompt cannot replace it. [PR1], [PR2], [PC2]

5. Neither project proves that the whole harness fits in one small file. At the current pins, pi's `agent-loop.ts` has 803 physical lines and its coding `agent-session.ts` has 3,554. Prime's corresponding files have 963 and 12,381. These counts include comments and exclude imported services. Prime's session file directly handles goals, compaction, kernel state, and extension binding. Its session design is not a model for Gent's maximum reduction. [PI1], [PI5], [PR1], [PR3]

**Recommended boundary**

| Concern                                                                        | Owner                                              | Reason                                                                                                                                    |
| ------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Branch command ordering, durable admission, interruption, turn completion      | Existing branch actor and runtime                  | This state must remain valid when a model call or extension fails. Keep Encore as the actor owner. [G2], [G3]                             |
| Model iteration, argument validation, admitted tool dispatch, result recording | Loop and host dispatcher                           | These are common execution rules. Call typed extension slots at defined points. [PI1], [PR1], [G3]                                        |
| Code-cell tool selection, prompt shape, evaluator, namespace behavior          | Cell extension                                     | Gent currently selects the literal tool name `cell` inside turn resolution. This is removable product policy. [G4]                        |
| Resource acquisition, replacement, cancellation, finalization                  | Host-owned scopes with extension-supplied services | Resources must close when their actor or publication ends. Runtime state cannot depend on a live kernel binding. [G5], [PI4], [PR2]       |
| Workflow instructions, goals, tool implementations, model provider policy      | Ordinary extensions                                | These can use the same author interface as project extensions. Preserve common host operations underneath them. [G2], [G6]                |
| Child registry and completion receipts                                         | A durable host owner                               | Delegate tool policy can move. Child ownership and recovery still need a stable owner. They need not live in the loop module. [PR2], [G2] |

Gent already has a useful leaf boundary. Tools, requests, and hooks use `provideExtensionLeaf`. It supplies the current extension facade and handles the run context. Preserve that rule. Collapse adjacent plumbing only when one owner can replace it. Do not pass raw runtime services to extensions to reduce the facade code. [G6], [G7]

The cell move needs a real new lifetime. `ResourceScope` currently permits only `process`. The actor directly builds `CellExecution.Branch` and `ModelContextLedger.Branch`. It also wires `cells.cancel` into turn execution. Moving those files leaves the same core coupling in place. [G5], [G8]

Add branch resources only with their actor-owned scope. The actor must build and retain the branch service context. It must release that context on branch retirement. The extension must own cell reset and worker recovery through typed operations. Prove setup, failed setup cleanup, reset, active-call cancellation, branch isolation, actor retirement, and restart recovery. Keep admitted tool identity and operation receipts in the shared dispatcher. This recommendation extends the existing resource model. It does not require arbitrary middleware or another actor around `AgentLoop`. [G3], [G5], [G8]

**Remove `core-internal` without opening all internals**

`core-internal/src` is a symlink to `../core/src`. The package provides a private wildcard lane over the same implementation. Its introduction commit is `3339164c223e4e8bb8795ed1187243b0e5a58b9b`, titled `refactor(core): close public internal exports`. The current guard permits only the extension API on `@gent/core` and enforces the private wildcard lane. Thus the package protects export scope. Removing it alone saves no implementation files. [G9], [G10], [G11]

Use four explicit logical entrypoints. Keep the existing extension API path as an alias during the caller change. pi's current package also uses exact entrypoint keys, including separate session and testing entrypoints. It does not export every source path. [PI7]

| Proposed entrypoint | Allowed surface                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Root extension API  | Extension declarations, typed leaves, hooks, resources, stable IDs, host facade. Retain `./extensions/api` as an alias.              |
| Runtime host        | The small construction/configuration surface used by SDK and server composition. Hide individual storage and runtime Tags.           |
| Protocol            | Transport schemas and client projection types. Reuse the owning schemas. Do not re-export the whole domain directory.                |
| Testing             | The integration harness and deliberate model test controls used by other packages. Core's own tests can use relative source imports. |

Move callers to these owning surfaces before deleting the package and its alias paths. Update the current export guard to check exact exports and extension imports. Do not substitute cross-package relative imports, a new private wildcard, or an all-symbol barrel. A facade is useful only when it reduces what its callers must know. [G7], [G10], [G11], [PI7]

The tradeoff is a wider deliberate host API than today's extension-only package. It is still smaller than a source wildcard. Some tests and apps must change because they currently depend on private structure. That caller work supplies the actual boundary improvement.

Count deleted source, moved source, and new boundary code separately. A code-cell move can make core smaller while leaving total source unchanged. Require total file and line reductions from deleted policy branches, merged owners, and removed forwarding modules. Do not set a whole-core line target from pi's loop file. Do not call a legacy runtime route dead before a caller audit proves it.

**Source receipts**

Local Gent references below use the warm-source paths after delivery. The review read the same source in the kernel-deletions Rift. The source content was unchanged between the two Gent revisions above. External links use immutable revisions.

| Ref | Full local source path and lines                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `/Users/cvr/Developer/personal/gent/plans/kernel-prior-art-2026-09-08.md`, baseline and prior findings                                                                                                                           |
| G2  | `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`, lines 130-172, 185-275, 316-378, 763-879                                                                                                                                   |
| G3  | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`, lines 1-42                                                                                                                             |
| G4  | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-resolve.ts`, lines 39-63, 302-319                                                                                                                       |
| G5  | `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts`, lines 2-14, 28-44, 49-91                                                                                                                              |
| G6  | `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`, lines 200-246; `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host.ts`, lines 27-79                                          |
| G7  | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-effect-membrane.ts`, lines 16-99; `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`, lines 262-282, 540-552 |
| G8  | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`, lines 323-333, 436-447                                                                                                              |
| G9  | `/Users/cvr/Developer/personal/gent/packages/core-internal/src`, symlink value `../core/src`; `/Users/cvr/Developer/personal/gent/packages/core-internal/package.json`, lines 1-20                                               |
| G10 | `/Users/cvr/Developer/personal/gent/packages/core/package.json`, lines 1-17; `/Users/cvr/Developer/personal/gent/tsconfig.json`, lines 131-134                                                                                   |
| G11 | `/Users/cvr/Developer/personal/gent/packages/tooling/src/core-public-exports.ts`, lines 29-95; Git commit `3339164c223e4e8bb8795ed1187243b0e5a58b9b`                                                                             |

| Ref | Full local source path                                                                                                              | Pinned primary source                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PI1 | `/tmp/gent-extension-prior-sources/pi/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/src/agent-loop.ts`                    | [Loop, lines 158-307 and 601-761](https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/src/agent-loop.ts#L158-L307)                                                 |
| PI2 | `/tmp/gent-extension-prior-sources/pi/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/src/types.ts`                         | [Loop contract, lines 178-293](https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/src/types.ts#L178-L293)                                                         |
| PI3 | `/tmp/gent-extension-prior-sources/pi/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/docs/extensions.md`            | [Resource lifetime, lines 220-224 and 516-528](https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/docs/extensions.md#L220-L224)                            |
| PI4 | `/tmp/gent-extension-prior-sources/pi/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/src/core/extensions/loader.ts` | [Context invalidation, lines 181-229](https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/src/core/extensions/loader.ts#L181-L229)                          |
| PI5 | `/tmp/gent-extension-prior-sources/pi/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/src/core/agent-session.ts`     | [Session duties, lines 1-125; reload, lines 2843-2867](https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/src/core/agent-session.ts#L2843-L2867)           |
| PI6 | `/tmp/gent-extension-prior-sources/pi/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/src/core/extensions/runner.ts` | [Hook policies, lines 927-1003; active checks, lines 594-608](https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/src/core/extensions/runner.ts#L927-L1003) |
| PI7 | `/tmp/gent-extension-prior-sources/pi/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/package.json`                         | [Exact exports, lines 8-39](https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/package.json#L8-L39)                                                               |
| PR1 | `/tmp/gent-extension-prior-sources/prime/f771dfcedd684d1afff84ca2c6fa95c7a21efbc2/packages/agent/src/agent-loop.ts`                 | [Loop, lines 304-454; preflight, lines 774-825](https://github.com/primeintellect-ai/prime-agent/blob/f771dfcedd684d1afff84ca2c6fa95c7a21efbc2/packages/agent/src/agent-loop.ts#L304-L454)                       |
| PR2 | `/tmp/gent-extension-prior-sources/prime/f771dfcedd684d1afff84ca2c6fa95c7a21efbc2/packages/coding-agent/src/core/rlm-runtime.ts`    | [Host child ownership, lines 249-320](https://github.com/primeintellect-ai/prime-agent/blob/f771dfcedd684d1afff84ca2c6fa95c7a21efbc2/packages/coding-agent/src/core/rlm-runtime.ts#L249-L320)                    |
| PR3 | `/tmp/gent-extension-prior-sources/prime/f771dfcedd684d1afff84ca2c6fa95c7a21efbc2/packages/coding-agent/src/core/agent-session.ts`  | [Session policy, lines 1155-1295 and 1374-1388](https://github.com/primeintellect-ai/prime-agent/blob/f771dfcedd684d1afff84ca2c6fa95c7a21efbc2/packages/coding-agent/src/core/agent-session.ts#L1155-L1295)      |
| PC1 | `/Users/cvr/.cache/repo/earendil-works/pi/packages/agent/src/agent-loop.ts`                                                         | [Cached pi loop, lines 158-307](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts#L158-L307)                                                   |
| PC2 | `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent/packages/coding-agent/src/core/rlm-runtime.ts`                                | [Cached Prime child host, lines 151-241](https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/rlm-runtime.ts#L151-L241)                 |

Review guidance: `/Users/cvr/Developer/personal/gent/AGENTS.md`; `/Users/cvr/Developer/personal/dotfiles/skills/research/SKILL.md`; `/Users/cvr/Developer/personal/dotfiles/skills/repo/SKILL.md`; `/Users/cvr/Developer/personal/dotfiles/skills/okra/SKILL.md`; `/Users/cvr/Developer/personal/dotfiles/skills/effect/SKILL.md`; `/Users/cvr/Developer/personal/dotfiles/skills/effect/references/PROGRAM_DESIGN.md`; `/Users/cvr/Developer/personal/dotfiles/principles/never-block-on-the-human.md`; `/Users/cvr/Developer/personal/dotfiles/principles/redesign-from-first-principles.md`.
