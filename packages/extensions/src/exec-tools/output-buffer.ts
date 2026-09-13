/**
 * Output buffer with fixed head + rolling tail for streaming command output.
 *
 * Maintains constant memory regardless of output size by keeping:
 * - first N lines (head, fill once then lock)
 * - last M lines (tail, ring buffer, always rolling)
 * - total line count for truncation message
 */

const DEFAULT_HEAD_LINES = 50
const DEFAULT_TAIL_LINES = 50

interface OutputBufferFormat {
  readonly text: string
  readonly truncatedLines: number
}

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
  format(): OutputBufferFormat {
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
