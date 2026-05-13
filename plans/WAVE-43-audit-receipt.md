# Wave 43 audit receipt

## Result

- **Status**: closed.
- **Severity result**: no P0/P1 findings.
- **Range audited**: `2092bfe9..e41371f7`.
- **North star audited**: a good extension author can build useful Gent
  behavior quickly without learning core internals, passing host requirements as
  parameters, or guessing which runtime surfaces are stable.
- **Verification**: `bun run gate` passed after the final W43 change.

## Audit Trail

### L1 - Authoring Happy Path

**Green.** The guide starts with a one-file `defineExtension + tool` quick
start and points to the complete one-file product loop.

- `/Users/cvr/Developer/personal/gent/docs/extensions.md:12`
- `/Users/cvr/Developer/personal/gent/docs/extensions.md:36`
- `/Users/cvr/Developer/personal/gent/examples/extensions/session-notes.ts:72`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/authoring-reference.test.ts:36`

### L2 - Reference Extensions As API Tests

**Green.** `session-notes` is now a reference extension loaded and executed from
the public authoring API, and guardrails prevent reference examples from
importing private Gent internals.

- `/Users/cvr/Developer/personal/gent/examples/extensions/session-notes.ts:11`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/authoring-reference.test.ts:76`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts:146`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts:366`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts:14`

### L3 - Hooks And Dynamic Registrations

**Green.** Hooks are the only lifecycle authoring shape. The old keyed
lifecycle bucket is deleted from the public API, domain contribution shape,
runtime compiler, and shipped extensions. Dynamic registrations are
session-coherent, conflict-diagnosed, visible to prompt/tool resolution, visible
to slash listing, and dispatchable through RPC.

- `/Users/cvr/Developer/personal/gent/docs/extensions.md:233`
- `/Users/cvr/Developer/personal/gent/docs/extensions.md:263`
- `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts:22`
- `/Users/cvr/Developer/personal/gent/examples/extensions/prompt-rules.ts:10`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/contribution.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:214`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-hooks.ts:206`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-hooks.test.ts:55`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts:99`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts:57`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts:72`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts:136`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-resolve.ts:58`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:575`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/dynamic-extension-registry.test.ts:28`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts:785`

### L4 - Extension Developer Feedback

**Green.** Runtime-loaded extension validation remains field-local; setup and
activation failures are surfaced as degraded/failed extension health; dynamic
registration conflicts now have author-facing duplicate diagnostics.

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-package-shape.ts:12`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-package-shape.ts:96`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts:43`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts:121`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts:593`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/registry.test.ts:198`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/registry.test.ts:366`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/domain/dynamic-extension-registry.test.ts:40`

### L5 - Public Surface And Packaging

**Green.** `@gent/core/extensions/api` remains the single public authoring
package path; shipped/project/user extensions use the same import contract; the
public export guard prevents accidental new public internals.

- `/Users/cvr/Developer/personal/gent/docs/extensions.md:58`
- `/Users/cvr/Developer/personal/gent/docs/extensions.md:65`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:62`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:220`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/core-public-exports.test.ts:9`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/core-public-exports.test.ts:39`

### L6 - Runtime UX Surfaces

**Green.** Extension slash commands and dynamic autocompletion are surfaced
through TUI/session command registration; extension status surfaces expose active
and failed/degraded state; client widgets reject undecodable extension data at
the client boundary.

- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:575`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-command-registry.ts:176`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-command-registry.ts:188`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts:142`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts:220`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts:267`

## Residual Notes

- No W44 is opened from this audit.
