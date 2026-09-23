import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import {
  Cause,
  Config,
  type Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  type PlatformError,
  Predicate,
  Schema,
  type Scope,
} from "effect"
import type { LogLevel } from "effect/LogLevel"
import { CurrentLogAnnotations, CurrentLogSpans, MinimumLogLevel } from "effect/References"

// ── tracer ──────────────────────────────────────────────────────────────────

/**
 * Effect OpenTelemetry wiring.
 *
 * If `OTEL_EXPORTER_OTLP_ENDPOINT` is set, exports spans via OTLP/HTTP.
 * Otherwise the Effect default Tracer (a no-op) is left in place.
 */

const otlpEndpoint = Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"))
const otlpServiceName = Config.option(Config.string("OTEL_SERVICE_NAME"))

export const GentTracerLive: Layer.Layer<never> = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* otlpEndpoint
    if (Option.isNone(endpoint)) return Layer.empty
    const serviceName = Option.getOrElse(yield* otlpServiceName, () => "gent")
    const exporter = new OTLPTraceExporter({
      url: `${endpoint.value.replace(/\/$/, "")}/v1/traces`,
    })
    return NodeSdk.layer(() => ({
      resource: { serviceName },
      spanProcessor: new BatchSpanProcessor(exporter),
      shutdownTimeout: "500 millis",
    }))
  }).pipe(Effect.catchEager(() => Effect.succeed(Layer.empty))),
)

// ── log-paths ───────────────────────────────────────────────────────────────

/**
 * Centralized log path resolution — all logs go to /tmp/gent/logs/
 *
 * Files are named by a short hash of the cwd + process start timestamp so
 * multiple gent instances don't clobber each other and old logs are easy to
 * identify by time.
 *
 * File naming: `<hash>-<ts>-server.log`, `<hash>-<ts>-client.log`
 */

export const LOG_DIR = "/tmp/gent/logs"
const FALLBACK_CWD_IDENTITY = "unknown-cwd"

/** FNV-1a 32-bit hash → 8-char hex */
const hashCwd = (cwd: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < cwd.length; i++) {
    h ^= cwd.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

const formatStartTs = (timeOrigin: number): string =>
  DateTime.make(timeOrigin).pipe(
    Option.match({
      onNone: () => "unknown",
      onSome: (date) =>
        DateTime.formatIso(date)
          .replace(/[-:T.]/g, "")
          .slice(0, 14),
    }),
  ) // YYYYMMDDHHMMSS

let cachedStartTs: Option.Option<string> = Option.none()
/**
 * Read the process-start timestamp, formatted YYYYMMDDHHMMSS. Lazy and
 * memoized so module import has no platform side effect, and so synchronous
 * callers (TUI logger module init) share the same value as Effect callers.
 */
const processStartTs = (): string => {
  if (Option.isSome(cachedStartTs)) return cachedStartTs.value
  const startTs = formatStartTs(performance.timeOrigin)
  cachedStartTs = Option.some(startTs)
  return startTs
}

interface LogPaths {
  readonly dir: string
  readonly log: string
  readonly client: string
}

/** The suffix each side writes. Owned here so readers never restate the rule. */
const LOG_SUFFIX = { server: "-server.log", client: "-client.log" } satisfies Record<
  "server" | "client",
  string
>

/** Which side wrote a log file, by name; `None` for anything else in the directory. */
export const classifyLogFile = (name: string): Option.Option<"server" | "client"> => {
  if (name.endsWith(LOG_SUFFIX.server)) return Option.some("server")
  if (name.endsWith(LOG_SUFFIX.client)) return Option.some("client")
  return Option.none()
}

/**
 * Build log paths for a given cwd identity. Pure — no I/O. App entrypoints
 * (e.g. TUI) that need a stable path before Effect startup can call this
 * directly; Effect-aware callers run {@link ensureLogDir} once at startup and
 * then call {@link buildLogPaths}.
 */
export const buildLogPaths = (cwd: string = FALLBACK_CWD_IDENTITY): LogPaths => {
  const prefix = `${hashCwd(cwd)}-${processStartTs()}`
  return {
    dir: LOG_DIR,
    log: `${LOG_DIR}/${prefix}${LOG_SUFFIX.server}`,
    client: `${LOG_DIR}/${prefix}${LOG_SUFFIX.client}`,
  }
}

/** Create the log directory if it doesn't exist. Call once at startup. */
export const ensureLogDir: Effect.Effect<void, never, FileSystem.FileSystem> = Effect.gen(
  function* () {
    const fs = yield* FileSystem.FileSystem
    yield* Effect.ignore(fs.makeDirectory(LOG_DIR, { recursive: true }))
  },
)

// ── logger ──────────────────────────────────────────────────────────────────

/**
 * Custom Effect Logger — one JSON line per entry, appended to a file.
 *
 * Based on loggingsucks.com principles: structured key-value data.
 *
 * Uses Effect.annotateLogs for context (sessionId, branchId, agent, model).
 * Uses Effect.withLogSpan for timing data.
 */

// =============================================================================
// Helpers
// =============================================================================

// oxlint-disable-next-line effect/noUnknownParameters -- Effect logger messages are an external logger boundary.
const extractMessage = (message: unknown): string => {
  if (Predicate.isString(message)) return message
  if (Array.isArray(message)) {
    return message
      .map((m) => {
        if (Predicate.isString(m)) return m
        return String(m)
      })
      .join(" ")
  }
  return String(message)
}

const decodeJsonValue = Schema.decodeUnknownOption(Schema.Json)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

type LogAnnotations =
  typeof CurrentLogAnnotations extends Context.Service<never, infer Value> ? Value : never

const collectAnnotations = (annotations: LogAnnotations) =>
  Object.fromEntries(
    Object.entries(annotations).map(([key, value]) => [
      key,
      Option.getOrElse(decodeJsonValue(value), () => String(value)),
    ]),
  )

const collectSpans = (spans: ReadonlyArray<[label: string, timestamp: number]>, now: number) =>
  Object.fromEntries(spans.map(([label, startTime]) => [label, now - startTime]))

// =============================================================================
// JSON File Logger
// =============================================================================

const formatJsonLogger: Logger.Logger<unknown, string> = Logger.make(
  ({ logLevel, message, fiber, date, cause }) => {
    const msg = extractMessage(message)
    const annotations = fiber.getRef(CurrentLogAnnotations)
    const spans = fiber.getRef(CurrentLogSpans)
    const annots = collectAnnotations(annotations)
    const now = date.getTime()
    const spanEntries = collectSpans(spans, now)

    const entry = Object.assign(
      {
        ts: date.toISOString(),
        level: logLevel,
        msg,
      },
      annots,
    )

    if (!Predicate.isUndefined(fiber.currentSpan)) {
      entry["traceId"] = fiber.currentSpan.traceId
      entry["spanId"] = fiber.currentSpan.spanId
      if (fiber.currentSpan._tag === "Span") {
        entry["spanName"] = fiber.currentSpan.name
      }
    }

    if (Object.keys(spanEntries).length > 0) {
      entry["spans"] = spanEntries
    }

    if (cause.reasons.length > 0) {
      entry["cause"] = Cause.pretty(cause).split("\n")[0] ?? "unknown error"
    }

    return encodeJson(entry)
  },
)

/**
 * Batched JSON file logger: one entry per line, appended to `path`, flushed
 * every 250 ms and once more when the scope closes. The server and the TUI
 * client both write this shape, so `gent doctor` reads one format.
 */
export const makeJsonFileLogger = (
  path: string,
): Effect.Effect<
  Logger.Logger<unknown, void>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const logFile = yield* fs.open(path, { flag: "a+" })
    const encoder = new TextEncoder()
    return yield* Logger.batched(formatJsonLogger, {
      window: 250,
      flush: (output) => Effect.ignore(logFile.write(encoder.encode(output.join("\n") + "\n"))),
    })
  })

// =============================================================================
// Config
// =============================================================================

const clearLogFile = (path: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* ensureLogDir
    const fs = yield* FileSystem.FileSystem
    yield* Effect.ignore(fs.writeFileString(path, ""))
  })

// =============================================================================
// Exported Layers
// =============================================================================

/**
 * JSON file logger under the cwd's server log path.
 *
 * Cwd is threaded explicitly from the dependency graph so the server log
 * path matches the launcher's resolved cwd. Falling back to ambient env
 * risked the two ends hashing different identities.
 */
const GentLogger = (cwd: string): Layer.Layer<never, never, FileSystem.FileSystem> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const logFile = buildLogPaths(cwd).log
      yield* clearLogFile(logFile)
      const jsonLogger = yield* makeJsonFileLogger(logFile)
      return Logger.layer([jsonLogger])
    }).pipe(Effect.orElseSucceed(() => Layer.empty)),
  )

/** The `GENT_LOG_LEVEL` names; each selects the one level of the same name. */
type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

const levelOf = (name: LogLevelName): LogLevel => {
  switch (name) {
    case "trace":
      return "Trace"
    case "debug":
      return "Debug"
    case "info":
      return "Info"
    case "warn":
      return "Warn"
    case "error":
      return "Error"
    case "fatal":
      return "Fatal"
  }
}

const LOG_LEVEL_NAMES: ReadonlyArray<LogLevelName> = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]

/**
 * Minimum log level from `GENT_LOG_LEVEL`. Unset keeps the Debug floor; a
 * name outside {@link LOG_LEVEL_NAMES} fails with a config error.
 */
export const GentLogLevel: Config.Config<LogLevel> = Config.literals(
  LOG_LEVEL_NAMES,
  "GENT_LOG_LEVEL",
).pipe(Config.withDefault<LogLevelName>("debug"), Config.map(levelOf))

/** File logger under `/tmp/gent/logs`, the `GENT_LOG_LEVEL` floor, and OTLP tracing when configured. */
export const GentObservability = (
  cwd: string,
  logLevel: LogLevel,
): Layer.Layer<never, never, FileSystem.FileSystem> =>
  Layer.mergeAll(GentLogger(cwd), Layer.succeed(MinimumLogLevel, logLevel), GentTracerLive)
