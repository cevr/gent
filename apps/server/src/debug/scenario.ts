import { Clock, DateTime, Effect, Ref, Schema } from "effect"
import {
  AgentSwitched,
  EventStore,
  MessageReceived,
  ProviderRetrying,
  StreamChunk,
  StreamEnded,
  StreamStarted,
  AgentRunSpawned,
  AgentRunSucceeded,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "@gent/core/domain/event.js"
import {
  Branch,
  Message,
  ReasoningPart,
  Session,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "@gent/core/domain/message.js"
import {
  BranchId,
  ExtensionId,
  MessageId,
  RpcId,
  SessionId,
  ToolCallId,
} from "@gent/core/domain/ids.js"
import { SessionStorage } from "@gent/core/storage/session-storage.js"
import { BranchStorage } from "@gent/core/storage/branch-storage.js"
import { MessageStorage } from "@gent/core/storage/message-storage.js"
import { ExtensionRegistry } from "@gent/core/runtime/extensions/registry.js"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform.js"
import type { CapabilityError, CapabilityNotFoundError } from "@gent/core/domain/capability.js"
import { ref } from "@gent/core/extensions/api"
import {
  TaskCreateRequest,
  TaskDeleteRequest,
  TaskListRequest,
  TaskUpdateRequest,
} from "@gent/extensions/task-tools/requests.js"

const TaskCreateRef = ref(TaskCreateRequest)
const TaskDeleteRef = ref(TaskDeleteRequest)
const TaskListRef = ref(TaskListRequest)
const TaskUpdateRef = ref(TaskUpdateRequest)

export interface DebugScenarioParams {
  sessionId: SessionId
  branchId: BranchId
  cwd: string
}

const makeText = (text: string) => new TextPart({ type: "text", text })

const asToolCallId = (value: string) => ToolCallId.make(value)
const DebugJson = Schema.fromJsonString(Schema.Unknown)
const encodeDebugJson = Schema.encodeSync(DebugJson)

const makeJsonResult = (toolCallId: ToolCallId, toolName: string, value: unknown) =>
  new ToolResultPart({
    type: "tool-result",
    toolCallId,
    toolName,
    output: { type: "json", value },
  })

const createParentTurnMessages = (
  params: DebugScenarioParams,
  iteration: number,
  delegateToolCallId: ToolCallId,
  reviewToolCallId: ToolCallId,
  searchSessionsToolCallId: ToolCallId,
  readSessionToolCallId: ToolCallId,
) => {
  const now = new Date()

  const assistant = Message.Regular.make({
    id: MessageId.make(Bun.randomUUIDv7()),
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "assistant",
    parts: [
      new ReasoningPart({
        type: "reasoning",
        text: "Scripted debug scenario. Exercise child sessions, task chrome, retries, and tool output renderers.",
      }),
      makeText(`Running debug inspection cycle ${iteration}.`),
      new ToolCallPart({
        type: "tool-call",
        toolCallId: delegateToolCallId,
        toolName: "delegate",
        input: { tasks: [{ agent: "explore", task: "Inspect the TUI tool chrome" }] },
      }),
      new ToolCallPart({
        type: "tool-call",
        toolCallId: reviewToolCallId,
        toolName: "review",
        input: { description: `Review debug cycle ${iteration}` },
      }),
      new ToolCallPart({
        type: "tool-call",
        toolCallId: searchSessionsToolCallId,
        toolName: "search_sessions",
        input: { query: "tool renderer" },
      }),
      new ToolCallPart({
        type: "tool-call",
        toolCallId: readSessionToolCallId,
        toolName: "read_session",
        input: {
          sessionId: "019debug1-session",
          goal: "Understand the renderer cleanup thread",
        },
      }),
      makeText("Inspection pass complete. Check the live tool timeline and task widget."),
    ],
    createdAt: new Date(now.getTime() + 1),
  })

  const tool = Message.Regular.make({
    id: MessageId.make(Bun.randomUUIDv7()),
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "tool",
    parts: [
      makeJsonResult(delegateToolCallId, "delegate", {
        output: "Explorer finished.",
        metadata: {
          mode: "parallel",
          results: [
            {
              _tag: "success",
              agentName: "explore",
              text: "Live child session completed read + grep before reporting back.",
              usage: { input: 181, output: 64, cost: 0.01 },
              toolCalls: [
                {
                  toolName: "read",
                  args: { path: `${params.cwd}/apps/tui/src/components/message-list.tsx` },
                  isError: false,
                },
                {
                  toolName: "grep",
                  args: { pattern: "ToolFrame", path: `${params.cwd}/apps/tui/src` },
                  isError: false,
                },
              ],
            },
          ],
          usage: { input: 181, output: 64, cost: 0.01 },
        },
      }),
      makeJsonResult(reviewToolCallId, "review", {
        summary: { critical: 0, high: 0, medium: 1, low: 0 },
        comments: [
          {
            file: "apps/tui/src/routes/session.tsx",
            line: 220,
            severity: "medium",
            type: "bug",
            text: "Pending steer badges should disappear as soon as the interjection flushes.",
          },
        ],
      }),
      makeJsonResult(searchSessionsToolCallId, "search_sessions", {
        totalMatches: 2,
        sessions: [
          {
            sessionId: "019debug1",
            name: "tui renderer cleanup",
            lastActivity: "2026-03-22T18:30:00.000Z",
            excerpts: ["tool rendering in the TUI is a bit broken"],
          },
        ],
      }),
      makeJsonResult(readSessionToolCallId, "read_session", {
        sessionId: "019debug1-session",
        extracted: true,
        goal: "Understand the renderer cleanup thread",
        content:
          "User wanted debug mode to exercise renderer chrome, retries, and queued message semantics.",
        messageCount: 24,
        branchCount: 1,
      }),
    ],
    createdAt: new Date(now.getTime() + 2),
  })

  return { assistant, tool }
}

const persistDebugUserMessage = (params: DebugScenarioParams, iteration: number) =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const eventStore = yield* EventStore
    const user = Message.Regular.make({
      id: MessageId.make(Bun.randomUUIDv7()),
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "user",
      parts: [makeText(`Run debug inspection cycle ${iteration}.`)],
      createdAt: yield* DateTime.nowAsDate,
    })

    yield* messageStorage.createMessage(user)
    yield* eventStore.publish(
      MessageReceived.make({
        message: user,
      }),
    )
  })

const createChildSession = (parent: DebugScenarioParams, iteration: number) =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const branchStorage = yield* BranchStorage
    const sessionId = SessionId.make(Bun.randomUUIDv7())
    const branchId = BranchId.make(Bun.randomUUIDv7())
    const now = yield* DateTime.nowAsDate

    yield* sessionStorage.createSession(
      new Session({
        id: sessionId,
        name: `debug child ${iteration}`,
        cwd: parent.cwd,
        parentSessionId: parent.sessionId,
        parentBranchId: parent.branchId,
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* branchStorage.createBranch(
      new Branch({
        id: branchId,
        sessionId,
        createdAt: now,
      }),
    )

    return { sessionId, branchId }
  })

const runDelegateScenario = (
  params: DebugScenarioParams,
  iteration: number,
  toolCallId: ToolCallId,
) =>
  Effect.gen(function* () {
    const eventStore = yield* EventStore
    const child = yield* createChildSession(params, iteration)
    const childReadToolCallId = asToolCallId(`dbg-child-read-${iteration}`)
    const childGrepToolCallId = asToolCallId(`dbg-child-grep-${iteration}`)

    yield* eventStore.publish(
      AgentRunSpawned.make({
        parentSessionId: params.sessionId,
        childSessionId: child.sessionId,
        agentName: "explore",
        prompt: "Inspect the TUI tool chrome",
        toolCallId,
        branchId: params.branchId,
      }),
    )
    yield* Effect.sleep("400 millis")

    yield* eventStore.publish(
      ToolCallStarted.make({
        sessionId: child.sessionId,
        branchId: child.branchId,
        toolCallId: childReadToolCallId,
        toolName: "read",
        input: { path: `${params.cwd}/apps/tui/src/components/message-list.tsx` },
      }),
    )
    yield* Effect.sleep("350 millis")
    yield* eventStore.publish(
      ToolCallSucceeded.make({
        sessionId: child.sessionId,
        branchId: child.branchId,
        toolCallId: childReadToolCallId,
        toolName: "read",
        summary: "182 lines from message-list.tsx",
        output: encodeDebugJson({
          path: `${params.cwd}/apps/tui/src/components/message-list.tsx`,
          lineCount: 182,
          truncated: false,
        }),
      }),
    )

    yield* Effect.sleep("250 millis")
    yield* eventStore.publish(
      ToolCallStarted.make({
        sessionId: child.sessionId,
        branchId: child.branchId,
        toolCallId: childGrepToolCallId,
        toolName: "grep",
        input: { pattern: "pendingMode", path: `${params.cwd}/apps/tui/src` },
      }),
    )
    yield* Effect.sleep("350 millis")
    yield* eventStore.publish(
      ToolCallSucceeded.make({
        sessionId: child.sessionId,
        branchId: child.branchId,
        toolCallId: childGrepToolCallId,
        toolName: "grep",
        summary: "3 matches in 2 files",
        output: encodeDebugJson({
          matches: [
            {
              file: `${params.cwd}/apps/tui/src/components/message-list.tsx`,
              line: 21,
              content: 'pendingMode?: "queued" | "steer"',
            },
          ],
          truncated: false,
        }),
      }),
    )

    yield* Effect.sleep("300 millis")
    yield* eventStore.publish(
      AgentRunSucceeded.make({
        parentSessionId: params.sessionId,
        childSessionId: child.sessionId,
        agentName: "explore",
        toolCallId,
        branchId: params.branchId,
      }),
    )
  })

const persistDebugTurn = (
  params: DebugScenarioParams,
  iteration: number,
  delegateToolCallId: ToolCallId,
  reviewToolCallId: ToolCallId,
  searchSessionsToolCallId: ToolCallId,
  readSessionToolCallId: ToolCallId,
) =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const eventStore = yield* EventStore
    const { assistant, tool } = createParentTurnMessages(
      params,
      iteration,
      delegateToolCallId,
      reviewToolCallId,
      searchSessionsToolCallId,
      readSessionToolCallId,
    )

    yield* messageStorage.createMessage(assistant)
    yield* eventStore.publish(
      MessageReceived.make({
        message: assistant,
      }),
    )
    yield* messageStorage.createMessage(tool)
    yield* eventStore.publish(
      MessageReceived.make({
        message: tool,
      }),
    )
  })

const runScriptedTurn = (params: DebugScenarioParams, iteration: number) =>
  Effect.gen(function* () {
    const eventStore = yield* EventStore
    const delegateToolCallId = asToolCallId(`dbg-live-delegate-${iteration}`)
    const reviewToolCallId = asToolCallId(`dbg-live-review-${iteration}`)
    const searchSessionsToolCallId = asToolCallId(`dbg-live-search-sessions-${iteration}`)
    const readSessionToolCallId = asToolCallId(`dbg-live-read-session-${iteration}`)
    const agent = "cowork"
    const previousAgent = "cowork"
    const startedAt = yield* Clock.currentTimeMillis

    yield* eventStore.publish(
      AgentSwitched.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        fromAgent: previousAgent,
        toAgent: agent,
      }),
    )
    yield* persistDebugUserMessage(params, iteration)
    yield* eventStore.publish(
      ProviderRetrying.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        attempt: 1,
        maxAttempts: 3,
        delayMs: 3_000,
        error: "Rate limit exceeded (429)",
      }),
    )
    yield* Effect.sleep("3100 millis")
    yield* eventStore.publish(
      StreamStarted.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
      }),
    )
    yield* eventStore.publish(
      StreamChunk.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        chunk: `Running debug inspection cycle ${iteration}. `,
      }),
    )
    yield* Effect.sleep("250 millis")

    yield* eventStore.publish(
      ToolCallStarted.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: delegateToolCallId,
        toolName: "delegate",
        input: { tasks: [{ agent: "explore", task: "Inspect the TUI tool chrome" }] },
      }),
    )
    yield* runDelegateScenario(params, iteration, delegateToolCallId)
    yield* eventStore.publish(
      ToolCallSucceeded.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: delegateToolCallId,
        toolName: "delegate",
        summary: "1 sub-agent completed",
        output: encodeDebugJson({
          output: "Explorer finished.",
          metadata: {
            mode: "parallel",
            results: [
              {
                _tag: "success",
                agentName: "explore",
                text: "Live child session completed read + grep before reporting back.",
                usage: { input: 181, output: 64, cost: 0.01 },
              },
            ],
          },
        }),
      }),
    )

    yield* Effect.sleep("250 millis")
    yield* eventStore.publish(
      ToolCallStarted.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: reviewToolCallId,
        toolName: "review",
        input: { description: `Review debug cycle ${iteration}` },
      }),
    )
    yield* Effect.sleep("450 millis")
    yield* eventStore.publish(
      ToolCallSucceeded.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: reviewToolCallId,
        toolName: "review",
        summary: "1 comment",
        output: encodeDebugJson({
          summary: { critical: 0, high: 0, medium: 1, low: 0 },
          comments: [
            {
              file: "apps/tui/src/routes/session.tsx",
              line: 220,
              severity: "medium",
              type: "bug",
              text: "Pending steer badges should disappear as soon as the interjection flushes.",
            },
          ],
        }),
      }),
    )

    yield* Effect.sleep("250 millis")
    yield* eventStore.publish(
      ToolCallStarted.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: searchSessionsToolCallId,
        toolName: "search_sessions",
        input: { query: "tool renderer" },
      }),
    )
    yield* Effect.sleep("350 millis")
    yield* eventStore.publish(
      ToolCallSucceeded.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: searchSessionsToolCallId,
        toolName: "search_sessions",
        summary: "2 matches in 1 session",
        output: encodeDebugJson({
          totalMatches: 2,
          sessions: [
            {
              sessionId: "019debug1",
              name: "tui renderer cleanup",
              lastActivity: "2026-03-22T18:30:00.000Z",
            },
          ],
        }),
      }),
    )

    yield* Effect.sleep("250 millis")
    yield* eventStore.publish(
      ToolCallStarted.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: readSessionToolCallId,
        toolName: "read_session",
        input: {
          sessionId: "019debug1-session",
          goal: "Understand the renderer cleanup thread",
        },
      }),
    )
    yield* Effect.sleep("350 millis")
    yield* eventStore.publish(
      ToolCallSucceeded.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: readSessionToolCallId,
        toolName: "read_session",
        summary: "Extracted session summary",
        output: encodeDebugJson({
          sessionId: "019debug1-session",
          extracted: true,
          goal: "Understand the renderer cleanup thread",
          content:
            "User wanted debug mode to exercise renderer chrome, retries, and queued message semantics.",
        }),
      }),
    )

    yield* eventStore.publish(
      StreamChunk.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        chunk: "Inspection pass complete. Check the live tool timeline and task widget.",
      }),
    )
    yield* eventStore.publish(
      StreamEnded.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        usage: { inputTokens: 212, outputTokens: 109 },
      }),
    )
    yield* eventStore.publish(
      TurnCompleted.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
      }),
    )
    yield* persistDebugTurn(
      params,
      iteration,
      delegateToolCallId,
      reviewToolCallId,
      searchSessionsToolCallId,
      readSessionToolCallId,
    )
  })

const runTaskLifecycle = (params: DebugScenarioParams) =>
  Effect.gen(function* () {
    const registry = yield* ExtensionRegistry
    const platform = yield* RuntimePlatform
    const capabilities = registry.getResolved().capabilities
    const ctx = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      cwd: platform.cwd,
      home: platform.home,
    }

    const invoke = <T>(
      ref: {
        readonly extensionId: string
        readonly capabilityId: string
        readonly intent: "read" | "write"
      },
      input: unknown,
    ): Effect.Effect<T, CapabilityError | CapabilityNotFoundError> => {
      const e = capabilities.runRequest(
        ExtensionId.make(ref.extensionId),
        RpcId.make(ref.capabilityId),
        input,
        ctx,
        {
          intent: ref.intent,
        },
      )
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
      return e as Effect.Effect<T, CapabilityError | CapabilityNotFoundError>
    }

    while (true) {
      const existing = yield* invoke<ReadonlyArray<{ readonly id: string }>>(TaskListRef, {})
      for (const task of existing) {
        yield* invoke<null>(TaskDeleteRef, { taskId: task.id }).pipe(
          Effect.catchEager(() => Effect.void),
        )
      }

      const inspect = yield* invoke<{ readonly id: string }>(TaskCreateRef, {
        subject: "Inspect codebase",
      })
      const verify = yield* invoke<{ readonly id: string }>(TaskCreateRef, {
        subject: "Run verification",
      })
      const summarize = yield* invoke<{ readonly id: string }>(TaskCreateRef, {
        subject: "Summarize outcome",
      })

      const setStatus = (taskId: string, status: "in_progress" | "completed") =>
        invoke<unknown>(TaskUpdateRef, { taskId, status })

      yield* setStatus(inspect.id, "in_progress")
      yield* Effect.sleep("2 seconds")
      yield* setStatus(inspect.id, "completed")
      yield* setStatus(verify.id, "in_progress")
      yield* Effect.sleep("2 seconds")
      yield* setStatus(verify.id, "completed")
      yield* setStatus(summarize.id, "in_progress")
      yield* Effect.sleep("2 seconds")
      yield* setStatus(summarize.id, "completed")
      yield* Effect.sleep("2 seconds")

      const deleteTask = (taskId: string) =>
        invoke<null>(TaskDeleteRef, { taskId }).pipe(Effect.catchEager(() => Effect.void))

      yield* deleteTask(inspect.id)
      yield* deleteTask(verify.id)
      yield* deleteTask(summarize.id)
      yield* Effect.sleep("2 seconds")
    }
  })

const runTurnLifecycle = (params: DebugScenarioParams) =>
  Effect.gen(function* () {
    const iterationRef = yield* Ref.make(0)

    while (true) {
      const iteration = yield* Ref.updateAndGet(iterationRef, (n) => n + 1)
      yield* runScriptedTurn(params, iteration)
      yield* Effect.sleep("12 seconds")
    }
  })

export const startDebugScenario = Effect.fn("DebugScenario.start")(function* (
  params: DebugScenarioParams,
) {
  yield* Effect.forkScoped(runTaskLifecycle(params))
  yield* Effect.forkScoped(runTurnLifecycle(params))
})
