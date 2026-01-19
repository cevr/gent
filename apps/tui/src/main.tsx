#!/usr/bin/env bun
import { Command, Options, Args } from "@effect/cli"
import { BunContext, BunRuntime, BunFileSystem } from "@effect/platform-bun"
import { Console, Effect, Layer, ManagedRuntime, Option, Runtime, Stream } from "effect"
import { RpcTest } from "@effect/rpc"
import {
  createDependencies,
  GentCore,
  RpcHandlersLive,
  DEFAULT_SYSTEM_PROMPT,
  GentRpcs,
  type GentCoreService,
  type GentCoreError,
  type SessionInfo,
} from "@gent/server"
import { DevTracerLive, clearLog } from "@gent/runtime"
import { DEFAULT_MODEL_ID, type ModelId } from "@gent/core"
import * as path from "node:path"

import { render } from "@opentui/solid"
import { App } from "./app.js"
import { ClientProvider, type Session } from "./client/index.js"
import { RouterProvider, Route } from "./router/index.js"
import { WorkspaceProvider } from "./workspace/index.js"
import type { GentRpcClient } from "./client.js"

// ============================================================================
// Initial State - discriminated union for clarity
// ============================================================================

type InitialState =
  | { _tag: "home" }
  | { _tag: "session"; session: SessionInfo; prompt?: string }
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
}): Effect.Effect<InitialState, GentCoreError> =>
  Effect.gen(function* () {
    const { core, cwd, session, continue_, headless, prompt, promptArg } = input

    // 1. Headless mode
    if (headless) {
      const promptText = Option.isSome(promptArg) ? promptArg.value : undefined
      if (!promptText) {
        yield* Console.error("Error: --headless requires a prompt argument")
        return process.exit(1)
      }
      // Get or create session
      let sess: SessionInfo | null = null
      if (Option.isSome(session)) {
        sess = yield* core.getSession(session.value)
        if (!sess) {
          yield* Console.error(`Error: session ${session.value} not found`)
          return process.exit(1)
        }
      } else {
        const result = yield* core.createSession({ name: "headless session", cwd })
        sess = {
          id: result.sessionId,
          name: result.name,
          cwd,
          branchId: result.branchId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }
      return { _tag: "headless" as const, session: sess, prompt: promptText }
    }

    // 2. Explicit session ID
    if (Option.isSome(session)) {
      const sess = yield* core.getSession(session.value)
      if (!sess) {
        yield* Console.error(`Error: session ${session.value} not found`)
        return process.exit(1)
      }
      const promptText = Option.isSome(prompt) ? prompt.value : undefined
      return { _tag: "session" as const, session: sess, prompt: promptText }
    }

    // 3. Continue from cwd
    if (continue_) {
      let sess = yield* core.getLastSessionByCwd(cwd)
      if (!sess) {
        const result = yield* core.createSession({ cwd })
        sess = {
          id: result.sessionId,
          name: result.name,
          cwd,
          branchId: result.branchId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }
      const promptText = Option.isSome(prompt) ? prompt.value : undefined
      return { _tag: "session" as const, session: sess, prompt: promptText }
    }

    // 4. Prompt without session - create new
    if (Option.isSome(prompt)) {
      const result = yield* core.createSession({ cwd })
      const sess: SessionInfo = {
        id: result.sessionId,
        name: result.name,
        cwd,
        branchId: result.branchId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      return { _tag: "session" as const, session: sess, prompt: prompt.value }
    }

    // 5. Home view
    return { _tag: "home" as const }
  })

// Data directory
const DATA_DIR = path.join(process.env["HOME"] ?? "~", ".gent")
const DB_PATH = path.join(DATA_DIR, "data.db")
const TRACE_LOG = "/tmp/gent-trace.log"

// Platform layer
const PlatformLayer = Layer.merge(BunFileSystem.layer, BunContext.layer)

// Dev tracer layer
const TracerLayer = DevTracerLive(TRACE_LOG)

// Dependencies layer with tracing
const ServerDepsLayer = createDependencies({
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  defaultModel: DEFAULT_MODEL_ID,
  dbPath: DB_PATH,
}).pipe(Layer.provide(PlatformLayer), Layer.provide(TracerLayer))

// GentCore layer on top of dependencies
const GentCoreLive = GentCore.Live.pipe(Layer.provide(ServerDepsLayer))

// RPC handlers layer (requires GentCore)
const RpcLayer = RpcHandlersLive.pipe(Layer.provide(GentCoreLive))

// Full layer stack for RPC client
const FullLayer = Layer.mergeAll(RpcLayer, GentCoreLive)

// Clear trace log on startup
clearLog(TRACE_LOG)

// Create managed runtime
const serverRuntime = ManagedRuntime.make(FullLayer)

// Headless runner - streams events to stdout
const runHeadless = (
  core: GentCoreService,
  sessionId: string,
  branchId: string,
  promptText: string
): Effect.Effect<void, GentCoreError, never> =>
  Effect.gen(function* () {
    // Subscribe to events before sending message
    const events = core.subscribeEvents(sessionId)

    // Send the message
    yield* core.sendMessage({ sessionId, branchId, content: promptText })

    // Stream events until complete
    yield* events.pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          switch (event._tag) {
            case "StreamChunk":
              process.stdout.write(event.chunk)
              break
            case "ToolCallStarted":
              process.stdout.write(`\n[tool: ${event.toolName}]\n`)
              break
            case "ToolCallCompleted":
              process.stdout.write(`[tool done: ${event.toolName}${event.isError ? " (error)" : ""}]\n`)
              break
            case "StreamEnded":
              process.stdout.write("\n")
              break
            case "ErrorOccurred":
              process.stderr.write(`\nError: ${event.error}\n`)
              break
          }
        })
      ),
      Stream.takeUntil((e) => e._tag === "StreamEnded" || e._tag === "ErrorOccurred"),
      Stream.runDrain
    )
  })

// Main command - launches TUI or runs headless
const main = Command.make(
  "gent",
  {
    session: Options.text("session").pipe(
      Options.withAlias("s"),
      Options.withDescription("Session ID to continue"),
      Options.optional
    ),
    continue_: Options.boolean("continue").pipe(
      Options.withAlias("c"),
      Options.withDescription("Continue last session from current directory"),
      Options.withDefault(false)
    ),
    headless: Options.boolean("headless").pipe(
      Options.withAlias("H"),
      Options.withDescription("Run in headless mode (no TUI, streams to stdout)"),
      Options.withDefault(false)
    ),
    prompt: Options.text("prompt").pipe(
      Options.withAlias("p"),
      Options.withDescription("Initial prompt (TUI mode)"),
      Options.optional
    ),
    promptArg: Args.text({ name: "prompt" }).pipe(
      Args.withDescription("Prompt for headless mode"),
      Args.optional
    ),
  },
  ({ session, continue_, headless, prompt, promptArg }) =>
    Effect.gen(function* () {
      // Get core service for direct access (headless, session management)
      const core = yield* GentCore
      const cwd = process.cwd()

      // Resolve initial state (discriminated union)
      const state = yield* resolveInitialState({
        core,
        cwd,
        session,
        continue_,
        headless,
        prompt,
        promptArg,
      })

      // Handle headless mode
      if (state._tag === "headless") {
        if (!state.session.branchId) {
          yield* Console.error("Error: session has no branch")
          return process.exit(1)
        }
        yield* runHeadless(core, state.session.id, state.session.branchId, state.prompt)
        return
      }

      // Create RPC client for TUI
      const rpcClient: GentRpcClient = yield* RpcTest.makeClient(GentRpcs)

      // Get runtime for client
      const runtime = yield* serverRuntime.runtimeEffect

      // Model change handler - steers agent to new model
      const handleModelChange = (modelId: ModelId) => {
        Runtime.runPromise(runtime)(
          core.steer({ _tag: "SwitchModel", model: modelId as string })
        ).catch(() => {
          // Ignore steer errors (e.g., if agent not running)
        })
      }

      // Derive initial session and route from state
      let initialSession: Session | undefined
      let initialRoute = Route.home()
      let initialPrompt: string | undefined

      if (state._tag === "session" && state.session.branchId) {
        initialSession = {
          sessionId: state.session.id,
          branchId: state.session.branchId,
          name: state.session.name ?? "Unnamed",
        }
        initialRoute = Route.session(state.session.id, state.session.branchId)
        initialPrompt = state.prompt
      }

      // Launch TUI with providers
      yield* Effect.promise(() =>
        render(() => (
          <WorkspaceProvider cwd={cwd}>
            <ClientProvider
              rpcClient={rpcClient}
              runtime={runtime}
              initialSession={initialSession}
            >
              <RouterProvider initialRoute={initialRoute}>
                <App initialPrompt={initialPrompt} onModelChange={handleModelChange} />
              </RouterProvider>
            </ClientProvider>
          </WorkspaceProvider>
        ))
      )

      // Keep process alive until TUI exits
      return yield* Effect.never
    }).pipe(Effect.scoped)
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
  })
)

// Root command with subcommands
const command = main.pipe(
  Command.withSubcommands([sessions]),
  Command.withDescription("Gent - minimal, opinionated agent harness")
)

// CLI
const cli = Command.run(command, {
  name: "gent",
  version: "0.0.0",
})

// Full runtime layer for CLI
const CliLayer = Layer.mergeAll(FullLayer, BunContext.layer, TracerLayer)

// Run with all layers
cli(process.argv).pipe(
  Effect.provide(CliLayer),
  BunRuntime.runMain
)
