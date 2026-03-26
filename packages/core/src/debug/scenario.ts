import { Effect, Ref, Schema } from "effect"
import {
  AgentSwitched,
  EventStore,
  MessageReceived,
  ProviderRetrying,
  StreamChunk,
  StreamEnded,
  StreamStarted,
  SubagentSpawned,
  SubagentSucceeded,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "../domain/event.js"
import {
  Branch,
  Message,
  ReasoningPart,
  Session,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../domain/message.js"
import type { BranchId, MessageId, SessionId, ToolCallId } from "../domain/ids.js"
import { Storage } from "../storage/sqlite-storage.js"
import { TaskService } from "../runtime/task-service.js"

export interface DebugScenarioParams {
  sessionId: SessionId
  branchId: BranchId
  cwd: string
}

const makeText = (text: string) => new TextPart({ type: "text", text })

const asToolCallId = (value: string) => value as ToolCallId
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
  codeReviewToolCallId: ToolCallId,
  searchSessionsToolCallId: ToolCallId,
  readSessionToolCallId: ToolCallId,
) => {
  const now = new Date()

  const assistant = new Message({
    id: Bun.randomUUIDv7() as MessageId,
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
        input: { tasks: [{ agent: "reviewer", task: "Inspect the TUI tool chrome" }] },
      }),
      new ToolCallPart({
        type: "tool-call",
        toolCallId: codeReviewToolCallId,
        toolName: "code_review",
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

  const tool = new Message({
    id: Bun.randomUUIDv7() as MessageId,
    sessionId: params.sessionId,
    branchId: params.branchId,
    role: "tool",
    parts: [
      makeJsonResult(delegateToolCallId, "delegate", {
        output: "Reviewer finished.",
        metadata: {
          mode: "parallel",
          results: [
            {
              _tag: "success",
              agentName: "reviewer",
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
      makeJsonResult(codeReviewToolCallId, "code_review", {
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
    const storage = yield* Storage
    const eventStore = yield* EventStore
    const user = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "user",
      kind: "regular",
      parts: [makeText(`Run debug inspection cycle ${iteration}.`)],
      createdAt: new Date(),
    })

    yield* storage.createMessage(user)
    yield* eventStore.publish(
      new MessageReceived({
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: user.id,
        role: "user",
      }),
    )
  })

const createChildSession = (parent: DebugScenarioParams, iteration: number) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const sessionId = Bun.randomUUIDv7() as SessionId
    const branchId = Bun.randomUUIDv7() as BranchId
    const now = new Date()

    yield* storage.createSession(
      new Session({
        id: sessionId,
        name: `debug child ${iteration}`,
        cwd: parent.cwd,
        bypass: true,
        parentSessionId: parent.sessionId,
        parentBranchId: parent.branchId,
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* storage.createBranch(
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
      new SubagentSpawned({
        parentSessionId: params.sessionId,
        childSessionId: child.sessionId,
        agentName: "reviewer",
        prompt: "Inspect the TUI tool chrome",
        toolCallId,
        branchId: params.branchId,
      }),
    )
    yield* Effect.sleep("400 millis")

    yield* eventStore.publish(
      new ToolCallStarted({
        sessionId: child.sessionId,
        branchId: child.branchId,
        toolCallId: childReadToolCallId,
        toolName: "read",
        input: { path: `${params.cwd}/apps/tui/src/components/message-list.tsx` },
      }),
    )
    yield* Effect.sleep("350 millis")
    yield* eventStore.publish(
      new ToolCallSucceeded({
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
      new ToolCallStarted({
        sessionId: child.sessionId,
        branchId: child.branchId,
        toolCallId: childGrepToolCallId,
        toolName: "grep",
        input: { pattern: "pendingMode", path: `${params.cwd}/apps/tui/src` },
      }),
    )
    yield* Effect.sleep("350 millis")
    yield* eventStore.publish(
      new ToolCallSucceeded({
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
      new SubagentSucceeded({
        parentSessionId: params.sessionId,
        childSessionId: child.sessionId,
        agentName: "reviewer",
        toolCallId,
        branchId: params.branchId,
      }),
    )
  })

const persistDebugTurn = (
  params: DebugScenarioParams,
  iteration: number,
  delegateToolCallId: ToolCallId,
  codeReviewToolCallId: ToolCallId,
  searchSessionsToolCallId: ToolCallId,
  readSessionToolCallId: ToolCallId,
) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const eventStore = yield* EventStore
    const { assistant, tool } = createParentTurnMessages(
      params,
      iteration,
      delegateToolCallId,
      codeReviewToolCallId,
      searchSessionsToolCallId,
      readSessionToolCallId,
    )

    yield* storage.createMessage(assistant)
    yield* eventStore.publish(
      new MessageReceived({
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: assistant.id,
        role: "assistant",
      }),
    )
    yield* storage.createMessage(tool)
    yield* eventStore.publish(
      new MessageReceived({
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: tool.id,
        role: "tool",
      }),
    )
  })

const runScriptedTurn = (params: DebugScenarioParams, iteration: number) =>
  Effect.gen(function* () {
    const eventStore = yield* EventStore
    const delegateToolCallId = asToolCallId(`dbg-live-delegate-${iteration}`)
    const codeReviewToolCallId = asToolCallId(`dbg-live-code-review-${iteration}`)
    const searchSessionsToolCallId = asToolCallId(`dbg-live-search-sessions-${iteration}`)
    const readSessionToolCallId = asToolCallId(`dbg-live-read-session-${iteration}`)
    const agent = iteration % 2 === 0 ? "deepwork" : "cowork"
    const previousAgent = iteration % 2 === 0 ? "cowork" : "deepwork"
    const startedAt = Date.now()

    yield* eventStore.publish(
      new AgentSwitched({
        sessionId: params.sessionId,
        branchId: params.branchId,
        fromAgent: previousAgent,
        toAgent: agent,
      }),
    )
    yield* persistDebugUserMessage(params, iteration)
    yield* eventStore.publish(
      new ProviderRetrying({
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
      new StreamStarted({
        sessionId: params.sessionId,
        branchId: params.branchId,
      }),
    )
    yield* eventStore.publish(
      new StreamChunk({
        sessionId: params.sessionId,
        branchId: params.branchId,
        chunk: `Running debug inspection cycle ${iteration}. `,
      }),
    )
    yield* Effect.sleep("250 millis")

    yield* eventStore.publish(
      new ToolCallStarted({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: delegateToolCallId,
        toolName: "delegate",
        input: { tasks: [{ agent: "reviewer", task: "Inspect the TUI tool chrome" }] },
      }),
    )
    yield* runDelegateScenario(params, iteration, delegateToolCallId)
    yield* eventStore.publish(
      new ToolCallSucceeded({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: delegateToolCallId,
        toolName: "delegate",
        summary: "1 sub-agent completed",
        output: encodeDebugJson({
          output: "Reviewer finished.",
          metadata: {
            mode: "parallel",
            results: [
              {
                _tag: "success",
                agentName: "reviewer",
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
      new ToolCallStarted({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: codeReviewToolCallId,
        toolName: "code_review",
        input: { description: `Review debug cycle ${iteration}` },
      }),
    )
    yield* Effect.sleep("450 millis")
    yield* eventStore.publish(
      new ToolCallSucceeded({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: codeReviewToolCallId,
        toolName: "code_review",
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
      new ToolCallStarted({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: searchSessionsToolCallId,
        toolName: "search_sessions",
        input: { query: "tool renderer" },
      }),
    )
    yield* Effect.sleep("350 millis")
    yield* eventStore.publish(
      new ToolCallSucceeded({
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
      new ToolCallStarted({
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
      new ToolCallSucceeded({
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
      new StreamChunk({
        sessionId: params.sessionId,
        branchId: params.branchId,
        chunk: "Inspection pass complete. Check the live tool timeline and task widget.",
      }),
    )
    yield* eventStore.publish(
      new StreamEnded({
        sessionId: params.sessionId,
        branchId: params.branchId,
        usage: { inputTokens: 212, outputTokens: 109 },
      }),
    )
    yield* eventStore.publish(
      new TurnCompleted({
        sessionId: params.sessionId,
        branchId: params.branchId,
        durationMs: Date.now() - startedAt,
      }),
    )
    yield* persistDebugTurn(
      params,
      iteration,
      delegateToolCallId,
      codeReviewToolCallId,
      searchSessionsToolCallId,
      readSessionToolCallId,
    )
  })

const runTaskLifecycle = (params: DebugScenarioParams) =>
  Effect.gen(function* () {
    const taskService = yield* TaskService

    while (true) {
      const existing = yield* taskService.list(params.sessionId, params.branchId)
      for (const task of existing) {
        yield* taskService.remove(task.id)
      }

      const inspect = yield* taskService.create({
        sessionId: params.sessionId,
        branchId: params.branchId,
        subject: "Inspect codebase",
      })
      const verify = yield* taskService.create({
        sessionId: params.sessionId,
        branchId: params.branchId,
        subject: "Run verification",
      })
      const summarize = yield* taskService.create({
        sessionId: params.sessionId,
        branchId: params.branchId,
        subject: "Summarize outcome",
      })

      yield* taskService.update(inspect.id, { status: "in_progress" })
      yield* Effect.sleep("2 seconds")
      yield* taskService.update(inspect.id, { status: "completed" })
      yield* taskService.update(verify.id, { status: "in_progress" })
      yield* Effect.sleep("2 seconds")
      yield* taskService.update(verify.id, { status: "completed" })
      yield* taskService.update(summarize.id, { status: "in_progress" })
      yield* Effect.sleep("2 seconds")
      yield* taskService.update(summarize.id, { status: "completed" })
      yield* Effect.sleep("2 seconds")

      yield* taskService.remove(inspect.id)
      yield* taskService.remove(verify.id)
      yield* taskService.remove(summarize.id)
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
