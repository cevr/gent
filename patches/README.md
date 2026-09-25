# Dependency patches

`package.json` `patchedDependencies` applies each file here at install. A
patch names one exact version, so a version bump leaves the patch unapplied
until it is regenerated for the new release. The Effect patches follow
`catalog.effect`; the guards fail when a patch key names another Effect
version. These are local dependency patches, not upstream releases.

## `@opentui/core@0.5.11`

The Bun and Node renderer bundles use the same resize correction.
`processResize` must clear from the actual split-footer origin when it is
above the estimated bottom-pinned footer area. Otherwise a width decrease
leaves stale composer rows on screen for short transcripts.

The patch keeps the existing lower-bound estimate and extends the clear
range upward to `renderOffset + 1`. It does not clear saved terminal lines.

Herdr reproduced the defect when returning from 80×24 to 44×22. The same
check passed after the patch, including a seeded transcript and a return
from 120×40. See `docs/research/2026-09-18-fx-ui-acceptance.md` for captures and validation.

Remove this patch when an OpenTUI release handles non-bottom-pinned
split-footer resize cleanup. Recheck these paths before removing it.
Rechecked on 2026-09-08: 0.5.11 still ships the unbounded clear, so the patch was regenerated for that release.

## `@effect/ai-anthropic@4.0.0-rc.112`

`prepareMessages` sets the request's `system` field from each system group
it meets, so a system message after the first message replaces the system
prompt. gent sends the runtime's turn notices as such a later system
message; in `system` they would change the cached prompt prefix every turn
and lose their place in the conversation.

The patch keeps the first system group in `system` and sends a later one,
in place, as a user message whose text blocks read
`<host-context-update>\n…\n</host-context-update>`, with `&`, `<` and `>`
escaped so the text cannot close the wrapper. The opening is
`HOST_CONTEXT_UPDATE_OPEN` in `packages/extensions/src/providers.ts`. The
Anthropic extension (`packages/extensions/src/anthropic.ts`) reads it through
`isHostContextUpdateText` to keep the cache marker off these blocks.

Remove this patch when the SDK keeps a later system message in place.
