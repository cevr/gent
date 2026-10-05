#!/usr/bin/env bun
import { Command, Flag, Argument } from "effect/cli"
import { ScriptedLanguageModel } from "@gent/core/host"
import { BunPlatformLive } from "@gent/core/host-bun"
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
} from "effect"
import {
  clearClientLog,
  ClientProvider,
  clientTraceLogger,
  createClientLog,
  shutdownLog,
} from "./client"
import { LinkOpener, makeHandover } from "./os"
import { AgentName, ModelId } from "@gent/core/protocol"

import { render } from "@opentui/solid"
import { createCliRenderer } from "@opentui/core"
import {
  App,
  AppBootstrapError,
  type HeadlessState,
  resolveHeadlessState,
  resolveInteractiveBootstrap,
  resolveHeadlessMissingSignIns,
} from "./app"
import { TerminalDimensionsProvider } from "./terminal"
import { holdUntilRendererDestroyed } from "./message-list"
import { SpinnerClockProvider } from "./ui"
import { ComposerMemoryProvider } from "./session"
import { detectColorScheme } from "./theme"
import { EnvProvider, WorkspaceProvider } from "./workspace"
import { ExtensionUIProvider } from "./extensions/host"
import {
  type ExitSignal,
  type HeadlessOptions,
  makeCliTeardown,
  runHeadless,
  waitForHeadlessReady,
} from "./headless"
import { type GentClientBundle } from "@gent/sdk"
import { version } from "../package.json"
import {
  CliStartupError,
  connectFlag,
  isolateFlag,
  reportFailureOnStderr,
  doctor,
  readHome,
  resolveClientBundle,
  resumableSessions,
  server,
  sessions,
  markVersionInUse,
  storage,
  upgrade,
} from "./ops"

// Clear client log on startup
clearClientLog()

// `BunPlatformLive` bundles `BunServices.layer` (FileSystem, Path,
// ChildProcessSpawner, …) with `BunGentPlatformLive`, so callers can yield
// `GentPlatform` alongside the standard primitives.
// `LinkOpener.Live` depends on `GentPlatform`, which
// `BunPlatformLive` provides. `Layer.mergeAll` builds in parallel, so use
// `provideMerge` to thread `GentPlatform` into the dependents while
// keeping it in the output context for downstream consumers.
const makeUiLayer = () => Layer.provideMerge(LinkOpener.Live, BunPlatformLive)

const runHeadlessTurn = (
  bundle: GentClientBundle,
  state: HeadlessState,
  options: HeadlessOptions,
) => {
  const branchId = Option.fromNullishOr(state.session.activeBranchId)
  if (Option.isNone(branchId)) {
    return Effect.fail(
      new AppBootstrapError({ sessionId: state.session.id, reason: "missing-branch" }),
    )
  }

  return runHeadless(bundle.client, state.session.id, branchId.value, state.prompt, options).pipe(
    Effect.withSpan("Headless.run"),
  )
}

// The inputs the TUI/headless entry takes. `resume` reuses them.
const gentFlags = {
  connect: connectFlag,
  session: Flag.String("session").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Session ID to continue"),
    Flag.optional,
  ),
  headless: Flag.Boolean("headless").pipe(
    Flag.withAlias("H"),
    Flag.withDescription("Run in headless mode (no TUI, streams to stdout)"),
    Flag.withDefault(false),
  ),
  isolate: isolateFlag,
  debug: Flag.Boolean("debug").pipe(
    Flag.withDescription(
      'Start an in-memory server with a seeded session on the scripted model, to exercise the TUI; a message with "debug tools" plays a multi-step tool turn, one with "debug ask" asks a background question, one with "debug threads" starts two threads, one with "debug handoff" asks for a handoff, and one with "debug think" thinks under a reasoning heading',
    ),
    Flag.withDefault(false),
  ),
  mockEmpty: Flag.Boolean("mock-empty").pipe(
    Flag.withDescription(
      "Run against a model that answers nothing, to exercise the unanswered turn",
    ),
    Flag.withDefault(false),
  ),
  prompt: Flag.String("prompt").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Initial prompt (TUI mode)"),
    Flag.optional,
  ),
  promptArg: Argument.String("prompt").pipe(
    Argument.withDescription("Prompt for headless mode"),
    Argument.optional,
  ),
  agent: Flag.String("agent").pipe(
    Flag.withAlias("a"),
    Flag.withDescription("Agent for the new headless session (-H only; default: main)"),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withAlias("m"),
    Flag.withDescription(
      "Model for the new headless session, as provider/model (-H only; default: the user's, `model` in ~/.gent/config.json)",
    ),
    Flag.optional,
  ),
  approveAll: Flag.Boolean("approve-all").pipe(
    Flag.withDescription(
      "Approve every ask of the headless turn (-H only; default: decline, as no user is present)",
    ),
    Flag.withDefault(false),
  ),
}

/**
 * The TUI starts sessions from the composer, which names no agent and asks
 * the reader, and takes its startup prompt from -p; the positional prompt is
 * headless input. A headless-only input the TUI cannot honour fails here
 * instead of being dropped.
 */
const refuseHeadlessInput = (given: {
  readonly agent: boolean
  readonly model: boolean
  readonly approveAll: boolean
  readonly promptArg: boolean
}): Effect.Effect<void, CliStartupError> => {
  const refusals: ReadonlyArray<readonly [boolean, string]> = [
    [given.agent, "--agent applies to headless mode; add -H with a prompt"],
    [
      given.model,
      "--model applies to headless mode; add -H with a prompt, or pick one with /model",
    ],
    [given.approveAll, "--approve-all applies to headless mode; add -H with a prompt"],
    [given.promptArg, "a prompt argument needs -H; use -p to start the TUI with a prompt"],
  ]
  return Option.match(Option.fromUndefinedOr(refusals.find(([isGiven]) => isGiven)), {
    onNone: () => Effect.void,
    onSome: ([, message]) => Effect.fail(new CliStartupError({ message })),
  })
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
  model,
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
  readonly model: Option.Option<string>
  readonly approveAll: boolean
}) =>
  Effect.gen(function* () {
    // The server checks the name against its roster when the session starts.
    const requestedAgent = Option.map(agent, (name) => AgentName.make(name))
    const requestedModel = Option.map(model, (id) => ModelId.make(id))
    if (!headless) {
      yield* refuseHeadlessInput({
        agent: Option.isSome(requestedAgent),
        model: Option.isSome(requestedModel),
        approveAll,
        promptArg: Option.isSome(promptArg),
      })
    }

    // Marked before anything slow runs: a signal while the bundle resolves
    // (it can start a server) already exits the way the chosen mode does.
    if (!headless) {
      yield* Effect.sync(() => {
        cliRun.interactive = true
      })
    }

    const cwd = process.cwd()
    const home = yield* readHome
    const scope = yield* Effect.scope
    const builtUiServices = yield* Layer.buildWithScope(makeUiLayer(), scope)
    const uiServices = Context.makeUnsafe<unknown>(builtUiServices.mapUnsafe)
    const visualOpt = yield* Config.option(Config.String("VISUAL"))
    const editorOpt = yield* Config.option(Config.String("EDITOR"))
    const authDirectoryOpt = yield* Config.option(Config.String("GENT_AUTH_DIRECTORY"))
    const env = {
      visual: visualOpt,
      editor: editorOpt,
    }

    // Create Effect-backed logger from captured services
    const mainServices = yield* Effect.context<never>()
    const log = createClientLog(Context.makeUnsafe<unknown>(mainServices.mapUnsafe))
    let mainFiber: Option.Option<Fiber.Fiber<unknown, unknown>> = Option.none()
    yield* Effect.withFiber((fiber) =>
      Effect.sync(() => {
        mainFiber = Option.some(fiber)
      }),
    )
    const interruptMain = () => {
      shutdownLog("shutdown.interrupt-fiber")
      if (Option.isSome(mainFiber)) {
        Effect.runForkWith(mainServices)(Fiber.interrupt(mainFiber.value))
      }
    }

    const inMemory = debug || isolate || mockEmpty
    let mock = Option.none<{ readonly empty: boolean }>()
    if (debug) mock = Option.some({ empty: false })
    if (mockEmpty) mock = Option.some({ empty: true })
    const bundle = yield* resolveClientBundle({
      cwd,
      connect,
      inMemory,
      debug,
      mock,
      authDirectory: authDirectoryOpt,
    })
    // A scripted model (`--debug`, `--mock-empty` on the server this run
    // starts) needs no sign-in, in headless and in the TUI alike.
    const { scriptedModel } = bundle
    if (headless) {
      // The agent is a session property: the flag shapes a new session only.
      if (Option.isSome(requestedAgent) && Option.isSome(session)) {
        return yield* new CliStartupError({
          message: "--agent applies to a new session; drop --session to use it",
        })
      }
      if (Option.isSome(requestedModel) && Option.isSome(session)) {
        return yield* new CliStartupError({
          message: "--model applies to a new session; drop --session to use it",
        })
      }
      yield* waitForHeadlessReady(bundle.runtime.lifecycle.waitForReady)
      const state = yield* resolveHeadlessState({
        client: bundle.client,
        cwd,
        session,
        promptArg,
        // No flag, no admission: the session stores none rather than `{}`.
        ...Record.filter(
          {
            admission: Option.getOrUndefined(
              Option.map(requestedAgent, (name) => ({ agent: name })),
            ),
            // A scripted server's model is the explicit one when no flag names another.
            modelId: Option.getOrUndefined(
              Option.orElse(requestedModel, () =>
                Option.liftPredicate(ScriptedLanguageModel.modelId, () => scriptedModel),
              ),
            ),
          },
          Predicate.isNotUndefined,
        ),
      })

      const missingSignIns = yield* resolveHeadlessMissingSignIns({
        client: bundle.client,
        state,
      })

      if (missingSignIns.length > 0 && !scriptedModel && Option.isNone(connect)) {
        return yield* new CliStartupError({
          message: `missing required sign-ins: ${missingSignIns.join(", ")}`,
        })
      }

      // Tool paths read from the session's own cwd, as the TUI spells them.
      const place = {
        cwd: Option.getOrElse(Option.fromNullishOr(state.session.cwd), () => cwd),
        home,
      }
      yield* runHeadlessTurn(bundle, state, { approveAll, place })
      return
    }

    // Wait for the connection to be ready, as the headless path does.
    yield* bundle.runtime.lifecycle.waitForReady

    // Resolve the session before rendering — eliminates the loading route
    const bootstrap = yield* resolveInteractiveBootstrap({
      client: bundle.client,
      cwd,
      sessionId: Option.getOrUndefined(session),
      continue_: continue_ || debug,
      prompt: Option.getOrUndefined(prompt),
    })

    // Resolve the terminal color scheme once before render so theme detection
    // never runs in the synchronous Solid render path.
    const initialThemeMode = yield* detectColorScheme

    // Shutdown interrupts the main fiber. Its scope then closes the renderer
    // hold, the client and the in-process server this run started.
    const envWithShutdown = {
      ...env,
      shutdown: () => {
        interruptMain()
      },
      resumable: resumableSessions({ connect, inMemory }),
      writeTerminal: (text: string) => {
        // eslint-disable-next-line effect/noGlobals -- The line must reach the real terminal after the renderer is destroyed, outside any Effect.
        process.stdout.write(text)
      },
    }

    const renderer = yield* Effect.promise(() =>
      createCliRenderer({
        exitOnCtrlC: false,
        // The session view's native transcript mode from the first frame: the
        // terminal is set up once, not in the alternate screen and then again.
        screenMode: "split-footer",
        externalOutputMode: "capture-stdout",
        useMouse: false,
        // Exit clears the split region only: the transcript above it stays
        // on screen, and the shell prompt follows.
        clearOnShutdown: false,
        // SIGINT, SIGTERM and SIGHUP are the process entry's (`runCliMain`): they
        // interrupt the main fiber, whose hold on the renderer commits the
        // live tail before it destroys the renderer. OpenTUI's own listener
        // would destroy it first and clear the transcript. It keeps the
        // signals gent does not handle, so they still restore the terminal.
        exitSignals: ["SIGQUIT", "SIGABRT", "SIGPIPE", "SIGBUS"],
        onDestroy: () => {
          shutdownLog("exit.renderer-destroy")
        },
      }),
    )
    // The terminal's holder lives with the renderer it suspends: gent's exit
    // ends its handovers before it leaves the terminal.
    const terminal = makeHandover({
      suspend: () => renderer.suspend(),
      resume: () => renderer.resume(),
    })
    yield* Effect.promise(() =>
      render(
        () => (
          <EnvProvider env={envWithShutdown}>
            <WorkspaceProvider cwd={cwd} home={home}>
              <ClientProvider
                client={bundle.client}
                runtime={bundle.runtime}
                services={uiServices}
                log={log}
                initialSession={bootstrap.initialSession}
              >
                <ExtensionUIProvider scope={scope} handover={terminal.handover}>
                  <TerminalDimensionsProvider>
                    <SpinnerClockProvider>
                      <ComposerMemoryProvider
                        initialPrompt={bootstrap.initialPrompt}
                        initialSessionId={Option.some(bootstrap.initialSession.sessionId)}
                      >
                        <App
                          debugMode={debug}
                          scriptedModel={scriptedModel}
                          initialBranches={bootstrap.initialBranches}
                          initialThemeMode={initialThemeMode}
                        />
                      </ComposerMemoryProvider>
                    </SpinnerClockProvider>
                  </TerminalDimensionsProvider>
                </ExtensionUIProvider>
              </ClientProvider>
            </WorkspaceProvider>
          </EnvProvider>
        ),
        renderer,
      ),
    )
    // Keep a real process handle open until the renderer is destroyed. A
    // signal leaves the terminal as the reader's exit does: the live view's
    // last items reach history before the renderer goes.
    return yield* holdUntilRendererDestroyed(
      renderer,
      envWithShutdown.writeTerminal,
      terminal.close,
    ).pipe(
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
    sessionId: Argument.String("session-id").pipe(
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
      model: Option.none(),
      approveAll: false,
    }),
)

// Root command with subcommands
const command = main.pipe(
  Command.withSubcommands([resume, sessions, server, doctor, storage, upgrade]),
  Command.withDescription("Gent - minimal, opinionated agent harness"),
)

// CLI. The version is the one apps/tui/package.json names: the release sets it
// there once, and the compiled build bundles the file.
const cli = Command.run(command, { version })
const TraceLoggerLayer = Layer.unwrap(
  clientTraceLogger.pipe(Effect.map((logger) => Logger.layer([logger]))),
)
/**
 * The platform is built first, so a failure anywhere after it, the trace
 * logger included, is reported through the platform's stderr.
 */
const mainEffect = Effect.scoped(
  Effect.gen(function* () {
    const platformContext = yield* Layer.build(BunPlatformLive)
    const platform = Context.makeUnsafe<unknown>(platformContext.mapUnsafe)
    const runCli = Effect.gen(function* () {
      // An installed gent marks its version in use until it exits, so an update keeps its pair.
      yield* markVersionInUse
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
 * whether it was the interactive TUI. The process entry owns both.
 */
const cliRun = {
  signal: Option.none<ExitSignal>(),
  interactive: false,
}

const runCliMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  let receivedSignal = false

  fiber.addObserver((exit) => {
    if (!receivedSignal) {
      process.removeListener("SIGINT", onSignal)
      process.removeListener("SIGTERM", onSignal)
      process.removeListener("SIGHUP", onSignal)
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
    process.removeListener("SIGHUP", onSignal)
    fiber.interruptUnsafe(fiber.id)
  }

  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  process.on("SIGHUP", onSignal)
})

runCliMain(mainEffect, {
  teardown: makeCliTeardown({
    signal: () => cliRun.signal,
    interactive: () => cliRun.interactive,
  }),
  disableErrorReporting: true,
})
