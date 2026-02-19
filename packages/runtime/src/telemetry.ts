/**
 * @deprecated Use `GentLogger` from `./logger` instead.
 * This file is kept for backwards compatibility. All exports are deprecated.
 */

import { Effect, Exit, Layer, ServiceMap, Tracer, Cause } from "effect"

import { appendFileSync, writeFileSync } from "node:fs"

// DevSpan - logs span lifecycle to file
class DevSpan implements Tracer.Span {
  readonly _tag = "Span" as const
  readonly spanId: string
  readonly traceId: string
  readonly sampled: boolean

  readonly name: string
  readonly parent: Tracer.AnySpan | undefined
  readonly annotations: ServiceMap.ServiceMap<never>
  readonly links: Array<Tracer.SpanLink>
  readonly startTime: bigint
  readonly kind: Tracer.SpanKind

  status: Tracer.SpanStatus
  attributes: Map<string, unknown>
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]> = []

  private depth: number
  private logFile: string

  constructor(
    options: {
      readonly name: string
      readonly parent: Tracer.AnySpan | undefined
      readonly annotations: ServiceMap.ServiceMap<never>
      readonly links: Array<Tracer.SpanLink>
      readonly startTime: bigint
      readonly kind: Tracer.SpanKind
      readonly sampled: boolean
    },
    logFile: string,
  ) {
    this.name = options.name
    this.parent = options.parent
    this.annotations = options.annotations
    this.links = Array.from(options.links)
    this.startTime = options.startTime
    this.kind = options.kind
    this.sampled = options.sampled
    this.logFile = logFile
    this.status = { _tag: "Started", startTime: options.startTime }
    this.attributes = new Map()
    this.traceId = options.parent?.traceId ?? randomHex(32)
    this.spanId = randomHex(16)
    this.depth = this.calculateDepth()

    this.log("START", `${this.name}`)
  }

  private calculateDepth(): number {
    let depth = 0
    let current: Tracer.AnySpan | undefined = this.parent
    while (current !== undefined) {
      depth++
      if (current._tag === "Span") {
        current = current.parent
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
    const line = `[${timestamp}] ${indent}${icon} ${message}${
      extra !== undefined && extra !== "" ? ` ${extra}` : ""
    }\n`
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
      const message = Cause.hasInterruptsOnly(cause)
        ? "interrupted"
        : (Cause.pretty(cause).split("\n")[0] ?? "unknown error")
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

/** @deprecated Use `GentLogger` from `./logger` instead. */
export function makeDevTracer(logFile: string): Tracer.Tracer {
  return Tracer.make({
    span: (options) => new DevSpan(options, logFile),
  })
}

/** @deprecated Use `GentLogger` from `./logger` instead. */
export const DevTracerLive = (logFile: string): Layer.Layer<never> =>
  Layer.effectServices(Effect.succeed(ServiceMap.make(Tracer.Tracer, makeDevTracer(logFile))))

/** @deprecated Use `GentLogger` from `./logger` instead. */
export const DEFAULT_LOG_FILE = "/tmp/gent-trace.log"

/** @deprecated Use `GentLogger` from `./logger` instead. */
export const DevTracer = DevTracerLive(DEFAULT_LOG_FILE)

/** @deprecated Use `GentLogger` from `./logger` instead. */
export function clearLog(logFile: string = DEFAULT_LOG_FILE): void {
  try {
    writeFileSync(logFile, "")
  } catch {
    // ignore
  }
}
