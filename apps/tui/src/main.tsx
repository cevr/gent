#!/usr/bin/env bun
import { Command, Options, Args } from "@effect/cli"
import { BunContext, BunRuntime, BunFileSystem } from "@effect/platform-bun"
import { Console, Effect, Layer, ManagedRuntime } from "effect"
import { GentServer } from "@gent/server"
import { DevTracerLive, clearLog } from "@gent/telemetry"
import * as path from "node:path"

import { render } from "@opentui/solid"
import { App } from "./App.js"
import { createClient } from "./client.js"

// Data directory
const DATA_DIR = path.join(process.env["HOME"] ?? "~", ".gent")
const DB_PATH = path.join(DATA_DIR, "data.db")
const TRACE_LOG = "/tmp/gent-trace.log"

// Platform layer
const PlatformLayer = Layer.merge(BunFileSystem.layer, BunContext.layer)

// Dev tracer layer
const TracerLayer = DevTracerLive(TRACE_LOG)

// GentServer layer with tracing
const ServerLayer = GentServer.Live({
  systemPrompt: "You are a helpful assistant.",
  defaultModel: "bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0",
  dbPath: DB_PATH,
}).pipe(
  Layer.provide(PlatformLayer),
  Layer.provide(TracerLayer)
)

// Clear trace log on startup
clearLog(TRACE_LOG)

// Create managed runtime for GentServer
const serverRuntime = ManagedRuntime.make(ServerLayer)

// Main command - launches TUI
const main = Command.make(
  "gent",
  {
    session: Options.text("session").pipe(
      Options.withAlias("s"),
      Options.withDescription("Session ID to continue"),
      Options.optional
    ),
    prompt: Args.text({ name: "prompt" }).pipe(
      Args.withDescription("Initial prompt to start with"),
      Args.optional
    ),
  },
  ({ session, prompt }) =>
    Effect.gen(function* () {
      // Build the runtime
      const runtime = yield* serverRuntime.runtimeEffect
      const client = createClient(runtime)
      const server = yield* GentServer

      // Get or create session
      let sessionId: string
      let branchId: string

      if (session._tag === "Some") {
        sessionId = session.value
        // Get existing session's branch
        const messages = yield* server.listMessages(sessionId)
        branchId = messages[0]?.branchId ?? crypto.randomUUID()
      } else {
        // Create new session
        const result = yield* server.createSession({ name: "gent session" })
        sessionId = result.sessionId
        branchId = result.branchId
      }

      const initialPrompt = prompt._tag === "Some" ? prompt.value : undefined

      // Launch TUI
      yield* Effect.promise(() =>
        render(() => (
          <App
            client={client}
            sessionId={sessionId}
            branchId={branchId}
            initialPrompt={initialPrompt}
          />
        ))
      )

      // Keep process alive until TUI exits
      return yield* Effect.never
    }).pipe(Effect.provide(ServerLayer))
)

// Sessions subcommand
const sessions = Command.make("sessions", {}, () =>
  Effect.gen(function* () {
    const server = yield* GentServer
    const allSessions = yield* server.listSessions()

    if (allSessions.length === 0) {
      yield* Console.log("No sessions found.")
      return
    }

    yield* Console.log("Sessions:")
    for (const s of allSessions) {
      const date = new Date(s.updatedAt).toISOString()
      yield* Console.log(`  ${s.id} - ${s.name ?? "Unnamed"} (${date})`)
    }
  }).pipe(Effect.provide(ServerLayer))
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

// Run with tracer
cli(process.argv).pipe(
  Effect.provide(Layer.merge(BunContext.layer, TracerLayer)),
  BunRuntime.runMain
)
