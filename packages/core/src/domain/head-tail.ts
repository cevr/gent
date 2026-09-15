/**
 * Head + tail projections of a bounded view over a longer sequence: the
 * first half, a truncation marker, the last half.
 */

interface HeadTailResult<T> {
  readonly head: T[]
  readonly tail: T[]
  readonly truncatedCount: number
}

interface HeadTailCharsResult {
  readonly text: string
  readonly truncated: boolean
  readonly totalChars: number
}

/**
 * Truncate an array to head + tail. For when all items are known upfront.
 */
export function headTail<T>(items: readonly T[], maxItems: number = 100): HeadTailResult<T> {
  const total = items.length
  if (total <= maxItems) {
    return { head: [...items], tail: [], truncatedCount: 0 }
  }

  const half = Math.floor(maxItems / 2)
  const head = items.slice(0, half)
  const tail = items.slice(-half)

  return { head, tail, truncatedCount: total - half * 2 }
}

/**
 * Format head+tail arrays with truncation marker.
 */
export function formatHeadTail(
  items: readonly unknown[],
  maxItems: number = 100,
  truncatedMsg: (count: number) => string = (n) => `... [${n} lines truncated] ...`,
): string {
  const { head, tail, truncatedCount } = headTail(items, maxItems)

  if (truncatedCount === 0) {
    return head.map(String).join("\n")
  }

  return [...head.map(String), "", truncatedMsg(truncatedCount), "", ...tail.map(String)].join("\n")
}

/**
 * Truncate raw text to head + tail by characters.
 */
export function headTailChars(text: string, maxChars: number = 64_000): HeadTailCharsResult {
  const total = text.length
  if (total <= maxChars) {
    return { text, truncated: false, totalChars: total }
  }

  const half = Math.floor(maxChars / 2)
  const head = text.slice(0, half)
  const tail = text.slice(-half)

  return {
    text: `${head}\n\n... [${total - maxChars} characters truncated] ...\n\n${tail}`,
    truncated: true,
    totalChars: total,
  }
}

/**
 * Keep the head of `text` up to `maxChars`. A longer text ends in `marker`.
 */
export function clipChars(text: string, maxChars: number, marker: string = "…"): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + marker
}
