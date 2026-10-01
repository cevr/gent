import {
  Cause,
  Clock,
  Config,
  type Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  type PlatformError,
  Predicate,
  Record as EffectRecord,
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
 * Otherwise the Effect default Tracer (a no-op) is left in place, and the
 * OpenTelemetry SDK is never loaded: it costs a launch time to evaluate.
 */

const otlpEndpoint = Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT"))
const otlpServiceName = Config.option(Config.String("OTEL_SERVICE_NAME"))

/** The tracer SDK. A failed or interrupted load keeps nothing; the next build imports again. */
const loadTracerSdk = Effect.all(
  [
    // oxlint-disable-next-line effect/noDynamicImports -- the tracer SDK loads only when an endpoint is set
    Effect.tryPromise(() => import("@effect/opentelemetry/NodeSdk")),
    // oxlint-disable-next-line effect/noDynamicImports -- the tracer SDK loads only when an endpoint is set
    Effect.tryPromise(() => import("@opentelemetry/exporter-trace-otlp-http")),
    // oxlint-disable-next-line effect/noDynamicImports -- the tracer SDK loads only when an endpoint is set
    Effect.tryPromise(() => import("@opentelemetry/sdk-trace-base")),
  ],
  { concurrency: "unbounded" },
)

const GentTracerLive: Layer.Layer<never> = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* otlpEndpoint
    if (Option.isNone(endpoint)) return Layer.empty
    const serviceName = Option.getOrElse(yield* otlpServiceName, () => "gent")
    const [NodeSdk, { OTLPTraceExporter }, { BatchSpanProcessor }] = yield* loadTracerSdk
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
 * Log path resolution — logs follow the data directory, in
 * `<GENT_DATA_DIR or ~/.gent>/logs` (`dataPaths(home).logDir` in discovery.ts,
 * the data-path owner), so an isolated run keeps its logs beside its database
 * and its doctor reads them.
 *
 * Files are named by a short hash of the cwd + process start timestamp so
 * multiple gent instances don't clobber each other and old logs are easy to
 * identify by time. Nothing outside gent clears the directory, so
 * {@link ensureLogDir} removes log files older than {@link LOG_RETENTION}.
 *
 * File naming: `<hash>-<ts>-server.log`, `<hash>-<ts>-client.log`
 */

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

/**
 * Read the process-start timestamp, formatted YYYYMMDDHHMMSS. It is read on
 * call, so module import has no platform side effect. The process's time
 * origin never changes, so synchronous callers (TUI logger module init) and
 * Effect callers read the same value.
 */
const processStartTs = (): string => formatStartTs(performance.timeOrigin)

interface LogPaths {
  readonly log: string
  readonly client: string
}

/** The suffix each side writes. Owned here so readers never restate the rule. */
const LOG_SUFFIX = { server: "-server.log", client: "-client.log" } satisfies Record<
  "server" | "client",
  string
>

/** The whole name {@link buildLogPaths} gives a file: cwd hash, start time, side. */
const GENERATED_LOG_NAME = /^[0-9a-f]{8}-(?:\d{14}|unknown)-(?:server|client)\.log$/

/**
 * Which side wrote a log file, by name; `None` for anything else in the
 * directory, such as `notes-server.log`: only a name gent generated is a log.
 */
export const classifyLogFile = (name: string): Option.Option<"server" | "client"> => {
  if (!GENERATED_LOG_NAME.test(name)) return Option.none()
  if (name.endsWith(LOG_SUFFIX.server)) return Option.some("server")
  return Option.some("client")
}

/**
 * Build log paths for a given cwd identity. Pure — no I/O. App entrypoints
 * (e.g. TUI) that need a stable path before Effect startup can call this
 * directly; Effect-aware callers run {@link ensureLogDir} once at startup and
 * then call {@link buildLogPaths}.
 */
export const buildLogPaths = (cwd: string, dir: string): LogPaths => {
  const prefix = `${hashCwd(cwd || FALLBACK_CWD_IDENTITY)}-${processStartTs()}`
  return {
    log: `${dir}/${prefix}${LOG_SUFFIX.server}`,
    client: `${dir}/${prefix}${LOG_SUFFIX.client}`,
  }
}

/** How long a log file stays after its last write. */
const LOG_RETENTION = Duration.days(14)

/**
 * Remove `name` from `dir` when it is a regular file with a name gent
 * generated, last written before `cutoff`.
 */
const pruneLogFile = (dir: string, name: string, cutoff: number) =>
  Effect.gen(function* () {
    if (Option.isNone(classifyLogFile(name))) return
    const fs = yield* FileSystem.FileSystem
    const path = `${dir}/${name}`
    const info = yield* fs.stat(path)
    if (info.type !== "File") return
    if (Option.exists(info.mtime, (date) => date.getTime() < cutoff)) yield* fs.remove(path)
  }).pipe(Effect.ignore)

/**
 * Create the log directory if it doesn't exist, and remove the gent logs in it
 * last written more than {@link LOG_RETENTION} ago. Call once at startup. A
 * file it cannot read or remove is left as it is.
 *
 * A pruned log may belong to a live, idle process: the names carry no pid.
 * No writer holds its file open, so that process's next flush writes the file
 * again, and no line goes to an unlinked file.
 */
export const ensureLogDir = (dir: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* Effect.ignore(fs.makeDirectory(dir, { recursive: true }))
    const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(LOG_RETENTION)
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
    yield* Effect.forEach(names, (name) => pruneLogFile(dir, name, cutoff), { discard: true })
  })

// ── logger ──────────────────────────────────────────────────────────────────

/**
 * Custom Effect Logger — one JSON line per entry, appended to a file, its
 * context as structured key-value data.
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
  if (Array.isArray(message)) return message.map(String).join(" ")
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

    const span = fiber.cache.span
    if (!Predicate.isUndefined(span)) {
      entry["traceId"] = span.traceId
      entry["spanId"] = span.spanId
      if (span._tag === "Span") {
        entry["spanName"] = span.name
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
 * client both write this shape, so `gent doctor` reads one format. The file
 * exists once this returns. Each flush appends by path and holds no
 * descriptor: a file pruned while this logger is idle comes back at its next
 * flush.
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
    const encoder = new TextEncoder()
    const append = (bytes: Uint8Array) => fs.writeFile(path, bytes, { flag: "a" })
    yield* append(new Uint8Array())
    return yield* Logger.batched(formatJsonLogger, {
      window: 250,
      flush: (output) => Effect.ignore(append(encoder.encode(output.join("\n") + "\n"))),
    })
  })

// =============================================================================
// Exported Layers
// =============================================================================

/**
 * JSON file logger under the cwd's server log path.
 *
 * The cwd comes from the dependency graph, never the ambient environment, so
 * the server and its launcher hash one identity and share one log path.
 */
const GentLogger = (
  cwd: string,
  logDir: string,
): Layer.Layer<never, never, FileSystem.FileSystem> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const logFile = buildLogPaths(cwd, logDir).log
      // Appended, never cleared: the name is per process start, so the only
      // earlier lines belong to another logger of this process.
      yield* ensureLogDir(logDir)
      const jsonLogger = yield* makeJsonFileLogger(logFile)
      return Logger.layer([jsonLogger])
    }).pipe(Effect.orElseSucceed(() => Layer.empty)),
  )

/** The `GENT_LOG_LEVEL` names; each selects the one level of the same name. */
const LOG_LEVELS = {
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
  fatal: "Fatal",
} as const satisfies Record<string, LogLevel>
type LogLevelName = keyof typeof LOG_LEVELS

/**
 * Minimum log level from `GENT_LOG_LEVEL`. Unset keeps the Debug floor; a
 * name outside {@link LOG_LEVELS} fails with a config error.
 */
export const GentLogLevel: Config.Config<LogLevel> = Config.Literals(
  EffectRecord.keys(LOG_LEVELS),
  "GENT_LOG_LEVEL",
).pipe(
  Config.withDefault<LogLevelName>("debug"),
  Config.map((name) => LOG_LEVELS[name]),
)

/** File logger under `logDir`, the `GENT_LOG_LEVEL` floor, and OTLP tracing when configured. */
export const GentObservability = (
  cwd: string,
  logLevel: LogLevel,
  logDir: string,
): Layer.Layer<never, never, FileSystem.FileSystem> =>
  Layer.mergeAll(GentLogger(cwd, logDir), Layer.succeed(MinimumLogLevel, logLevel), GentTracerLive)
