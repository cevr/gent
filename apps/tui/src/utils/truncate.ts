/**
 * The one column-budget truncation for the TUI.
 *
 * Every caller budgets terminal columns, not code units: a CJK name or an
 * emoji fits `.length` and still overflows the row. Graphemes are measured
 * with the terminal width adapter and the ellipsis is a single glyph, so the
 * result never exceeds `width` columns.
 */
import { textWidth } from "../platform/text-width-adapter"

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" })

const oneLine = (value: string): string => value.replace(/[\r\n\t]/g, " ")

/** Keep the head; end with `…` when the text does not fit `width` columns. */
export function truncate(value: string, width: number): string {
  if (width <= 0) return ""
  const line = oneLine(value)
  if (textWidth(line) <= width) return line
  let text = ""
  let columns = 0
  for (const { segment } of graphemes.segment(line)) {
    const size = textWidth(segment)
    if (columns + size > width - 1) break
    text += segment
    columns += size
  }
  return `${text}…`
}

/** Keep the tail without splitting a displayed character: the end of a query stays visible. */
export function truncateStart(value: string, width: number): string {
  if (width <= 0) return ""
  const line = oneLine(value)
  if (textWidth(line) <= width) return line
  let text = ""
  let columns = 0
  for (const { segment } of Array.from(graphemes.segment(line)).reverse()) {
    const size = textWidth(segment)
    if (columns + size > width) break
    text = segment + text
    columns += size
  }
  return text
}
