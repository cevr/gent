import { Clock, DateTime, Effect, Ref, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
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
} from "@gent/core-internal/domain/event.js"
import { dateFromMillis, Branch, Message, Session } from "@gent/core-internal/domain/message.js"
import { AgentName } from "@gent/core-internal/domain/agent.js"
import {
  BranchId,
  ExtensionId,
  MessageId,
  RpcId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids.js"
import { SessionStorage } from "@gent/core-internal/storage/session-storage.js"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage.js"
import { MessageStorage } from "@gent/core-internal/storage/message-storage.js"
import { ExtensionRegistry } from "@gent/core-internal/runtime/extensions/registry.js"
import { provideCurrentHostCtx } from "@gent/core-internal/runtime/agent/current-extension-host-context.js"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import { RuntimeEnvironment } from "@gent/core-internal/runtime/runtime-environment.js"
import type {
  CapabilityError,
  CapabilityNotFoundError,
} from "@gent/core-internal/domain/capability.js"
import { ref } from "@gent/core/extensions/api"
import { ExtensionHostProcessError } from "@gent/core-internal/domain/extension.js"
import {
  TodoCreateRequest,
  TodoDeleteRequest,
  TodoListRequest,
  TodoUpdateRequest,
} from "@gent/extensions/client.js"

const TodoCreateRef = ref(TodoCreateRequest)
const TodoDeleteRef = ref(TodoDeleteRequest)
const TodoListRef = ref(TodoListRequest)
const TodoUpdateRef = ref(TodoUpdateRequest)

export interface DebugScenarioParams {
  sessionId: SessionId
  branchId: BranchId
  cwd: string
}

const makeText = (text: string) => Prompt.textPart({ text })

const asToolCallId = (value: string) => ToolCallId.make(value)
const DebugJson = Schema.fromJsonString(Schema.Unknown)
const encodeDebugJson = Schema.encodeSync(DebugJson)

const makeJsonResult = (toolCallId: ToolCallId, toolName: string, value: unknown) =>
  Prompt.toolResultPart({
    id: toolCallId,
    name: toolName,
    isFailure: false,
    result: value,
  })

const createParentTurnMessages = (
  params: DebugScenarioParams,
  iteration: number,
  delegateToolCallId: ToolCallId,
  reviewToolCallId: ToolCallId,
  searchSessionsToolCallId: ToolCallId,
  readSessionToolCallId: ToolCallId,
  nowMillis: number,
) =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const assistant = Message.cases.regular.make({
      id: MessageId.make(yield* platform.randomId),
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "assistant",
      parts: [
        Prompt.reasoningPart({
          text: "Scripted debug scenario. Exercise child sessions, todo chrome, retries, and tool output renderers.",
        }),
        makeText(`Running debug inspection cycle ${iteration}.`),
        Prompt.toolCallPart({
          id: delegateToolCallId,
          name: "delegate",
          params: { todos: [{ agent: "explore", todo: "Inspect the TUI tool chrome" }] },
          providerExecuted: false,
        }),
        Prompt.toolCallPart({
          id: reviewToolCallId,
          name: "review",
          params: { description: `Review debug cycle ${iteration}` },
          providerExecuted: false,
        }),
        Prompt.toolCallPart({
          id: searchSessionsToolCallId,
          name: "search_sessions",
          params: { query: "tool renderer" },
          providerExecuted: false,
        }),
        Prompt.toolCallPart({
          id: readSessionToolCallId,
          name: "read_session",
          params: {
            sessionId: "019debug1-session",
            goal: "Understand the renderer cleanup thread",
          },
          providerExecuted: false,
        }),
        makeText("Inspection pass complete. Check the live tool timeline and todo widget."),
      ],
      createdAt: dateFromMillis(nowMillis + 1),
    })

    const tool = Message.cases.regular.make({
      id: MessageId.make(yield* platform.randomId),
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
      createdAt: dateFromMillis(nowMillis + 2),
    })

    return { assistant, tool }
  })

const persistDebugUserMessage = (params: DebugScenarioParams, iteration: number) =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const eventStore = yield* EventStore
    const platform = yield* GentPlatform
    const user = Message.cases.regular.make({
      id: MessageId.make(yield* platform.randomId),
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
    const platform = yield* GentPlatform
    const sessionId = SessionId.make(yield* platform.randomId)
    const branchId = BranchId.make(yield* platform.randomId)
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
        agentName: AgentName.make("explore"),
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
        agentName: AgentName.make("explore"),
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
    const nowMillis = yield* Clock.currentTimeMillis
    const { assistant, tool } = yield* createParentTurnMessages(
      params,
      iteration,
      delegateToolCallId,
      reviewToolCallId,
      searchSessionsToolCallId,
      readSessionToolCallId,
      nowMillis,
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
    const agent = AgentName.make("cowork")
    const previousAgent = AgentName.make("cowork")
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
        input: { todos: [{ agent: "explore", todo: "Inspect the TUI tool chrome" }] },
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
        chunk: "Inspection pass complete. Check the live tool timeline and todo widget.",
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

const runTodoLifecycle = (params: DebugScenarioParams) =>
  Effect.gen(function* () {
    const registry = yield* ExtensionRegistry
    const platform = yield* RuntimeEnvironment
    const gentPlatform = yield* GentPlatform
    const rpcRegistry = registry.getResolved().rpcRegistry
    const osInfo = yield* gentPlatform.osInfo
    const execPath = yield* gentPlatform.execPath
    const homeDirectory = yield* gentPlatform.homeDirectory
    const parentEnv = yield* gentPlatform.env
    const pathListSeparator = yield* gentPlatform.pathListSeparator
    const ctx = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      cwd: platform.cwd,
      home: platform.home,
      host: {
        osInfo,
        execPath,
        homeDirectory,
        parentEnv,
        pathListSeparator,
        commandCandidates: gentPlatform.commandCandidates,
        isPortFree: gentPlatform.isPortFree,
        isPidAlive: (pid: number) =>
          gentPlatform.signal(pid, 0).pipe(
            Effect.as(true),
            Effect.catchEager(() => Effect.succeed(false)),
          ),
        signalPid: (pid: number, signal: string | 0) =>
          gentPlatform.signal(pid, signal).pipe(Effect.catchEager(() => Effect.void)),
        runProcess: (command: string) =>
          Effect.fail(
            new ExtensionHostProcessError({
              command,
              message: "debug scenario host.runProcess unavailable",
            }),
          ),
      },
      agent: {
        listAgents: () => Effect.succeed([]),
        run: () => Effect.die("debug scenario agent.run unavailable"),
      },
      session: {
        listMessages: () => Effect.succeed([]),
        getSession: () => Effect.sync(() => undefined),
        getDetail: () => Effect.die("debug scenario session.getDetail unavailable"),
        renameCurrent: () => Effect.succeed({ renamed: false }),
        search: () => Effect.succeed([]),
        queueFollowUp: () => Effect.sync(() => undefined),
        listBranches: () => Effect.succeed([]),
      },
      interaction: {
        approve: () => Effect.die("debug scenario interaction.approve unavailable"),
        present: () => Effect.sync(() => undefined),
        confirm: () => Effect.succeed("no" as const),
        review: () => Effect.die("debug scenario interaction.review unavailable"),
      },
    }

    const invoke = <T>(
      ref: {
        readonly extensionId: string
        readonly capabilityId: string
      },
      input: unknown,
    ): Effect.Effect<T, CapabilityError | CapabilityNotFoundError> => {
      const e = rpcRegistry
        .run(ExtensionId.make(ref.extensionId), RpcId.make(ref.capabilityId), input)
        .pipe(provideCurrentHostCtx(ctx))
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
      return e as Effect.Effect<T, CapabilityError | CapabilityNotFoundError>
    }

    while (true) {
      const existing = yield* invoke<ReadonlyArray<{ readonly id: string }>>(TodoListRef, {})
      for (const todo of existing) {
        yield* invoke<null>(TodoDeleteRef, { todoId: todo.id }).pipe(
          Effect.catchEager(() => Effect.void),
        )
      }

      const inspect = yield* invoke<{ readonly id: string }>(TodoCreateRef, {
        subject: "Inspect codebase",
      })
      const verify = yield* invoke<{ readonly id: string }>(TodoCreateRef, {
        subject: "Run verification",
      })
      const summarize = yield* invoke<{ readonly id: string }>(TodoCreateRef, {
        subject: "Summarize outcome",
      })

      const setStatus = (todoId: string, status: "in_progress" | "completed") =>
        invoke<unknown>(TodoUpdateRef, { todoId, status })

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

      const deleteTodo = (todoId: string) =>
        invoke<null>(TodoDeleteRef, { todoId }).pipe(Effect.catchEager(() => Effect.void))

      yield* deleteTodo(inspect.id)
      yield* deleteTodo(verify.id)
      yield* deleteTodo(summarize.id)
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
  yield* Effect.forkScoped(runTodoLifecycle(params))
  yield* Effect.forkScoped(runTurnLifecycle(params))
})
