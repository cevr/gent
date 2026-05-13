# Wave 44 plan

## Frame

- **Product direction**: extension authoring is the product loop, now with no
  compatibility lifecycle bucket.
- **Source**: W43 closed the hooks-only rearchitecture with no P0/P1 findings.
- **Start HEAD**: `8e719c07` (`docs(plan): close wave 43 without compatibility`).
- **W43 status**: closed; no W44 was opened by the W43 audit itself.
- **North star**: a good extension author can build useful Gent behavior
  quickly without learning core internals, passing host requirements as
  parameters, or guessing which runtime surfaces are stable.
- **Rule**: dogfood the public extension API through real extension-building
  pressure. Improve the product surface where real authoring feels ceremonial,
  leaky, or under-diagnosed.
- **Requirement ownership rule**: handlers receive product input only. Host
  authority is yielded through public facades or extension-owned service Tags.
  Service-owned hidden requirements remain valid when the owning service
  captures and internally provides them.
- **Design rule**: redesign from first principles. Do not keep compatibility
  shims or migration-shaped names for existing extensions.
- **External reference points**:
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:222`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:40`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1084`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:266`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:37`.

## Product Thesis

W44 tests whether the hooks-only API is enough to build real extension
products, not just pass API shape tests.

The API should feel:

- **Expressive**: tools, requests, hooks, resources, agents, and dynamic
  registrations combine without private imports.
- **Composable**: extension-owned services hide their requirements internally,
  while runtime authority comes from public `ExtensionContext` facets.
- **Simple**: the first working version should be small; advanced behavior
  should grow by adding explicit leaves, not by learning runtime plumbing.
- **Actor-native**: extension behavior crosses runtime boundaries through
  declared capabilities and hooks, not local callback substrates or hidden
  side channels.

## Lanes

## Progress

### L1/L6 dynamic dogfood batch - complete

- Added `examples/extensions/dynamic-scratchpad.ts` as the stateful/dynamic
  reference extension. It uses only `@gent/core/extensions/api`, owns
  process-scoped state with `defineStateResource`, exposes one installer slash
  request, and registers a session-scoped tool plus slash request through
  `ExtensionContext.Dynamic`.
- Added public-import coverage for the dynamic example to
  `packages/core/tests/extensions/authoring-reference.test.ts`.
- Added an RPC acceptance path proving the dynamic example updates slash
  commands, exposes the dynamic tool to the model, runs that tool through a
  real model turn, and lets the dynamic request read the same extension-owned
  state afterward.
- Updated `docs/extensions.md` so dynamic capabilities are taught as part of
  the authoring product loop instead of only appearing in internal tests.
- Dogfood finding: dynamic registration originally required authors to thread
  their own `extensionId` into
  `ExtensionContext.Dynamic.registerTool/registerRequest`. The L2 ceremony batch
  below removed that authoring cost.
- Verification:
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/extensions/authoring-reference.test.ts packages/core/tests/server/extension-commands-rpc.test.ts -t "dynamic reference|reference dynamic|RPC dynamic|dynamic registrations"`
  passed with 3 tests. `bun run typecheck` passed.
- Evidence:
  `/Users/cvr/Developer/personal/gent/examples/extensions/dynamic-scratchpad.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/authoring-reference.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md`.

### L2 dynamic ownership ceremony batch - complete

- Changed `ExtensionContext.Dynamic.registerTool/registerRequest` so authors
  pass only the public capability leaf. The runtime supplies the current
  extension identity from the RPC, hook, or tool execution boundary.
- Preserved requirement ownership: dynamic registration still fails when the
  host cannot prove the current extension owner, rather than accepting an
  author-supplied ID parameter.
- Updated dynamic request dispatch and tool execution so dynamic leaves run with
  the owner extension in their `ExtensionContext`. Static tool execution now
  maps the already-resolved model-visible tool back to its owning extension
  before providing the authoring facade.
- Added a compile-time surface lock proving `registerTool(tool)` is accepted
  and `registerTool(extensionId, tool)` is rejected.
- Updated the dynamic scratchpad reference and docs to teach the smaller call
  shape.
- Verification:
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/extensions/extension-surface-locks.test.ts packages/core/tests/extensions/authoring-reference.test.ts packages/core/tests/server/extension-commands-rpc.test.ts packages/core/tests/runtime/tool-runner.test.ts -t "dynamic|Dynamic|reference dynamic|ExtensionContext identity|host authority"`
  passed with 7 tests. `bun run typecheck` passed.
- Evidence:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-hooks.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/dynamic-scratchpad.ts`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md`.

### L1 - Dogfood Real Extensions

Build or port representative extensions using only
`@gent/core/extensions/api`, then let the friction drive API changes.

- **C1**: Pick one small extension and one stateful/dynamic extension as W44
  dogfood targets.
- **C2**: Add or update reference acceptance tests that load those extensions
  through the real setup/runtime boundary.
- **C3**: Capture authoring friction as code changes or explicit findings;
  do not leave vague notes.
- **Evidence targets**:
  `/Users/cvr/Developer/personal/gent/examples/extensions/session-notes.ts`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/authoring-reference.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts`.

### L2 - Ceremony And Naming

Audit the public extension surface for ceremony that an author pays before the
behavior itself is clear.

- **C4**: Review `defineExtension`, `tool`, `request`, `hook`, `defineResource`,
  dynamic registration, and ref derivation as one authoring language.
- **C5**: Collapse redundant names/concepts where the product can be simpler
  without hiding requirements.
- **C6**: Add compile-time or runtime locks for any simplification so the
  authoring surface does not drift back.
- **Evidence targets**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts`.

### L3 - Requirement Ownership In Practice

Prove the no-context-params rule works for real extensions with private state,
runtime authority, and dynamic behavior.

- **C7**: Audit shipped extensions for any remaining host facts, implicit
  runtime authority, or private core Tags crossing into extension code.
- **C8**: Prefer extension-owned services/resources that internally provide
  their dependencies over parameter threading.
- **C9**: Add a guard or test when a leak pattern is likely to recur.
- **Evidence targets**:
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/index.ts`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/index.ts`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/index.ts`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts`.

### L4 - Runtime And UX Feedback

Make extension failures and lifecycle state feel like product feedback, not
implementation leakage.

- **C10**: Exercise setup, validation, resource startup, dynamic registration,
  hook failure, and extension status surfaces from an author perspective.
- **C11**: Improve diagnostics where an author cannot tell what to change.
- **C12**: Keep UI/runtime status language product-facing and free of deleted
  lifecycle or migration terminology.
- **Evidence targets**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-package-shape.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/extension-commands.ts`,
  `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md`.

### L5 - Architecture Simplification

Use the dogfood findings to remove concepts and LOC while preserving the actor
model north star.

- **C13**: Look for extension/runtime seams that exist only because of past API
  shape, not current product needs.
- **C14**: Collapse local adapter layers or duplicate concepts when the owner
  boundary is clear.
- **C15**: Verify every simplification through runtime or RPC acceptance tests,
  not only unit tests.
- **Evidence targets**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-hooks.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-resolve.ts`,
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`.

### L6 - Documentation As Product

Make the docs teach the shape an author should actually use after W43.

- **C16**: Ensure `docs/extensions.md` has one coherent progression from
  hello tool to stateful/dynamic extension.
- **C17**: Keep all examples hooks-only and public-API-only.
- **C18**: Add exact commands for validating a local extension authoring
  change.
- **Evidence targets**:
  `/Users/cvr/Developer/personal/gent/docs/extensions.md`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/hello-tool.ts`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/session-notes.ts`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts`.

## Completion Criteria

- At least one real authoring dogfood path is implemented or audited deeply
  enough to produce code changes.
- No W43 compatibility surface is reintroduced.
- No extension authoring path requires private Gent imports.
- No handler receives host authority as a parameter.
- `bun run gate` passes.
- Final W44 audit receipt lists every file reference used to conclude no
  P0/P1 findings.
