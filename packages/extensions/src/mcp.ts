import {
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Crypto,
  Equal,
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
import { Hex } from "effect/encoding"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  defineExtension,
  defineResource,
  ExtensionHost,
  hasProjectScope,
  isRecord,
  omitUndefined,
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
 * entry runs over stdio; a `url` entry over streamable HTTP. Strings may name
 * environment variables as `${NAME}` or `${NAME:-default}`.
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

const resolveServers = Effect.fn("Mcp.resolveServers")(function* (
  entries: Readonly<Record<string, McpServerConfig>>,
  sessionCwd: string,
) {
  const path = yield* Path.Path
  const servers: Array<McpServer> = []
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
      continue
    }
    servers.push({ name, key: key.success, config: expanded.success, cwd })
  }
  return servers
})

// ── catalog cache ───────────────────────────────────────────────────────────

/** One tool as `tools/list` describes it; the rest of its fields are ignored. */
const CatalogTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Json,
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

/** Each server's tools, keyed by the hash of its entry, so an edited entry lists again. */
const CatalogFile = Schema.fromJsonString(
  Schema.Struct({
    servers: Schema.Record(Schema.String, Schema.Struct({ tools: Schema.Array(CatalogTool) })),
  }),
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
  entries: ReadonlyArray<readonly [key: string, tools: ReadonlyArray<CatalogTool>]>,
) {
  if (entries.length === 0) return
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const current = yield* readCatalog(file)
  const servers = { ...current.servers }
  for (const [key, tools] of entries) servers[key] = { tools }
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* writeFileAtomic(file, yield* Schema.encodeEffect(CatalogFile)({ servers }))
})

// ── connections ─────────────────────────────────────────────────────────────

class McpError extends Schema.TaggedError<McpError>()("McpError", {
  server: Schema.String,
  message: Schema.String,
}) {}

const failureMessage = (cause: unknown) => {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

const timeoutOf = (server: McpServer) => server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS

const transportFor = (server: McpServer) => {
  const config = server.config
  if ("command" in config) {
    return new StdioClientTransport({
      command: config.command,
      args: [...(config.args ?? [])],
      env: { ...config.env },
      cwd: server.cwd,
      // The server's own log would land in the terminal gent draws.
      stderr: "ignore",
    })
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { ...config.headers } },
  })
}

/** An initialized client; closing its scope closes the transport, and a stdio server with it. */
const connect = (server: McpServer) =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new Client({ name: "gent", version: "1.0.0" })),
      (opened) => Effect.promise(() => opened.close()).pipe(Effect.ignore),
    )
    yield* Effect.tryPromise({
      try: () => client.connect(transportFor(server)),
      catch: (cause) =>
        new McpError({ server: server.name, message: `connect: ${failureMessage(cause)}` }),
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
    return client
  })

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

interface McpClientsService {
  /** Calls one tool on a server, opening its connection on first use. */
  readonly call: (
    server: McpServer,
    tool: string,
    input: Readonly<Record<string, Schema.Json>>,
  ) => Effect.Effect<CallResult, McpError>
}

/**
 * The open connections of this process, one per server entry. A server's
 * first call connects; a connection idle for `IDLE_TIME_TO_LIVE` closes. A
 * failed connect is not kept, so the next call tries again.
 */
class McpClients extends Context.Service<McpClients, McpClientsService>()(
  "@gent/extensions/src/mcp/McpClients",
) {}

/** A server this process registered, with the tools its registration read. */
interface RegisteredServer {
  readonly server: McpServer
  readonly tools: ReadonlyArray<CatalogTool>
}

/** An open connection and the tool names the server listed when it opened. */
interface Connection {
  readonly client: Client
  readonly listed: ReadonlySet<string>
}

/**
 * The connections of `registered`, each under its cache key, which names one
 * entry. Opening a connection lists the server's tools again: a tool it no
 * longer lists fails its call by name, and a list that differs from the one
 * registered is written to the cache, so the next session registers it. The
 * current session keeps the tools it registered; changing them live needs a
 * host seam to re-register an extension's tools.
 */
const mcpClientsLive = (registered: ReadonlyArray<RegisteredServer>, file: string) =>
  Layer.effect(
    McpClients,
    Effect.gen(function* () {
      const byKey = new Map(registered.map((entry) => [entry.server.key, entry]))
      const writePermit = yield* Semaphore.make(1)
      const relist = (entry: RegisteredServer, client: Client) =>
        Effect.gen(function* () {
          const tools = yield* listTools(entry.server, client)
          if (!Equal.equals(tools, entry.tools)) {
            yield* Semaphore.withPermit(
              writePermit,
              writeCatalogEntries(file, [[entry.server.key, tools]]),
            )
          }
          return new Set(tools.map((listed) => listed.name))
        })
      const clients = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.gen(function* () {
            const entry = byKey.get(key)
            if (Predicate.isUndefined(entry)) {
              return yield* new McpError({ server: key, message: "not configured" })
            }
            const client = yield* connect(entry.server)
            // A server that cannot list again keeps the registered list.
            const listed = yield* relist(entry, client).pipe(
              Effect.orElseSucceed(() => new Set(entry.tools.map((listed) => listed.name))),
            )
            return { client, listed } satisfies Connection
          }),
        idleTimeToLive: IDLE_TIME_TO_LIVE,
      })
      return McpClients.of({
        call: (server, name, input) =>
          RcMap.get(clients, server.key).pipe(
            // RcMap keeps a failed lookup until it idles out; drop it so the next call connects.
            Effect.tapError(() => RcMap.invalidate(clients, server.key)),
            Effect.filterOrFail(
              (connection) => connection.listed.has(name),
              () =>
                new McpError({
                  server: server.name,
                  message: `the server no longer lists ${name}; the tool catalog was stale, and the next session registers the current list`,
                }),
            ),
            Effect.map((connection) => connection.client),
            Effect.flatMap((client) =>
              Effect.tryPromise({
                try: (signal) =>
                  // oxlint-disable-next-line effect/noNullish -- the SDK takes its default result schema positionally
                  client.callTool({ name, arguments: input }, undefined, {
                    signal,
                    timeout: timeoutOf(server),
                  }),
                catch: (cause) =>
                  new McpError({
                    server: server.name,
                    message: `${name}: ${failureMessage(cause)}`,
                  }),
              }).pipe(
                Effect.flatMap((value) =>
                  Schema.decodeUnknownEffect(CallResult)(value).pipe(
                    Effect.mapError(
                      (error) =>
                        new McpError({ server: server.name, message: `${name}: ${error.message}` }),
                    ),
                  ),
                ),
              ),
            ),
            Effect.scoped,
          ),
      })
    }),
  )

// ── tools ───────────────────────────────────────────────────────────────────

/** Anything the importer cannot read takes any object; the server still checks it. */
const AnyInput = Schema.Record(Schema.String, Schema.Json)

/**
 * The tool's input schema, imported from its JSON Schema so the host checks
 * the input and the cell signature shows its types. Patterns are ignored: a
 * server's regular expressions do not run in gent.
 */
const inputSchemaOf = (inputSchema: Schema.Json) =>
  Result.try(() => {
    if (!isRecord(inputSchema)) return AnyInput
    let document = JsonSchema.fromSchemaDraft07(inputSchema)
    const dialect = inputSchema["$schema"]
    if (Predicate.isString(dialect) && dialect.includes("2020-12")) {
      document = JsonSchema.fromSchemaDraft2020_12(inputSchema)
    }
    const imported = SchemaRepresentation.fromJsonSchemaDocument(document, { patterns: "ignore" })
    // `make` is the typed bridge from an AST: an imported schema needs no services.
    return Schema.make<Schema.Codec<Readonly<Record<string, Schema.Json>>>>(imported.ast)
  }).pipe(Result.getOrElse(() => AnyInput))

/** The bytes a base64 string decodes to. */
const base64Bytes = (data: string) => {
  const padding = data.length - data.replace(/=+$/, "").length
  return Math.floor((data.length * 3) / 4) - padding
}

const isTextBlock = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }))
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

/** A call's content blocks sorted into text, other blocks, and binary data left out. */
interface ProjectedContent {
  readonly texts: Array<string>
  readonly blocks: Array<Schema.Json>
  readonly omitted: Array<Schema.Json>
}

const projectContent = (content: ReadonlyArray<Schema.Json>): ProjectedContent => {
  const projected: ProjectedContent = { texts: [], blocks: [], omitted: [] }
  for (const block of content) {
    if (isTextBlock(block)) {
      projected.texts.push(block.text)
    } else if (isMediaBlock(block)) {
      projected.omitted.push({
        type: block.type,
        ...omitUndefined({ mimeType: block.mimeType }),
        bytes: base64Bytes(block.data ?? ""),
      })
    } else if (isBlobResource(block)) {
      projected.omitted.push({
        type: "resource",
        ...omitUndefined({ uri: block.resource.uri, mimeType: block.resource.mimeType }),
        bytes: base64Bytes(block.resource.blob),
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

const omittedNote = (count: number) => {
  let noun = "blocks"
  if (count === 1) noun = "block"
  return `${count} binary ${noun} omitted: the cell receives no image, audio or blob data`
}

/**
 * The value a call returns. Text alone is its joined text; structured content
 * alone (its text only repeating it) is that value. Anything else is an
 * object: `structuredContent`, `text`, the other blocks as `content`, and
 * `omitted` naming each image, audio, or blob block the cell does not
 * receive, with its MIME type and size, and a `note` saying so.
 */
export const projectCallResult = (result: CallResult): Schema.Json => {
  const { texts, blocks, omitted } = projectContent(result.content ?? [])
  const text = texts.join("\n")
  const structured = Option.fromUndefinedOr(result.structuredContent)
  if (blocks.length === 0 && omitted.length === 0) {
    if (Option.isNone(structured)) return text
    if (texts.length === 0 || repeats(text, structured.value)) return structured.value
  }
  const value: Record<string, Schema.Json> = {}
  if (Option.isSome(structured)) value["structuredContent"] = structured.value
  if (texts.length > 0) value["text"] = text
  if (blocks.length > 0) value["content"] = blocks
  if (omitted.length > 0) {
    value["omitted"] = omitted
    value["note"] = omittedNote(omitted.length)
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
    return [
      tool({
        id: `mcp.${server.name}.${segment}`,
        description: toolDescription(server, entry),
        readonly: entry.annotations?.readOnlyHint === true,
        destructive: entry.annotations?.destructiveHint === true,
        params: inputSchemaOf(entry.inputSchema),
        output: Schema.Json,
        execute: Effect.fn("Mcp.call")(function* (input) {
          const clients = yield* McpClients
          const result = yield* clients.call(server, entry.name, input)
          const value = projectCallResult(result)
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
          return value
        }),
      }),
    ]
  })
}

/** A server's tools, and whether setup listed them now (so they go to the cache). */
interface SetupCatalog {
  readonly tools: ReadonlyArray<CatalogTool>
  readonly listedNow: boolean
}

/**
 * The server's tools from the cache, or, on a miss, from one connection at
 * setup that lists them. A server that cannot list is reported and
 * contributes nothing; the other servers are unaffected.
 */
const catalogFor = (server: McpServer, cache: CatalogFile): Effect.Effect<SetupCatalog> => {
  const cached = cache.servers[server.key]
  if (Predicate.isNotUndefined(cached)) {
    return Effect.succeed({ tools: cached.tools, listedNow: false })
  }
  return Effect.scoped(
    connect(server).pipe(Effect.flatMap((client) => listTools(server, client))),
  ).pipe(
    Effect.map((tools): SetupCatalog => ({ tools, listedNow: true })),
    Effect.catchCause((cause) =>
      Effect.logWarning("mcp.server.unlisted").pipe(
        Effect.annotateLogs({ server: server.name, error: String(cause) }),
        Effect.as<SetupCatalog>({ tools: [], listedNow: false }),
      ),
    ),
  )
}

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
  const servers = yield* resolveServers(entries, host.cwd)
  if (servers.length === 0) return
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
      .map((entry): readonly [string, ReadonlyArray<CatalogTool>] => [
        entry.server.key,
        entry.tools,
      ]),
  ).pipe(Effect.ignore)
  yield* host.register(
    "resource",
    defineResource({
      id: `${extensionId}/clients`,
      scope: "process",
      layer: mcpClientsLive(registered, file),
    }),
  )
  yield* host.register(
    "tool",
    ...registered.flatMap((entry) => toolsFor(entry.server, entry.tools)),
  )
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
