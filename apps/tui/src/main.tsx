#!/usr/bin/env bun
import { Command, Options, Args } from "@effect/cli"
import { BunContext, BunRuntime, BunFileSystem } from "@effect/platform-bun"
import { Console, Effect, Layer, ManagedRuntime, Runtime, Stream } from "effect"
import { RpcTest } from "@effect/rpc"
import {
  GentServer,
  GentCore,
  RpcHandlersLive,
  DEFAULT_SYSTEM_PROMPT,
  type GentCoreService,
  type GentCoreError,
} from "@gent/server"
import { GentRpcs } from "@gent/api"
import { DevTracerLive, clearLog } from "@gent/telemetry"
import { DEFAULT_MODEL_ID, type ModelId } from "@gent/core"
import * as path from "node:path"

import { render } from "@opentui/solid"
import { App } from "./app.js"
import { createClient, type GentRpcClient } from "./client.js"

// Data directory
const DATA_DIR = path.join(process.env["HOME"] ?? "~", ".gent")
const DB_PATH = path.join(DATA_DIR, "data.db")
const TRACE_LOG = "/tmp/gent-trace.log"

// Platform layer
const PlatformLayer = Layer.merge(BunFileSystem.layer, BunContext.layer)

// Dev tracer layer
const TracerLayer = DevTracerLive(TRACE_LOG)

// GentServer layer with tracing (provides dependencies for GentCore)
const ServerDepsLayer = GentServer.Dependencies({
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
    headless: Options.boolean("headless").pipe(
      Options.withAlias("H"),
      Options.withDescription("Run in headless mode (no TUI, streams to stdout)"),
      Options.withDefault(false)
    ),
    prompt: Args.text({ name: "prompt" }).pipe(
      Args.withDescription("Initial prompt to start with"),
      Args.optional
    ),
  },
  ({ session, headless, prompt }) =>
    Effect.gen(function* () {
      // Get core service for direct access (headless, session management)
      const core = yield* GentCore

      // Create RPC client for TUI
      const rpcClient: GentRpcClient = yield* RpcTest.makeClient(GentRpcs)

      // Get or create session
      let sessionId: string
      let branchId: string

      if (session._tag === "Some") {
        sessionId = session.value
        // Get existing session's branch
        const branches = yield* core.listBranches(sessionId)
        branchId = branches[0]?.id ?? crypto.randomUUID()
      } else {
        // Create new session
        const result = yield* core.createSession({ name: "gent session" })
        sessionId = result.sessionId
        branchId = result.branchId
      }

      const initialPrompt = prompt._tag === "Some" ? prompt.value : undefined

      // Headless mode: run prompt and exit
      if (headless) {
        if (!initialPrompt) {
          yield* Console.error("Error: --headless requires a prompt argument")
          process.exit(1)
        }
        yield* runHeadless(core, sessionId, branchId, initialPrompt)
        return
      }

      // Create client adapter for the TUI using managed runtime
      const runtime = yield* serverRuntime.runtimeEffect
      const client = createClient(rpcClient, runtime)

      // Model change handler - steers agent to new model
      const handleModelChange = (modelId: ModelId) => {
        Runtime.runPromise(runtime)(
          core.steer({ _tag: "SwitchModel", model: modelId as string })
        ).catch(() => {
          // Ignore steer errors (e.g., if agent not running)
        })
      }

      // Launch TUI
      yield* Effect.promise(() =>
        render(() => (
          <App
            client={client}
            sessionId={sessionId}
            branchId={branchId}
            initialPrompt={initialPrompt}
            onModelChange={handleModelChange}
          />
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
  Command.withDescription("Gent - Effect-native agent harness")
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
