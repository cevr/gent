/**
 * External turn execution — integration tests.
 *
 * Covers: collectExternalTurn with mock TurnExecutor, full agent loop
 * dispatch for external execution, event publishing, and cancellation.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Predicate, Clock, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import { TestClock } from "effect/testing"
import type { AgentLoopError } from "../../../src/runtime/agent/agent-loop.state"
import {
  AgentLoop as AgentLoopActor,
  AgentLoopTestActor,
} from "../../../src/runtime/agent/agent-loop.actor"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { entityIdOf } from "../../../src/runtime/agent/agent-loop.entity-id"
import {
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "../../../src/runtime/agent/agent-loop.utils"
import { resolveExtensions, ExtensionRegistry } from "../../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../../src/runtime/extensions/driver-registry"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { ToolRunner } from "../../../src/runtime/agent/tool-runner"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { finishPart, LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import {
  messagePartsText,
  messagePartsToolCallParts,
  messagePartsToolResultParts,
} from "@gent/core-internal/domain/message-part-projection"
import {
  AgentDefinition,
  AgentName,
  ExternalDriverRef,
  type RunSpec,
} from "@gent/core-internal/domain/agent"
import type { TurnExecutor, TurnContext, TurnStreamPart } from "@gent/core-internal/domain/driver"
import { ExternalToolRunner, TurnError } from "@gent/core-internal/domain/driver"
import type { AgentEvent } from "@gent/core-internal/domain/event"
import { EventEnvelope, EventId, EventStore } from "@gent/core-internal/domain/event"
import { EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { Permission } from "@gent/core-internal/domain/permission"
import { SqliteStorage, type StorageError } from "@gent/core-internal/storage/sqlite-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { ToolCallBindingStorage } from "@gent/core-internal/storage/tool-call-binding-storage"
import type { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import type { SessionStorage } from "@gent/core-internal/storage/session-storage"
import {
  BranchId,
  ActorCommandId,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { ConfigService } from "../../../src/runtime/config-service"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { AllBuiltinAgents } from "../../../../extensions/tests/helpers/builtin-agents.js"
import { ApprovalService } from "../../../src/runtime/approval-service"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { ExtensionContext, getToolId, tool, type ToolCapability } from "@gent/core/extensions/api"
import { DefaultWorkspaceId } from "@gent/core-internal/server/workspace-rpc"
// ── Helpers ──
const sessionId = SessionId.make("test-session")
const branchId = BranchId.make("test-branch")
const makeMessage = (text: string) =>
  Message.cases.regular.make({
    id: MessageId.make(`${sessionId}-${branchId}-msg`),
    sessionId,
    branchId,
    role: "user",
    parts: [Prompt.textPart({ text })],
    createdAt: dateFromMillis(1_767_225_600_000),
  })
const makeMessageWithParts = (parts: Message["parts"]) =>
  Message.cases.regular.make({
    id: MessageId.make(`${sessionId}-${branchId}-multipart-msg`),
    sessionId,
    branchId,
    role: "user",
    parts,
    createdAt: dateFromMillis(1_767_225_600_000),
  })
interface AgentLoopService {
  readonly runOnce: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly agentName: AgentName
    readonly prompt: string
    readonly interactive?: boolean
    readonly runSpec?: RunSpec
  }) => Effect.Effect<void, AgentLoopError | StorageError, BranchStorage | SessionStorage>
}
const makeAgentLoopService = Effect.gen(function* () {
  const actorClientFactory = yield* AgentLoopActor.Context
  const refFor = (targetSessionId: SessionId, targetBranchId: BranchId) =>
    actorClientFactory(entityIdOf(DefaultWorkspaceId, targetSessionId, targetBranchId))
  return {
    runOnce: (input) =>
      Effect.gen(function* () {
        const message = Message.cases.regular.make({
          id: MessageId.make(`${input.sessionId}-${input.branchId}-${input.prompt}`),
          sessionId: input.sessionId,
          branchId: input.branchId,
          role: "user",
          parts: [Prompt.textPart({ text: input.prompt })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
        const ref = yield* refFor(input.sessionId, input.branchId)
        const payload = {
          workspaceId: DefaultWorkspaceId,
          message,
          // Actor operation payloads require optional fields explicitly.
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          agentOverride: input.agentName,
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          runSpec: input.runSpec,
          // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
          interactive: input.interactive,
        }
        yield* ref.execute(AgentLoopActor.Run.make(payload))
      }),
  } satisfies AgentLoopService
})
const runAgentLoop = (
  _agentLoop: AgentLoopService,
  message: Message,
  options?: {
    readonly agentOverride?: AgentName
    readonly runSpec?: RunSpec
    readonly interactive?: boolean
  },
) =>
  ensureStorageParents({ sessionId: message.sessionId, branchId: message.branchId }).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const actorClientFactory = yield* AgentLoopActor.Context
        const ref = yield* actorClientFactory(
          entityIdOf(DefaultWorkspaceId, message.sessionId, message.branchId),
        )
        yield* ref.execute(
          AgentLoopActor.Run.make({
            workspaceId: DefaultWorkspaceId,
            message,
            // Actor operation payloads require optional fields explicitly.
            // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
            agentOverride: options?.agentOverride,
            // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
            runSpec: options?.runSpec,
            // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
            interactive: options?.interactive,
          }),
        )
      }),
    ),
  )
const runAgentLoopOnce = (
  agentLoop: AgentLoopService,
  input: Parameters<AgentLoopService["runOnce"]>[0],
) =>
  ensureStorageParents({ sessionId: input.sessionId, branchId: input.branchId }).pipe(
    Effect.flatMap(() => agentLoop.runOnce(input)),
  )
const textDelta = (text: string): TurnStreamPart =>
  Response.makePart("text-delta", { id: "external-test-text", delta: text })

const reasoningDelta = (text: string): TurnStreamPart =>
  Response.makePart("reasoning-delta", { id: "external-test-reasoning", delta: text })

const toolCall = (
  toolCallId: ToolCallId,
  toolName: string,
  input: Schema.Schema.Type<typeof Schema.Unknown> = {},
): TurnStreamPart =>
  Response.makePart("tool-call", {
    id: toolCallId,
    name: toolName,
    params: input,
    providerExecuted: false,
  })

const toolResult = (
  toolCallId: ToolCallId,
  toolName: string,
  // oxlint-disable-next-line effect/noNullish -- External response fixture preserves a null tool result on the wire.
  result: Schema.Schema.Type<typeof Schema.Unknown> = null,
): TurnStreamPart =>
  Response.makePart("tool-result", {
    id: toolCallId,
    name: toolName,
    result,
    encodedResult: result,
    isFailure: false,
    providerExecuted: false,
    preliminary: false,
  })

const failedToolResult = (
  toolCallId: ToolCallId,
  toolName: string,
  error: string,
): TurnStreamPart =>
  Response.makePart("tool-result", {
    id: toolCallId,
    name: toolName,
    result: error,
    encodedResult: { error },
    isFailure: true,
    providerExecuted: false,
    preliminary: false,
  })

const finish = (finishReason: Response.FinishReason = "stop"): TurnStreamPart =>
  finishPart({ finishReason })

/** Create a TurnExecutor that emits a sequence of response parts. */
const makeMockExecutor = (parts: ReadonlyArray<TurnStreamPart>): TurnExecutor => ({
  executeTurn: () => Stream.fromIterable(parts),
})
/** Create a TurnExecutor that captures the TurnContext for assertions. */
const makeCapturingExecutor = (
  parts: ReadonlyArray<TurnStreamPart>,
  capture: (ctx: TurnContext) => void,
): TurnExecutor => ({
  executeTurn: (ctx) => {
    capture(ctx)
    return Stream.fromIterable(parts)
  },
})
/** Create a TurnExecutor that fails. */
const makeFailingExecutor = (message: string): TurnExecutor => ({
  executeTurn: () => Stream.fail(new TurnError({ message })),
})
const externalAgent = AgentDefinition.make({
  name: AgentName.make("test-external"),
  allowedTools: ["context_probe"],
  driver: ExternalDriverRef.make({ id: "test-runner" }),
})
const contextProbeTool: ToolCapability = tool({
  id: "context_probe",
  description: "Probe tool context",
  params: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  execute: () => Effect.succeed({ ok: true }),
})
const makeResolved = (executor: TurnExecutor, tools: ReadonlyArray<ToolCapability> = []) =>
  resolveExtensions([
    {
      manifest: { id: ExtensionId.make("test-ext") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: [externalAgent],
        tools,
        externalDrivers: [{ id: "test-runner", executor, invalidate: Effect.void }],
      },
    },
  ])
const makeExtRegistry = (executor: TurnExecutor, tools?: ReadonlyArray<ToolCapability>) =>
  ExtensionRegistry.fromResolved(makeResolved(executor, tools))
const makeDriverRegistry = (executor: TurnExecutor, tools?: ReadonlyArray<ToolCapability>) =>
  DriverRegistry.fromResolved({
    modelDrivers: makeResolved(executor, tools).modelDrivers,
    externalDrivers: makeResolved(executor, tools).externalDrivers,
  })
/** Counting event store that captures published events. */
const makeCountingEventStore = (eventsRef: Ref.Ref<AgentEvent[]>) =>
  Layer.succeed(
    EventStore,
    EventStore.of({
      append: (event: AgentEvent) =>
        Effect.gen(function* () {
          yield* Ref.update(eventsRef, (events) => [...events, event])
          return EventEnvelope.make({
            id: EventId.make(0),
            event,
            createdAt: yield* Clock.currentTimeMillis,
          })
        }),
      broadcast: () => Effect.void,
      deliver: () => Effect.void,
      publish: (event: AgentEvent) => Ref.update(eventsRef, (events) => [...events, event]),
      subscribe: () => Stream.empty,
      removeSession: () => Effect.void,
    }),
  )
const makeLayerWithEvents = (
  executor: TurnExecutor,
  eventsRef: Ref.Ref<AgentEvent[]>,
  options?: {
    readonly tools?: ReadonlyArray<ToolCapability>
    readonly liveToolRunner?: boolean
    readonly liveApproval?: boolean
  },
) => {
  // Dummy provider — external turns don't use it but AgentLoop requires it
  const providerLayer = LanguageModelLayers.testStream(() =>
    Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
  )
  let toolRunnerLayer = ToolRunner.Test()
  if (options?.liveToolRunner === true) toolRunnerLayer = ToolRunner.Live
  const deps = Layer.mergeAll(
    SqliteStorage.TestWithSql(),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    makeExtRegistry(executor, options?.tools),
    makeDriverRegistry(executor, options?.tools),
    makeCountingEventStore(eventsRef),
    toolRunnerLayer,
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ApprovalService.Test(),
    Permission.Live([], "allow"),
    BunServices.layer,
    ModelRegistry.Test(),
    ConfigService.Test(),
    GentPlatform.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  let approvalLayer = ApprovalService.Test()
  if (options?.liveApproval === true) {
    approvalLayer = ApprovalService.Live.pipe(
      Layer.provide(Layer.merge(deps, eventPublisherLayer)),
      Layer.orDie,
    )
  }
  return AgentLoopTestActor({ baseSections: [] }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live, approvalLayer),
    ),
  )
}
// ── Tests ──
describe("external turn execution", () => {
  it.live("publishes StreamStarted, StreamChunk, and TurnCompleted for external turn", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        textDelta("Hello from "),
        textDelta("external agent"),
        finish(),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, makeMessage("test"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("StreamStarted")
          expect(tags).toContain("StreamChunk")
          expect(tags).toContain("TurnCompleted")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("external sequential calls retain results and resume before later callbacks", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const toolCalls = yield* Ref.make(0)
      const completedInputs = yield* Ref.make<string[]>([])
      const actualCallIds = yield* Ref.make<string[]>([])
      const executorCalls = yield* Ref.make(0)
      const pendingTool: ToolCapability = tool({
        id: "context_probe",
        description: "Probe tool context",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({
          value: Schema.String,
          nested: Schema.Struct({ ok: Schema.Boolean }),
        }),
        execute: (input: { value: string }) =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            yield* Ref.update(toolCalls, (value) => value + 1)
            const actualCallId = ctx.toolCallId
            if (Predicate.isUndefined(actualCallId))
              return yield* Effect.die("Missing tool call ID")
            yield* Ref.update(actualCallIds, (ids) => [...ids, actualCallId])
            if (input.value === "park") {
              const decision = yield* ctx.Interaction.approve({
                text: "Approve second external call",
              })
              expect(decision.approved).toBe(true)
            }
            yield* Ref.update(completedInputs, (inputs) => [...inputs, input.value])
            return { value: input.value, nested: { ok: true } }
          }),
      })
      const executor: TurnExecutor = {
        executeTurn: () =>
          Stream.fromEffect(
            Effect.gen(function* () {
              const call = yield* Ref.getAndUpdate(executorCalls, (value) => value + 1)
              const runner = yield* ExternalToolRunner
              if (call === 0) {
                yield* runner.runTool("context_probe", { value: "first" })
                return yield* runner.runTool("context_probe", { value: "park" })
              }
              return yield* runner.runTool("context_probe", { value: "later" })
            }),
          ).pipe(
            Stream.flatMap(() => Stream.fromIterable([textDelta("external resumed"), finish()])),
          ),
      }
      const layer = makeLayerWithEvents(executor, eventsRef, {
        tools: [pendingTool],
        liveToolRunner: true,
        liveApproval: true,
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* ensureStorageParents({ sessionId, branchId })
          const message = makeMessage("park externally")
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, message, {
              agentOverride: AgentName.make("test-external"),
            }),
          )
          const actorClientFactory = yield* AgentLoopActor.Context
          const ref = yield* actorClientFactory(entityIdOf(DefaultWorkspaceId, sessionId, branchId))
          const state = yield* waitFor(
            ref.execute(
              AgentLoopActor.GetState.make({
                workspaceId: DefaultWorkspaceId,
                sessionId,
                branchId,
                commandId: ActorCommandId.make("external-pending-state"),
              }),
            ),
            (snapshot) => snapshot._tag === "WaitingForInteraction",
            4_000,
            "external interaction pending state",
          )
          expect(state._tag).toBe("WaitingForInteraction")
          if (state._tag !== "WaitingForInteraction") return
          const messages = yield* MessageStorage
          const bindingStorage = yield* ToolCallBindingStorage
          const firstResult = yield* messages.getMessage(toolResultMessageIdForTurn(message.id, 1))
          expect(firstResult?.parts).toEqual([
            Prompt.toolResultPart({
              id: Ref.getUnsafe(actualCallIds)[0] ?? "missing",
              name: "context_probe",
              isFailure: false,
              providerExecuted: false,
              result: { value: "first", nested: { ok: true } },
            }),
          ])
          const assistant = yield* messages.getMessage(assistantMessageIdForTurn(message.id, 2))
          expect(assistant).not.toBeUndefined()
          if (Predicate.isUndefined(assistant)) return
          const persistedCall = assistant.parts.find((part) => part.type === "tool-call")
          expect(persistedCall?.type).toBe("tool-call")
          if (persistedCall?.type !== "tool-call") return
          expect(persistedCall.id).toBe(Ref.getUnsafe(actualCallIds)[1] ?? "missing")
          expect(persistedCall.params).toEqual({ value: "park" })
          expect(
            yield* bindingStorage.get({
              sessionId,
              branchId,
              assistantMessageId: assistant.id,
              toolCallId: ToolCallId.make(persistedCall.id),
            }),
          ).toBeUndefined()
          const approval = yield* ApprovalService
          const pendingRequestId = yield* approval.pendingRequestId({ sessionId, branchId })
          expect(pendingRequestId).not.toBeUndefined()
          if (Predicate.isUndefined(pendingRequestId)) return
          yield* approval.storeResolution(pendingRequestId, { approved: true })
          yield* ref.execute(
            AgentLoopActor.RespondInteraction.make({
              workspaceId: DefaultWorkspaceId,
              sessionId,
              branchId,
              requestId: pendingRequestId,
            }),
          )
          yield* waitFor(
            ref.execute(
              AgentLoopActor.GetState.make({
                workspaceId: DefaultWorkspaceId,
                sessionId,
                branchId,
                commandId: ActorCommandId.make("external-resumed-state"),
              }),
            ),
            (snapshot) => snapshot._tag === "Idle",
            4_000,
            "external interaction resumed state",
          )
          expect(Ref.getUnsafe(toolCalls)).toBe(4)
          expect(Ref.getUnsafe(executorCalls)).toBe(2)
          expect(Ref.getUnsafe(completedInputs)).toEqual(["first", "park", "later"])
          const ids = Ref.getUnsafe(actualCallIds)
          expect(ids[2]).toBe(ids[1])
          expect(ids[3]).not.toBe(ids[1])
          const history = yield* messages.listMessages(branchId)
          const calls = history.flatMap((message) => messagePartsToolCallParts(message.parts))
          const results = history.flatMap((message) => messagePartsToolResultParts(message.parts))
          expect(calls.map((part) => part.id)).toEqual(ids.filter((_, index) => index !== 2))
          expect(results.map((part) => part.id)).toEqual(calls.map((part) => part.id))
          expect(results.map((part) => part.result)).toEqual([
            { value: "first", nested: { ok: true } },
            { value: "park", nested: { ok: true } },
            { value: "later", nested: { ok: true } },
          ])
          expect(history.map((message) => messagePartsText(message.parts))).toContain(
            "external resumed",
          )
          yield* Fiber.join(fiber)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("external callback limit rejects before another side effect or saved intent", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executions = yield* Ref.make(0)
      const boundedTool = tool({
        id: "context_probe",
        description: "Count external side effects",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.Finite,
        execute: () => Ref.updateAndGet(executions, (count) => count + 1),
      })
      const executor: TurnExecutor = {
        executeTurn: () =>
          Stream.fromEffect(
            Effect.gen(function* () {
              const runner = yield* ExternalToolRunner
              for (let call = 0; call < 201; call++) {
                yield* runner.runTool("context_probe", { value: String(call) })
              }
              return finish()
            }),
          ),
      }
      const layer = makeLayerWithEvents(executor, eventsRef, {
        tools: [boundedTool],
        liveToolRunner: true,
      }).pipe(Layer.provideMerge(TestClock.layer()))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(1_767_225_600_000)
          const loop = yield* makeAgentLoopService
          const message = makeMessage("bound external calls")
          yield* runAgentLoop(loop, message, {
            agentOverride: externalAgent.name,
          })
          const storage = yield* MessageStorage
          const history = yield* storage.listMessages(branchId)
          const calls = history.flatMap((message) => messagePartsToolCallParts(message.parts))
          const results = history.flatMap((message) => messagePartsToolResultParts(message.parts))
          expect(yield* Ref.get(executions)).toBe(200)
          expect(calls).toHaveLength(200)
          expect(history.map((entry) => entry.id)).toEqual([
            message.id,
            ...Array.from({ length: 200 }, (_, index) => index + 1).flatMap((step) => [
              assistantMessageIdForTurn(message.id, step),
              toolResultMessageIdForTurn(message.id, step),
            ]),
          ])
          expect(results.map((result) => result.id)).toEqual(calls.map((call) => call.id))
          expect(results.at(-1)?.result).toBe(200)
          const errors = (yield* Ref.get(eventsRef)).filter(
            (event) => event._tag === "ErrorOccurred",
          )
          expect(errors.map((event) => event.error)).toContain(
            "External turn executor error: External turn exceeded the 200 tool step limit",
          )
        }).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- This test builds the real actor under a fixed clock at its test boundary.
          Effect.provide(layer),
          Effect.timeout("4 seconds"),
        ),
      )
    }),
  )
  it.live("publishes tool observability events for external tool calls", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        toolCall(ToolCallId.make("tc-1"), "read_file"),
        toolResult(ToolCallId.make("tc-1"), "read_file"),
        textDelta("File contents here"),
        finish(),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef, { tools: [contextProbeTool] })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, makeMessage("read a file"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("ToolCallStarted")
          expect(tags).toContain("ToolCallSucceeded")
          const started = events.find((e) => e._tag === "ToolCallStarted")
          expect(started).toEqual(expect.objectContaining({ input: {} }))
          const succeeded = events.find((e) => e._tag === "ToolCallSucceeded")
          expect(succeeded).toEqual(
            expect.objectContaining({
              summary: "null",
              output: "null",
            }),
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("publishes ToolCallFailed for failed external tool calls", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        toolCall(ToolCallId.make("tc-fail"), "bash"),
        failedToolResult(ToolCallId.make("tc-fail"), "bash", "permission denied"),
        finish(),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, makeMessage("run something"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("ToolCallFailed")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("publishes ErrorOccurred when external executor stream fails", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeFailingExecutor("connection lost")
      const layer = makeLayerWithEvents(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, makeMessage("test error"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("ErrorOccurred")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("native external response error parts fail the stream and preserve partial output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        textDelta("partial external answer"),
        Response.makePart("error", {
          error: new TurnError({ message: "external response part failed" }),
        }),
        textDelta("unreachable"),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef)
      const message = makeMessage("external native error")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messages = yield* MessageStorage
          yield* runAgentLoop(agentLoop, message, {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("StreamStarted")
          expect(tags).toContain("StreamChunk")
          expect(tags).toContain("StreamEnded")
          expect(tags).toContain("ErrorOccurred")
          expect(tags).toContain("TurnCompleted")
          const error = events.find((event) => event._tag === "ErrorOccurred")
          expect(error).toEqual(
            expect.objectContaining({
              error: "External turn executor error: external response part failed",
            }),
          )
          const assistant = yield* messages.getMessage(assistantMessageIdForTurn(message.id, 1))
          expect(assistant?.parts).toEqual([Prompt.textPart({ text: "partial external answer" })])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("external turn does not re-execute tools (toolCalls empty in draft)", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        toolCall(ToolCallId.make("tc-1"), "bash"),
        toolResult(ToolCallId.make("tc-1"), "bash"),
        textDelta("done"),
        finish(),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, makeMessage("test no tool re-exec"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          // TurnCompleted fires (loop completed), ToolCallStarted fires (observability),
          // but no additional ToolCallSucceeded from loop-owned tool execution (which would
          // come from ToolRunner, not the external executor)
          expect(tags).toContain("TurnCompleted")
          // Only one ToolCallStarted (from external events), not two (no re-execution)
          const toolStartedCount = tags.filter((t) => t === "ToolCallStarted").length
          expect(toolStartedCount).toBe(1)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("model-backed agents still work unchanged", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      // Use the default agent (model-backed) with a simple provider
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
      )
      const agentsResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("agents") },
          scope: "builtin",
          sourcePath: "test",
          contributions: { agents: AllBuiltinAgents },
        },
      ])
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        ExtensionRegistry.fromResolved(agentsResolved),
        DriverRegistry.fromResolved({
          modelDrivers: agentsResolved.modelDrivers,
          externalDrivers: agentsResolved.externalDrivers,
        }),
        makeCountingEventStore(eventsRef),
        ToolRunner.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        BunServices.layer,
        ModelRegistry.Test(),
        GentPlatform.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, makeMessage("model turn"))
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("StreamStarted")
          expect(tags).toContain("TurnCompleted")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("executor receives correct TurnContext", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const capturedContexts: TurnContext[] = []
      const executor = makeCapturingExecutor([finish()], (ctx) => {
        capturedContexts.push(ctx)
      })
      const layer = makeLayerWithEvents(executor, eventsRef, { tools: [contextProbeTool] })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, makeMessage("context check"), {
            agentOverride: AgentName.make("test-external"),
          })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
      expect(capturedContexts).toHaveLength(1)
      const capturedCtx = capturedContexts[0]
      if (Predicate.isUndefined(capturedCtx)) return
      expect(capturedCtx.agent.name).toBe(AgentName.make("test-external"))
      expect(capturedCtx.cwd).toBe("/tmp")
      expect(capturedCtx.abortSignal).toBeDefined()
      expect(capturedCtx.tools.map((candidate) => String(getToolId(candidate)))).toEqual([
        "context_probe",
      ])
    }),
  )
  it.live("executor receives all live user message parts", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const capturedContexts: TurnContext[] = []
      const executor = makeCapturingExecutor([finish()], (ctx) => {
        capturedContexts.push(ctx)
      })
      const layer = makeLayerWithEvents(executor, eventsRef)
      const message = makeMessageWithParts([
        Prompt.textPart({ text: "first text" }),
        Prompt.filePart({
          data: "data:image/png;base64,abc",
          mediaType: "image/png",
        }),
        Prompt.textPart({ text: "second text" }),
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, message, {
            agentOverride: AgentName.make("test-external"),
          })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
      expect(capturedContexts).toHaveLength(1)
      const capturedCtx = capturedContexts[0]
      if (Predicate.isUndefined(capturedCtx)) return
      const lastUser = capturedCtx.messages.at(-1)
      expect(lastUser).toBeDefined()
      if (Predicate.isUndefined(lastUser)) return
      expect(lastUser.parts.map((part) => part.type)).toEqual(["text", "file", "text"])
      const lastPart = lastUser.parts[2]
      expect(lastPart).toBeDefined()
      if (Predicate.isUndefined(lastPart)) return
      expect(lastPart.type).toBe("text")
      if (lastPart.type === "text") expect(lastPart.text).toBe("second text")
    }),
  )
  it.live("reasoning-delta events are captured in assistant output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        reasoningDelta("thinking..."),
        textDelta("answer"),
        finish(),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, makeMessage("reason test"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          // Turn should complete successfully with reasoning present
          expect(tags).toContain("TurnCompleted")
          expect(tags).toContain("StreamChunk")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
})
// ── ExternalDriverContribution end-to-end ──
//
// Proves that `ExternalDriverContribution` wired through `DriverRegistry`
// (not a mock) actually dispatches to the registered `TurnExecutor` AND
// that the executor's text output lands in the stored messages.
describe("ExternalDriverContribution end-to-end", () => {
  it.live("text from TurnExecutor appears in stored messages via DriverRegistry dispatch", () =>
    Effect.gen(function* () {
      const e2eSessionId = SessionId.make("e2e-session")
      const e2eBranchId = BranchId.make("e2e-branch")
      // A simple TurnExecutor that emits a known response chunk then finishes.
      const expectedText = "hello from my-test-driver"
      const e2eExecutor: TurnExecutor = {
        executeTurn: () => Stream.fromIterable([textDelta(expectedText), finish()]),
      }
      // Agent referencing the external driver by id.
      const e2eAgent = AgentDefinition.make({
        name: AgentName.make("my-test-agent"),
        driver: ExternalDriverRef.make({ id: "my-test-driver" }),
      })
      // Register the contribution through resolveExtensions — the real path.
      const e2eResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("e2e-ext") },
          scope: "builtin",
          sourcePath: "test",
          contributions: {
            agents: [e2eAgent],
            externalDrivers: [
              { id: "my-test-driver", executor: e2eExecutor, invalidate: Effect.void },
            ],
          },
        },
      ])
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
      )
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        ExtensionRegistry.fromResolved(e2eResolved),
        DriverRegistry.fromResolved({
          modelDrivers: e2eResolved.modelDrivers,
          externalDrivers: e2eResolved.externalDrivers,
        }),
        // Messages go through focused storage directly — EventStore path is orthogonal.
        makeCountingEventStore(eventsRef),
        ToolRunner.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        BunServices.layer,
        ModelRegistry.Test(),
        GentPlatform.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoopOnce(agentLoop, {
            sessionId: e2eSessionId,
            branchId: e2eBranchId,
            agentName: AgentName.make("my-test-agent"),
            prompt: "trigger the external driver",
          })
          // Query the real Storage for the messages stored during the turn.
          const messages = yield* MessageStorage
          const messagesResult = yield* messages.listMessages(e2eBranchId)
          // The assistant message should contain the text emitted by the executor.
          const allText = messagesResult.map((m) => messagePartsText(m.parts))
          const combined = allText.join("")
          expect(combined).toContain(expectedText)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("external-driver tool calls and results persist into the assistant transcript", () =>
    Effect.gen(function* () {
      // External drivers stream the same Effect AI response parts as model
      // providers, so tool calls and results should persist without a Gent-only
      // adapter DTO between the driver and transcript projection.
      const e2eSessionId = SessionId.make("e2e-tool-session")
      const e2eBranchId = BranchId.make("e2e-tool-branch")
      const toolInput = { path: "/tmp/example" }
      const toolOutput = { contents: "hello" }
      const e2eExecutor: TurnExecutor = {
        executeTurn: () =>
          Stream.fromIterable([
            toolCall(ToolCallId.make("tc-A"), "read_file", toolInput),
            toolResult(ToolCallId.make("tc-A"), "read_file", toolOutput),
            textDelta("done"),
            finish(),
          ]),
      }
      const e2eAgent = AgentDefinition.make({
        name: AgentName.make("tool-test-agent"),
        driver: ExternalDriverRef.make({ id: "tool-test-driver" }),
      })
      const e2eResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("e2e-tool-ext") },
          scope: "builtin",
          sourcePath: "test",
          contributions: {
            agents: [e2eAgent],
            externalDrivers: [
              { id: "tool-test-driver", executor: e2eExecutor, invalidate: Effect.void },
            ],
          },
        },
      ])
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
      )
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        ExtensionRegistry.fromResolved(e2eResolved),
        DriverRegistry.fromResolved({
          modelDrivers: e2eResolved.modelDrivers,
          externalDrivers: e2eResolved.externalDrivers,
        }),
        makeCountingEventStore(eventsRef),
        ToolRunner.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        BunServices.layer,
        ModelRegistry.Test(),
        GentPlatform.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoopOnce(agentLoop, {
            sessionId: e2eSessionId,
            branchId: e2eBranchId,
            agentName: AgentName.make("tool-test-agent"),
            prompt: "do the tool",
          })
          const messages = yield* MessageStorage
          const messagesResult = yield* messages.listMessages(e2eBranchId)
          const toolCallParts = messagesResult.flatMap((m) => messagePartsToolCallParts(m.parts))
          const toolResultParts = messagesResult.flatMap((m) =>
            messagePartsToolResultParts(m.parts),
          )
          expect(toolCallParts.length).toBe(1)
          expect(toolCallParts[0]?.name).toBe("read_file")
          expect(toolResultParts.length).toBe(1)
          expect(toolResultParts[0]?.name).toBe("read_file")
          expect(toolResultParts[0]?.isFailure).toBe(false)
          // And the observability event records the real tool name
          // rather than the hardcoded "external".
          const events = yield* Ref.get(eventsRef)
          const succeeded = events.find((e) => e._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (!Predicate.isUndefined(succeeded) && "toolName" in succeeded) {
            expect(succeeded.toolName).toBe("read_file")
          }
          const started = events.find((e) => e._tag === "ToolCallStarted")
          expect(started).toEqual(expect.objectContaining({ input: toolInput }))
          expect(succeeded).toEqual(
            expect.objectContaining({
              summary: '{"contents":"hello"}',
              output: '{\n  "contents": "hello"\n}',
            }),
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("external-driver tool-failed events persist with real toolName", () =>
    Effect.gen(function* () {
      const e2eSessionId = SessionId.make("e2e-tool-fail-session")
      const e2eBranchId = BranchId.make("e2e-tool-fail-branch")
      const e2eExecutor: TurnExecutor = {
        executeTurn: () =>
          Stream.fromIterable([
            toolCall(ToolCallId.make("tc-F"), "bash"),
            failedToolResult(ToolCallId.make("tc-F"), "bash", "permission denied"),
            textDelta("ok"),
            finish(),
          ]),
      }
      const e2eAgent = AgentDefinition.make({
        name: AgentName.make("tool-fail-agent"),
        driver: ExternalDriverRef.make({ id: "tool-fail-driver" }),
      })
      const e2eResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("e2e-tool-fail-ext") },
          scope: "builtin",
          sourcePath: "test",
          contributions: {
            agents: [e2eAgent],
            externalDrivers: [
              { id: "tool-fail-driver", executor: e2eExecutor, invalidate: Effect.void },
            ],
          },
        },
      ])
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
      )
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        ExtensionRegistry.fromResolved(e2eResolved),
        DriverRegistry.fromResolved({
          modelDrivers: e2eResolved.modelDrivers,
          externalDrivers: e2eResolved.externalDrivers,
        }),
        makeCountingEventStore(eventsRef),
        ToolRunner.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        BunServices.layer,
        ModelRegistry.Test(),
        GentPlatform.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoopOnce(agentLoop, {
            sessionId: e2eSessionId,
            branchId: e2eBranchId,
            agentName: AgentName.make("tool-fail-agent"),
            prompt: "trigger a failure",
          })
          const messages = yield* MessageStorage
          const messagesResult = yield* messages.listMessages(e2eBranchId)
          const toolResultParts = messagesResult.flatMap((m) =>
            messagePartsToolResultParts(m.parts),
          )
          expect(toolResultParts.length).toBe(1)
          expect(toolResultParts[0]?.name).toBe("bash")
          expect(toolResultParts[0]?.isFailure).toBe(true)
          // Failure payload must mirror the model-driver shape: a
          // discriminated `{ error: string }` object, not a bare string.
          expect(toolResultParts[0]?.result).toEqual({ error: "permission denied" })
          const events = yield* Ref.get(eventsRef)
          const failed = events.find((e) => e._tag === "ToolCallFailed")
          expect(failed).toBeDefined()
          if (!Predicate.isUndefined(failed) && "toolName" in failed) {
            expect(failed.toolName).toBe("bash")
          }
          expect(failed).toEqual(
            expect.objectContaining({
              summary: '{"error":"permission denied"}',
              output: '{\n  "error": "permission denied"\n}',
            }),
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("duplicate final tool response parts de-duplicate in the stored transcript", () =>
    Effect.gen(function* () {
      // Upstream drivers can repeat the same provider tool-call part while
      // streaming. Normalization keeps one transcript tool-call/result per id.
      const e2eSessionId = SessionId.make("e2e-tool-dup-session")
      const e2eBranchId = BranchId.make("e2e-tool-dup-branch")
      const e2eExecutor: TurnExecutor = {
        executeTurn: () =>
          Stream.fromIterable([
            toolCall(ToolCallId.make("tc-dup"), "write_file"),
            toolCall(ToolCallId.make("tc-dup"), "write_file"),
            toolResult(ToolCallId.make("tc-dup"), "write_file", {}),
            toolResult(ToolCallId.make("tc-dup"), "write_file", {}),
            finish(),
          ]),
      }
      const e2eAgent = AgentDefinition.make({
        name: AgentName.make("tool-dup-agent"),
        driver: ExternalDriverRef.make({ id: "tool-dup-driver" }),
      })
      const e2eResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("e2e-tool-dup-ext") },
          scope: "builtin",
          sourcePath: "test",
          contributions: {
            agents: [e2eAgent],
            externalDrivers: [
              { id: "tool-dup-driver", executor: e2eExecutor, invalidate: Effect.void },
            ],
          },
        },
      ])
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
      )
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        ExtensionRegistry.fromResolved(e2eResolved),
        DriverRegistry.fromResolved({
          modelDrivers: e2eResolved.modelDrivers,
          externalDrivers: e2eResolved.externalDrivers,
        }),
        makeCountingEventStore(eventsRef),
        ToolRunner.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        BunServices.layer,
        ModelRegistry.Test(),
        GentPlatform.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoopOnce(agentLoop, {
            sessionId: e2eSessionId,
            branchId: e2eBranchId,
            agentName: AgentName.make("tool-dup-agent"),
            prompt: "write a file",
          })
          const messages = yield* MessageStorage
          const messagesResult = yield* messages.listMessages(e2eBranchId)
          const toolCallParts = messagesResult.flatMap((m) => messagePartsToolCallParts(m.parts))
          const toolResultParts = messagesResult.flatMap((m) =>
            messagePartsToolResultParts(m.parts),
          )
          expect(toolCallParts.length).toBe(1)
          expect(toolCallParts[0]?.name).toBe("write_file")
          expect(toolResultParts.length).toBe(1)
          expect(toolResultParts[0]?.name).toBe("write_file")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
})
