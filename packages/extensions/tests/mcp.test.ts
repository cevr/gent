import { describe, expect, it, test } from "effect-bun-test"
import {
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
  Stream,
} from "effect"
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type * as Prompt from "effect/unstable/ai/Prompt"
import {
  BunGentPlatformLive,
  collectTestContributions,
  createRpcHarness,
  LanguageModelLayers,
  type SequenceStep,
  textStep,
  toolCallStep,
  waitFor,
} from "@gent/core/test-utils"
import { getToolId, type ToolCapability } from "@gent/core/extensions/api"
import { messagePartsText } from "@gent/core/protocol"
import { McpExtension, McpServers, projectCallResult } from "../src/mcp.js"
import { shippedPreset } from "./helpers/test-preset.js"

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A stdio MCP server: newline-delimited JSON-RPC on stdin and stdout, with
 * no SDK, so the test owns every byte it answers. Each start appends a line
 * to `MCP_FIXTURE_LOG` with its extra arguments, and `count` returns the calls
 * this process served. `MCP_FIXTURE_FAIL_ON_START=n` exits the nth start;
 * `MCP_FIXTURE_EXIT_AFTER_CALL` exits once it answered a call;
 * `count` is not listed while `MCP_FIXTURE_HIDE_COUNT` names a file that
 * exists, and with it `hide` writes that file and sends `list_changed`, and
 * `drop` writes it silently; a call to a tool not listed is answered with the
 * spec's unknown-tool error (the TypeScript SDK server's `isError` shape with
 * `MCP_FIXTURE_SDK_UNKNOWN`); `MCP_FIXTURE_COLLIDE` adds tools whose names
 * clean to one id;
 * `MCP_FIXTURE_ENV_TOOL` adds `env`, which reads the server's environment;
 * `MCP_FIXTURE_TYPED` adds `stats` and `badstats`, which declare an output
 * schema, and only `stats` keeps it;
 * `tools/list` answers no tools while `MCP_FIXTURE_EMPTY_LIST` names a file that exists.
 */
const FIXTURE_SERVER = String.raw`
const fs = require("node:fs")
if (process.env.MCP_FIXTURE_LOG) fs.appendFileSync(process.env.MCP_FIXTURE_LOG, JSON.stringify(process.argv.slice(2)) + "\n")
if (process.env.MCP_FIXTURE_FAIL_ON_START) {
  const started = fs.readFileSync(process.env.MCP_FIXTURE_LOG, "utf8").split("\n").filter((line) => line !== "").length
  if (started === Number(process.env.MCP_FIXTURE_FAIL_ON_START)) process.exit(1)
}
let calls = 0
const tools = [
  {
    name: "echo",
    description: "Echo text back.\nSecond line.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, times: { type: "integer", minimum: 1 } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
  },
  { name: "structured", description: "Return structured content.", inputSchema: { type: "object", properties: {} } },
  { name: "fail", description: "Always fail.", inputSchema: { type: "object", properties: {} } },
  { name: "count", description: "Count calls this process served.", inputSchema: { type: "object", properties: {} } },
  { name: "repo.search/issues", description: "A name with separators.", inputSchema: { type: "object" } },
]
const hideFile = process.env.MCP_FIXTURE_HIDE_COUNT
if (hideFile) {
  tools.push(
    { name: "hide", description: "Stop listing count, and say so.", inputSchema: { type: "object" } },
    { name: "drop", description: "Stop listing count silently.", inputSchema: { type: "object" } },
  )
}
const listedTools = () => {
  if (hideFile && fs.existsSync(hideFile)) return tools.filter((entry) => entry.name !== "count")
  return tools
}
if (process.env.MCP_FIXTURE_COLLIDE) {
  for (const name of ["a/b", "a.b", "a_b_2", "get__x", "_x", "x_", "x".repeat(70) + "1", "x".repeat(70) + "2"]) {
    tools.push({ name, description: "Collides as " + name + ".", inputSchema: { type: "object" } })
  }
}
if (process.env.MCP_FIXTURE_ENV_TOOL) {
  tools.push({
    name: "env",
    description: "Read a variable of the server's environment.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  })
}
if (process.env.MCP_FIXTURE_TYPED) {
  const outputSchema = {
    type: "object",
    properties: { open: { type: "integer" }, labels: { type: "array", items: { type: "string" } } },
    required: ["open", "labels"],
  }
  tools.push(
    { name: "stats", description: "Count open issues.", inputSchema: { type: "object" }, outputSchema },
    { name: "badstats", description: "Break its own output schema.", inputSchema: { type: "object" }, outputSchema },
  )
}
for (let index = 0; index < Number(process.env.MCP_FIXTURE_EXTRA ?? 0); index++) {
  tools.push({
    name: "extra_" + String(index).padStart(3, "0"),
    description: "Generated tool " + index + " that lists repository issues matching a query.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, query: { type: "string" }, limit: { type: "integer" } },
      required: ["owner", "repo", "query"],
    },
  })
}
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
const answer = (request) => {
  if (request.method === "initialize") {
    return { result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1" } } }
  }
  if (request.method === "tools/list") {
    if (process.env.MCP_FIXTURE_EMPTY_LIST && fs.existsSync(process.env.MCP_FIXTURE_EMPTY_LIST)) return { result: { tools: [] } }
    return { result: { tools: listedTools() } }
  }
  if (request.method !== "tools/call") return { error: { code: -32601, message: "no method " + request.method } }
  if (!listedTools().some((entry) => entry.name === request.params.name)) {
    if (process.env.MCP_FIXTURE_SDK_UNKNOWN) return { result: { content: [{ type: "text", text: "Tool " + request.params.name + " not found" }], isError: true } }
    return { error: { code: -32602, message: "Unknown tool: " + request.params.name } }
  }
  calls += 1
  const input = request.params.arguments ?? {}
  switch (request.params.name) {
    case "hide":
    case "drop":
      fs.writeFileSync(hideFile, "")
      return { result: { content: [{ type: "text", text: "count hidden" }] } }
    case "echo":
      return { result: { content: [{ type: "text", text: String(input.text).repeat(input.times ?? 1) }] } }
    case "structured":
      return { result: { content: [{ type: "text", text: JSON.stringify({ ok: true, items: [1, 2] }) }], structuredContent: { ok: true, items: [1, 2] } } }
    case "fail":
      return { result: { content: [{ type: "text", text: "fixture failure" }], isError: true } }
    case "count":
      return { result: { content: [{ type: "text", text: String(calls) }] } }
    case "stats":
      return { result: { content: [{ type: "text", text: "3 open" }], structuredContent: { open: 3, labels: ["bug"] } } }
    case "badstats":
      return { result: { content: [{ type: "text", text: "many open" }], structuredContent: { open: "many" } } }
    case "env":
      return { result: { content: [{ type: "text", text: process.env[input.name] ?? "unset" }] } }
    default:
      return { result: { content: [{ type: "text", text: "called " + request.params.name }] } }
  }
}
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let end = buffer.indexOf("\n")
  while (end >= 0) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    end = buffer.indexOf("\n")
    if (line === "") continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    const answered = answer(request)
    if (request.method === "tools/call" && process.env.MCP_FIXTURE_EXIT_AFTER_CALL) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...answered }) + "\n", () => process.exit(0))
      return
    }
    send({ id: request.id, ...answered })
    if (request.method === "tools/call" && request.params.name === "hide") {
      send({ method: "notifications/tools/list_changed" })
    }
  }
})
`

const platformLayer = Layer.merge(BunServices.layer, BunGentPlatformLive)

/** A scratch directory holding the fixture server and the file its starts are logged to. */
const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "gent-mcp-" }))
  const server = path.join(directory, "server.cjs")
  const log = path.join(directory, "starts.log")
  yield* fs.writeFileString(server, FIXTURE_SERVER)
  const startLines = fs.readFileString(log).pipe(
    Effect.map((text) => text.split("\n").filter((line) => line !== "")),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  )
  const starts = Effect.map(startLines, (lines) => lines.length)
  /** Each start's extra arguments, as JSON. */
  const startArgs = startLines
  const stdio = (env: Readonly<Record<string, string>> = {}) => ({
    command: process.execPath,
    args: [server],
    env: { MCP_FIXTURE_LOG: log, ...env },
  })
  return { directory, server, starts, startArgs, stdio }
})

const toolList = (contributions: { readonly tools?: ReadonlyArray<ToolCapability> }) =>
  Option.getOrElse(
    Option.fromUndefinedOr(contributions.tools),
    (): ReadonlyArray<ToolCapability> => [],
  )

const toolIds = (contributions: { readonly tools?: ReadonlyArray<ToolCapability> }) =>
  toolList(contributions)
    .map((capability) => String(getToolId(capability)))
    .toSorted()

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/**
 * An environment whose data directory is a fixed scratch path, so a test that
 * cannot name the harness's home still shares its catalog cache.
 */
const withDataDir = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-mcp-data-" })
    return ConfigProvider.layer(ConfigProvider.fromUnknown({ GENT_DATA_DIR: directory }))
  }),
)

/** An environment with `GENT_MCP_VALUE` set to `value`. */
const withVariable = (value: string) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ GENT_MCP_VALUE: value }))

/** A model step that records the system prompt it was sent. */
const systemRecorder = () => {
  const systems: Array<string> = []
  const recordSystem = (step: SequenceStep): SequenceStep => ({
    ...step,
    assertOptions: (options) => {
      systems.push(
        options.prompt.content
          .filter((message) => message.role === "system")
          .map((message) => String(message.content))
          .join("\n"),
      )
    },
  })
  return { systems, recordSystem }
}

/** The first cell result, once the reply `done` arrives. */
const cellResultAfterDone = (
  client: Effect.Success<ReturnType<typeof createRpcHarness>>["client"],
  branchId: Effect.Success<ReturnType<typeof createRpcHarness>>["branchId"],
) =>
  waitFor(
    client.message.list({ branchId }),
    (all) =>
      all.some(
        (message) => message.role === "assistant" && messagePartsText(message.parts) === "done",
      ),
    15_000,
    "assistant reply done",
  ).pipe(
    Effect.map((messages) =>
      messages
        .flatMap((message) => message.parts)
        .find((part): part is Prompt.ToolResultPart => part.type === "tool-result"),
    ),
  )

// ── config ──────────────────────────────────────────────────────────────────

describe("mcp config", () => {
  it.scopedLive(
    "the user file registers a server's tools; a project file counts only once the project is trusted",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* makeFixture
        const home = path.join(fixture.directory, "home")
        const cwd = path.join(fixture.directory, "project")
        yield* fs.makeDirectory(path.join(home, ".gent"), { recursive: true })
        yield* fs.makeDirectory(path.join(cwd, ".gent"), { recursive: true })
        yield* fs.writeFileString(
          path.join(home, ".gent", "mcp.json"),
          encodeJson({
            mcpServers: { user: fixture.stdio(), off: { ...fixture.stdio(), enabled: false } },
          }),
        )
        yield* fs.writeFileString(
          path.join(cwd, ".gent", "mcp.json"),
          encodeJson({ mcpServers: { "project-server": fixture.stdio() } }),
        )
        const untrusted = yield* collectTestContributions(McpExtension.setup, { home, cwd })
        expect(toolIds(untrusted)).toEqual([
          "mcp.user.count",
          "mcp.user.echo",
          "mcp.user.fail",
          "mcp.user.repo_search_issues",
          "mcp.user.structured",
        ])
        yield* fs.writeFileString(
          path.join(home, ".gent", "config.json"),
          encodeJson({ trustedProjects: [cwd] }),
        )
        const trusted = yield* collectTestContributions(McpExtension.setup, { home, cwd })
        expect(toolIds(trusted).filter((id) => id.startsWith("mcp.project-server."))).toHaveLength(
          5,
        )
        expect(toolIds(trusted).filter((id) => id.startsWith("mcp.user."))).toHaveLength(5)
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "a cold catalog starts the server once at setup; a cached one starts nothing",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fixture = yield* makeFixture
        const home = path.join(fixture.directory, "home")
        const extension = McpServers("@test/mcp-cache", { fixture: fixture.stdio() })
        const cold = yield* collectTestContributions(extension.setup, {
          home,
          cwd: fixture.directory,
        })
        expect(toolIds(cold)).toContain("mcp.fixture.echo")
        expect(yield* fixture.starts).toBe(1)
        const warm = yield* collectTestContributions(extension.setup, {
          home,
          cwd: fixture.directory,
        })
        expect(toolIds(warm)).toEqual(toolIds(cold))
        expect(yield* fixture.starts).toBe(1)
        // The same entry written in another key order is the same cache key.
        const { env, ...rest } = fixture.stdio()
        const reordered = McpServers("@test/mcp-cache", { fixture: { env, ...rest } })
        yield* collectTestContributions(reordered.setup, { home, cwd: fixture.directory })
        expect(yield* fixture.starts).toBe(1)
        // An edited entry is a new cache key, so it lists again.
        const edited = McpServers("@test/mcp-cache", { fixture: fixture.stdio({ EDITED: "1" }) })
        yield* collectTestContributions(edited.setup, { home, cwd: fixture.directory })
        expect(yield* fixture.starts).toBe(2)
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "servers listed together at setup all reach the cache",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fixture = yield* makeFixture
        const home = path.join(fixture.directory, "home")
        const servers = Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [
            `server${index}`,
            fixture.stdio({ INSTANCE: String(index) }),
          ]),
        )
        const extension = McpServers("@test/mcp-many-cold", servers)
        yield* collectTestContributions(extension.setup, { home, cwd: fixture.directory })
        expect(yield* fixture.starts).toBe(8)
        const warm = yield* collectTestContributions(extension.setup, {
          home,
          cwd: fixture.directory,
        })
        expect(toolIds(warm)).toHaveLength(40)
        expect(yield* fixture.starts).toBe(8)
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "a variable's value is taken literally, replacement patterns and all",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fixture = yield* makeFixture
        const entry = fixture.stdio()
        const extension = McpServers("@test/mcp-expand", {
          fixture: { ...entry, args: [...entry.args, "${GENT_MCP_VALUE}", "${GENT_MCP_VALUE}"] },
        })
        yield* collectTestContributions(extension.setup, {
          home: path.join(fixture.directory, "home"),
          cwd: fixture.directory,
        }).pipe(Effect.provide(withVariable("a$&b$'c$$d$1")))
        expect(yield* fixture.startArgs).toEqual([encodeJson(["a$&b$'c$$d$1", "a$&b$'c$$d$1"])])
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "the cache key is the entry as it runs: its expanded values and its directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* makeFixture
        const home = path.join(fixture.directory, "home")
        const other = path.join(fixture.directory, "other")
        yield* fs.makeDirectory(other)
        const entry = fixture.stdio()
        const extension = McpServers("@test/mcp-identity", {
          fixture: { ...entry, args: [...entry.args, "${GENT_MCP_VALUE}"] },
        })
        const setup = (cwd: string, value: string) =>
          collectTestContributions(extension.setup, { home, cwd }).pipe(
            Effect.provide(withVariable(value)),
          )
        yield* setup(fixture.directory, "one")
        yield* setup(fixture.directory, "one")
        expect(yield* fixture.starts).toBe(1)
        // Another value behind the same written entry is another server.
        yield* setup(fixture.directory, "two")
        expect(yield* fixture.starts).toBe(2)
        // So is the same entry run from another directory.
        yield* setup(other, "one")
        expect(yield* fixture.starts).toBe(3)
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "every server and tool gets its own tool id in the wire grammar, colliding names by suffix",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fixture = yield* makeFixture
        const extension = McpServers("@test/mcp-names", {
          "my.server": fixture.stdio({ MCP_FIXTURE_COLLIDE: "1" }),
          my_server: fixture.stdio(),
        })
        const ids = toolIds(
          yield* collectTestContributions(extension.setup, {
            home: path.join(fixture.directory, "home"),
            cwd: fixture.directory,
          }),
        )
        // Code-unit order of the names decides who keeps the plain id.
        expect(ids.filter((id) => id.startsWith("mcp.my_server."))).toEqual(
          [
            "a_b",
            "a_b_2",
            "a_b_2_2",
            "count",
            "echo",
            "fail",
            "get_x",
            "repo_search_issues",
            "structured",
            "x",
            "x_2",
            "x".repeat(48),
            `${"x".repeat(46)}_2`,
          ]
            .map((name) => `mcp.my_server.${name}`)
            .toSorted(),
        )
        expect(ids.filter((id) => id.startsWith("mcp.my_server_2."))).toHaveLength(5)
        // Each id is dot-joined segments of `[A-Za-z0-9-]` runs joined by one `_`,
        // and its wire name (`.` as `__`) fits in 64 characters.
        const grammar = /^[a-zA-Z0-9-]+(?:_[a-zA-Z0-9-]+)*(?:\.[a-zA-Z0-9-]+(?:_[a-zA-Z0-9-]+)*)*$/
        expect(
          ids.filter((id) => !grammar.test(id) || id.replaceAll(".", "__").length > 64),
        ).toEqual([])
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "a server that cannot start contributes nothing and does not fail the extension",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fixture = yield* makeFixture
        const extension = McpServers("@test/mcp-dead", {
          dead: { command: "/nonexistent/gent-probe-x", timeoutMs: 2000 },
          fixture: fixture.stdio(),
          missing: {
            url: "http://127.0.0.1:9/mcp",
            headers: { authorization: "${GENT_MCP_UNSET}" },
          },
        })
        const contributions = yield* collectTestContributions(extension.setup, {
          home: path.join(fixture.directory, "home"),
          cwd: fixture.directory,
        })
        expect(toolIds(contributions).every((id) => id.startsWith("mcp.fixture."))).toBe(true)
        expect(toolIds(contributions)).toHaveLength(5)
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(platformLayer)),
    30_000,
  )
})

// ── streamable http ─────────────────────────────────────────────────────────

const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
})
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcRequest))

/**
 * The HTTP fixture's sessions: `initialize` opens one, and every other
 * request names a live one or is answered 404, as the spec asks. The `forget`
 * tool drops them all, as a restarted server does.
 */
interface HttpSessions {
  readonly live: Set<string>
  opened: number
}

/** An in-process streamable HTTP server that answers only a matching bearer token. */
const httpFixtureApp = (sessions: HttpSessions) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 })
    if (request.headers["authorization"] !== "Bearer fixture-token") {
      return HttpServerResponse.text("unauthorized", { status: 401 })
    }
    const message = yield* Effect.flatMap(request.text, decodeRequest)
    const params = Option.fromUndefinedOr(message.params)
    let session = request.headers["mcp-session-id"] ?? ""
    if (message.method === "initialize") {
      sessions.opened += 1
      session = `session-${sessions.opened}`
      sessions.live.add(session)
    } else if (!sessions.live.has(session)) {
      return HttpServerResponse.text("unknown session", { status: 404 })
    }
    const result = answerHttp(message.method, params)
    if (
      Option.contains(
        Option.flatMap(params, (value) => Option.fromUndefinedOr(value["name"])),
        "forget",
      )
    ) {
      sessions.live.clear()
    }
    return Option.match(Option.fromUndefinedOr(message.id), {
      onNone: () => HttpServerResponse.empty({ status: 202 }),
      onSome: (id) =>
        HttpServerResponse.jsonUnsafe(
          { jsonrpc: "2.0", id, result },
          { headers: { "mcp-session-id": session } },
        ),
    })
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("bad request", { status: 400 })))

/** The fixture's port and its sessions; the server stops with the test scope. */
const serveHttpFixture = Effect.gen(function* () {
  const sessions: HttpSessions = { live: new Set(), opened: 0 }
  const context = yield* Layer.build(
    HttpServer.serve(httpFixtureApp(sessions)).pipe(
      Layer.provideMerge(BunHttpServer.layerServer({ port: 0, hostname: "127.0.0.1" })),
    ),
  )
  const address = Context.get(context, HttpServer.HttpServer).address
  if (address._tag !== "TcpAddress") return yield* Effect.die("expected a TCP address")
  return { port: address.port, sessions }
})

const answerHttp = (
  method: string,
  params: Option.Option<Readonly<Record<string, Schema.Json>>>,
): Schema.Json => {
  if (method === "initialize") {
    return {
      protocolVersion: Option.getOrElse(
        Option.flatMap(params, (value) => Option.fromUndefinedOr(value["protocolVersion"])),
        () => "2025-06-18",
      ),
      capabilities: { tools: {} },
      serverInfo: { name: "http-fixture", version: "1" },
    }
  }
  if (method === "tools/list") {
    return {
      tools: [
        {
          name: "whoami",
          description: "Name the caller.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "forget",
          description: "Drop every session.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }
  }
  return { content: [{ type: "text", text: "http caller" }] }
}

const withFixtureToken = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ GENT_MCP_FIXTURE_TOKEN: "fixture-token" }),
)

/** The fixture as an entry, its token from a variable. */
const httpEntry = (port: number) => ({
  url: `http://127.0.0.1:${port}/mcp`,
  headers: { Authorization: "Bearer ${GENT_MCP_FIXTURE_TOKEN}" },
})

describe("mcp over streamable http", () => {
  it.scopedLive(
    "a header variable expands, and the tool lists and answers over HTTP",
    () =>
      Effect.gen(function* () {
        const { port } = yield* serveHttpFixture
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: "await tools.mcp.remote.whoami()" }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            McpServers("@test/mcp-http", { remote: httpEntry(port) }),
          ],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "ask the HTTP server" })
        const result = yield* cellResultAfterDone(client, branchId)
        expect(result).toMatchObject({
          name: "cell",
          isFailure: false,
          result: { display: "http caller" },
        })
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.provide(Layer.merge(platformLayer, withFixtureToken)),
      ),
    25_000,
  )

  it.scopedLive(
    "a session the server forgot is answered 404, and the call opens a new session once",
    () =>
      Effect.gen(function* () {
        const { port, sessions } = yield* serveHttpFixture
        const code = [
          "const first = await tools.mcp.remote.whoami()",
          "await tools.mcp.remote.forget()",
          "const second = await tools.mcp.remote.whoami()",
          "JSON.stringify({ first, second })",
        ].join("; ")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            McpServers("@test/mcp-http-session", { remote: httpEntry(port) }),
          ],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "ask twice" })
        const result = yield* cellResultAfterDone(client, branchId)
        expect(result).toMatchObject({
          name: "cell",
          isFailure: false,
          result: { display: encodeJson({ first: "http caller", second: "http caller" }) },
        })
        // Setup's listing, the first call's connection, and the one redial.
        expect(sessions.opened).toBe(3)
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.provide(Layer.merge(platformLayer, withFixtureToken)),
      ),
    25_000,
  )
})

// ── sse ─────────────────────────────────────────────────────────────────────

/** What the SSE fixture saw: event streams asked for (with any token), and streamable HTTP posts it refused. */
interface SseCounts {
  streamRequests: number
  streams: number
  refusedPosts: number
}

/**
 * An in-process server that speaks only the older SSE transport: `GET /sse`
 * opens an event stream whose first event names the endpoint to post to, and
 * each answer arrives on that stream. A streamable HTTP `POST /sse` is
 * answered 405. Every request needs the fixture's bearer token.
 */
const serveSseFixture = Effect.gen(function* () {
  const counts: SseCounts = { streamRequests: 0, streams: 0, refusedPosts: 0 }
  const streams = new Map<string, Queue.Queue<string>>()
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://127.0.0.1")
    if (url.pathname === "/sse" && request.method === "GET") counts.streamRequests += 1
    if (request.headers["authorization"] !== "Bearer fixture-token") {
      return HttpServerResponse.text("unauthorized", { status: 401 })
    }
    if (url.pathname === "/sse" && request.method === "GET") {
      counts.streams += 1
      const session = `sse-${counts.streams}`
      const queue = yield* Queue.unbounded<string>()
      streams.set(session, queue)
      yield* Queue.offer(queue, `event: endpoint\ndata: /messages?session=${session}\n\n`)
      return HttpServerResponse.stream(Stream.fromQueue(queue).pipe(Stream.encodeText), {
        contentType: "text/event-stream",
      })
    }
    const queue = Option.fromUndefinedOr(streams.get(url.searchParams.get("session") ?? ""))
    if (url.pathname !== "/messages" || request.method !== "POST" || Option.isNone(queue)) {
      counts.refusedPosts += 1
      return HttpServerResponse.empty({ status: 405 })
    }
    const message = yield* Effect.flatMap(request.text, decodeRequest)
    const id = Option.fromUndefinedOr(message.id)
    if (Option.isSome(id)) {
      const result = answerHttp(message.method, Option.fromUndefinedOr(message.params))
      const data = encodeJson({ jsonrpc: "2.0", id: id.value, result })
      yield* Queue.offer(queue.value, `event: message\ndata: ${data}\n\n`)
    }
    return HttpServerResponse.empty({ status: 202 })
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("bad request", { status: 400 })))
  const context = yield* Layer.build(
    HttpServer.serve(app).pipe(
      Layer.provideMerge(BunHttpServer.layerServer({ port: 0, hostname: "127.0.0.1" })),
    ),
  )
  const address = Context.get(context, HttpServer.HttpServer).address
  if (address._tag !== "TcpAddress") return yield* Effect.die("expected a TCP address")
  return { port: address.port, counts }
})

describe("mcp over sse", () => {
  it.scopedLive(
    "an SSE server works pinned by type, and auto reaches it after streamable HTTP is refused",
    () =>
      Effect.gen(function* () {
        const { port, counts } = yield* serveSseFixture
        const sse = { ...httpEntry(port), url: `http://127.0.0.1:${port}/sse` }
        const code = [
          "const pinned = await tools.mcp.pinned.whoami()",
          "const auto = await tools.mcp.auto.whoami()",
          "JSON.stringify({ pinned, auto })",
        ].join("; ")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            McpServers("@test/mcp-sse", { pinned: { ...sse, type: "sse" }, auto: sse }),
          ],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "ask both" })
        const result = yield* cellResultAfterDone(client, branchId)
        expect(result).toMatchObject({
          name: "cell",
          isFailure: false,
          result: { display: encodeJson({ pinned: "http caller", auto: "http caller" }) },
        })
        // Setup and the calls each open one stream per server; only auto posts first.
        expect(counts).toEqual({ streamRequests: 4, streams: 4, refusedPosts: 2 })
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.provide(Layer.merge(platformLayer, withFixtureToken)),
      ),
    25_000,
  )

  it.scopedLive(
    "auto does not try SSE when streamable HTTP is refused for the credential",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fs = yield* FileSystem.FileSystem
        const { port, counts } = yield* serveSseFixture
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-mcp-sse-" })
        const extension = McpServers("@test/mcp-sse-401", {
          auto: {
            url: `http://127.0.0.1:${port}/sse`,
            headers: { Authorization: "Bearer wrong-token" },
          },
        })
        const contributions = yield* collectTestContributions(extension.setup, {
          home: path.join(directory, "home"),
          cwd: directory,
        })
        expect(toolIds(contributions)).toEqual([])
        expect(counts).toEqual({ streamRequests: 0, streams: 0, refusedPosts: 0 })
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(platformLayer)),
    25_000,
  )
})

// ── results ─────────────────────────────────────────────────────────────────

describe("mcp results", () => {
  test("structured content alone when its text only repeats it; text joins", () => {
    expect(
      projectCallResult({
        content: [{ type: "text", text: '{"a":1}' }],
        structuredContent: { a: 1 },
      }),
    ).toEqual({ a: 1 })
    expect(
      projectCallResult({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb")
  })

  test("structured content keeps the text and blocks beside it", () => {
    expect(
      projectCallResult({
        content: [
          { type: "text", text: "a caption" },
          { type: "resource", resource: { uri: "file:///notes", text: "notes" } },
        ],
        structuredContent: { a: 1 },
      }),
    ).toEqual({
      structuredContent: { a: 1 },
      text: "a caption",
      content: [{ type: "resource", uri: "file:///notes", text: "notes" }],
    })
  })

  test("binary blocks are named as omitted, with their type, MIME type and size", () => {
    expect(
      projectCallResult({
        content: [
          { type: "text", text: "see" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///x", blob: "AAAAAA==", mimeType: "x/y" } },
        ],
      }),
    ).toEqual({
      text: "see",
      omitted: [
        { type: "image", mimeType: "image/png", bytes: 3 },
        { type: "resource", uri: "file:///x", mimeType: "x/y", bytes: 4 },
      ],
      note: "2 binary blocks omitted: the cell receives no image, audio or blob data",
    })
    expect(
      projectCallResult({
        content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
        structuredContent: { ok: true },
      }),
    ).toEqual({
      structuredContent: { ok: true },
      omitted: [{ type: "audio", mimeType: "audio/wav", bytes: 3 }],
      note: "1 binary block omitted: the cell receives no image, audio or blob data",
    })
  })
})

// ── cell ────────────────────────────────────────────────────────────────────

describe("mcp tools in the cell", () => {
  it.scopedLive(
    "the cell calls MCP tools as typed functions through the host tool path, on one lazy connection",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture
        const { systems, recordSystem } = systemRecorder()
        const code = [
          "const echoed = await tools.mcp.fixture.echo({ text: 'hi', times: 2 })",
          "const structured = await tools.mcp.fixture.structured()",
          "let failed = ''; try { await tools.mcp.fixture.fail() } catch (error) { failed = error.message }",
          "let invalid = ''; try { await tools.mcp.fixture.echo({ times: 1 }) } catch (error) { invalid = error.message }",
          "const counts = [await tools.mcp.fixture.count(), await tools.mcp.fixture.count()]",
          "JSON.stringify({ echoed, structured, failed, invalid: invalid.length > 0, counts })",
        ].join("; ")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          recordSystem(toolCallStep("cell", { code })),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            McpServers("@test/mcp-cell", { fixture: fixture.stdio() }),
          ],
          providerLayer,
        })
        // Setup listed the tools on a connection it closed.
        expect(yield* fixture.starts).toBe(1)
        yield* client.message.send({ sessionId, branchId, content: "use the fixture server" })
        const result = yield* cellResultAfterDone(client, branchId)
        expect(result).toMatchObject({
          name: "cell",
          isFailure: false,
          result: {
            display: encodeJson({
              echoed: "hihi",
              structured: { ok: true, items: [1, 2] },
              failed: "fixture failure",
              invalid: true,
              // Four calls reached the server before these: one process served them all.
              counts: ["4", "5"],
            }),
          },
        })
        expect(yield* fixture.starts).toBe(2)
        const system = systems[0] ?? ""
        expect(system).toContain(
          "- tools.mcp.fixture.echo(input: { text: string; times?: number }): Promise<",
        )
        expect(system).toContain("// Echo text back.")
        // Every inner call is a host tool call nested under the cell, with a receipt.
        const cellToolCallId = result?.id
        const inner = yield* client.session.events({ sessionId, branchId, after: 0 }).pipe(
          Stream.filter(
            (envelope) =>
              envelope.event._tag === "ToolCallStarted" &&
              envelope.event.toolName.startsWith("mcp.fixture."),
          ),
          Stream.take(5),
          Stream.runCollect,
        )
        expect(
          inner.map((envelope) => ({
            tool: Reflect.get(envelope.event, "toolName"),
            parent: Reflect.get(envelope.event, "parentToolCallId"),
          })),
        ).toEqual(
          ["echo", "structured", "fail", "echo", "count"].map((name) => ({
            tool: `mcp.fixture.${name}`,
            parent: cellToolCallId,
          })),
        )
        expect(result?.result).toMatchObject({
          operations: expect.arrayContaining([
            expect.objectContaining({ tool: "mcp.fixture.echo", outcome: "succeeded" }),
            expect.objectContaining({ tool: "mcp.fixture.fail", outcome: "failed" }),
          ]),
        })
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "a server with 100 tools collapses to one prompt line, and the cell finds, describes and calls them",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture
        const { systems, recordSystem } = systemRecorder()
        const code = [
          "const found = tools.search('extra_042').map((entry) => entry.id)",
          "const signature = tools.describe('mcp.fixture.extra_042')",
          "const called = await tools.mcp.fixture.extra_042({ owner: 'o', repo: 'r', query: 'q' })",
          "JSON.stringify({ found, signature, called })",
        ].join("; ")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          recordSystem(toolCallStep("cell", { code })),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            // Five named tools and 95 generated ones.
            McpServers("@test/mcp-many", { fixture: fixture.stdio({ MCP_FIXTURE_EXTRA: "95" }) }),
          ],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "find a fixture tool" })
        const result = yield* cellResultAfterDone(client, branchId)
        const system = systems[0] ?? ""
        expect(system).toContain("- tools.mcp.fixture.*: 100 tools (count, echo, extra_000, ")
        expect(system).not.toContain("- tools.mcp.fixture.extra_042(")
        expect(result).toMatchObject({
          name: "cell",
          isFailure: false,
          result: {
            display: encodeJson({
              found: ["mcp.fixture.extra_042"],
              signature:
                "tools.mcp.fixture.extra_042(input: { owner: string; repo: string; query: string; limit?: number }): Promise<unknown> // Generated tool 42 that lists repository issues matching a query.",
              called: "called extra_042",
            }),
          },
        })
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "a tool with an output schema shows a typed result and returns its structured content",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture
        const { systems, recordSystem } = systemRecorder()
        const code = [
          "const signature = tools.describe('mcp.fixture.stats')",
          "const stats = await tools.mcp.fixture.stats()",
          "let broken = ''; try { await tools.mcp.fixture.badstats() } catch (error) { broken = error.message }",
          "JSON.stringify({ signature, stats, broken })",
        ].join("; ")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          recordSystem(toolCallStep("cell", { code })),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            McpServers("@test/mcp-typed", { fixture: fixture.stdio({ MCP_FIXTURE_TYPED: "1" }) }),
          ],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "count the issues" })
        const result = yield* cellResultAfterDone(client, branchId)
        const typed =
          "tools.mcp.fixture.stats(input?: {}): Promise<{ open: number; labels: string[] }>"
        expect(systems[0] ?? "").toContain(`- ${typed} // Count open issues.`)
        expect(result).toMatchObject({ name: "cell", isFailure: false })
        const display = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ signature: Schema.String, stats: Schema.Json, broken: Schema.String }),
          ),
        )(Reflect.get(result?.result ?? {}, "display"))
        expect(display).toMatchObject({
          signature: `${typed} // Count open issues.`,
          stats: { open: 3, labels: ["bug"] },
        })
        expect(display.broken).toContain("does not match")
        expect(display.broken).toContain("output schema")
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "a call to a tool the server stopped listing names the stale catalog, and the cache drops it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* makeFixture
        const hide = path.join(fixture.directory, "hide-count")
        // A fixed directory, so the key does not follow the harness's session cwd.
        const servers = {
          fixture: { ...fixture.stdio({ MCP_FIXTURE_HIDE_COUNT: hide }), cwd: fixture.directory },
        }
        const code = [
          "let stale = ''; try { await tools.mcp.fixture.count() } catch (error) { stale = error.message }",
          "const echoed = await tools.mcp.fixture.echo({ text: 'still here' })",
          "JSON.stringify({ stale, echoed })",
        ].join("; ")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            McpServers("@test/mcp-stale", servers),
          ],
          providerLayer,
        })
        expect(yield* fixture.starts).toBe(1)
        // The server drops `count` after setup cached it.
        yield* fs.writeFileString(hide, "")
        yield* client.message.send({ sessionId, branchId, content: "count" })
        const result = yield* cellResultAfterDone(client, branchId)
        expect(result).toMatchObject({ name: "cell", isFailure: false })
        const display = String(Reflect.get(Object(result?.result), "display"))
        expect(display).toContain("no longer lists count")
        expect(display).toContain('"echoed":"still here"')
        // The connection relisted and wrote the cache, so the next setup has no `count`.
        const next = yield* collectTestContributions(McpServers("@test/mcp-stale", servers).setup, {
          home: path.join(fixture.directory, "home"),
          cwd: fixture.directory,
        })
        expect(toolIds(next)).not.toContain("mcp.fixture.count")
        expect(toolIds(next)).toContain("mcp.fixture.echo")
        expect(yield* fixture.starts).toBe(2)
      }).pipe(
        Effect.timeout("25 seconds"),
        Effect.provide(Layer.provideMerge(withDataDir, platformLayer)),
      ),
    30_000,
  )

  it.scopedLive(
    "a relist that answers no tools for a server that had some keeps the cached tools",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* makeFixture
        const empty = path.join(fixture.directory, "empty-list")
        const servers = {
          fixture: { ...fixture.stdio({ MCP_FIXTURE_EMPTY_LIST: empty }), cwd: fixture.directory },
        }
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: "await tools.mcp.fixture.echo({ text: 'kept' })" }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            McpServers("@test/mcp-empty", servers),
          ],
          providerLayer,
        })
        // The server answers an empty list from now on, as one with broken auth can.
        yield* fs.writeFileString(empty, "")
        yield* client.message.send({ sessionId, branchId, content: "echo" })
        const result = yield* cellResultAfterDone(client, branchId)
        expect(result).toMatchObject({
          name: "cell",
          isFailure: false,
          result: { display: "kept" },
        })
        const next = yield* collectTestContributions(McpServers("@test/mcp-empty", servers).setup, {
          home: path.join(fixture.directory, "home"),
          cwd: fixture.directory,
        })
        expect(toolIds(next)).toHaveLength(5)
        expect(yield* fixture.starts).toBe(2)
      }).pipe(
        Effect.timeout("25 seconds"),
        Effect.provide(Layer.provideMerge(withDataDir, platformLayer)),
      ),
    30_000,
  )

  it.scopedLive(
    "a list_changed notification on an open connection relists and writes the cache",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fixture = yield* makeFixture
        const hide = path.join(fixture.directory, "hide-count")
        const servers = {
          fixture: { ...fixture.stdio({ MCP_FIXTURE_HIDE_COUNT: hide }), cwd: fixture.directory },
        }
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: "await tools.mcp.fixture.hide()" }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            McpServers("@test/mcp-changed", servers),
          ],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "hide count" })
        expect(yield* cellResultAfterDone(client, branchId)).toMatchObject({
          name: "cell",
          isFailure: false,
        })
        const next = yield* waitFor(
          collectTestContributions(McpServers("@test/mcp-changed", servers).setup, {
            home: path.join(fixture.directory, "home"),
            cwd: fixture.directory,
          }).pipe(Effect.map(toolIds)),
          (ids) => !ids.includes("mcp.fixture.count"),
          10_000,
          "the cache drops count",
        )
        expect(next).toContain("mcp.fixture.echo")
        // The open connection relisted; no server started for it.
        expect(yield* fixture.starts).toBe(2)
      }).pipe(
        Effect.timeout("25 seconds"),
        Effect.provide(Layer.provideMerge(withDataDir, platformLayer)),
      ),
    30_000,
  )

  const unknownToolAnswers: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
    ["the spec's -32602 error", {}],
    ["the TypeScript SDK server's isError result", { MCP_FIXTURE_SDK_UNKNOWN: "1" }],
  ]
  for (const [answer, answerEnv] of unknownToolAnswers) {
    it.scopedLive(
      `a call the server answers as an unknown tool (${answer}) names the stale catalog and relists`,
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const fixture = yield* makeFixture
          const hide = path.join(fixture.directory, "hide-count")
          const servers = {
            fixture: {
              ...fixture.stdio({ MCP_FIXTURE_HIDE_COUNT: hide, ...answerEnv }),
              cwd: fixture.directory,
            },
          }
          const code = [
            "await tools.mcp.fixture.drop()",
            "let stale = ''; try { await tools.mcp.fixture.count() } catch (error) { stale = error.message }",
            "stale",
          ].join("; ")
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("cell", { code }),
            textStep("done"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...shippedPreset,
            extensionInputs: [
              ...shippedPreset.extensionInputs,
              McpServers("@test/mcp-unknown", servers),
            ],
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "count" })
          const result = yield* cellResultAfterDone(client, branchId)
          expect(String(Reflect.get(Object(result?.result), "display"))).toContain(
            "no longer lists count",
          )
          yield* waitFor(
            collectTestContributions(McpServers("@test/mcp-unknown", servers).setup, {
              home: path.join(fixture.directory, "home"),
              cwd: fixture.directory,
            }).pipe(Effect.map(toolIds)),
            (ids) => !ids.includes("mcp.fixture.count"),
            10_000,
            "the cache drops count",
          )
        }).pipe(
          Effect.timeout("25 seconds"),
          Effect.provide(Layer.provideMerge(withDataDir, platformLayer)),
        ),
      30_000,
    )
  }

  it.scopedLive(
    "a failed connect is not kept: the next call connects again",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture
        const code = [
          "let first = ''; try { await tools.mcp.fixture.echo({ text: 'a' }) } catch (error) { first = 'failed' }",
          "const second = await tools.mcp.fixture.echo({ text: 'b' })",
          "JSON.stringify({ first, second })",
        ].join("; ")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            // Setup is start 1; the first call's connect is start 2, which exits.
            McpServers("@test/mcp-retry", {
              fixture: { ...fixture.stdio({ MCP_FIXTURE_FAIL_ON_START: "2" }), timeoutMs: 5000 },
            }),
          ],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "echo twice" })
        const result = yield* cellResultAfterDone(client, branchId)
        expect(result).toMatchObject({
          name: "cell",
          isFailure: false,
          result: { display: encodeJson({ first: "failed", second: "b" }) },
        })
        expect(yield* fixture.starts).toBe(3)
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "a server that exits after connecting is dropped: the next call starts it again",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture
        // A call can race the exit it follows and fail once (the server may
        // have run it, so it is not sent again); each count gets two tries.
        const code = [
          "const counts = []",
          "for (let index = 0; index < 3; index++) { let value = 'failed'; for (let attempt = 0; attempt < 2 && value === 'failed'; attempt++) { try { value = await tools.mcp.fixture.count() } catch (error) {} } counts.push(value) }",
          "JSON.stringify(counts)",
        ].join("; ")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            McpServers("@test/mcp-exit", {
              fixture: { ...fixture.stdio({ MCP_FIXTURE_EXIT_AFTER_CALL: "1" }), timeoutMs: 5000 },
            }),
          ],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "count three times" })
        const result = yield* cellResultAfterDone(client, branchId)
        // Each call reaches a new process, which served one call and exited.
        expect(result).toMatchObject({
          name: "cell",
          isFailure: false,
          result: { display: encodeJson(["1", "1", "1"]) },
        })
        expect(yield* fixture.starts).toBe(4)
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(platformLayer)),
    30_000,
  )

  it.scopedLive(
    "a stdio server runs with the host environment, its entry's env winning",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture
        const code = [
          "const host = await tools.mcp.fixture.env({ name: 'GENT_MCP_HOST_ONLY' })",
          "const declared = await tools.mcp.fixture.env({ name: 'GENT_MCP_DECLARED' })",
          "JSON.stringify({ host, declared })",
        ].join("; ")
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [
            ...shippedPreset.extensionInputs,
            McpServers("@test/mcp-env", {
              fixture: fixture.stdio({
                MCP_FIXTURE_ENV_TOOL: "1",
                GENT_MCP_DECLARED: "from the entry",
              }),
            }),
          ],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "read the environment" })
        const result = yield* cellResultAfterDone(client, branchId)
        expect(result).toMatchObject({
          name: "cell",
          isFailure: false,
          result: {
            display: encodeJson({ host: "from the host", declared: "from the entry" }),
          },
        })
      }).pipe(
        Effect.timeout("25 seconds"),
        Effect.provide(
          Layer.merge(
            platformLayer,
            // The gent process's environment, as a proxy or CA variable is in a user's shell.
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { GENT_MCP_HOST_ONLY: "from the host", GENT_MCP_DECLARED: "from the host" },
              }),
            ),
          ),
        ),
      ),
    30_000,
  )
})
