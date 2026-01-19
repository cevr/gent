import { Context, Effect, Layer, Stream } from "effect"
import type { PlatformError } from "@effect/platform/Error"
import {
  Session,
  Branch,
  Message,
  TextPart,
  EventBus,
  type AgentEvent,
  type MessagePart,
} from "@gent/core"
import { Storage, StorageError } from "@gent/storage"
import { AgentLoop, SteerCommand, AgentLoopError } from "@gent/runtime"

// Re-export for consumers
export { SteerCommand, AgentLoopError }
export { StorageError }

// ============================================================================
// Types
// ============================================================================

export interface CreateSessionInput {
  name?: string
}

export interface CreateSessionOutput {
  sessionId: string
  branchId: string
}

export interface SendMessageInput {
  sessionId: string
  branchId: string
  content: string
}

export interface SessionInfo {
  id: string
  name: string | undefined
  createdAt: number
  updatedAt: number
}

export interface BranchInfo {
  id: string
  sessionId: string
  createdAt: number
}

export interface MessageInfo {
  id: string
  sessionId: string
  branchId: string
  role: "user" | "assistant" | "system" | "tool"
  parts: readonly MessagePart[]
  createdAt: number
}

export type GentCoreError = StorageError | AgentLoopError | PlatformError

// ============================================================================
// GentCore Service
// ============================================================================

export interface GentCoreService {
  readonly createSession: (
    input: CreateSessionInput
  ) => Effect.Effect<CreateSessionOutput, GentCoreError>

  readonly listSessions: () => Effect.Effect<SessionInfo[], GentCoreError>

  readonly getSession: (
    sessionId: string
  ) => Effect.Effect<SessionInfo | null, GentCoreError>

  readonly deleteSession: (
    sessionId: string
  ) => Effect.Effect<void, GentCoreError>

  readonly sendMessage: (
    input: SendMessageInput
  ) => Effect.Effect<void, GentCoreError>

  readonly listMessages: (
    branchId: string
  ) => Effect.Effect<MessageInfo[], GentCoreError>

  readonly listBranches: (
    sessionId: string
  ) => Effect.Effect<BranchInfo[], GentCoreError>

  readonly steer: (command: SteerCommand) => Effect.Effect<void, GentCoreError>

  readonly subscribeEvents: (
    sessionId: string
  ) => Stream.Stream<AgentEvent, never, never>
}

export class GentCore extends Context.Tag("GentCore")<
  GentCore,
  GentCoreService
>() {
  static Live: Layer.Layer<GentCore, never, Storage | AgentLoop | EventBus> =
    Layer.effect(
      GentCore,
      Effect.gen(function* () {
        const storage = yield* Storage
        const agentLoop = yield* AgentLoop
        const eventBus = yield* EventBus

        const service: GentCoreService = {
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

          sendMessage: Effect.fn("GentCore.sendMessage")(function* (input) {
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

          listBranches: (sessionId) =>
            Effect.gen(function* () {
              const branches = yield* storage.listBranches(sessionId)
              return branches.map((b) => ({
                id: b.id,
                sessionId: b.sessionId,
                createdAt: b.createdAt.getTime(),
              }))
            }),

          steer: (command) => agentLoop.steer(command),

          subscribeEvents: (sessionId) =>
            eventBus.subscribe().pipe(
              Stream.filter((e) => e.sessionId === sessionId)
            ),
        }

        return service
      })
    )
}
