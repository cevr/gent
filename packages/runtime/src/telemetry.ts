import type { Context, Option } from "effect"
import { Exit, Layer, Tracer, Cause } from "effect"

// Note: Tracer.Span interface requires synchronous methods (end, event, attribute).
// We use node:fs sync APIs here because:
// 1. Bun.write is async (returns Promise)
// 2. Span callbacks execute outside Effect context
// 3. Sync writes ensure trace ordering is preserved
import { appendFileSync, writeFileSync } from "node:fs"

// DevSpan - logs span lifecycle to file
class DevSpan implements Tracer.Span {
  readonly _tag = "Span" as const
  readonly spanId: string
  readonly traceId: string
  readonly sampled = true

  status: Tracer.SpanStatus
  attributes: Map<string, unknown>
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]> = []
  links: Array<Tracer.SpanLink>

  private depth: number
  private logFile: string

  constructor(
    readonly name: string,
    readonly parent: Option.Option<Tracer.AnySpan>,
    readonly context: Context.Context<never>,
    links: Iterable<Tracer.SpanLink>,
    readonly startTime: bigint,
    readonly kind: Tracer.SpanKind,
    logFile: string
  ) {
    this.logFile = logFile
    this.status = { _tag: "Started", startTime }
    this.attributes = new Map()
    this.traceId = parent._tag === "Some" ? parent.value.traceId : randomHex(32)
    this.spanId = randomHex(16)
    this.links = Array.from(links)
    this.depth = this.calculateDepth()

    this.log("START", `${this.name}`)
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
    const timestamp = new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
    const icon = event === "START" ? ">" : event === "END" ? "<" : event === "ERROR" ? "!" : "."
    const line = `[${timestamp}] ${indent}${icon} ${message}${extra ? ` ${extra}` : ""}\n`
    try {
      appendFileSync(this.logFile, line)
    } catch {
      // ignore write errors
    }
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
      this.log("END", `${this.name}`, `(${durationStr})`)
    } else {
      const cause = exit.cause
      const message = Cause.isInterruptedOnly(cause)
        ? "interrupted"
        : Cause.pretty(cause).split("\n")[0] ?? "unknown error"
      this.log("ERROR", `${this.name}`, `(${durationStr}) - ${message}`)
    }
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value)
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.events.push([name, startTime, attributes ?? {}])
    this.log("EVENT", `${this.name}`, `[${name}]`)
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links)
  }
}

function randomHex(length: number): string {
  const chars = "abcdef0123456789"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// Create a dev tracer that logs to a file
export function makeDevTracer(logFile: string): Tracer.Tracer {
  return Tracer.make({
    span: (name, parent, context, links, startTime, kind) =>
      new DevSpan(name, parent, context, links, startTime, kind, logFile),
    context: (f) => f(),
  })
}

// Layer that provides the dev tracer
export const DevTracerLive = (logFile: string): Layer.Layer<never> =>
  Layer.setTracer(makeDevTracer(logFile))

// Default log file location
export const DEFAULT_LOG_FILE = "/tmp/gent-trace.log"

// Convenience layer with default log file
export const DevTracer = DevTracerLive(DEFAULT_LOG_FILE)

// Helper to clear the log file (sync, for use before starting trace)
export function clearLog(logFile: string = DEFAULT_LOG_FILE): void {
  try {
    writeFileSync(logFile, "")
  } catch {
    // ignore
  }
}
