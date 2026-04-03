#!/usr/bin/env bun
import { Command, Flag, Argument } from "effect/unstable/cli"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import {
  Cause,
  Config,
  Console,
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
import type { ServiceMap } from "effect"
import { RegistryProvider } from "./atom-solid/solid"
import { LinkOpener } from "@gent/core/domain/link-opener.js"
import { OsService } from "@gent/core/domain/os-service.js"
import type { ProviderId } from "@gent/core/domain/model.js"
import { AgentName as AgentNameSchema, type AgentName } from "@gent/core/domain/agent.js"

import { render } from "@opentui/solid"
import { App } from "./app"
import { ClientProvider } from "./client/index"
import { RouterProvider } from "./router/index"
import { WorkspaceProvider } from "./workspace/index"
import { EnvProvider } from "./env/context"
import { ExtensionUIProvider } from "./extensions/context"
import { clearClientLog, createClientLog, shutdownLog } from "./utils/client-logger"
import { resolveInitialState, resolveStartupAuthState, type InitialState } from "./app-bootstrap"
import { runHeadless } from "./headless-runner"
import { Gent, type GentClientBundle } from "@gent/sdk"

// Clear client log on startup
clearClientLog()

const formatMissingProviders = (providers: readonly ProviderId[]): string =>
  providers.map((provider) => provider).join(", ")

const ATOM_CACHE_MAX = 256

// Platform layer
const PlatformLayer = Layer.merge(BunServices.layer, BunFileSystem.layer)

const LinkLayer = Layer.provide(LinkOpener.Live, OsService.Live)

const makeUiLayer = () => Layer.mergeAll(PlatformLayer, LinkLayer)

const parsePersistenceMode = (value: string | undefined): "disk" | "memory" | undefined => {
  if (value === "memory") return "memory"
  if (value === "disk") return "disk"
  return undefined
}

const parseProviderMode = (
  value: string | undefined,
): "live" | "debug-scripted" | "debug-failing" | "debug-slow" | undefined => {
  if (value === "debug-scripted") return "debug-scripted"
  if (value === "debug-failing") return "debug-failing"
  if (value === "debug-slow") return "debug-slow"
  if (value === "live") return "live"
  return undefined
}

const resolveLocalOptions = (cwd: string) =>
  Effect.gen(function* () {
    const homeOpt = yield* Config.option(Config.string("HOME"))
    const shellOpt = yield* Config.option(Config.string("SHELL"))
    const dataDirOpt = yield* Config.option(Config.string("GENT_DATA_DIR"))
    const dbPathOpt = yield* Config.option(Config.string("GENT_DB_PATH"))
    const authFilePathOpt = yield* Config.option(Config.string("GENT_AUTH_FILE_PATH"))
    const authKeyPathOpt = yield* Config.option(Config.string("GENT_AUTH_KEY_PATH"))
    const persistenceModeOpt = yield* Config.option(Config.string("GENT_PERSISTENCE_MODE"))
    const providerModeOpt = yield* Config.option(Config.string("GENT_PROVIDER_MODE"))

    const persistenceMode = parsePersistenceMode(Option.getOrUndefined(persistenceModeOpt))
    const providerMode = parseProviderMode(Option.getOrUndefined(providerModeOpt))

    return {
      cwd,
      scheduledJobCommand: resolveScheduledJobCommand(),
      ...(Option.isSome(homeOpt) ? { home: homeOpt.value } : {}),
      ...(Option.isSome(shellOpt) ? { shell: shellOpt.value } : {}),
      ...(Option.isSome(dataDirOpt) ? { dataDir: dataDirOpt.value } : {}),
      ...(Option.isSome(dbPathOpt) ? { dbPath: dbPathOpt.value } : {}),
      ...(Option.isSome(authFilePathOpt) ? { authFilePath: authFilePathOpt.value } : {}),
      ...(Option.isSome(authKeyPathOpt) ? { authKeyPath: authKeyPathOpt.value } : {}),
      ...(persistenceMode !== undefined ? { persistenceMode } : {}),
      ...(providerMode !== undefined ? { providerMode } : {}),
    }
  })

const resolveScheduledJobCommand = (): readonly [string, ...ReadonlyArray<string>] => {
  const runtimePath = process.execPath
  const mainEntry = typeof Bun !== "undefined" ? Bun.main : undefined
  if (
    mainEntry !== undefined &&
    mainEntry.length > 0 &&
    (mainEntry.endsWith(".ts") ||
      mainEntry.endsWith(".tsx") ||
      mainEntry.endsWith(".js") ||
      mainEntry.endsWith(".mjs"))
  ) {
    return [runtimePath, mainEntry]
  }
  return [runtimePath]
}

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
) =>
  Effect.gen(function* () {
    const branchId = state.session.branchId
    if (branchId === undefined) {
      yield* Console.error("Error: session has no branch")
      return yield* Effect.die("session has no branch")
    }

    const parentSpan = yield* resolveParentSpan()

    yield* runHeadless(
      bundle.client,
      state.session.id,
      branchId,
      state.prompt,
      Option.getOrUndefined(agent),
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
  },
  ({ connect, session, continue_, headless, debug, prompt, promptArg, agent }) =>
    Effect.gen(function* () {
      const cwd = process.cwd()
      const scope = yield* Effect.scope
      const uiServices = (yield* Layer.buildWithScope(
        makeUiLayer(),
        scope,
      )) as ServiceMap.ServiceMap<unknown>
      const visualOpt = yield* Config.option(Config.string("VISUAL"))
      const editorOpt = yield* Config.option(Config.string("EDITOR"))
      const env = {
        visual: Option.getOrUndefined(visualOpt),
        editor: Option.getOrUndefined(editorOpt),
      }

      // Create Effect-backed logger from captured services
      const logServices = yield* Effect.services<never>()
      const log = createClientLog(logServices as ServiceMap.ServiceMap<unknown>)
      let mainFiber: Fiber.Fiber<unknown, unknown> | undefined
      yield* Effect.withFiber((fiber) =>
        Effect.sync(() => {
          mainFiber = fiber
        }),
      )
      const mainServices = yield* Effect.services<never>()
      const interruptMain = () => {
        shutdownLog("shutdown.interrupt-fiber")
        if (mainFiber !== undefined) {
          Effect.runForkWith(mainServices)(Fiber.interrupt(mainFiber))
        }
      }

      const localOptions = yield* resolveLocalOptions(cwd).pipe(
        Effect.map((options) =>
          debug
            ? {
                ...options,
                persistenceMode: "memory" as const,
                providerMode: "debug-scripted" as const,
              }
            : options,
        ),
      )

      const bundle = yield* Option.isSome(connect)
        ? Gent.connect({ url: connect.value })
        : Gent.local(localOptions)
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

        yield* runHeadlessTurn(bundle, state, agent)
        return
      }

      // Shutdown signal — interrupt the main fiber to break out of Layer.launch's
      // Effect.never, triggering scope finalization (supervisor.stop, WS close, etc).
      const envWithShutdown = {
        ...env,
        shutdown: () => {
          interruptMain()
        },
      }

      yield* Effect.sync(() =>
        render(() => (
          <EnvProvider env={envWithShutdown}>
            <WorkspaceProvider cwd={cwd} services={uiServices}>
              <RegistryProvider services={uiServices} maxEntries={ATOM_CACHE_MAX}>
                <ClientProvider
                  client={bundle.client}
                  runtime={bundle.runtime}
                  log={log}
                  initialSession={undefined}
                  initialAgent={undefined}
                >
                  <ExtensionUIProvider>
                    <RouterProvider initialRoute={{ _tag: "loading" }}>
                      <App
                        debugMode={debug}
                        startup={{
                          cwd,
                          sessionId: Option.getOrUndefined(session),
                          continue_: continue_ || debug,
                          prompt: Option.getOrUndefined(prompt),
                        }}
                      />
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
  },
  ({ connect }) =>
    Effect.gen(function* () {
      const bundle = yield* Option.isSome(connect)
        ? Gent.connect({ url: connect.value })
        : resolveLocalOptions(process.cwd()).pipe(Effect.flatMap((options) => Gent.local(options)))
      yield* bundle.runtime.lifecycle.waitForReady
      const allSessions = yield* bundle.client.session.list()

      if (allSessions.length === 0) {
        yield* Console.log("No sessions found.")
        return
      }

      yield* Console.log("Sessions:")
      for (const s of allSessions) {
        // @effect-diagnostics-next-line *:off
        const date = new Date(s.updatedAt).toISOString()
        yield* Console.log(`  ${s.id} - ${s.name ?? "Unnamed"} (${date})`)
      }
    }),
)

// Root command with subcommands
const command = main.pipe(
  Command.withSubcommands([sessions]),
  Command.withDescription("Gent - minimal, opinionated agent harness"),
)

// CLI
const cli = Command.run(command, {
  version: "0.0.0",
}).pipe(Effect.provide(PlatformLayer))
const TraceLoggerLayer = Layer.unwrap(
  makeClientTraceLogger().pipe(Effect.map((logger) => Logger.layer([logger]))),
)
const mainEffect = cli.pipe(Effect.provide(Layer.provide(TraceLoggerLayer, PlatformLayer)))

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

runCliMain(Effect.scoped(mainEffect), { teardown: gracefulCliTeardown })
