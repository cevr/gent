import { describe, expect, it, test } from "effect-bun-test"
import {
  builtinDriver,
  builtinHerdr,
  getFileTag,
  makeHerdrReporter,
  searchFiles,
} from "../../src/extensions/builtins"
import { BunServices } from "@effect/platform-bun"
import {
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
  Scope,
} from "effect"
import { AgentName, BranchId, DriverRef, SessionId } from "@gent/core/protocol"
import { AllBuiltinAgents } from "../../../../packages/extensions/tests/helpers/builtin-agents.js"
import {
  type ClientActivitySnapshot,
  ClientContext,
  type ClientContextDeps,
  makeClientContextLayer,
} from "../../src/extensions/client-facets"
import { createMockClient, createMockRuntime } from "../render-harness-boundary"
import {
  makeClientTestTransport,
  makePaneSlot,
  runClientExtensionSetupWithRuntime,
} from "../extension-test-harness-boundary"
import { createSignal } from "solid-js"

// ── ../file-tag.test ────────────────────────────────────────────────────────

describe("getFileTag", () => {
  test("returns [ts] for TypeScript files", () => {
    expect(getFileTag("file.ts")).toBe("[ts]")
    expect(getFileTag("component.tsx")).toBe("[ts]")
    expect(getFileTag("src/utils/helper.ts")).toBe("[ts]")
  })

  test("returns [js] for JavaScript files", () => {
    expect(getFileTag("file.js")).toBe("[js]")
    expect(getFileTag("component.jsx")).toBe("[js]")
  })

  test("returns [md] for Markdown files", () => {
    expect(getFileTag("README.md")).toBe("[md]")
    expect(getFileTag("docs/guide.mdx")).toBe("[md]")
  })

  test("returns [json] for JSON files", () => {
    expect(getFileTag("package.json")).toBe("[json]")
    expect(getFileTag("tsconfig.json")).toBe("[json]")
  })

  test("returns [css] for CSS-like files", () => {
    expect(getFileTag("styles.css")).toBe("[css]")
    expect(getFileTag("theme.scss")).toBe("[css]")
    expect(getFileTag("vars.less")).toBe("[css]")
  })

  test("returns [html] for HTML files", () => {
    expect(getFileTag("index.html")).toBe("[html]")
  })

  test("returns [py] for Python files", () => {
    expect(getFileTag("script.py")).toBe("[py]")
  })

  test("returns [rs] for Rust files", () => {
    expect(getFileTag("main.rs")).toBe("[rs]")
  })

  test("returns [go] for Go files", () => {
    expect(getFileTag("main.go")).toBe("[go]")
  })

  test("returns [yaml] for YAML files", () => {
    expect(getFileTag("config.yaml")).toBe("[yaml]")
    expect(getFileTag("ci.yml")).toBe("[yaml]")
  })

  test("returns [toml] for TOML files", () => {
    expect(getFileTag("Cargo.toml")).toBe("[toml]")
  })

  test("returns [sh] for shell files", () => {
    expect(getFileTag("script.sh")).toBe("[sh]")
    expect(getFileTag("setup.bash")).toBe("[sh]")
    expect(getFileTag("init.zsh")).toBe("[sh]")
  })

  test("returns empty string for unknown extensions", () => {
    expect(getFileTag("file.txt")).toBe("")
    expect(getFileTag("image.png")).toBe("")
    expect(getFileTag("archive.zip")).toBe("")
  })

  test("returns empty string for files without extension", () => {
    expect(getFileTag("Makefile")).toBe("")
    expect(getFileTag("Dockerfile")).toBe("")
  })

  test("is case insensitive", () => {
    expect(getFileTag("FILE.TS")).toBe("[ts]")
    expect(getFileTag("README.MD")).toBe("[md]")
    expect(getFileTag("Config.JSON")).toBe("[json]")
  })
})

// ── ../file-finder-db-dir.test ──────────────────────────────────────────────

/**
 * The finder keeps its frecency and history databases where the caller says.
 * A build that memoizes the directory on the first call reuses it for every
 * later workspace, so the second directory here is never written.
 */
const finderTest = it.scopedLive.layer(BunServices.layer)

describe("file finder db dir", () => {
  finderTest("each search writes the db dir it was handed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const first = yield* fs.makeTempDirectoryScoped()
      const second = yield* fs.makeTempDirectoryScoped()
      const cwd = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${cwd}/alpha.ts`, "export const a = 1\n")

      const firstDbDir = `${first}/.gent/fff`
      const secondDbDir = `${second}/.gent/fff`
      yield* fs.makeDirectory(firstDbDir, { recursive: true })
      yield* fs.makeDirectory(secondDbDir, { recursive: true })

      // Distinct cwds: the finder cache is keyed by cwd, so each call builds
      // its own finder and has to honour the db dir passed with it.
      const secondCwd = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(`${secondCwd}/beta.ts`, "export const b = 2\n")

      yield* Effect.option(searchFiles(cwd, firstDbDir, "alpha", 5))
      yield* Effect.option(searchFiles(secondCwd, secondDbDir, "beta", 5))

      const wrote = (dir: string) => Effect.map(fs.readDirectory(dir), (names) => names.length > 0)

      expect(yield* Effect.orElseSucceed(wrote(firstDbDir), () => false)).toBe(true)
      expect(yield* Effect.orElseSucceed(wrote(secondDbDir), () => false)).toBe(true)
    }),
  )
})

/** A `ClientContext` layer over a test transport; `deps` replaces any default. */
const contextLayer = (deps: Partial<ClientContextDeps> = {}) =>
  makeClientContextLayer({
    transport: makeClientTestTransport({ currentSession: () => Option.none() }),
    workspace: { cwd: "/tmp/test-cwd", home: "/tmp/test-home" },
    shell: { cast: createMockRuntime().cast, pane: makePaneSlot() },
    ...deps,
  })

// ── ../driver-transport.test ────────────────────────────────────────────────

/**
 * `/driver` routes through `transport.driverList/driverSet/driverClear`.
 *
 * The transport seals every shell RPC failure into a
 * `ClientTransportRequestError` that names the RPC and keeps the server's
 * tagged error as `cause`; the slash command reports that failure through
 * `shell.notify`, and a change that lands reports nothing.
 */

class DriverRejected extends Schema.TaggedError<DriverRejected>()("DriverRejected", {
  driverId: Schema.String,
}) {}

const absent = Option.getOrUndefined(Option.none())
const agentName = AgentName.make("main")
const session = { sessionId: SessionId.make("sess-1"), branchId: BranchId.make("branch-1") }

const driverListReply = {
  drivers: [{ _tag: "Model", id: "model:sonnet" }],
  overrides: {},
  agents: AllBuiltinAgents,
}

/**
 * Run the `/driver` slash once. Resolves with the notices the shell received
 * once `settled` completes: the transport call the test waits on, or the
 * first notice.
 */
const runDriverSlash = (
  transport: ReturnType<typeof makeClientTestTransport>,
  args: string,
  settled: Deferred.Deferred<void>,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const notices: Array<string> = []
    const contributions = yield* runClientExtensionSetupWithRuntime(builtinDriver, {
      transport,
      shell: {
        notify: (message) => {
          notices.push(message)
          Deferred.doneUnsafe(settled, Effect.void)
        },
      },
    })
    const command = Option.fromUndefinedOr(contributions.commands).pipe(
      Option.flatMap((commands) => Option.fromUndefinedOr(commands[0])),
      Option.flatMap((entry) => Option.fromUndefinedOr(entry.onSlash)),
    )
    expect(Option.isSome(command)).toBe(true)
    if (Option.isSome(command)) command.value(args)
    yield* Deferred.await(settled)
    return notices
  })

describe("driver routing through the client transport", () => {
  it.live(
    "driverSet keeps the server's tagged error as the cause of ClientTransportRequestError",
    () => {
      const rejected = new DriverRejected({ driverId: "model:nope" })
      const transport = makeClientTestTransport({ currentSession: () => Option.none() })
      const client = createMockClient({ driver: { set: () => Effect.fail(rejected) } })
      const layer = contextLayer({
        transport: { ...transport, client, runtime: createMockRuntime() },
      })
      return Effect.gen(function* () {
        const { transport: service } = yield* ClientContext
        const error = yield* service
          .driverSet({ agentName, driver: DriverRef.make({ id: "model:nope" }) })
          .pipe(Effect.flip)
        expect(error._tag).toBe("ClientTransportRequestError")
        expect(error.tag).toBe("driver.set")
        const cause = Option.fromUndefinedOr(error.cause)
        expect(Option.isSome(cause)).toBe(true)
        if (Option.isSome(cause)) expect(cause.value).toBe(rejected)
      }).pipe(Effect.provide(layer))
    },
  )

  it.live("/driver <agent> <known-id> sets the override without a notice", () =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>()
      const seen: Array<{ readonly agentName: string; readonly driverId: string }> = []
      const client = createMockClient({
        driver: {
          list: () => Effect.succeed(driverListReply),
          set: (input: { agentName: AgentName; driver: { id: string } }) => {
            seen.push({ agentName: input.agentName, driverId: input.driver.id })
            return Deferred.succeed(settled, absent)
          },
        },
      })
      const transport = {
        ...makeClientTestTransport({ currentSession: () => Option.some(session) }),
        client,
      }
      const notices = yield* runDriverSlash(transport, "main model:sonnet", settled).pipe(
        Effect.timeout("5 seconds"),
      )
      expect(notices).toEqual([])
      expect(seen).toEqual([{ agentName: "main", driverId: "model:sonnet" }])
    }),
  )

  it.live("/driver reports the transport error tag when driver.set is rejected", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        driver: {
          list: () => Effect.succeed(driverListReply),
          set: () => Effect.fail(new DriverRejected({ driverId: "model:sonnet" })),
        },
      })
      const transport = {
        ...makeClientTestTransport({ currentSession: () => Option.some(session) }),
        client,
      }
      const notices = yield* runDriverSlash(
        transport,
        "main model:sonnet",
        yield* Deferred.make<void>(),
      ).pipe(Effect.timeout("5 seconds"))
      const notice = notices.join("\n")
      expect(notice).toContain("Failed to set driver:")
      expect(notice).toContain("ClientTransportRequestError")
      expect(notice).toContain("DriverRejected")
    }),
  )

  it.live("/driver <agent> default clears the override without a notice", () =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>()
      const cleared: Array<string> = []
      const client = createMockClient({
        driver: {
          clear: (input: { agentName: AgentName }) => {
            cleared.push(input.agentName)
            return Deferred.succeed(settled, absent)
          },
        },
      })
      const transport = {
        ...makeClientTestTransport({ currentSession: () => Option.some(session) }),
        client,
      }
      const notices = yield* runDriverSlash(transport, "main default", settled).pipe(
        Effect.timeout("5 seconds"),
      )
      expect(notices).toEqual([])
      expect(cleared).toEqual(["main"])
    }),
  )

  it.live("/driver with a malformed argument notifies the usage hint", () =>
    Effect.gen(function* () {
      const transport = makeClientTestTransport({ currentSession: () => Option.some(session) })
      const notices = yield* runDriverSlash(transport, "main", yield* Deferred.make<void>()).pipe(
        Effect.timeout("5 seconds"),
      )
      expect(notices).toEqual(["Usage: /driver <agent> <driver-id|default>"])
    }),
  )
})

// ── ../herdr-test-server-boundary ───────────────────────────────────────────

/** Local socket boundary for Herdr acceptance tests. */

const Request = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  params: Schema.Struct({
    pane_id: Schema.String,
    source: Schema.String,
    agent: Schema.String,
    seq: Schema.Finite,
    state: Schema.optional(Schema.String),
    agent_session_id: Schema.optional(Schema.String),
  }),
})
const decode = Schema.decodeOption(Schema.fromJsonString(Request))
const encodeReply = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, result: Schema.Struct({}) })),
)

export const makeHerdrTestServer = Effect.fn("Test.makeHerdrServer")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-herdr-" })
  const socketPath = path.join(directory, "s")
  const requests = yield* Queue.unbounded<typeof Request.Type>()
  let respond = true
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      // eslint-disable-next-line effect/noGlobals -- Real Unix socket peer at the test platform boundary.
      Bun.listen<{ buffer: string }>({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.data = { buffer: "" }
          },
          data(socket, chunk) {
            socket.data.buffer += chunk.toString()
            const end = socket.data.buffer.indexOf("\n")
            if (end < 0) return
            const request = decode(socket.data.buffer.slice(0, end))
            if (request._tag === "None") {
              socket.end()
              return
            }
            Queue.offerUnsafe(requests, request.value)
            if (respond) socket.end(`${encodeReply({ id: request.value.id, result: {} })}\n`)
          },
        },
      }),
    ),
    (listener) => Effect.sync(() => listener.stop(true)),
  )
  return {
    target: { socketPath, paneId: "test:p1" },
    next: Queue.take(requests),
    pauseReplies: () => {
      respond = false
    },
    resumeReplies: () => {
      respond = true
    },
    stop: () => server.stop(true),
  }
})

// ── ../herdr.test ───────────────────────────────────────────────────────────

const config = (socketPath: string) =>
  ConfigProvider.fromUnknown({
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: "test:p1",
  })

describe("Herdr integration", () => {
  it.scopedLive("reports the active UI state and session changes, then releases the pane", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      const [snapshot, setSnapshot] = createSignal<ClientActivitySnapshot>({
        sessionId: SessionId.make("session-a"),
        state: "working",
      })
      const cleanups: Array<() => void> = []
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      )
      const context = yield* Layer.buildWithScope(
        contextLayer({ activity: snapshot, lifecycle: { addCleanup: (fn) => cleanups.push(fn) } }),
        scope,
      )
      yield* builtinHerdr.setup.pipe(
        Effect.provideContext(context),
        Effect.provideService(ConfigProvider.ConfigProvider, config(server.target.socketPath)),
      )
      const first = yield* server.next
      expect(first.params).toMatchObject({
        source: "herdr:gent",
        agent: "gent",
        state: "working",
        agent_session_id: "session-a",
      })
      for (const state of [
        "blocked",
        "working",
        "idle",
      ] satisfies ClientActivitySnapshot["state"][]) {
        yield* Effect.sync(() => setSnapshot({ sessionId: SessionId.make("session-a"), state }))
        expect((yield* server.next).params.state).toBe(state)
      }
      yield* Effect.sync(() =>
        setSnapshot({ sessionId: SessionId.make("session-b"), state: "idle" }),
      )
      const switched = yield* server.next
      expect(switched.params.agent_session_id).toBe("session-b")
      expect(switched.params.seq).toBeGreaterThan(first.params.seq)
      yield* Effect.sync(() => {
        for (const cleanup of cleanups) cleanup()
      })
      yield* Scope.close(scope, Exit.void)
      const release = yield* server.next
      expect(release.method).toBe("pane.release_agent")
      expect(release.params.seq).toBeGreaterThan(switched.params.seq)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
  )

  it.scopedLive("release follows an in-flight report and discards queued reports", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      server.pauseReplies()
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      )
      const reporter = yield* makeHerdrReporter(server.target).pipe(Scope.provide(scope))
      reporter.report({ state: "working" })
      const first = yield* server.next
      reporter.report({ state: "idle" })
      server.resumeReplies()
      yield* Scope.close(scope, Exit.void)
      reporter.report({ state: "working" })
      const last = yield* server.next
      expect(last.method).toBe("pane.release_agent")
      expect(last.params.seq).toBeGreaterThan(first.params.seq)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
  )

  it.scopedLive("a missing socket does not fail setup or shutdown", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      server.stop()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reporter = yield* makeHerdrReporter(server.target)
          reporter.report({ state: "working" })
        }),
      )
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
  )

  it.scopedLive("shutdown is bounded when Herdr never replies", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      server.pauseReplies()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reporter = yield* makeHerdrReporter(server.target)
          reporter.report({ state: "working" })
          yield* server.next
        }),
      )
      expect((yield* server.next).method).toBe("pane.release_agent")
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("3 seconds")),
  )

  it.live("does nothing outside Herdr, without pane identity, or in headless mode", () =>
    Effect.gen(function* () {
      for (const env of [
        {},
        { HERDR_ENV: "1" },
        { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/unused", HERDR_PANE_ID: "test:p1" },
        { HERDR_ENV: "0", HERDR_SOCKET_PATH: "/unused", HERDR_PANE_ID: "test:p1" },
      ]) {
        const result = yield* builtinHerdr.setup.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
        )
        expect(result).toBeDefined()
      }
    }).pipe(Effect.provide(contextLayer())),
  )
})
