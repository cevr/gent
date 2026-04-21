/**
 * Output buffer with fixed head + rolling tail.
 *
 * Maintains constant memory regardless of output size by keeping:
 * - first N lines (head, fill once then lock)
 * - last M lines (tail, ring buffer, always rolling)
 * - total line count for truncation message
 *
 * When truncated, saves full output to /tmp/gent-output/ and returns the path.
 */

import { DateTime, Effect, FileSystem, Path } from "effect"

const DEFAULT_HEAD_LINES = 50
const DEFAULT_TAIL_LINES = 50
const OUTPUT_DIR = "/tmp/gent/outputs"

/**
 * Truncate an array to head + tail. Simpler than OutputBuffer — for when
 * you have all items upfront (not streaming).
 */
export function headTail<T>(
  items: readonly T[],
  maxItems: number = 100,
): { head: T[]; tail: T[]; truncatedCount: number } {
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
export function headTailChars(
  text: string,
  maxChars: number = 64_000,
): { text: string; truncated: boolean; totalChars: number } {
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

export interface OutputBufferResult {
  text: string
  truncatedLines: number
  savedPath?: string
}

/**
 * Save full output to /tmp/gent/outputs/ and return the path.
 */
export const saveFullOutput = (output: string, label: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(OUTPUT_DIR, { recursive: true })

    const now = yield* DateTime.nowAsDate
    const timestamp = now.toISOString().replace(/[:.]/g, "-")
    const safeName = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)
    const filename = `${safeName}_${timestamp}.txt`
    const filepath = path.join(OUTPUT_DIR, filename)

    const header = `# Label: ${label}\n# Timestamp: ${now.toISOString()}\n\n`
    yield* fs.writeFileString(filepath, header + output)

    return filepath
  })

export class OutputBuffer {
  private head: string[] = []
  private tail: string[] = []
  private headComplete = false
  private pendingLine = ""
  totalLines = 0

  constructor(
    private maxHead: number = DEFAULT_HEAD_LINES,
    private maxTail: number = DEFAULT_TAIL_LINES,
  ) {}

  /**
   * Add a chunk of output. Handles partial lines at boundaries.
   */
  add(chunk: string): void {
    const text = this.pendingLine + chunk
    const lines = text.split("\n")

    // last element might be incomplete (no trailing newline)
    this.pendingLine = lines.pop() ?? ""

    for (const line of lines) {
      this.totalLines++
      this.addLine(line)
    }
  }

  private addLine(line: string): void {
    if (!this.headComplete && this.head.length < this.maxHead) {
      this.head.push(line)
      if (this.head.length === this.maxHead) {
        this.headComplete = true
      }
    }

    // always push to tail for dedup in format()
    this.tail.push(line)
    if (this.tail.length > this.maxTail) {
      this.tail.shift()
    }
  }

  /**
   * Finalize and format the output.
   * Returns text + count of truncated lines.
   */
  format(): { text: string; truncatedLines: number } {
    // flush remaining pending line
    if (this.pendingLine) {
      this.totalLines++
      this.addLine(this.pendingLine)
      this.pendingLine = ""
    }

    const allLines = this.totalLines

    // no truncation: output fits in head + tail
    if (allLines <= this.maxHead + this.maxTail) {
      const uniqueLines = this.dedupe(allLines)
      return { text: uniqueLines.join("\n"), truncatedLines: 0 }
    }

    // truncation: head + marker + tail
    const truncated = allLines - this.head.length - this.tail.length
    const parts = [...this.head, "", `... [${truncated} lines truncated] ...`, "", ...this.tail]

    return { text: parts.join("\n"), truncatedLines: truncated }
  }

  /**
   * Get all buffered content as a single string (for saving full output).
   * NOTE: Only useful when all content has been added.
   */
  getFullText(): string {
    if (this.pendingLine) {
      return [...this.head, ...this.tail, this.pendingLine].join("\n")
    }
    const allLines = this.totalLines
    if (allLines <= this.maxHead + this.maxTail) {
      return this.dedupe(allLines).join("\n")
    }
    // when truncated, we lost middle lines — can't reconstruct full text
    // callers should accumulate separately if they need full output
    return ""
  }

  private dedupe(totalLines: number): string[] {
    if (totalLines <= this.maxHead) return this.head
    if (totalLines <= this.maxTail) return this.tail

    const overlapLen = Math.max(0, this.head.length + this.tail.length - totalLines)
    if (overlapLen === 0) return [...this.head, ...this.tail]

    const headPart = this.head.slice(0, this.head.length - overlapLen)
    return [...headPart, ...this.tail]
  }
}
