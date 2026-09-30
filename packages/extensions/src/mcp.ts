import {
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Hash,
  JsonSchema,
  Layer,
  Option,
  Path,
  Predicate,
  RcMap,
  Result,
  Schema,
  SchemaRepresentation,
} from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  defineExtension,
  defineResource,
  ExtensionHost,
  hasProjectScope,
  isRecord,
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
  /** The catalog cache key: a hash of the entry as written, before expansion. */
  readonly key: string
  readonly config: McpServerConfig
}

const encodeKeyFields = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const sortedEntries = (record: Readonly<Record<string, string>> = {}) =>
  Object.entries(record).toSorted(([left], [right]) => left.localeCompare(right))

/**
 * The catalog cache key: the fields that decide what a server lists, in a
 * fixed order, so an edit to any of them relists and key order never does.
 */
const serverKey = (written: string, config: McpServerConfig) => {
  if ("command" in config) {
    return String(
      Hash.string(
        encodeKeyFields([
          written,
          "stdio",
          config.command,
          config.args ?? [],
          sortedEntries(config.env),
          config.cwd ?? "",
          config.timeoutMs ?? 0,
        ]),
      ),
    )
  }
  return String(
    Hash.string(
      encodeKeyFields([
        written,
        "http",
        config.url,
        sortedEntries(config.headers),
        config.timeoutMs ?? 0,
      ]),
    ),
  )
}

/** Default bound on connecting to a server and on each call. */
const DEFAULT_TIMEOUT_MS = 30_000
/** A connection nobody used for this long closes; the next call opens it again. */
const IDLE_TIME_TO_LIVE = Duration.minutes(5)
/** Server and tool id segments are cut here, so `mcp__<server>__<tool>` stays within 128 characters. */
const SERVER_SEGMENT_LIMIT = 32
const TOOL_SEGMENT_LIMIT = 64

/**
 * An id segment a provider wire name can carry once `.` is encoded:
 * `[A-Za-z0-9_-]` only, no `__` (the encoding's separator), and bounded.
 */
const idSegment = (name: string, limit: number) =>
  name
    .replaceAll(/[^A-Za-z0-9_-]/g, "_")
    .replaceAll(/_{2,}/g, "_")
    .slice(0, limit)

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** `${NAME}` and `${NAME:-default}` from the environment; an unset one without a default is a failure. */
const expandVariables = Effect.fn("Mcp.expandVariables")(function* (text: string) {
  let expanded = text
  for (const [match, name = "", fallback] of text.matchAll(VARIABLE)) {
    const value = yield* Config.option(Config.string(name)).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    const resolved = Option.orElse(value, () => Option.fromUndefinedOr(fallback))
    if (Option.isNone(resolved))
      return yield* Effect.fail(`environment variable ${name} is not set`)
    expanded = expanded.replace(match, resolved.value)
  }
  return expanded
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
) {
  const servers: Array<McpServer> = []
  const names = new Set<string>()
  for (const [written, config] of Object.entries(entries).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (config.enabled === false) continue
    const name = idSegment(written, SERVER_SEGMENT_LIMIT)
    if (name === "" || names.has(name)) {
      yield* Effect.logWarning("mcp.server.name-taken").pipe(
        Effect.annotateLogs({ server: written }),
      )
      continue
    }
    const expanded = yield* Effect.result(expandConfig(config))
    if (Result.isFailure(expanded)) {
      yield* Effect.logWarning("mcp.server.config").pipe(
        Effect.annotateLogs({ server: written, error: expanded.failure }),
      )
      continue
    }
    names.add(name)
    servers.push({
      name,
      key: serverKey(written, config),
      config: expanded.success,
    })
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

/** Merge one server's tools into the cache file; a failed write only costs a relist. */
const writeCatalogEntry = Effect.fn("Mcp.writeCatalogEntry")(function* (
  file: string,
  key: string,
  tools: ReadonlyArray<CatalogTool>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const current = yield* readCatalog(file)
  const next = { servers: { ...current.servers, [key]: { tools } } }
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* writeFileAtomic(file, yield* Schema.encodeEffect(CatalogFile)(next))
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

const transportFor = (server: McpServer, cwd: string) => {
  const config = server.config
  if ("command" in config) {
    return new StdioClientTransport({
      command: config.command,
      args: [...(config.args ?? [])],
      env: { ...config.env },
      cwd: config.cwd ?? cwd,
      // The server's own log would land in the terminal gent draws.
      stderr: "ignore",
    })
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { ...config.headers } },
  })
}

/** An initialized client; closing its scope closes the transport, and a stdio server with it. */
const connect = (server: McpServer, cwd: string) =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new Client({ name: "gent", version: "1.0.0" })),
      (opened) => Effect.promise(() => opened.close()).pipe(Effect.ignore),
    )
    yield* Effect.tryPromise({
      try: () => client.connect(transportFor(server, cwd)),
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

/** The connections of `servers`, each under its cache key, which names one entry. */
const mcpClientsLive = (cwd: string, servers: ReadonlyArray<McpServer>) =>
  Layer.effect(
    McpClients,
    Effect.gen(function* () {
      const byKey = new Map(servers.map((server) => [server.key, server]))
      const clients = yield* RcMap.make({
        lookup: (key: string) => {
          const server = byKey.get(key)
          if (Predicate.isUndefined(server)) {
            return Effect.fail(new McpError({ server: key, message: "not configured" }))
          }
          return connect(server, cwd)
        },
        idleTimeToLive: IDLE_TIME_TO_LIVE,
      })
      return McpClients.of({
        call: (server, name, input) =>
          RcMap.get(clients, server.key).pipe(
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

/** A content block as JSON: text as its text; a binary block as its type and MIME type only. */
const projectBlock = (block: Schema.Json): Schema.Json => {
  if (!isRecord(block)) return block
  if (block["type"] === "text" && Predicate.isString(block["text"])) return block["text"]
  if (block["type"] === "image" || block["type"] === "audio") {
    return {
      type: block["type"],
      mimeType: Option.getOrNull(Option.liftPredicate(block["mimeType"], Predicate.isString)),
    }
  }
  if (block["type"] === "resource" && isRecord(block["resource"])) {
    const { blob: _blob, ...resource } = block["resource"]
    return { type: "resource", ...resource }
  }
  return block
}

/**
 * The value a call returns: its structured content when it has one, else its
 * text when every block is text, else each block projected.
 */
export const projectCallResult = (result: CallResult): Schema.Json => {
  if (Predicate.isNotUndefined(result.structuredContent)) return result.structuredContent
  const blocks = (result.content ?? []).map(projectBlock)
  if (blocks.every(Predicate.isString)) return blocks.join("\n")
  return blocks
}

const toolDescription = (server: McpServer, listed: CatalogTool) => {
  const description = (listed.description ?? "").trim()
  if (description.length > 0) return description
  return `${listed.name} on the ${server.name} MCP server`
}

/** One host tool per listed MCP tool; a name that collides after cleaning is left out. */
const toolsFor = (server: McpServer, listed: ReadonlyArray<CatalogTool>) => {
  const seen = new Set<string>()
  return listed.flatMap((entry) => {
    const segment = idSegment(entry.name, TOOL_SEGMENT_LIMIT)
    if (segment === "" || seen.has(segment)) return []
    seen.add(segment)
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

/**
 * The server's tools from the cache, or, on a miss, from one connection at
 * setup that lists them and writes the cache. A server that cannot list is
 * reported and contributes nothing; the other servers are unaffected.
 */
const catalogFor = (server: McpServer, cache: CatalogFile, file: string, cwd: string) => {
  const cached = cache.servers[server.key]
  if (Predicate.isNotUndefined(cached)) return Effect.succeed(cached.tools)
  return Effect.scoped(
    connect(server, cwd).pipe(Effect.flatMap((client) => listTools(server, client))),
  ).pipe(
    Effect.tap((tools) => writeCatalogEntry(file, server.key, tools).pipe(Effect.ignore)),
    Effect.catchCause((cause) =>
      Effect.logWarning("mcp.server.unlisted").pipe(
        Effect.annotateLogs({ server: server.name, error: String(cause) }),
        Effect.as<ReadonlyArray<CatalogTool>>([]),
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
  const servers = yield* resolveServers(entries)
  if (servers.length === 0) return
  const file = yield* catalogPath(host.home)
  const cache = yield* readCatalog(file)
  const catalogs = yield* Effect.forEach(
    servers,
    (server) => catalogFor(server, cache, file, host.cwd),
    { concurrency: 8 },
  )
  yield* host.register(
    "resource",
    defineResource({
      id: `${extensionId}/clients`,
      scope: "process",
      layer: mcpClientsLive(host.cwd, servers),
    }),
  )
  yield* host.register(
    "tool",
    ...servers.flatMap((server, index) => toolsFor(server, catalogs[index] ?? [])),
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
