import { Context, Effect, Layer } from "effect"
import type { Stream } from "effect"
import type { PlatformError } from "@effect/platform/Error"
import {
  Session,
  Branch,
  Message,
  TextPart,
  type EventEnvelope,
  EventStore,
  type EventStoreError,
  SessionNameUpdated,
  PlanConfirmed,
  ModelChanged,
  type AgentMode,
  type MessagePart,
} from "@gent/core"
import { Storage, StorageError } from "@gent/storage"
import type { ProviderError } from "@gent/providers"
import { Provider } from "@gent/providers"
import { AgentLoop, SteerCommand, AgentLoopError, CheckpointService } from "@gent/runtime"

// Re-export for consumers
export { SteerCommand, AgentLoopError }
export { StorageError }

// ============================================================================
// Types
// ============================================================================

export interface CreateSessionInput {
  name?: string
  cwd?: string
  firstMessage?: string
}

export interface CreateSessionOutput {
  sessionId: string
  branchId: string
  name: string
}

export interface CreateBranchInput {
  sessionId: string
  name?: string
}

export interface CreateBranchOutput {
  branchId: string
}

export interface SendMessageInput {
  sessionId: string
  branchId: string
  content: string
  mode?: AgentMode
  model?: string
}

export interface SubscribeEventsInput {
  sessionId: string
  branchId?: string
  after?: number
}

export interface GetSessionStateInput {
  sessionId: string
  branchId: string
}

export interface SessionState {
  sessionId: string
  branchId: string
  messages: MessageInfo[]
  lastEventId: number | null
  isStreaming: boolean
  mode: AgentMode
  model: string | undefined
}

export interface SessionInfo {
  id: string
  name: string | undefined
  cwd: string | undefined
  branchId: string | undefined
  createdAt: number
  updatedAt: number
}

export interface BranchInfo {
  id: string
  sessionId: string
  name: string | undefined
  model: string | undefined
  createdAt: number
}

export interface MessageInfo {
  id: string
  sessionId: string
  branchId: string
  role: "user" | "assistant" | "system" | "tool"
  parts: readonly MessagePart[]
  createdAt: number
  turnDurationMs: number | undefined
}

export type GentCoreError =
  | StorageError
  | AgentLoopError
  | PlatformError
  | ProviderError
  | EventStoreError

// ============================================================================
// GentCore Service
// ============================================================================

export interface ApprovePlanInput {
  sessionId: string
  branchId: string
  planPath: string
  requestId?: string
}

export interface GentCoreService {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<CreateSessionOutput, GentCoreError>

  readonly listSessions: () => Effect.Effect<SessionInfo[], GentCoreError>

  readonly getSession: (sessionId: string) => Effect.Effect<SessionInfo | null, GentCoreError>

  readonly getLastSessionByCwd: (cwd: string) => Effect.Effect<SessionInfo | null, GentCoreError>

  readonly deleteSession: (sessionId: string) => Effect.Effect<void, GentCoreError>

  readonly createBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<CreateBranchOutput, GentCoreError>

  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<void, GentCoreError>

  readonly listMessages: (branchId: string) => Effect.Effect<MessageInfo[], GentCoreError>

  readonly listBranches: (sessionId: string) => Effect.Effect<BranchInfo[], GentCoreError>

  readonly steer: (command: SteerCommand) => Effect.Effect<void, GentCoreError>

  readonly approvePlan: (input: ApprovePlanInput) => Effect.Effect<void, GentCoreError>

  readonly getSessionState: (input: GetSessionStateInput) => Effect.Effect<SessionState, GentCoreError>

  readonly subscribeEvents: (input: SubscribeEventsInput) => Stream.Stream<EventEnvelope, EventStoreError>
}

// Name generation model - using haiku for speed/cost
const NAME_GEN_MODEL = "anthropic/claude-haiku-4-5-20251001"

// Generate session name from first message (fire-and-forget)
const generateSessionName = Effect.fn("generateSessionName")(function* (
  provider: Provider["Type"],
  firstMessage: string,
) {
  const prompt = `Generate a 2-4 word title for a chat starting with: "${firstMessage.slice(0, 200)}". Reply with just the title, no quotes or punctuation.`
  const result = yield* provider
    .generate({
      model: NAME_GEN_MODEL,
      prompt,
      maxTokens: 20,
    })
    .pipe(Effect.catchAll(() => Effect.succeed("")))
  return result.trim() || "New Chat"
})

export class GentCore extends Context.Tag("GentCore")<GentCore, GentCoreService>() {
  static Live: Layer.Layer<
    GentCore,
    never,
    Storage | AgentLoop | EventStore | Provider | CheckpointService
  > = Layer.effect(
    GentCore,
    Effect.gen(function* () {
      const storage = yield* Storage
      const agentLoop = yield* AgentLoop
      const eventStore = yield* EventStore
      const provider = yield* Provider
      const checkpointService = yield* CheckpointService

      const service: GentCoreService = {
        createSession: (input) =>
          Effect.gen(function* () {
            const sessionId = Bun.randomUUIDv7()
            const branchId = Bun.randomUUIDv7()
            const now = new Date()

            // Start with placeholder name
            const placeholderName = input.name ?? "New Chat"

            const session = new Session({
              id: sessionId,
              name: placeholderName,
              cwd: input.cwd,
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

            const firstMessage = input.firstMessage
            if (firstMessage) {
              // Fork name generation (non-blocking)
              yield* Effect.forkDaemon(
                Effect.gen(function* () {
                  const generatedName = yield* generateSessionName(provider, firstMessage)
                  // Update session with generated name
                  const updatedSession = new Session({
                    ...session,
                    name: generatedName,
                    updatedAt: new Date(),
                  })
                  yield* storage.updateSession(updatedSession)
                  // Publish event for clients
                  yield* eventStore.publish(
                    new SessionNameUpdated({ sessionId, name: generatedName }),
                  )
                }).pipe(Effect.catchAll(() => Effect.void)),
              )

              // Fork sending the first message (non-blocking, starts agent loop)
              const message = new Message({
                id: Bun.randomUUIDv7(),
                sessionId,
                branchId,
                role: "user",
                parts: [new TextPart({ type: "text", text: firstMessage })],
                createdAt: now,
              })
              yield* Effect.forkDaemon(
                agentLoop.run(message).pipe(
                  Effect.withSpan("AgentLoop.firstMessage"),
                  Effect.catchAllCause(() => Effect.void),
                ),
              )
            }

            return { sessionId, branchId, name: placeholderName }
          }),

        listSessions: () =>
          Effect.gen(function* () {
            const sessions = yield* storage.listSessions()
            // Include first branch ID for each session
            const sessionsWithBranch = yield* Effect.all(
              sessions.map((s) =>
                Effect.gen(function* () {
                  const branches = yield* storage.listBranches(s.id)
                  return {
                    id: s.id,
                    name: s.name,
                    cwd: s.cwd,
                    branchId: branches[0]?.id,
                    createdAt: s.createdAt.getTime(),
                    updatedAt: s.updatedAt.getTime(),
                  }
                }),
              ),
            )
            return sessionsWithBranch
          }),

        getSession: (sessionId) =>
          Effect.gen(function* () {
            const session = yield* storage.getSession(sessionId)
            if (!session) return null
            const branches = yield* storage.listBranches(sessionId)
            return {
              id: session.id,
              name: session.name,
              cwd: session.cwd,
              branchId: branches[0]?.id,
              createdAt: session.createdAt.getTime(),
              updatedAt: session.updatedAt.getTime(),
            }
          }),

        getLastSessionByCwd: (cwd) =>
          Effect.gen(function* () {
            const session = yield* storage.getLastSessionByCwd(cwd)
            if (!session) return null
            const branches = yield* storage.listBranches(session.id)
            return {
              id: session.id,
              name: session.name,
              cwd: session.cwd,
              branchId: branches[0]?.id,
              createdAt: session.createdAt.getTime(),
              updatedAt: session.updatedAt.getTime(),
            }
          }),

        deleteSession: (sessionId) => storage.deleteSession(sessionId),

        createBranch: (input) =>
          Effect.gen(function* () {
            const branchId = Bun.randomUUIDv7()
            const branch = new Branch({
              id: branchId,
              sessionId: input.sessionId,
              name: input.name,
              createdAt: new Date(),
            })
            yield* storage.createBranch(branch)
            return { branchId }
          }),

        sendMessage: Effect.fn("GentCore.sendMessage")(function* (input) {
          // Switch mode if specified (before starting the run)
          if (input.mode) {
            yield* agentLoop.steer({ _tag: "SwitchMode", mode: input.mode })
          }

          // Update branch model if specified
          if (input.model) {
            yield* storage.updateBranchModel(input.branchId, input.model)
            yield* agentLoop.steer({ _tag: "SwitchModel", model: input.model })
            yield* eventStore.publish(
              new ModelChanged({
                sessionId: input.sessionId,
                branchId: input.branchId,
                model: input.model,
              }),
            )
          }

          yield* Effect.forkDaemon(
            Effect.gen(function* () {
              const session = yield* storage.getSession(input.sessionId)
              if (!session || session.name !== "New Chat") return
              const generatedName = yield* generateSessionName(provider, input.content)
              const updatedSession = new Session({
                ...session,
                name: generatedName,
                updatedAt: new Date(),
              })
              yield* storage.updateSession(updatedSession)
              yield* eventStore.publish(
                new SessionNameUpdated({ sessionId: input.sessionId, name: generatedName }),
              )
            }).pipe(Effect.catchAll(() => Effect.void)),
          )

          const message = new Message({
            id: Bun.randomUUIDv7(),
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
              Effect.catchAllCause(() => Effect.void),
            ),
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
              turnDurationMs: m.turnDurationMs,
            }))
          }),

        listBranches: (sessionId) =>
          Effect.gen(function* () {
            const branches = yield* storage.listBranches(sessionId)
            return branches.map((b) => ({
              id: b.id,
              sessionId: b.sessionId,
              name: b.name,
              model: b.model,
              createdAt: b.createdAt.getTime(),
            }))
          }),

        steer: (command) => agentLoop.steer(command),

        approvePlan: (input) =>
          Effect.gen(function* () {
            // Create plan checkpoint - hard reset context
            yield* checkpointService.createPlanCheckpoint(input.branchId, input.planPath)

            // Emit plan confirmed event
            yield* eventStore.publish(
              new PlanConfirmed({
                sessionId: input.sessionId,
                branchId: input.branchId,
                requestId: input.requestId ?? Bun.randomUUIDv7(),
                planPath: input.planPath,
              }),
            )
          }),

        getSessionState: (input) =>
          Effect.gen(function* () {
            const session = yield* storage.getSession(input.sessionId)
            if (!session) {
              return yield* new StorageError({ message: "Session not found" })
            }
            const branch = yield* storage.getBranch(input.branchId)
            if (!branch || branch.sessionId !== input.sessionId) {
              return yield* new StorageError({ message: "Branch not found" })
            }

            const messages = yield* storage.listMessages(input.branchId)
            const messageInfos = messages.map((m) => ({
              id: m.id,
              sessionId: m.sessionId,
              branchId: m.branchId,
              role: m.role,
              parts: m.parts,
              createdAt: m.createdAt.getTime(),
              turnDurationMs: m.turnDurationMs,
            }))

            const lastEventId = yield* storage.getLatestEventId({
              sessionId: input.sessionId,
              branchId: input.branchId,
            })

            const streamTag = yield* storage.getLatestEventTag({
              sessionId: input.sessionId,
              branchId: input.branchId,
              tags: ["StreamStarted", "StreamEnded"],
            })

            const modeTag = yield* storage.getLatestEventTag({
              sessionId: input.sessionId,
              branchId: input.branchId,
              tags: ["PlanModeEntered", "PlanConfirmed", "PlanRejected"],
            })

            return {
              sessionId: input.sessionId,
              branchId: input.branchId,
              messages: messageInfos,
              lastEventId: lastEventId ?? null,
              isStreaming: streamTag === "StreamStarted",
              mode: modeTag === "PlanConfirmed" ? "build" : "plan",
              model: branch.model,
            }
          }),

        subscribeEvents: (input) =>
          eventStore.subscribe({
            sessionId: input.sessionId,
            ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
            ...(input.after !== undefined
              ? { after: input.after as EventEnvelope["id"] }
              : {}),
          }),
      }

      return service
    }),
  )
}
