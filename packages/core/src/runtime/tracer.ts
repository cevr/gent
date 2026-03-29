/**
 * GentTracer — Effect Tracer that logs span lifecycle to file.
 *
 * Creates traceId/spanId for Effect spans, logs start/end with indentation
 * to show nesting. Used by both TUI (embedded) and standalone server.
 */

import type { ServiceMap, PlatformError, Scope } from "effect"
import { Config, Effect, FileSystem, Layer, Option, Tracer, Exit, Cause } from "effect"

const LOG_PATH = "/tmp/gent-trace.log"

const timestamp = () => {
  const d = new Date()
  return `[${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}]`
}

export const clearTraceLog = () => {
  void Bun.write(LOG_PATH, "")
}

const formatTraceValue = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  if (value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return "[unserializable]"
  }
}

const formatTraceFields = (fields: Iterable<readonly [string, unknown]>): string => {
  const parts: string[] = []
  for (const [key, value] of fields) {
    parts.push(`${key}=${formatTraceValue(value)}`)
  }
  return parts.join(" ")
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
    this.writeLine(
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
    const attributes = formatTraceFields(this.attributes.entries())
    const extra = attributes.length > 0 ? `attrs{${attributes}}` : undefined

    if (Exit.isSuccess(exit)) {
      this.log("END", this.name, [durationStr, extra].filter(Boolean).join(" "))
    } else {
      const cause = exit.cause
      const message = Cause.hasInterruptsOnly(cause)
        ? "interrupted"
        : (Cause.pretty(cause).split("\n")[0] ?? "unknown error")
      this.log(
        "ERROR",
        this.name,
        [`(${durationStr})`, "-", message, extra].filter(Boolean).join(" "),
      )
    }
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value)
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.events.push([name, startTime, attributes ?? {}])
    const details = formatTraceFields(Object.entries(attributes ?? {}))
    this.log("EVENT", this.name, [`[${name}]`, details].filter((part) => part.length > 0).join(" "))
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links)
  }
}

export function makeGentTracer(writeLine: (line: string) => void): Tracer.Tracer {
  return Tracer.make({
    span: (options) => new GentSpan(options, writeLine),
  })
}

/** Provides the GentTracer as the Effect Tracer. */
export const GentTracerLive: Layer.Layer<
  never,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> = Layer.effect(
  Tracer.Tracer,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const traceFile = yield* fs.open(LOG_PATH, { flag: "a+" })
    const encoder = new TextEncoder()
    const services = yield* Effect.services<never>()
    const writeLine = (line: string) => {
      void Effect.runForkWith(services)(Effect.ignore(traceFile.write(encoder.encode(line + "\n"))))
    }
    return makeGentTracer(writeLine)
  }),
)

/** Clear trace log — call at startup (not in subprocess mode). */
export const clearTraceLogIfRoot: Layer.Layer<never, never, FileSystem.FileSystem> = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const isSubprocess = Option.isSome(yield* Config.option(Config.string("GENT_TRACE_ID")))
    if (!isSubprocess) {
      yield* Effect.ignore(fs.writeFileString(LOG_PATH, ""))
    }
    return Layer.empty
  }).pipe(Effect.catchEager(() => Effect.succeed(Layer.empty))),
)
