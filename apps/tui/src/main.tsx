#!/usr/bin/env bun
import { Command, Options, Args } from "@effect/cli"
import { BunContext, BunRuntime, BunFileSystem } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Option, Stream } from "effect"
import type { Runtime } from "effect"
import { RegistryProvider } from "@gent/atom-solid"
import {
  createDependencies,
  GentCore,
  type GentCoreService,
  type GentCoreError,
  type SessionInfo,
  type BranchInfo,
} from "@gent/server"
import { makeDirectClient, type DirectClient } from "@gent/sdk"
import { UnifiedTracerLive, clearUnifiedLog } from "./utils/unified-tracer"
import { AuthGuard, type ProviderId } from "@gent/core"
import * as path from "node:path"
import * as os from "node:os"

import { render } from "@opentui/solid"
import { App } from "./app"
import { ClientProvider, type Session } from "./client/index"
import { RouterProvider, Route } from "./router/index"
import { WorkspaceProvider } from "./workspace/index"

// ============================================================================
// Initial State - discriminated union for clarity
// ============================================================================

type InitialState =
  | { _tag: "home" }
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
  core: GentCoreService
  cwd: string
  session: Option.Option<string>
  continue_: boolean
  headless: boolean
  prompt: Option.Option<string>
  promptArg: Option.Option<string>
  bypass: boolean
}): Effect.Effect<InitialState, GentCoreError> =>
  Effect.gen(function* () {
    const { core, cwd, session, continue_, headless, prompt, promptArg, bypass } = input

    // 1. Headless mode
    if (headless) {
      const promptText = Option.isSome(promptArg) ? promptArg.value : undefined
      if (promptText === undefined || promptText.length === 0) {
        yield* Console.error("Error: --headless requires a prompt argument")
        return process.exit(1)
      }
      // Get or create session
      if (Option.isSome(session)) {
        const sess = yield* core.getSession(session.value)
        if (sess === null) {
          yield* Console.error(`Error: session ${session.value} not found`)
          return process.exit(1)
        }
        return { _tag: "headless" as const, session: sess, prompt: promptText }
      }

      const result = yield* core.createSession({ name: "headless session", cwd, bypass })
      const sess: SessionInfo = {
        id: result.sessionId,
        name: result.name,
        cwd,
        bypass: result.bypass,
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
      const sess = yield* core.getSession(session.value)
      if (sess === null) {
        yield* Console.error(`Error: session ${session.value} not found`)
        return process.exit(1)
      }
      const promptText = Option.isSome(prompt) ? prompt.value : undefined
      const branches = yield* core.listBranches(sess.id)
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
        const existing = yield* core.getLastSessionByCwd(cwd)
        if (existing !== null) return existing

        const result = yield* core.createSession({ cwd, bypass })
        return {
          id: result.sessionId,
          name: result.name,
          cwd,
          bypass: result.bypass,
          branchId: result.branchId,
          parentSessionId: undefined,
          parentBranchId: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      })
      const promptText = Option.isSome(prompt) ? prompt.value : undefined
      const branches = yield* core.listBranches(sess.id)
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
      const result = yield* core.createSession({ cwd, bypass })
      const sess: SessionInfo = {
        id: result.sessionId,
        name: result.name,
        cwd,
        bypass: result.bypass,
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

// Unified tracer logs to /tmp/gent-unified.log
const ATOM_CACHE_MAX = 256

// Platform layer
const PlatformLayer = Layer.merge(BunFileSystem.layer, BunContext.layer)

// Unified tracer layer - logs both Effect spans and TUI events
const TracerLayer = UnifiedTracerLive

const CoreLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cwd = process.cwd()
    const home = yield* Config.option(Config.string("HOME")).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none())),
      Effect.map(Option.getOrElse(() => os.homedir())),
    )
    const dataDirOpt = yield* Config.option(Config.string("GENT_DATA_DIR")).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none())),
    )
    const dataDir = Option.getOrElse(dataDirOpt, () => path.join(home, ".gent"))
    const dbPath = Option.getOrElse(
      yield* Config.option(Config.string("GENT_DB_PATH")).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none())),
      ),
      () => path.join(dataDir, "data.db"),
    )
    const authFilePath = Option.isSome(dataDirOpt) ? path.join(dataDir, "auth.json.enc") : undefined
    const authKeyPath = Option.isSome(dataDirOpt) ? path.join(dataDir, "auth.key") : undefined

    const serverDeps = createDependencies({
      cwd,
      dbPath,
      ...(authFilePath !== undefined ? { authFilePath } : {}),
      ...(authKeyPath !== undefined ? { authKeyPath } : {}),
    }).pipe(Layer.provide(PlatformLayer), Layer.provide(TracerLayer))
    const coreLive = GentCore.Live.pipe(Layer.provide(serverDeps))
    return Layer.mergeAll(coreLive, serverDeps, PlatformLayer)
  }),
)

// Clear trace log on startup
clearUnifiedLog()

// Headless runner - streams events to stdout
const runHeadless = (
  core: GentCoreService,
  sessionId: string,
  branchId: string,
  promptText: string,
): Effect.Effect<void, GentCoreError, never> =>
  Effect.gen(function* () {
    // Subscribe to events before sending message
    const events = core.subscribeEvents({ sessionId, branchId })

    // Send the message
    yield* core.sendMessage({ sessionId, branchId, content: promptText })

    // Stream events until complete
    yield* events.pipe(
      Stream.tap((envelope) =>
        Effect.sync(() => {
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
            case "StreamEnded":
              process.stdout.write("\n")
              break
            case "ErrorOccurred":
              process.stderr.write(`\nError: ${event.error}\n`)
              break
          }
        }),
      ),
      Stream.takeUntil(
        (envelope) =>
          envelope.event._tag === "StreamEnded" || envelope.event._tag === "ErrorOccurred",
      ),
      Stream.runDrain,
    )
  })

// Main command - launches TUI or runs headless
const main = Command.make(
  "gent",
  {
    session: Options.text("session").pipe(
      Options.withAlias("s"),
      Options.withDescription("Session ID to continue"),
      Options.optional,
    ),
    continue_: Options.boolean("continue").pipe(
      Options.withAlias("c"),
      Options.withDescription("Continue last session from current directory"),
      Options.withDefault(false),
    ),
    headless: Options.boolean("headless").pipe(
      Options.withAlias("H"),
      Options.withDescription("Run in headless mode (no TUI, streams to stdout)"),
      Options.withDefault(false),
    ),
    prompt: Options.text("prompt").pipe(
      Options.withAlias("p"),
      Options.withDescription("Initial prompt (TUI mode)"),
      Options.optional,
    ),
    promptArg: Args.text({ name: "prompt" }).pipe(
      Args.withDescription("Prompt for headless mode"),
      Args.optional,
    ),
    bypass: Options.boolean("bypass").pipe(
      Options.withDescription(
        "Auto-allow all tool calls (default: true, use --no-bypass to disable)",
      ),
      Options.withDefault(true),
    ),
  },
  ({ session, continue_, headless, prompt, promptArg, bypass }) =>
    Effect.gen(function* () {
      // Get core service for direct access (headless, session management)
      const cwd = process.cwd()

      const program = Effect.gen(function* () {
        const core = yield* GentCore
        const authGuard = yield* AuthGuard

        const authProviders = yield* authGuard.listProviders()
        const missingProviders = authProviders
          .filter((p) => p.required && !p.hasKey)
          .map((p) => p.provider)

        if (missingProviders.length > 0 && headless) {
          const hint = formatMissingProviders(missingProviders)
          yield* Console.error(`Error: missing required API keys: ${hint}`)
          return process.exit(1)
        }

        // Resolve initial state (discriminated union)
        const state = yield* resolveInitialState({
          core,
          cwd,
          session,
          continue_,
          headless,
          prompt,
          promptArg,
          bypass,
        })

        // Handle headless mode
        if (state._tag === "headless") {
          const branchId = state.session.branchId
          if (branchId === undefined) {
            yield* Console.error("Error: session has no branch")
            return process.exit(1)
          }
          yield* runHeadless(core, state.session.id, branchId, state.prompt)
          return
        }

        // Create direct client for TUI (no RPC layer, avoids scope issues)
        const directClient: DirectClient = yield* makeDirectClient

        // Get runtime for client
        const uiRuntime = (yield* Effect.runtime<never>()) as Runtime.Runtime<unknown>

        // Derive initial session and route from state
        let initialSession: Session | undefined
        let initialRoute = Route.home()
        let initialPrompt: string | undefined
        const missingAuthProviders =
          missingProviders.length > 0 ? (missingProviders as readonly ProviderId[]) : undefined

        if (state._tag === "session" && state.session.branchId !== undefined) {
          initialSession = {
            sessionId: state.session.id,
            branchId: state.session.branchId,
            name: state.session.name ?? "Unnamed",
            bypass: state.session.bypass ?? true,
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

        // Launch TUI with providers
        yield* Effect.promise(() =>
          render(() => (
            <WorkspaceProvider cwd={cwd} runtime={uiRuntime}>
              <RegistryProvider runtime={uiRuntime} maxEntries={ATOM_CACHE_MAX}>
                <ClientProvider
                  rpcClient={directClient}
                  runtime={uiRuntime}
                  initialSession={initialSession}
                >
                  <RouterProvider initialRoute={initialRoute}>
                    <App
                      initialPrompt={initialPrompt}
                      missingAuthProviders={missingAuthProviders}
                    />
                  </RouterProvider>
                </ClientProvider>
              </RegistryProvider>
            </WorkspaceProvider>
          )),
        )

        // Keep process alive until TUI exits
        return yield* Effect.never
      }).pipe(Effect.scoped)

      return yield* program
    }),
)

// Sessions subcommand
const sessions = Command.make("sessions", {}, () =>
  Effect.gen(function* () {
    const core = yield* GentCore
    const allSessions = yield* core.listSessions()

    if (allSessions.length === 0) {
      yield* Console.log("No sessions found.")
      return
    }

    yield* Console.log("Sessions:")
    for (const s of allSessions) {
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
  name: "gent",
  version: "0.0.0",
})

// Base runtime layer for CLI
const CliLayer = CoreLayer

// Run with base layers; command handlers provide core layers as needed
const MainLayer = Layer.scopedDiscard(Effect.suspend(() => cli(process.argv))).pipe(
  Layer.provide(CliLayer),
)

BunRuntime.runMain(Layer.launch(MainLayer))
