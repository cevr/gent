/**
 * Excerpt-based windowing for tool output.
 *
 * windowItems<T>() — generic windowing primitive. Operates on any array.
 *
 * Focus semantics:
 *   "head"  — first `context` items (one-sided from start)
 *   "tail"  — last `context` items (one-sided from end)
 *   N       — ±context items around index N (symmetric)
 *
 * Multiple excerpts are sorted and merged when overlapping or adjacent.
 * Gaps get an elision marker via the caller-provided makeElision factory.
 */

export interface Excerpt {
  focus: number | "head" | "tail"
  context: number
}

export interface WindowResult<T> {
  items: T[]
  skippedRanges: Array<[number, number]>
}

/**
 * Generic excerpt windowing. Picks items to keep based on excerpts,
 * inserts caller-provided elision markers for gaps.
 *
 * If excerpts is empty, returns all items unchanged.
 */
export function windowItems<T>(
  items: readonly T[],
  excerpts: readonly Excerpt[],
  makeElision: (count: number) => T,
): WindowResult<T> {
  const total = items.length
  if (total === 0 || excerpts.length === 0) {
    return { items: [...items], skippedRanges: [] }
  }

  // resolve each excerpt to an inclusive [start, end] range
  const ranges: Array<[number, number]> = excerpts.map(({ focus, context }) => {
    if (focus === "head") {
      return [0, Math.min(context - 1, total - 1)]
    } else if (focus === "tail") {
      return [Math.max(0, total - context), total - 1]
    } else {
      return [Math.max(0, focus - context), Math.min(total - 1, focus + context)]
    }
  })

  // sort by start, merge overlapping/adjacent
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last === undefined || range[0] > last[1] + 1) {
      merged.push([range[0], range[1]])
    } else {
      last[1] = Math.max(last[1], range[1])
    }
  }

  const result: T[] = []
  const skippedRanges: Array<[number, number]> = []
  let cursor = 0

  for (const [start, end] of merged) {
    if (cursor < start) {
      skippedRanges.push([cursor, start])
      result.push(makeElision(start - cursor))
    }
    for (let i = start; i <= end; i++) {
      const item = items[i]
      if (item !== undefined) result.push(item)
    }
    cursor = end + 1
  }

  if (cursor < total) {
    skippedRanges.push([cursor, total])
    result.push(makeElision(total - cursor))
  }

  return { items: result, skippedRanges }
}

/**
 * Convenience: headTail excerpts for windowing.
 * Returns excerpts that show the first `head` and last `tail` items.
 */
export function headTailExcerpts(head: number, tail: number): Excerpt[] {
  return [
    { focus: "head" as const, context: head },
    { focus: "tail" as const, context: tail },
  ]
}
