import { Context, Effect, Layer, Stream } from "effect"
import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import {
  Session,
  Branch,
  Message,
  TextPart,
  EventBus,
  ToolRegistry,
  Permission,
  type AgentEvent,
  type MessagePart,
} from "@gent/core"
import { Storage, StorageError } from "@gent/storage"
import { Provider } from "@gent/providers"
import { AgentLoop, SteerCommand, AgentLoopError } from "@gent/runtime"
import { AllTools } from "@gent/tools"

// Re-export types
export { SteerCommand, AgentLoopError }
export { StorageError }

// Session types
export interface CreateSessionInput {
  name?: string
}

export interface CreateSessionOutput {
  sessionId: string
  branchId: string
}

// Message types
export interface SendMessageInput {
  sessionId: string
  branchId: string
  content: string
}

// Server Error
export type GentServerError = StorageError | AgentLoopError | PlatformError

// Server Service - methods return Effects with errors
export interface GentServerService {
  readonly createSession: (
    input: CreateSessionInput
  ) => Effect.Effect<CreateSessionOutput, GentServerError>

  readonly listSessions: () => Effect.Effect<
    Array<{
      id: string
      name: string | undefined
      createdAt: number
      updatedAt: number
    }>,
    GentServerError
  >

  readonly getSession: (
    sessionId: string
  ) => Effect.Effect<
    {
      id: string
      name: string | undefined
      createdAt: number
      updatedAt: number
    } | null,
    GentServerError
  >

  readonly deleteSession: (
    sessionId: string
  ) => Effect.Effect<void, GentServerError>

  readonly sendMessage: (
    input: SendMessageInput
  ) => Effect.Effect<void, GentServerError>

  readonly listMessages: (
    branchId: string
  ) => Effect.Effect<
    Array<{
      id: string
      sessionId: string
      branchId: string
      role: "user" | "assistant" | "system" | "tool"
      parts: readonly MessagePart[]
      createdAt: number
    }>,
    GentServerError
  >

  readonly steer: (command: SteerCommand) => Effect.Effect<void, GentServerError>

  readonly subscribeEvents: (
    sessionId: string
  ) => Stream.Stream<AgentEvent, never, never>
}

export class GentServer extends Context.Tag("GentServer")<
  GentServer,
  GentServerService
>() {
  static Live = (config: {
    systemPrompt: string
    defaultModel: string
    dbPath?: string
  }): Layer.Layer<GentServer, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      GentServer,
      Effect.gen(function* () {
        const storage = yield* Storage
        const agentLoop = yield* AgentLoop
        const eventBus = yield* EventBus

        const service: GentServerService = {
          createSession: (input) =>
            Effect.gen(function* () {
              const sessionId = crypto.randomUUID()
              const branchId = crypto.randomUUID()
              const now = new Date()

              const session = new Session({
                id: sessionId,
                name: input.name ?? "New Session",
                createdAt: now,
                updatedAt: now,
              })

              const branch = new Branch({
                id: branchId,
                sessionId,
                createdAt: now,
              })

              yield* storage.createSession(session)
              yield* storage.createBranch(branch)

              return { sessionId, branchId }
            }),

          listSessions: () =>
            Effect.gen(function* () {
              const sessions = yield* storage.listSessions()
              return sessions.map((s) => ({
                id: s.id,
                name: s.name,
                createdAt: s.createdAt.getTime(),
                updatedAt: s.updatedAt.getTime(),
              }))
            }),

          getSession: (sessionId) =>
            Effect.gen(function* () {
              const session = yield* storage.getSession(sessionId)
              if (!session) return null
              return {
                id: session.id,
                name: session.name,
                createdAt: session.createdAt.getTime(),
                updatedAt: session.updatedAt.getTime(),
              }
            }),

          deleteSession: (sessionId) => storage.deleteSession(sessionId),

          sendMessage: Effect.fn("GentServer.sendMessage")(function* (input) {
            const message = new Message({
              id: crypto.randomUUID(),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: input.content })],
              createdAt: new Date(),
            })

            // Run agent loop in background - don't wait for completion
            yield* Effect.forkDaemon(
              agentLoop.run(message).pipe(
                Effect.withSpan("AgentLoop.background"),
                Effect.catchAllCause(() => Effect.void)
              )
            )
          }),

          listMessages: (branchId) =>
            Effect.gen(function* () {
              const messages = yield* storage.listMessages(branchId)
              return messages.map((m) => ({
                id: m.id,
                sessionId: m.sessionId,
                branchId: m.branchId,
                role: m.role,
                parts: m.parts,
                createdAt: m.createdAt.getTime(),
              }))
            }),

          steer: (command) => agentLoop.steer(command),

          subscribeEvents: (sessionId) =>
            eventBus.subscribe().pipe(
              Stream.filter((e) => {
                if ("sessionId" in e) {
                  return (e as { sessionId: string }).sessionId === sessionId
                }
                return false
              })
            ),
        }

        return service
      })
    ).pipe(Layer.provide(GentServer.Dependencies(config)))

  static Dependencies = (config: {
    systemPrompt: string
    defaultModel: string
    dbPath?: string
  }): Layer.Layer<
    Storage | Provider | ToolRegistry | EventBus | Permission | AgentLoop,
    PlatformError,
    FileSystem.FileSystem | Path.Path
  > => {
    const StorageLive = Storage.Live(config.dbPath ?? ".gent/data.db")

    const BaseServicesLive = Layer.mergeAll(
      StorageLive,
      Provider.Live,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- ToolDefinition type variance requires any
      ToolRegistry.Live(AllTools as any),
      EventBus.Live,
      Permission.Live()
    )

    const AgentLoopLive = AgentLoop.Live({
      systemPrompt: config.systemPrompt,
      defaultModel: config.defaultModel,
    })

    return Layer.merge(
      BaseServicesLive,
      Layer.provide(AgentLoopLive, BaseServicesLive)
    )
  }
}
