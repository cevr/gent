/**
 * GentTracer — Effect Tracer that logs span lifecycle to file.
 *
 * Creates traceId/spanId for Effect spans, logs start/end with indentation
 * to show nesting. Used by both TUI (embedded) and standalone server.
 */

import { appendFileSync, writeFileSync } from "node:fs"
import type { ServiceMap } from "effect"
import { Config, Effect, Layer, Option, Tracer, Exit, Cause } from "effect"

const LOG_PATH = "/tmp/gent-trace.log"

const timestamp = () => {
  const d = new Date()
  return `[${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}]`
}

export const clearTraceLog = () => writeFileSync(LOG_PATH, "")

const writeLine = (line: string) => {
  try {
    appendFileSync(LOG_PATH, line + "\n")
  } catch {
    // ignore write errors
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

class GentSpan implements Tracer.Span {
  readonly _tag = "Span" as const
  readonly spanId: string
  readonly traceId: string
  readonly sampled: boolean

  readonly name: string
  readonly parent: Option.Option<Tracer.AnySpan>
  readonly annotations: ServiceMap.ServiceMap<never>
  readonly kind: Tracer.SpanKind

  status: Tracer.SpanStatus
  attributes: Map<string, unknown>
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]> = []
  links: Array<Tracer.SpanLink>

  private depth: number

  constructor(options: {
    readonly name: string
    readonly parent: Option.Option<Tracer.AnySpan>
    readonly annotations: ServiceMap.ServiceMap<never>
    readonly links: Array<Tracer.SpanLink>
    readonly startTime: bigint
    readonly kind: Tracer.SpanKind
    readonly sampled: boolean
  }) {
    this.name = options.name
    this.parent = options.parent
    this.annotations = options.annotations
    this.kind = options.kind
    this.status = { _tag: "Started", startTime: options.startTime }
    this.attributes = new Map()
    this.traceId = Option.getOrUndefined(options.parent)?.traceId ?? randomHex(32)
    this.spanId = randomHex(16)
    this.links = Array.from(options.links)
    this.sampled = options.sampled
    this.depth = this.calculateDepth()

    this.log("START", this.name)
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
    const traceShort = this.traceId.slice(0, 8)
    let icon = "."
    if (event === "START") icon = ">"
    else if (event === "END") icon = "<"
    else if (event === "ERROR") icon = "!"
    writeLine(
      `${timestamp()} [${traceShort}] ${indent}${icon} ${message}${
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
      const message = Cause.hasInterruptsOnly(cause)
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

export function makeGentTracer(): Tracer.Tracer {
  return Tracer.make({
    span: (options) => new GentSpan(options),
  })
}

/** Provides the GentTracer as the Effect Tracer. */
export const GentTracerLive: Layer.Layer<never> = Layer.succeed(Tracer.Tracer, makeGentTracer())

/** Clear trace log — call at startup (not in subprocess mode). */
export const clearTraceLogIfRoot: Layer.Layer<never> = Layer.unwrap(
  Effect.gen(function* () {
    const isSubprocess = Option.isSome(yield* Config.option(Config.string("GENT_TRACE_ID")))
    if (!isSubprocess) clearTraceLog()
    return Layer.empty
  }).pipe(Effect.catchEager(() => Effect.succeed(Layer.empty))),
)
