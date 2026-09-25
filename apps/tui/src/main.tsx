#!/usr/bin/env bun
import { Command, Flag, Argument } from "effect/unstable/cli"
import { BunPlatformLive } from "@gent/core/host"
import {
  Config,
  Context,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Predicate,
  Record,
  Runtime,
  Scope,
} from "effect"
import {
  clearClientLog,
  ClientProvider,
  clientTraceLogger,
  createClientLog,
  shutdownLog,
} from "./client"
import { LinkOpener, OsService } from "./os"
import { AgentName, GentConnectionError } from "@gent/core/protocol"

import { render } from "@opentui/solid"
import { createCliRenderer, type CliRenderer } from "@opentui/core"
import {
  App,
  AppBootstrapError,
  type InitialState,
  resolveInitialState,
  resolveInteractiveBootstrap,
  resolveHeadlessMissingProviders,
} from "./app"
import { TerminalDimensionsProvider } from "./terminal"
import { ComposerMemoryProvider } from "./session"
import { detectColorScheme } from "./theme"
import { EnvProvider, WorkspaceProvider } from "./workspace"
import { ExtensionUIProvider } from "./extensions/host"
import { type ExitSignal, type HeadlessOptions, makeCliTeardown, runHeadless } from "./headless"
import { type GentClientBundle } from "@gent/sdk"
import {
  CliStartupError,
  reportFailureOnStderr,
  doctor,
  readHome,
  resolveClientBundle,
  server,
  sessions,
  storage,
} from "./ops"

// Clear client log on startup
clearClientLog()

const waitForRendererDestroy = (renderer: CliRenderer) =>
  Effect.callback<void>((resume) => {
    let settled = false
    // @effect-diagnostics-next-line globalTimersInEffect:off -- process lifetime handle: OpenTUI render resolves after mount and suspended Effect fibers do not keep Bun alive
    const keepAlive = setInterval(() => {}, 60_000) // eslint-disable-line effect/noGlobals -- OpenTUI needs a process-lifetime handle until renderer destruction.
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

const runHeadlessTurn = (
  bundle: GentClientBundle,
  state: Extract<InitialState, { readonly _tag: "headless" }>,
  options: HeadlessOptions,
) => {
  const branchId = Option.fromNullishOr(state.session.activeBranchId)
  if (Option.isNone(branchId)) {
    return Effect.fail(
      new AppBootstrapError({ sessionId: state.session.id, reason: "missing-branch" }),
    )
  }

  const resolvedBranchId = branchId.value

  return Effect.gen(function* () {
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
      resolvedBranchId,
      state.prompt,
      options,
    ).pipe(Effect.withSpan("Headless.run"))
  })
}

// The inputs the TUI/headless entry takes. `resume` reuses them.
const gentFlags = {
  connect: Flag.string("connect").pipe(
    Flag.withDescription("Connect to an existing gent server"),
    Flag.optional,
  ),
  session: Flag.string("session").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Session ID to continue"),
    Flag.optional,
  ),
  headless: Flag.boolean("headless").pipe(
    Flag.withAlias("H"),
    Flag.withDescription("Run in headless mode (no TUI, streams to stdout)"),
    Flag.withDefault(false),
  ),
  isolate: Flag.boolean("isolate").pipe(
    Flag.withDescription("Keep state in memory: no data-directory database or lock"),
    Flag.withDefault(false),
  ),
  debug: Flag.boolean("debug").pipe(
    Flag.withDescription("Launch TUI renderer playground for widgets and tool renderers"),
    Flag.withDefault(false),
  ),
  mockEmpty: Flag.boolean("mock-empty").pipe(
    Flag.withDescription(
      "Run against a model that answers nothing, to exercise the unanswered turn",
    ),
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
    Flag.withDescription("Agent for the new headless session (-H only; default: main)"),
    Flag.optional,
  ),
  approveAll: Flag.boolean("approve-all").pipe(
    Flag.withDescription(
      "Approve every ask of the headless turn (-H only; default: decline, as no user is present)",
    ),
    Flag.withDefault(false),
  ),
}

/**
 * Launch the TUI, or run one headless turn.
 *
 * `gent` and `gent resume` differ only in how they name the session to open, so
 * they share this body: `resume` fills `session` from its argument, or asks for
 * the last session in this directory when given none.
 */
const runGent = ({
  connect,
  session,
  continue_,
  isolate,
  headless,
  debug,
  mockEmpty,
  prompt,
  promptArg,
  agent,
  approveAll,
}: {
  readonly connect: Option.Option<string>
  readonly session: Option.Option<string>
  readonly continue_: boolean
  readonly isolate: boolean
  readonly headless: boolean
  readonly debug: boolean
  readonly mockEmpty: boolean
  readonly prompt: Option.Option<string>
  readonly promptArg: Option.Option<string>
  readonly agent: Option.Option<string>
  readonly approveAll: boolean
}) =>
  Effect.gen(function* () {
    // The server checks the name against its roster when the session starts.
    const requestedAgent = Option.map(agent, (name) => AgentName.make(name))
    // The TUI starts sessions from the composer, which names no agent, so a
    // flag it cannot honour fails here instead of being dropped.
    if (Option.isSome(requestedAgent) && !headless) {
      return yield* new CliStartupError({
        message: "--agent applies to headless mode; add -H with a prompt",
      })
    }
    if (approveAll && !headless) {
      return yield* new CliStartupError({
        message: "--approve-all applies to headless mode; add -H with a prompt",
      })
    }

    // Marked before anything slow runs: a signal while the bundle resolves
    // (it can start a server) still exits the way a headless run does.
    if (headless) {
      yield* Effect.sync(() => {
        cliRun.headless = true
      })
    }

    const cwd = process.cwd()
    const home = yield* readHome
    const scope = yield* Effect.scope
    const builtUiServices = yield* Layer.buildWithScope(makeUiLayer(), scope)
    const uiServices = Context.makeUnsafe<unknown>(builtUiServices.mapUnsafe)
    const visualOpt = yield* Config.option(Config.string("VISUAL"))
    const editorOpt = yield* Config.option(Config.string("EDITOR"))
    const authDirectoryOpt = yield* Config.option(Config.string("GENT_AUTH_DIRECTORY"))
    const env = {
      visual: visualOpt,
      editor: editorOpt,
    }

    // Create Effect-backed logger from captured services
    const logServices = yield* Effect.context<never>()
    const log = createClientLog(Context.makeUnsafe<unknown>(logServices.mapUnsafe))
    let mainFiber: Option.Option<Fiber.Fiber<unknown, unknown>> = Option.none()
    yield* Effect.withFiber((fiber) =>
      Effect.sync(() => {
        mainFiber = Option.some(fiber)
      }),
    )
    const mainServices = yield* Effect.context<never>()
    const interruptMain = () => {
      shutdownLog("shutdown.interrupt-fiber")
      if (Option.isSome(mainFiber)) {
        Effect.runForkWith(mainServices)(Fiber.interrupt(mainFiber.value))
      }
    }

    let mock = Option.none<{ readonly empty: boolean }>()
    if (debug) mock = Option.some({ empty: false })
    if (mockEmpty) mock = Option.some({ empty: true })
    const bundle = yield* resolveClientBundle({
      cwd,
      connect,
      inMemory: debug || isolate || mockEmpty,
      debug,
      mock,
      authDirectory: authDirectoryOpt,
    })
    if (headless) {
      // The agent is a session property: the flag shapes a new session only.
      if (Option.isSome(requestedAgent) && Option.isSome(session)) {
        return yield* new CliStartupError({
          message: "--agent applies to a new session; drop --session to use it",
        })
      }
      yield* bundle.runtime.lifecycle.waitForReady
      const state = yield* resolveInitialState({
        client: bundle.client,
        cwd,
        session,
        continue_: continue_ || debug,
        headless,
        prompt,
        promptArg,
        // No flag, no admission: the session stores none rather than `{}`.
        ...Record.filter(
          {
            admission: Option.getOrUndefined(
              Option.map(requestedAgent, (name) => ({ agent: name })),
            ),
          },
          Predicate.isNotUndefined,
        ),
      })

      if (state._tag !== "headless") {
        return yield* new CliStartupError({
          message: "headless startup resolved an interactive state",
        })
      }

      const missingProviders = yield* resolveHeadlessMissingProviders({
        client: bundle.client,
        state,
      })

      if (missingProviders.length > 0 && !debug && !Option.isSome(connect)) {
        return yield* new CliStartupError({
          message: `missing required API keys: ${missingProviders.join(", ")}`,
        })
      }

      yield* runHeadlessTurn(bundle, state, { approveAll })
      return
    }

    // Block until supervisor is ready (same as headless path)
    yield* bundle.runtime.lifecycle.waitForReady

    // Resolve the session and its agent before rendering — eliminates the loading route
    const { bootstrap, initialAgent } = yield* resolveInteractiveBootstrap({
      client: bundle.client,
      cwd,
      sessionId: Option.getOrUndefined(session),
      continue_: continue_ || debug,
      prompt: Option.getOrUndefined(prompt),
      debugMode: debug,
    })

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

    const uiScope = yield* Scope.Scope
    const renderer = yield* Effect.promise(() =>
      createCliRenderer({
        exitOnCtrlC: false,
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
              <ClientProvider
                client={bundle.client}
                runtime={bundle.runtime}
                services={uiServices}
                log={log}
                initialSession={bootstrap.initialSession}
                initialAgent={initialAgent}
              >
                <ExtensionUIProvider scope={uiScope}>
                  <TerminalDimensionsProvider>
                    <ComposerMemoryProvider
                      initialPrompt={bootstrap.initialPrompt}
                      initialSessionId={Option.map(
                        Option.fromNullishOr(bootstrap.initialSession),
                        (session) => session.sessionId,
                      )}
                    >
                      <App
                        debugMode={debug}
                        initialBranches={bootstrap.initialBranches}
                        initialThemeMode={initialThemeMode}
                      />
                    </ComposerMemoryProvider>
                  </TerminalDimensionsProvider>
                </ExtensionUIProvider>
              </ClientProvider>
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
  })

// Main command - launches TUI or runs headless
const main = Command.make("gent", gentFlags, (input) => runGent({ ...input, continue_: false }))

/**
 * Resume a conversation: `gent resume <id>`, or `gent resume` for the last
 * session in this directory.
 *
 * The session id is the only handle on a conversation once the TUI exits, so
 * the exit prints it. Naming one is the ordinary case; omitting it asks for the
 * most recent session in this directory.
 */
const resume = Command.make(
  "resume",
  {
    sessionId: Argument.string("session-id").pipe(
      Argument.withDescription("Session to resume (default: the last one in this directory)"),
      Argument.optional,
    ),
    connect: gentFlags.connect,
    isolate: gentFlags.isolate,
    prompt: gentFlags.prompt,
  },
  ({ sessionId, connect, isolate, prompt }) =>
    runGent({
      connect,
      session: sessionId,
      // No id names the last session in this directory.
      continue_: Option.isNone(sessionId),
      isolate,
      headless: false,
      debug: false,
      mockEmpty: false,
      prompt,
      promptArg: Option.none(),
      agent: Option.none(),
      approveAll: false,
    }),
)

// Root command with subcommands
const command = main.pipe(
  Command.withSubcommands([resume, sessions, server, doctor, storage]),
  Command.withDescription("Gent - minimal, opinionated agent harness"),
)

// CLI
const cli = Command.run(command, {
  version: "0.0.0",
})
const TraceLoggerLayer = Layer.unwrap(
  clientTraceLogger.pipe(Effect.map((logger) => Logger.layer([logger]))),
)
/**
 * The platform is built first, so a failure anywhere after it, the trace
 * logger included, is reported through the platform's stderr.
 */
const mainEffect = Effect.scoped(
  Effect.gen(function* () {
    const platformContext = yield* Layer.build(PlatformLayer)
    const platform = Context.makeUnsafe<unknown>(platformContext.mapUnsafe)
    const runCli = Effect.gen(function* () {
      const loggerContext = yield* Layer.build(TraceLoggerLayer)
      return yield* Effect.provideContext(
        cli,
        Context.merge(platform, Context.makeUnsafe<unknown>(loggerContext.mapUnsafe)),
      )
    })
    return yield* Effect.provideContext(reportFailureOnStderr(runCli), platform)
  }),
)

/**
 * What the teardown reads about the run: the signal that stopped it, and
 * whether it was a headless run. The process entry owns both.
 */
const cliRun = {
  signal: Option.none<ExitSignal>(),
  headless: false,
}

const runCliMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  let receivedSignal = false

  fiber.addObserver((exit) => {
    if (!receivedSignal) {
      process.removeListener("SIGINT", onSignal)
      process.removeListener("SIGTERM", onSignal)
    }
    teardown(exit, (code) => {
      // eslint-disable-next-line effect/noGlobals -- CLI teardown must return the process exit code.
      process.exit(code)
    })
  })

  function onSignal(signal: ExitSignal) {
    receivedSignal = true
    cliRun.signal = Option.some(signal)
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    fiber.interruptUnsafe(fiber.id)
  }

  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
})

runCliMain(mainEffect, {
  teardown: makeCliTeardown({ signal: () => cliRun.signal, headless: () => cliRun.headless }),
  disableErrorReporting: true,
})
