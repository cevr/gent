import {
  Cause,
  Clock,
  Config,
  ConfigProvider,
  Context,
  Duration,
  Effect,
  FileSystem,
  Crypto,
  Encoding,
  Equal,
  FiberSet,
  JsonSchema,
  Layer,
  Option,
  Path,
  Predicate,
  RcMap,
  Result,
  Schema,
  SchemaRepresentation,
  Semaphore,
} from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ErrorCode, McpError as ProtocolError } from "@modelcontextprotocol/sdk/types.js"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  hasProjectScope,
  isRecord,
  omitUndefined,
  request,
  resolveDataDir,
  tool,
  ToolResultFailure,
  writeFileAtomic,
} from "@gent/core/extensions/api"

// Test seam: `McpServers` (the extension over inline servers) and the config
// and catalog schemas are read by tests; the shipped extension is
// `McpExtension`, which reads the `mcp.json` files.

// ── config ──────────────────────────────────────────────────────────────────

/**
 * One MCP server in the `mcpServers` shape Claude Code, Cursor, pi and
 * opencode share, so an entry pasted from any of them works. A `command`
 * entry runs over stdio; a `url` entry over streamable HTTP or SSE. Strings
 * may name environment variables as `${NAME}` or `${NAME:-default}`.
 */
const Shared = {
  /** `false` keeps the entry without starting it. */
  enabled: Schema.optional(Schema.Boolean),
  /** Bound on connecting and on each call, in milliseconds. */
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
}

const StdioServerConfig = Schema.Struct({
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optional(Schema.String),
  ...Shared,
})

const HttpServerConfig = Schema.Struct({
  url: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * The transport, as Claude Code writes it: `http` (or `streamable-http`)
   * or `sse`. Absent or `auto`, streamable HTTP is tried first, then SSE.
   */
  type: Schema.optional(Schema.Literals(["http", "streamable-http", "sse", "auto"])),
  ...Shared,
})

const McpServerConfig = Schema.Union([StdioServerConfig, HttpServerConfig])
type McpServerConfig = typeof McpServerConfig.Type

const McpConfigFile = Schema.Struct({
  mcpServers: Schema.optional(Schema.Record(Schema.String, McpServerConfig)),
})

/** A configured server under its id segment, with its variables expanded. */
interface McpServer {
  /** The id segment: `mcp.<name>.<tool>`. */
  readonly name: string
  /** The catalog cache key and connection key: the digest of `serverIdentity`. */
  readonly key: string
  readonly config: McpServerConfig
  /** The directory a stdio server runs in: its `cwd` resolved against the session's. */
  readonly cwd: string
}

const encodeKeyFields = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const compareCodeUnits = (left: string, right: string) => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const sortedEntries = (record: Readonly<Record<string, string>> = {}) =>
  Object.entries(record).toSorted(([left], [right]) => compareCodeUnits(left, right))

/**
 * What decides the tools a server lists: the entry as it runs, after
 * expansion, and for a stdio server the directory it runs in, in a fixed
 * order so key order never matters. It holds secrets, so only its SHA-256
 * digest is kept.
 */
const serverIdentity = (written: string, config: McpServerConfig, cwd: string) => {
  if ("command" in config) {
    return encodeKeyFields([
      written,
      "stdio",
      config.command,
      config.args ?? [],
      sortedEntries(config.env),
      cwd,
      config.timeoutMs ?? 0,
    ])
  }
  return encodeKeyFields([
    written,
    "http",
    config.url,
    sortedEntries(config.headers),
    config.timeoutMs ?? 0,
  ])
}

const serverKey = Effect.fn("Mcp.serverKey")(function* (
  written: string,
  config: McpServerConfig,
  cwd: string,
) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(serverIdentity(written, config, cwd)),
  )
  return Encoding.encodeHex(digest)
})

/** Default bound on connecting to a server and on each call. */
const DEFAULT_TIMEOUT_MS = 30_000
/** A connection nobody used for this long closes; the next call opens it again. */
const IDLE_TIME_TO_LIVE = Duration.minutes(5)
/**
 * The wire name `mcp__<server>__<tool>` must fit in 64 characters (the
 * limit every provider accepts), so server and tool segments share 57.
 */
const WIRE_SEGMENTS_LIMIT = 64 - "mcp____".length
const SERVER_SEGMENT_LIMIT = 20

const trimUnderscores = (text: string) => text.replace(/^_+/, "").replace(/_+$/, "")

/**
 * A name as an id segment in the host's tool id grammar: runs of
 * `[A-Za-z0-9-]` joined by one `_` (so no `__`, the wire separator, and no
 * `_` at either end), cut to `limit`, and `fallback` when nothing is left.
 */
const idSegment = (name: string, limit: number, fallback: string) => {
  const segment = trimUnderscores(
    trimUnderscores(name.replaceAll(/[^A-Za-z0-9-]+/g, "_")).slice(0, limit),
  )
  if (segment === "") return fallback
  return segment
}

/**
 * A distinct segment for each name. Names take their segments in code-unit
 * order; a name whose segment is taken gets the first free `_2`, `_3`, ...,
 * cut so the whole stays within `limit`. The same names always get the same
 * segments, and no name is dropped.
 */
const allocateSegments = (
  names: ReadonlyArray<string>,
  limit: number,
  fallback: string,
): ReadonlyMap<string, string> => {
  const allocated = new Map<string, string>()
  const taken = new Set<string>()
  for (const name of [...new Set(names)].toSorted(compareCodeUnits)) {
    const base = idSegment(name, limit, fallback)
    let segment = base
    for (let suffix = 2; taken.has(segment); suffix++) {
      segment = `${trimUnderscores(base.slice(0, limit - `_${suffix}`.length))}_${suffix}`
    }
    taken.add(segment)
    allocated.set(name, segment)
  }
  return allocated
}

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** `${NAME}` and `${NAME:-default}` from the environment; an unset one without a default is a failure. */
const expandVariables = Effect.fn("Mcp.expandVariables")(function* (text: string) {
  const values = new Map<string, string>()
  for (const [match, name = "", fallback] of text.matchAll(VARIABLE)) {
    const value = yield* Config.option(Config.string(name)).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    const resolved = Option.orElse(value, () => Option.fromUndefinedOr(fallback))
    if (Option.isNone(resolved))
      return yield* Effect.fail(`environment variable ${name} is not set`)
    values.set(match, resolved.value)
  }
  // A callback, so a value's `$&` or `$1` is text, not a replacement pattern.
  return text.replaceAll(VARIABLE, (match) => values.get(match) ?? match)
})

const expandRecord = (record: Option.Option<Readonly<Record<string, string>>>) =>
  Effect.forEach(Object.entries(Option.getOrElse(record, () => ({}))), ([key, value]) =>
    Effect.map(expandVariables(value), (text): readonly [string, string] => [key, text]),
  ).pipe(Effect.map((entries): Record<string, string> => Object.fromEntries(entries)))

const expandConfig = (config: McpServerConfig): Effect.Effect<McpServerConfig, string> => {
  if ("command" in config) {
    return Effect.gen(function* () {
      return {
        ...config,
        command: yield* expandVariables(config.command),
        args: yield* Effect.forEach(config.args ?? [], expandVariables),
        env: yield* expandRecord(Option.fromUndefinedOr(config.env)),
      }
    })
  }
  return Effect.gen(function* () {
    return {
      ...config,
      url: yield* expandVariables(config.url),
      headers: yield* expandRecord(Option.fromUndefinedOr(config.headers)),
    }
  })
}

/** A file that is missing has no servers; one that does not decode is reported and skipped. */
const readConfigFile = Effect.fn("Mcp.readConfigFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return {}
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(McpConfigFile))),
    Effect.map((decoded) => decoded.mcpServers ?? {}),
    Effect.catchCause((cause) =>
      Effect.logWarning("mcp.config.unreadable").pipe(
        Effect.annotateLogs({ file, error: String(cause) }),
        Effect.as({}),
      ),
    ),
  )
})

const UserTrust = Schema.fromJsonString(
  Schema.Struct({ trustedProjects: Schema.optional(Schema.Array(Schema.String)) }),
)

/**
 * A project's servers run commands, so its `.gent/mcp.json` counts only when
 * the user config trusts the project root, the rule project extensions follow.
 */
const projectTrusted = Effect.fn("Mcp.projectTrusted")(function* (home: string, cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (!(yield* hasProjectScope({ user: home, project: cwd }))) return false
  const trusted = yield* fs.readFileString(path.join(home, ".gent", "config.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(UserTrust)),
    Effect.map((config) => config.trustedProjects ?? []),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  )
  return yield* fs.realPath(cwd).pipe(
    Effect.map((root) => trusted.includes(root)),
    Effect.orElseSucceed(() => false),
  )
})

/**
 * The servers `~/.gent/mcp.json` names, and a trusted project's
 * `.gent/mcp.json` over them by name. A disabled entry, or one whose variables
 * do not expand, is left out with a warning.
 */
const readMcpConfig = Effect.fn("Mcp.readConfig")(function* (home: string, cwd: string) {
  const path = yield* Path.Path
  const user = yield* readConfigFile(path.join(home, ".gent", "mcp.json"))
  let project = {}
  if (yield* projectTrusted(home, cwd)) {
    project = yield* readConfigFile(path.join(cwd, ".gent", "mcp.json"))
  }
  return { ...user, ...project }
})

/** An enabled entry that cannot run, and why; `mcp.status` reports it. */
interface MisconfiguredServer {
  readonly name: string
  readonly config: McpServerConfig
  readonly reason: string
}

/**
 * The enabled entries as servers, and the ones whose variables do not expand
 * or whose key cannot be computed, which are reported and never started.
 */
const resolveServers = Effect.fn("Mcp.resolveServers")(function* (
  entries: Readonly<Record<string, McpServerConfig>>,
  sessionCwd: string,
) {
  const path = yield* Path.Path
  const servers: Array<McpServer> = []
  const misconfigured: Array<MisconfiguredServer> = []
  const enabled = Object.entries(entries)
    .filter(([, config]) => config.enabled !== false)
    .toSorted(([left], [right]) => compareCodeUnits(left, right))
  const names = allocateSegments(
    enabled.map(([written]) => written),
    SERVER_SEGMENT_LIMIT,
    "server",
  )
  for (const [written, config] of enabled) {
    const name = names.get(written) ?? "server"
    const expanded = yield* Effect.result(expandConfig(config))
    if (Result.isFailure(expanded)) {
      yield* Effect.logWarning("mcp.server.config").pipe(
        Effect.annotateLogs({ server: written, error: expanded.failure }),
      )
      misconfigured.push({ name, config, reason: expanded.failure })
      continue
    }
    let cwd = sessionCwd
    if ("command" in expanded.success && Predicate.isNotUndefined(expanded.success.cwd)) {
      cwd = path.resolve(sessionCwd, expanded.success.cwd)
    }
    const key = yield* Effect.result(serverKey(written, expanded.success, cwd))
    if (Result.isFailure(key)) {
      yield* Effect.logWarning("mcp.server.key").pipe(
        Effect.annotateLogs({ server: written, error: key.failure.message }),
      )
      misconfigured.push({ name, config, reason: key.failure.message })
      continue
    }
    servers.push({ name, key: key.success, config: expanded.success, cwd })
  }
  return { servers, misconfigured }
})

// ── catalog cache ───────────────────────────────────────────────────────────

/** One tool as `tools/list` describes it; the rest of its fields are ignored. */
const CatalogTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Json,
  outputSchema: Schema.optional(Schema.Json),
  annotations: Schema.optional(
    Schema.Struct({
      readOnlyHint: Schema.optional(Schema.Boolean),
      destructiveHint: Schema.optional(Schema.Boolean),
    }),
  ),
})
type CatalogTool = typeof CatalogTool.Type

const ListToolsPage = Schema.Struct({
  tools: Schema.Array(CatalogTool),
  nextCursor: Schema.optional(Schema.String),
})

/** A server's tools and the `instructions` its `initialize` answer carried, if any. */
const CatalogServer = Schema.Struct({
  tools: Schema.Array(CatalogTool),
  instructions: Schema.optional(Schema.String),
})
type CatalogServer = typeof CatalogServer.Type

/** Each server's entry, keyed by the hash of its config, so an edited entry lists again. */
const CatalogFile = Schema.fromJsonString(
  Schema.Struct({ servers: Schema.Record(Schema.String, CatalogServer) }),
)
type CatalogFile = typeof CatalogFile.Type

const catalogPath = Effect.fn("Mcp.catalogPath")(function* (home: string) {
  const path = yield* Path.Path
  return path.join(yield* resolveDataDir(home), "mcp-catalog.json")
})

const readCatalog = Effect.fn("Mcp.readCatalog")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CatalogFile)),
    Effect.orElseSucceed((): CatalogFile => ({ servers: {} })),
  )
})

/**
 * Merge servers' tools into the cache file in one read and one write. Setup
 * writes every server it listed at once, and the connections write under one
 * permit, so no entry is lost to another's write in this process. A write
 * another gent process races can still lose an entry; that costs one relist.
 */
const writeCatalogEntries = Effect.fn("Mcp.writeCatalogEntries")(function* (
  file: string,
  entries: ReadonlyArray<readonly [key: string, server: CatalogServer]>,
) {
  if (entries.length === 0) return
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const current = yield* readCatalog(file)
  const servers = { ...current.servers }
  for (const [key, server] of entries) servers[key] = server
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* writeFileAtomic(file, yield* Schema.encodeEffect(CatalogFile)({ servers }))
})

// ── binary files ────────────────────────────────────────────────────────────

/** A binary block larger than this is not written; its entry keeps its size and has no path. */
const BLOB_FILE_LIMIT_MIB = 20
const BLOB_FILE_LIMIT = BLOB_FILE_LIMIT_MIB * 1024 * 1024
/** A file in `mcp-blobs` last written longer ago than this is removed, once per process. */
const BLOB_MAX_AGE = Duration.days(14)

const BLOB_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/ogg", "ogg"],
  ["application/pdf", "pdf"],
  ["application/json", "json"],
  ["text/plain", "txt"],
])

/** The file extension of a MIME type; any other type is `bin`. */
const blobExtension = (mimeType: Option.Option<string>) =>
  Option.getOrElse(
    Option.flatMap(mimeType, (type) =>
      Option.fromUndefinedOr(BLOB_EXTENSIONS.get(type.split(";")[0]?.trim().toLowerCase() ?? "")),
    ),
    () => "bin",
  )

const blobDirectory = Effect.fn("Mcp.blobDirectory")(function* (home: string) {
  const path = yield* Path.Path
  return path.join(yield* resolveDataDir(home), "mcp-blobs")
})

/** Removes the files in `directory` last written more than `BLOB_MAX_AGE` ago. */
const pruneBlobs = Effect.fn("Mcp.pruneBlobs")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const now = yield* Clock.currentTimeMillis
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  for (const name of names) {
    const file = path.join(directory, name)
    const written = Option.flatMap(yield* Effect.option(fs.stat(file)), (info) => info.mtime)
    if (Option.isSome(written) && now - written.value.getTime() > Duration.toMillis(BLOB_MAX_AGE)) {
      yield* fs.remove(file).pipe(Effect.ignore)
    }
  }
})

/**
 * Writes the binary blocks of a call result to `directory`, each once, as
 * `<sha256>.<ext>`, so the cell reads them with Bun. A block past
 * `BLOB_FILE_LIMIT`, or one that cannot be decoded or written, gets no file.
 * The first write of the process removes files older than `BLOB_MAX_AGE`.
 */
const makeBlobStore = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const prune = yield* Effect.cached(
      pruneBlobs(directory).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("mcp.blobs.prune.failed").pipe(
            Effect.annotateLogs({ error: String(cause) }),
          ),
        ),
      ),
    )
    const saveOne = (data: string, mimeType: Option.Option<string>) =>
      Effect.gen(function* () {
        if (base64Bytes(data) > BLOB_FILE_LIMIT) return Option.none<string>()
        const bytes = Encoding.decodeBase64(data)
        if (Result.isFailure(bytes) || bytes.success.length > BLOB_FILE_LIMIT) {
          return Option.none<string>()
        }
        yield* prune
        const digest = Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes.success))
        const file = path.join(directory, `${digest}.${blobExtension(mimeType)}`)
        if (!(yield* fs.exists(file))) {
          yield* fs.makeDirectory(directory, { recursive: true })
          yield* writeFileAtomic(file, bytes.success)
        }
        return Option.some(file)
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.catchCause((cause) =>
          Effect.logWarning("mcp.blob.unwritten").pipe(
            Effect.annotateLogs({ error: String(cause) }),
            Effect.as(Option.none<string>()),
          ),
        ),
      )
    return {
      /** Each content block's file by index; none for a block that is not binary or was not written. */
      save: (content: ReadonlyArray<Schema.Json>) =>
        Effect.forEach(content, (block) =>
          Option.match(binaryOf(block), {
            onNone: () => Effect.succeed(Option.none<string>()),
            onSome: (binary) => saveOne(binary.data, Option.fromUndefinedOr(binary.mimeType)),
          }),
        ),
    }
  })

// ── connections ─────────────────────────────────────────────────────────────

class McpError extends Schema.TaggedError<McpError>()("McpError", {
  server: Schema.String,
  message: Schema.String,
  /** The HTTP status the server answered a connect with, when it did. */
  status: Schema.optional(Schema.Int),
}) {}

const failureMessage = (cause: unknown) => {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

const timeoutOf = (server: McpServer) => server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS

/**
 * The environment of this process. A stdio server runs with it, under its
 * entry's `env`, as bash and the cell do: a proxy or CA variable in the
 * user's shell reaches the server, and a restricted list would protect
 * nothing the cell cannot already run (decided by consistency with bash and
 * the cell; the cell runs full Bun).
 */
const hostEnvironment = Effect.gen(function* () {
  const provider = yield* ConfigProvider.ConfigProvider
  const environment = new Map<string, string>()
  // The environment provider nests a name at each `_`; the walk joins the path back.
  const walk = (path: ReadonlyArray<string>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const loaded = yield* provider.load(path).pipe(
        Effect.map(Option.fromUndefinedOr),
        Effect.orElseSucceed(() => Option.none()),
      )
      if (Option.isNone(loaded)) return
      const node = loaded.value
      if (Predicate.isString(node.value) && path.length > 0) {
        environment.set(path.join("_"), node.value)
      }
      let children: ReadonlyArray<string> = []
      if (node._tag === "Record") children = [...node.keys]
      if (node._tag === "Array") {
        children = Array.from({ length: node.length }, (_, index) => String(index))
      }
      yield* Effect.forEach(children, (child) => walk([...path, child]), { discard: true })
    })
  yield* walk([])
  return Object.fromEntries(environment)
})

/** The transport a connection runs over. */
const TransportKind = Schema.Literals(["stdio", "streamable-http", "sse"])
type TransportKind = typeof TransportKind.Type

const transportFor = (
  server: McpServer,
  kind: TransportKind,
  environment: Readonly<Record<string, string>>,
) => {
  const config = server.config
  if ("command" in config) {
    return new StdioClientTransport({
      command: config.command,
      args: [...(config.args ?? [])],
      env: { ...environment, ...config.env },
      cwd: server.cwd,
      // The server's own log would land in the terminal gent draws.
      stderr: "ignore",
    })
  }
  const options = { requestInit: { headers: { ...config.headers } } }
  if (kind === "sse") return new SSEClientTransport(new URL(config.url), options)
  return new StreamableHTTPClientTransport(new URL(config.url), options)
}

/** The HTTP status a failed connect was answered with, when it has one. */
const statusOf = (cause: unknown): Option.Option<number> => {
  if (cause instanceof StreamableHTTPError || cause instanceof SseError) {
    return Option.fromUndefinedOr(cause.code)
  }
  return Option.none()
}

/**
 * Statuses that say the server does not speak streamable HTTP at this URL,
 * so `auto` tries SSE. 401 and 403 are about the credential, which SSE
 * would refuse too, so they never fall back.
 */
const SSE_FALLBACK_STATUSES: ReadonlySet<number> = new Set([400, 404, 405, 406, 415, 422, 501])

/** A close that has not finished within this long is abandoned. */
const CLOSE_TIMEOUT = Duration.seconds(2)

/** An initialized client over `kind`; closing its scope closes the transport. */
const dial = (
  server: McpServer,
  kind: TransportKind,
  environment: Readonly<Record<string, string>>,
  onToolsChanged: Option.Option<() => void>,
) =>
  Effect.gen(function* () {
    const listChanged = Option.match(onToolsChanged, {
      onNone: () => ({}),
      onSome: (onChanged) => ({
        listChanged: { tools: { autoRefresh: false, onChanged: () => onChanged() } },
      }),
    })
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new Client({ name: "gent", version: "1.0.0" }, listChanged)),
      (opened) =>
        Effect.tryPromise(() => opened.close()).pipe(Effect.timeout(CLOSE_TIMEOUT), Effect.ignore),
    )
    yield* Effect.tryPromise({
      try: () => client.connect(transportFor(server, kind, environment)),
      catch: (cause) =>
        new McpError({
          server: server.name,
          message: `connect: ${failureMessage(cause)}`,
          ...omitUndefined({ status: Option.getOrUndefined(statusOf(cause)) }),
        }),
    })
    return {
      client,
      transport: kind,
      instructions: Option.fromUndefinedOr(client.getInstructions()),
    }
  })

/**
 * An initialized client and the transport it runs over; closing its scope
 * closes the transport, and a stdio server with it. A `url` entry's `type`
 * picks the transport: `http` (or `streamable-http`) and `sse` pin one, and
 * `auto`, the default, tries streamable HTTP and then SSE when the server
 * answers with a status in `SSE_FALLBACK_STATUSES`. `onToolsChanged` runs on
 * each `notifications/tools/list_changed` of a server that declares it sends
 * them.
 */
const connect = (server: McpServer, onToolsChanged: Option.Option<() => void> = Option.none()) =>
  Effect.gen(function* () {
    const config = server.config
    if ("command" in config) {
      return yield* dial(server, "stdio", yield* hostEnvironment, onToolsChanged)
    }
    const type = config.type ?? "auto"
    if (type === "sse") return yield* dial(server, "sse", {}, onToolsChanged)
    const streamable = dial(server, "streamable-http", {}, onToolsChanged)
    if (type !== "auto") return yield* streamable
    return yield* streamable.pipe(
      Effect.catchTag("McpError", (error) => {
        if (!SSE_FALLBACK_STATUSES.has(error.status ?? 0)) return Effect.fail(error)
        return dial(server, "sse", {}, onToolsChanged).pipe(
          Effect.mapError(
            (sse) =>
              new McpError({
                server: server.name,
                message: `streamable HTTP ${error.message}; SSE ${sse.message}`,
              }),
          ),
        )
      }),
    )
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutOf(server),
      orElse: () =>
        Effect.fail(
          new McpError({
            server: server.name,
            message: `connect timed out after ${timeoutOf(server)} ms`,
          }),
        ),
    }),
  )

/** Every page of `tools/list`. */
const listTools = (server: McpServer, client: Client) =>
  Effect.gen(function* () {
    const tools: Array<CatalogTool> = []
    let cursor = Option.none<string>()
    for (let page = 0; page < 100; page++) {
      const params = Option.match(cursor, {
        onNone: () => ({}),
        onSome: (value) => ({ cursor: value }),
      })
      const listed = yield* Effect.tryPromise({
        try: (signal) => client.listTools(params, { signal, timeout: timeoutOf(server) }),
        catch: (cause) =>
          new McpError({ server: server.name, message: `tools/list: ${failureMessage(cause)}` }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ListToolsPage)),
        Effect.mapError(
          (error) => new McpError({ server: server.name, message: failureMessage(error) }),
        ),
      )
      tools.push(...listed.tools)
      cursor = Option.fromUndefinedOr(listed.nextCursor)
      if (Option.isNone(cursor)) break
    }
    return tools
  })

/** The result fields a call reads; content blocks stay JSON. */
const CallResult = Schema.Struct({
  content: Schema.optional(Schema.Array(Schema.Json)),
  structuredContent: Schema.optional(Schema.Json),
  isError: Schema.optional(Schema.Boolean),
})
type CallResult = typeof CallResult.Type

/**
 * What a failed call says about its connection. `answered`: the server sent
 * a JSON-RPC error, so the connection is sound. `expired`: HTTP 404, a
 * session the server no longer knows, so it ran nothing. `dead`: the
 * transport failed (the connection closed, the call timed out, HTTP 400, 401
 * or 408, a network error). `kept`: any other HTTP status, which says nothing
 * about the connection. `stale`: the server answered that it has no such
 * tool, so the catalog is out of date.
 */
const CallFailureKind = Schema.Literals(["answered", "expired", "dead", "kept", "stale"])
type CallFailureKind = typeof CallFailureKind.Type

const staleMessage = (name: string) =>
  `the server no longer lists ${name}; the tool catalog was stale, and the next session registers the current list`

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Whether a server's answer says it has no tool `name`: the spec's
 * `Unknown tool: name` (a -32602 error), or the TypeScript SDK server's
 * `Tool name not found` (an `isError` result). The name is matched exactly,
 * so a tool error that only mentions "not found" does not match.
 */
const isUnknownToolMessage = (message: string, name: string) =>
  new RegExp(
    `(?:unknown tool:?\\s*"?${escapeRegExp(name)}"?|tool\\s+"?${escapeRegExp(name)}"?\\s+(?:not found|is not available|does not exist))`,
    "i",
  ).test(message)

/** HTTP statuses that end a connection: the request, the credential, or the session is bad. */
const DEAD_STATUSES: ReadonlySet<number> = new Set([400, 401, 408])

/** JSON-RPC codes the SDK raises itself, for a closed connection or a timeout; no server sent them. */
const CLIENT_RAISED: ReadonlySet<number> = new Set<number>([
  ErrorCode.ConnectionClosed,
  ErrorCode.RequestTimeout,
])
const INVALID_PARAMS: number = ErrorCode.InvalidParams

const failureKind = (cause: unknown, name: string): CallFailureKind => {
  if (cause instanceof ProtocolError) {
    if (CLIENT_RAISED.has(cause.code)) return "dead"
    if (cause.code === INVALID_PARAMS && isUnknownToolMessage(cause.message, name)) return "stale"
    return "answered"
  }
  if (cause instanceof StreamableHTTPError) {
    if (cause.code === 404) return "expired"
    if (DEAD_STATUSES.has(cause.code ?? 0)) return "dead"
    return "kept"
  }
  return "dead"
}

/** A failed call on one connection, and whether that connection had served a call before. */
class CallFailed extends Schema.TaggedError<CallFailed>()("CallFailed", {
  kind: CallFailureKind,
  reused: Schema.Boolean,
  message: Schema.String,
}) {}

/**
 * A server's health as `mcp.status` reports it: `healthy` once a connect and
 * its list worked, `expired` when the server refused the credential (401 or
 * 403), `misconfigured` when the entry cannot run, `degraded` when the last
 * connect, list or call failed or the server listed no tools, and `unknown`
 * while this process has not connected to it.
 */
const McpHealth = Schema.Literals(["healthy", "expired", "misconfigured", "degraded", "unknown"])
type McpHealth = typeof McpHealth.Type

const McpServerStatus = Schema.Struct({
  /** The id segment: `mcp.<name>.<tool>`. */
  name: Schema.String,
  /** The transport the open connection uses, else the one the entry names. */
  transport: Schema.Literals(["stdio", "streamable-http", "sse", "auto"]),
  health: McpHealth,
  connected: Schema.Boolean,
  tools: Schema.Int,
  /** The `instructions` of the server's `initialize` answer. */
  description: Schema.optional(Schema.String),
  /** Why the health is not `healthy` or `unknown`. */
  reason: Schema.optional(Schema.String),
})
type McpServerStatus = typeof McpServerStatus.Type

const McpStatus = Schema.Struct({ servers: Schema.Array(McpServerStatus) })
type McpStatus = typeof McpStatus.Type

/** The transport an entry names before any connection opens. */
const configuredTransport = (config: McpServerConfig): McpServerStatus["transport"] => {
  if ("command" in config) return "stdio"
  if (config.type === "http") return "streamable-http"
  return config.type ?? "auto"
}

interface McpClientsService {
  /** Calls one tool on a server, opening its connection on first use. */
  readonly call: (
    server: McpServer,
    tool: string,
    input: Readonly<Record<string, Schema.Json>>,
  ) => Effect.Effect<CallResult, McpError>
  /** Every configured server as this process sees it now, by name. */
  readonly status: Effect.Effect<McpStatus>
  /** Writes a result's binary blocks to files (see `makeBlobStore`); each block's file by index. */
  readonly saveBlobs: (
    content: ReadonlyArray<Schema.Json>,
  ) => Effect.Effect<ReadonlyArray<Option.Option<string>>>
}

/**
 * The open connections of this process, one per server entry. A server's
 * first call connects; a connection idle for `IDLE_TIME_TO_LIVE` closes. A
 * failed connect is not kept, so the next call tries again.
 */
class McpClients extends Context.Service<McpClients, McpClientsService>()(
  "@gent/extensions/src/mcp/McpClients",
) {}

/** A server this process registered, with what its registration read. */
interface RegisteredServer extends SetupCatalog {
  readonly server: McpServer
}

interface ServerHealth {
  readonly health: McpHealth
  readonly reason: Option.Option<string>
}

/** A refused credential is `expired`; any other failure leaves the server `degraded`. */
const failureHealth = (error: McpError): ServerHealth => {
  let health: McpHealth = "degraded"
  if (error.status === 401 || error.status === 403) health = "expired"
  return { health, reason: Option.some(error.message) }
}

/** A server listed at setup is `healthy`; one read from the cache is `unknown` until it connects. */
const setupHealth = (entry: RegisteredServer): ServerHealth =>
  Option.match(entry.failure, {
    onSome: failureHealth,
    onNone: (): ServerHealth => {
      if (entry.listedNow) return { health: "healthy", reason: Option.none() }
      return { health: "unknown", reason: Option.none() }
    },
  })

/** An open connection and the tool names the server listed last. */
interface Connection {
  readonly client: Client
  readonly transport: TransportKind
  readonly instructions: Option.Option<string>
  listed: ReadonlySet<string>
  /** Set when the transport closed: the stdio server exited, or the HTTP transport ended. */
  closed: boolean
  /** Calls started on this connection. */
  calls: number
}

/**
 * The connections of `registered`, each under its cache key, which names one
 * entry. The server's tools are listed again when a connection opens, when
 * the server sends `notifications/tools/list_changed`, and when it answers a
 * call as an unknown tool: a tool it no longer lists fails its call by name,
 * and a list that differs from the last one is written to the cache, so the
 * next session registers it. The current session keeps the tools it
 * registered; changing them live needs a host seam to re-register an
 * extension's tools.
 *
 * A connection is dropped when its transport closes and when a call on it
 * fails in the transport (see `failureKind`); a JSON-RPC error leaves it
 * open. A connection that closed before a call starts is replaced before the
 * call is sent. A call on a reused connection answered 404 (the server
 * forgot the session, so it ran nothing) is sent once more on a new
 * connection; no other failure sends a call twice.
 *
 * Each server's health (see `McpHealth`) starts from its setup listing and
 * follows its connects, lists and failed calls; `status` reads it.
 */
const mcpClientsLive = (
  registered: ReadonlyArray<RegisteredServer>,
  misconfigured: ReadonlyArray<MisconfiguredServer>,
  file: string,
  blobs: string,
) =>
  Layer.effect(
    McpClients,
    Effect.gen(function* () {
      const blobStore = yield* makeBlobStore(blobs)
      const byKey = new Map(registered.map((entry) => [entry.server.key, entry]))
      const writePermit = yield* Semaphore.make(1)
      const runFork = yield* FiberSet.makeRuntime<FileSystem.FileSystem | Path.Path>()
      /** The connection each key holds now, so a late close never drops its successor. */
      const live = new Map<string, Connection>()
      /** Each server's last accepted entry, which a new list is compared with. */
      const known = new Map(registered.map((entry) => [entry.server.key, entry.catalog]))
      const health = new Map(registered.map((entry) => [entry.server.key, setupHealth(entry)]))
      const setHealth = (key: string, state: McpHealth, reason: Option.Option<string>) => {
        health.set(key, { health: state, reason })
      }
      const setFailed = (key: string, error: McpError) => {
        health.set(key, failureHealth(error))
      }
      const namesOf = (tools: ReadonlyArray<CatalogTool>) =>
        new Set(tools.map((listed) => listed.name))
      /**
       * The names the server lists now, written to the cache with its
       * instructions when either changed. An empty list from a server that
       * had tools is not trusted (a server whose auth broke can answer one),
       * and a failed list is not either: both keep the last list and the
       * cached tools, and leave the server `degraded`.
       */
      const relist = (server: McpServer, client: Client, instructions: Option.Option<string>) =>
        Effect.gen(function* () {
          const previous = known.get(server.key) ?? { tools: [] }
          const tools = yield* listTools(server, client)
          if (tools.length === 0 && previous.tools.length > 0) {
            yield* Effect.logWarning("mcp.server.relist.empty").pipe(
              Effect.annotateLogs({ server: server.name }),
            )
            setHealth(
              server.key,
              "degraded",
              Option.some(`listed no tools; kept the ${previous.tools.length} listed before`),
            )
            return namesOf(previous.tools)
          }
          const next: CatalogServer = {
            tools,
            ...omitUndefined({ instructions: Option.getOrUndefined(instructions) }),
          }
          known.set(server.key, next)
          setHealth(server.key, "healthy", Option.none())
          if (!Equal.equals(next, previous)) {
            yield* Semaphore.withPermit(
              writePermit,
              writeCatalogEntries(file, [[server.key, next]]),
            )
          }
          return namesOf(tools)
        }).pipe(
          Effect.catchCause((cause) => {
            const message = failureMessage(Cause.squash(cause))
            setHealth(server.key, "degraded", Option.some(message))
            return Effect.logWarning("mcp.server.relist.failed").pipe(
              Effect.annotateLogs({ server: server.name, error: message }),
              Effect.as(namesOf(known.get(server.key)?.tools ?? [])),
            )
          }),
        )
      /** Lists an open connection's tools again, off the call that asked. */
      const refresh = (server: McpServer, connection: Connection) =>
        runFork(
          relist(server, connection.client, connection.instructions).pipe(
            Effect.map((listed) => {
              connection.listed = listed
            }),
          ),
        )
      const clients = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.gen(function* () {
            const entry = byKey.get(key)
            if (Predicate.isUndefined(entry)) {
              return yield* new McpError({ server: key, message: "not configured" })
            }
            // The notification can only arrive once the connection below exists.
            let onToolsChanged = () => {}
            const { client, transport, instructions } = yield* connect(
              entry.server,
              Option.some(() => onToolsChanged()),
            )
            const connection: Connection = {
              client,
              transport,
              instructions,
              listed: yield* relist(entry.server, client, instructions),
              closed: false,
              calls: 0,
            }
            onToolsChanged = () => refresh(entry.server, connection)
            live.set(key, connection)
            // Runs before the client closes, so its own close event finds nothing to drop.
            yield* Effect.addFinalizer(() => Effect.sync(() => forget(key, connection)))
            client.onclose = () => {
              connection.closed = true
              if (live.get(key) === connection) {
                setHealth(key, "degraded", Option.some("the connection closed"))
              }
              runFork(evict(key, connection))
            }
            return connection
          }),
        idleTimeToLive: IDLE_TIME_TO_LIVE,
      })
      /** Whether `connection` was the key's current one; it no longer is. */
      const forget = (key: string, connection: Connection) => {
        if (live.get(key) !== connection) return false
        live.delete(key)
        return true
      }
      const evict = (key: string, connection: Connection) =>
        Effect.suspend(() => {
          if (!forget(key, connection)) return Effect.void
          return RcMap.invalidate(clients, key)
        })
      const acquire = (server: McpServer) =>
        RcMap.get(clients, server.key).pipe(
          // RcMap keeps a failed lookup until it idles out; drop it so the next call connects.
          Effect.tapError((error) =>
            Effect.andThen(
              Effect.sync(() => setFailed(server.key, error)),
              RcMap.invalidate(clients, server.key),
            ),
          ),
        )
      /** The key's connection; one whose transport already closed ran nothing, so it is replaced. */
      const open = (server: McpServer) =>
        Effect.gen(function* () {
          const connection = yield* acquire(server)
          if (!connection.closed) return connection
          yield* evict(server.key, connection)
          return yield* acquire(server)
        })
      /** One `tools/call` on the key's connection, which the failure's kind then drops or relists. */
      const callOnce = (
        server: McpServer,
        name: string,
        input: Readonly<Record<string, Schema.Json>>,
      ) =>
        Effect.gen(function* () {
          const connection = yield* open(server)
          if (!connection.listed.has(name)) {
            return yield* new McpError({ server: server.name, message: staleMessage(name) })
          }
          const reused = connection.calls > 0
          connection.calls += 1
          const send = Effect.gen(function* () {
            const value = yield* Effect.tryPromise({
              try: (signal) =>
                // oxlint-disable-next-line effect/noNullish -- the SDK takes its default result schema positionally
                connection.client.callTool({ name, arguments: input }, undefined, {
                  signal,
                  timeout: timeoutOf(server),
                }),
              catch: (cause) => {
                const kind = failureKind(cause, name)
                let message = `${name}: ${failureMessage(cause)}`
                if (kind === "stale") message = staleMessage(name)
                return new CallFailed({ kind, reused, message })
              },
            })
            const result = yield* Schema.decodeUnknownEffect(CallResult)(value).pipe(
              Effect.mapError(
                (error) =>
                  new CallFailed({
                    kind: "answered",
                    reused,
                    message: `${name}: ${error.message}`,
                  }),
              ),
            )
            if (result.isError === true && isUnknownToolMessage(resultText(result), name)) {
              return yield* new CallFailed({ kind: "stale", reused, message: staleMessage(name) })
            }
            return result
          })
          return yield* send.pipe(
            Effect.tapError((failed) => {
              if (failed.kind === "dead") {
                setHealth(server.key, "degraded", Option.some(failed.message))
              }
              if (failed.kind === "dead" || failed.kind === "expired") {
                return evict(server.key, connection)
              }
              if (failed.kind === "stale") return Effect.sync(() => refresh(server, connection))
              return Effect.void
            }),
          )
        })
      return McpClients.of({
        call: (server, name, input) =>
          callOnce(server, name, input).pipe(
            Effect.catchTag("CallFailed", (failed) => {
              if (failed.kind === "expired" && failed.reused) return callOnce(server, name, input)
              return Effect.fail(failed)
            }),
            Effect.mapError((error) => {
              if (error._tag === "McpError") return error
              return new McpError({ server: server.name, message: error.message })
            }),
            Effect.scoped,
          ),
        status: Effect.sync(() => {
          const servers = registered.map(({ server }): McpServerStatus => {
            const state = health.get(server.key) ?? { health: "unknown", reason: Option.none() }
            const connection = Option.fromUndefinedOr(live.get(server.key)).pipe(
              Option.filter((open) => !open.closed),
            )
            const catalog = known.get(server.key) ?? { tools: [] }
            return {
              name: server.name,
              transport: Option.match(connection, {
                onNone: () => configuredTransport(server.config),
                onSome: (open) => open.transport,
              }),
              health: state.health,
              connected: Option.isSome(connection),
              tools: catalog.tools.length,
              ...omitUndefined({
                description: catalog.instructions,
                reason: Option.getOrUndefined(state.reason),
              }),
            }
          })
          for (const entry of misconfigured) {
            servers.push({
              name: entry.name,
              transport: configuredTransport(entry.config),
              health: "misconfigured",
              connected: false,
              tools: 0,
              reason: entry.reason,
            })
          }
          return {
            servers: servers.toSorted((left, right) => compareCodeUnits(left.name, right.name)),
          }
        }),
        saveBlobs: blobStore.save,
      })
    }),
  )

// ── tools ───────────────────────────────────────────────────────────────────

/** Anything the importer cannot read takes any object; the server still checks it. */
const AnyInput = Schema.Record(Schema.String, Schema.Json)

/**
 * A tool's JSON Schema, imported as a schema of `A`, or `fallback` when the
 * importer cannot read it. Patterns are ignored: a server's regular
 * expressions do not run in gent.
 */
const importJsonSchema = <A>(json: Schema.Json, fallback: Schema.Codec<A>): Schema.Codec<A> =>
  Result.try(() => {
    if (!isRecord(json)) return fallback
    let document = JsonSchema.fromSchemaDraft07(json)
    const dialect = json["$schema"]
    if (Predicate.isString(dialect) && dialect.includes("2020-12")) {
      document = JsonSchema.fromSchemaDraft2020_12(json)
    }
    const imported = SchemaRepresentation.fromJsonSchemaDocument(document, { patterns: "ignore" })
    // `make` is the typed bridge from an AST: an imported schema needs no services.
    return Schema.make<Schema.Codec<A>>(imported.ast)
  }).pipe(Result.getOrElse(() => fallback))

/** The tool's input schema, so the host checks the input and the cell signature shows its types. */
const inputSchemaOf = (inputSchema: Schema.Json) => importJsonSchema(inputSchema, AnyInput)

/**
 * The tool's result type. A tool that declares an `outputSchema` returns its
 * structured content as that type, so the signature shows it; any other tool
 * returns JSON.
 */
const outputSchemaOf = (listed: CatalogTool) =>
  Option.match(Option.fromUndefinedOr(listed.outputSchema), {
    onNone: () => Schema.Json,
    onSome: (outputSchema) => importJsonSchema<Schema.Json>(outputSchema, Schema.Json),
  })

/** The bytes a base64 string decodes to. */
const base64Bytes = (data: string) => {
  const padding = data.length - data.replace(/=+$/, "").length
  return Math.floor((data.length * 3) / 4) - padding
}

const isTextBlock = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }))

/** A result's text blocks, joined. */
const resultText = (result: CallResult) =>
  (result.content ?? [])
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n")

const isMediaBlock = Schema.is(
  Schema.Struct({
    type: Schema.Literals(["image", "audio"]),
    data: Schema.optional(Schema.String),
    mimeType: Schema.optional(Schema.String),
  }),
)
const isBlobResource = Schema.is(
  Schema.Struct({
    type: Schema.Literal("resource"),
    resource: Schema.Struct({
      uri: Schema.optional(Schema.String),
      mimeType: Schema.optional(Schema.String),
      blob: Schema.String,
    }),
  }),
)
const isResource = Schema.is(
  Schema.Struct({
    type: Schema.Literal("resource"),
    resource: Schema.Record(Schema.String, Schema.Json),
  }),
)

/** A block's binary data and MIME type, when it is an image, audio, or blob block. */
const binaryOf = (block: Schema.Json) => {
  if (isMediaBlock(block)) {
    return Option.some({ data: block.data ?? "", mimeType: block.mimeType })
  }
  if (isBlobResource(block)) {
    return Option.some({ data: block.resource.blob, mimeType: block.resource.mimeType })
  }
  return Option.none()
}

/** A call's content blocks sorted into text, other blocks, and binary blocks the cell reads from a file or not at all. */
interface ProjectedContent {
  readonly texts: Array<string>
  readonly blocks: Array<Schema.Json>
  readonly binary: Array<Schema.Json>
  /** Binary blocks with no file: past the cap, or not written. */
  unsaved: number
}

/** `saved` holds the file of each content block by index, where one was written. */
const projectContent = (
  content: ReadonlyArray<Schema.Json>,
  saved: ReadonlyArray<Option.Option<string>>,
): ProjectedContent => {
  const projected: ProjectedContent = { texts: [], blocks: [], binary: [], unsaved: 0 }
  for (const [index, block] of content.entries()) {
    const path = Option.flatten(Option.fromUndefinedOr(saved[index]))
    if (Option.isSome(binaryOf(block)) && Option.isNone(path)) projected.unsaved += 1
    const file = omitUndefined({ path: Option.getOrUndefined(path) })
    if (isTextBlock(block)) {
      projected.texts.push(block.text)
    } else if (isMediaBlock(block)) {
      projected.binary.push({
        type: block.type,
        ...omitUndefined({ mimeType: block.mimeType }),
        bytes: base64Bytes(block.data ?? ""),
        ...file,
      })
    } else if (isBlobResource(block)) {
      projected.binary.push({
        type: "resource",
        ...omitUndefined({ uri: block.resource.uri, mimeType: block.resource.mimeType }),
        bytes: base64Bytes(block.resource.blob),
        ...file,
      })
    } else if (isResource(block)) {
      projected.blocks.push({ type: "resource", ...block.resource })
    } else {
      projected.blocks.push(block)
    }
  }
  return projected
}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** Whether `text` is only `value` serialized, as the spec asks a server to send beside it. */
const repeats = (text: string, value: Schema.Json) =>
  Option.match(decodeJsonText(text), {
    onNone: () => false,
    onSome: (parsed) => Equal.equals(parsed, value),
  })

const blockCount = (count: number) => {
  if (count === 1) return "1 binary block"
  return `${count} binary blocks`
}

const binaryNote = (count: number, unsaved: number) => {
  if (unsaved === 0) return `${blockCount(count)} saved to files: read each one from its path`
  const omitted = `${blockCount(unsaved)} without a path omitted (over the ${BLOB_FILE_LIMIT_MIB} MiB file cap, or not written): the cell does not receive that data`
  if (unsaved === count) return omitted
  return `${omitted}; read the others from their paths`
}

/**
 * The value a call returns. Text alone is its joined text; structured content
 * alone (its text only repeating it) is that value. Anything else is an
 * object: `structuredContent`, `text`, the other blocks as `content`, and
 * `omitted` naming each image, audio, or blob block with its MIME type and
 * size, and the `path` of the file it was saved to (see `saveBlobs`) when
 * `saved` names one, and a `note` saying which the cell can read.
 */
export const projectCallResult = (
  result: CallResult,
  saved: ReadonlyArray<Option.Option<string>> = [],
): Schema.Json => {
  const { texts, blocks, binary, unsaved } = projectContent(result.content ?? [], saved)
  const text = texts.join("\n")
  const structured = Option.fromUndefinedOr(result.structuredContent)
  if (blocks.length === 0 && binary.length === 0) {
    if (Option.isNone(structured)) return text
    if (texts.length === 0 || repeats(text, structured.value)) return structured.value
  }
  const value: Record<string, Schema.Json> = {}
  if (Option.isSome(structured)) value["structuredContent"] = structured.value
  if (texts.length > 0) value["text"] = text
  if (blocks.length > 0) value["content"] = blocks
  if (binary.length > 0) {
    value["omitted"] = binary
    value["note"] = binaryNote(binary.length, unsaved)
  }
  return value
}

const toolDescription = (server: McpServer, listed: CatalogTool) => {
  const description = (listed.description ?? "").trim()
  if (description.length > 0) return description
  return `${listed.name} on the ${server.name} MCP server`
}

/**
 * One host tool per listed MCP tool, each under its own segment (see
 * `allocateSegments`). A name the server lists twice is one tool.
 */
const toolsFor = (server: McpServer, listed: ReadonlyArray<CatalogTool>) => {
  const segments = allocateSegments(
    listed.map((entry) => entry.name),
    WIRE_SEGMENTS_LIMIT - server.name.length,
    "tool",
  )
  const seen = new Set<string>()
  return listed.flatMap((entry) => {
    const segment = segments.get(entry.name) ?? "tool"
    if (seen.has(entry.name)) return []
    seen.add(entry.name)
    const output = outputSchemaOf(entry)
    const typed = Predicate.isNotUndefined(entry.outputSchema)
    const conforms = Schema.is(output)
    return [
      tool({
        id: `mcp.${server.name}.${segment}`,
        description: toolDescription(server, entry),
        readonly: entry.annotations?.readOnlyHint === true,
        destructive: entry.annotations?.destructiveHint === true,
        params: inputSchemaOf(entry.inputSchema),
        output,
        execute: Effect.fn("Mcp.call")(function* (input) {
          const clients = yield* McpClients
          const result = yield* clients.call(server, entry.name, input)
          const value = projectCallResult(result, yield* clients.saveBlobs(result.content ?? []))
          if (result.isError === true) {
            // The host shape for a failed call, `{ error }`, with any non-text content beside it.
            if (Predicate.isString(value) && value.length > 0) {
              return yield* new ToolResultFailure({ message: value, result: { error: value } })
            }
            const message = `${server.name}.${entry.name} failed`

            return yield* new ToolResultFailure({
              message,
              result: { error: message, content: value },
            })
          }
          if (!typed) return value
          // The spec asks a client to check structured content against the declared schema.
          const structured = result.structuredContent
          if (Predicate.isNotUndefined(structured) && conforms(structured)) return structured
          let message = `${server.name}.${entry.name} returned structured content that does not match its output schema`
          if (Predicate.isUndefined(structured)) {
            message = `${server.name}.${entry.name} returned no structured content for its output schema`
          }
          return yield* new ToolResultFailure({
            message,
            result: { error: message, content: value },
          })
        }),
      }),
    ]
  })
}

/**
 * A server's catalog entry, whether setup listed it now (so it goes to the
 * cache), and the failure of a setup listing that did not work.
 */
interface SetupCatalog {
  readonly catalog: CatalogServer
  readonly listedNow: boolean
  readonly failure: Option.Option<McpError>
}

/**
 * The server's tools from the cache, or, on a miss, from one connection at
 * setup that lists them. A server that cannot list is reported and
 * contributes nothing; the other servers are unaffected.
 */
const catalogFor = (server: McpServer, cache: CatalogFile): Effect.Effect<SetupCatalog> => {
  const cached = cache.servers[server.key]
  if (Predicate.isNotUndefined(cached)) {
    return Effect.succeed({ catalog: cached, listedNow: false, failure: Option.none() })
  }
  const unlisted = (error: McpError) =>
    Effect.logWarning("mcp.server.unlisted").pipe(
      Effect.annotateLogs({ server: server.name, error: error.message }),
      Effect.as<SetupCatalog>({
        catalog: { tools: [] },
        listedNow: false,
        failure: Option.some(error),
      }),
    )
  return Effect.scoped(
    Effect.gen(function* () {
      const { client, instructions } = yield* connect(server)
      const tools = yield* listTools(server, client)
      const catalog: CatalogServer = {
        tools,
        ...omitUndefined({ instructions: Option.getOrUndefined(instructions) }),
      }
      return catalog
    }),
  ).pipe(
    Effect.map((catalog): SetupCatalog => ({ catalog, listedNow: true, failure: Option.none() })),
    Effect.catchTag("McpError", unlisted),
    Effect.catchCause((cause) =>
      unlisted(new McpError({ server: server.name, message: String(Cause.squash(cause)) })),
    ),
  )
}

// ── status ──────────────────────────────────────────────────────────────────

/**
 * `mcp.status()`: every configured server with its transport, health, tool
 * count and instructions. It reads this process's state and connects to
 * nothing.
 */
const McpStatusTool = tool({
  id: "mcp.status",
  description:
    "Report each configured MCP server: transport, health, connection, tool count, and the server's own instructions",
  readonly: true,
  params: Schema.Struct({}),
  output: McpStatus,
  execute: Effect.fn("Mcp.status")(function* () {
    const clients = yield* McpClients
    return yield* clients.status
  }),
})

const statusLine = (server: McpServerStatus) => {
  let tools = `${server.tools} tools`
  if (server.tools === 1) tools = "1 tool"
  let connected = "not connected"
  if (server.connected) connected = "connected"
  const facts = [server.health, tools, connected]
  const reason = Option.match(Option.fromUndefinedOr(server.reason), {
    onNone: () => "",
    onSome: (text) => `\n  ${text}`,
  })
  const description = Option.match(Option.fromUndefinedOr(server.description), {
    onNone: () => "",
    onSome: (text) => `\n  ${firstLine(text)}`,
  })
  return `- ${server.name} (${server.transport}): ${facts.join(", ")}${reason}${description}`
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? ""

/** `/mcp`: shows `mcp.status` to the user. */
const McpCommand = request({
  id: "mcp-command",
  description: "Show the MCP servers: transport, health, and tool count",
  slash: {
    trigger: "mcp",
    name: "MCP",
    description: "/mcp · status of each MCP server",
    category: "Tools",
  },
  input: Schema.String,
  output: Schema.Void,
  execute: () =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const clients = yield* McpClients
      const { servers } = yield* clients.status
      yield* ctx.Interaction.present({
        title: "MCP servers",
        content: servers.map(statusLine).join("\n"),
      })
    }),
})

// ── extension ───────────────────────────────────────────────────────────────

/**
 * Registers the tools of `servers`, as read once at setup. Connections open
 * on first call, inside a process resource, so a server that nobody calls
 * never starts after its catalog is cached.
 */
const registerServers = Effect.fn("Mcp.registerServers")(function* (
  extensionId: string,
  entries: Readonly<Record<string, McpServerConfig>>,
) {
  const host = yield* ExtensionHost
  const { servers, misconfigured } = yield* resolveServers(entries, host.cwd)
  if (servers.length === 0 && misconfigured.length === 0) return
  const file = yield* catalogPath(host.home)
  const cache = yield* readCatalog(file)
  const registered = yield* Effect.forEach(
    servers,
    (server) => Effect.map(catalogFor(server, cache), (catalog) => ({ server, ...catalog })),
    { concurrency: 8 },
  )
  // One write for every server listed now; a failed write only costs a relist.
  yield* writeCatalogEntries(
    file,
    registered
      .filter((entry) => entry.listedNow)
      .map((entry): readonly [string, CatalogServer] => [entry.server.key, entry.catalog]),
  ).pipe(Effect.ignore)
  yield* host.register(
    "resource",
    defineResource({
      id: `${extensionId}/clients`,
      scope: "process",
      layer: mcpClientsLive(registered, misconfigured, file, yield* blobDirectory(host.home)),
    }),
  )
  yield* host.register(
    "tool",
    McpStatusTool,
    ...registered.flatMap((entry) => toolsFor(entry.server, entry.catalog.tools)),
  )
  yield* host.register("request", McpCommand)
})

/**
 * @gent/mcp: every MCP server in `~/.gent/mcp.json` (and, for a trusted
 * project, `.gent/mcp.json`) becomes typed functions in the cell:
 * `await tools.mcp.<server>.<tool>(input)`. Each tool runs through the host
 * tool path, with its permission, events, receipt and recovery.
 */
export const McpExtension = defineExtension({
  id: "@gent/mcp",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* registerServers("@gent/mcp", yield* readMcpConfig(host.home, host.cwd))
  }),
})

/** The MCP extension over inline servers instead of the config files. */
export const McpServers = (id: string, entries: Readonly<Record<string, McpServerConfig>>) =>
  defineExtension({ id, setup: registerServers(id, entries) })
