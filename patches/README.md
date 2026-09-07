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
