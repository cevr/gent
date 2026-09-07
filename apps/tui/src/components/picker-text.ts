import { textWidth } from "../platform/text-width-adapter"

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" })

/** Keep the query end visible without splitting a displayed character. */
export function pickerQueryText(value: string, width: number): string {
  if (width <= 0) return ""
  const line = value.replace(/[\r\n\t]/g, " ")
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

export function pickerText(value: string, width: number): string {
  if (width <= 0) return ""
  const line = value.replace(/[\r\n\t]/g, " ")
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
