import { Cause, ServiceMap, Effect, Layer, Schema, Stream } from "effect"
import { identity } from "effect/Function"
import {
  Session,
  Branch,
  Message,
  TextPart,
  type EventId,
  type EventEnvelope,
  EventStore,
  type EventStoreError,
  ErrorOccurred,
  SessionNameUpdated,
  PlanConfirmed,
  BranchCreated,
  BranchSwitched,
  BranchSummarized,
  AgentName,
  type MessagePart,
  type Task,
  type SessionId,
  type BranchId,
  type MessageId,
  type SessionTreeNode,
} from "@gent/core"
import { Storage, StorageError } from "@gent/storage"
import {
  Provider,
  type ProviderError,
  type ProviderAuthError,
  type ProviderService,
} from "@gent/providers"
import { AgentLoop, SteerCommand, AgentLoopError, CheckpointService } from "@gent/runtime"
import type { PlatformErrorSchema } from "./errors"
import { NotFoundError } from "./errors"

// Re-export for consumers
export { SteerCommand, AgentLoopError }
export { StorageError }
export { NotFoundError }

// ============================================================================
// Types
// ============================================================================

export interface CreateSessionInput {
  name?: string
  cwd?: string
  firstMessage?: string
  bypass?: boolean
  parentSessionId?: SessionId
  parentBranchId?: BranchId
}

export interface CreateSessionOutput {
  sessionId: SessionId
  branchId: BranchId
  name: string
  bypass: boolean
}

export interface CreateBranchInput {
  sessionId: SessionId
  name?: string
}

export interface CreateBranchOutput {
  branchId: BranchId
}

export interface SendMessageInput {
  sessionId: SessionId
  branchId: BranchId
  content: string
}

export interface SubscribeEventsInput {
  sessionId: SessionId
  branchId?: BranchId
  after?: number
}

export interface GetSessionStateInput {
  sessionId: SessionId
  branchId: BranchId
}

export interface SessionState {
  sessionId: SessionId
  branchId: BranchId
  messages: MessageInfo[]
  lastEventId: number | null
  isStreaming: boolean
  agent: AgentName
  bypass: boolean | undefined
}

export interface SessionInfo {
  id: SessionId
  name: string | undefined
  cwd: string | undefined
  bypass: boolean | undefined
  branchId: BranchId | undefined
  parentSessionId: SessionId | undefined
  parentBranchId: BranchId | undefined
  createdAt: number
  updatedAt: number
}

export interface BranchInfo {
  id: BranchId
  sessionId: SessionId
  parentBranchId: BranchId | undefined
  parentMessageId: MessageId | undefined
  name: string | undefined
  summary: string | undefined
  createdAt: number
}

export interface BranchTreeNode {
  id: BranchId
  name: string | undefined
  summary: string | undefined
  parentMessageId: MessageId | undefined
  messageCount: number
  createdAt: number
  children: readonly BranchTreeNode[]
}

type MutableBranchTreeNode = Omit<BranchTreeNode, "children"> & {
  children: MutableBranchTreeNode[]
}

export interface MessageInfo {
  id: MessageId
  sessionId: SessionId
  branchId: BranchId
  kind: "regular" | "interjection" | undefined
  role: "user" | "assistant" | "system" | "tool"
  parts: readonly MessagePart[]
  createdAt: number
  turnDurationMs: number | undefined
}

export type GentCoreError =
  | StorageError
  | AgentLoopError
  | PlatformErrorSchema
  | ProviderError
  | ProviderAuthError
  | EventStoreError
  | NotFoundError

// ============================================================================
// GentCore Service
// ============================================================================

export interface ApprovePlanInput {
  sessionId: SessionId
  branchId: BranchId
  planPath: string
  requestId?: string
  emitEvent?: boolean
}

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

  readonly getBranchTree: (sessionId: SessionId) => Effect.Effect<BranchTreeNode[], GentCoreError>

  readonly switchBranch: (input: {
    sessionId: SessionId
    fromBranchId: BranchId
    toBranchId: BranchId
    summarize?: boolean
  }) => Effect.Effect<void, GentCoreError>

  readonly forkBranch: (input: {
    sessionId: SessionId
    fromBranchId: BranchId
    atMessageId: MessageId
    name?: string
  }) => Effect.Effect<{ branchId: BranchId }, GentCoreError>

  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<void, GentCoreError>

  readonly listMessages: (branchId: BranchId) => Effect.Effect<MessageInfo[], GentCoreError>

  readonly listBranches: (sessionId: SessionId) => Effect.Effect<BranchInfo[], GentCoreError>

  readonly listTasks: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Task>, GentCoreError>

  readonly steer: (command: SteerCommand) => Effect.Effect<void, GentCoreError>

  readonly approvePlan: (input: ApprovePlanInput) => Effect.Effect<void, GentCoreError>

  readonly getSessionState: (
    input: GetSessionStateInput,
  ) => Effect.Effect<SessionState, GentCoreError>

  readonly subscribeEvents: (
    input: SubscribeEventsInput,
  ) => Stream.Stream<EventEnvelope, EventStoreError>

  readonly updateSessionBypass: (input: {
    sessionId: SessionId
    bypass: boolean
  }) => Effect.Effect<{ bypass: boolean }, GentCoreError>
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
  "@gent/server/src/core/GentCore",
) {
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
        createSession: (input) =>
          Effect.gen(function* () {
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
                }).pipe(
                  Effect.catchEager((e) => Effect.logWarning("session name generation failed", e)),
                  parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
                ),
              )

              // Fork sending the first message (non-blocking, starts agent loop)
              const message = new Message({
                id: Bun.randomUUIDv7() as MessageId,
                sessionId,
                branchId,
                role: "user",
                parts: [new TextPart({ type: "text", text: firstMessage })],
                createdAt: now,
              })
              yield* Effect.forkDetach(
                agentLoop.run(message, { bypass }).pipe(
                  Effect.withSpan("AgentLoop.firstMessage"),
                  Effect.catchCause((cause) => {
                    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                    return eventStore
                      .publish(
                        new ErrorOccurred({
                          sessionId,
                          branchId,
                          error: Cause.pretty(cause),
                        }),
                      )
                      .pipe(
                        Effect.catchEager((e) =>
                          Effect.logWarning("failed to publish ErrorOccurred event", e),
                        ),
                      )
                  }),
                  parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
                ),
              )
            }

            return { sessionId, branchId, name: placeholderName, bypass }
          }).pipe(Effect.withSpan("GentCore.createSession")),

        listSessions: () =>
          Effect.gen(function* () {
            const sessions = yield* storage.listSessions()
            const firstBranches = yield* storage.listFirstBranches()
            const branchMap = new Map(firstBranches.map((row) => [row.sessionId, row.branchId]))
            return sessions.map((s) => ({
              id: s.id,
              name: s.name,
              cwd: s.cwd,
              bypass: s.bypass,
              branchId: branchMap.get(s.id),
              parentSessionId: s.parentSessionId,
              parentBranchId: s.parentBranchId,
              createdAt: s.createdAt.getTime(),
              updatedAt: s.updatedAt.getTime(),
            }))
          }).pipe(Effect.withSpan("GentCore.listSessions")),

        getSession: (sessionId) =>
          Effect.gen(function* () {
            const session = yield* storage.getSession(sessionId)
            if (session === undefined) return null
            const branches = yield* storage.listBranches(sessionId)
            return {
              id: session.id,
              name: session.name,
              cwd: session.cwd,
              bypass: session.bypass,
              branchId: branches[0]?.id,
              parentSessionId: session.parentSessionId,
              parentBranchId: session.parentBranchId,
              createdAt: session.createdAt.getTime(),
              updatedAt: session.updatedAt.getTime(),
            }
          }).pipe(Effect.withSpan("GentCore.getSession")),

        getLastSessionByCwd: (cwd) =>
          Effect.gen(function* () {
            const session = yield* storage.getLastSessionByCwd(cwd)
            if (session === undefined) return null
            const branches = yield* storage.listBranches(session.id)
            return {
              id: session.id,
              name: session.name,
              cwd: session.cwd,
              bypass: session.bypass,
              branchId: branches[0]?.id,
              parentSessionId: session.parentSessionId,
              parentBranchId: session.parentBranchId,
              createdAt: session.createdAt.getTime(),
              updatedAt: session.updatedAt.getTime(),
            }
          }).pipe(Effect.withSpan("GentCore.getLastSessionByCwd")),

        deleteSession: (sessionId) => storage.deleteSession(sessionId),

        getChildSessions: (parentSessionId) =>
          Effect.gen(function* () {
            const children = yield* storage.getChildSessions(parentSessionId)
            const firstBranches = yield* storage.listFirstBranches()
            const branchMap = new Map(firstBranches.map((row) => [row.sessionId, row.branchId]))
            return children.map((s) => ({
              id: s.id,
              name: s.name,
              cwd: s.cwd,
              bypass: s.bypass,
              branchId: branchMap.get(s.id),
              parentSessionId: s.parentSessionId,
              parentBranchId: s.parentBranchId,
              createdAt: s.createdAt.getTime(),
              updatedAt: s.updatedAt.getTime(),
            }))
          }).pipe(Effect.withSpan("GentCore.getChildSessions")),

        getSessionTree: (rootSessionId) =>
          Effect.gen(function* () {
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
          }).pipe(Effect.withSpan("GentCore.getSessionTree")),

        createBranch: (input) =>
          Effect.gen(function* () {
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
          }).pipe(Effect.withSpan("GentCore.createBranch")),

        getBranchTree: (sessionId) =>
          Effect.gen(function* () {
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
              list.sort((a, b) => a.createdAt - b.createdAt)
              for (const node of list) {
                if (node.children.length > 0) sortNodes(node.children)
              }
            }
            sortNodes(roots)

            return roots
          }).pipe(Effect.withSpan("GentCore.getBranchTree")),

        switchBranch: (input) =>
          Effect.gen(function* () {
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
          }).pipe(Effect.withSpan("GentCore.switchBranch")),

        forkBranch: (input) =>
          Effect.gen(function* () {
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
          }).pipe(Effect.withSpan("GentCore.forkBranch")),

        sendMessage: Effect.fn("GentCore.sendMessage")(function* (input) {
          const session = yield* storage.getSession(input.sessionId)
          const bypass = session?.bypass ?? true

          // Capture caller's span so daemons inherit the traceId
          const parentSpan = yield* Effect.currentParentSpan.pipe(
            Effect.orElseSucceed(() => undefined),
          )

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

          const message = new Message({
            id: Bun.randomUUIDv7() as MessageId,
            sessionId: input.sessionId,
            branchId: input.branchId,
            kind: "regular",
            role: "user",
            parts: [new TextPart({ type: "text", text: input.content })],
            createdAt: new Date(),
          })

          // Run agent loop in background - don't wait for completion
          yield* Effect.forkDetach(
            agentLoop.run(message, { bypass }).pipe(
              Effect.withSpan("AgentLoop.background"),
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                return eventStore
                  .publish(
                    new ErrorOccurred({
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      error: Cause.pretty(cause),
                    }),
                  )
                  .pipe(
                    Effect.catchEager((e) =>
                      Effect.logWarning("failed to publish ErrorOccurred event", e),
                    ),
                  )
              }),
              parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
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
              kind: m.kind,
              role: m.role,
              parts: m.parts,
              createdAt: m.createdAt.getTime(),
              turnDurationMs: m.turnDurationMs,
            }))
          }).pipe(Effect.withSpan("GentCore.listMessages")),

        listBranches: (sessionId) =>
          Effect.gen(function* () {
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
          }).pipe(Effect.withSpan("GentCore.listBranches")),

        listTasks: (sessionId, branchId) =>
          storage.listTasks(sessionId, branchId).pipe(Effect.withSpan("GentCore.listTasks")),

        steer: (command) => agentLoop.steer(command),

        approvePlan: (input) =>
          Effect.gen(function* () {
            // Create plan checkpoint - hard reset context
            yield* checkpointService.createPlanCheckpoint(input.branchId, input.planPath)

            // Emit plan confirmed event
            if (input.emitEvent !== false) {
              yield* eventStore.publish(
                new PlanConfirmed({
                  sessionId: input.sessionId,
                  branchId: input.branchId,
                  requestId: input.requestId ?? Bun.randomUUIDv7(),
                  planPath: input.planPath,
                }),
              )
            }
          }).pipe(Effect.withSpan("GentCore.approvePlan")),

        getSessionState: (input) =>
          Effect.gen(function* () {
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
            }
          }).pipe(Effect.withSpan("GentCore.getSessionState")),

        updateSessionBypass: (input) =>
          Effect.gen(function* () {
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
          }).pipe(Effect.withSpan("GentCore.updateSessionBypass")),

        subscribeEvents: (input) =>
          eventStore.subscribe({
            sessionId: input.sessionId,
            ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
            ...(input.after !== undefined ? { after: input.after as EventId } : {}),
          }),
      }

      return service
    }),
  )
}
