import {
  Cause,
  Clock,
  Config,
  ConfigProvider,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Crypto,
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
  Schedule,
  Scope,
  Semaphore,
} from "effect"
import { Base64, Base64Url, Hex } from "effect/encoding"
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { BunHttpServer } from "@effect/platform-bun"
import {
  auth,
  extractResourceMetadataUrl,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  ErrorCode,
  McpError as ProtocolError,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { compareIds } from "./cell-protocol.js"
import { type SdkFetch, sdkFetch } from "./mcp-boundary.js"
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

const sortedEntries = (record: Readonly<Record<string, string>> = {}) =>
  Object.entries(record).toSorted(([left], [right]) => compareIds(left, right))

/**
 * What decides the tools a server lists: the entry as it runs, after
 * expansion, with its transport type, and for a stdio server that names a
 * `cwd` the directory it resolves to, in a fixed order so key order never
 * matters. A stdio entry that names no `cwd` runs in the session's directory
 * but keys without it: one listing serves every project, and a server whose
 * tools depend on its directory is corrected by the relist on its first
 * connection. It holds secrets, so only its SHA-256 digest is kept.
 */
const serverIdentity = (written: string, config: McpServerConfig, cwd: string) => {
  if ("command" in config) {
    let namedCwd = ""
    if (Predicate.isNotUndefined(config.cwd)) namedCwd = cwd
    return encodeKeyFields([
      written,
      "stdio",
      config.command,
      config.args ?? [],
      sortedEntries(config.env),
      namedCwd,
      config.timeoutMs ?? 0,
    ])
  }
  // The transport as configured: `auto` is its own identity, whichever transport it reaches.
  return encodeKeyFields([
    written,
    configuredTransport(config),
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
  return Hex.encode(digest)
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
  for (const name of [...new Set(names)].toSorted(compareIds)) {
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
    const value = yield* Config.option(Config.String(name)).pipe(
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
    .toSorted(([left], [right]) => compareIds(left, right))
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

/**
 * One page of `tools/list` before its entries are read. Each entry decodes on
 * its own, so one malformed entry never drops the page.
 */
const ListToolsPage = Schema.Struct({
  tools: Schema.Array(Schema.Json),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
})

/** A listed entry: `CatalogTool`, with a `null` description read as none. */
const ListedTool = Schema.Struct({
  ...CatalogTool.fields,
  description: Schema.optional(Schema.NullOr(Schema.String)),
})

/** The listed entry as a `CatalogTool`, or why the spec's tool shape refuses it. */
const catalogToolOf = (entry: Schema.Json) =>
  Schema.decodeUnknownEffect(ListedTool)(entry).pipe(
    Effect.map(({ description, ...rest }): CatalogTool => {
      if (Predicate.isNotNull(description) && Predicate.isNotUndefined(description)) {
        return { ...rest, description }
      }
      return rest
    }),
  )

/** A server's tools, and the `instructions` its `initialize` answer carried, if any. */
const CatalogServer = Schema.Struct({
  tools: Schema.Array(CatalogTool),
  instructions: Schema.optional(Schema.String),
})
type CatalogServer = typeof CatalogServer.Type

/** A server's cached catalog, and when a setup last listed or read it (epoch ms). */
const CachedServer = Schema.Struct({
  ...CatalogServer.fields,
  listedAt: Schema.optional(Schema.Finite),
})
type CachedServer = typeof CachedServer.Type

/** Each server's entry, keyed by the hash of its config, so an edited entry lists again. */
const CatalogFile = Schema.fromJsonString(
  Schema.Struct({ servers: Schema.Record(Schema.String, CachedServer) }),
)
type CatalogFile = typeof CatalogFile.Type

/** A cached entry no setup listed or read for this long is dropped at the next write. */
const CATALOG_MAX_AGE = Duration.days(14)
/** A setup that reads an entry stamped longer ago than this stamps it again. */
const CATALOG_RESTAMP_AGE = Duration.days(1)

/** The cached entry's catalog, without its stamp. */
const catalogOf = (cached: CachedServer): CatalogServer => {
  const catalog: CatalogServer = { tools: cached.tools }
  if (Predicate.isUndefined(cached.instructions)) return catalog
  return { ...catalog, instructions: cached.instructions }
}

/** The entry has no stamp, or one older than `CATALOG_RESTAMP_AGE`. */
const needsRestamp = (cached: CachedServer, now: number) =>
  !Option.exists(
    Option.fromUndefinedOr(cached.listedAt),
    (at) => now - at < Duration.toMillis(CATALOG_RESTAMP_AGE),
  )

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
 *
 * Each written entry is stamped now. An entry stamped longer ago than
 * `CATALOG_MAX_AGE` is dropped, so the file holds only servers a setup used
 * lately (one for each project directory a stdio entry names). An entry with
 * no stamp is stamped now and ages from this write.
 */
const writeCatalogEntries = Effect.fn("Mcp.writeCatalogEntries")(function* (
  file: string,
  entries: ReadonlyArray<readonly [key: string, server: CatalogServer]>,
) {
  if (entries.length === 0) return
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const now = yield* Clock.currentTimeMillis
  const current = yield* readCatalog(file)
  const servers: Record<string, CachedServer> = {}
  for (const [key, cached] of Object.entries(current.servers)) {
    const listedAt = cached.listedAt ?? now
    if (now - listedAt <= Duration.toMillis(CATALOG_MAX_AGE)) {
      servers[key] = { ...cached, listedAt }
    }
  }
  for (const [key, server] of entries) servers[key] = { ...server, listedAt: now }
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

/**
 * Removes the files in `directory` last written more than `BLOB_MAX_AGE` ago.
 * A save that reuses a file sets its modification time to now, so a file
 * any process named within `BLOB_MAX_AGE` stays. Each file is checked right
 * before it is removed; a save that finds its file gone writes it again.
 */
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
 * The first write of the process removes files older than `BLOB_MAX_AGE`
 * (see `pruneBlobs`); a reused file's modification time is set to now.
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
        const bytes = Base64.decode(data)
        if (Result.isFailure(bytes) || bytes.success.length > BLOB_FILE_LIMIT) {
          return Option.none<string>()
        }
        yield* prune
        const digest = Hex.encode(yield* crypto.digest("SHA-256", bytes.success))
        const file = path.join(directory, `${digest}.${blobExtension(mimeType)}`)
        // A reuse marks the file as just written, so no prune takes it now; a file gone is written again.
        const now = (yield* Clock.currentTimeMillis) / 1000
        const reused = yield* fs.utimes(file, now, now).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
        if (!reused) {
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

// ── oauth ───────────────────────────────────────────────────────────────────

/** Tokens as the SDK hands them to `saveTokens`, kept as they came. */
const StoredTokens = Schema.Struct({
  access_token: Schema.String,
  id_token: Schema.optional(Schema.String),
  token_type: Schema.String,
  expires_in: Schema.optional(Schema.Finite),
  scope: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  issuer: Schema.optional(Schema.String),
})
type StoredTokens = typeof StoredTokens.Type

/** The client the authorization server registered, as `saveClientInformation` hands it. */
const StoredClient = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  client_id_issued_at: Schema.optional(Schema.Finite),
  client_secret_expires_at: Schema.optional(Schema.Finite),
  token_endpoint_auth_method: Schema.optional(Schema.String),
  issuer: Schema.optional(Schema.String),
})
type StoredClient = typeof StoredClient.Type

const StoredLogin = Schema.Struct({
  tokens: StoredTokens,
  /** When the access token expires, in epoch milliseconds, when the server said. */
  expiresAt: Schema.optional(Schema.Finite),
  client: StoredClient,
  /** The redirect URI the client registered with; a refresh names it again. */
  redirectUri: Schema.String,
  /**
   * The protected resource metadata URL the server's 401 named in
   * `WWW-Authenticate`, when it named one. A refresh finds the token
   * endpoint through it; a server that serves its metadata off the
   * well-known path is not found otherwise.
   */
  resourceMetadataUrl: Schema.optional(Schema.String),
})
type StoredLogin = typeof StoredLogin.Type

/** `<data dir>/mcp-auth.json`, mode 0600: each login under `authKey`. */
const AuthFile = Schema.fromJsonString(
  Schema.Struct({ servers: Schema.Record(Schema.String, StoredLogin) }),
)
type AuthFile = typeof AuthFile.Type

/** A token that expires within this long is refreshed before a dial. */
const REFRESH_SKEW = Duration.seconds(60)
/** A login waits this long for the browser's redirect. */
const LOGIN_TIMEOUT = Duration.minutes(5)
/**
 * The requests a 401 may send again once a refresh gave a new token. They
 * change nothing on the server; a `tools/call` is never sent twice.
 */
const REPLAYABLE: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "GET",
])

/** The server refused the OAuth token, and no refresh gave one it takes. */
class LoginRequired extends Schema.TaggedError<LoginRequired>()("LoginRequired", {
  server: Schema.String,
  message: Schema.String,
}) {}

const loginMessage = (name: string) =>
  `the ${name} MCP server needs a login: run /mcp login ${name}`

const loginRequired = (name: string) =>
  new LoginRequired({ server: name, message: loginMessage(name) })

type HttpServerConfig = typeof HttpServerConfig.Type

/** A `url` entry signs in with OAuth unless it sends its own `Authorization` header. */
const usesOAuth = (config: McpServerConfig): config is HttpServerConfig =>
  "url" in config &&
  !Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === "authorization")

/**
 * A login's key: the server's name and URL, not the entry's digest, so a
 * login outlives an edit to the entry's other fields.
 */
const authKey = (server: McpServer, config: HttpServerConfig) => `${server.name} ${config.url}`

/** The login file, and the services a fetch runs its refresh with. */
interface AuthStore {
  readonly file: string
  readonly services: Context.Context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>
}

const makeAuthStore = Effect.fn("Mcp.makeAuthStore")(function* (home: string) {
  const path = yield* Path.Path
  return {
    file: path.join(yield* resolveDataDir(home), "mcp-auth.json"),
    services: yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>(),
  }
})

const readLogins = (store: AuthStore) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(store.file).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AuthFile)),
      Effect.orElseSucceed((): AuthFile => ({ servers: {} })),
    )
  })

const readLogin = (store: AuthStore, key: string) =>
  Effect.map(readLogins(store), (file) => Option.fromUndefinedOr(file.servers[key]))

/**
 * Stores one login; the file is written whole, atomically, readable by its
 * owner only. The caller holds the auth lock (`underAuthLock`): the read and
 * the write here are one step no other writer comes between.
 */
const writeLogin = (store: AuthStore, key: string, login: StoredLogin) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const current = yield* readLogins(store)
    const servers = { ...current.servers, [key]: login }
    yield* fs.makeDirectory(path.dirname(store.file), { recursive: true })
    yield* writeFileAtomic(store.file, yield* Schema.encodeEffect(AuthFile)({ servers }), {
      mode: 0o600,
    })
  })

/** The SDK's tokens as stored; a refresh answer without a refresh token keeps the old one. */
const storedTokens = (
  tokens: StoredTokens,
  previous: Option.Option<StoredTokens>,
): StoredTokens => ({
  access_token: tokens.access_token,
  token_type: tokens.token_type,
  ...omitUndefined({
    id_token: tokens.id_token,
    expires_in: tokens.expires_in,
    scope: tokens.scope,
    issuer: tokens.issuer,
    refresh_token:
      tokens.refresh_token ??
      Option.getOrUndefined(
        Option.flatMap(previous, (old) => Option.fromUndefinedOr(old.refresh_token)),
      ),
  }),
})

const storedClient = (client: StoredClient): StoredClient => ({
  client_id: client.client_id,
  ...omitUndefined({
    client_secret: client.client_secret,
    client_id_issued_at: client.client_id_issued_at,
    client_secret_expires_at: client.client_secret_expires_at,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    issuer: client.issuer,
  }),
})

const loginFrom = (
  tokens: StoredTokens,
  client: StoredClient,
  redirectUri: string,
  metadata: Option.Option<URL>,
  now: number,
): StoredLogin => ({
  tokens,
  client,
  redirectUri,
  ...omitUndefined({
    expiresAt: Option.getOrUndefined(
      Option.map(Option.fromUndefinedOr(tokens.expires_in), (seconds) => now + seconds * 1000),
    ),
    resourceMetadataUrl: Option.getOrUndefined(Option.map(metadata, (url) => url.href)),
  }),
})

/** The options an SDK `auth()` run takes for `config`, with the resource metadata URL when known. */
const authOptions = (config: HttpServerConfig, metadata: Option.Option<URL>) => ({
  serverUrl: config.url,
  ...Option.match(metadata, {
    onNone: () => ({}),
    onSome: (resourceMetadataUrl) => ({ resourceMetadataUrl }),
  }),
})

/** The stored resource metadata URL of `login`, when it has a valid one. */
const storedMetadata = (login: StoredLogin) =>
  Option.flatMap(Option.fromUndefinedOr(login.resourceMetadataUrl), (href) =>
    Option.liftThrowable(() => new URL(href))(),
  )

/** The server's `initialize` as a probe sends it, with no token. */
const INITIALIZE_PROBE =
  '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gent","version":"1.0.0"}}}'

/**
 * The resource metadata URL the server names in its 401's
 * `WWW-Authenticate`, read from one request with no token: an `initialize`
 * POST, or the stream's GET for an `sse` entry. None when the server does not
 * refuse it or names none; discovery then tries the well-known paths.
 */
const namedMetadata = (config: HttpServerConfig) =>
  Effect.gen(function* () {
    const fetchWeb = yield* FetchHttpClient.Fetch
    const headers = new Headers(config.headers)
    headers.set("Accept", "application/json, text/event-stream")
    const init: RequestInit = { headers }
    if (configuredTransport(config) !== "sse") {
      headers.set("Content-Type", "application/json")
      init.method = "POST"
      init.body = INITIALIZE_PROBE
    }
    const response = yield* Effect.tryPromise(() => fetchWeb(config.url, init))
    // Only the status and headers count; an `sse` stream's body never ends.
    const body = Option.fromNullishOr(response.body)
    if (Option.isSome(body)) yield* Effect.ignore(Effect.tryPromise(() => body.value.cancel()))
    if (response.status !== 401) return Option.none<URL>()
    return Option.fromUndefinedOr(extractResourceMetadataUrl(response))
  }).pipe(Effect.orElseSucceed(() => Option.none<URL>()))

/** gent's client as it registers with an authorization server: a public client on a loopback redirect. */
const clientMetadataFor = (redirectUri: string) => ({
  client_name: "gent",
  redirect_uris: [redirectUri],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
})

/** What an SDK `auth()` run saved: the client it registered, the tokens, the login URL and verifier. */
interface AuthFlow {
  client: Option.Option<StoredClient>
  tokens: Option.Option<StoredTokens>
  authorizationUrl: Option.Option<URL>
  verifier: string
}

const emptyFlow = (client: Option.Option<StoredClient>): AuthFlow => ({
  client,
  tokens: Option.none(),
  authorizationUrl: Option.none(),
  verifier: "",
})

/**
 * The SDK's `OAuthClientProvider` over one `AuthFlow`. It never opens a
 * browser: where the SDK would send the user to log in, it keeps the
 * authorization URL in the flow and the SDK's `auth` answers `REDIRECT`.
 * `interactive` is a login's state; a login presents that URL, and a refresh
 * that ends there has no token.
 */
const flowProvider = (
  server: string,
  redirectUri: string,
  flow: AuthFlow,
  previous: Option.Option<StoredLogin>,
  interactive: Option.Option<string>,
): OAuthClientProvider => ({
  get redirectUrl() {
    return redirectUri
  },
  get clientMetadata() {
    return clientMetadataFor(redirectUri)
  },
  ...Option.match(interactive, {
    onNone: () => ({}),
    onSome: (state) => ({ state: () => state }),
  }),
  clientInformation: () => Option.getOrUndefined(flow.client),
  saveClientInformation: (client) => {
    flow.client = Option.some(storedClient(client))
  },
  tokens: () => Option.getOrUndefined(Option.map(previous, (login) => login.tokens)),
  saveTokens: (tokens) => {
    flow.tokens = Option.some(
      storedTokens(
        tokens,
        Option.map(previous, (login) => login.tokens),
      ),
    )
  },
  redirectToAuthorization: (url) => {
    flow.authorizationUrl = Option.some(url)
  },
  saveCodeVerifier: (verifier) => {
    flow.verifier = verifier
  },
  codeVerifier: () => flow.verifier,
})

/**
 * A new token for `login` from its refresh token, stored; none when it has
 * no refresh token or the authorization server refused it. Discovery starts
 * from `named`, the metadata URL a 401 just named, else the stored one.
 */
const refreshLogin = (
  server: McpServer,
  config: HttpServerConfig,
  store: AuthStore,
  login: StoredLogin,
  named: Option.Option<URL>,
) =>
  Effect.gen(function* () {
    if (Predicate.isUndefined(login.tokens.refresh_token)) return Option.none<StoredLogin>()
    const now = yield* Clock.currentTimeMillis
    const flow = emptyFlow(Option.some(login.client))
    const provider = flowProvider(
      server.name,
      login.redirectUri,
      flow,
      Option.some(login),
      Option.none(),
    )
    const metadata = Option.orElse(named, () => storedMetadata(login))
    // The step this runs in is not interrupted (`refreshUnlessFresh`), so this
    // signal is what ends every request of the refresh by `REFRESH_BOUND`.
    const signal = AbortSignal.timeout(Duration.toMillis(REFRESH_BOUND))
    const fetchWeb = yield* FetchHttpClient.Fetch
    const result = yield* Effect.tryPromise(() =>
      auth(provider, {
        ...authOptions(config, metadata),
        fetchFn: (url, init) => fetchWeb(url, { ...init, signal }),
      }),
    )
    if (result !== "AUTHORIZED" || Option.isNone(flow.tokens)) return Option.none<StoredLogin>()
    const refreshed = loginFrom(
      flow.tokens.value,
      Option.getOrElse(flow.client, () => login.client),
      login.redirectUri,
      metadata,
      now,
    )
    yield* writeLogin(store, authKey(server, config), refreshed)
    return Option.some(refreshed)
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("mcp.oauth.refresh.failed").pipe(
        Effect.annotateLogs({ server: server.name, error: failureMessage(Cause.squash(cause)) }),
        Effect.as(Option.none<StoredLogin>()),
      ),
    ),
  )

/** The stored login, refreshed first when its token expires within `REFRESH_SKEW`. */
const loginBeforeDial = (server: McpServer, config: HttpServerConfig, store: AuthStore) =>
  Effect.gen(function* () {
    const login = yield* readLogin(store, authKey(server, config))
    if (Option.isNone(login)) return login
    const now = yield* Clock.currentTimeMillis
    if (!nearExpiry(login.value, now)) return login
    return yield* refreshUnlessFresh(
      server,
      config,
      store,
      (stored, at) => !nearExpiry(stored, at),
      Option.none(),
    )
  })

/** The login's token expires within `REFRESH_SKEW` of `now`. */
const nearExpiry = (login: StoredLogin, now: number) =>
  Option.exists(
    Option.fromUndefinedOr(login.expiresAt),
    (expiresAt) => expiresAt - Duration.toMillis(REFRESH_SKEW) <= now,
  )

/**
 * Refreshes the stored login under the auth lock, unless the login read again
 * under the lock is `fresh`. So of two refreshes of one login, in this
 * process or another, the second finds the token the first stored and uses
 * it; it never redeems the refresh token the first already spent. None when
 * there is no login, or the refresh or the lock failed.
 *
 * The token request and the stored login are one step that is not
 * interrupted: a dial that times out, or a request the SDK aborts, waits for
 * it, since a refresh token the server spent is lost unless the new one is
 * stored. `REFRESH_BOUND` ends the step well inside `AUTH_LOCK_STALE`, so no
 * other process takes the lock over while it runs. The wait for the lock is
 * interrupted as usual.
 */
const refreshUnlessFresh = (
  server: McpServer,
  config: HttpServerConfig,
  store: AuthStore,
  fresh: (login: StoredLogin, now: number) => boolean,
  named: Option.Option<URL>,
) =>
  Effect.gen(function* () {
    const key = authKey(server, config)
    const refresh = Effect.gen(function* () {
      const login = yield* readLogin(store, key)
      if (Option.isNone(login)) return login
      if (fresh(login.value, yield* Clock.currentTimeMillis)) return login
      return yield* refreshLogin(server, config, store, login.value, named)
    })
    return yield* Effect.uninterruptible(refresh).pipe(underAuthLock(store))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("mcp.oauth.refresh.failed").pipe(
        Effect.annotateLogs({ server: server.name, error: failureMessage(Cause.squash(cause)) }),
        Effect.as(Option.none<StoredLogin>()),
      ),
    ),
  )

/** An auth lock older than this was left by a holder that died; no refresh takes this long. */
const AUTH_LOCK_STALE = Duration.seconds(30)
/** The longest a refresh's requests run: well inside `AUTH_LOCK_STALE`. */
const REFRESH_BOUND = Duration.seconds(20)
/** How often a writer tries a held lock again, and how many times before it gives up. */
const AUTH_LOCK_RETRY = { schedule: Schedule.spaced("50 millis"), times: 1200 }

/** Another writer held the auth lock for longer than a stale lock lives. */
class AuthLockBusy extends Schema.TaggedError<AuthLockBusy>()("AuthLockBusy", {
  message: Schema.String,
}) {}

/**
 * Runs an effect while holding the lock of the login file: `<data
 * dir>/mcp-auth.json.lock`, created with `wx`, so one holder at a time across
 * every gent process on the data directory. Every refresh and every stored
 * login holds it, so two writers of different logins never read the same
 * file and each drop the other's token. Refreshes are rare, so one lock for
 * every server costs nothing. The holder removes the file when done. A file
 * older than `AUTH_LOCK_STALE` is a dead holder's, and the next taker removes
 * it first.
 */
const underAuthLock =
  (store: AuthStore) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = `${store.file}.lock`
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      // One try is not interrupted between the create and its answer, so an
      // interrupted wait never leaves a lock it made; the wait between tries is.
      const take = Effect.gen(function* () {
        const taken = yield* fs.writeFileString(file, "", { flag: "wx", mode: 0o600 }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
          Effect.uninterruptible,
        )
        if (taken) return
        const now = yield* Clock.currentTimeMillis
        const modified = Option.flatMap(yield* Effect.option(fs.stat(file)), (info) => info.mtime)
        if (
          Option.exists(modified, (at) => now - at.getTime() > Duration.toMillis(AUTH_LOCK_STALE))
        ) {
          yield* Effect.ignore(fs.remove(file))
        }
        return yield* new AuthLockBusy({ message: `the auth lock ${file} stays held` })
      })
      return yield* Effect.acquireUseRelease(
        Effect.interruptible(Effect.retry(take, AUTH_LOCK_RETRY)),
        () => effect,
        () => Effect.ignore(fs.remove(file)),
      )
    })

const JsonRpcMethod = Schema.fromJsonString(Schema.Struct({ method: Schema.String }))

/** The JSON-RPC method a request sends, or `GET` for a stream a transport opens. */
const requestMethod = (init: Option.Option<RequestInit>) => {
  const method = Option.getOrElse(
    Option.flatMap(init, (value) => Option.fromUndefinedOr(value.method)),
    () => "GET",
  )
  if (method === "GET") return "GET"
  return Option.match(
    Option.flatMap(
      Option.flatMap(init, (value) => Option.fromNullishOr(value.body)),
      Schema.decodeUnknownOption(JsonRpcMethod),
    ),
    { onNone: () => "", onSome: (message) => message.method },
  )
}

/** What a transport takes to send a server's OAuth token. */
interface OAuthTransport {
  readonly authProvider: OAuthClientProvider
  readonly fetch: SdkFetch
}

/**
 * The OAuth parts of a `url` entry's transport, when it signs in with OAuth.
 * The provider only hands the SDK the stored bearer token; it never starts a
 * login. The fetch answers each 401 or 403 before the SDK sees it: a 401 on
 * a request in `REPLAYABLE` refreshes the token and sends that request once
 * more, and any other refusal fails with `LoginRequired`, whose message names
 * `/mcp login <server>`. So a `tools/call` is never sent twice.
 */
const oauthTransport = (server: McpServer, config: HttpServerConfig, store: AuthStore) =>
  Effect.gen(function* () {
    if (!usesOAuth(config)) return Option.none<OAuthTransport>()
    let current = yield* loginBeforeDial(server, config, store)
    const tokens = () => Option.getOrUndefined(Option.map(current, (login) => login.tokens))
    const authProvider: OAuthClientProvider = {
      ...flowProvider(server.name, "", emptyFlow(Option.none()), current, Option.none()),
      get redirectUrl() {
        return Option.getOrUndefined(Option.map(current, (login) => login.redirectUri))
      },
      tokens,
    }
    const fetchWeb = yield* FetchHttpClient.Fetch
    const send = (url: string | URL, init: Option.Option<RequestInit>) =>
      Effect.promise(() => fetchWeb(url, Option.getOrUndefined(init)))
    const answer = (url: string | URL, init: Option.Option<RequestInit>) =>
      Effect.gen(function* () {
        const response = yield* send(url, init)
        if (response.status !== 401 && response.status !== 403) return response
        if (response.status === 401 && REPLAYABLE.has(requestMethod(init))) {
          const refreshed = yield* Option.match(current, {
            onNone: () => Effect.succeed(Option.none<StoredLogin>()),
            // A stored token other than the refused one is another refresh's; it is used as it is.
            onSome: (refused) =>
              refreshUnlessFresh(
                server,
                config,
                store,
                (stored) => stored.tokens.access_token !== refused.tokens.access_token,
                Option.fromUndefinedOr(extractResourceMetadataUrl(response)),
              ),
          })
          if (Option.isSome(refreshed)) {
            current = refreshed
            const headers = new Headers(
              Option.getOrUndefined(Option.map(init, (value) => value.headers)),
            )
            headers.set("Authorization", `Bearer ${refreshed.value.tokens.access_token}`)
            const retried = yield* send(
              url,
              Option.some({ ...Option.getOrElse(init, () => ({})), headers }),
            )
            if (retried.status !== 401 && retried.status !== 403) return retried
          }
        }
        return yield* loginRequired(server.name)
      })
    const transport: OAuthTransport = {
      authProvider,
      fetch: sdkFetch(store.services, answer),
    }
    return Option.some(transport)
  })

/** The login a `/mcp login` started: its URL, and the effect that waits for the redirect and finishes it. */
interface LoginStart {
  readonly url: string
  readonly finish: Effect.Effect<StoredLogin, McpError>
}

/**
 * Starts a login to `server`: a loopback listener on 127.0.0.1 for the
 * redirect, the resource metadata URL the server names in a 401 (see
 * `namedMetadata`), the SDK's client registration and PKCE authorization URL. The
 * listener lives in `scope`. `finish` waits up to `LOGIN_TIMEOUT` for the
 * redirect, exchanges its code, and stores the login.
 */
const startLogin = (
  server: McpServer,
  config: HttpServerConfig,
  store: AuthStore,
  scope: Scope.Scope,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const state = Base64Url.encode(yield* crypto.randomBytes(24))
    const code = yield* Deferred.make<string, McpError>()
    const port = yield* serveRedirect(server, state, code).pipe(Scope.provide(scope))
    const redirectUri = `http://127.0.0.1:${port}/callback`
    const flow = emptyFlow(Option.none())
    const metadata = yield* namedMetadata(config)
    const provider = flowProvider(server.name, redirectUri, flow, Option.none(), Option.some(state))
    const fail = (message: string) => new McpError({ server: server.name, message })
    yield* Effect.tryPromise({
      try: () => auth(provider, authOptions(config, metadata)),
      catch: (cause) => fail(`login: ${failureMessage(cause)}`),
    })
    if (Option.isNone(flow.authorizationUrl)) {
      return yield* fail("login: the authorization server gave no login URL")
    }
    const finish = Effect.gen(function* () {
      const received = yield* Deferred.await(code).pipe(
        Effect.timeoutOrElse({
          duration: LOGIN_TIMEOUT,
          orElse: () => Effect.fail(fail("login: no redirect came within 5 minutes")),
        }),
      )
      yield* Effect.tryPromise({
        try: () =>
          auth(provider, { ...authOptions(config, metadata), authorizationCode: received }),
        catch: (cause) => fail(`login: ${failureMessage(cause)}`),
      })
      if (Option.isNone(flow.tokens) || Option.isNone(flow.client)) {
        return yield* fail("login: the authorization server gave no token")
      }
      const login = loginFrom(
        flow.tokens.value,
        flow.client.value,
        redirectUri,
        metadata,
        yield* Clock.currentTimeMillis,
      )
      yield* writeLogin(store, authKey(server, config), login).pipe(underAuthLock(store))
      return login
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        Context.get(store.services, FileSystem.FileSystem),
      ),
      Effect.provideService(Path.Path, Context.get(store.services, Path.Path)),
      Effect.mapError((error) => {
        if (error._tag === "McpError") return error
        return fail(`login: ${error.message}`)
      }),
    )
    const started: LoginStart = { url: flow.authorizationUrl.value.href, finish }
    return started
  })

/** Closes a login's `scope` unless its start succeeded: a failed or interrupted start owns no listener. */
const closeOnFailure = (scope: Scope.Closeable, exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return Effect.void
  return Scope.close(scope, exit)
}

/** The loopback listener for a login's redirect, on a free port; its port. */
const serveRedirect = (
  server: McpServer,
  state: string,
  code: Deferred.Deferred<string, McpError>,
) =>
  Effect.gen(function* () {
    const app = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://127.0.0.1")
      const param = (name: string) => Option.fromNullishOr(url.searchParams.get(name))
      if (url.pathname !== "/callback") return HttpServerResponse.text("not found", { status: 404 })
      // A request without this login's state is not its redirect; the wait goes on.
      if (!Option.contains(param("state"), state)) {
        return HttpServerResponse.text("this is not the login gent started", { status: 400 })
      }
      const refused = param("error")
      if (Option.isSome(refused)) {
        const message = Option.getOrElse(param("error_description"), () => refused.value)
        yield* Deferred.fail(
          code,
          new McpError({ server: server.name, message: `login: ${message}` }),
        )
        return HttpServerResponse.text(`gent: the login failed: ${message}`, { status: 400 })
      }
      const received = param("code").pipe(Option.filter((value) => value !== ""))
      if (Option.isNone(received)) {
        return HttpServerResponse.text("the redirect carries no code", { status: 400 })
      }
      yield* Deferred.succeed(code, received.value)
      return HttpServerResponse.text(`gent is logged in to ${server.name}. You can close this tab.`)
    })
    const context = yield* Layer.build(
      HttpServer.serve(app).pipe(
        Layer.provideMerge(BunHttpServer.layerServer({ port: 0, hostname: "127.0.0.1" })),
      ),
    )
    const address = Context.get(context, HttpServer.HttpServer).address
    if (address._tag === "UnixPathAddress") {
      return yield* new McpError({ server: server.name, message: "login: no loopback port" })
    }
    return address.port
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
 *
 * It is read from the ambient `ConfigProvider`, the environment seam every
 * other read here uses. Each setup reads it at most once (see
 * `HostEnvironment`): a name with a numeric segment (`DB_PORT_5432_TCP`)
 * makes its parent an array node, and the walk loads every index below the
 * largest one.
 */
const hostEnvironment = Effect.gen(function* () {
  const provider = yield* ConfigProvider.ConfigProvider
  const environment = new Map<string, string>()
  // The environment provider nests a name at each `_`; the walk joins the path back.
  const walk = (path: ReadonlyArray<string>, listed: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      const loaded = yield* Effect.option(provider.load(path))
      if (Option.isNone(loaded)) return
      const node = loaded.value
      if (Predicate.isUndefined(node)) {
        // A record lists only names the environment holds, and the provider reads
        // an empty value as missing: a listed name that loads nothing is set empty.
        // An array node keeps only its length, so its missing and empty indices look alike.
        if (listed) environment.set(path.join("_"), "")
        return
      }
      if (Predicate.isString(node.value) && path.length > 0) {
        environment.set(path.join("_"), node.value)
      }
      let children: ReadonlyArray<string> = []
      if (node._tag === "Record") children = [...node.keys]
      if (node._tag === "Array") {
        children = Array.from({ length: node.length }, (_, index) => String(index))
      }
      const listsChildren = node._tag === "Record"
      yield* Effect.forEach(children, (child) => walk([...path, child], listsChildren), {
        discard: true,
      })
    })
  yield* walk([], false)
  return Object.fromEntries(environment)
})

/**
 * The host environment as setup hands it to every stdio dial: `hostEnvironment`
 * under `Effect.cached`, so each setup walks the environment once.
 */
type HostEnvironment = Effect.Effect<Readonly<Record<string, string>>>

/** The transport a connection runs over. */
const TransportKind = Schema.Literals(["stdio", "streamable-http", "sse"])
type TransportKind = typeof TransportKind.Type

const transportFor = (
  server: McpServer,
  kind: TransportKind,
  environment: Readonly<Record<string, string>>,
  oauth: Option.Option<OAuthTransport>,
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
  const options = {
    requestInit: { headers: { ...config.headers } },
    ...Option.getOrElse(oauth, () => ({})),
  }
  if (kind === "sse") return new SSEClientTransport(new URL(config.url), options)
  return new StreamableHTTPClientTransport(new URL(config.url), options)
}

/** The HTTP status a failed connect was answered with, when it has one. */
const statusOf = (cause: unknown): Option.Option<number> => {
  if (cause instanceof StreamableHTTPError || cause instanceof SseError) {
    return Option.fromUndefinedOr(cause.code)
  }
  if (Schema.is(LoginRequired)(cause)) return Option.some(401)
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
  oauth: Option.Option<OAuthTransport>,
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
      try: () => client.connect(transportFor(server, kind, environment, oauth)),
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
 * answers with a status in `SSE_FALLBACK_STATUSES`. A `url` entry without
 * its own `Authorization` header signs in with its stored OAuth login (see
 * `oauthTransport`). `onToolsChanged` runs on each
 * `notifications/tools/list_changed` of a server that declares it sends them.
 */
const connect = (
  server: McpServer,
  auth: AuthStore,
  environment: HostEnvironment,
  onToolsChanged: Option.Option<() => void> = Option.none(),
) =>
  Effect.gen(function* () {
    const config = server.config
    if ("command" in config) {
      return yield* dial(server, "stdio", yield* environment, Option.none(), onToolsChanged)
    }
    const oauth = yield* oauthTransport(server, config, auth)
    const type = config.type ?? "auto"
    if (type === "sse") return yield* dial(server, "sse", {}, oauth, onToolsChanged)
    const streamable = dial(server, "streamable-http", {}, oauth, onToolsChanged)
    if (type !== "auto") return yield* streamable
    return yield* streamable.pipe(
      Effect.catchTag("McpError", (error) => {
        if (!SSE_FALLBACK_STATUSES.has(error.status ?? 0)) return Effect.fail(error)
        return dial(server, "sse", {}, oauth, onToolsChanged).pipe(
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

/**
 * Every page of `tools/list`. The request goes out with the SDK's loose
 * result schema, not `client.listTools`, whose schema refuses the whole page
 * for one malformed entry; each entry decodes here instead, and one the
 * spec's tool shape refuses is skipped with a warning. So the SDK keeps no
 * output-schema validators, and the tool checks structured content itself.
 */
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
        try: (signal) =>
          client.request({ method: "tools/list", params }, ResultSchema, {
            signal,
            timeout: timeoutOf(server),
          }),
        catch: (cause) =>
          new McpError({ server: server.name, message: `tools/list: ${failureMessage(cause)}` }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ListToolsPage)),
        Effect.mapError(
          (error) => new McpError({ server: server.name, message: failureMessage(error) }),
        ),
      )
      for (const [index, entry] of listed.tools.entries()) {
        const tool = yield* Effect.result(catalogToolOf(entry))
        if (Result.isSuccess(tool)) {
          tools.push(tool.success)
          continue
        }
        yield* Effect.logWarning("mcp.tools.skipped").pipe(
          Effect.annotateLogs({ server: server.name, entry: index, error: tool.failure.message }),
        )
      }
      cursor = Option.fromNullishOr(listed.nextCursor)
      if (Option.isNone(cursor)) break
    }
    return tools
  })

/** A listing as the cache keeps it. */
const catalogServerOf = (
  tools: ReadonlyArray<CatalogTool>,
  instructions: Option.Option<string>,
): CatalogServer => ({
  tools,
  ...omitUndefined({ instructions: Option.getOrUndefined(instructions) }),
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
 * a JSON-RPC error, or an HTTP status that says nothing about the connection
 * (a 404 without a session included: a gateway can answer it after the server
 * ran the call), so the connection stays. `expired`: HTTP 404 to a request
 * that carried an `Mcp-Session-Id`, a session the server no longer knows, so
 * it ran nothing. `dead`: the transport failed (the connection closed, the
 * call timed out, HTTP 400 or 408, a network error). `refused`: HTTP 401 or
 * 403, or an OAuth token no refresh helped (see `oauthTransport`): the server
 * no longer takes the entry's credential. `stale`: the server answered that
 * it has no such tool, so the catalog is out of date.
 */
const CallFailureKind = Schema.Literals(["answered", "expired", "dead", "refused", "stale"])
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

/** HTTP statuses that end a connection: the request or the session is bad. */
const DEAD_STATUSES: ReadonlySet<number> = new Set([400, 408])
/** HTTP statuses that refuse the credential. */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403])

/** JSON-RPC codes the SDK raises itself, for a closed connection or a timeout; no server sent them. */
const CLIENT_RAISED: ReadonlySet<number> = new Set<number>([
  ErrorCode.ConnectionClosed,
  ErrorCode.RequestTimeout,
])
const INVALID_PARAMS: number = ErrorCode.InvalidParams

/** `hadSession`: the request carried the transport's `Mcp-Session-Id`. */
const failureKind = (cause: unknown, name: string, hadSession: boolean): CallFailureKind => {
  if (Schema.is(LoginRequired)(cause)) return "refused"
  if (cause instanceof ProtocolError) {
    if (CLIENT_RAISED.has(cause.code)) return "dead"
    if (cause.code === INVALID_PARAMS && isUnknownToolMessage(cause.message, name)) return "stale"
    return "answered"
  }
  if (cause instanceof StreamableHTTPError) {
    const status = cause.code ?? 0
    if (status === 404 && hadSession) return "expired"
    if (REFUSED_STATUSES.has(status)) return "refused"
    if (DEAD_STATUSES.has(status)) return "dead"
    return "answered"
  }
  return "dead"
}

/** The failures that drop the connection: the next call dials again, with the credential as it is then. */
const DROPPING_FAILURES: ReadonlySet<CallFailureKind> = new Set(["dead", "expired", "refused"])

/** A failed call's message, with the HTTP status the server answered, when it did. */
const callFailureMessage = (name: string, cause: unknown) =>
  Option.match(statusOf(cause), {
    onNone: () => `${name}: ${failureMessage(cause)}`,
    onSome: (status) => `${name}: ${failureMessage(cause)} (HTTP ${status})`,
  })

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
  /** Starts an OAuth login to the named server; the URL to open (see `login` in `mcpClientsLive`). */
  readonly login: (name: string) => Effect.Effect<string, McpError>
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

/** What this process holds for one registered server; `status` is a projection of it. */
interface ServerState {
  readonly entry: RegisteredServer
  /** Its lists run one at a time, so an older list never lands last. */
  readonly listPermit: Semaphore.Semaphore
  /** The connection it holds now, so a late close never drops its successor. */
  connection: Option.Option<Connection>
  /** The last accepted listing, which a new list is compared with. */
  catalog: CatalogServer
  health: ServerHealth
  /** The login it waits for, so a second `/mcp login` replaces the first. */
  pendingLogin: Option.Option<Fiber.Fiber<void>>
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
const mcpClientsLive = ({
  registered,
  misconfigured,
  file,
  blobs,
  auth,
  environment,
}: {
  readonly registered: ReadonlyArray<RegisteredServer>
  readonly misconfigured: ReadonlyArray<MisconfiguredServer>
  /** The catalog cache. */
  readonly file: string
  /** The directory binary blocks are written to. */
  readonly blobs: string
  readonly auth: AuthStore
  readonly environment: HostEnvironment
}) =>
  Layer.effect(
    McpClients,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const blobStore = yield* makeBlobStore(blobs)
      const writePermit = yield* Semaphore.make(1)
      /** Each registered server's state, under its cache key. */
      const states = new Map(
        yield* Effect.forEach(registered, (entry) =>
          Effect.map(Semaphore.make(1), (listPermit) => {
            const state: ServerState = {
              entry,
              listPermit,
              connection: Option.none(),
              catalog: entry.catalog,
              health: setupHealth(entry),
              pendingLogin: Option.none(),
            }
            return [entry.server.key, state] as const
          }),
        ),
      )
      const stateOf = (server: McpServer) =>
        Effect.fromOption(Option.fromUndefinedOr(states.get(server.key))).pipe(
          Effect.mapError(() => new McpError({ server: server.name, message: "not configured" })),
        )
      const runFork = yield* FiberSet.makeRuntime<FileSystem.FileSystem | Path.Path>()
      /** The layer's scope: each login's listener lives in a child of it. */
      const layerScope = yield* Scope.Scope
      const setHealth = (state: ServerState, health: McpHealth, reason: Option.Option<string>) => {
        state.health = { health, reason }
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
      const listNames = (state: ServerState, client: Client, instructions: Option.Option<string>) =>
        Effect.gen(function* () {
          const { server } = state.entry
          const previous = state.catalog
          const tools = yield* listTools(server, client)
          if (tools.length === 0 && previous.tools.length > 0) {
            yield* Effect.logWarning("mcp.server.relist.empty").pipe(
              Effect.annotateLogs({ server: server.name }),
            )
            setHealth(
              state,
              "degraded",
              Option.some(`listed no tools; kept the ${previous.tools.length} listed before`),
            )
            return namesOf(previous.tools)
          }
          const next = catalogServerOf(tools, instructions)
          state.catalog = next
          setHealth(state, "healthy", Option.none())
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
            setHealth(state, "degraded", Option.some(message))
            return Effect.logWarning("mcp.server.relist.failed").pipe(
              Effect.annotateLogs({ server: state.entry.server.name, error: message }),
              Effect.as(namesOf(state.catalog.tools)),
            )
          }),
        )
      /**
       * `listNames` under the server's list permit, handing the names to
       * `apply` before the permit is released, so lists and their results
       * land in the order they were asked for.
       */
      const relist = (
        state: ServerState,
        client: Client,
        instructions: Option.Option<string>,
        apply: (names: ReadonlySet<string>) => void,
      ) =>
        Semaphore.withPermit(
          state.listPermit,
          listNames(state, client, instructions).pipe(Effect.map((names) => apply(names))),
        )
      /** Lists an open connection's tools again, off the call that asked. */
      const refresh = (state: ServerState, connection: Connection) =>
        runFork(
          relist(state, connection.client, connection.instructions, (names) => {
            connection.listed = names
          }),
        )
      const clients = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.gen(function* () {
            const state = Option.fromUndefinedOr(states.get(key))
            if (Option.isNone(state)) {
              return yield* new McpError({ server: key, message: "not configured" })
            }
            // The notification can only arrive once the connection below exists.
            let onToolsChanged = () => {}
            const { client, transport, instructions } = yield* connect(
              state.value.entry.server,
              auth,
              environment,
              Option.some(() => onToolsChanged()),
            )
            const connection: Connection = {
              client,
              transport,
              instructions,
              listed: new Set(),
              closed: false,
              calls: 0,
            }
            yield* relist(state.value, client, instructions, (names) => {
              connection.listed = names
            })
            onToolsChanged = () => refresh(state.value, connection)
            state.value.connection = Option.some(connection)
            // Runs before the client closes, so its own close event finds nothing to drop.
            yield* Effect.addFinalizer(() => Effect.sync(() => forget(state.value, connection)))
            client.onclose = () => {
              connection.closed = true
              if (Option.contains(state.value.connection, connection)) {
                setHealth(state.value, "degraded", Option.some("the connection closed"))
              }
              runFork(evict(state.value, connection))
            }
            return connection
          }),
        idleTimeToLive: IDLE_TIME_TO_LIVE,
      })
      /** Whether `connection` was the server's current one; it no longer is. */
      const forget = (state: ServerState, connection: Connection) => {
        if (!Option.contains(state.connection, connection)) return false
        state.connection = Option.none()
        return true
      }
      const evict = (state: ServerState, connection: Connection) =>
        Effect.suspend(() => {
          if (!forget(state, connection)) return Effect.void
          return RcMap.invalidate(clients, state.entry.server.key)
        })
      const acquire = (state: ServerState) =>
        RcMap.get(clients, state.entry.server.key).pipe(
          // RcMap keeps a failed lookup until it idles out; drop it so the next call connects.
          Effect.tapError((error) =>
            Effect.andThen(
              Effect.sync(() => {
                state.health = failureHealth(error)
              }),
              RcMap.invalidate(clients, state.entry.server.key),
            ),
          ),
        )
      /** The server's connection; one whose transport already closed ran nothing, so it is replaced. */
      const open = (state: ServerState) =>
        Effect.gen(function* () {
          const connection = yield* acquire(state)
          if (!connection.closed) return connection
          yield* evict(state, connection)
          return yield* acquire(state)
        })
      /** One `tools/call` on the server's connection, which the failure's kind then drops or relists. */
      const callOnce = (
        state: ServerState,
        name: string,
        input: Readonly<Record<string, Schema.Json>>,
      ) =>
        Effect.gen(function* () {
          const { server } = state.entry
          const connection = yield* open(state)
          if (!connection.listed.has(name)) {
            return yield* new McpError({ server: server.name, message: staleMessage(name) })
          }
          const reused = connection.calls > 0
          connection.calls += 1
          // Read before the call: the transport sends this session id with it.
          const hadSession = Predicate.isNotUndefined(connection.client.transport?.sessionId)
          const send = Effect.gen(function* () {
            const value = yield* Effect.tryPromise({
              try: (signal) =>
                // oxlint-disable-next-line effect/noNullish -- the SDK takes its default result schema positionally
                connection.client.callTool({ name, arguments: input }, undefined, {
                  signal,
                  timeout: timeoutOf(server),
                }),
              catch: (cause) => {
                const kind = failureKind(cause, name, hadSession)
                let message = callFailureMessage(name, cause)
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
                setHealth(state, "degraded", Option.some(failed.message))
              }
              if (failed.kind === "refused") {
                setHealth(state, "expired", Option.some(failed.message))
              }
              if (DROPPING_FAILURES.has(failed.kind)) return evict(state, connection)
              if (failed.kind === "stale") return Effect.sync(() => refresh(state, connection))
              return Effect.void
            }),
          )
        })
      /** Waits for a started login's redirect, then connects with its token; closes `scope` at the end. */
      const finishLogin = (state: ServerState, started: LoginStart, scope: Scope.Closeable) =>
        Effect.gen(function* () {
          yield* started.finish
          // A connection opened before the login sends no token; the next one does.
          if (Option.isSome(state.connection)) yield* evict(state, state.connection.value)
          yield* Effect.scoped(acquire(state))
          yield* Effect.logInfo("mcp.oauth.login.done").pipe(
            Effect.annotateLogs({ server: state.entry.server.name }),
          )
        }).pipe(
          Effect.catchCause((cause) => {
            const message = failureMessage(Cause.squash(cause))
            setHealth(state, "expired", Option.some(message))
            return Effect.logWarning("mcp.oauth.login.failed").pipe(
              Effect.annotateLogs({ server: state.entry.server.name, error: message }),
            )
          }),
          Effect.ensuring(Scope.close(scope, Exit.void)),
          Effect.ensuring(
            Effect.sync(() => {
              state.pendingLogin = Option.none()
            }),
          ),
        )
      /**
       * Starts a login to the server named `name` and returns its URL at
       * once. A process fiber waits for the redirect, stores the tokens, and
       * connects with them, which lists the tools into the cache; `/mcp`
       * shows how it went. No turn and no request waits for the browser.
       */
      const login = (name: string) =>
        Effect.gen(function* () {
          const found = Option.fromUndefinedOr(
            [...states.values()].find((candidate) => candidate.entry.server.name === name),
          )
          const config = Option.flatMap(found, (candidate) => {
            const entry = candidate.entry.server.config
            if (usesOAuth(entry)) return Option.some(entry)
            return Option.none()
          })
          if (Option.isNone(found) || Option.isNone(config)) {
            const names = registered
              .filter((candidate) => usesOAuth(candidate.server.config))
              .map((candidate) => candidate.server.name)
            return yield* new McpError({
              server: name,
              message: `no MCP server named ${name} signs in with OAuth; these do: ${names.join(", ") || "none"}`,
            })
          }
          const state = found.value
          if (Option.isSome(state.pendingLogin)) yield* Fiber.interrupt(state.pendingLogin.value)
          // The listener's scope is a child of the layer's from its creation. A
          // start that fails or is interrupted closes it; a start that
          // succeeds hands it to the finishing fiber in the same
          // uninterruptible step, so no gap leaves the listener unowned.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const scope = yield* Scope.fork(layerScope)
              const started = yield* restore(
                startLogin(state.entry.server, config.value, auth, scope).pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.mapError((error) => {
                    if (error._tag === "McpError") return error
                    return new McpError({ server: name, message: `login: ${error.message}` })
                  }),
                ),
              ).pipe(Effect.onExit((exit) => closeOnFailure(scope, exit)))
              state.pendingLogin = Option.some(runFork(finishLogin(state, started, scope)))
              return started.url
            }),
          )
        })
      return McpClients.of({
        login,
        call: (server, name, input) =>
          Effect.gen(function* () {
            const state = yield* stateOf(server)
            return yield* callOnce(state, name, input).pipe(
              Effect.catchTag("CallFailed", (failed) => {
                if (failed.kind === "expired" && failed.reused) return callOnce(state, name, input)
                return Effect.fail(failed)
              }),
            )
          }).pipe(
            Effect.mapError((error) => {
              if (error._tag === "McpError") return error
              return new McpError({ server: server.name, message: error.message })
            }),
            Effect.scoped,
          ),
        status: Effect.sync(() => {
          const servers = [...states.values()].map((state): McpServerStatus => {
            const { server } = state.entry
            const connection = Option.filter(state.connection, (open) => !open.closed)
            return {
              name: server.name,
              transport: Option.match(connection, {
                onNone: () => configuredTransport(server.config),
                onSome: (open) => open.transport,
              }),
              health: state.health.health,
              connected: Option.isSome(connection),
              tools: state.catalog.tools.length,
              ...omitUndefined({
                description: state.catalog.instructions,
                reason: Option.getOrUndefined(state.health.reason),
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
            servers: servers.toSorted((left, right) => compareIds(left.name, right.name)),
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
const toolsFor = (server: McpServer, catalog: CatalogServer) => {
  const listed = catalog.tools
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
 * A server's catalog entry, whether setup listed it now, whether a cached
 * entry is stamped again (either goes to the cache), and the failure of a
 * setup listing that did not work.
 */
interface SetupCatalog {
  readonly catalog: CatalogServer
  readonly listedNow: boolean
  readonly restamp: boolean
  readonly failure: Option.Option<McpError>
}

/**
 * The server's tools from the cache, or, on a miss, from one connection at
 * setup that lists them. A server that cannot list is reported and
 * contributes nothing; the other servers are unaffected.
 */
const catalogFor = (
  server: McpServer,
  cache: CatalogFile,
  auth: AuthStore,
  environment: HostEnvironment,
  now: number,
) => {
  const cached = cache.servers[server.key]
  if (Predicate.isNotUndefined(cached)) {
    return Effect.succeed<SetupCatalog>({
      catalog: catalogOf(cached),
      listedNow: false,
      restamp: needsRestamp(cached, now),
      failure: Option.none(),
    })
  }
  const unlisted = (error: McpError) =>
    Effect.logWarning("mcp.server.unlisted").pipe(
      Effect.annotateLogs({ server: server.name, error: error.message }),
      Effect.as<SetupCatalog>({
        catalog: { tools: [] },
        listedNow: false,
        restamp: false,
        failure: Option.some(error),
      }),
    )
  return Effect.scoped(
    Effect.gen(function* () {
      const { client, instructions } = yield* connect(server, auth, environment)
      return catalogServerOf(yield* listTools(server, client), instructions)
    }),
  ).pipe(
    Effect.map((catalog): SetupCatalog => ({
      catalog,
      listedNow: true,
      restamp: false,
      failure: Option.none(),
    })),
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

/**
 * `/mcp` shows `mcp.status` to the user. `/mcp login <server>` starts that
 * server's OAuth login and shows the URL to open; the login finishes in the
 * background, and `/mcp` shows the result. The URL is shown, not opened: the
 * gent server may run on another machine than the browser. With no server
 * configured there is no pool, and `/mcp` says where to add one.
 */
const NO_SERVERS =
  "No MCP servers are configured. Add one to ~/.gent/mcp.json, or to .gent/mcp.json in a trusted project."

const McpCommand = request({
  id: "mcp-command",
  description: "Show the MCP servers, or log in to one",
  slash: {
    trigger: "mcp",
    name: "MCP",
    description: "/mcp · status of each MCP server · login <server>",
    category: "Tools",
  },
  input: Schema.String,
  output: Schema.Void,
  execute: (input: string) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const pool = yield* Effect.serviceOption(McpClients)
      if (Option.isNone(pool)) {
        return yield* ctx.Interaction.present({ title: "MCP servers", content: NO_SERVERS })
      }
      const clients = pool.value
      const words = input.trim().split(/\s+/)
      if (words[0] === "login") {
        const name = words[1] ?? ""
        const content = yield* clients.login(name).pipe(
          Effect.map(
            (url) =>
              `Open this URL to log in to the ${name} MCP server. gent waits 5 minutes for the redirect, then lists the server's tools; run /mcp to see the result.\n\n${url}`,
          ),
          Effect.catchTag("McpError", (error) => Effect.succeed(error.message)),
        )
        return yield* ctx.Interaction.present({ title: "MCP login", content })
      }
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
  environment: HostEnvironment,
) {
  const host = yield* ExtensionHost
  const { servers, misconfigured } = yield* resolveServers(entries, host.cwd)
  // No server: `/mcp` still answers, and the model gets no status tool with nothing to report.
  if (servers.length === 0 && misconfigured.length === 0) {
    return yield* host.register("request", McpCommand)
  }
  const file = yield* catalogPath(host.home)
  const cache = yield* readCatalog(file)
  const auth = yield* makeAuthStore(host.home)
  const now = yield* Clock.currentTimeMillis
  const registered = yield* Effect.forEach(
    servers,
    (server) =>
      Effect.map(catalogFor(server, cache, auth, environment, now), (catalog) => ({
        server,
        ...catalog,
      })),
    { concurrency: 8 },
  )
  // One write for every server listed now or stamped again; a failed write only costs a relist.
  yield* writeCatalogEntries(
    file,
    registered
      .filter((entry) => entry.listedNow || entry.restamp)
      .map((entry): readonly [string, CatalogServer] => [entry.server.key, entry.catalog]),
  ).pipe(Effect.ignore)
  yield* host.register(
    "resource",
    defineResource({
      id: `${extensionId}/clients`,
      scope: "process",
      layer: mcpClientsLive({
        registered,
        misconfigured,
        file,
        blobs: yield* blobDirectory(host.home),
        auth,
        environment,
      }),
    }),
  )
  yield* host.register(
    "tool",
    McpStatusTool,
    ...registered.flatMap((entry) => toolsFor(entry.server, entry.catalog)),
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
    const entries = yield* readMcpConfig(host.home, host.cwd)
    yield* registerServers("@gent/mcp", entries, yield* Effect.cached(hostEnvironment))
  }),
})

/** The MCP extension over inline servers instead of the config files. */
export const McpServers = (id: string, entries: Readonly<Record<string, McpServerConfig>>) =>
  defineExtension({
    id,
    setup: Effect.gen(function* () {
      yield* registerServers(id, entries, yield* Effect.cached(hostEnvironment))
    }),
  })
