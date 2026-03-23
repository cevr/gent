#!/usr/bin/env bun
import { Command, Flag, Argument } from "effect/unstable/cli"
import { BunFileSystem, BunServices, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Option, Ref, Stream, Tracer } from "effect"
import { identity } from "effect/Function"
import type { ServiceMap } from "effect"
import { RegistryProvider } from "./atom-solid/solid"
import { createDependencies } from "@gent/core/server/index.js"
import { GentCore, type GentCoreError } from "@gent/core/server/core.js"
import { SessionQueries, type SessionQueriesService } from "@gent/core/server/session-queries.js"
import { SessionCommands, type SessionCommandsService } from "@gent/core/server/session-commands.js"
import { SessionEvents, type SessionEventsService } from "@gent/core/server/session-events.js"
import { InteractionCommands } from "@gent/core/server/interaction-commands.js"
import { makeDirectGentClient, type GentClient, type SessionInfo, type BranchInfo } from "@gent/sdk"
import { GentLogger } from "@gent/core/runtime/logger.js"
import { GentTracerLive, clearTraceLogIfRoot } from "@gent/core/runtime/tracer.js"
import { AuthGuard } from "@gent/core/domain/auth-guard.js"
import { LinkOpener } from "@gent/core/domain/link-opener.js"
import { OsService } from "@gent/core/domain/os-service.js"
import type { HandoffPresented } from "@gent/core/domain/event.js"
import type { ProviderId } from "@gent/core/domain/model.js"
import type { SessionId, BranchId } from "@gent/core/domain/ids.js"
import * as os from "node:os"

import { render } from "@opentui/solid"
import { App } from "./app"
import { ClientProvider, type Session } from "./client/index"
import { RouterProvider, Route } from "./router/index"
import { WorkspaceProvider } from "./workspace/index"
import { EnvProvider } from "./env/context"
import { clearClientLog } from "./utils/client-logger"
import { prepareDebugSession } from "@gent/core/debug/session.js"
import { joinPath } from "./platform/path-runtime"

// Clear client log on startup
clearClientLog()

// ============================================================================
// Initial State - discriminated union for clarity
// ============================================================================

type InitialState =
  | { _tag: "home" }
  | { _tag: "debug" }
  | { _tag: "session"; session: SessionInfo; prompt?: string }
  | {
      _tag: "branchPicker"
      session: SessionInfo
      branches: readonly BranchInfo[]
      prompt?: string
    }
  | { _tag: "headless"; session: SessionInfo; prompt: string }

// Pure function for state resolution
const resolveInitialState = (input: {
  queries: SessionQueriesService
  commands: Pick<SessionCommandsService, "createSession">
  cwd: string
  session: Option.Option<string>
  continue_: boolean
  headless: boolean
  debug: boolean
  prompt: Option.Option<string>
  promptArg: Option.Option<string>
  bypass: boolean
}): Effect.Effect<InitialState, GentCoreError> =>
  Effect.gen(function* () {
    const {
      queries,
      commands,
      cwd,
      session,
      continue_,
      headless,
      debug,
      prompt,
      promptArg,
      bypass,
    } = input

    if (debug) {
      return { _tag: "debug" as const }
    }

    // 1. Headless mode
    if (headless) {
      const promptText = Option.isSome(promptArg) ? promptArg.value : undefined
      if (promptText === undefined || promptText.length === 0) {
        yield* Console.error("Error: --headless requires a prompt argument")
        return process.exit(1)
      }
      // Get or create session
      if (Option.isSome(session)) {
        const sess = yield* queries.getSession(session.value as SessionId)
        if (sess === null) {
          yield* Console.error(`Error: session ${session.value} not found`)
          return process.exit(1)
        }
        return { _tag: "headless" as const, session: sess, prompt: promptText }
      }

      const result = yield* commands.createSession({ name: "headless session", cwd, bypass })
      const sess: SessionInfo = {
        id: result.sessionId,
        name: result.name,
        cwd,
        bypass: result.bypass,
        reasoningLevel: undefined,
        branchId: result.branchId,
        parentSessionId: undefined,
        parentBranchId: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      return { _tag: "headless" as const, session: sess, prompt: promptText }
    }

    // 2. Explicit session ID
    if (Option.isSome(session)) {
      const sess = yield* queries.getSession(session.value as SessionId)
      if (sess === null) {
        yield* Console.error(`Error: session ${session.value} not found`)
        return process.exit(1)
      }
      const promptText = Option.isSome(prompt) ? prompt.value : undefined
      const branches = yield* queries.listBranches(sess.id)
      if (branches.length > 1) {
        return {
          _tag: "branchPicker" as const,
          session: sess,
          branches,
          prompt: promptText,
        }
      }
      return { _tag: "session" as const, session: sess, prompt: promptText }
    }

    // 3. Continue from cwd
    if (continue_) {
      const sess: SessionInfo = yield* Effect.gen(function* () {
        const existing = yield* queries.getLastSessionByCwd(cwd)
        if (existing !== null) return existing

        const result = yield* commands.createSession({ cwd, bypass })
        return {
          id: result.sessionId,
          name: result.name,
          cwd,
          bypass: result.bypass,
          reasoningLevel: undefined,
          branchId: result.branchId,
          parentSessionId: undefined,
          parentBranchId: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      })
      const promptText = Option.isSome(prompt) ? prompt.value : undefined
      const branches = yield* queries.listBranches(sess.id)
      if (branches.length > 1) {
        return {
          _tag: "branchPicker" as const,
          session: sess,
          branches,
          prompt: promptText,
        }
      }
      return { _tag: "session" as const, session: sess, prompt: promptText }
    }

    // 4. Prompt without session - create new
    if (Option.isSome(prompt)) {
      const result = yield* commands.createSession({ cwd, bypass })
      const sess: SessionInfo = {
        id: result.sessionId,
        name: result.name,
        cwd,
        bypass: result.bypass,
        reasoningLevel: undefined,
        branchId: result.branchId,
        parentSessionId: undefined,
        parentBranchId: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      return { _tag: "session" as const, session: sess, prompt: prompt.value }
    }

    // 5. Home view
    return { _tag: "home" as const }
  })

const formatMissingProviders = (providers: readonly ProviderId[]): string =>
  providers.map((provider) => provider).join(", ")

const ATOM_CACHE_MAX = 256

// Platform layer
const PlatformLayer = Layer.merge(BunServices.layer, BunFileSystem.layer)

// Logger layer — pretty (stderr) + JSON (/tmp/gent.log)
const LoggerLayer = GentLogger

// Tracer layer — span tracing to /tmp/gent-trace.log
const TracerLayer = Layer.merge(GentTracerLive, clearTraceLogIfRoot)

const LinkLayer = Layer.provide(LinkOpener.Live, OsService.Live)

const makeCoreLayer = (options?: { cwd?: string; debug?: boolean }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cwd = options?.cwd ?? process.cwd()
      const homeOpt = yield* Config.option(Config.string("HOME"))
      const home = Option.getOrElse(homeOpt, () => os.homedir())
      const dataDirOpt = yield* Config.option(Config.string("GENT_DATA_DIR"))
      const dataDir = Option.getOrElse(dataDirOpt, () => joinPath(home, ".gent"))
      const dbPathOpt = yield* Config.option(Config.string("GENT_DB_PATH"))
      const dbPath = Option.getOrElse(dbPathOpt, () => joinPath(dataDir, "data.db"))
      const authFilePath = Option.isSome(dataDirOpt)
        ? joinPath(dataDir, "auth.json.enc")
        : undefined
      const authKeyPath = Option.isSome(dataDirOpt) ? joinPath(dataDir, "auth.key") : undefined

      const serverDeps = createDependencies({
        cwd,
        home,
        platform: process.platform,
        dbPath,
        persistenceMode: options?.debug === true ? "memory" : "disk",
        providerMode: options?.debug === true ? "debug-scripted" : "live",
        ...(authFilePath !== undefined ? { authFilePath } : {}),
        ...(authKeyPath !== undefined ? { authKeyPath } : {}),
      }).pipe(Layer.provide(PlatformLayer), Layer.provide(LoggerLayer), Layer.provide(TracerLayer))
      const gentCoreLive = GentCore.Live.pipe(Layer.provide(serverDeps))
      const coreLive = Layer.mergeAll(
        SessionQueries.Live,
        SessionCommands.Live,
        SessionEvents.Live,
        InteractionCommands.Live,
      ).pipe(Layer.provideMerge(gentCoreLive), Layer.provide(serverDeps))
      return Layer.mergeAll(coreLive, serverDeps, LinkLayer)
    }),
  )

// Headless runner - streams events to stdout
const runHeadless = (
  commands: SessionCommandsService,
  events: SessionEventsService,
  client: GentClient,
  sessionId: SessionId,
  branchId: BranchId,
  promptText: string,
): Effect.Effect<void, GentCoreError, never> =>
  Effect.gen(function* () {
    // Subscribe to events before sending message
    const eventStream = events.subscribeEvents({ sessionId, branchId })

    // Send the message
    yield* commands
      .sendMessage({ sessionId, branchId, content: promptText })
      .pipe(Effect.withSpan("Headless.sendMessage"))

    // Stream events until turn completes (with handoff support)
    // TurnCompleted fires before HandoffPresented, so we can't use simple takeUntil.
    // Track state with Refs for concurrency safety.
    const doneRef = yield* Ref.make(false)
    const handoffPendingRef = yield* Ref.make(false)

    yield* eventStream.pipe(
      Stream.tap((envelope) =>
        Effect.gen(function* () {
          const event = envelope.event
          switch (event._tag) {
            case "StreamChunk":
              process.stdout.write(event.chunk)
              break
            case "ToolCallStarted":
              process.stdout.write(`\n[tool: ${event.toolName}]\n`)
              break
            case "ToolCallCompleted":
              process.stdout.write(
                `[tool done: ${event.toolName}${event.isError ? " (error)" : ""}]\n`,
              )
              break
            case "ToolCallSucceeded":
              process.stdout.write(`[tool done: ${event.toolName}]\n`)
              break
            case "ToolCallFailed":
              process.stdout.write(`[tool done: ${event.toolName} (error)]\n`)
              break
            case "StreamEnded":
              process.stdout.write("\n")
              break
            case "ErrorOccurred":
              process.stderr.write(`\nError: ${event.error}\n`)
              yield* Ref.set(doneRef, true)
              break
            case "TurnCompleted":
              // Don't exit yet — handoff check runs after this in the agent loop
              break
            case "HandoffPresented": {
              yield* Ref.set(handoffPendingRef, true)
              const hp = event as typeof HandoffPresented.Type
              process.stdout.write(`\n[handoff: auto-confirming]\n`)
              yield* client
                .respondHandoff(hp.requestId, "confirm")
                .pipe(Effect.catchEager(() => Effect.void))
              break
            }
            case "HandoffConfirmed":
              yield* Ref.set(handoffPendingRef, false)
              yield* Ref.set(doneRef, true)
              break
            case "HandoffRejected":
              yield* Ref.set(handoffPendingRef, false)
              break
          }

          // After TurnCompleted, wait briefly for HandoffPresented to arrive
          if (event._tag === "TurnCompleted") {
            yield* Effect.sleep("50 millis")
            const pending = yield* Ref.get(handoffPendingRef)
            if (!pending) yield* Ref.set(doneRef, true)
          }
        }),
      ),
      Stream.takeUntilEffect(() => Ref.get(doneRef)),
      Stream.runDrain,
    )
  })

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
    bypass: Flag.boolean("bypass").pipe(
      Flag.withDescription("Auto-allow all tool calls (default: true, use --no-bypass to disable)"),
      Flag.withDefault(true),
    ),
  },
  ({ session, continue_, headless, debug, prompt, promptArg, bypass }) =>
    Effect.gen(function* () {
      // Get core service for direct access (headless, session management)
      const cwd = process.cwd()
      const runtimeLayer = makeCoreLayer({ cwd, debug })
      const scope = yield* Effect.scope
      const services = yield* Layer.buildWithScope(runtimeLayer, scope)

      return yield* Effect.promise(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const queries = yield* SessionQueries
            const commands = yield* SessionCommands
            const events = yield* SessionEvents
            const authGuard = yield* AuthGuard

            const authProviders = yield* authGuard.listProviders()
            const missingProviders = authProviders
              .filter((p) => p.required && !p.hasKey)
              .map((p) => p.provider)

            if (missingProviders.length > 0 && headless && !debug) {
              const hint = formatMissingProviders(missingProviders)
              yield* Console.error(`Error: missing required API keys: ${hint}`)
              return process.exit(1)
            }

            // Resolve initial state (discriminated union)
            const state = yield* resolveInitialState({
              queries,
              commands: { createSession: commands.createSession },
              cwd,
              session,
              continue_,
              headless,
              debug,
              prompt,
              promptArg,
              bypass,
            })

            // Create client (used by both headless and TUI)
            const gentClient: GentClient = yield* makeDirectGentClient

            // Handle headless mode
            if (state._tag === "headless") {
              const branchId = state.session.branchId
              if (branchId === undefined) {
                yield* Console.error("Error: session has no branch")
                return process.exit(1)
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
              const headlessEffect = runHeadless(
                commands,
                events,
                gentClient,
                state.session.id,
                branchId,
                state.prompt,
              ).pipe(
                Effect.withSpan("Headless.run"),
                parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
              )
              yield* headlessEffect
              return process.exit(0)
            }

            const uiServices = (yield* Effect.services<never>()) as ServiceMap.ServiceMap<unknown>

            let initialSession: Session | undefined
            let initialRoute = Route.home()
            let initialPrompt: string | undefined
            let debugMode = false
            const missingAuthProviders =
              !debug && missingProviders.length > 0
                ? (missingProviders as readonly ProviderId[])
                : undefined

            if (state._tag === "debug") {
              const debugSession = yield* prepareDebugSession(cwd)
              initialSession = debugSession
              initialRoute = Route.session(debugSession.sessionId, debugSession.branchId)
              debugMode = true
            }

            if (state._tag === "session" && state.session.branchId !== undefined) {
              initialSession = {
                sessionId: state.session.id,
                branchId: state.session.branchId,
                name: state.session.name ?? "Unnamed",
                bypass: state.session.bypass ?? true,
                reasoningLevel: state.session.reasoningLevel,
              }
              initialRoute = Route.session(state.session.id, state.session.branchId)
              initialPrompt = state.prompt
            }

            if (state._tag === "branchPicker") {
              initialRoute = Route.branchPicker(
                state.session.id,
                state.session.name ?? "Unnamed",
                state.branches,
                state.prompt,
              )
            }

            const visualOpt = yield* Config.option(Config.string("VISUAL"))
            const editorOpt = yield* Config.option(Config.string("EDITOR"))
            const env = {
              visual: Option.getOrUndefined(visualOpt),
              editor: Option.getOrUndefined(editorOpt),
            }

            yield* Effect.promise(() =>
              render(() => (
                <EnvProvider env={env}>
                  <WorkspaceProvider cwd={cwd} services={uiServices}>
                    <RegistryProvider services={uiServices} maxEntries={ATOM_CACHE_MAX}>
                      <ClientProvider client={gentClient} initialSession={initialSession}>
                        <RouterProvider initialRoute={initialRoute}>
                          <App
                            initialPrompt={initialPrompt}
                            missingAuthProviders={missingAuthProviders}
                            debugMode={debugMode}
                          />
                        </RouterProvider>
                      </ClientProvider>
                    </RegistryProvider>
                  </WorkspaceProvider>
                </EnvProvider>
              )),
            )

            return yield* Effect.never
          }).pipe(Effect.provideServices(services)),
        ),
      )
    }),
)

// Sessions subcommand
const sessions = Command.make("sessions", {}, () =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const services = yield* Layer.buildWithScope(makeCoreLayer({ cwd: process.cwd() }), scope)
    return yield* Effect.gen(function* () {
      const queries = yield* SessionQueries
      const allSessions = yield* queries.listSessions()

      if (allSessions.length === 0) {
        yield* Console.log("No sessions found.")
        return
      }

      yield* Console.log("Sessions:")
      for (const s of allSessions) {
        const date = new Date(s.updatedAt).toISOString()
        yield* Console.log(`  ${s.id} - ${s.name ?? "Unnamed"} (${date})`)
      }
    }).pipe(Effect.provideServices(services))
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

// Run with base platform layers; command handlers provide core layers as needed
const CliLayer = Layer.effectDiscard(cli)

const MainLayer = CliLayer.pipe(
  Layer.provide(LoggerLayer),
  Layer.provide(TracerLayer),
  Layer.provide(PlatformLayer),
)

BunRuntime.runMain(Effect.scoped(Layer.launch(MainLayer)))
