#!/usr/bin/env bun
import { Command, Flag, Argument } from "effect/unstable/cli"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
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
import type { ProviderId } from "@gent/core/domain/model.js"
import {
  RunSpecSchema,
  AgentName as AgentNameSchema,
  type RunSpec,
  type AgentName,
} from "@gent/core/domain/agent.js"

import { render } from "@opentui/solid"
import { App } from "./app"
import { ClientProvider } from "./client/index"
import { RouterProvider } from "./router/index"
import { WorkspaceProvider } from "./workspace/index"
import { EnvProvider } from "./env/context"
import { ExtensionUIProvider } from "./extensions/context"
import { clearClientLog, createClientLog, shutdownLog } from "./utils/client-logger"
import {
  resolveInteractiveBootstrap,
  resolveInitialState,
  resolveStartupAuthState,
  type InitialState,
} from "./app-bootstrap"
import { runHeadless } from "./headless-runner"
import { Gent, GentConnectionError, type GentClientBundle } from "@gent/sdk"
import {
  listRegistryEntries,
  validateRegistryEntry,
  removeRegistryEntry,
  isPidAlive,
  getLocalHostname,
} from "@gent/sdk/server-registry"

class ServerSignalError extends Schema.TaggedErrorClass<ServerSignalError>()("ServerSignalError", {
  pid: Schema.Number,
  serverId: Schema.String,
}) {}

// Clear client log on startup
clearClientLog()

const formatMissingProviders = (providers: readonly ProviderId[]): string =>
  providers.map((provider) => provider).join(", ")

const ATOM_CACHE_MAX = 256

// Platform layer
const PlatformLayer = Layer.merge(BunServices.layer, BunFileSystem.layer)

const LinkLayer = Layer.provide(LinkOpener.Live, OsService.Live)

const makeUiLayer = () => Layer.mergeAll(PlatformLayer, LinkLayer)

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
  agent: Option.Option<string>,
  runSpec?: RunSpec,
) =>
  Effect.gen(function* () {
    const branchId = state.session.branchId
    if (branchId === undefined) {
      yield* Console.error("Error: session has no branch")
      return yield* Effect.die("session has no branch")
    }

    const parentSpan = yield* resolveParentSpan()
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
      Option.getOrUndefined(agent),
      runSpec,
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const uiServices = (yield* Layer.buildWithScope(
        makeUiLayer(),
        scope,
      )) as Context.Context<unknown>
      const visualOpt = yield* Config.option(Config.string("VISUAL"))
      const editorOpt = yield* Config.option(Config.string("EDITOR"))
      const authFilePathOpt = yield* Config.option(Config.string("GENT_AUTH_FILE_PATH"))
      const authKeyPathOpt = yield* Config.option(Config.string("GENT_AUTH_KEY_PATH"))
      const env = {
        visual: Option.getOrUndefined(visualOpt),
        editor: Option.getOrUndefined(editorOpt),
      }

      // Create Effect-backed logger from captured services
      const logServices = yield* Effect.context<never>()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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
            ...(Option.isSome(authFilePathOpt) ? { authFilePath: authFilePathOpt.value } : {}),
            ...(Option.isSome(authKeyPathOpt) ? { authKeyPath: authKeyPathOpt.value } : {}),
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

        if (missingProviders.length > 0 && !debug) {
          const hint = formatMissingProviders(missingProviders)
          yield* Console.error(`Error: missing required API keys: ${hint}`)
          return yield* Effect.die(hint)
        }

        if (state._tag !== "headless") {
          return yield* Effect.die("headless startup resolved an interactive state")
        }

        const decodedRunSpec: RunSpec | undefined = Option.isSome(runSpecJson)
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunSpecSchema))(
              runSpecJson.value,
            ).pipe(Effect.catchEager((e) => Effect.die(`Invalid --run-spec: ${String(e)}`)))
          : undefined

        yield* runHeadlessTurn(bundle, state, agent, decodedRunSpec)
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

      // Shutdown signal — interrupt the main fiber to break out of Layer.launch's
      // Effect.never, triggering scope finalization (supervisor.stop, WS close, etc).
      const envWithShutdown = {
        ...env,
        shutdown: () => {
          interruptMain()
        },
      }

      yield* Effect.promise(() =>
        render(() => (
          <EnvProvider env={envWithShutdown}>
            <WorkspaceProvider cwd={cwd} home={home} services={uiServices}>
              <RegistryProvider services={uiServices} maxEntries={ATOM_CACHE_MAX}>
                <ClientProvider
                  client={bundle.client}
                  runtime={bundle.runtime}
                  log={log}
                  initialSession={bootstrap.initialSession}
                  initialAgent={initialAgent}
                >
                  <ExtensionUIProvider>
                    <RouterProvider initialRoute={bootstrap.initialRoute}>
                      <App debugMode={debug} missingAuthProviders={missingAuth} />
                    </RouterProvider>
                  </ExtensionUIProvider>
                </ClientProvider>
              </RegistryProvider>
            </WorkspaceProvider>
          </EnvProvider>
        )),
      )
      // Block until interrupted. Fiber interrupt from env.shutdown() breaks
      // Layer.launch's Effect.never, triggering scope finalization.
      return yield* Effect.never.pipe(
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
        const date = DateTime.formatIso(DateTime.makeUnsafe(s.updatedAt))
        yield* Console.log(`  ${s.id} - ${s.name ?? "Unnamed"} (${date})`)
      }
    }),
)

// Server status subcommand
const serverStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const home = Option.getOrElse(yield* Config.option(Config.string("HOME")), () => "/tmp")
    const entries = listRegistryEntries(home)

    if (entries.length === 0) {
      yield* Console.log("No registered servers.")
      return
    }

    yield* Console.log("Registered servers:\n")
    yield* Console.log(
      `${"PID".padEnd(8)} ${"STATUS".padEnd(10)} ${"SERVER ID".padEnd(40)} ${"DB PATH".padEnd(40)} ${"URL"}`,
    )
    yield* Console.log("─".repeat(120))

    for (const entry of entries) {
      const validation = validateRegistryEntry(entry)
      const status = validation.valid ? "alive" : `dead (${validation.reason})`
      yield* Console.log(
        `${String(entry.pid).padEnd(8)} ${status.padEnd(10)} ${entry.serverId.padEnd(40)} ${entry.dbPath.padEnd(40)} ${entry.rpcUrl}`,
      )
    }
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
      const thisHost = getLocalHostname()
      const entries = listRegistryEntries(home)

      if (entries.length === 0) {
        yield* Console.log("No registered servers.")
        return
      }

      // Only consider entries on this host — never signal cross-host PIDs
      const localEntries = entries.filter((e) => e.hostname === thisHost)
      const toStop = all ? localEntries : localEntries.filter((e) => isPidAlive(e.pid))

      if (toStop.length === 0) {
        yield* Console.log("No live servers to stop on this host.")
        return
      }

      // Signal all targets
      for (const entry of toStop) {
        if (isPidAlive(entry.pid)) {
          yield* Effect.try({
            try: () => process.kill(entry.pid, "SIGTERM"),
            catch: () => new ServerSignalError({ pid: entry.pid, serverId: entry.serverId }),
          }).pipe(
            Effect.andThen(Console.log(`Sent SIGTERM to PID ${entry.pid} (${entry.serverId})`)),
            Effect.catchTag("ServerSignalError", (e) =>
              Console.log(`Failed to signal PID ${e.pid} (${e.serverId})`),
            ),
          )
        }
      }

      // Wait for processes to exit, then cleanup registry
      yield* Effect.sleep("2 seconds")

      let stillAlive = 0
      for (const entry of toStop) {
        if (isPidAlive(entry.pid)) {
          stillAlive++
        } else {
          removeRegistryEntry(home, entry.dbPath, entry.serverId)
        }
      }

      if (stillAlive > 0) {
        yield* Console.log(`\n${stillAlive} server(s) still running after SIGTERM.`)
      } else {
        yield* Console.log(`\nAll ${toStop.length} server(s) stopped and cleaned up.`)
      }
    }),
)

// Server subcommand group
const server = Command.make("server", {}, () =>
  Console.log("Usage: gent server <status|stop>"),
).pipe(Command.withSubcommands([serverStatus, serverStop]))

// Root command with subcommands
const command = main.pipe(
  Command.withSubcommands([sessions, server]),
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

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
runCliMain(Effect.scoped(mainEffect) as Effect.Effect<void>, { teardown: gracefulCliTeardown })
