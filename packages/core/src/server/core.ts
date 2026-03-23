import { ServiceMap, Effect, Layer, Schema, Stream } from "effect"
import { identity } from "effect/Function"
import type { SessionId, BranchId, MessageId } from "../domain/ids.js"
import { Session, Branch, Message, TextPart, type SessionTreeNode } from "../domain/message.js"
import {
  EventStore,
  type EventId,
  type EventEnvelope,
  type EventStoreError,
  SessionNameUpdated,
  BranchCreated,
  BranchSwitched,
  BranchSummarized,
} from "../domain/event.js"
import { AgentName } from "../domain/agent.js"
import { Permission, PermissionRule } from "../domain/permission.js"
import { PermissionHandler, PromptHandler, HandoffHandler } from "../domain/interaction-handlers.js"
import type { Task } from "../domain/task.js"
import type { QueueSnapshot } from "../domain/queue.js"
import { Storage, StorageError } from "../storage/sqlite-storage.js"
import { Provider, type ProviderError, type ProviderService } from "../providers/provider.js"
import type { ProviderAuthError } from "../providers/provider-auth.js"
import { ActorProcess, type ActorProcessError } from "../runtime/actor-process.js"
import { SteerCommand, AgentLoopError } from "../runtime/agent/agent-loop.js"
import { ConfigService } from "../runtime/config-service.js"
import type { PlatformErrorSchema } from "./errors"
import { NotFoundError } from "./errors"
import type {
  CreateSessionInput,
  CreateSessionResult as CreateSessionOutput,
  CreateBranchInput,
  CreateBranchResult as CreateBranchOutput,
  SendMessageInput,
  SubscribeEventsInput,
  GetSessionStateInput,
  SessionState,
  SessionInfo,
  BranchInfo,
  BranchTreeNode as TransportBranchTreeNode,
  MessageInfoReadonly as MessageInfo,
  SwitchBranchInput,
  ForkBranchInput,
  UpdateSessionBypassInput,
  UpdateSessionBypassResult,
  UpdateSessionReasoningLevelInput,
  UpdateSessionReasoningLevelResult,
  RespondPermissionInput,
  RespondPromptInput,
  RespondHandoffInput,
  RespondHandoffResult,
} from "./transport-contract.js"

// Re-export for consumers
export { SteerCommand, AgentLoopError }
export { StorageError }
export { NotFoundError }

type MutableBranchTreeNode = Omit<TransportBranchTreeNode, "children"> & {
  children: MutableBranchTreeNode[]
}

export type GentCoreError =
  | StorageError
  | AgentLoopError
  | ActorProcessError
  | PlatformErrorSchema
  | ProviderError
  | ProviderAuthError
  | EventStoreError
  | NotFoundError

// ============================================================================
// GentCore Service
// ============================================================================

export interface GentCoreService {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<CreateSessionOutput, GentCoreError>

  readonly listSessions: () => Effect.Effect<SessionInfo[], GentCoreError>

  readonly getSession: (sessionId: SessionId) => Effect.Effect<SessionInfo | null, GentCoreError>

  readonly getLastSessionByCwd: (cwd: string) => Effect.Effect<SessionInfo | null, GentCoreError>

  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, GentCoreError>

  readonly getChildSessions: (
    parentSessionId: SessionId,
  ) => Effect.Effect<SessionInfo[], GentCoreError>

  readonly getSessionTree: (
    rootSessionId: SessionId,
  ) => Effect.Effect<SessionTreeNode, GentCoreError>

  readonly createBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<CreateBranchOutput, GentCoreError>

  readonly getBranchTree: (
    sessionId: SessionId,
  ) => Effect.Effect<TransportBranchTreeNode[], GentCoreError>

  readonly switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, GentCoreError>

  readonly forkBranch: (input: ForkBranchInput) => Effect.Effect<CreateBranchOutput, GentCoreError>

  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<void, GentCoreError>

  readonly listMessages: (branchId: BranchId) => Effect.Effect<MessageInfo[], GentCoreError>

  readonly listBranches: (sessionId: SessionId) => Effect.Effect<BranchInfo[], GentCoreError>

  readonly listTasks: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Task>, GentCoreError>

  readonly drainQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, GentCoreError>

  readonly getQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, GentCoreError>

  readonly steer: (command: SteerCommand) => Effect.Effect<void, GentCoreError>

  readonly getSessionState: (
    input: GetSessionStateInput,
  ) => Effect.Effect<SessionState, GentCoreError>

  readonly subscribeEvents: (
    input: SubscribeEventsInput,
  ) => Stream.Stream<EventEnvelope, EventStoreError>

  readonly updateSessionBypass: (
    input: UpdateSessionBypassInput,
  ) => Effect.Effect<UpdateSessionBypassResult, GentCoreError>

  readonly updateSessionReasoningLevel: (
    input: UpdateSessionReasoningLevelInput,
  ) => Effect.Effect<UpdateSessionReasoningLevelResult, GentCoreError>

  // Interaction response methods (centralized business logic)
  readonly respondPermission: (input: RespondPermissionInput) => Effect.Effect<void, GentCoreError>

  readonly respondPrompt: (input: RespondPromptInput) => Effect.Effect<void, GentCoreError>

  readonly respondHandoff: (
    input: RespondHandoffInput,
  ) => Effect.Effect<RespondHandoffResult, GentCoreError>
}

// Name generation model - using haiku for speed/cost
const NAME_GEN_MODEL = "anthropic/claude-haiku-4-5-20251001"

// Generate session name from first message (fire-and-forget)
const generateSessionName = Effect.fn("generateSessionName")(function* (
  provider: ProviderService,
  firstMessage: string,
) {
  const prompt = [
    "Generate a 3-5 word lowercase title for a conversation that starts with the following message.",
    "Rules:",
    "- Lowercase only, no quotes, no punctuation",
    "- Be specific to the content, not generic",
    '- Bad: "help with code", "quick question", "new project"',
    '- Good: "fix auth token refresh", "add dark mode toggle", "migrate postgres to sqlite"',
    "",
    `Message: "${firstMessage.slice(0, 300)}"`,
    "",
    "Title:",
  ].join("\n")

  // Try up to 2 times if we get an empty/generic result
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = yield* provider
      .generate({
        model: NAME_GEN_MODEL,
        prompt,
        maxTokens: 30,
      })
      .pipe(Effect.catchEager(() => Effect.succeed("")))

    const name = result
      .trim()
      .replace(/^["']|["']$/g, "") // strip quotes
      .replace(/\.$/g, "") // strip trailing period
      .toLowerCase()

    if (name.length > 0 && name !== "new chat" && name !== "untitled") {
      return name
    }
  }

  return "New Chat"
})

export class GentCore extends ServiceMap.Service<GentCore, GentCoreService>()(
  "@gent/core/src/server/core/GentCore",
) {
  static Live: Layer.Layer<
    GentCore,
    never,
    | Storage
    | ActorProcess
    | EventStore
    | Provider
    | PermissionHandler
    | PromptHandler
    | HandoffHandler
    | Permission
    | ConfigService
  > = Layer.effect(
    GentCore,
    Effect.gen(function* () {
      const storage = yield* Storage
      const actorProcess = yield* ActorProcess
      const eventStore = yield* EventStore
      const provider = yield* Provider
      const permissionHandler = yield* PermissionHandler
      const promptHandler = yield* PromptHandler
      const handoffHandler = yield* HandoffHandler
      const permission = yield* Permission
      const configService = yield* ConfigService

      const summarizeBranch = Effect.fn("GentCore.summarizeBranch")(function* (branchId: BranchId) {
        const messages = yield* storage.listMessages(branchId)
        if (messages.length === 0) return ""
        const firstMessage = messages[0]
        if (firstMessage === undefined) return ""

        const recent = messages.slice(-50)
        const conversation = recent
          .map((m) => {
            const text = m.parts
              .filter((p): p is TextPart => p.type === "text")
              .map((p) => p.text)
              .join("\n")
            return text !== "" ? `${m.role}: ${text}` : ""
          })
          .filter((line) => line.trim().length > 0)
          .join("\n\n")

        if (conversation === "") return ""

        const prompt = `Summarize this branch concisely. Focus on decisions, open questions, and current state. Keep it short and actionable.

Branch conversation (recent):
${conversation}`

        const summaryMessage = new Message({
          id: Bun.randomUUIDv7() as MessageId,
          sessionId: firstMessage.sessionId,
          branchId,
          role: "user",
          parts: [new TextPart({ type: "text", text: prompt })],
          createdAt: new Date(),
        })

        const streamEffect = yield* provider.stream({
          model: NAME_GEN_MODEL,
          messages: [summaryMessage],
          maxTokens: 400,
        })

        const parts: string[] = []
        yield* Stream.runForEach(streamEffect, (chunk) =>
          Effect.sync(() => {
            if (chunk._tag === "TextChunk") {
              parts.push(chunk.text)
            }
          }),
        )

        return parts.join("").trim()
      })

      const service: GentCoreService = {
        createSession: Effect.fn("GentCore.createSession")(function* (input) {
          const sessionId = Bun.randomUUIDv7() as SessionId

          // Validate parent session exists if specified
          if (input.parentSessionId !== undefined) {
            const parent = yield* storage.getSession(input.parentSessionId)
            if (parent === undefined) {
              return yield* new NotFoundError({
                message: `Parent session not found: ${input.parentSessionId}`,
                entity: "session",
              })
            }
          }

          const branchId = Bun.randomUUIDv7() as BranchId
          const now = new Date()

          // Start with placeholder name
          const placeholderName = input.name ?? "New Chat"
          const bypass = input.bypass ?? true

          const session = new Session({
            id: sessionId,
            name: placeholderName,
            cwd: input.cwd,
            bypass,
            parentSessionId: input.parentSessionId,
            parentBranchId: input.parentBranchId,
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
          if (firstMessage !== undefined) {
            // Capture caller's span so daemons inherit the traceId
            const parentSpan = yield* Effect.currentParentSpan.pipe(
              Effect.orElseSucceed(() => undefined),
            )

            // Fork name generation (non-blocking)
            yield* Effect.forkDetach(
              Effect.gen(function* () {
                const generatedName = yield* generateSessionName(provider, firstMessage)
                const updatedSession = new Session({
                  ...session,
                  name: generatedName,
                  updatedAt: new Date(),
                })
                yield* storage.updateSession(updatedSession)
                yield* eventStore.publish(
                  new SessionNameUpdated({ sessionId, name: generatedName }),
                )
              }).pipe(
                Effect.catchEager((e) => Effect.logWarning("session name generation failed", e)),
                parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
              ),
            )

            // Route through ActorProcess — handles Message construction, forkDetach, error handling
            yield* actorProcess.sendUserMessage({
              sessionId,
              branchId,
              content: firstMessage,
              bypass,
            })
          }

          return { sessionId, branchId, name: placeholderName, bypass }
        }),

        listSessions: Effect.fn("GentCore.listSessions")(function* () {
          const sessions = yield* storage.listSessions()
          const firstBranches = yield* storage.listFirstBranches()
          const branchMap = new Map(firstBranches.map((row) => [row.sessionId, row.branchId]))
          return sessions.map((s) => ({
            id: s.id,
            name: s.name,
            cwd: s.cwd,
            bypass: s.bypass,
            reasoningLevel: s.reasoningLevel,
            branchId: branchMap.get(s.id),
            parentSessionId: s.parentSessionId,
            parentBranchId: s.parentBranchId,
            createdAt: s.createdAt.getTime(),
            updatedAt: s.updatedAt.getTime(),
          }))
        }),

        getSession: Effect.fn("GentCore.getSession")(function* (sessionId) {
          const session = yield* storage.getSession(sessionId)
          if (session === undefined) return null
          const branches = yield* storage.listBranches(sessionId)
          return {
            id: session.id,
            name: session.name,
            cwd: session.cwd,
            bypass: session.bypass,
            reasoningLevel: session.reasoningLevel,
            branchId: branches[0]?.id,
            parentSessionId: session.parentSessionId,
            parentBranchId: session.parentBranchId,
            createdAt: session.createdAt.getTime(),
            updatedAt: session.updatedAt.getTime(),
          }
        }),

        getLastSessionByCwd: Effect.fn("GentCore.getLastSessionByCwd")(function* (cwd) {
          const session = yield* storage.getLastSessionByCwd(cwd)
          if (session === undefined) return null
          const branches = yield* storage.listBranches(session.id)
          return {
            id: session.id,
            name: session.name,
            cwd: session.cwd,
            bypass: session.bypass,
            reasoningLevel: session.reasoningLevel,
            branchId: branches[0]?.id,
            parentSessionId: session.parentSessionId,
            parentBranchId: session.parentBranchId,
            createdAt: session.createdAt.getTime(),
            updatedAt: session.updatedAt.getTime(),
          }
        }),

        deleteSession: (sessionId) => storage.deleteSession(sessionId),

        getChildSessions: Effect.fn("GentCore.getChildSessions")(function* (parentSessionId) {
          const children = yield* storage.getChildSessions(parentSessionId)
          const firstBranches = yield* storage.listFirstBranches()
          const branchMap = new Map(firstBranches.map((row) => [row.sessionId, row.branchId]))
          return children.map((s) => ({
            id: s.id,
            name: s.name,
            cwd: s.cwd,
            bypass: s.bypass,
            reasoningLevel: s.reasoningLevel,
            branchId: branchMap.get(s.id),
            parentSessionId: s.parentSessionId,
            parentBranchId: s.parentBranchId,
            createdAt: s.createdAt.getTime(),
            updatedAt: s.updatedAt.getTime(),
          }))
        }),

        getSessionTree: Effect.fn("GentCore.getSessionTree")(function* (rootSessionId) {
          // BFS build of session tree
          const rootSession = yield* storage.getSession(rootSessionId)
          if (rootSession === undefined) {
            return yield* new NotFoundError({
              message: `Session not found: ${rootSessionId}`,
              entity: "session",
            })
          }

          const buildNode = (session: Session): Effect.Effect<SessionTreeNode, GentCoreError> =>
            Effect.gen(function* () {
              const children = yield* storage.getChildSessions(session.id)
              const childNodes = yield* Effect.forEach(children, buildNode, { concurrency: 5 })
              return { session, children: childNodes }
            })

          return yield* buildNode(rootSession)
        }),

        createBranch: Effect.fn("GentCore.createBranch")(function* (input) {
          const branchId = Bun.randomUUIDv7() as BranchId
          const branch = new Branch({
            id: branchId,
            sessionId: input.sessionId,
            name: input.name,
            createdAt: new Date(),
          })
          yield* storage.createBranch(branch)
          yield* eventStore.publish(
            new BranchCreated({
              sessionId: input.sessionId,
              branchId,
              ...(branch.parentBranchId !== undefined
                ? { parentBranchId: branch.parentBranchId }
                : {}),
              ...(branch.parentMessageId !== undefined
                ? { parentMessageId: branch.parentMessageId }
                : {}),
            }),
          )
          return { branchId }
        }),

        getBranchTree: Effect.fn("GentCore.getBranchTree")(function* (sessionId) {
          const branches = yield* storage.listBranches(sessionId)
          const branchIds = branches.map((b) => b.id)
          const messageCounts = yield* storage.countMessagesByBranches(branchIds)
          const nodes = new Map<BranchId, MutableBranchTreeNode>()

          for (const branch of branches) {
            const messageCount = messageCounts.get(branch.id) ?? 0
            nodes.set(branch.id, {
              id: branch.id,
              name: branch.name,
              summary: branch.summary,
              parentMessageId: branch.parentMessageId,
              messageCount,
              createdAt: branch.createdAt.getTime(),
              children: [],
            })
          }

          const roots: MutableBranchTreeNode[] = []
          for (const branch of branches) {
            const node = nodes.get(branch.id)
            if (node === undefined) continue
            if (
              branch.parentBranchId !== undefined &&
              branch.parentBranchId !== "" &&
              nodes.has(branch.parentBranchId)
            ) {
              const parent = nodes.get(branch.parentBranchId)
              if (parent !== undefined) parent.children.push(node)
            } else {
              roots.push(node)
            }
          }

          const sortNodes = (list: MutableBranchTreeNode[]) => {
            list.sort((a, b) => a["createdAt"] - b["createdAt"])
            for (const node of list) {
              if (node.children.length > 0) sortNodes(node.children)
            }
          }
          sortNodes(roots)

          return roots
        }),

        switchBranch: Effect.fn("GentCore.switchBranch")(function* (input) {
          const fromBranch = yield* storage.getBranch(input.fromBranchId)
          if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
            return yield* new NotFoundError({
              message: "From branch not found",
              entity: "branch",
            })
          }
          const toBranch = yield* storage.getBranch(input.toBranchId)
          if (toBranch === undefined || toBranch.sessionId !== input.sessionId) {
            return yield* new NotFoundError({ message: "To branch not found", entity: "branch" })
          }

          const shouldSummarize = input.summarize !== false
          if (shouldSummarize && input.fromBranchId !== input.toBranchId) {
            const summary = yield* summarizeBranch(input.fromBranchId).pipe(
              Effect.catchEager(() => Effect.succeed("")),
            )
            if (summary !== "") {
              yield* storage.updateBranchSummary(input.fromBranchId, summary)
              yield* eventStore.publish(
                new BranchSummarized({
                  sessionId: input.sessionId,
                  branchId: input.fromBranchId,
                  summary,
                }),
              )
            }
          }

          yield* eventStore.publish(
            new BranchSwitched({
              sessionId: input.sessionId,
              fromBranchId: input.fromBranchId,
              toBranchId: input.toBranchId,
            }),
          )
        }),

        forkBranch: Effect.fn("GentCore.forkBranch")(function* (input) {
          const fromBranch = yield* storage.getBranch(input.fromBranchId)
          if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
            return yield* new NotFoundError({ message: "Branch not found", entity: "branch" })
          }

          const messages = yield* storage.listMessages(input.fromBranchId)
          const targetIndex = messages.findIndex((m) => m.id === input.atMessageId)
          if (targetIndex === -1) {
            return yield* new NotFoundError({
              message: "Message not found in branch",
              entity: "message",
            })
          }

          const branchId = Bun.randomUUIDv7() as BranchId
          const now = new Date()
          const branch = new Branch({
            id: branchId,
            sessionId: input.sessionId,
            parentBranchId: input.fromBranchId,
            parentMessageId: input.atMessageId,
            name: input.name,
            createdAt: now,
          })
          yield* storage.createBranch(branch)

          const messagesToCopy = messages.slice(0, targetIndex + 1)
          for (const message of messagesToCopy) {
            yield* storage.createMessage(
              new Message({
                id: Bun.randomUUIDv7() as MessageId,
                sessionId: message.sessionId,
                branchId,
                role: message.role,
                parts: message.parts,
                createdAt: message.createdAt,
                ...(message.turnDurationMs !== undefined
                  ? { turnDurationMs: message.turnDurationMs }
                  : {}),
              }),
            )
          }

          yield* eventStore.publish(
            new BranchCreated({
              sessionId: input.sessionId,
              branchId,
              ...(branch.parentBranchId !== undefined
                ? { parentBranchId: branch.parentBranchId }
                : {}),
              ...(branch.parentMessageId !== undefined
                ? { parentMessageId: branch.parentMessageId }
                : {}),
            }),
          )

          return { branchId }
        }),

        sendMessage: Effect.fn("GentCore.sendMessage")(function* (input) {
          const session = yield* storage.getSession(input.sessionId)

          // Capture caller's span so daemons inherit the traceId
          const parentSpan = yield* Effect.currentParentSpan.pipe(
            Effect.orElseSucceed(() => undefined),
          )

          // Fork name generation (non-blocking, separate concern)
          yield* Effect.forkDetach(
            Effect.gen(function* () {
              if (session === undefined || session.name !== "New Chat") return
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
            }).pipe(
              Effect.catchEager((e) => Effect.logWarning("session name generation failed", e)),
              parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
            ),
          )

          // Route through ActorProcess — handles Message construction, forkDetach, error handling
          yield* actorProcess.sendUserMessage({
            sessionId: input.sessionId,
            branchId: input.branchId,
            content: input.content,
          })
        }),

        listMessages: Effect.fn("GentCore.listMessages")(function* (branchId) {
          return yield* Effect.gen(function* () {
            const messages = yield* storage.listMessages(branchId)
            return messages.map((m) => ({
              id: m.id,
              sessionId: m.sessionId,
              branchId: m.branchId,
              kind: m.kind,
              role: m.role,
              parts: m.parts,
              createdAt: m.createdAt.getTime(),
              turnDurationMs: m.turnDurationMs,
            }))
          })
        }),

        listBranches: Effect.fn("GentCore.listBranches")(function* (sessionId) {
          return yield* Effect.gen(function* () {
            const branches = yield* storage.listBranches(sessionId)
            return branches.map((b) => ({
              id: b.id,
              sessionId: b.sessionId,
              parentBranchId: b.parentBranchId,
              parentMessageId: b.parentMessageId,
              name: b.name,
              summary: b.summary,
              createdAt: b.createdAt.getTime(),
            }))
          })
        }),

        listTasks: (sessionId, branchId) =>
          storage.listTasks(sessionId, branchId).pipe(Effect.withSpan("GentCore.listTasks")),

        drainQueuedMessages: ({ sessionId, branchId }) =>
          actorProcess
            .drainQueuedMessages({ sessionId, branchId })
            .pipe(Effect.withSpan("GentCore.drainQueuedMessages")),

        getQueuedMessages: ({ sessionId, branchId }) =>
          actorProcess
            .getQueuedMessages({ sessionId, branchId })
            .pipe(Effect.withSpan("GentCore.getQueuedMessages")),

        steer: (command) => actorProcess.steerAgent(command),

        getSessionState: Effect.fn("GentCore.getSessionState")(function* (input) {
          return yield* Effect.gen(function* () {
            const session = yield* storage.getSession(input.sessionId)
            if (session === undefined) {
              return yield* new NotFoundError({ message: "Session not found", entity: "session" })
            }
            const branch = yield* storage.getBranch(input.branchId)
            if (branch === undefined || branch.sessionId !== input.sessionId) {
              return yield* new NotFoundError({ message: "Branch not found", entity: "branch" })
            }

            const messages = yield* storage.listMessages(input.branchId)
            const messageInfos = messages.map((m) => ({
              id: m.id,
              sessionId: m.sessionId,
              branchId: m.branchId,
              kind: m.kind,
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

            const latestAgentEvent = yield* storage.getLatestEvent({
              sessionId: input.sessionId,
              branchId: input.branchId,
              tags: ["AgentSwitched"],
            })
            const raw =
              latestAgentEvent !== undefined && latestAgentEvent._tag === "AgentSwitched"
                ? latestAgentEvent.toAgent
                : undefined
            const currentAgent: AgentName = Schema.is(AgentName)(raw) ? raw : "cowork"

            return {
              sessionId: input.sessionId,
              branchId: input.branchId,
              messages: messageInfos,
              lastEventId: lastEventId ?? null,
              isStreaming: streamTag === "StreamStarted",
              agent: currentAgent,
              bypass: session.bypass,
              reasoningLevel: session.reasoningLevel,
            }
          })
        }),

        updateSessionBypass: Effect.fn("GentCore.updateSessionBypass")(function* (input) {
          return yield* Effect.gen(function* () {
            const session = yield* storage.getSession(input.sessionId)
            if (session === undefined) {
              return yield* new NotFoundError({ message: "Session not found", entity: "session" })
            }
            const updated = new Session({
              ...session,
              bypass: input.bypass,
              updatedAt: new Date(),
            })
            yield* storage.updateSession(updated)
            return { bypass: input.bypass }
          })
        }),

        updateSessionReasoningLevel: Effect.fn("GentCore.updateSessionReasoningLevel")(
          function* (input) {
            return yield* Effect.gen(function* () {
              const session = yield* storage.getSession(input.sessionId)
              if (session === undefined) {
                return yield* new NotFoundError({ message: "Session not found", entity: "session" })
              }
              const updated = new Session({
                ...session,
                reasoningLevel: input.reasoningLevel,
                updatedAt: new Date(),
              })
              yield* storage.updateSession(updated)
              return { reasoningLevel: input.reasoningLevel }
            })
          },
        ),

        subscribeEvents: (input) =>
          eventStore.subscribe({
            sessionId: input.sessionId,
            ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
            ...(input.after !== undefined ? { after: input.after as EventId } : {}),
          }),

        respondPermission: Effect.fn("GentCore.respondPermission")(function* (input) {
          return yield* Effect.gen(function* () {
            const request = yield* permissionHandler.respond(input.requestId, input.decision)
            if (input.persist === true && request !== undefined) {
              const rule = new PermissionRule({
                tool: request.toolName,
                action: input.decision,
              })
              yield* configService.addPermissionRule(rule)
              yield* permission.addRule(rule)
            }
          })
        }),

        respondPrompt: (input) =>
          promptHandler
            .respond(input.requestId, input.decision, input.content)
            .pipe(Effect.asVoid, Effect.withSpan("GentCore.respondPrompt")),

        respondHandoff: Effect.fn("GentCore.respondHandoff")(function* (input) {
          return yield* Effect.gen(function* () {
            if (input.decision !== "confirm") {
              yield* handoffHandler.respond(input.requestId, "reject", undefined, input.reason)
              return { childSessionId: undefined, childBranchId: undefined }
            }

            // Atomic claim — prevents duplicate child sessions on double-confirm
            const entry = yield* handoffHandler.claim(input.requestId)
            if (entry === undefined) {
              return { childSessionId: undefined, childBranchId: undefined }
            }

            const parentSession = yield* service.getSession(entry.sessionId)
            const result = yield* service.createSession({
              firstMessage: `[Handoff]\n\n${entry.summary}`,
              ...(parentSession?.cwd !== undefined ? { cwd: parentSession.cwd } : {}),
              ...(parentSession?.bypass !== undefined ? { bypass: parentSession.bypass } : {}),
              parentSessionId: entry.sessionId,
              parentBranchId: entry.branchId,
            })

            yield* handoffHandler.respond(input.requestId, "confirm", result.sessionId)
            return { childSessionId: result.sessionId, childBranchId: result.branchId }
          })
        }),
      }

      return service
    }),
  )
}
