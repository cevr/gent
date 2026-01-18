#!/usr/bin/env bun
import { Command, Options, Args } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect, Layer, Stream, Runtime } from "effect"
import { Storage } from "@gent/storage"
import { Provider, TextChunk, ToolCallChunk, FinishChunk } from "@gent/providers"
import {
  ToolRegistry,
  EventBus,
  Permission,
  Message,
  TextPart,
  Session,
  Branch,
} from "@gent/core"
import { AllTools, AskUserHandler } from "@gent/tools"
import { AgentLoop } from "@gent/runtime"
import * as path from "node:path"
import * as readline from "node:readline"

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
  Layer.succeed(AskUserHandler, {
    ask: (question, options) =>
      Effect.promise(async () => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        })
        return new Promise<string>((resolve) => {
          const prompt = options?.length
            ? `${question}\n${options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}\n> `
            : `${question}\n> `
          rl.question(prompt, (answer) => {
            rl.close()
            if (options?.length) {
              const idx = parseInt(answer) - 1
              resolve(options[idx] ?? answer)
            } else {
              resolve(answer)
            }
          })
        })
      }),
  })
)

const AgentLoopLayer = AgentLoop.Live({
  systemPrompt: "You are a helpful assistant.",
  defaultModel: "anthropic/claude-sonnet-4-20250514",
}).pipe(Layer.provide(RuntimeLayer))

const FullLayer = Layer.merge(RuntimeLayer, AgentLoopLayer)

// Chat command
const chat = Command.make(
  "chat",
  {
    message: Args.text({ name: "message" }).pipe(Args.optional),
    session: Options.text("session").pipe(
      Options.withAlias("s"),
      Options.withDescription("Session ID to continue"),
      Options.optional
    ),
    model: Options.text("model").pipe(
      Options.withAlias("m"),
      Options.withDescription("Model to use (provider/model)"),
      Options.withDefault("anthropic/claude-sonnet-4-20250514")
    ),
  },
  ({ message, session, model }) =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const provider = yield* Provider
      const eventBus = yield* EventBus

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
            name: "CLI Session",
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

      yield* Console.log(`Session: ${sessionId}`)

      // If message provided, run single turn
      if (message._tag === "Some") {
        const userMessage = new Message({
          id: crypto.randomUUID(),
          sessionId,
          branchId,
          role: "user",
          parts: [new TextPart({ text: message.value })],
          createdAt: new Date(),
        })

        yield* storage.createMessage(userMessage)

        const messages = yield* storage.listMessages(branchId)
        const stream = yield* provider.stream({
          model,
          messages: [...messages],
          systemPrompt: "You are a helpful assistant.",
        })

        let response = ""
        yield* Stream.runForEach(stream, (chunk) =>
          Effect.gen(function* () {
            if (chunk._tag === "TextChunk") {
              response += chunk.text
              yield* Console.log(chunk.text)
            }
          })
        )

        // Save assistant response
        yield* storage.createMessage(
          new Message({
            id: crypto.randomUUID(),
            sessionId,
            branchId,
            role: "assistant",
            parts: [new TextPart({ text: response })],
            createdAt: new Date(),
          })
        )
      } else {
        // Interactive REPL
        yield* Console.log("Interactive mode. Type 'exit' to quit.\n")

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        })

        const rt = yield* Effect.runtime<Storage | Provider>()

        yield* Effect.async<void, never, never>((resume) => {
          const prompt = () => {
            rl.question("you> ", async (input) => {
              if (input.toLowerCase() === "exit") {
                rl.close()
                resume(Effect.void)
                return
              }

              const userMessage = new Message({
                id: crypto.randomUUID(),
                sessionId,
                branchId,
                role: "user",
                parts: [new TextPart({ text: input })],
                createdAt: new Date(),
              })

              await Runtime.runPromise(rt)(
                Effect.gen(function* () {
                  yield* storage.createMessage(userMessage)
                  const messages = yield* storage.listMessages(branchId)

                  const stream = yield* provider.stream({
                    model,
                    messages: [...messages],
                    systemPrompt: "You are a helpful assistant.",
                  })

                  process.stdout.write("assistant> ")
                  let response = ""

                  yield* Stream.runForEach(stream, (chunk) =>
                    Effect.sync(() => {
                      if (chunk._tag === "TextChunk") {
                        response += chunk.text
                        process.stdout.write(chunk.text)
                      }
                    })
                  )

                  process.stdout.write("\n\n")

                  yield* storage.createMessage(
                    new Message({
                      id: crypto.randomUUID(),
                      sessionId,
                      branchId,
                      role: "assistant",
                      parts: [new TextPart({ text: response })],
                      createdAt: new Date(),
                    })
                  )
                })
              )

              prompt()
            })
          }

          prompt()
        })
      }
    }).pipe(Effect.provide(FullLayer))
)

// Sessions command
const sessions = Command.make("sessions", {}, () =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const sessions = yield* storage.listSessions()

    if (sessions.length === 0) {
      yield* Console.log("No sessions found.")
      return
    }

    yield* Console.log("Sessions:")
    for (const session of sessions) {
      yield* Console.log(
        `  ${session.id} - ${session.name ?? "Unnamed"} (${session.updatedAt.toISOString()})`
      )
    }
  }).pipe(Effect.provide(RuntimeLayer))
)

// Main command
const command = Command.make("gent", {
  version: Options.boolean("version").pipe(
    Options.withAlias("v"),
    Options.withDescription("Show version")
  ),
}).pipe(
  Command.withSubcommands([chat, sessions]),
  Command.withDescription("Gent - Effect-native agent harness")
)

// CLI
const cli = Command.run(command, {
  name: "gent",
  version: "0.0.0",
})

// Run
cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
