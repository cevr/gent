/**
 * How tall the split footer may grow.
 *
 * Scrollback is written by letting committed rows scroll off the top of the
 * output region above the footer. OpenTUI derives that region from the footer:
 * `calculateRenderGeometry` gives it `terminalHeight - effectiveFooterHeight`
 * rows and `getSplitPinnedRenderOffset` pins the commit origin to the same
 * value. The native commit then sets a scroll region of `ESC[1;<rows>r`.
 *
 * Two footer heights break that region:
 *
 *  - A footer as tall as the terminal leaves zero output rows. The commit
 *    writes at screen row 1, the footer repaint covers those rows in the same
 *    synchronized frame, and nothing scrolls off at all.
 *  - A footer one row short leaves a single output row, so the region is
 *    `ESC[1;1r`. A one-row region has no line to scroll away from; the
 *    terminal discards the row instead of keeping it.
 *
 * Reserving two rows is the smallest region a terminal will actually scroll,
 * and it is what keeps history growing. Measured on a 40-row terminal
 * resuming a 23-step session: zero reserved rows and one reserved row both
 * give 0 history rows, two give 235.
 */
export const SPLIT_FOOTER_RESERVED_OUTPUT_ROWS = 2

export const splitFooterHeight = (terminalHeight: number, requestedHeight: number): number => {
  const maximum = Math.max(1, terminalHeight - SPLIT_FOOTER_RESERVED_OUTPUT_ROWS)
  return Math.min(maximum, Math.max(1, requestedHeight))
}
