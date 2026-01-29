/**
 * Unified tracer for TUI debugging
 *
 * Combines Effect spans with TUI-level events in a single log file.
 * This allows tracing the full flow from UI interaction -> Effect RPC -> response.
 */

import { appendFileSync, writeFileSync } from "node:fs"
import { Layer, Tracer, Exit, Cause, type Context, type Option } from "effect"

const LOG_PATH = "/tmp/gent-unified.log"

// Shared timestamp format
const timestamp = () => {
  const d = new Date()
  return `[${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}]`
}

// Clear log file
export const clearUnifiedLog = () => writeFileSync(LOG_PATH, "")

// Write a line to the log
const writeLine = (line: string) => {
  try {
    appendFileSync(LOG_PATH, line + "\n")
  } catch {
    // ignore write errors
  }
}

// =============================================================================
// TUI-level logging (for Solid/UI events)
// =============================================================================

export const tuiLog = (msg: string) => writeLine(`${timestamp()} [tui] ${msg}`)

export const tuiEvent = (tag: string, data?: Record<string, unknown>) =>
  tuiLog(`${tag}${data !== undefined ? " " + JSON.stringify(data) : ""}`)

export const tuiError = (tag: string, err: unknown) =>
  tuiLog(`! ${tag} - ${err instanceof Error ? err.message : String(err)}`)

// =============================================================================
// Effect tracer (for RPC/server operations)
// =============================================================================

function randomHex(length: number): string {
  const chars = "abcdef0123456789"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

class UnifiedSpan implements Tracer.Span {
  readonly _tag = "Span" as const
  readonly spanId: string
  readonly traceId: string
  readonly sampled = true

  status: Tracer.SpanStatus
  attributes: Map<string, unknown>
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]> = []
  links: Array<Tracer.SpanLink>

  private depth: number

  constructor(
    readonly name: string,
    readonly parent: Option.Option<Tracer.AnySpan>,
    readonly context: Context.Context<never>,
    links: Iterable<Tracer.SpanLink>,
    readonly startTime: bigint,
    readonly kind: Tracer.SpanKind,
  ) {
    this.status = { _tag: "Started", startTime }
    this.attributes = new Map()
    this.traceId = parent._tag === "Some" ? parent.value.traceId : randomHex(32)
    this.spanId = randomHex(16)
    this.links = Array.from(links)
    this.depth = this.calculateDepth()

    this.log("START", this.name)
  }

  private calculateDepth(): number {
    let depth = 0
    let current = this.parent
    while (current._tag === "Some") {
      depth++
      if (current.value._tag === "Span") {
        current = current.value.parent
      } else {
        break
      }
    }
    return depth
  }

  private log(event: string, message: string, extra?: string) {
    const indent = "  ".repeat(this.depth)
    const icon = event === "START" ? ">" : event === "END" ? "<" : event === "ERROR" ? "!" : "."
    writeLine(
      `${timestamp()} [effect] ${indent}${icon} ${message}${
        extra !== undefined && extra.length > 0 ? ` ${extra}` : ""
      }`,
    )
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = {
      _tag: "Ended",
      endTime,
      exit,
      startTime: this.status.startTime,
    }

    const durationMs = Number(endTime - this.status.startTime) / 1_000_000
    const durationStr = durationMs < 1 ? `${durationMs.toFixed(2)}ms` : `${durationMs.toFixed(0)}ms`

    if (Exit.isSuccess(exit)) {
      this.log("END", this.name, `(${durationStr})`)
    } else {
      const cause = exit.cause
      const message = Cause.isInterruptedOnly(cause)
        ? "interrupted"
        : (Cause.pretty(cause).split("\n")[0] ?? "unknown error")
      this.log("ERROR", this.name, `(${durationStr}) - ${message}`)
    }
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value)
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.events.push([name, startTime, attributes ?? {}])
    this.log("EVENT", this.name, `[${name}]`)
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links)
  }
}

// Create unified tracer
export function makeUnifiedTracer(): Tracer.Tracer {
  return Tracer.make({
    span: (name, parent, context, links, startTime, kind) =>
      new UnifiedSpan(name, parent, context, links, startTime, kind),
    context: (f) => f(),
  })
}

// Layer that provides the unified tracer
export const UnifiedTracerLive: Layer.Layer<never> = Layer.setTracer(makeUnifiedTracer())
