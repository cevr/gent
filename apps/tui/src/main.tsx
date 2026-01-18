#!/usr/bin/env bun
import { Command, Options, Args } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { Storage } from "@gent/storage"
import {
  ToolRegistry,
  EventBus,
  Permission,
  Session,
  Branch,
} from "@gent/core"
import { Provider } from "@gent/providers"
import { AllTools, AskUserHandler } from "@gent/tools"
import { AgentLoop } from "@gent/runtime"
import * as path from "node:path"

import { render } from "@opentui/solid"
import { App } from "./App.js"

// Data directory
const DATA_DIR = path.join(process.env["HOME"] ?? "~", ".gent")
const DB_PATH = path.join(DATA_DIR, "data.db")

// Runtime layer
const RuntimeLayer = Layer.mergeAll(
  Storage.Live(DB_PATH),
  Provider.Live,
  ToolRegistry.Live(AllTools as any),
  EventBus.Live,
  Permission.Live(),
  AskUserHandler.Test([]) // TUI handles user interaction
)

const AgentLoopLayer = AgentLoop.Live({
  systemPrompt: "You are a helpful assistant.",
  defaultModel: "anthropic/claude-sonnet-4-20250514",
}).pipe(Layer.provide(RuntimeLayer))

const FullLayer = Layer.merge(RuntimeLayer, AgentLoopLayer)

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
      const storage = yield* Storage

      // Get or create session
      let sessionId: string
      let branchId: string

      if (session._tag === "Some") {
        sessionId = session.value
        const branches = yield* storage.listBranches(sessionId)
        branchId = branches[0]?.id ?? crypto.randomUUID()
      } else {
        sessionId = crypto.randomUUID()
        branchId = crypto.randomUUID()

        yield* storage.createSession(
          new Session({
            id: sessionId,
            name: "gent session",
            createdAt: new Date(),
            updatedAt: new Date(),
          })
        )
        yield* storage.createBranch(
          new Branch({
            id: branchId,
            sessionId,
            createdAt: new Date(),
          })
        )
      }

      const initialPrompt = prompt._tag === "Some" ? prompt.value : undefined

      // Launch TUI
      yield* Effect.sync(() => {
        render(() => (
          <App
            sessionId={sessionId}
            branchId={branchId}
            initialPrompt={initialPrompt}
          />
        ))
      })

      // Keep process alive until TUI exits
      return yield* Effect.never
    }).pipe(Effect.provide(FullLayer))
)

// Sessions subcommand
const sessions = Command.make("sessions", {}, () =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const allSessions = yield* storage.listSessions()

    if (allSessions.length === 0) {
      yield* Console.log("No sessions found.")
      return
    }

    yield* Console.log("Sessions:")
    for (const s of allSessions) {
      yield* Console.log(
        `  ${s.id} - ${s.name ?? "Unnamed"} (${s.updatedAt.toISOString()})`
      )
    }
  }).pipe(Effect.provide(RuntimeLayer))
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

// Run
cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
