#!/usr/bin/env bun
import { Command, Flag, Argument } from "effect/unstable/cli"
import { BunPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"
import {
  Cause,
  Config,
  Console,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Runtime,
  Schema,
  Scope,
} from "effect"
import { clientTraceLogger } from "./utils/client-trace-logger"
import { LinkOpener } from "./services/link-opener"
import { OsService } from "./services/os-service"
import {
  RunSpecSchema,
  AgentName as AgentNameSchema,
  type AgentName,
  type ProviderId,
  type RunSpec,
} from "@gent/core/protocol"

import { render } from "@opentui/solid"
import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { App } from "./app"
import { TerminalDimensionsProvider } from "./terminal-dimensions"
import { ComposerDraftsProvider } from "./components/composer-drafts"
import { detectColorScheme } from "./theme"
import { ClientProvider } from "./client/index"
import { SessionShellProvider } from "./session-shell"
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
import { GentConnectionError, type GentClientBundle } from "@gent/sdk"
import { builtinClientModules } from "./extensions/builtins/index"
import { loadExtensionUi } from "./services/extension-context-boundary"
import { makeClientRuntime } from "./extensions/client-runtime"
import type { ClientRuntime } from "./extensions/client-facets.js"
import {
  CliStartupError,
  doctor,
  readHome,
  resolveClientBundle,
  server,
  sessions,
  storage,
} from "./ops/commands"

// Clear client log on startup
clearClientLog()

const formatMissingProviders = (providers: readonly ProviderId[]): string =>
  providers.map((provider) => provider).join(", ")

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
  cwd: string,
  home: string,
  agent: Option.Option<AgentName>,
  runSpec: Option.Option<RunSpec>,
) => {
  const branchId = Option.fromNullishOr(state.session.activeBranchId)
  if (Option.isNone(branchId)) {
    return Effect.gen(function* () {
      yield* Console.error("Error: session has no branch")
      return yield* new AppBootstrapError({
        sessionId: state.session.id,
        reason: "missing-branch",
      })
    })
  }

  const resolvedBranchId = branchId.value
  const clientRuntime: ClientRuntime = makeClientRuntime({
    transport: {
      client: bundle.client,
      runtime: bundle.runtime,
      currentSession: () => ({ sessionId: state.session.id, branchId: resolvedBranchId }),
      onExtensionStateChanged: () => () => {},
      onSessionEvent: () => () => {},
    },
    workspace: { cwd, home },
    shell: { run: bundle.runtime.run, cast: bundle.runtime.cast },
  })

  return Effect.gen(function* () {
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
      resolvedBranchId,
      state.prompt,
      Option.getOrUndefined(agent),
      Option.getOrUndefined(runSpec),
      toolRenderers,
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
    Flag.withDescription("Run with an in-process server (no shared server, no registry)"),
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
    Flag.withDescription("Agent to use for headless mode (default: main)"),
    Flag.optional,
  ),
  runSpec: Flag.string("run-spec").pipe(
    Flag.withDescription("JSON-encoded RunSpec (internal, used by subprocess runner)"),
    Flag.optional,
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
  runSpec: runSpecJson,
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
  readonly runSpec: Option.Option<string>
}) =>
  Effect.gen(function* () {
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
    const requestedAgent = Option.match(agent, {
      onNone: () => Option.none<AgentName>(),
      onSome: (value) => {
        if (!Schema.is(AgentNameSchema)(value)) return Option.none<AgentName>()
        return Option.some(value)
      },
    })

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
        requestedAgent: Option.getOrUndefined(requestedAgent),
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

      const decodedRunSpec = yield* Option.match(runSpecJson, {
        onNone: () => Effect.succeed(Option.none<RunSpec>()),
        onSome: (runSpec) =>
          Schema.decodeEffect(Schema.fromJsonString(RunSpecSchema))(runSpec).pipe(
            Effect.asSome,
            Effect.mapError(
              (e) => new CliStartupError({ message: `Invalid --run-spec: ${String(e)}`, cause: e }),
            ),
          ),
      })

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
                  <SessionShellProvider
                    initialPrompt={bootstrap.initialPrompt}
                    initialSessionId={Option.map(
                      Option.fromNullishOr(bootstrap.initialSession),
                      (session) => session.sessionId,
                    )}
                  >
                    <TerminalDimensionsProvider>
                      <ComposerDraftsProvider>
                        <App
                          debugMode={debug}
                          missingAuthProviders={missingAuth}
                          initialBranches={bootstrap.initialBranches}
                          initialThemeMode={initialThemeMode}
                        />
                      </ComposerDraftsProvider>
                    </TerminalDimensionsProvider>
                  </SessionShellProvider>
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
 * most recent session here, which is what `--continue` used to mean.
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
      runSpec: Option.none(),
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
const CliRuntimeLayer = Layer.merge(PlatformLayer, Layer.provide(TraceLoggerLayer, PlatformLayer))
const mainEffect = Effect.scoped(
  Effect.gen(function* () {
    const cliContext = yield* Layer.build(CliRuntimeLayer)
    return yield* Effect.provideContext(cli, Context.makeUnsafe<unknown>(cliContext.mapUnsafe))
  }),
)

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
      // eslint-disable-next-line effect/noGlobals -- CLI teardown must return the process exit code.
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
