#!/usr/bin/env bun
import { Command, Flag, Argument } from "effect/unstable/cli"
import type { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import { BunPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"
import {
  Cause,
  Config,
  Console,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Runtime,
  Schema,
  Tracer,
} from "effect"
import { makeClientTraceLogger } from "./utils/client-trace-logger"
import { identity } from "effect/Function"
import type { Context } from "effect"
import { RegistryProvider } from "./atom-solid/solid"
import { LinkOpener } from "./services/link-opener"
import { OsService } from "./services/os-service"
import type { ProviderId } from "@gent/core-internal/domain/model.js"
import {
  RunSpecSchema,
  AgentName as AgentNameSchema,
  type RunSpec,
  type AgentName,
} from "@gent/core-internal/domain/agent.js"

import { render } from "@opentui/solid"
import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { App } from "./app"
import { detectColorScheme } from "./theme/index"
import { ClientProvider } from "./client/index"
import { RouterProvider } from "./router/index"
import { WorkspaceProvider } from "./workspace/context"
import { EnvProvider } from "./env/context"
import { ExtensionUIProvider } from "./extensions/context"
import { clearClientLog, createClientLog, shutdownLog } from "./utils/client-logger"
import {
  AppBootstrapError,
  resolveInteractiveBootstrap,
  resolveInitialState,
  resolveStartupAuthState,
  type InitialState,
} from "./app-bootstrap"
import { runHeadless } from "./headless-runner"
import { DEFAULT_HEADLESS_TOOL_RENDERERS } from "./headless-tool-renderers"
import {
  Gent,
  GentConnectionError,
  probeServerLockEntryIdentity,
  type GentClientBundle,
} from "@gent/sdk"
import {
  readServerLock,
  validateServerLockEntry,
  removeServerLock,
  isPidAlive,
  getLocalHostname,
  signalIfIdentityOwned,
  type ServerLockEntry,
} from "@gent/sdk/server-lock"
import { builtinClientModules } from "./extensions/builtins/index"
import { loadExtensionUi } from "./services/extension-context-boundary"
import { makeClientTransportLayer } from "./extensions/client-transport"
import {
  makeClientComposerLayer,
  makeClientLifecycleLayer,
  makeClientShellLayer,
  makeClientWorkspaceLayer,
} from "./extensions/client-services"
import type { ClientRuntime } from "./extensions/client-facets.js"
import {
  extensionHealthError,
  extensionHealthFromSnapshot,
  extensionHealthUnavailable,
  formatDoctorReport,
  makeDoctorReport,
  resetStorage,
  type ExtensionDoctorHealth,
} from "./ops/local-health"

// Clear client log on startup
clearClientLog()

const formatMissingProviders = (providers: readonly ProviderId[]): string =>
  providers.map((provider) => provider).join(", ")

const ATOM_CACHE_MAX = 256

const waitForRendererDestroy = (renderer: CliRenderer) =>
  Effect.callback<void>((resume) => {
    let settled = false
    // @effect-diagnostics-next-line globalTimersInEffect:off -- process lifetime handle: OpenTUI render resolves after mount and suspended Effect fibers do not keep Bun alive
    const keepAlive = setInterval(() => {}, 60_000)
    const onDestroy = () => {
      if (settled) return
      settled = true
      clearInterval(keepAlive)
      resume(Effect.void)
    }

    renderer.once("destroy", onDestroy)

    return Effect.sync(() => {
      if (settled) return
      settled = true
      clearInterval(keepAlive)
      renderer.off("destroy", onDestroy)
      renderer.destroy()
    })
  })

class CliStartupError extends Schema.TaggedErrorClass<CliStartupError>()("CliStartupError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Platform layer — `BunPlatformLive` bundles `BunServices.layer`
// (FileSystem, Path, ChildProcessSpawner, …) with `BunGentPlatformLive`
// so callers can yield `GentPlatform` alongside the standard primitives.
const PlatformLayer = BunPlatformLive

const LinkLayer = Layer.provide(LinkOpener.Live, OsService.Live)

// `OsService.Live` and `LinkLayer` depend on `GentPlatform`, which
// `PlatformLayer` provides. `Layer.mergeAll` builds in parallel, so use
// `provideMerge` to thread `GentPlatform` into the dependents while
// keeping it in the output context for downstream consumers.
const makeUiLayer = () => Layer.provideMerge(LinkLayer, PlatformLayer)

const resolveParentSpan = () =>
  Effect.gen(function* () {
    const traceIdOpt = yield* Config.option(Config.string("GENT_TRACE_ID"))
    const parentSpanIdOpt = yield* Config.option(Config.string("GENT_PARENT_SPAN_ID"))

    if (!Option.isSome(traceIdOpt) || !Option.isSome(parentSpanIdOpt)) return undefined

    return Tracer.externalSpan({
      traceId: traceIdOpt.value,
      spanId: parentSpanIdOpt.value,
      sampled: true,
    })
  })

const runHeadlessTurn = (
  bundle: GentClientBundle,
  state: Extract<InitialState, { readonly _tag: "headless" }>,
  cwd: string,
  home: string,
  agent: AgentName | undefined,
  runSpec?: RunSpec,
) =>
  Effect.gen(function* () {
    const branchId = state.session.activeBranchId
    if (branchId === undefined) {
      yield* Console.error("Error: session has no branch")
      return yield* new AppBootstrapError({
        sessionId: state.session.id,
        reason: "missing-branch",
      })
    }

    const parentSpan = yield* resolveParentSpan()
    const clientRuntime: ClientRuntime = ManagedRuntime.make(
      Layer.mergeAll(
        BunFileSystem.layer,
        BunServices.layer,
        makeClientTransportLayer({
          client: bundle.client,
          runtime: bundle.runtime,
          currentSession: () => ({ sessionId: state.session.id, branchId }),
          onExtensionStateChanged: () => () => {},
          onSessionEvent: () => () => {},
        }),
        makeClientWorkspaceLayer({ cwd, home }),
        makeClientShellLayer({
          sendMessage: () => {},
          openOverlay: () => {},
          closeOverlay: () => {},
        }),
        makeClientComposerLayer({
          state: () => ({
            draft: "",
            mode: "editing",
            inputFocused: false,
            autocompleteOpen: false,
          }),
        }),
        makeClientLifecycleLayer({ addCleanup: () => {} }),
      ),
    )
    const toolRenderers = yield* Effect.promise(() =>
      loadExtensionUi(clientRuntime, {
        builtins: builtinClientModules,
        home,
        cwd,
      }).finally(() => clientRuntime.dispose()),
    ).pipe(
      Effect.map((resolved) => resolved.headlessRenderers),
      Effect.catchEager(() => Effect.succeed(DEFAULT_HEADLESS_TOOL_RENDERERS)),
    )
    yield* bundle.runtime.lifecycle.waitForReady.pipe(
      Effect.timeoutOption("15 seconds"),
      Effect.flatMap((ready) =>
        Option.match(ready, {
          onNone: () =>
            Effect.fail(
              new GentConnectionError({
                message: "connection did not become ready within 15 seconds",
              }),
            ),
          onSome: () => Effect.void,
        }),
      ),
    )

    yield* runHeadless(
      bundle.client,
      state.session.id,
      branchId,
      state.prompt,
      agent,
      runSpec,
      toolRenderers,
    ).pipe(
      Effect.withSpan("Headless.run"),
      parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
    )
  })

// Main command - launches TUI or runs headless
const main = Command.make(
  "gent",
  {
    connect: Flag.string("connect").pipe(
      Flag.withDescription("Connect to an existing gent server"),
      Flag.optional,
    ),
    session: Flag.string("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Session ID to continue"),
      Flag.optional,
    ),
    continue_: Flag.boolean("continue").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("Continue last session from current directory"),
      Flag.withDefault(false),
    ),
    headless: Flag.boolean("headless").pipe(
      Flag.withAlias("H"),
      Flag.withDescription("Run in headless mode (no TUI, streams to stdout)"),
      Flag.withDefault(false),
    ),
    isolate: Flag.boolean("isolate").pipe(
      Flag.withDescription("Run with an in-process server (no shared server, no registry)"),
      Flag.withDefault(false),
    ),
    debug: Flag.boolean("debug").pipe(
      Flag.withDescription("Launch TUI renderer playground for widgets and tool renderers"),
      Flag.withDefault(false),
    ),
    prompt: Flag.string("prompt").pipe(
      Flag.withAlias("p"),
      Flag.withDescription("Initial prompt (TUI mode)"),
      Flag.optional,
    ),
    promptArg: Argument.string("prompt").pipe(
      Argument.withDescription("Prompt for headless mode"),
      Argument.optional,
    ),
    agent: Flag.string("agent").pipe(
      Flag.withAlias("a"),
      Flag.withDescription("Agent to use for headless mode (e.g. memory:reflect)"),
      Flag.optional,
    ),
    runSpec: Flag.string("run-spec").pipe(
      Flag.withDescription("JSON-encoded RunSpec (internal, used by subprocess runner)"),
      Flag.optional,
    ),
  },
  ({
    connect,
    session,
    continue_,
    isolate,
    headless,
    debug,
    prompt,
    promptArg,
    agent,
    runSpec: runSpecJson,
  }) =>
    Effect.gen(function* () {
      const cwd = process.cwd()
      const home = Option.getOrElse(yield* Config.option(Config.string("HOME")), () => "/tmp")
      const scope = yield* Effect.scope
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- platform boundary validates foreign runtime shape before use
      const uiServices = (yield* Layer.buildWithScope(
        makeUiLayer(),
        scope,
      )) as Context.Context<unknown>
      const visualOpt = yield* Config.option(Config.string("VISUAL"))
      const editorOpt = yield* Config.option(Config.string("EDITOR"))
      const authDirectoryOpt = yield* Config.option(Config.string("GENT_AUTH_DIRECTORY"))
      const env = {
        visual: Option.getOrUndefined(visualOpt),
        editor: Option.getOrUndefined(editorOpt),
      }

      // Create Effect-backed logger from captured services
      const logServices = yield* Effect.context<never>()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- platform boundary validates foreign runtime shape before use
      const log = createClientLog(logServices as Context.Context<unknown>)
      let mainFiber: Fiber.Fiber<unknown, unknown> | undefined
      yield* Effect.withFiber((fiber) =>
        Effect.sync(() => {
          mainFiber = fiber
        }),
      )
      const mainServices = yield* Effect.context<never>()
      const interruptMain = () => {
        shutdownLog("shutdown.interrupt-fiber")
        if (mainFiber !== undefined) {
          Effect.runForkWith(mainServices)(Fiber.interrupt(mainFiber))
        }
      }

      const resolveBundle = () => {
        if (Option.isSome(connect)) return Gent.client(connect.value)
        const serverState = debug || isolate ? Gent.state.memory() : Gent.state.sqlite()
        const serverProvider = debug ? Gent.provider.mock() : Gent.provider.live()
        return Effect.flatMap(
          Gent.server({
            cwd,
            state: serverState,
            provider: serverProvider,
            ...(Option.isSome(authDirectoryOpt) ? { authDirectory: authDirectoryOpt.value } : {}),
            debug,
          }),
          Gent.client,
        )
      }
      const bundle = yield* resolveBundle()
      const requestedAgent: AgentName | undefined =
        Option.isSome(agent) && Schema.is(AgentNameSchema)(agent.value) ? agent.value : undefined

      if (headless) {
        yield* bundle.runtime.lifecycle.waitForReady
        const state = yield* resolveInitialState({
          client: bundle.client,
          cwd,
          session,
          continue_: continue_ || debug,
          headless,
          prompt,
          promptArg,
        })

        const startupAuth = yield* resolveStartupAuthState({
          client: bundle.client,
          state,
          ...(requestedAgent !== undefined ? { requestedAgent } : {}),
        })
        const missingProviders = startupAuth.missingProviders

        if (missingProviders.length > 0 && !debug && !Option.isSome(connect)) {
          const hint = formatMissingProviders(missingProviders)
          yield* Console.error(`Error: missing required API keys: ${hint}`)
          return yield* new CliStartupError({ message: hint })
        }

        if (state._tag !== "headless") {
          return yield* new CliStartupError({
            message: "headless startup resolved an interactive state",
          })
        }

        const decodedRunSpec: RunSpec | undefined = Option.isSome(runSpecJson)
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunSpecSchema))(
              runSpecJson.value,
            ).pipe(
              Effect.mapError(
                (e) =>
                  new CliStartupError({ message: `Invalid --run-spec: ${String(e)}`, cause: e }),
              ),
            )
          : undefined

        yield* runHeadlessTurn(bundle, state, cwd, home, requestedAgent, decodedRunSpec)
        return
      }

      // Block until supervisor is ready (same as headless path)
      yield* bundle.runtime.lifecycle.waitForReady

      // Resolve session + auth before rendering — eliminates the loading route
      const { bootstrap, initialAgent } = yield* resolveInteractiveBootstrap({
        client: bundle.client,
        cwd,
        sessionId: Option.getOrUndefined(session),
        continue_: continue_ || debug,
        prompt: Option.getOrUndefined(prompt),
        debugMode: debug,
      })

      const missingAuth = bootstrap.missingAuthProviders

      // Resolve the terminal color scheme once before render so theme detection
      // never runs in the synchronous Solid render path.
      const initialThemeMode = yield* detectColorScheme

      // Shutdown signal — interrupt the main fiber to break out of Layer.launch's
      // Effect.never, triggering scope finalization (supervisor.stop, WS close, etc).
      const envWithShutdown = {
        ...env,
        shutdown: () => {
          interruptMain()
        },
      }

      const renderer = yield* Effect.promise(() =>
        createCliRenderer({
          onDestroy: () => {
            shutdownLog("exit.renderer-destroy")
          },
        }),
      )
      yield* Effect.promise(() =>
        render(
          () => (
            <EnvProvider env={envWithShutdown}>
              <WorkspaceProvider cwd={cwd} home={home} services={uiServices}>
                <RegistryProvider services={uiServices} maxEntries={ATOM_CACHE_MAX}>
                  <ClientProvider
                    client={bundle.client}
                    runtime={bundle.runtime}
                    services={uiServices}
                    log={log}
                    initialSession={bootstrap.initialSession}
                    initialAgent={initialAgent}
                  >
                    <ExtensionUIProvider>
                      <RouterProvider initialRoute={bootstrap.initialRoute}>
                        <App
                          debugMode={debug}
                          missingAuthProviders={missingAuth}
                          initialThemeMode={initialThemeMode}
                        />
                      </RouterProvider>
                    </ExtensionUIProvider>
                  </ClientProvider>
                </RegistryProvider>
              </WorkspaceProvider>
            </EnvProvider>
          ),
          renderer,
        ),
      )
      // Keep a real process handle open until the renderer is destroyed.
      // OpenTUI mounts synchronously and `render(...)` resolves immediately;
      // a bare suspended fiber does not keep Bun alive.
      return yield* waitForRendererDestroy(renderer).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            shutdownLog("shutdown.interrupted")
          }),
        ),
      )
    }),
)

// Sessions subcommand
const sessions = Command.make(
  "sessions",
  {
    connect: Flag.string("connect").pipe(
      Flag.withDescription("Connect to an existing gent server"),
      Flag.optional,
    ),
    isolate: Flag.boolean("isolate").pipe(
      Flag.withDescription("Run with an in-process server (no shared server, no registry)"),
      Flag.withDefault(false),
    ),
  },
  ({ connect, isolate }) =>
    Effect.gen(function* () {
      const cwd = process.cwd()
      const resolveBundle = () => {
        if (Option.isSome(connect)) return Gent.client(connect.value)
        const serverState = isolate ? Gent.state.memory() : Gent.state.sqlite()
        return Effect.flatMap(Gent.server({ cwd, state: serverState }), Gent.client)
      }
      const bundle = yield* resolveBundle()
      yield* bundle.runtime.lifecycle.waitForReady
      const allSessions = yield* bundle.client.session.list()

      if (allSessions.length === 0) {
        yield* Console.log("No sessions found.")
        return
      }

      yield* Console.log("Sessions:")
      for (const s of allSessions) {
        const date = DateTime.make(s.updatedAt).pipe(
          Option.match({
            onNone: () => "unknown",
            onSome: DateTime.formatIso,
          }),
        )
        yield* Console.log(`  ${s.id} - ${s.name ?? "Unnamed"} (${date})`)
      }
    }),
)

// Server status subcommand
const serverStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const home = Option.getOrElse(yield* Config.option(Config.string("HOME")), () => "/tmp")
    const entry = yield* readServerLock(home)

    if (entry === undefined) {
      yield* Console.log("No shared server.")
      return
    }

    yield* Console.log("Shared server:\n")
    yield* Console.log(
      `${"PID".padEnd(8)} ${"STATUS".padEnd(10)} ${"SERVER ID".padEnd(40)} ${"DB PATH".padEnd(40)} ${"URL"}`,
    )
    yield* Console.log("─".repeat(120))

    const validation = yield* validateServerLockEntry(entry)
    const status = validation.valid ? "alive" : `dead (${validation.reason})`
    yield* Console.log(
      `${String(entry.pid).padEnd(8)} ${status.padEnd(10)} ${entry.serverId.padEnd(40)} ${entry.dbPath.padEnd(40)} ${entry.rpcUrl}`,
    )
  }),
)

// Server stop subcommand
const serverStop = Command.make(
  "stop",
  {
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Stop all registered servers"),
      Flag.withDefault(false),
    ),
  },
  ({ all }) =>
    Effect.gen(function* () {
      const home = Option.getOrElse(yield* Config.option(Config.string("HOME")), () => "/tmp")
      const thisHost = yield* getLocalHostname
      const entry = yield* readServerLock(home)

      if (entry === undefined) {
        yield* Console.log("No shared server.")
        return
      }

      if (entry.hostname !== thisHost || (!all && !(yield* isPidAlive(entry.pid)))) {
        yield* Console.log("No live shared server to stop on this host.")
        return
      }

      // Signal target — identity-probe before SIGTERM so PID reuse after a
      // crash never kills an unrelated process (same boundary as SDK attach).
      const outcome = yield* signalIfIdentityOwned(entry, probeServerLockEntryIdentity)
      if (outcome === "signaled") {
        yield* Console.log(`Sent SIGTERM to PID ${entry.pid} (${entry.serverId})`)
      } else {
        yield* Console.log(`Skipped PID ${entry.pid} (${entry.serverId}): identity probe failed`)
      }

      // Wait for the process to exit, then cleanup the server lock.
      yield* Effect.sleep("2 seconds")

      if (yield* isPidAlive(entry.pid)) {
        yield* Console.log("\nShared server is still running after SIGTERM.")
      } else {
        yield* removeServerLock(home, entry.serverId)
        yield* Console.log("\nShared server stopped and cleaned up.")
      }
    }),
)

// Server subcommand group
const server = Command.make("server", {}, () =>
  Console.log("Usage: gent server <status|stop>"),
).pipe(Command.withSubcommands([serverStatus, serverStop]))

const readDoctorExtensionHealth = (
  entry: ServerLockEntry,
): Effect.Effect<ExtensionDoctorHealth, never, GentPlatform> =>
  Effect.gen(function* () {
    const validation = yield* validateServerLockEntry(entry)
    if (!validation.valid) {
      return extensionHealthUnavailable(
        validation.reason === "dead-pid"
          ? "Shared server lock is stale."
          : "Shared server is not local to this host.",
      )
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const bundle = yield* Gent.client(entry.rpcUrl, { cwd: process.cwd() })
        yield* bundle.runtime.lifecycle.waitForReady
        const snapshot = yield* bundle.client.extension.listStatus({})
        return extensionHealthFromSnapshot(snapshot)
      }),
    ).pipe(Effect.catch((error: unknown) => Effect.succeed(extensionHealthError(String(error)))))
  })

const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const home = Option.getOrElse(yield* Config.option(Config.string("HOME")), () => "/tmp")
    const entry = yield* readServerLock(home)
    const extensions =
      entry === undefined
        ? extensionHealthUnavailable("No shared server.")
        : yield* readDoctorExtensionHealth(entry)
    const report = yield* makeDoctorReport(home, entry, extensions)
    yield* Console.log(formatDoctorReport(report))
  }),
)

const storageReset = Command.make("reset", {}, () =>
  Effect.gen(function* () {
    const home = Option.getOrElse(yield* Config.option(Config.string("HOME")), () => "/tmp")
    const entry = yield* readServerLock(home)
    if (entry !== undefined && (yield* validateServerLockEntry(entry)).valid) {
      yield* Console.error(
        "Error: shared server is running. Stop it with `gent server stop` first.",
      )
      return yield* new CliStartupError({
        message: "shared server is running; refusing to reset storage",
      })
    }

    const result = yield* resetStorage(home)
    if (result.archived.length === 0) {
      yield* Console.log("No storage files found.")
      return
    }

    yield* Console.log(`Archived storage files to ${result.archiveDir}`)
    for (const file of result.archived) {
      yield* Console.log(`  ${file}`)
    }
  }),
)

const storage = Command.make("storage", {}, () => Console.log("Usage: gent storage <reset>")).pipe(
  Command.withSubcommands([storageReset]),
)

// Root command with subcommands
const command = main.pipe(
  Command.withSubcommands([sessions, server, doctor, storage]),
  Command.withDescription("Gent - minimal, opinionated agent harness"),
)

// CLI
const cli = Command.run(command, {
  version: "0.0.0",
})
const TraceLoggerLayer = Layer.unwrap(
  makeClientTraceLogger().pipe(Effect.map((logger) => Logger.layer([logger]))),
)
const CliRuntimeLayer = Layer.merge(PlatformLayer, Layer.provide(TraceLoggerLayer, PlatformLayer))
// @effect-diagnostics-next-line strictEffectProvide:off entrypoint layer provision
const mainEffect = cli.pipe(Effect.provide(CliRuntimeLayer))

const gracefulCliTeardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit)) {
    onExit(0)
    return
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    onExit(0)
    return
  }
  Runtime.defaultTeardown(exit, onExit)
}

const runCliMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  let receivedSignal = false

  fiber.addObserver((exit) => {
    if (!receivedSignal) {
      process.removeListener("SIGINT", onSignal)
      process.removeListener("SIGTERM", onSignal)
    }
    teardown(exit, (code) => {
      process.exit(code)
    })
  })

  function onSignal() {
    receivedSignal = true
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    fiber.interruptUnsafe(fiber.id)
  }

  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
})

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- platform boundary validates foreign runtime shape before use
runCliMain(Effect.scoped(mainEffect) as Effect.Effect<void>, { teardown: gracefulCliTeardown })
