#!/usr/bin/env bun
import { Command, Flag, Argument } from "effect/unstable/cli"
import { BunFileSystem, BunServices, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Fiber, Layer, Logger, Option, Schema, Tracer } from "effect"
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
import { resolveAppBootstrap, resolveInitialState, resolveStartupAuthState } from "./app-bootstrap"
import { runHeadless } from "./headless-runner"
import { Gent } from "@gent/sdk"

// Clear client log on startup
clearClientLog()

const formatMissingProviders = (providers: readonly ProviderId[]): string =>
  providers.map((provider) => provider).join(", ")

const ATOM_CACHE_MAX = 256

// Platform layer
const PlatformLayer = Layer.merge(BunServices.layer, BunFileSystem.layer)

const LinkLayer = Layer.provide(LinkOpener.Live, OsService.Live)

const makeUiLayer = () => Layer.mergeAll(PlatformLayer, LinkLayer)

// Main command - launches TUI or runs headless
const main = Command.make(
  "gent",
  {
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
  ({ session, continue_, headless, debug, prompt, promptArg, agent }) =>
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

      const bundle = yield* Gent.spawn({ cwd, mode: debug ? "debug" : "default" })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => shutdownLog("shutdown.finalizer.post-spawn")),
      )
      const requestedAgent: AgentName | undefined =
        Option.isSome(agent) && Schema.is(AgentNameSchema)(agent.value) ? agent.value : undefined

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

      if (missingProviders.length > 0 && headless && !debug) {
        const hint = formatMissingProviders(missingProviders)
        yield* Console.error(`Error: missing required API keys: ${hint}`)
        return yield* Effect.die(hint)
      }

      if (state._tag === "headless") {
        const branchId = state.session.branchId
        if (branchId === undefined) {
          yield* Console.error("Error: session has no branch")
          return yield* Effect.die("session has no branch")
        }
        const traceIdOpt = yield* Config.option(Config.string("GENT_TRACE_ID"))
        const parentSpanIdOpt = yield* Config.option(Config.string("GENT_PARENT_SPAN_ID"))
        const parentSpan =
          Option.isSome(traceIdOpt) && Option.isSome(parentSpanIdOpt)
            ? Tracer.externalSpan({
                traceId: traceIdOpt.value,
                spanId: parentSpanIdOpt.value,
                sampled: true,
              })
            : undefined
        const agentOverride = Option.getOrUndefined(agent)
        yield* runHeadless(
          bundle.client,
          state.session.id,
          branchId,
          state.prompt,
          agentOverride,
        ).pipe(
          Effect.withSpan("Headless.run"),
          parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
        )
        return
      }
      const bootstrap = resolveAppBootstrap(state, {
        missingProviders: missingProviders as readonly ProviderId[],
        debugMode: debug,
      })

      // Shutdown signal — interrupt the main fiber to break out of Layer.launch's
      // Effect.never, triggering scope finalization (supervisor.stop, WS close, etc).
      let mainFiber: Fiber.Fiber<unknown, unknown> | undefined
      yield* Effect.withFiber((fiber) =>
        Effect.sync(() => {
          mainFiber = fiber
        }),
      )
      const mainServices = yield* Effect.services<never>()
      const envWithShutdown = {
        ...env,
        shutdown: () => {
          shutdownLog("shutdown.interrupt-fiber")
          if (mainFiber !== undefined) {
            Effect.runForkWith(mainServices)(Fiber.interrupt(mainFiber))
          }
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
                  initialSession={bootstrap.initialSession}
                  initialAgent={startupAuth.initialAgent}
                >
                  <ExtensionUIProvider>
                    <RouterProvider initialRoute={bootstrap.initialRoute}>
                      <App
                        missingAuthProviders={bootstrap.missingAuthProviders}
                        debugMode={bootstrap.debugMode}
                      />
                    </RouterProvider>
                  </ExtensionUIProvider>
                </ClientProvider>
              </RegistryProvider>
            </WorkspaceProvider>
          </EnvProvider>
        )),
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => shutdownLog("shutdown.finalizer.post-render")),
      )

      yield* Effect.addFinalizer(() => Effect.sync(() => shutdownLog("shutdown.finalizer.first")))

      // Block until interrupted. Fiber interrupt from env.shutdown() breaks
      // Layer.launch's Effect.never, triggering scope finalization.
      return yield* Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            shutdownLog("shutdown.interrupted")
            // Safety: if scope finalizers hang, force exit after 3s.
            const watchdog = setTimeout(() => {
              shutdownLog("shutdown.watchdog-fired")
              process.exit(0)
            }, 3_000)
            if (typeof watchdog === "object" && "unref" in watchdog) watchdog.unref()
          }),
        ),
      )
    }),
)

// Sessions subcommand
const sessions = Command.make("sessions", {}, () =>
  Effect.gen(function* () {
    const bundle = yield* Gent.spawn({ cwd: process.cwd() })
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
})

const CliLayer = Layer.effectDiscard(cli)
const TraceLoggerLayer = Layer.unwrap(
  makeClientTraceLogger().pipe(Effect.map((logger) => Logger.layer([logger]))),
)
const MainLayer = CliLayer.pipe(
  Layer.provide(PlatformLayer),
  Layer.provide(Layer.provide(TraceLoggerLayer, PlatformLayer)),
)
BunRuntime.runMain(Effect.scoped(Layer.launch(MainLayer)))
