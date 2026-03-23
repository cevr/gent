/**
 * @deprecated Use `GentLogger` from `./logger` instead.
 * This file is kept for backwards compatibility. All exports are deprecated.
 */

import type { PlatformError, Scope, ServiceMap } from "effect"
import { Effect, Exit, FileSystem, Layer, Option, Tracer, Cause } from "effect"

// DevSpan - logs span lifecycle to file
class DevSpan implements Tracer.Span {
  readonly _tag = "Span" as const
  readonly spanId: string
  readonly traceId: string
  readonly sampled: boolean

  readonly name: string
  readonly parent: Option.Option<Tracer.AnySpan>
  readonly annotations: ServiceMap.ServiceMap<never>
  readonly links: Array<Tracer.SpanLink>
  readonly startTime: bigint
  readonly kind: Tracer.SpanKind

  status: Tracer.SpanStatus
  attributes: Map<string, unknown>
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]> = []

  private depth: number
  constructor(
    options: {
      readonly name: string
      readonly parent: Option.Option<Tracer.AnySpan>
      readonly annotations: ServiceMap.ServiceMap<never>
      readonly links: Array<Tracer.SpanLink>
      readonly startTime: bigint
      readonly kind: Tracer.SpanKind
      readonly sampled: boolean
    },
    private readonly writeLine: (line: string) => void,
  ) {
    this.name = options.name
    this.parent = options.parent
    this.annotations = options.annotations
    this.links = Array.from(options.links)
    this.startTime = options.startTime
    this.kind = options.kind
    this.sampled = options.sampled
    this.status = { _tag: "Started", startTime: options.startTime }
    this.attributes = new Map()
    this.traceId = Option.getOrUndefined(options.parent)?.traceId ?? randomHex(32)
    this.spanId = randomHex(16)
    this.depth = this.calculateDepth()

    this.log("START", `${this.name}`)
  }

  private calculateDepth(): number {
    let depth = 0
    let current = Option.getOrUndefined(this.parent)
    while (current !== undefined) {
      depth++
      if (current._tag === "Span") {
        current = Option.getOrUndefined(current.parent)
      } else {
        break
      }
    }
    return depth
  }

  private log(event: string, message: string, extra?: string) {
    const indent = "  ".repeat(this.depth)
    const timestamp = new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
    let icon = "."
    if (event === "START") icon = ">"
    else if (event === "END") icon = "<"
    else if (event === "ERROR") icon = "!"
    const line = `[${timestamp}] ${indent}${icon} ${message}${
      extra !== undefined && extra !== "" ? ` ${extra}` : ""
    }\n`
    this.writeLine(line)
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
  const writeLine = (line: string) => {
    void Bun.write(logFile, line)
  }
  return Tracer.make({
    span: (options) => new DevSpan(options, writeLine),
  })
}

/** @deprecated Use `GentLogger` from `./logger` instead. */
export const DevTracerLive = (
  logFile: string,
): Layer.Layer<never, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Layer.effect(
    Tracer.Tracer,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = yield* fs.open(logFile, { flag: "a+" })
      const encoder = new TextEncoder()
      const writeLine = (line: string) => {
        void Effect.runFork(Effect.ignore(file.write(encoder.encode(line))))
      }
      return Tracer.make({
        span: (options) => new DevSpan(options, writeLine),
      })
    }),
  )

/** @deprecated Use `GentLogger` from `./logger` instead. */
export const DEFAULT_LOG_FILE = "/tmp/gent-trace.log"

/** @deprecated Use `GentLogger` from `./logger` instead. */
export const DevTracer = DevTracerLive(DEFAULT_LOG_FILE)

/** @deprecated Use `GentLogger` from `./logger` instead. */
export function clearLog(logFile: string = DEFAULT_LOG_FILE): void {
  void Bun.write(logFile, "")
}
