# Wave 43 plan

## Frame

- **Product direction**: extension authoring is the product loop.
- **Source**: fresh product direction after `plans/WAVE-42-audit-receipt.md`
  closed all current lanes with no P0/P1/P2 findings.
- **Start HEAD**: `2092bfe9` (`docs(plan): close wave 42`).
- **W42 status**: all nine prior lanes are green; W43 is not spillover.
- **North star**: a good extension author can build useful Gent behavior
  quickly without learning core internals, passing host requirements as
  parameters, or guessing which runtime surfaces are stable.
- **Rule**: ship the authoring loop as product. Prefer reference extensions,
  acceptance tests, and clear diagnostics over abstract API polishing.
- **Requirement ownership rule**: handlers receive product input only. Host
  authority is yielded through public facades or extension-owned service Tags.
  Service-owned hidden requirements remain valid when the owning service
  captures and internally provides them.
- **External reference points**:
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:222`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:40`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1084`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:266`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:37`.

## Product Thesis

Gent's extension API should feel like an Effect-native answer to plugin
systems:

- More structured and requirement-honest than opencode's broad async hook bag.
- More actor-native and composable than pi-mono's callback-style registration
  API.
- Low enough ceremony that a useful extension fits in one file, but honest
  enough that real extensions can grow into scoped services, hooks, dynamic
  tools, slash requests, and reference agents without crossing private
  runtime boundaries.

## Lanes

## Progress

### L1/L5 initial batch - complete

- Added `examples/extensions/session-notes.ts` as the one-file authoring
  reference for tool + slash request + state resource + hook.
- Added `packages/core/tests/extensions/authoring-reference.test.ts` to load
  that reference extension from the public authoring API, execute its
  contributed tool/hook under the real resource layer, check the slash request
  through the registry surface, and assert the source imports no Gent
  internals.
- Fixed the public hook bucket path so `defineExtension({ hooks })` is accepted
  by package-shape validation and hook factories erase author E/R at the public
  bucket boundary while runtime invocation still reseals failures.
- Updated `docs/extensions.md` so the guide points authors from the minimal
  greeting tool to the complete one-file product loop.
- Verification:
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/extensions/authoring-reference.test.ts`.
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/extensions/authoring-reference.test.ts packages/core/tests/extensions/define-extension.test.ts packages/core/tests/extensions/extension-reactions.test.ts packages/core/tests/runtime/tool-runner.test.ts`
  passed with 36 tests. `bun run typecheck` and `bun run gate` passed.
- Evidence:
  `/Users/cvr/Developer/personal/gent/examples/extensions/session-notes.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/authoring-reference.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-package-shape.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:36`.

### L2/L3 dynamic reference batch - complete

- Made dynamic registrations session-coherent: session scoped tools/requests
  now shadow process scoped entries for that session, dynamic model tools are
  merged into turn resolution, tool execution prefers dynamic tools over
  static tools with the same id, and slash command listing gives dynamic
  commands the same shadow semantics.
- Added author-facing duplicate diagnostics for same-scope dynamic
  registrations. Authors get a `DynamicRegistrationError` that names the
  dynamic kind, id, and scope and tells them to run the unregister finalizer
  before replacing a capability.
- Added RPC acceptance coverage proving an extension request can yield
  `ExtensionContext`, dynamically register a tool and slash request, refresh
  slash command listing, dispatch the dynamic request, and expose the dynamic
  tool to the next model call.
- Added a guardrail for reference extension examples so they cannot import
  `@gent/core-internal/*`, core source files, shipped extension internals, or
  out-of-tree relative internals.
- Verification:
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/domain/dynamic-extension-registry.test.ts packages/core/tests/server/extension-commands-rpc.test.ts packages/core/tests/runtime/tool-runner.test.ts`
  passed with 32 tests.
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/tooling/tests/platform-duplication-guards.test.ts`
  passed with 34 tests. `bun run typecheck` passed.
- Evidence:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-resolve.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/dynamic-extension-registry.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts`.

### L3 authoring language batch - complete

- Audited the remaining public docs/examples after the dynamic batch and found
  the authoring guide still teaching `reactions.turnProjection` while the
  reference extension and public factory path now use `hooks`.
- Updated examples under `examples/extensions/` to teach `hook.systemPrompt`
  and `hook.turnAfter` instead of direct `reactions:` bags.
- Updated `docs/extensions.md` so `hook` is the named authoring concept,
  prompt/tool-policy derivation points at `hook.turnProjection`, and
  `reactions` is documented as a lower-level compatibility/shipped-extension
  lifecycle bag rather than a second authority model.
- Verification:
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/extensions/authoring-reference.test.ts packages/tooling/tests/platform-duplication-guards.test.ts`
  passed with 37 tests. `bun run typecheck` passed.
- Evidence:
  `/Users/cvr/Developer/personal/gent/docs/extensions.md`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/prompt-rules.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:217`.

### L1 - Authoring Happy Path

Make the first extension experience obvious and runnable.

- **C1**: Add a focused authoring smoke fixture that loads a user/project
  extension through the real loader and proves a one-file tool appears in the
  runtime tool surface.
- **C2**: Add a one-file reference extension that combines one tool, one
  slash request, one state resource, and one hook without touching internals.
- **C3**: Make the docs lead with the runnable happy path and the exact
  verification command for an author.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:12`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:34`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:339`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:1`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/loader.ts`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/hello-tool.ts`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts`.

### L2 - Reference Extensions As API Tests

Turn representative extensions into living acceptance tests for the product
surface.

- **C4**: Promote at least two in-tree examples into test-backed reference
  extensions: one tiny authoring example and one stateful/dynamic example.
- **C5**: Ensure shipped extensions that demonstrate the public API import
  only from `@gent/core/extensions/api` and extension-local modules.
- **C6**: Add a guardrail that reference extensions do not import
  `@gent/core-internal/*`, runtime internals, storage Tags, or app edge
  modules.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/index.ts`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/index.ts`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/tests/core-public-exports.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/src/check-guardrails.ts`.

### L3 - Hooks And Dynamic Registrations

Make hooks and dynamic tools/requests expressive without becoming generic
middleware.

- **C7**: Decide whether `reactions` and `hooks` should remain two authoring
  names or collapse into one public concept. If both remain, document the
  product distinction and enforce it with tests.
- **C8**: Prove dynamic tool and slash request registration refreshes prompt,
  slash list, and dispatch behavior through the same actor/session boundary.
- **C9**: Add author-facing diagnostics for dynamic registration conflicts and
  stale registration cleanup.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:189`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-reactions.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/tool-runner.test.ts`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:222`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:37`.

### L4 - Extension Developer Feedback

When an extension fails, the author should know what to change.

- **C10**: Audit loader/setup/startup/validation errors for field-local,
  path-local, extension-local messages.
- **C11**: Add acceptance coverage for invalid bucket shapes, duplicate
  contributions, failed startup resources, and dynamic registration conflicts.
- **C12**: Ensure `gent doctor` and extension status surfaces expose active,
  failed, and degraded extension state without private implementation names.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:244`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-package-shape.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/extension-commands.ts`,
  `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts`.

### L5 - Public Surface And Packaging

Make extension authoring feel like one stable package, not a monorepo trick.

- **C13**: Verify `@gent/core/extensions/api` exports only author-facing
  primitives and does not leak implementation helpers by convenience.
- **C14**: Add a package-consumer style type test that imports from the public
  path and builds a representative extension outside core internals.
- **C15**: Make loader/discovery docs and examples match the package story:
  user/project/shipped extensions use the same import contract.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:62`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/tests/public-surface.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/tests/core-public-exports.test.ts`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:50`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:77`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:350`.

### L6 - Runtime UX Surfaces

Surface extensions as product objects in the client/runtime, not hidden
registry rows.

- **C16**: Ensure extension health, slash commands, dynamic tools, and prompt
  sections have coherent user-visible state in the TUI/SDK.
- **C17**: Add a TUI or SDK acceptance path that proves an author-visible
  extension contribution is discoverable, invokable, and diagnosable.
- **C18**: Keep app-specific UI extension facets at the app edge; do not push
  TUI concerns into core authoring types.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:36`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/event-hub.ts`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-command-registry.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`.

## Initial Batch

Start with L1 and L5 together:

1. Add the package-consumer reference extension test.
2. Add the one-file reference extension that exercises tool + slash request +
   state + hook.
3. Tighten `docs/extensions.md` around the exact authoring loop.
4. Run focused tests, then `bun run gate`.

## Closing Criteria

- A new authoring acceptance test proves the public API from
  `@gent/core/extensions/api`.
- At least one reference extension demonstrates a realistic one-file workflow.
- Dynamic registration and hook semantics are either unified or explicitly
  differentiated with tests and docs.
- Extension diagnostics are author-local and covered.
- No shipped/reference extension needs private Gent internals for ordinary
  authoring.
- Run a W43 closing audit against the six lanes. If it finds P0/P1, open W44;
  if not, write `plans/WAVE-43-audit-receipt.md` and close W43.
