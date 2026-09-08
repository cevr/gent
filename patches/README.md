# OpenTUI patches

## `@opentui/core@0.5.10`

The Bun and Node renderer bundles use the same resize correction.
`processResize` must clear from the actual split-footer origin when it is
above the estimated bottom-pinned footer area. Otherwise a width decrease
leaves stale composer rows on screen for short transcripts.

The patch keeps the existing lower-bound estimate and extends the clear
range upward to `renderOffset + 1`. It does not clear saved terminal lines.

Herdr reproduced the defect when returning from 80×24 to 44×22. The same
check passed after the patch, including a seeded transcript and a return
from 120×40. See `docs/fx-ui-acceptance.md` for captures and validation.

Remove this patch when an OpenTUI release handles non-bottom-pinned
split-footer resize cleanup. Recheck these paths before removing it.
This is a local dependency patch, not an upstream release.

## `effect-encore@0.29.1`

`Actor.provideLayerBuildContext` captured the whole layer-build fiber
context. When an actor layer is built inside another actor's handler,
that context carries the outer entity's `CurrentAddress`, runner address,
state registry, and scope. `Effect.provideContext` merges the captured
values over the ones the entity manager provides, so the inner handler
build read the outer entity's address.

Gent hits this in foreground `delegate`: the ephemeral child composition
root builds its own `AgentLoopLiveActor` inside the parent turn. The child
loop then keyed its queue by the parent session id inside the child's
in-memory database, and the write failed with
`FOREIGN KEY constraint failed`.

The patch omits the declared `ActorLayerBuildContextExclusions` from the
captured context. The same change is committed upstream on the
`fix/layer-build-context-exclusions` branch of `cevr/effect-encore` with a
regression test in `test/actor-with-scope.test.ts`.

Remove this patch when `effect-encore` releases that fix and bump the
dependency. `packages/extensions/tests/delegate/delegate-foreground-child.test.ts`
guards the behavior.
