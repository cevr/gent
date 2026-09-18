/**
 * The split footer must always leave the terminal room to scroll.
 *
 * Scrollback only exists because committed rows scroll off the top of the
 * output region above the footer. OpenTUI derives that region from the footer
 * height, and the native commit turns it into a scroll region of
 * `ESC[1;<rows>r`. A footer that takes the whole screen leaves no region at
 * all, and a footer one row short leaves `ESC[1;1r`, which a terminal drops
 * rather than scrolls. Both spellings cost the reader the entire transcript:
 * measured on a 40-row terminal resuming a 23-step session, each gave 0 rows
 * of history where the fixed height gives 236.
 *
 * A tall live view is the case that used to break it. `liveHeight` grows with
 * the streaming reply, so the requested height passes the screen height long
 * before the reader notices.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { splitFooterHeight, SPLIT_FOOTER_RESERVED_OUTPUT_ROWS } from "../src/message-list"

describe("split footer height", () => {
  it.effect("a live view taller than the screen still leaves rows to scroll", () =>
    Effect.sync(() => {
      const terminalHeight = 40
      // The composer plus a live view that has outgrown the screen twice over.
      const height = splitFooterHeight(terminalHeight, 3 + 120)
      expect(height).toBeLessThan(terminalHeight)
      expect(terminalHeight - height).toBeGreaterThanOrEqual(2)
    }),
  )

  it.effect("every requested height keeps a scrollable output region", () =>
    Effect.sync(() => {
      const terminalHeight = 40
      const requested = Array.from({ length: 200 }, (_, index) => index + 1)
      const regions = requested.map(
        (value) => terminalHeight - splitFooterHeight(terminalHeight, value),
      )
      // A region of 0 rows cannot be written and a region of 1 row cannot
      // scroll, so neither may ever be produced.
      expect(Math.min(...regions)).toBeGreaterThanOrEqual(2)
    }),
  )

  it.effect("a short footer is left alone", () =>
    Effect.sync(() => {
      expect(splitFooterHeight(40, 4)).toBe(4)
      expect(splitFooterHeight(40, 1)).toBe(1)
    }),
  )

  it.effect("the reserved region is at least the two rows a terminal will scroll", () =>
    Effect.sync(() => {
      expect(SPLIT_FOOTER_RESERVED_OUTPUT_ROWS).toBeGreaterThanOrEqual(2)
    }),
  )

  it.effect("a tiny terminal still reports a usable footer", () =>
    Effect.sync(() => {
      expect(splitFooterHeight(1, 10)).toBe(1)
      expect(splitFooterHeight(2, 10)).toBe(1)
      expect(splitFooterHeight(3, 10)).toBe(1)
    }),
  )
})
