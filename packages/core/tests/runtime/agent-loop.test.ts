import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
  TxQueue,
  TxSubscriptionRef,
} from "effect"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  RequestId,
  SessionId,
  ToolCallId,
  ToolId,
} from "../../src/domain/ids"
import { CurrentWorkspaceId, DefaultWorkspaceId, WorkspaceId } from "../../src/server/workspace-rpc"
import {
  AgentLoop,
  AgentLoop as AgentLoopActor,
  AgentLoopSessionGovernance,
  type AgentLoopState,
  AgentLoopTestActor,
  buildInitialAgentLoopState,
  canStartTurnNow,
  emptyAdmissionGate,
  makeAgentLoopWorker,
  makeLoopInbox,
  wantsWakeOnRecovery,
} from "../../src/runtime/agent-loop"
import { TestClock } from "effect/testing"
import {
  AgentDefinition,
  AgentName,
  type AgentRunner,
  AgentRunnerService,
  DEFAULT_AGENT_NAME,
  DEFAULT_MAX_AGENT_RUN_DEPTH,
  ExternalDriverRef,
  makeRunSpec,
  Model,
  ModelId,
  ProviderId,
  type RunSpec,
  type SteerCommand,
} from "../../src/domain/agent"
import {
  assertSequence,
  createE2ELayer,
  createRpcHarness,
  ensureStorageParents,
  RecordingEventStore,
  SequenceRecorder,
} from "../../src/test-utils/index"
import {
  finishPart,
  LanguageModelLayers,
  type LanguageModelStreamPart,
  makeTempDirectoryScoped,
  multiToolCallStep,
  reasoningDeltaPart,
  textDeltaPart,
  textStep,
  toolCallPart,
  toolCallStep,
  waitFor,
} from "../../src/test-utils/language-model"
import {
  assistantMessageIdForTurn,
  Branch,
  dateFromMillis,
  emptyLoopQueueState,
  emptyQueueSnapshot,
  encodeToolOutput,
  LoopQueueState,
  type LoopQueueState as LoopQueueStateType,
  Message,
  messagePartsReasoning,
  messagePartsText,
  messagePartsToolCallParts,
  messageSingleText,
  type QueuedTurnItem,
  Session,
} from "../../src/domain/message"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  getToolId,
  request,
  type RequestCapability,
  tool,
  type ToolCapability,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import {
  AgentLoopQueueStorage,
  BranchStorage,
  EventStorage,
  makeStorageTransaction,
  MessageStorage,
  RelationshipStorage,
  SessionOperationStorage,
  SessionStorage,
  SqliteStorage,
  ToolCallBindingStorage,
} from "../../src/storage/storage"
import {
  helperAgent,
  makeAgentLoopService,
  makeExternalLayerWithEvents,
  makeExtRegistry,
  makeLayer,
  makeLayerWithEventPublisher,
  makeLayerWithEvents,
  makeLiveToolLayer,
  makeMessage,
  makeRecordingLayer,
  respondAgentLoopInteraction,
  retryableStreamError,
  runAgentLoop,
  scriptedProvider,
  steerAgentLoop,
  submitAgentLoop,
  waitFor as waitForOption,
  waitForPhase,
} from "./agent-loop-helpers"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  AgentEvent,
  EventEnvelope,
  EventId,
  EventPublisher,
  EventPublisherLive,
  EventStore,
  EventStoreError,
  MessageReceived,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "../../src/domain/event"
import {
  type ActiveStreamHandle,
  findPersistedToolResults,
  persistAssistantPartsWithBindings,
  toolResultMessageIdForTurn,
  ToolResultReplayError,
  TurnOutcome,
} from "../../src/runtime/turn"
import { windowDetails, windowMarkerMessage } from "../../src/runtime/model-context"
import { e2ePreset, ModelContextCompactorLive } from "../../../extensions/tests/helpers/test-preset"
import * as AiModel from "effect/unstable/ai/Model"
import { BunCrypto, BunFileSystem, BunServices } from "@effect/platform-bun"
import { Auth, ModelRegistry, ModelResolver } from "../../src/runtime/provider"
import {
  ExternalToolRunner,
  type ModelDriverContribution,
  type TurnContext,
  TurnError,
  type TurnExecutor,
  type TurnStreamPart,
} from "../../src/domain/driver"
import { ConfigService, RuntimeEnvironment } from "../../src/runtime/config"
import { GentPlatform } from "../../src/runtime/gent-platform"
import {
  ApprovalService,
  DriverRegistry,
  eraseResourceLayer,
  ExtensionRegistry,
  resolveExtensions,
  SessionProfileCache,
} from "../../src/runtime/extension-host"
import {
  type BranchToolFeature,
  BranchToolWork,
  captureCurrentToolBinding,
  CurrentBranchToolFeature,
  innerOperationBindingIdentity,
  noBranchTools,
  processLocalReplayBindingKey,
  ProcessLocalToolReplay,
  type ResolvedToolCapability,
  resolveReplayToolBinding,
  resolveStoredToolBinding,
  ToolRunner,
  makeTurnInterruption,
} from "../../src/runtime/tools"
import { AllBuiltinAgents, builtinAgent } from "../../../extensions/tests/helpers/builtin-agents"
import {
  AgentLoopError,
  buildIdleState,
  buildRunningState,
  entityIdOf,
  type LoopState,
  type RunningState,
  type SessionRuntimeState,
  SessionRuntimeStateSchema,
} from "../../src/domain/agent-loop"
import * as AiError from "effect/unstable/ai/AiError"
import { StorageError } from "../../src/domain/errors"
import { Database } from "bun:sqlite"
import { Gent } from "@gent/sdk"
import type { LanguageModel } from "effect/unstable/ai"
import { narrowR } from "../helpers/effect"
import { SingleRunner } from "effect/unstable/cluster"
import {
  EventStoreLive,
  getSessionDepth,
  SessionRuntime,
  SessionRuntimeError,
  type SessionRuntimeService,
} from "../../src/runtime/session"
import { test } from "bun:test"
import { InteractionPendingError } from "../../src/domain/interaction"
import * as Response from "effect/unstable/ai/Response"
import {
  LoadedArtifactIdentity,
  type LoadedExtension,
  type ExtensionContributions,
} from "../../src/domain/extension"
import {
  CapabilityError,
  ToolBindingIdentity,
  ToolBindingSource,
  ToolSchemaRevision,
  ToolSourceRevision,
} from "../../src/domain/capability"
import {
  admitChildSession,
  ChildCompletionDelivery,
  InProcessRunner,
} from "../../src/runtime/child-agents"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { SessionMutationsLive } from "../../src/server/server"

// ── agent-loop/primary-key-dedup.test ───────────────────────────────────────

/**
 * Regression: distinct `commandId` values for the same `(workspaceId,
 * sessionId, branchId)` must produce distinct `primaryKey` components in
 * each op's `ExecId`. Otherwise concurrent intents collapse via dedup —
 * a second `GetState`/`GetQueue`/`TerminateBranch` would silently piggyback
 * on the first instead of running independently.
 *
 * `ExecId` encoding is `${entityId}\x00${tag}\x00${primaryKey}` (see
 * effect-encore/src/actor.ts), so checking the encoded ExecId lets us
 * assert primaryKey divergence purely from the op-handle layer without
 * spinning up a runtime.
 */

describe("agent-loop op primary keys", () => {
  const workspaceId = DefaultWorkspaceId
  const sessionId = SessionId.make("primary-key-session")
  const branchId = BranchId.make("primary-key-branch")
  const cmd1 = ActorCommandId.make("cmd-1")
  const cmd2 = ActorCommandId.make("cmd-2")

  it.live("GetState with distinct commandIds produces distinct ExecIds on the same entity", () =>
    Effect.gen(function* () {
      const id1 = yield* AgentLoop.GetState.executionId({
        workspaceId,
        sessionId,
        branchId,
        commandId: cmd1,
      })
      const id2 = yield* AgentLoop.GetState.executionId({
        workspaceId,
        sessionId,
        branchId,
        commandId: cmd2,
      })
      expect(String(id1)).not.toBe(String(id2))
      expect(String(id1).endsWith(`\x00${cmd1}`)).toBe(true)
      expect(String(id2).endsWith(`\x00${cmd2}`)).toBe(true)
    }),
  )

  it.live("GetQueue with distinct commandIds produces distinct ExecIds on the same entity", () =>
    Effect.gen(function* () {
      const id1 = yield* AgentLoop.GetQueue.executionId({
        workspaceId,
        sessionId,
        branchId,
        commandId: cmd1,
      })
      const id2 = yield* AgentLoop.GetQueue.executionId({
        workspaceId,
        sessionId,
        branchId,
        commandId: cmd2,
      })
      expect(String(id1)).not.toBe(String(id2))
      expect(String(id1).endsWith(`\x00${cmd1}`)).toBe(true)
      expect(String(id2).endsWith(`\x00${cmd2}`)).toBe(true)
    }),
  )

  it.live(
    "TerminateBranch with distinct commandIds produces distinct ExecIds on the same entity",
    () =>
      Effect.gen(function* () {
        const id1 = yield* AgentLoop.TerminateBranch.executionId({
          workspaceId,
          sessionId,
          branchId,
          commandId: cmd1,
        })
        const id2 = yield* AgentLoop.TerminateBranch.executionId({
          workspaceId,
          sessionId,
          branchId,
          commandId: cmd2,
        })
        expect(String(id1)).not.toBe(String(id2))
        expect(String(id1).endsWith(`\x00${cmd1}`)).toBe(true)
        expect(String(id2).endsWith(`\x00${cmd2}`)).toBe(true)
      }),
  )
})

// ── agent/agent-loop.session-governance.test ────────────────────────────────

const sessionA = SessionId.make("session-a")
const sessionB = SessionId.make("session-b")
const workspaceA = "a".repeat(64)
const workspaceB = "b".repeat(64)

describe("session termination markers", () => {
  it.effect("isTerminated returns false for unmarked sessions", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      const terminated = yield* governance.isTerminated(workspaceA, sessionA)
      expect(terminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("markTerminated then isTerminated reflects the marker per session", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.markTerminated(workspaceA, sessionA)
      const aTerminated = yield* governance.isTerminated(workspaceA, sessionA)
      const bTerminated = yield* governance.isTerminated(workspaceA, sessionB)
      expect(aTerminated).toBe(true)
      expect(bTerminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("clearTerminated removes the marker", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.markTerminated(workspaceA, sessionA)
      yield* governance.clearTerminated(workspaceA, sessionA)
      const terminated = yield* governance.isTerminated(workspaceA, sessionA)
      expect(terminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("clearTerminated on an unmarked session is a no-op", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.clearTerminated(workspaceA, sessionA)
      const terminated = yield* governance.isTerminated(workspaceA, sessionA)
      expect(terminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("same session id does not collide across workspaces", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.markTerminated(workspaceA, sessionA)

      const workspaceATerminated = yield* governance.isTerminated(workspaceA, sessionA)
      const workspaceBTerminated = yield* governance.isTerminated(workspaceB, sessionA)

      expect(workspaceATerminated).toBe(true)
      expect(workspaceBTerminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )
})

// ── agent-loop/turn-lifetime.test ───────────────────────────────────────────

describe("turn lifetime", () => {
  it.scopedLive(
    "keeps a waiting model turn alive beyond the entity idle limit",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("LONG-TURN-COMPLETE"), gated: true },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          extensions: [],
          extensionInputs: [],
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
        })
        const completed = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(({ event }) => event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "Wait for the model" })
        yield* TestClock.adjust("10 seconds")
        yield* controls.waitForCall(0)
        yield* TestClock.adjust("2 minutes")
        yield* controls.emitAll(0)
        yield* Fiber.join(completed)
        expect(yield* controls.callCount).toBe(1)
        const messages = yield* client.message.list({ branchId })
        expect(
          messages.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text.includes("LONG-TURN-COMPLETE"),
            ),
          ),
        ).toBe(true)
      }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("8 seconds")),
    10_000,
  )
})

// ── agent-loop-concurrency.test ─────────────────────────────────────────────

describe("concurrency", () => {
  it.live("independent tool calls may overlap", () =>
    Effect.gen(function* () {
      const events: string[] = []
      let running = 0
      let maxRunning = 0
      const bothStarted = yield* Deferred.make<void>()
      const makeSerialTool = (name: string) =>
        tool({
          id: name,
          description: `Serial tool ${name}`,
          params: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                running += 1
                maxRunning = Math.max(maxRunning, running)
                events.push(`start:${name}`)
              })
              // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
              if (running > 1) yield* Deferred.succeed(bothStarted, undefined)
              yield* Deferred.await(bothStarted).pipe(Effect.timeout("1 second"))
              yield* Effect.sync(() => {
                events.push(`end:${name}`)
                running -= 1
              })
              return { ok: true }
            }),
        })
      const toolA = makeSerialTool("serial-a")
      const toolB = makeSerialTool("serial-b")
      const layer = makeLiveToolLayer(
        scriptedProvider([
          [
            toolCallPart("serial-a", {}, { toolCallId: ToolCallId.make("tc-1") }),
            toolCallPart("serial-b", {}, { toolCallId: ToolCallId.make("tc-2") }),
            finishPart({ finishReason: "tool-calls" }),
          ],
          [finishPart({ finishReason: "stop" })],
        ]),
        [toolA, toolB],
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const branchStorage = yield* BranchStorage
        const loop = yield* makeAgentLoopService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("serial-session"),
          name: "Serial Test",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("serial-branch"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessionStorage.createSession(session)
        yield* branchStorage.createBranch(branch)
        yield* loop.runOnce({
          sessionId: session.id,
          branchId: branch.id,
          agentName: DEFAULT_AGENT_NAME,
          prompt: "run serial tools",
        })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(maxRunning).toBeGreaterThan(1)
      expect(events.length).toBe(4)
      expect(events[0]?.startsWith("start:")).toBe(true)
      expect(events[1]?.startsWith("start:")).toBe(true)
      expect(events[2]?.startsWith("end:")).toBe(true)
      expect(events[3]?.startsWith("end:")).toBe(true)
      expect(new Set(events.map((event) => event.split(":")[1])).size).toBe(2)
    }),
  )
})
// ============================================================================

// ── agent-loop-continuation.test ────────────────────────────────────────────

describe("continuation", () => {
  const contSessionId = SessionId.make("cont-test-session")
  const contBranchId = BranchId.make("cont-test-branch")
  let messageSequence = 0
  const makeContMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make(`msg-${messageSequence++}`),
      sessionId: contSessionId,
      branchId: contBranchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })
  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (_params) => Effect.succeed({ text: _params.text }),
  })
  it.live("tool call auto-continues to next LLM call", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "hello" }),
        textStep("Done with tools."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("test auto-continue"))
        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )
  it.live("text-only response does not trigger continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("Just text, no tools."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("text only"))
        expect(yield* controls.callCount).toBe(1)
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )
  it.live("multi-hop tool calls chain until text response", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        toolCallStep("echo", { text: "step 3" }),
        textStep("Finally done."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("multi-hop"))
        expect(yield* controls.callCount).toBe(4)
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )
  it.live("TurnCompleted fires once per turn, not per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Done."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("turn-events"))
        expect(yield* controls.callCount).toBe(3)
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        expect(turnCompleted.length).toBe(1)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
  it.live("an interjection during a tool step joins the same turn at the next step boundary", () =>
    Effect.gen(function* () {
      const latestUserText = (request: { readonly prompt: Prompt.RawInput }) => {
        const latest = [...Prompt.make(request.prompt).content]
          .reverse()
          .find((message) => message.role === "user")
        if (Predicate.isUndefined(latest)) return ""
        return latest.content
          .filter((part): part is Prompt.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      }
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...toolCallStep("echo", { text: "step 1" }), gated: true },
        {
          ...textStep("Done after steering."),
          assertOptions: (options) => {
            expect(latestUserText(options)).toBe("steer now")
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const turn = makeContMessage("steer at step boundary")
        const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, turn))
        yield* controls.waitForCall(0)
        yield* steerAgentLoop({
          _tag: "Interject",
          sessionId: contSessionId,
          branchId: contBranchId,
          requestId: "req-interject-step-boundary",
          message: "steer now",
        })
        yield* controls.emitAll(0)
        yield* Fiber.join(fiber)
        // One turn, two model calls: the steering did not interrupt the stream.
        expect(yield* controls.callCount).toBe(2)
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((event) => event._tag === "TurnCompleted")).toHaveLength(1)
        expect(
          events.some((event) => event._tag === "TurnCompleted" && event.interrupted === true),
        ).toBe(false)
        const messages = yield* messageStorage.listMessages(contBranchId)
        expect(messages.filter((message) => message._tag === "interjection")).toHaveLength(1)
        // The interjection sorts after the tool result it waited for, never between
        // the call and its result.
        const resultIndex = messages.findIndex((message) =>
          message.parts.some((part) => part.type === "tool-result"),
        )
        const interjectionIndex = messages.findIndex((message) => message._tag === "interjection")
        expect(resultIndex).toBeGreaterThanOrEqual(0)
        expect(interjectionIndex).toBeGreaterThan(resultIndex)
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
  it.live("an interjection that asks to wake starts a turn on an idle branch", () =>
    Effect.gen(function* () {
      const idleSessionId = SessionId.make("cont-idle-session")
      const idleBranchId = BranchId.make("cont-idle-branch")
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("Answered the idle steer."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        // No turn is running: nothing for the steering to join. The queue would
        // hold it forever if the actor did not start a turn on an idle branch.
        yield* steerAgentLoop({
          _tag: "Interject",
          sessionId: idleSessionId,
          branchId: idleBranchId,
          requestId: "req-interject-idle-start",
          message: "answer me",
          wake: true,
        })
        yield* waitForPhase(agentLoop, { sessionId: idleSessionId, branchId: idleBranchId }, "Idle")
        expect(yield* controls.callCount).toBe(1)
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((event) => event._tag === "TurnCompleted")).toHaveLength(1)
        const messages = yield* messageStorage.listMessages(idleBranchId)
        expect(messages.filter((message) => message._tag === "interjection")).toHaveLength(1)
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
  it.live("interrupt during tool execution stops continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("Continuation response."), gated: true },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const fiber = yield* Effect.forkChild(
          runAgentLoop(agentLoop, makeContMessage("interrupt test")),
        )
        yield* controls.waitForCall(1)
        yield* steerAgentLoop({
          _tag: "Interrupt",
          sessionId: contSessionId,
          branchId: contBranchId,
          requestId: "req-continuation-interrupt-first",
        })
        yield* controls.emitAll(1)
        yield* Fiber.join(fiber)
        expect(yield* controls.callCount).toBe(2)
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter(Schema.is(TurnCompleted))
        expect(turnCompleted.length).toBe(1)
        const tc = turnCompleted[0]
        expect(tc).toBeDefined()
        if (Predicate.isUndefined(tc)) return
        expect(tc.interrupted).toBe(true)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
  it.live("GUARD: ToolsFinished without interrupt routes to Resolving", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "tool" }),
        textStep("Continuation reached."),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, makeContMessage("structural guard"))
        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((e) => e._tag === "TurnCompleted").length).toBe(1)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
  it.live("GUARD: multi-hop persists distinct messages per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Final answer."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const msg = makeContMessage("multi-hop persistence")
        yield* runAgentLoop(agentLoop, msg)
        const a1 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 1))
        const t1 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 1))
        expect(a1).toBeDefined()
        expect(t1).toBeDefined()
        expect(a1!.role).toBe("assistant")
        expect(t1!.role).toBe("tool")
        const a2 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 2))
        const t2 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 2))
        expect(a2).toBeDefined()
        expect(t2).toBeDefined()
        expect(a2!.role).toBe("assistant")
        expect(t2!.role).toBe("tool")
        const a3 = yield* messageStorage.getMessage(assistantMessageIdForTurn(msg.id, 3))
        const t3 = yield* messageStorage.getMessage(toolResultMessageIdForTurn(msg.id, 3))
        expect(a3).toBeDefined()
        expect(a3!.role).toBe("assistant")
        expect(t3).toBeUndefined()
        expect(new Set([a1!.id, a2!.id, a3!.id]).size).toBe(3)
        expect(new Set([t1!.id, t2!.id]).size).toBe(2)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )
  it.live("queued follow-up executes normally after interrupt", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("gated response"), gated: true },
        textStep("follow-up response"),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const first = makeContMessage("first message")
        const followUp = makeContMessage("follow-up after interrupt")
        // Start first turn — tool call auto-continues to gated step
        yield* Effect.forkChild(runAgentLoop(agentLoop, first))
        // Wait for the gated step (second stream call) to start
        yield* controls.waitForCall(1)
        // Queue a follow-up while step 1 is gated
        yield* submitAgentLoop(agentLoop, followUp)
        // Interrupt the current turn. `agentLoop.steer` issues
        // `actor.call(Interrupt)` which is serialized request-reply — by the
        // time it returns, the actor has already set `interruptedRef = true`
        // and signalled the active stream. No additional wait needed.
        yield* steerAgentLoop({
          _tag: "Interrupt",
          sessionId: contSessionId,
          branchId: contBranchId,
          requestId: "req-continuation-interrupt-second",
        })
        // Release the gated step so the interrupted turn can finalize
        yield* controls.emitAll(1)
        // Wait for the follow-up to complete
        yield* waitForPhase(
          agentLoop,
          { sessionId: contSessionId, branchId: contBranchId },
          "Idle",
          200,
        )
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter(Schema.is(TurnCompleted))
        // Both turns should have completed
        expect(turnCompleted.length).toBe(2)
        const interruptedTurns = turnCompleted.filter((e) => e.interrupted === true)
        // First turn was interrupted, second (follow-up) was not
        expect(interruptedTurns.length).toBe(1)
        // Follow-up used the third provider step
        expect(yield* controls.callCount).toBe(3)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }),
  )
})

// ── agent-loop-empty-final-step.test ────────────────────────────────────────

/**
 * A turn whose last model step yields nothing must not report success.
 *
 * Observed in production against a real workspace: a multi-tool turn ran its
 * tools, the model then returned a step with no text and no tool calls, and
 * the loop finalized the turn as Done. No assistant message was ever stored
 * (`persistAssistantParts` skips an empty parts list), so the caller saw an
 * empty answer and exit 0 — a turn that silently produced nothing.
 */

describe("empty final step", () => {
  const sessionId = SessionId.make("empty-step-session")
  const branchId = BranchId.make("empty-step-branch")

  const userMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make("empty-step-msg-0"),
      sessionId,
      branchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })

  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })

  /** A model step that finishes with neither text nor tool calls. */
  const emptyStep = () => ({
    parts: [finishPart({ finishReason: "stop", usage: { inputTokens: 10, outputTokens: 0 } })],
  })

  it.live("stores an assistant message even when the last step is empty", () =>
    Effect.gen(function* () {
      // Third step answers the re-prompt the loop should issue after the
      // empty one. Without the fix the loop never asks, and it goes unused.
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "hello" }),
        emptyStep(),
        textStep("Here is the answer."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("do the thing"))

        const messageStorage = yield* MessageStorage
        const stored = yield* messageStorage.listMessages(branchId)
        const assistantTexts = stored
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "text")

        // The turn ran tools and then produced nothing. Reporting Done with no
        // assistant text at all is the failure: the caller cannot tell an empty
        // answer from a successful one.
        expect(assistantTexts.length).toBeGreaterThan(0)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )

  it.live("a step cut off at the output limit is retried in a smaller step", () =>
    Effect.gen(function* () {
      // Observed in the gamut testbed: the orchestrator wrote one giant tool
      // call, hit the output limit, and the loop reported the leading text
      // as the answer. The third step answers the re-prompt the loop should
      // issue after the truncated one.
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("echo", { text: "hello" }),
        {
          parts: [
            textDeltaPart("Let me delegate."),
            finishPart({ finishReason: "length", usage: { inputTokens: 10, outputTokens: 4096 } }),
          ],
        },
        textStep("Here is the answer."),
      ])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("do the thing"))

        const messageStorage = yield* MessageStorage
        const stored = yield* messageStorage.listMessages(branchId)
        const assistantTexts = stored
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.parts)
          .flatMap((part) => {
            if (part.type === "text") return [part.text]
            return []
          })
        expect(assistantTexts).toContain("Here is the answer.")
        const continuation = stored.find(
          (message) => message.metadata?.customType === "continuation",
        )
        expect(continuation?.role).toBe("user")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }),
  )

  it.live("marks the turn unanswered once every continuation is spent", () =>
    Effect.gen(function* () {
      // Three empty steps: the first two burn both continuations, the third
      // still says nothing. The loop has no move left, so the receipt must
      // record that it gave up rather than reporting an ordinary reply.
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        emptyStep(),
        emptyStep(),
        emptyStep(),
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const recorder = yield* SequenceRecorder
          yield* runAgentLoop(agentLoop, userMessage("do the thing"))

          const calls = yield* recorder.getCalls
          const turnCompleted = calls
            .filter((call) => call.service === "EventStore" && call.method === "append")
            .map((call) => Schema.decodeUnknownOption(AgentEvent)(call.args))
            .filter(Option.isSome)
            .map(({ value }) => value)
            .filter((event) => event._tag === "TurnCompleted")

          expect(turnCompleted.length).toBeGreaterThan(0)
          // Without the flag every field here reads exactly like a successful
          // turn, and the caller cannot tell "gave up" from "replied".
          expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeRecordingLayer(providerLayer))),
      )
    }),
  )

  it.live("spends every continuation before giving up", () =>
    Effect.gen(function* () {
      // `LanguageModelLayers.empty` is the layer `gent --mock-empty` runs on,
      // so this pins the same path the CLI exercises: the loop must re-prompt
      // MAX_CONTINUATIONS_PER_TURN times rather than stopping at the first
      // empty step, and it must stop rather than looping forever.
      const providerLayer = LanguageModelLayers.empty
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const recorder = yield* SequenceRecorder
          yield* runAgentLoop(agentLoop, userMessage("do the thing"))

          const calls = yield* recorder.getCalls
          const events = calls
            .filter((call) => call.service === "EventStore" && call.method === "append")
            .map((call) => Schema.decodeUnknownOption(AgentEvent)(call.args))
            .filter(Option.isSome)
            .map(({ value }) => value)

          const turnCompleted = events.filter((event) => event._tag === "TurnCompleted")
          expect(turnCompleted.length).toBeGreaterThan(0)
          expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeRecordingLayer(providerLayer))),
      )
    }),
  )
})

// ── agent-loop-max-steps.test ───────────────────────────────────────────────

/**
 * A turn that spends the whole step budget must not report success.
 *
 * `runTurn` bounds a turn at `MAX_TURN_STEPS` so a model that asks for tools
 * forever cannot run without end. That exit left `interrupted`, `streamFailed`
 * and `unanswered` all false, so the turn published a `TurnCompleted` that
 * reads exactly like an ordinary reply. `headless-runner.ts:122` picks its exit
 * code from `event.unanswered !== true`, so `gent -H` against a looping model
 * exited 0 having printed no answer at all.
 *
 * Same failure as `agent-loop-empty-final-step.test.ts` guards, at the other
 * exit from the same loop: a turn that gave up must say so.
 */

describe("max turn steps", () => {
  const sessionId = SessionId.make("max-steps-session")
  const branchId = BranchId.make("max-steps-branch")

  const userMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make("max-steps-msg-0"),
      sessionId,
      branchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })

  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })

  /**
   * A model that asks for the same tool on every step and never answers. Real
   * providers stop on their own; this one does not, which is the case the step
   * bound exists for.
   */
  const alwaysToolCalls = LanguageModelLayers.testStream(() =>
    Effect.succeed(
      Stream.make(
        toolCallPart("echo", { text: "again" }),
        finishPart({ finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }),
      ),
    ),
  )

  it.live("a turn that spends the whole step budget is marked unanswered", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        // The budget is the agent's to lower; three steps prove the same exit
        // the default two hundred do.
        yield* runAgentLoop(agentLoop, userMessage("loop forever"), {
          runSpec: makeRunSpec({ overrides: { maxSteps: 3 } }),
        })

        const events = yield* Ref.get(eventsRef)
        expect(events.filter((event) => event._tag === "StreamStarted")).toHaveLength(3)
        const turnCompleted = events.filter((event) => event._tag === "TurnCompleted")
        expect(turnCompleted.length).toBeGreaterThan(0)
        // Without the flag this reads as a successful turn with an empty
        // transcript, and headless mode exits 0 on it.
        expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(alwaysToolCalls, eventsRef, [echoTool])))
    }),
  )

  /**
   * Steering joins a turn at a step boundary by leaving the queue. On the last
   * step of the budget there is no next step, so a message delivered there
   * would leave the queue and never reach a prompt.
   */
  it.live("steering that arrives during the last budgeted step opens the next turn", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...textStep("the budget's only answer"), gated: true },
        {
          ...textStep("read the steering"),
          assertOptions: (options) => {
            const texts = Prompt.make(options.prompt).content.flatMap((message) => {
              if (message.role !== "user") return []
              return message.content.flatMap((part) => {
                if (part.type !== "text") return []
                return [part.text]
              })
            })
            expect(texts).toContain("steer late")
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const fiber = yield* Effect.forkChild(
          runAgentLoop(agentLoop, userMessage("answer once"), {
            runSpec: makeRunSpec({ overrides: { maxSteps: 1 } }),
          }),
        )
        yield* controls.waitForCall(0)
        yield* steerAgentLoop({
          _tag: "Interject",
          sessionId,
          branchId,
          requestId: "req-interject-last-step",
          message: "steer late",
        })
        yield* controls.emitAll(0)
        yield* Fiber.join(fiber)
        yield* controls.waitForCall(1)
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )

  /**
   * The same failure at the loop's other give-up exit.
   *
   * `resolveTurnContext` publishes `ErrorOccurred` and returns undefined for an
   * agent no extension defines (`turn-resolve.ts:134`). `runTurnStep` turned
   * that into a `Stop` with every flag false, so the turn published a
   * `TurnCompleted` indistinguishable from a reply.
   */
  it.live("a turn for an unknown agent is marked unanswered", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, userMessage("who are you"), {
          agentOverride: AgentName.make("no-such-agent"),
        })

        const events = yield* Ref.get(eventsRef)
        expect(
          events.some(
            (event) =>
              event._tag === "ErrorOccurred" && event.error === "Unknown agent: no-such-agent",
          ),
        ).toBe(true)
        const turnCompleted = events.filter((event) => event._tag === "TurnCompleted")
        expect(turnCompleted).toHaveLength(1)
        expect(turnCompleted.every((event) => event.unanswered === true)).toBe(true)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(alwaysToolCalls, eventsRef, [echoTool])))
    }),
  )
})

// ── agent-loop-turn-stream.test ─────────────────────────────────────────────

describe("turn stream parity", () => {
  it.live("model and external turns produce the same assistant draft and lifecycle tags", () =>
    Effect.gen(function* () {
      const expectedTags: AgentEvent["_tag"][] = [
        "MessageReceived",
        "StreamStarted",
        "StreamChunk",
        "StreamEnded",
        "MessageReceived",
        "TurnCompleted",
      ]
      const modelEventsRef = yield* Ref.make<AgentEvent[]>([])
      const externalEventsRef = yield* Ref.make<AgentEvent[]>([])
      const modelDraft = yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("model-parity-session"),
          BranchId.make("model-parity-branch"),
          "hello",
        )
        yield* runAgentLoop(agentLoop, message)
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        return {
          text: messagePartsText(assistant!.parts),
          reasoning: messagePartsReasoning(assistant!.parts),
          toolCalls: messagePartsToolCallParts(assistant!.parts),
        }
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(
          makeLayerWithEvents(
            scriptedProvider([
              [
                reasoningDeltaPart("thinking"),
                textDeltaPart("hello from parity"),
                finishPart({
                  finishReason: "stop",
                  usage: { inputTokens: 3, outputTokens: 5 },
                }),
              ],
            ]),
            modelEventsRef,
          ),
        ),
      )
      const externalDraft = yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("external-parity-session"),
          BranchId.make("external-parity-branch"),
          "hello",
        )
        yield* runAgentLoop(agentLoop, message, {
          agentOverride: AgentName.make("test-external-parity"),
        })
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        return {
          text: messagePartsText(assistant!.parts),
          reasoning: messagePartsReasoning(assistant!.parts),
          toolCalls: messagePartsToolCallParts(assistant!.parts),
        }
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(
          makeExternalLayerWithEvents(
            [
              reasoningDeltaPart("thinking"),
              textDeltaPart("hello from parity"),
              finishPart({
                finishReason: "stop",
                usage: { inputTokens: 3, outputTokens: 5 },
              }),
            ],
            externalEventsRef,
          ),
        ),
      )
      expect(modelDraft).toEqual(externalDraft)
      // Only a model turn projects context; the lifecycle around it must still match.
      const modelTags = (yield* Ref.get(modelEventsRef))
        .map((event) => event._tag)
        .filter((tag): tag is AgentEvent["_tag"] => tag !== "ModelContextProjected")
      expect(modelTags).toEqual([...expectedTags])
      expect((yield* Ref.get(externalEventsRef)).map((event) => event._tag)).toEqual([
        ...expectedTags,
      ])
    }),
  )
})

// ── agent-loop/tool-projection-reconciliation.test ──────────────────────────

describe("tool projection reconciliation", () => {
  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })

  it.live("fails a stale running tool projection before any new model work", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("orphan-session")
      const branchId = BranchId.make("orphan-branch")
      const toolCallId = ToolCallId.make("orphan-call")
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("never reached"),
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const messageStorage = yield* MessageStorage
          const eventStorage = yield* EventStorage
          yield* ensureStorageParents({ sessionId, branchId })
          const turn = makeMessage(sessionId, branchId, "resume me")
          const assistantMessageId = assistantMessageIdForTurn(turn.id, 1)
          // A previous host died after admitting the call: the assistant message
          // holds the tool call, the start event exists, and no result was stored.
          yield* messageStorage.createMessage(
            Message.cases.regular.make({
              id: assistantMessageId,
              sessionId,
              branchId,
              role: "assistant",
              parts: [
                Prompt.toolCallPart({
                  id: toolCallId,
                  name: "echo",
                  params: { text: "stale" },
                  providerExecuted: false,
                }),
              ],
              createdAt: dateFromMillis(1_767_225_600_000),
            }),
          )
          yield* eventStorage.appendEvent(
            ToolCallStarted.make({
              sessionId,
              branchId,
              toolCallId,
              toolName: "echo",
              input: { text: "stale" },
              assistantMessageId,
            }),
          )

          const agentLoop = yield* makeAgentLoopService
          yield* Effect.exit(runAgentLoop(agentLoop, turn))

          // The binding cannot be replayed, so the projection is closed as failed
          // and the model is not called again for this turn.
          const events = yield* Ref.get(eventsRef)
          const failed = events.find((event) => event._tag === "ToolCallFailed")
          expect(failed).toMatchObject({
            _tag: "ToolCallFailed",
            toolCallId,
            toolName: "echo",
            assistantMessageId,
          })
          expect(events.some((event) => event._tag === "StreamStarted")).toBe(false)
          expect(yield* controls.callCount).toBe(0)
          const result = yield* messageStorage.getMessage(toolResultMessageIdForTurn(turn.id, 1))
          expect(result?.parts).toMatchObject([
            { type: "tool-result", id: toolCallId, isFailure: true },
          ])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool]))),
      )
    }),
  )
})

// ── agent-loop/model-compaction.test ────────────────────────────────────────

const promptText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (Predicate.isString(message.content)) return [message.content]
      return message.content
        .filter((part): part is Prompt.TextPart => part.type === "text")
        .map((part) => part.text)
    })
    .join("\n")

describe("native model compaction integration", () => {
  it.live("hands off the history before the turn and keeps every message durable", () => {
    const sessionId = SessionId.make("native-compaction-session")
    const branchId = BranchId.make("native-compaction-branch")
    const oldMessages = Array.from({ length: 12 }, (_, index) =>
      Message.cases.regular.make({
        id: MessageId.make(`native-old-${index + 1}`),
        sessionId,
        branchId,
        role: "assistant",
        parts: [Prompt.textPart({ text: `native-old-${index + 1} ${"x".repeat(50_000)}` })],
        createdAt: dateFromMillis(1_000 + index),
      }),
    )
    let providerCalls = 0
    let mainPrompt = Option.none<Prompt.Prompt>()
    const providerLayer = LanguageModelLayers.testStream((options) => {
      providerCalls += 1
      if (providerCalls === 2) mainPrompt = Option.some(Prompt.make(options.prompt))
      let text = "native response"
      if (providerCalls === 1) text = "native bounded summary"
      return Effect.succeed(
        Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })]),
      )
    })

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* ensureStorageParents({ sessionId, branchId })
        const storage = yield* MessageStorage
        yield* Effect.forEach(oldMessages, (message) => storage.createMessage(message), {
          discard: true,
        })
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "native current turn"))

        expect(providerCalls).toBe(2)
        expect(Option.isSome(mainPrompt)).toBe(true)
        if (Option.isNone(mainPrompt)) return yield* Effect.die("main prompt missing")
        const main = promptText(mainPrompt.value)
        expect(main).toContain("Context handoff")
        expect(main).toContain("native bounded summary")
        expect(main).toContain(`Session ${sessionId}, branch ${branchId}`)
        expect(main).toContain("native current turn")
        // The handoff replaced the old messages in the model view.
        expect(main).not.toContain("native-old-1 xxxx")

        const durable = yield* storage.listMessages(branchId)
        const markers = durable.filter(
          (message) => message.metadata?.customType === "context-window",
        )
        expect(markers).toHaveLength(1)
        const marker = markers[0]
        if (Predicate.isUndefined(marker)) return yield* Effect.die("marker missing")
        const details = Option.getOrThrow(windowDetails(marker))
        expect(details.summarized).toMatchObject({
          firstMessageId: "native-old-1",
          lastMessageId: "native-old-12",
          count: 12,
        })
        expect(main).toContain("native-old-1 … native-old-12")
        expect(durable.some((message) => message.id === oldMessages[0]?.id)).toBe(true)
      }),
    ).pipe(
      Effect.provide(makeLayer(providerLayer).pipe(Layer.provideMerge(ModelContextCompactorLive))),
      Effect.timeout("15 seconds"),
    )
  })

  it.live("a smaller agent context window hands off history the catalog window would keep", () => {
    const sessionId = SessionId.make("small-window-session")
    const branchId = BranchId.make("small-window-branch")
    // ~3,000 tokens: far under the 128k test catalog limit, over a 6k window minus reserves.
    const oldMessages = Array.from({ length: 12 }, (_, index) =>
      Message.cases.regular.make({
        id: MessageId.make(`small-old-${index + 1}`),
        sessionId,
        branchId,
        role: "assistant",
        parts: [Prompt.textPart({ text: `small-old-${index + 1} ${"x".repeat(1_000)}` })],
        createdAt: dateFromMillis(1_000 + index),
      }),
    )
    let providerCalls = 0
    const providerLayer = LanguageModelLayers.testStream(() => {
      providerCalls += 1
      let text = "small response"
      if (providerCalls === 1) text = "small bounded summary"
      return Effect.succeed(
        Stream.fromIterable([textDeltaPart(text), finishPart({ finishReason: "stop" })]),
      )
    })

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* ensureStorageParents({ sessionId, branchId })
        const storage = yield* MessageStorage
        yield* Effect.forEach(oldMessages, (message) => storage.createMessage(message), {
          discard: true,
        })
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "small current turn"), {
          runSpec: { overrides: { contextLength: 6_000 } },
        })

        expect(providerCalls).toBe(2)
        const durable = yield* storage.listMessages(branchId)
        const markers = durable.filter(
          (message) => message.metadata?.customType === "context-window",
        )
        expect(markers).toHaveLength(1)
      }),
    ).pipe(
      Effect.provide(makeLayer(providerLayer).pipe(Layer.provideMerge(ModelContextCompactorLive))),
      Effect.timeout("15 seconds"),
    )
  })
})

// ── agent-loop/model-context.test ───────────────────────────────────────────

const promptTextModelContext = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (Predicate.isString(message.content)) return [message.content]
      return message.content.filter(Schema.is(Prompt.TextPart)).map((part) => part.text)
    })
    .join("\n")

describe("native model context projection", () => {
  it.live("truncates the provider prompt while preserving durable history", () => {
    const oldMarker = "old-context-marker"
    let capturedPrompt: Option.Option<Prompt.Prompt> = Option.none()
    const providerLayer = LanguageModelLayers.testStream((options) => {
      capturedPrompt = Option.some(Prompt.make(options.prompt))
      return Effect.succeed(
        Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
      )
    })
    const sessionId = SessionId.make("model-context-session")
    const branchId = BranchId.make("model-context-branch")

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* ensureStorageParents({ sessionId, branchId })
        const messageStorage = yield* MessageStorage
        yield* messageStorage.createMessage(
          Message.cases.regular.make({
            id: MessageId.make("old-context-message"),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: `${oldMarker} ${"x".repeat(520_000)}` })],
            createdAt: dateFromMillis(1),
          }),
        )

        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "fresh request"))

        expect(Option.isSome(capturedPrompt)).toBe(true)
        if (Option.isNone(capturedPrompt)) return yield* Effect.die("provider did not run")
        const submittedText = promptTextModelContext(capturedPrompt.value)
        expect(submittedText).toContain("fresh request")
        expect(submittedText).not.toContain(oldMarker)

        const durableMessages = yield* messageStorage.listMessages(branchId)
        expect(
          durableMessages.some((message) =>
            message.parts.some((part) => part.type === "text" && part.text.includes(oldMarker)),
          ),
        ).toBe(true)
      }),
    ).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("5 seconds"))
  })

  it.live("keeps parallel native tool calls and results paired", () => {
    const readTool = tool({
      id: "read",
      description: "Read a test path.",
      params: Schema.Struct({ path: Schema.String }),
      output: Schema.String,
      execute: (input) => Effect.succeed(input.path),
    })
    let capturedPrompt: Option.Option<Prompt.Prompt> = Option.none()

    return Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        multiToolCallStep(
          { toolName: "read", input: { path: "first.txt" }, toolCallId: ToolCallId.make("pair-1") },
          {
            toolName: "read",
            input: { path: "second.txt" },
            toolCallId: ToolCallId.make("pair-2"),
          },
        ),
        {
          ...textStep("done"),
          assertOptions: (options) => {
            capturedPrompt = Option.some(Prompt.make(options.prompt))
          },
        },
      ])
      const run = Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const sessionId = SessionId.make("model-context-tool-session")
        const branchId = BranchId.make("model-context-tool-branch")
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "run parallel tools"))
        yield* controls.assertDone

        expect(Option.isSome(capturedPrompt)).toBe(true)
        if (Option.isNone(capturedPrompt)) return yield* Effect.die("second provider call missing")
        const messages = capturedPrompt.value.content
        const callIds = messages.flatMap((message) => {
          if (message.role !== "assistant" || Predicate.isString(message.content)) return []
          return message.content.filter(Schema.is(Prompt.ToolCallPart)).map((part) => part.id)
        })
        const resultIds = messages.flatMap((message) => {
          if (message.role !== "tool" || Predicate.isString(message.content)) return []
          return message.content.filter(Schema.is(Prompt.ToolResultPart)).map((part) => part.id)
        })
        expect(callIds).toEqual([ToolCallId.make("pair-1"), ToolCallId.make("pair-2")])
        expect(resultIds).toEqual([ToolCallId.make("pair-1"), ToolCallId.make("pair-2")])
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- The provider layer is created by this test.
        Effect.provide(makeLayer(providerLayer, [readTool])),
      )
      yield* run
    }).pipe(Effect.timeout("5 seconds"))
  })

  it.live("leaves the output limit to the provider and passes the stable session cache key", () => {
    const modelId = ModelId.make("context-driver/model")
    let observedMaxTokens = Option.none<number>()
    const observedCacheKeys: Array<Option.Option<string>> = []
    const providerLayer = LanguageModelLayers.testStream(() =>
      Effect.succeed(
        Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
      ),
    )
    const driver: ModelDriverContribution = {
      id: "context-driver",
      name: "Context driver",
      resolveModel: (_modelName, _authInfo, hints) =>
        Effect.sync(() => {
          const maxTokens = Option.fromUndefinedOr(hints).pipe(
            Option.flatMap((value) => Option.fromUndefinedOr(value.maxTokens)),
          )
          if (Option.isSome(maxTokens)) observedMaxTokens = maxTokens
          observedCacheKeys.push(Option.fromUndefinedOr(hints?.cacheKey))
          return AiModel.make("context-driver", "model", providerLayer)
        }),
    }
    const resolved = resolveExtensions([
      {
        manifest: { id: ExtensionId.make("model-context-driver") },
        scope: "builtin",
        sourcePath: "test",
        contributions: { agents: AllBuiltinAgents, modelDrivers: [driver] },
      },
    ])
    const extensionRegistry = ExtensionRegistry.fromResolved(resolved)
    const driverRegistry = DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    })
    const modelResolver = ModelResolver.Live.pipe(
      Layer.provide(Layer.mergeAll(Auth.Test(), driverRegistry)),
    )
    const deps = Layer.mergeAll(
      SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
      extensionRegistry,
      driverRegistry,
      RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      EventStore.Memory,
      ToolRunner.Test(),
      ApprovalService.Test(),
      BunServices.layer,
      ModelRegistry.Test([
        Model.make({
          id: modelId,
          name: "Context model",
          provider: ProviderId.make("context-driver"),
          contextLength: 128_000,
        }),
      ]),
      GentPlatform.Test(),
      modelResolver,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    const layer = AgentLoopTestActor({ baseSections: [] }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
      ),
    )

    return Effect.scoped(
      Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(
          agentLoop,
          makeMessage(
            SessionId.make("model-context-driver-session"),
            BranchId.make("model-context-driver-branch"),
            "request provider budget",
          ),
          { runSpec: { overrides: { modelId } } },
        )
        expect(observedMaxTokens).toEqual(Option.none())
        yield* runAgentLoop(
          agentLoop,
          makeMessage(
            SessionId.make("model-context-driver-session"),
            BranchId.make("model-context-driver-branch"),
            "continue with the same cache key",
          ),
          { runSpec: { overrides: { modelId } } },
        )
        expect(observedCacheKeys).toEqual([
          Option.some("model-context-driver-session"),
          Option.some("model-context-driver-session"),
        ])
      }),
    ).pipe(Effect.provide(layer), Effect.timeout("5 seconds"))
  })
})

// ── agent-loop/admission-withdrawal.test ────────────────────────────────────

const sessionId = SessionId.make("withdrawal-session")
const branchId = BranchId.make("withdrawal-branch")

const queuedItem = (id: string): QueuedTurnItem => ({
  message: Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId,
    branchId,
    role: "user",
    parts: [Prompt.textPart({ text: id })],
    createdAt: dateFromMillis(1_767_225_600_000),
  }),
})

/** The admitted item sits in `inFlight` and names the Running checkpoint; the turn has not started. */
const admitted = (item: QueuedTurnItem, rest: ReadonlyArray<QueuedTurnItem>) => ({
  state: buildRunningState(item, { startedAtMs: 1 }),
  queue: { ...emptyLoopQueueState(), followUp: [...rest], inFlight: item },
})

/**
 * The worker runs against a real `LoopInbox`, not a stub of the queue algebra.
 * The subject is the admission gate, and only a real inbox proves the worker's
 * withdrawal and the inbox's in-flight slot agree about what was admitted.
 * Storage is a memory cell: the durable write is not this test's subject.
 */
const memoryQueueStorage = Layer.effect(
  AgentLoopQueueStorage,
  Effect.gen(function* () {
    const rows = yield* Ref.make(new Map<string, LoopQueueState>())
    const key = (s: string, b: string) => `${s}/${b}`
    return AgentLoopQueueStorage.of({
      getQueueState: (s, b) =>
        Ref.get(rows).pipe(Effect.map((map) => map.get(key(s, b)) ?? emptyLoopQueueState())),
      putQueueState: (s, b, queue) => Ref.update(rows, (map) => new Map(map).set(key(s, b), queue)),
    })
  }),
)

const makeHarness = (initial: { state: LoopState; queue: LoopQueueState }) =>
  Effect.gen(function* () {
    const loopRef = yield* TxSubscriptionRef.make<AgentLoopState>(
      buildInitialAgentLoopState({ state: initial.state, queue: initial.queue }),
    )
    const inbox = yield* makeLoopInbox({
      sessionId,
      branchId,
      loopRef,
      queuePersistenceSemaphore: yield* Semaphore.make(1),
      persistenceFailure: yield* Deferred.make<void, AgentLoopError>(),
      startedRef: yield* Ref.make(true),
    })
    const ranTurns = yield* Ref.make<ReadonlyArray<string>>([])
    const turnWorkerQueue = yield* TxQueue.unbounded<RunningState>()
    const gateRef = yield* Ref.make(emptyAdmissionGate)
    const worker = makeAgentLoopWorker<never, never>({
      sessionId,
      branchId,
      sideMutationSemaphore: yield* Semaphore.make(1),
      interruptSemaphore: yield* Semaphore.make(1),
      turnWorkerQueue,
      activeStreamRef: yield* Ref.make(Option.none<ActiveStreamHandle>()),
      turnInterruption: yield* makeTurnInterruption,
      interruptToolWork: Effect.void,
      inbox,
      admissionGateRef: gateRef,
      recordTurnFailure: () => Effect.void,
      publishEvent: () => Effect.void,
      runTurn: (state) =>
        Ref.update(ranTurns, (ids) => [...ids, String(state.message.id)]).pipe(
          Effect.as(TurnOutcome.cases.Done.make({})),
        ),
    })
    const phase = inbox.phase
    const queue = TxSubscriptionRef.get(loopRef).pipe(Effect.map((s) => s.queue))
    const setPhase = (next: LoopState) => inbox.moveToPhase(next)
    return { worker, phase, queue, setPhase, ranTurns, turnWorkerQueue, gateRef }
  }).pipe(Effect.provide(memoryQueueStorage))

const waitForEmptyWorkerQueue = (queue: TxQueue.TxQueue<RunningState>): Effect.Effect<void> =>
  TxQueue.size(queue).pipe(
    Effect.flatMap((size) => {
      if (size === 0) return Effect.void
      return Effect.yieldNow.pipe(Effect.andThen(waitForEmptyWorkerQueue(queue)))
    }),
  )

describe("admitted turn withdrawal", () => {
  it.effect("withdrawing the admitted turn returns the branch to idle", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness(admitted(first, []))
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      expect(withdrawn).toBe(true)
      expect((yield* harness.phase)._tag).toBe("Idle")
      expect((yield* harness.queue).inFlight).toBeUndefined()
    }),
  )

  it.effect("withdrawing the admitted turn promotes the next queued follow-up", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const second = queuedItem("second")
      const harness = yield* makeHarness(admitted(first, [second]))
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      expect(withdrawn).toBe(true)
      const state = yield* harness.phase
      expect(state._tag).toBe("Running")
      if (state._tag === "Running") expect(String(state.message.id)).toBe("second")
      expect((yield* harness.queue).followUp).toHaveLength(0)
    }),
  )

  it.effect("a message that is not the admitted turn is left alone", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness(admitted(first, []))
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(MessageId.make("other"))
      expect(withdrawn).toBe(false)
      expect((yield* harness.phase)._tag).toBe("Running")
    }),
  )

  it.effect("a turn the worker already claimed cannot be withdrawn", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness(admitted(first, []))
      yield* Ref.set(harness.gateRef, {
        ...emptyAdmissionGate,
        started: Option.some(first.message.id),
      })
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      expect(withdrawn).toBe(false)
      expect((yield* harness.phase)._tag).toBe("Running")
    }),
  )

  it.effect("a resumed turn without an in-flight marker is not withdrawn", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness({
        state: buildRunningState(first, { startedAtMs: 1 }),
        queue: emptyLoopQueueState(),
      })
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      expect(withdrawn).toBe(false)
      expect((yield* harness.phase)._tag).toBe("Running")
    }),
  )

  it.effect("the worker skips a withdrawn admission left in its queue", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const initial = admitted(first, [])
      const harness = yield* makeHarness(initial)
      // The finishing turn enqueued `first`; the withdrawal lands before the worker takes it.
      yield* TxQueue.offer(harness.turnWorkerQueue, initial.state)
      yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      yield* harness.setPhase(buildIdleState())
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      yield* waitForEmptyWorkerQueue(harness.turnWorkerQueue)
      expect(yield* Ref.get(harness.ranTurns)).toEqual([])
      yield* Fiber.interrupt(loop)
    }),
  )

  it.effect("two concurrent withdrawals of one admission remove it exactly once", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const initial = admitted(first, [])
      const harness = yield* makeHarness(initial)
      yield* TxQueue.offer(harness.turnWorkerQueue, initial.state)
      const results = yield* Effect.all(
        [
          harness.worker.withdrawAdmittedTurn(first.message.id),
          harness.worker.withdrawAdmittedTurn(first.message.id),
        ],
        { concurrency: "unbounded" },
      )
      expect(results.filter((removed) => removed)).toHaveLength(1)
      expect((yield* harness.phase)._tag).toBe("Idle")
      // The losing call must not clear the marker the worker checks.
      expect(Option.getOrUndefined((yield* Ref.get(harness.gateRef)).withdrawn)).toBe(
        first.message.id,
      )
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      yield* waitForEmptyWorkerQueue(harness.turnWorkerQueue)
      expect(yield* Ref.get(harness.ranTurns)).toEqual([])
      yield* Fiber.interrupt(loop)
    }),
  )

  it.effect("a promoted follow-up can be withdrawn in turn", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const second = queuedItem("second")
      const harness = yield* makeHarness(admitted(first, [second]))
      expect(yield* harness.worker.withdrawAdmittedTurn(first.message.id)).toBe(true)
      expect(yield* harness.worker.withdrawAdmittedTurn(first.message.id)).toBe(false)
      expect(yield* harness.worker.withdrawAdmittedTurn(second.message.id)).toBe(true)
      expect((yield* harness.phase)._tag).toBe("Idle")
      expect((yield* harness.queue).followUp).toHaveLength(0)
    }),
  )
})

// ── agent-loop/turn-lifecycle-hooks.test ────────────────────────────────────

/**
 * How a turn ended, as an extension reads it.
 *
 * `turnAfter` carries both facts a handler needs to pick one action:
 * `interrupted` for a turn a person stopped, `streamFailed` for one whose
 * provider stream broke and never recovered. One hook, one decision — a
 * second seam firing afterwards could only correct what the first already did.
 *
 * The hook runs after `TurnCompleted` is appended and delivered
 * (`agent-loop.turn-execution.ts:732`), so these tests poll with `waitFor`
 * rather than waiting on that event.
 */

interface HookTurnOutcome {
  readonly interrupted: boolean
  readonly streamFailed: boolean
}

const makeTurnWatch = (id: string) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<HookTurnOutcome>>([])
    const extension = defineExtension({
      id,
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.on("turnAfter", (input: TurnAfterInput) =>
          Ref.update(seen, (all) => [
            ...all,
            { interrupted: input.interrupted, streamFailed: input.streamFailed },
          ]),
        )
      }),
    })
    return { seen, extension }
  })

const answeringProvider = () =>
  LanguageModelLayers.testStream(() =>
    Effect.succeed(
      Stream.fromIterable([
        textDeltaPart("answered"),
        finishPart({ finishReason: "stop" }),
      ] satisfies LanguageModelStreamPart[]),
    ),
  )

/**
 * Writes something, then breaks, on every call. A break before any output is
 * retried by the driver; a break after partial output spends a continuation.
 * The turn reports the failure once both are exhausted.
 */
const brokenAfterPartialOutput = (calls: Ref.Ref<number>) =>
  LanguageModelLayers.testStream(() =>
    Effect.gen(function* () {
      const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
      return Stream.concat(
        Stream.fromIterable([textDeltaPart(`part ${call}`)] satisfies LanguageModelStreamPart[]),
        Stream.fail(
          AiError.make({
            module: "Test",
            method: "streamText",
            reason: new AiError.UnknownError({ description: "connection reset" }),
          }),
        ),
      )
    }),
  )

describe("turn lifecycle hooks", () => {
  it.scopedLive("a turn that answers reports neither interrupt nor failure", () =>
    Effect.gen(function* () {
      const watch = yield* makeTurnWatch("@gent/test-turn-after-answered")
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer: answeringProvider(),
        extensionInputs: [...e2ePreset.extensionInputs, watch.extension],
      })

      yield* client.message.send({ sessionId, branchId, content: "answer me" })
      const outcomes = yield* waitFor(
        Ref.get(watch.seen),
        (all) => all.length === 1,
        5_000,
        "turnAfter fired",
      )
      expect(outcomes).toEqual([{ interrupted: false, streamFailed: false }])
    }),
  )

  it.scopedLive("an interrupted turn reports the interrupt", () =>
    Effect.gen(function* () {
      const watch = yield* makeTurnWatch("@gent/test-turn-after-interrupted")
      // The signal provider holds the stream open between parts, so the turn is
      // still running when the interrupt arrives.
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.signal("one. two.")
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        extensionInputs: [...e2ePreset.extensionInputs, watch.extension],
      })

      yield* client.message.send({ sessionId, branchId, content: "answer me" })
      yield* controls.waitForStreamStart.pipe(Effect.timeout("5 seconds"))
      yield* client.steer.command({
        command: {
          _tag: "Interrupt",
          sessionId,
          branchId,
          requestId: "req-lifecycle-interrupt",
        } satisfies SteerCommand,
      })

      const outcomes = yield* waitFor(
        Ref.get(watch.seen),
        (all) => all.length === 1,
        5_000,
        "turnAfter fired",
      )
      expect(outcomes).toEqual([{ interrupted: true, streamFailed: false }])
    }),
  )

  it.scopedLive("a turn whose stream keeps breaking reports the failure once", () =>
    Effect.gen(function* () {
      const watch = yield* makeTurnWatch("@gent/test-turn-after-stream-failed")
      const calls = yield* Ref.make(0)
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer: brokenAfterPartialOutput(calls),
        extensionInputs: [...e2ePreset.extensionInputs, watch.extension],
      })

      yield* client.message.send({ sessionId, branchId, content: "answer me" })
      const outcomes = yield* waitFor(
        Ref.get(watch.seen),
        (all) => all.length === 1,
        10_000,
        "turnAfter fired",
      )

      expect(outcomes).toEqual([{ interrupted: false, streamFailed: true }])
      // Two continuations, then the third partial failure ends the turn.
      expect(yield* Ref.get(calls)).toBe(3)
    }),
  )
})

// ── agent-loop/recovery-race.test ───────────────────────────────────────────

/**
 * Regression: per-entity `handle` rebuild in `agent-loop.actor.ts` must
 * serialize against `concurrency: "unbounded"` mailbox dispatch.
 *
 * `ensureStarted` reads `lifecycleRef`, and `openLoop` yields on its first
 * I/O (`getQueueState`) before it can publish a new state there. Without
 * holding the startup permit across the full read/rebuild/check, a second op
 * arriving between those two steps reads a `lifecycleRef` the first op is
 * still rebuilding and proceeds against a loop that is not the one it will
 * be handed.
 *
 * To turn this into a deterministic regression: wrap `AgentLoopQueueStorage`
 * so the first `getQueueState` call (the one `openLoop` makes on reopen)
 * blocks on a `Deferred`. Op1 enters `ensureStarted` and blocks inside
 * `getQueueState`. Op2 fires concurrently. With the full-body permit, Op2
 * blocks waiting for Op1 to drop the permit — its completion `Deferred` is
 * unset until we release Op1's gate. With a narrow permit, Op2 races past
 * the lifecycle check and completes immediately, before we have released Op1.
 *
 * Assertion: Op2 has NOT completed at the moment Op1 is still inside the
 * gated `getQueueState`. After releasing the gate, Op1 + Op2 both complete.
 *
 * To deterministically drive the actor into `Closed` first, use
 * `TerminateBranch` (the production path that settles `lifecycleRef` on
 * `Closed`) followed by `clearTerminated` so subsequent ops are allowed
 * past `rejectIfTerminated`.
 */

const emptyPersistedQueue = (): LoopQueueStateType =>
  LoopQueueState.make({ steering: [], followUp: [] })

const gatedQueueStorageLayer = <E>(
  reopenGate: Ref.Ref<Option.Option<Deferred.Deferred<void>>>,
  reopenEntered: Ref.Ref<Option.Option<Deferred.Deferred<void>>>,
  inner: Layer.Layer<AgentLoopQueueStorage, E>,
): Layer.Layer<AgentLoopQueueStorage, E> => {
  const built = Layer.effect(
    AgentLoopQueueStorage,
    Effect.gen(function* () {
      const real = yield* AgentLoopQueueStorage
      return AgentLoopQueueStorage.of({
        getQueueState: (sessionId, branchId) =>
          Effect.gen(function* () {
            // Snapshot the gate BEFORE signaling entry. If we signaled
            // first and then re-read the gate, the test fiber could clear
            // `reopenGate` between the two reads, and Op1 would slip past
            // unblocked.
            const gate = yield* Ref.get(reopenGate)
            const enteredSignal = yield* Ref.get(reopenEntered)
            if (Option.isSome(enteredSignal)) yield* Deferred.succeed(enteredSignal.value, void 0)
            if (Option.isSome(gate)) yield* Deferred.await(gate.value)
            return yield* real.getQueueState(sessionId, branchId)
          }),
        putQueueState: real.putQueueState,
      })
    }),
  )
  return Layer.provide(built, inner)
}

describe("agent-loop recovery race", () => {
  it.live(
    "recovery start failure closes without re-entering startup semaphore",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("recovery-start-fail-session")
        const branchId = BranchId.make("recovery-start-fail-branch")
        const storedQueueRef = yield* Ref.make<LoopQueueStateType>(emptyPersistedQueue())

        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.succeed(
            Stream.fromIterable([
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[]),
          ),
        )
        const queueStorageLayer = Layer.succeed(
          AgentLoopQueueStorage,
          AgentLoopQueueStorage.of({
            getQueueState: () => Ref.get(storedQueueRef),
            // The loop reads its queue, then writes it back as the branch's
            // first row. That write is what fails here: the startup path
            // must close the loop and release its semaphore, not park.
            putQueueState: () =>
              new StorageError({
                message: "injected recovery start persistence failure",
                cause: "test",
              }),
          }),
        )

        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          queueStorageLayer,
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
            const sessionStorage = yield* SessionStorage
            const branchStorage = yield* BranchStorage
            const eventStorage = yield* EventStorage
            const actorClientFactory = yield* AgentLoopActor.Context
            const platform = yield* GentPlatform

            const now = dateFromMillis(1_767_225_600_000)
            yield* sessionStorage.createSession(
              new Session({
                id: sessionId,
                name: "Recovery Start Failure",
                createdAt: now,
                updatedAt: now,
              }),
            )
            yield* branchStorage.createBranch(
              new Branch({ id: branchId, sessionId, createdAt: now }),
            )
            const message = Message.cases.regular.make({
              id: MessageId.make("recovery-start-failure-message"),
              sessionId,
              branchId,
              role: "user",
              parts: [Prompt.textPart({ text: "recover and fail" })],
              createdAt: now,
            })
            yield* eventStorage.appendEvent(MessageReceived.make({ message }))

            const ref = yield* actorClientFactory(
              entityIdOf(DefaultWorkspaceId, sessionId, branchId),
            )
            const completed = yield* Effect.exit(
              ref.execute(
                AgentLoopActor.GetState.make({
                  workspaceId: DefaultWorkspaceId,
                  sessionId,
                  branchId,
                  commandId: ActorCommandId.make(yield* platform.randomId),
                }),
              ),
            ).pipe(Effect.timeoutOption("2 seconds"))

            expect(completed._tag).toBe("Some")
            if (completed._tag === "Some") {
              expect(Exit.isFailure(completed.value)).toBe(true)
            }
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
        )
      }),
    10000,
  )

  it.live(
    "second op blocks on startup semaphore until first op finishes reopen",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("recovery-race-session")
        const branchId = BranchId.make("recovery-race-branch")

        // Gate the next getQueueState (i.e., the next openLoop) so we can
        // pause Op1 mid-reopen. `reopenEntered` lets us await the moment
        // Op1 has actually entered `getQueueState` (so `closed=false` is
        // already published).
        const reopenGate = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none())
        const reopenEntered = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none())

        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.succeed(
            Stream.fromIterable([
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[]),
          ),
        )

        const baseStorage = SqliteStorage.TestWithSql(
          noBranchTools.storage,
          noBranchTools.migrations,
        )
        const wrappedQueueStorage = gatedQueueStorageLayer(
          reopenGate,
          reopenEntered,
          Layer.provide(AgentLoopQueueStorage.Live, baseStorage),
        )

        const deps = Layer.mergeAll(
          baseStorage,
          wrappedQueueStorage,
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
            const sessionStorage = yield* SessionStorage
            const branchStorage = yield* BranchStorage
            const governance = yield* AgentLoopSessionGovernance
            const actorClientFactory = yield* AgentLoopActor.Context
            const platform = yield* GentPlatform

            const now = dateFromMillis(1_767_225_600_000)
            yield* sessionStorage.createSession(
              new Session({
                id: sessionId,
                name: "Recovery Race",
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

            const ref = yield* actorClientFactory(
              entityIdOf(DefaultWorkspaceId, sessionId, branchId),
            )

            // Force-close the entity loop via TerminateBranch (the one
            // production path that flips `closed=true` via cleanupLoop),
            // then clear the session-terminated guard so follow-up ops
            // reach `ensureStarted` rather than getting rejected.
            yield* ref.execute(
              AgentLoopActor.TerminateBranch.make({
                workspaceId: DefaultWorkspaceId,
                sessionId,
                branchId,
                commandId: ActorCommandId.make(yield* platform.randomId),
              }),
            )
            yield* governance.clearTerminated(DefaultWorkspaceId, sessionId)

            // Install the reopen gate before the next ensureStarted.
            const gate = yield* Deferred.make<void>()
            const entered = yield* Deferred.make<void>()
            yield* Ref.set(reopenGate, Option.some(gate))
            yield* Ref.set(reopenEntered, Option.some(entered))

            // Op1 enters the actor mailbox, reaches `ensureStarted`,
            // sets `closed=false`, then BLOCKS inside getQueueState.
            const op1 = yield* ref
              .execute(
                AgentLoopActor.GetState.make({
                  workspaceId: DefaultWorkspaceId,
                  sessionId,
                  branchId,
                  commandId: ActorCommandId.make(yield* platform.randomId),
                }),
              )
              .pipe(Effect.forkChild)

            // Wait until Op1 is provably inside the gated getQueueState
            // (which means `closed=false` is already published — the
            // exact window where a narrow semaphore would let Op2 leak
            // past).
            yield* Deferred.await(entered)

            // Disarm the gate so Op2's own openLoop (if any) won't block.
            // Op2 should NOT need to reopen — under the wide semaphore it
            // blocks on the permit until Op1 finishes; under a narrow
            // semaphore it would race past the now-unset `closed=false`
            // and try to use the partially-rebuilt handle. Either way,
            // the gate must not capture Op2's storage calls.
            yield* Ref.set(reopenGate, Option.none())
            yield* Ref.set(reopenEntered, Option.none())

            // Op2 fires concurrently. Track its completion via a Deferred
            // so we can assert it has NOT completed while Op1 is gated.
            const op2Done = yield* Deferred.make<void>()
            const op2 = yield* ref
              .execute(
                AgentLoopActor.GetState.make({
                  workspaceId: DefaultWorkspaceId,
                  sessionId,
                  branchId,
                  commandId: ActorCommandId.make(yield* platform.randomId),
                }),
              )
              // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
              .pipe(Effect.andThen(Deferred.succeed(op2Done, undefined)), Effect.forkChild)

            // Sanity: Op2 should not have completed yet. With the wide
            // semaphore, Op2 is parked on `startupSemaphore.withPermits`.
            // With a narrow semaphore, Op2 would already have observed
            // `closed=false` and completed (visible as op2Done resolved
            // before we release the gate).
            //
            // We give the scheduler enough ticks to expose any racy
            // completion before checking — without sleeps we cannot
            // distinguish "still running" from "about to complete on the
            // next tick". `Effect.yieldNow` drains the microtask queue
            // without burning wallclock.
            yield* Effect.yieldNow.pipe(Effect.repeat(Schedule.recurs(20)))
            const op2DoneEarly = yield* Deferred.isDone(op2Done)
            expect(op2DoneEarly).toBe(false)

            // Release Op1's gate. Both ops should now drain.
            // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(op1)
            yield* Fiber.join(op2)
            yield* Deferred.await(op2Done)
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
        )
      }),
    10000,
  )
})

// ── agent-loop/turn-resume.test ─────────────────────────────────────────────

/**
 * Resume from the durable turn record.
 *
 * A turn's position is one row: the step whose messages committed, the
 * continuations it has spent, and the tool calls the current step has not
 * settled. These tests drive the loop through a real step boundary and
 * assert the row that boundary wrote, then restart the whole process over
 * the same database and assert the turn finishes without re-running a tool
 * whose result already committed.
 */

const TurnRecordRow = Schema.Struct({
  step: Schema.Finite,
  continuations: Schema.Finite,
  pending_tool_calls_json: Schema.String,
})

const decodePendingJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))),
)

/**
 * Read the turn row straight from the database file. The test asserts what a
 * restarting process would see, so it must not read through a live layer.
 */
const readTurnRecordRow = Effect.fn("test.readTurnRecordRow")(function* (params: {
  readonly dbPath: string
  readonly sessionId: string
  readonly branchId: string
  readonly messageId: string
}) {
  const raw = yield* Effect.sync(() => {
    const db = new Database(params.dbPath, { readonly: true })
    const rows = db
      .query(
        "SELECT step, continuations, pending_tool_calls_json FROM turn_records WHERE session_id = ? AND branch_id = ? AND message_id = ?",
      )
      .all(params.sessionId, params.branchId, params.messageId)
    db.close()
    return rows[0]
  })
  const row = yield* Schema.decodeUnknownEffect(TurnRecordRow)(raw)
  const pendingToolCalls = yield* decodePendingJson(row.pending_tool_calls_json)
  return { step: row.step, continuations: row.continuations, pendingToolCalls }
})

/**
 * What the probe tool did, across both processes; two layer graphs, one box.
 * `gate` holds one labelled call open so a step can be cut in half: the other
 * call's terminal event commits, the step's tool-result message does not.
 */
interface ProbeGate {
  readonly label: string
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

interface ProbeBox {
  runs: number
  byLabel: Map<string, number>
  gate: Option.Option<ProbeGate>
}

const probe: ProbeBox = { runs: 0, byLabel: new Map(), gate: Option.none() }

const resetProbe = () => {
  probe.runs = 0
  probe.byLabel = new Map()
  probe.gate = Option.none()
}

const probeRunsFor = (label: string) =>
  Option.getOrElse(Option.fromUndefinedOr(probe.byLabel.get(label)), () => 0)

const ResumeProbeExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("@test/turn-resume-probe") },
  scope: "builtin",
  sourcePath: "test",
  artifactIdentity: LoadedArtifactIdentity.make("@test/turn-resume-probe@artifact-1"),
  contributions: {
    tools: [
      tool({
        id: "resume_probe",
        description: "Record one execution and echo the label",
        params: Schema.Struct({ label: Schema.String }),
        output: Schema.Struct({ label: Schema.String, run: Schema.Finite }),
        execute: Effect.fn("resume_probe")(function* (params) {
          yield* ExtensionContext
          probe.runs += 1
          probe.byLabel.set(params.label, probeRunsFor(params.label) + 1)
          const gate = probe.gate
          if (Option.isSome(gate) && gate.value.label === params.label) {
            yield* Deferred.succeed(gate.value.entered, void 0)
            yield* Deferred.await(gate.value.release)
          }
          return { label: params.label, run: probe.runs }
        }),
      }),
    ],
  },
}

/** The user message id that opened the branch's only turn. */
const openingTurnMessageId = (messages: ReadonlyArray<{ readonly id: string }>) =>
  Option.fromUndefinedOr(messages.map((message) => message.id).find((id) => !id.includes(":")))

describe("turn record", () => {
  it.scopedLive(
    "records the completed step for a turn that answered after a tool call",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-record-")
        const dbPath = `${tempDir}/gent.db`
        const provider = yield* LanguageModelLayers.sequence([
          toolCallStep("resume_probe", { label: "one" }),
          textStep("DONE-AFTER-TOOL"),
        ])
        const { client } = yield* Gent.test(
          createE2ELayer({
            ...e2ePreset,
            providerLayer: provider.layer,
            extensions: [ResumeProbeExtension],
            storagePath: dbPath,
          }),
        )
        const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
        // The turn is done only when `TurnCompleted` lands: the reply text is
        // durable before the final step boundary writes the record.
        const completed = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(({ event }) => event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "run the probe" })
        yield* Fiber.join(completed)
        const messages = yield* client.message.list({ branchId })
        const messageId = openingTurnMessageId(messages)
        expect(Option.isSome(messageId)).toBe(true)

        const record = yield* readTurnRecordRow({
          dbPath,
          sessionId,
          branchId,
          messageId: Option.getOrElse(messageId, () => ""),
        })
        // Two steps ran: the tool call and the answer. Both closed.
        expect(record.step).toBe(2)
        expect(record.pendingToolCalls).toEqual([])
        expect(record.continuations).toBe(0)
        expect(probe.runs).toBe(1)
      }).pipe(Effect.timeout("20 seconds")),
    40_000,
  )

  it.scopedLive(
    "finishes an interrupted turn from the record without re-running a settled tool",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-resume-")
        const dbPath = `${tempDir}/gent.db`
        const finalReply = "RESUMED-REPLY"

        // First process: the tool call settles, then the model is asked
        // again. The scope closes while that second call is gated, so the
        // turn never finalizes.
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("resume_probe", { label: "first" }),
          { ...textStep("never emitted"), gated: true },
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: firstProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            yield* client.message
              .send({ sessionId, branchId, content: "run the resume probe" })
              .pipe(Effect.forkScoped)
            yield* firstProvider.controls.waitForCall(1)
            return { sessionId, branchId }
          }).pipe(Effect.timeout("10 seconds")),
        )
        expect(probe.runs).toBe(1)

        // Second process: the same database, a model that only answers. The
        // settled tool call must not run a second time.
        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: secondProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            yield* client.message.send({
              sessionId: started.sessionId,
              branchId: started.branchId,
              content: "continue",
            })
            yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (messages) =>
                messages.some((message) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.text.includes(finalReply),
                  ),
                ),
              15_000,
              "resumed turn produced its reply",
            )
          }).pipe(Effect.timeout("20 seconds")),
        )

        expect(probe.runs).toBe(1)
      }),
    60_000,
  )

  it.scopedLive(
    "replays the settled half of a cut step instead of running that tool again",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-partial-")
        const dbPath = `${tempDir}/gent.db`
        const finalReply = "PARTIAL-RESUMED"

        // One step, two calls. "slow" blocks, so the step's tool-result
        // message never commits; "fast" finishes and its terminal event does.
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        probe.gate = Option.some({ label: "slow", entered, release })

        const firstProvider = yield* LanguageModelLayers.sequence([
          multiToolCallStep(
            { toolName: "resume_probe", input: { label: "fast" } },
            { toolName: "resume_probe", input: { label: "slow" } },
          ),
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: firstProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            yield* client.message
              .send({ sessionId, branchId, content: "run both probes" })
              .pipe(Effect.forkScoped)
            yield* Deferred.await(entered)
            // "fast" settled; wait for its terminal event to be durable.
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              () => probeRunsFor("fast") >= 1,
              10_000,
              "the fast probe settled",
            )
            return { sessionId, branchId }
          }).pipe(Effect.timeout("15 seconds")),
        )

        // Release the blocked call and restart: the loop must replay "fast".
        probe.gate = Option.none()
        yield* Deferred.succeed(release, void 0)

        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: secondProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            yield* client.message.send({
              sessionId: started.sessionId,
              branchId: started.branchId,
              content: "continue",
            })
            yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (messages) =>
                messages.some((message) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.text.includes(finalReply),
                  ),
                ),
              15_000,
              "resumed turn produced its reply",
            )
          }).pipe(Effect.timeout("20 seconds")),
        )

        // "fast" settled durably in the first process; it must not run twice.
        expect(probeRunsFor("fast")).toBe(1)
      }),
    60_000,
  )

  it.scopedLive(
    "trusts the messages over a record left behind by a crash mid-step",
    () =>
      Effect.gen(function* () {
        resetProbe()
        const tempDir = yield* makeTempDirectoryScoped("gent-turn-stale-")
        const dbPath = `${tempDir}/gent.db`
        const finalReply = "STALE-RECORD-RESUMED"

        // First process: step 1 completes a tool call and closes. Step 2 issues
        // a second call whose messages commit before the gate holds it open.
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("resume_probe", { label: "first" }),
          toolCallStep("resume_probe", { label: "settled" }),
          { ...textStep("never emitted"), gated: true },
        ])
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: firstProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            yield* client.message
              .send({ sessionId, branchId, content: "run the probe" })
              .pipe(Effect.forkScoped)
            yield* firstProvider.controls.waitForCall(2)
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              () => probeRunsFor("settled") >= 1,
              10_000,
              "the second step's tool call settled",
            )
            return { sessionId, branchId }
          }).pipe(Effect.timeout("15 seconds")),
        )
        expect(probeRunsFor("settled")).toBe(1)

        // Stage the crash window. The record is written after the step's
        // messages, in its own transaction, so a crash in between leaves step
        // 2's assistant message durable while the row still names step 1 with
        // nothing pending. Rewind the row to exactly that state.
        yield* Effect.sync(() => {
          const db = new Database(dbPath)
          db.query(
            "UPDATE turn_records SET step = 1, pending_tool_calls_json = '[]' WHERE session_id = ? AND branch_id = ?",
          ).run(started.sessionId, started.branchId)
          db.close()
        })

        // Second process: the stale row says step 0 with nothing pending. If
        // the resolver believes it, the turn re-issues the step whose tool call
        // already ran, and the probe fires a second time.
        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* Gent.test(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: secondProvider.layer,
                extensions: [ResumeProbeExtension],
                storagePath: dbPath,
              }),
            )
            yield* client.message.send({
              sessionId: started.sessionId,
              branchId: started.branchId,
              content: "continue",
            })
            yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (messages) =>
                messages.some((message) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.text.includes(finalReply),
                  ),
                ),
              15_000,
              "resumed turn produced its reply",
            )
          }).pipe(Effect.timeout("20 seconds")),
        )

        expect(probeRunsFor("settled")).toBe(1)
      }),
    60_000,
  )
})

// ── agent-loop/actor-command.test ───────────────────────────────────────────

const makeTestExtensions = (
  tools: ReadonlyArray<ToolCapability> = [],
  requests: ReadonlyArray<RequestCapability> = [],
) => {
  const mainAgent = AgentDefinition.make({
    name: DEFAULT_AGENT_NAME,
    model: ModelId.make("test/default"),
  })
  return resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: [mainAgent],
        tools,
        requests,
      } satisfies ExtensionContributions,
    },
  ])
}

const makeClusterRunnerLayer = <A>(storageLayer: ReturnType<typeof SqliteStorage.TestWithSql<A>>) =>
  Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    Layer.merge(storageLayer, BunCrypto.layer),
  )

const makeRuntimeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability> = [],
  requests: ReadonlyArray<RequestCapability> = [],
) => {
  const resolvedExtensions = makeTestExtensions(tools, requests)
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations)
  let toolRunnerLayer = ToolRunner.Test()
  if (tools.length > 0) toolRunnerLayer = ToolRunner.Live
  const baseDeps = Layer.mergeAll(
    storageLayer,
    makeClusterRunnerLayer(storageLayer),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    ExtensionRegistry.fromResolved(resolvedExtensions),
    DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    }),
    eventStoreLayer,
    recorderLayer,
    toolRunnerLayer,
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    AgentLoopSessionGovernance.Live,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  const approvalLayer = ApprovalService.Live.pipe(
    Layer.provide(Layer.merge(baseDeps, eventPublisherLayer)),
  )
  return Layer.provideMerge(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.mergeAll(baseDeps, eventPublisherLayer, approvalLayer, ProcessLocalToolReplay.Live),
  )
}

const createSessionBranch = Effect.gen(function* () {
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const sessionId = SessionId.make("runtime-session")
  const branchId = BranchId.make("runtime-branch")
  const now = dateFromMillis(1_767_225_600_000)
  yield* sessionStorage.createSession(
    new Session({
      id: sessionId,
      name: "Runtime Test",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* branchStorage.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
  return { sessionId, branchId }
})

let getActorStateCounter = 0
const getActorState = (input: { sessionId: SessionId; branchId: BranchId }) =>
  Effect.gen(function* () {
    const actorClientFactory = yield* AgentLoopActor.Context
    const ref = yield* actorClientFactory(
      entityIdOf(DefaultWorkspaceId, input.sessionId, input.branchId),
    )
    return yield* ref.execute(
      AgentLoopActor.GetState.make({
        workspaceId: DefaultWorkspaceId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        commandId: ActorCommandId.make(`get-state-${++getActorStateCounter}`),
      }),
    )
  })

/**
 * `RequestExtension` is the live side-mutation operation: its handler takes the
 * same per-session permit and the same `drainWake` as every other mutation. The
 * concurrency tests below drive the actor through it, so they assert the
 * permit's behavior against a path production actually uses.
 */
const TEST_REQUEST_EXTENSION_ID = ExtensionId.make("agents")

const requestExtensionViaActor = (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
  readonly capabilityId: string
  readonly input: unknown
}) =>
  Effect.gen(function* () {
    const actorClientFactory = yield* AgentLoopActor.Context
    const ref = yield* actorClientFactory(
      entityIdOf(DefaultWorkspaceId, input.sessionId, input.branchId),
    )
    return yield* ref.execute(
      AgentLoopActor.RequestExtension.make({
        workspaceId: DefaultWorkspaceId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        commandId: input.commandId,
        extensionId: TEST_REQUEST_EXTENSION_ID,
        capabilityId: input.capabilityId,
        input: { _tag: "Present", value: input.input },
      }),
    )
  })

describe("agent-loop actor commands", () => {
  it.live("side-mutation commands are serialized per session", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const firstEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      let entered = 0
      let completed = 0
      const blockingRequest = request({
        id: "serialize-probe",
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) =>
          Effect.gen(function* () {
            entered++
            if (entered === 1) {
              // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
              yield* Deferred.succeed(firstEntered, undefined)
              yield* Deferred.await(releaseFirst)
            }
            completed++
            return value
          }),
      })
      const layer = makeRuntimeLayer(providerLayer, [], [blockingRequest])
      yield* narrowR(
        Effect.gen(function* () {
          const { sessionId, branchId } = yield* createSessionBranch
          const call = (commandId: string, value: string) =>
            requestExtensionViaActor({
              sessionId,
              branchId,
              commandId: ActorCommandId.make(commandId),
              capabilityId: "serialize-probe",
              input: value,
            })
          const firstFiber = yield* Effect.forkChild(call("serialize-a", "a"))
          yield* Deferred.await(firstEntered).pipe(Effect.timeout("5 seconds"))
          const secondFiber = yield* Effect.forkChild(call("serialize-b", "b"))
          // The permit is held by the first command, so the second cannot even
          // enter the capability body until the first releases it.
          const earlySecond = yield* Fiber.join(secondFiber).pipe(Effect.timeoutOption("1 millis"))
          expect(earlySecond._tag).toBe("None")
          expect(entered).toBe(1)
          expect(completed).toBe(0)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Fiber.join(firstFiber)
          yield* Fiber.join(secondFiber)
          expect(entered).toBe(2)
          expect(completed).toBe(2)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )

  it.live("a side mutation waits for the active turn mutation owner", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamStarted, undefined)
          yield* Deferred.await(streamReleased)
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      let executed = false
      const probeRequest = request({
        id: "owner-probe",
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) =>
          Effect.sync(() => {
            executed = true
            return value
          }),
      })
      const layer = makeRuntimeLayer(providerLayer, [], [probeRequest])
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createSessionBranch
          const submitFiber = yield* Effect.forkChild(
            sessionRuntime.sendUserMessage({
              sessionId,
              branchId,
              content: "hold the turn open",
            }),
          )
          yield* Deferred.await(streamStarted).pipe(Effect.timeout("5 seconds"))
          const requestFiber = yield* Effect.forkChild(
            requestExtensionViaActor({
              sessionId,
              branchId,
              commandId: ActorCommandId.make("request-active-owner"),
              capabilityId: "owner-probe",
              input: "blocked until turn completes",
            }),
          )
          // The running turn owns the mutation permit, so the side mutation
          // cannot start until the turn releases it.
          const earlyRequest = yield* Fiber.join(requestFiber).pipe(
            Effect.timeoutOption("1 millis"),
          )
          expect(earlyRequest._tag).toBe("None")
          expect(executed).toBe(false)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamReleased, undefined)
          yield* Fiber.join(submitFiber)
          const result = yield* Fiber.join(requestFiber)
          expect(executed).toBe(true)
          expect(result).toEqual("blocked until turn completes")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )

  it.live("a read-only request answers while the turn holds the mutation permit", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamStarted, undefined)
          yield* Deferred.await(streamReleased)
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const readProbe = request({
        id: "read-probe",
        readonly: true,
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) => Effect.succeed(`read ${value}`),
      })
      const layer = makeRuntimeLayer(providerLayer, [], [readProbe])
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createSessionBranch
          const submitFiber = yield* Effect.forkChild(
            sessionRuntime.sendUserMessage({
              sessionId,
              branchId,
              content: "hold the turn open",
            }),
          )
          yield* Deferred.await(streamStarted).pipe(Effect.timeout("5 seconds"))
          // The turn still owns the permit, and the read does not need it.
          const result = yield* requestExtensionViaActor({
            sessionId,
            branchId,
            commandId: ActorCommandId.make("request-read-during-turn"),
            capabilityId: "read-probe",
            input: "mid-turn",
          }).pipe(Effect.timeout("2 seconds"))
          expect(result).toEqual("read mid-turn")
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamReleased, undefined)
          yield* Fiber.join(submitFiber)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )

  it.live("TerminateBranch interrupts an active turn while a side mutation is waiting", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamStarted, undefined)
          yield* Deferred.await(streamReleased)
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const terminateProbe = request({
        id: "terminate-probe",
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) => Effect.succeed(value),
      })
      const layer = makeRuntimeLayer(providerLayer, [], [terminateProbe])
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createSessionBranch
          const submitFiber = yield* Effect.forkChild(
            sessionRuntime.sendUserMessage({
              sessionId,
              branchId,
              content: "hold the turn open",
            }),
          )
          yield* Deferred.await(streamStarted).pipe(Effect.timeout("5 seconds"))
          const recordFiber = yield* Effect.forkChild(
            requestExtensionViaActor({
              sessionId,
              branchId,
              commandId: ActorCommandId.make("request-terminate-owner"),
              capabilityId: "terminate-probe",
              input: "blocked until turn completes",
            }),
          )
          const earlyRecord = yield* Fiber.join(recordFiber).pipe(Effect.timeoutOption("1 millis"))
          expect(earlyRecord._tag).toBe("None")
          yield* sessionRuntime.terminateSession(sessionId).pipe(Effect.timeout("1 second"))
          yield* Fiber.join(submitFiber).pipe(Effect.ignore)
          yield* Fiber.join(recordFiber).pipe(Effect.ignore)
          const afterTerminate = yield* Effect.exit(getActorState({ sessionId, branchId }))
          expect(afterTerminate._tag).toBe("Failure")
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamReleased, undefined).pipe(Effect.ignore)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
})

// ── agent-loop/queue.test ───────────────────────────────────────────────────

describe("turn admission", () => {
  const item = (id: string) => ({
    message: Message.cases.regular.make({
      id: MessageId.make(id),
      sessionId: SessionId.make("admit-session"),
      branchId: BranchId.make("admit-branch"),
      role: "user",
      parts: [Prompt.textPart({ text: id })],
      createdAt: dateFromMillis(1_767_225_600_000),
    }),
  })

  test("an idle branch with nothing reserved may start a turn", () => {
    expect(canStartTurnNow(buildInitialAgentLoopState({ state: buildIdleState() }))).toBe(true)
  })

  test("a running branch may not start another turn", () => {
    const running = buildRunningState(item("running"), { startedAtMs: 0 })
    expect(canStartTurnNow(buildInitialAgentLoopState({ state: running }))).toBe(false)
  })

  // The reserving caller has taken the item out of the queue and has not yet
  // reached `startTurn`, so `state` is still Idle. A second caller that reads
  // only `state` would take a turn past the reservation, and the reserved item
  // would then be in neither the queue nor the transcript.
  test("an idle branch holding a reservation may not start a turn", () => {
    const reserved = buildRunningState(item("reserved"), { startedAtMs: 0 })
    const state = {
      ...buildInitialAgentLoopState({ state: buildIdleState() }),
      startingState: reserved,
    }
    expect(state.state._tag).toBe("Idle")
    expect(canStartTurnNow(state)).toBe(false)
  })
})

describe("wake admission", () => {
  const wakeSessionId = SessionId.make("wake-session")
  const wakeBranchId = BranchId.make("wake-branch")
  const queuedMessage = (id: string, text: string) =>
    Message.cases.regular.make({
      id: MessageId.make(id),
      sessionId: wakeSessionId,
      branchId: wakeBranchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })

  /**
   * Batching and keying are the inbox's, so they are exercised through
   * `admit`. The inbox runs over a memory queue row: the durable write is
   * covered by the drain and recovery suites below.
   */
  const withInbox = <A>(
    body: (inbox: {
      readonly admit: (item: QueuedTurnItem) => Effect.Effect<unknown, AgentLoopError>
      readonly queue: Effect.Effect<LoopQueueStateType>
    }) => Effect.Effect<A, AgentLoopError>,
  ) =>
    Effect.gen(function* () {
      const loopRef = yield* TxSubscriptionRef.make<AgentLoopState>(
        buildInitialAgentLoopState({
          state: buildRunningState({ message: queuedMessage("busy", "busy") }, { startedAtMs: 0 }),
        }),
      )
      const rows = yield* Ref.make(emptyLoopQueueState())
      const inbox = yield* makeLoopInbox({
        sessionId: wakeSessionId,
        branchId: wakeBranchId,
        loopRef,
        queuePersistenceSemaphore: yield* Semaphore.make(1),
        persistenceFailure: yield* Deferred.make<void, AgentLoopError>(),
        startedRef: yield* Ref.make(true),
      }).pipe(
        Effect.provideService(AgentLoopQueueStorage, {
          getQueueState: () => Ref.get(rows),
          putQueueState: (_s, _b, queue) => Ref.set(rows, queue),
        }),
      )
      return yield* body({
        admit: (item) => inbox.admit(item, { queueOnly: true }),
        queue: TxSubscriptionRef.get(loopRef).pipe(Effect.map((s) => s.queue)),
      })
    })

  it.effect("a batched follow-up keeps the wake request and the queue reports it", () =>
    withInbox((inbox) =>
      Effect.gen(function* () {
        yield* inbox.admit({ message: queuedMessage("wake-a", "first") })
        expect(wantsWakeOnRecovery(yield* inbox.queue)).toEqual(
          Option.some({ unconditional: false }),
        )
        yield* inbox.admit({ message: queuedMessage("wake-b", "second"), wake: true })
        const woken = yield* inbox.queue
        expect(woken.followUp).toHaveLength(1)
        expect(woken.followUp[0]?.wake).toBe(true)
        expect(wantsWakeOnRecovery(woken)).toEqual(Option.some({ unconditional: true }))
      }),
    ),
  )

  it.effect(
    "a source-keyed follow-up is never merged into its neighbour; re-admission replaces it",
    () =>
      withInbox((inbox) =>
        Effect.gen(function* () {
          yield* inbox.admit({ message: queuedMessage("user-a", "first") })
          yield* inbox.admit({
            message: queuedMessage("follow-up:w:s:b:child-1", "child done"),
            keyed: true,
          })
          expect((yield* inbox.queue).followUp.map((item) => String(item.message.id))).toEqual([
            "user-a",
            "follow-up:w:s:b:child-1",
          ])
          yield* inbox.admit({
            message: queuedMessage("follow-up:w:s:b:child-1", "child done (retry)"),
            keyed: true,
          })
          expect((yield* inbox.queue).followUp).toHaveLength(2)
        }),
      ),
  )

  test("a recovered queue with nothing in it never wakes", () => {
    expect(wantsWakeOnRecovery(emptyLoopQueueState())).toEqual(Option.none())
  })
})

describe("queue drain regression", () => {
  it.live(
    "multiple submits during a Running turn drain in submission order after TurnDone",
    () =>
      Effect.gen(function* () {
        const drainSessionId = SessionId.make("session-loop-drain")
        const drainBranchId = BranchId.make("branch-loop-drain")
        // Provider gates each turn on a per-turn Deferred so the test can
        // serialize "submit while Running" semantics deterministically.
        // First model stream call is gated by gates[0], second by gates[1], etc.
        // Each call records its index into `streamOrder` and returns a
        // simple text+stop response when its gate resolves.
        const gates = [
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
          yield* Deferred.make<void>(),
        ]
        const streamOrder = yield* Ref.make<readonly number[]>([])
        const streamCallRef = yield* Ref.make(0)
        const gatedProvider = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            const idx = yield* Ref.getAndUpdate(streamCallRef, (n) => n + 1)
            yield* Ref.update(streamOrder, (arr) => [...arr, idx])
            const gate = gates[idx]
            if (!Predicate.isUndefined(gate)) {
              yield* Deferred.await(gate)
            }
            return Stream.fromIterable([
              textDeltaPart(`turn-${idx}`),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          gatedProvider,
          ModelResolver.fromLanguageModel(gatedProvider),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
            // `interactive: true` disables follow-up batching in
            // `canBatchQueuedFollowUp` — without it, multiple plain-text
            // user submits collapse into a single combined turn before
            // they ever hit the queue drain.
            const submitOne = (id: string, text: string) =>
              submitAgentLoop(
                agentLoop,
                Message.cases.regular.make({
                  id: MessageId.make(id),
                  sessionId: drainSessionId,
                  branchId: drainBranchId,
                  role: "user",
                  parts: [Prompt.textPart({ text })],
                  createdAt: dateFromMillis(1_767_225_600_000),
                }),
                { interactive: true },
              )
            // Submit turn #0; wait until the provider's model stream has
            // actually been entered (parked on gate[0]). Phase transitions
            // to Running before model streaming starts, so we poll on
            // streamCallRef instead.
            yield* submitOne("msg-drain-0", "first")
            yield* waitForOption(
              () =>
                Effect.gen(function* () {
                  const count = yield* Ref.get(streamCallRef)
                  if (count >= 1) {
                    return Option.some(count)
                  }
                  return Option.none()
                }),
              "model stream call #0 to start",
              200,
            )
            expect(yield* Ref.get(streamCallRef)).toBe(1)
            // Submit #1, #2, #3 while #0 is still parked. They MUST
            // enqueue (Running → Running re-enter) — they cannot start
            // a new model stream until #0's gate releases.
            yield* submitOne("msg-drain-1", "second")
            yield* submitOne("msg-drain-2", "third")
            yield* submitOne("msg-drain-3", "fourth")
            // Confirm model streaming was not re-entered.
            expect(yield* Ref.get(streamCallRef)).toBe(1)
            // Release all gates. Drain proceeds: #0 → #1 → #2 → #3.
            yield* Deferred.succeed(gates[0]!, void 0)
            yield* Deferred.succeed(gates[1]!, void 0)
            yield* Deferred.succeed(gates[2]!, void 0)
            yield* Deferred.succeed(gates[3]!, void 0)
            // Wait for full drain: stream call count must reach 4 and
            // loop returns to Idle.
            yield* waitForPhase(
              agentLoop,
              { sessionId: drainSessionId, branchId: drainBranchId },
              "Idle",
            )
            const finalCount = yield* Ref.get(streamCallRef)
            expect(finalCount).toBe(4)
            const order = yield* Ref.get(streamOrder)
            expect(order).toEqual([0, 1, 2, 3])
            const queueStorage = yield* AgentLoopQueueStorage
            const queue = yield* queueStorage.getQueueState(drainSessionId, drainBranchId)
            expect(queue.inFlight).toBeUndefined()
            expect(queue.followUp).toEqual([])
            expect(queue.steering).toEqual([])
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "concurrent follow-up persistence keeps the full queue after actor restart",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-loop-persist-race")
        const branchId = BranchId.make("branch-loop-persist-race")
        const storedQueueRef = yield* Ref.make<LoopQueueStateType>(emptyPersistedQueue())
        const secondFollowUpStored = yield* Deferred.make<void>()
        const activeTurnReleased = yield* Deferred.make<void>()
        const queuedProvider = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            yield* Deferred.await(activeTurnReleased)
            return Stream.fromIterable([
              textDeltaPart("held"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const queueStorageLayer = Layer.succeed(
          AgentLoopQueueStorage,
          AgentLoopQueueStorage.of({
            getQueueState: () => Ref.get(storedQueueRef),
            putQueueState: (_sessionId, _branchId, queue) =>
              Effect.gen(function* () {
                const queuedFollowUps = queue.followUp.length
                if (queuedFollowUps === 1) {
                  yield* Deferred.await(secondFollowUpStored).pipe(
                    Effect.timeoutOption("10 millis"),
                  )
                }
                yield* Ref.set(storedQueueRef, queue)
                if (queuedFollowUps === 2) {
                  // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                  yield* Deferred.succeed(secondFollowUpStored, undefined).pipe(
                    Effect.catchEager(() => Effect.void),
                  )
                }
              }),
          }),
        )
        const makeLayer = () => {
          const deps = Layer.mergeAll(
            SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
            queueStorageLayer,
            queuedProvider,
            ModelResolver.fromLanguageModel(queuedProvider),
            makeExtRegistry(),
            RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
            ConfigService.Test(),
            EventStore.Memory,
            ToolRunner.Test(),
            ApprovalService.Test(),
            BunServices.layer,
            ModelRegistry.Test(),
            GentPlatform.Test(),
          )
          const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
          return AgentLoopTestActor({ baseSections: [] }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
            ),
          )
        }
        const makeMessage = (id: string, text: string) =>
          Message.cases.regular.make({
            id: MessageId.make(id),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text })],
            createdAt: dateFromMillis(1_767_225_600_000),
          })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* submitAgentLoop(agentLoop, makeMessage("msg-persist-race-0", "first"), {
              interactive: true,
            })
            const firstQueued = yield* Effect.forkChild(
              submitAgentLoop(agentLoop, makeMessage("msg-persist-race-1", "second"), {
                interactive: true,
              }),
            )
            const secondQueued = yield* Effect.forkChild(
              submitAgentLoop(agentLoop, makeMessage("msg-persist-race-2", "third"), {
                interactive: true,
              }),
            )
            yield* Fiber.join(firstQueued)
            yield* Fiber.join(secondQueued)
            expect((yield* agentLoop.getQueue({ sessionId, branchId })).followUp).toHaveLength(2)
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(makeLayer())),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const recovered = yield* agentLoop.getQueue({ sessionId, branchId })
            expect(recovered.followUp.map((item) => item.content)).toEqual(["second", "third"])
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(makeLayer())),
        )
        // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
        yield* Deferred.succeed(activeTurnReleased, undefined).pipe(
          Effect.catchEager(() => Effect.void),
        )
      }),
    15000,
  )

  it.live(
    "startup resumes an incomplete user turn even after the queue token was cleared",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-loop-incomplete-recovery")
        const branchId = BranchId.make("branch-loop-incomplete-recovery")
        const providerCalled = yield* Deferred.make<void>()
        const providerCalls = yield* Ref.make(0)
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            yield* Ref.update(providerCalls, (n) => n + 1)
            // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
            yield* Deferred.succeed(providerCalled, undefined).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("recovered"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
        const message = Message.cases.regular.make({
          id: MessageId.make("msg-incomplete-recovery"),
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "recover me" })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            yield* eventStorage.appendEvent(MessageReceived.make({ message }))

            const agentLoop = yield* makeAgentLoopService
            yield* agentLoop.getState({ sessionId, branchId })
            yield* Deferred.await(providerCalled).pipe(Effect.timeout("4 seconds"))
            expect(yield* Ref.get(providerCalls)).toBe(1)
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "startup does not replay a continuation prompt as a user turn",
    () =>
      Effect.gen(function* () {
        // A continuation prompt is persisted as a user message inside a turn
        // and never gets a TurnCompleted of its own. Seen in the gamut testbed:
        // startup took it for an unanswered turn and sent a transcript that
        // ended with the assistant reply, which the provider rejected.
        const sessionId = SessionId.make("session-loop-continuation-replay")
        const branchId = BranchId.make("branch-loop-continuation-replay")
        const providerCalled = yield* Deferred.make<void>()
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
            yield* Deferred.succeed(providerCalled, undefined).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("replayed"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
        const messageId = MessageId.make("msg-continuation-replay")
        const message = Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "answer me" })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
        const continuation = Message.cases.regular.make({
          id: MessageId.make(`${messageId}:continuation:2`),
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "Answer the request now." })],
          createdAt: dateFromMillis(1_767_225_600_001),
          metadata: { customType: "continuation", details: { step: 2 } },
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            yield* eventStorage.appendEvent(MessageReceived.make({ message }))
            yield* eventStorage.appendEvent(MessageReceived.make({ message: continuation }))
            yield* eventStorage.appendEvent(
              TurnCompleted.make({ sessionId, branchId, messageId, durationMs: 1 }),
            )

            const agentLoop = yield* makeAgentLoopService
            const state = yield* agentLoop.getState({ sessionId, branchId })
            expect(state._tag).toBe("Idle")
            const called = yield* Deferred.await(providerCalled).pipe(
              Effect.timeout("500 millis"),
              Effect.option,
            )
            expect(Option.isNone(called)).toBe(true)
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "startup does not answer a context handoff marker as a user turn",
    () =>
      Effect.gen(function* () {
        // A handoff marker is a user-role message the loop persists mid-turn.
        // Seen on the gamut at a 20k window: reopening a finished child took
        // the marker for an unanswered turn and the provider rejected the
        // transcript, which ended with the assistant reply.
        const sessionId = SessionId.make("session-loop-marker-replay")
        const branchId = BranchId.make("branch-loop-marker-replay")
        const providerCalled = yield* Deferred.make<void>()
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
            yield* Deferred.succeed(providerCalled, undefined).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("replayed"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
        const messageId = MessageId.make("msg-marker-replay")
        const message = Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "answer me" })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
        const reply = Message.cases.regular.make({
          id: MessageId.make("msg-marker-reply"),
          sessionId,
          branchId,
          role: "assistant",
          parts: [Prompt.textPart({ text: "answered" })],
          createdAt: dateFromMillis(1_767_225_600_001),
        })
        const marker = windowMarkerMessage({
          sessionId,
          branchId,
          keepFromMessageId: reply.id,
          notice: "Context handoff.",
          createdAt: dateFromMillis(1_767_225_600_002),
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            yield* eventStorage.appendEvent(MessageReceived.make({ message }))
            yield* eventStorage.appendEvent(MessageReceived.make({ message: reply }))
            yield* eventStorage.appendEvent(MessageReceived.make({ message: marker }))
            yield* eventStorage.appendEvent(
              TurnCompleted.make({ sessionId, branchId, messageId, durationMs: 1 }),
            )

            const agentLoop = yield* makeAgentLoopService
            const state = yield* agentLoop.getState({ sessionId, branchId })
            expect(state._tag).toBe("Idle")
            const called = yield* Deferred.await(providerCalled).pipe(
              Effect.timeout("500 millis"),
              Effect.option,
            )
            expect(Option.isNone(called)).toBe(true)
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "startup does not answer delivered steering as a user turn",
    () =>
      Effect.gen(function* () {
        // Steering delivered at a step boundary joins the turn already running
        // and never gets a `TurnCompleted` of its own. Without a runtime
        // marker, recovery reads that as an unanswered user turn and answers
        // it a second time after a restart.
        const sessionId = SessionId.make("session-loop-steering-replay")
        const branchId = BranchId.make("branch-loop-steering-replay")
        const providerCalled = yield* Deferred.make<void>()
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
            yield* Deferred.succeed(providerCalled, undefined).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("replayed"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
        const messageId = MessageId.make("msg-steering-replay")
        const message = Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "answer me" })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
        // The shape `deliverSteeringAtStepBoundary` writes: a user-role
        // interjection carrying the runtime marker, with no completion of
        // its own.
        const delivered = Message.cases.regular.make({
          id: MessageId.make("msg-steering-replay-interject"),
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "also do this" })],
          createdAt: dateFromMillis(1_767_225_600_001),
          metadata: { customType: "steering" },
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            yield* eventStorage.appendEvent(MessageReceived.make({ message }))
            yield* eventStorage.appendEvent(MessageReceived.make({ message: delivered }))
            yield* eventStorage.appendEvent(
              TurnCompleted.make({ sessionId, branchId, messageId, durationMs: 1 }),
            )

            const agentLoop = yield* makeAgentLoopService
            const state = yield* agentLoop.getState({ sessionId, branchId })
            expect(state._tag).toBe("Idle")
            const called = yield* Deferred.await(providerCalled).pipe(
              Effect.timeout("500 millis"),
              Effect.option,
            )
            expect(Option.isNone(called)).toBe(true)
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "steering reaches the transcript before the queue lets it go",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-steer-transcript-first")
        const branchId = BranchId.make("branch-steer-transcript-first")
        const storedQueueRef = yield* Ref.make<LoopQueueStateType>(emptyPersistedQueue())
        const echoTool = tool({
          id: "echo",
          description: "Echoes input",
          params: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: (params) => Effect.succeed({ text: params.text }),
        })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...toolCallStep("echo", { text: "step 1" }), gated: true },
          textStep("Done after steering."),
        ])
        // Read at the drop: the write that empties a non-empty steering queue
        // is the one that follows delivery. Recording whether the transcript
        // already holds the interjection at that instant says which of the two
        // writes went first, without failing either.
        const transcriptHeldAtDrop = yield* Ref.make(Option.none<boolean>())
        const storageLayer = SqliteStorage.TestWithSql(
          noBranchTools.storage,
          noBranchTools.migrations,
        )
        const queueStorageLayer = Layer.provide(
          Layer.effect(
            AgentLoopQueueStorage,
            Effect.gen(function* () {
              const messageStorage = yield* MessageStorage
              return AgentLoopQueueStorage.of({
                getQueueState: () => Ref.get(storedQueueRef),
                putQueueState: (_sessionId, _branchId, queue) =>
                  Effect.gen(function* () {
                    const previous = yield* Ref.get(storedQueueRef)
                    if (previous.steering.length > 0 && queue.steering.length === 0) {
                      const messages = yield* messageStorage
                        .listMessages(branchId)
                        .pipe(Effect.catchEager(() => Effect.succeed([])))
                      const held = messages.some((message) => message._tag === "interjection")
                      // First drop wins: a later step boundary must not
                      // overwrite what the one under test recorded.
                      yield* Ref.update(transcriptHeldAtDrop, (current) =>
                        Option.orElse(current, () => Option.some(held)),
                      )
                    }
                    yield* Ref.set(storedQueueRef, queue)
                  }),
              })
            }),
          ),
          storageLayer,
        )
        const deps = Layer.mergeAll(
          storageLayer,
          queueStorageLayer,
          providerLayer,
          ModelResolver.fromLanguageModel(providerLayer),
          makeExtRegistry([echoTool]),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
            const messageStorage = yield* MessageStorage
            const turn = Message.cases.regular.make({
              id: MessageId.make("msg-steer-transcript-first"),
              sessionId,
              branchId,
              role: "user",
              parts: [Prompt.textPart({ text: "run a tool" })],
              createdAt: dateFromMillis(1_767_225_600_000),
            })
            const fiber = yield* Effect.forkChild(
              submitAgentLoop(agentLoop, turn, { interactive: true }).pipe(Effect.ignore),
            )
            yield* controls.waitForCall(0)
            yield* steerAgentLoop({
              _tag: "Interject",
              sessionId,
              branchId,
              requestId: "req-steer-transcript-first",
              message: "answer this too",
            })
            yield* controls.emitAll(0)
            yield* Fiber.join(fiber).pipe(Effect.ignore)
            // The submit returns once the turn is admitted, not once it ends.
            // Reading the transcript before the loop parks would tear the layer
            // down mid-stream and interrupt the very delivery under test.
            yield* waitForPhase(agentLoop, { sessionId, branchId }, "Idle")
            const messages = yield* messageStorage.listMessages(branchId)
            expect(messages.filter((message) => message._tag === "interjection")).toHaveLength(1)
            // The drop happened, and the transcript already held the interjection
            // when it did. A crash in that window replays a delivery the message
            // id makes a no-op; the other order loses input the branch accepted.
            expect(yield* Ref.get(transcriptHeldAtDrop)).toStrictEqual(Option.some(true))
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "failed follow-up persistence does not expose the queued item",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("session-loop-persist-failure")
        const branchId = BranchId.make("branch-loop-persist-failure")
        const storedQueueRef = yield* Ref.make<LoopQueueStateType>(emptyPersistedQueue())
        const activeTurnReleased = yield* Deferred.make<void>()
        const heldProvider = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            yield* Deferred.await(activeTurnReleased)
            return Stream.fromIterable([
              textDeltaPart("held"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const queueStorageLayer = Layer.succeed(
          AgentLoopQueueStorage,
          AgentLoopQueueStorage.of({
            getQueueState: () => Ref.get(storedQueueRef),
            putQueueState: (_sessionId, _branchId, queue) => {
              if (queue.followUp.length > 0) {
                return Effect.fail(
                  new StorageError({
                    message: "queue persistence failed",
                    cause: "injected test failure",
                  }),
                )
              }
              return Ref.set(storedQueueRef, queue)
            },
          }),
        )
        const deps = Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          queueStorageLayer,
          heldProvider,
          ModelResolver.fromLanguageModel(heldProvider),
          makeExtRegistry(),
          RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
          ConfigService.Test(),
          EventStore.Memory,
          ToolRunner.Test(),
          ApprovalService.Test(),
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
        const makeMessage = (id: string, text: string) =>
          Message.cases.regular.make({
            id: MessageId.make(id),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text })],
            createdAt: dateFromMillis(1_767_225_600_000),
          })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            yield* submitAgentLoop(agentLoop, makeMessage("msg-persist-failure-0", "first"), {
              interactive: true,
            })

            const queuedExit = yield* Effect.exit(
              submitAgentLoop(agentLoop, makeMessage("msg-persist-failure-1", "second"), {
                interactive: true,
              }),
            )

            expect(queuedExit._tag).toBe("Failure")
            expect((yield* agentLoop.getQueue({ sessionId, branchId })).followUp).toEqual([])
            expect((yield* Ref.get(storedQueueRef)).followUp).toEqual([])
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer)),
        )
        // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
        yield* Deferred.succeed(activeTurnReleased, undefined).pipe(
          Effect.catchEager(() => Effect.void),
        )
      }),
    15000,
  )
})

// ── agent-loop/interactions.test ────────────────────────────────────────────

describe("interaction", () => {
  const intSessionId = SessionId.make("s-interaction")
  const intBranchId = BranchId.make("b-interaction")
  const makeIntMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make(`msg-${text}`),
      sessionId: intSessionId,
      branchId: intBranchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })
  const makeInteractionTool = (callCount: Ref.Ref<number>, resolution: Deferred.Deferred<void>) =>
    tool({
      id: "interaction-tool",
      description: "Tool that triggers an interaction",
      params: Schema.Struct({ value: Schema.String }),
      output: Schema.Struct({
        resolved: Schema.Boolean,
        value: Schema.String,
      }),
      execute: (params: { value: string }) =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          const count = yield* Ref.getAndUpdate(callCount, (n) => n + 1)
          if (count === 0) {
            return yield* new InteractionPendingError({
              requestId: InteractionRequestId.make("req-test-1"),
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
            })
          }
          yield* Deferred.succeed(resolution, void 0)
          return { resolved: true, value: params.value }
        }),
    })
  // Stateful provider: first model stream returns a tool call (triggers interaction),
  // subsequent model streams return text only (completes the turn).
  // Without this, the loop re-streams the same tool call 199 times until maxTurnSteps.
  const makeInteractionProviderLayer = () => {
    let streamCall = 0
    return LanguageModelLayers.testStream(() => {
      const call = streamCall++
      if (call === 0) {
        return Effect.succeed(
          Stream.fromIterable([
            toolCallPart(
              "interaction-tool",
              { value: "test" },
              {
                toolCallId: ToolCallId.make("tc-1"),
              },
            ),
            finishPart({ finishReason: "tool-calls" }),
          ] satisfies LanguageModelStreamPart[]),
        )
      }
      return Effect.succeed(
        Stream.fromIterable([
          textDeltaPart("done"),
          finishPart({ finishReason: "stop" }),
        ] satisfies LanguageModelStreamPart[]),
      )
    })
  }
  const makeInteractionRecordingLayer = (
    tools: ReadonlyArray<ToolCapability>,
    providerLayer?: Layer.Layer<LanguageModel.LanguageModel>,
  ) => {
    const resolvedProviderLayer = providerLayer ?? makeInteractionProviderLayer()
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const baseDeps = Layer.mergeAll(
      SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
      resolvedProviderLayer,
      ModelResolver.fromLanguageModel(resolvedProviderLayer),
      makeExtRegistry(tools),
      RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      ApprovalService.Test(),
      BunServices.layer,
      ModelRegistry.Test(),
      GentPlatform.Test(),
      recorderLayer,
      eventStoreLayer,
    )
    const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    return AgentLoopTestActor({ baseSections: [] }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
      ),
    )
  }
  it.live("tool triggers InteractionPendingError and machine parks", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeInteractionRecordingLayer([tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const recorder = yield* SequenceRecorder
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("trigger interaction")),
          )
          const state = yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          expect(state._tag).toBe("WaitingForInteraction")
          expect(yield* Ref.get(callCount)).toBe(1)
          const calls = yield* recorder.getCalls
          const eventTags = calls
            .filter((c) => c.service === "EventStore" && c.method === "append")
            .map((c) => Schema.decodeUnknownSync(AgentEvent)(c.args)._tag)
          expect(eventTags).toContain("ToolCallStarted")
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(yield* Ref.get(callCount)).toBe(2)
          yield* Fiber.join(fiber)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("stale interaction response does not resume a different pending request", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeInteractionRecordingLayer([tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("stale interaction")),
          )
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-stale-1"),
          })

          const state = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(state._tag).toBe("WaitingForInteraction")
          expect(yield* Ref.get(callCount)).toBe(1)
          expect(yield* Deferred.isDone(resolution)).toBe(false)

          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(yield* Ref.get(callCount)).toBe(2)
          yield* Fiber.join(fiber)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live(
    "a turn interrupted after a tool call arrived leaves a transcript the next turn reads",
    () =>
      Effect.gen(function* () {
        const executed = yield* Ref.make(0)
        const toolCallArrived = yield* Deferred.make<void>()
        const echo = tool({
          id: "interrupted-echo",
          description: "Counts executions",
          params: Schema.Struct({ value: Schema.String }),
          output: Schema.String,
          execute: (params: { value: string }) =>
            Ref.update(executed, (n) => n + 1).pipe(Effect.as(params.value)),
        })
        let calls = 0
        const provider = LanguageModelLayers.testStream(() => {
          calls += 1
          if (calls > 1) {
            return Effect.succeed(
              Stream.fromIterable([
                textDeltaPart("after interrupt"),
                finishPart({ finishReason: "stop" }),
              ]),
            )
          }
          // The tool call arrives whole, then the stream stalls before its finish
          // part: the interrupt lands with a call the step never got to run.
          return Effect.succeed(
            Stream.make(toolCallPart("interrupted-echo", { value: "never runs" })).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(toolCallArrived, void 0)).pipe(Stream.drain),
              ),
              Stream.concat(Stream.never),
            ),
          )
        })
        const layer = makeLiveToolLayer(provider, [echo])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const first = makeIntMessage("interrupt me mid tool call")
            const running = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
            yield* Deferred.await(toolCallArrived)
            yield* steerAgentLoop({
              _tag: "Interrupt",
              sessionId: intSessionId,
              branchId: intBranchId,
              requestId: "req-interrupt-mid-tool-call",
            })
            yield* Fiber.join(running)
            expect(yield* Ref.get(executed)).toBe(0)

            const second = makeIntMessage("are you still there")
            yield* runAgentLoop(agentLoop, second)
            const reply = yield* (yield* MessageStorage).getMessage(
              assistantMessageIdForTurn(second.id, 1),
            )
            expect(reply?.parts).toEqual([Prompt.textPart({ text: "after interrupt" })])
            const unrun = yield* (yield* MessageStorage).getMessage(
              toolResultMessageIdForTurn(first.id, 1),
            )
            expect(
              unrun?.parts.map((part) => part.type === "tool-result" && part.isFailure),
            ).toEqual([true])
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
        )
      }),
  )
  it.live("an interrupt stops a tool that is still running and gives its call a result", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const stuck = tool({
        id: "stuck-tool",
        description: "Never returns",
        params: Schema.Struct({}),
        output: Schema.String,
        execute: () =>
          Deferred.succeed(started, void 0).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(stopped, void 0)),
          ),
      })
      let calls = 0
      const provider = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls > 1) {
          return Effect.succeed(
            Stream.fromIterable([
              textDeltaPart("after stop"),
              finishPart({ finishReason: "stop" }),
            ]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            toolCallPart("stuck-tool", {}),
            finishPart({ finishReason: "tool-calls" }),
          ]),
        )
      })
      const layer = makeLiveToolLayer(provider, [stuck])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const first = makeIntMessage("run the stuck tool")
          const running = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(started)
          yield* steerAgentLoop({
            _tag: "Interrupt",
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: "req-interrupt-running-tool",
          })
          yield* Deferred.await(stopped)
          yield* Fiber.join(running)
          const result = yield* (yield* MessageStorage).getMessage(
            toolResultMessageIdForTurn(first.id, 1),
          )
          expect(result?.parts).toMatchObject([
            { type: "tool-result", isFailure: true, result: { reason: "Interrupted" } },
          ])
          expect(calls).toBe(1)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live(
    "a stream that fails after a tool call arrived leaves a transcript the re-prompt reads",
    () =>
      Effect.gen(function* () {
        const executed = yield* Ref.make(0)
        const echo = tool({
          id: "cut-echo",
          description: "Counts executions",
          params: Schema.Struct({ value: Schema.String }),
          output: Schema.String,
          execute: (params: { value: string }) =>
            Ref.update(executed, (n) => n + 1).pipe(Effect.as(params.value)),
        })
        let calls = 0
        const provider = LanguageModelLayers.testStream(() => {
          calls += 1
          if (calls > 1) {
            return Effect.succeed(
              Stream.fromIterable([
                textDeltaPart("after failure"),
                finishPart({ finishReason: "stop" }),
              ]),
            )
          }
          return Effect.succeed(
            Stream.make(toolCallPart("cut-echo", { value: "never runs" })).pipe(
              Stream.concat(
                Stream.fail(
                  AiError.make({
                    module: "Test",
                    method: "streamText",
                    reason: new AiError.UnknownError({ description: "connection reset" }),
                  }),
                ),
              ),
            ),
          )
        })
        const layer = makeLiveToolLayer(provider, [echo])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const first = makeIntMessage("the stream breaks mid tool call")
            // A stream that broke with output in hand is re-prompted inside the turn.
            yield* runAgentLoop(agentLoop, first)
            expect(yield* Ref.get(executed)).toBe(0)
            const reply = yield* (yield* MessageStorage).getMessage(
              assistantMessageIdForTurn(first.id, 2),
            )
            expect(reply?.parts).toEqual([Prompt.textPart({ text: "after failure" })])
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
        )
      }),
  )
  it.live("interrupt during WaitingForInteraction finalizes turn", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeLiveToolLayer(makeInteractionProviderLayer(), [tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("interrupt test")),
          )
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* steerAgentLoop({
            _tag: "Interrupt",
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: "req-interrupt-waiting-interaction",
          })
          yield* Fiber.join(fiber)
          const stateAfter = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(stateAfter._tag).toBe("Idle")
          expect(yield* Ref.get(callCount)).toBe(1)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("respondInteraction is no-op when not in WaitingForInteraction", () =>
    Effect.gen(function* () {
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(
          Stream.fromIterable([textDeltaPart("hello"), finishPart({ finishReason: "stop" })]),
        ),
      )
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        makeExtRegistry(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        EventStore.Memory,
        ToolRunner.Test(),
        ApprovalService.Test(),
        BunServices.layer,
        ModelRegistry.Test(),
        GentPlatform.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const loopLayer = AgentLoopTestActor({ baseSections: [] }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, makeIntMessage("no interaction"))
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("nonexistent"),
          })
          const state = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(state._tag).toBe("Idle")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(loopLayer)),
      )
    }),
  )
  it.live("GUARD: interaction resume executes tool without new LLM call", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const providerCallsRef = yield* Ref.make(0)
      let streamCallIndex = 0
      const separateCallProvider = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          yield* Ref.update(providerCallsRef, (n) => n + 1)
          const idx = streamCallIndex++
          if (idx === 0) {
            return Stream.fromIterable([
              toolCallPart(
                getToolId(tool),
                { value: "guard-test" },
                {
                  toolCallId: ToolCallId.make("tc-guard"),
                },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies LanguageModelStreamPart[])
          }
          return Stream.fromIterable([
            textDeltaPart("interaction resolved"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const layer = makeLiveToolLayer(separateCallProvider, [tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("guard interaction")),
          )
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          const messageStorage = yield* MessageStorage
          const bindingStorage = yield* ToolCallBindingStorage
          const assistant = yield* messageStorage.getMessage(
            assistantMessageIdForTurn(makeIntMessage("guard interaction").id),
          )
          expect(assistant).not.toBeUndefined()
          if (Predicate.isNotUndefined(assistant)) {
            const toolCall = assistant.parts.find((part) => part.type === "tool-call")
            expect(toolCall?.type).toBe("tool-call")
            if (toolCall?.type === "tool-call") {
              expect(
                yield* bindingStorage.get({
                  assistantMessageId: assistant.id,
                  toolCallId: ToolCallId.make(toolCall.id),
                  sessionId: intSessionId,
                  branchId: intBranchId,
                }),
              ).toBeUndefined()
            }
          }
          expect(Ref.getUnsafe(providerCallsRef)).toBe(1)
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(Ref.getUnsafe(callCount)).toBe(2)
          expect(
            yield* bindingStorage.get({
              assistantMessageId: assistantMessageIdForTurn(makeIntMessage("guard interaction").id),
              toolCallId: ToolCallId.make("tc-guard"),
              sessionId: intSessionId,
              branchId: intBranchId,
            }),
          ).toBeUndefined()
          yield* Fiber.join(fiber)
          expect(Ref.getUnsafe(providerCallsRef)).toBe(2)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("resumes the latest incomplete tool step after an earlier step completed", () =>
    Effect.gen(function* () {
      const firstTool = tool({
        id: "first-tool",
        description: "Completes the first step",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            yield* ExtensionContext
            return params.value
          }),
      })
      const interactionCalls = yield* Ref.make(0)
      const interactionStarted = yield* Deferred.make<void>()
      const interactionResumed = yield* Deferred.make<void>()
      const releaseInteraction = yield* Deferred.make<void>()
      const secondTool = tool({
        id: "second-tool",
        description: "Parks on the second step",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            const count = yield* Ref.getAndUpdate(interactionCalls, (n) => n + 1)
            if (count === 0) {
              yield* Deferred.succeed(interactionStarted, void 0)
              return yield* new InteractionPendingError({
                requestId: InteractionRequestId.make("req-multi-step"),
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
              })
            }
            yield* Deferred.succeed(interactionResumed, void 0)
            yield* Deferred.await(releaseInteraction)
            return params.value
          }),
      })
      const providerCalls = yield* Ref.make(0)
      let streamCallIndex = 0
      const provider = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          yield* Ref.update(providerCalls, (n) => n + 1)
          const index = streamCallIndex++
          if (index === 0) {
            return Stream.fromIterable([
              toolCallPart(
                "first-tool",
                { value: "step-1" },
                {
                  toolCallId: ToolCallId.make("tc-step-1"),
                },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies LanguageModelStreamPart[])
          }
          if (index === 1) {
            return Stream.fromIterable([
              toolCallPart(
                "second-tool",
                { value: "step-2" },
                {
                  toolCallId: ToolCallId.make("tc-step-2"),
                },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies LanguageModelStreamPart[])
          }
          return Stream.fromIterable([
            textDeltaPart("multi-step complete"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const layer = makeLiveToolLayer(provider, [firstTool, secondTool])
      const message = makeIntMessage("multi-step interaction")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* Deferred.await(interactionStarted)
          expect(Ref.getUnsafe(providerCalls)).toBe(2)

          const messageStorage = yield* MessageStorage
          expect(
            yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1)),
          ).not.toBeUndefined()
          expect(
            yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 2)),
          ).not.toBeUndefined()
          expect(
            yield* messageStorage.getMessage(toolResultMessageIdForTurn(message.id, 2)),
          ).toBeUndefined()

          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-multi-step"),
          })
          yield* Deferred.await(interactionResumed).pipe(Effect.timeout("5 seconds"))
          expect(Ref.getUnsafe(providerCalls)).toBe(2)
          yield* Deferred.succeed(releaseInteraction, void 0)
          yield* Fiber.join(fiber)
          expect(Ref.getUnsafe(providerCalls)).toBe(3)
        })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(layer))
          .pipe(Effect.timeout("2 seconds")),
      )
    }),
  )
  it.live("reuses a completed sibling tool after another sibling parks", () =>
    Effect.gen(function* () {
      const firstCalls = yield* Ref.make(0)
      const secondCalls = yield* Ref.make(0)
      const secondStarted = yield* Deferred.make<void>()
      const secondResumed = yield* Deferred.make<void>()
      const firstTool = tool({
        id: "sibling-first-tool",
        description: "Completes before the sibling parks",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            yield* ExtensionContext
            yield* Ref.update(firstCalls, (count) => count + 1)
            return { value: params.value }
          }),
      })
      const secondTool = tool({
        id: "sibling-second-tool",
        description: "Parks once before completing",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            const count = yield* Ref.getAndUpdate(secondCalls, (value) => value + 1)
            if (count === 0) {
              yield* Deferred.succeed(secondStarted, void 0)
              return yield* new InteractionPendingError({
                requestId: InteractionRequestId.make("req-sibling-tools"),
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
              })
            }
            yield* Deferred.succeed(secondResumed, void 0)
            return params.value
          }),
      })
      let streamCallIndex = 0
      const provider = LanguageModelLayers.testStream(() => {
        const index = streamCallIndex++
        if (index === 0) {
          return Effect.succeed(
            Stream.fromIterable([
              toolCallPart(
                getToolId(secondTool),
                { value: "second" },
                { toolCallId: ToolCallId.make("tc-sibling-second") },
              ),
              toolCallPart(
                getToolId(firstTool),
                { value: "first" },
                { toolCallId: ToolCallId.make("tc-sibling-first") },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies LanguageModelStreamPart[]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            textDeltaPart("siblings complete"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[]),
        )
      })
      const layer = makeLiveToolLayer(provider, [firstTool, secondTool])
      const message = makeIntMessage("sibling interaction")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* Deferred.await(secondStarted)
          expect(Ref.getUnsafe(firstCalls)).toBe(1)
          expect(Ref.getUnsafe(secondCalls)).toBe(1)

          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-sibling-tools"),
          })
          yield* Deferred.await(secondResumed).pipe(Effect.timeout("1 second"))
          yield* Fiber.join(fiber)

          expect(Ref.getUnsafe(firstCalls)).toBe(1)
          expect(Ref.getUnsafe(secondCalls)).toBe(2)
          const messageStorage = yield* MessageStorage
          const result = yield* messageStorage.getMessage(toolResultMessageIdForTurn(message.id, 1))
          expect(result).not.toBeUndefined()
          if (Predicate.isNotUndefined(result)) {
            expect(result.parts).toHaveLength(2)
            expect(result.parts.map((part) => part.type === "tool-result" && part.id)).toEqual([
              "tc-sibling-second",
              "tc-sibling-first",
            ])
            const firstResult = result.parts.find(
              (part) => part.type === "tool-result" && part.id === "tc-sibling-first",
            )
            expect(Predicate.isUndefined(firstResult)).toBe(false)
            if (Predicate.isNotUndefined(firstResult)) {
              expect(firstResult.type).toBe("tool-result")
              if (firstResult.type === "tool-result") {
                expect(firstResult.result).toEqual({ value: "first" })
              }
            }
          }
        })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(layer))
          .pipe(Effect.timeout("2 seconds")),
      )
    }),
  )
  it.live("reuses a completed sibling declared before the pending sibling", () =>
    Effect.gen(function* () {
      const firstCalls = yield* Ref.make(0)
      const secondCalls = yield* Ref.make(0)
      const secondStarted = yield* Deferred.make<void>()
      const secondResumed = yield* Deferred.make<void>()
      const firstTool = tool({
        id: "sibling-reverse-first",
        description: "Completes before the pending sibling",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            yield* ExtensionContext
            yield* Ref.update(firstCalls, (count) => count + 1)
            return { value: params.value }
          }),
      })
      const secondTool = tool({
        id: "sibling-reverse-second",
        description: "Parks after the completed sibling",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            const count = yield* Ref.getAndUpdate(secondCalls, (value) => value + 1)
            if (count === 0) {
              yield* Deferred.succeed(secondStarted, void 0)
              return yield* new InteractionPendingError({
                requestId: InteractionRequestId.make("req-sibling-reverse"),
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
              })
            }
            yield* Deferred.succeed(secondResumed, void 0)
            return params.value
          }),
      })
      let streamCallIndex = 0
      const provider = LanguageModelLayers.testStream(() => {
        const index = streamCallIndex++
        if (index === 0) {
          return Effect.succeed(
            Stream.fromIterable([
              toolCallPart(
                getToolId(firstTool),
                { value: "first-reverse" },
                { toolCallId: ToolCallId.make("tc-sibling-reverse-first") },
              ),
              toolCallPart(
                getToolId(secondTool),
                { value: "second-reverse" },
                { toolCallId: ToolCallId.make("tc-sibling-reverse-second") },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies LanguageModelStreamPart[]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            textDeltaPart("reverse siblings complete"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[]),
        )
      })
      const layer = makeLiveToolLayer(provider, [firstTool, secondTool])
      const message = makeIntMessage("reverse sibling interaction")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* Deferred.await(secondStarted)
          expect(Ref.getUnsafe(firstCalls)).toBe(1)
          expect(Ref.getUnsafe(secondCalls)).toBe(1)

          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-sibling-reverse"),
          })
          yield* Deferred.await(secondResumed).pipe(Effect.timeout("1 second"))
          yield* Fiber.join(fiber)

          expect(Ref.getUnsafe(firstCalls)).toBe(1)
          expect(Ref.getUnsafe(secondCalls)).toBe(2)
          const result = yield* MessageStorage.pipe(
            Effect.flatMap((storage) =>
              storage.getMessage(toolResultMessageIdForTurn(message.id, 1)),
            ),
          )
          expect(result).not.toBeUndefined()
          if (Predicate.isNotUndefined(result)) {
            const firstResult = result.parts.find(
              (part) => part.type === "tool-result" && part.id === "tc-sibling-reverse-first",
            )
            expect(firstResult?.type).toBe("tool-result")
            if (firstResult?.type === "tool-result") {
              expect(firstResult.result).toEqual({ value: "first-reverse" })
            }
          }
        })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(layer))
          .pipe(Effect.timeout("2 seconds")),
      )
    }),
  )
  it.live("does not rerun a tool when its persisted structured result is corrupt", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const corruptTool = tool({
        id: "corrupt-result-tool",
        description: "Parks before a corrupt persisted result is supplied",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: () =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            const count = yield* Ref.getAndUpdate(calls, (value) => value + 1)
            if (count === 0) {
              yield* Deferred.succeed(started, void 0)
              return yield* new InteractionPendingError({
                requestId: InteractionRequestId.make("req-corrupt-result"),
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
              })
            }
            return "must not run"
          }),
      })
      let providerCalls = 0
      const provider = LanguageModelLayers.testStream(() => {
        const call = providerCalls++
        if (call > 0) {
          return Effect.succeed(
            Stream.fromIterable([
              textDeltaPart("next turn works"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            toolCallPart(
              getToolId(corruptTool),
              { value: "corrupt" },
              { toolCallId: ToolCallId.make("tc-corrupt-result") },
            ),
            finishPart({ finishReason: "tool-calls" }),
          ] satisfies LanguageModelStreamPart[]),
        )
      })
      const layer = makeLiveToolLayer(provider, [corruptTool])
      const message = makeIntMessage("corrupt result interaction")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* Deferred.await(started)
          const assistant = yield* MessageStorage.pipe(
            Effect.flatMap((storage) =>
              storage.getMessage(assistantMessageIdForTurn(message.id, 1)),
            ),
          )
          expect(assistant).not.toBeUndefined()
          if (Predicate.isUndefined(assistant)) return
          const eventStorage = yield* EventStorage
          yield* eventStorage.appendEvent(MessageReceived.make({ message: assistant }))
          yield* eventStorage.appendEvent(
            ToolCallSucceeded.make({
              sessionId: intSessionId,
              branchId: intBranchId,
              toolCallId: ToolCallId.make("tc-corrupt-result"),
              toolName: getToolId(corruptTool),
              output: "display value is not authoritative",
              resultJson: "{invalid-json",
            }),
          )
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-corrupt-result"),
          })
          const outcome = yield* Fiber.await(fiber)
          expect(outcome._tag).toBe("Failure")
          if (Exit.isFailure(outcome)) {
            const failure = Cause.findErrorOption(outcome.cause)
            expect(Option.isSome(failure)).toBe(true)
            if (Option.isSome(failure)) {
              expect(Schema.is(AgentLoopError)(failure.value)).toBe(true)
              if (Schema.is(AgentLoopError)(failure.value)) {
                expect(Schema.is(ToolResultReplayError)(failure.value.cause)).toBe(true)
              }
            }
          }
          expect(Ref.getUnsafe(calls)).toBe(1)
          const result = yield* MessageStorage.pipe(
            Effect.flatMap((storage) =>
              storage.getMessage(toolResultMessageIdForTurn(message.id, 1)),
            ),
          )
          expect(result).not.toBeUndefined()
          if (Predicate.isNotUndefined(result)) {
            expect(result.parts).toHaveLength(1)
            const part = result.parts[0]
            expect(part?.type).toBe("tool-result")
            if (part?.type === "tool-result") {
              expect(part.id).toBe("tc-corrupt-result")
              expect(part.isFailure).toBe(true)
            }
          }
          yield* runAgentLoop(agentLoop, makeIntMessage("after corrupt result"))
          const nextAssistant = yield* MessageStorage.pipe(
            Effect.flatMap((storage) =>
              storage.getMessage(
                assistantMessageIdForTurn(makeIntMessage("after corrupt result").id, 1),
              ),
            ),
          )
          expect(nextAssistant).not.toBeUndefined()
          if (Predicate.isNotUndefined(nextAssistant)) {
            expect(nextAssistant.parts).toContainEqual(Prompt.textPart({ text: "next turn works" }))
          }
        })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(layer))
          .pipe(Effect.timeout("2 seconds")),
      )
    }),
  )
})
// ============================================================================
// Durable suspension + queue drain regression
// ============================================================================
//
// Verifies the queue-drain behavior justified by the phase-tagged runtime:
// while a turn is `Running`, multiple `submit` calls enqueue and drain in
// submission order after `TurnDone`.
//
// Cites: `make-impossible-states-unrepresentable` (phase-tag invariants),
//        `redesign-from-first-principles` (the current runtime carries the
//        same correctness load as the FSM did).

// ── agent-loop/streaming.test ───────────────────────────────────────────────

describe("run completion", () => {
  it.live("run returns after a fast turn completes before the caller awaits idle", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("fast reply")])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const sessionId = SessionId.make("fast-run-session")
        const branchId = BranchId.make("fast-run-branch")
        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "fast")).pipe(
          Effect.timeout("2 seconds"),
        )
        const state = yield* agentLoop.getState({ sessionId, branchId })
        expect(state._tag).toBe("Idle")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayer(providerLayer)))
    }),
  )
})
describe("streaming", () => {
  it.scopedLive(
    "targeted cancellation before admission prevents model execution",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("later work still runs"),
        ])
        const context = yield* Layer.build(makeLayer(providerLayer))
        yield* Effect.gen(function* () {
          const loop = yield* makeAgentLoopService
          const sessionId = SessionId.make("pre-admission-cancel-session")
          const branchId = BranchId.make("pre-admission-cancel-branch")
          const cancelled = makeMessage(sessionId, branchId, "cancel before start")
          yield* steerAgentLoop({
            _tag: "Cancel",
            sessionId,
            branchId,
            requestId: RequestId.make("cancel-before-admission"),
            messageId: cancelled.id,
          })
          yield* runAgentLoop(loop, cancelled)
          expect(yield* controls.callCount).toBe(0)
          expect(
            (yield* (yield* MessageStorage).getMessage(cancelled.id))?.turnDurationMs,
          ).toBeDefined()
          const later = makeMessage(sessionId, branchId, "later")
          yield* runAgentLoop(loop, later)
          expect(yield* controls.callCount).toBe(1)
          const reply = yield* (yield* MessageStorage).getMessage(
            assistantMessageIdForTurn(later.id, 1),
          )
          expect(reply?.parts).toEqual([Prompt.textPart({ text: "later work still runs" })])
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("4 seconds")),
    6000,
  )

  it.scopedLive(
    "late turn-targeted cancellation leaves the current stream running",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("first reply"),
          { ...textStep("second reply"), gated: true },
        ])
        const context = yield* Layer.build(makeLayer(providerLayer))
        yield* Effect.gen(function* () {
          const loop = yield* makeAgentLoopService
          const sessionId = SessionId.make("targeted-cancel-session")
          const branchId = BranchId.make("targeted-cancel-branch")
          const first = makeMessage(sessionId, branchId, "first")
          const second = makeMessage(sessionId, branchId, "second")
          yield* runAgentLoop(loop, first)
          const running = yield* runAgentLoop(loop, second).pipe(Effect.forkChild)
          yield* controls.waitForCall(1)
          // This helper awaits the actual actor handler, not only durable send admission.
          yield* steerAgentLoop({
            _tag: "Cancel",
            sessionId,
            branchId,
            requestId: RequestId.make("late-first-cancel"),
            messageId: first.id,
          })
          expect((yield* loop.getState({ sessionId, branchId }))._tag).toBe("Running")
          yield* controls.emitAll(1)
          yield* Fiber.join(running)
          const reply = yield* (yield* MessageStorage).getMessage(
            assistantMessageIdForTurn(second.id, 1),
          )
          expect(reply?.parts).toEqual([Prompt.textPart({ text: "second reply" })])
          expect(yield* controls.callCount).toBe(2)
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("4 seconds")),
    6000,
  )

  it.live("concurrent sessions run independently", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, void 0)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(
              Stream.flatMap(() =>
                Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
              ),
            ),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
        )
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageA = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "hello")
          const messageB = makeMessage(SessionId.make("s2"), BranchId.make("b2"), "world")
          const fiberA = yield* Effect.forkChild(runAgentLoop(agentLoop, messageA))
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(runAgentLoop(agentLoop, messageB))
          const finishedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedB._tag).toBe("Some")
          const statusA = fiberA.pollUnsafe()
          expect(statusA).toBeUndefined()
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiberA)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("same session/branch serializes loop creation", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, void 0)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(
              Stream.flatMap(() =>
                Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
              ),
            ),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
        )
      })
      const delayedEventStorage = Layer.effect(
        EventStorage,
        Effect.gen(function* () {
          const eventStorage = yield* EventStorage
          return EventStorage.of({
            ...eventStorage,
            getLatestEvent: (input) =>
              eventStorage.getLatestEvent(input).pipe(Effect.delay("5 millis")),
          })
        }),
      )
      const baseStorageLayer = SqliteStorage.TestWithSql(
        noBranchTools.storage,
        noBranchTools.migrations,
      )
      const slowStorage = Layer.provideMerge(delayedEventStorage, baseStorageLayer)
      const deps = Layer.mergeAll(
        slowStorage,
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        makeExtRegistry(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        EventStore.Memory,
        ToolRunner.Test(),
        ApprovalService.Test(),
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
          const fiberA = yield* Effect.forkChild(
            runAgentLoop(
              agentLoop,
              makeMessage(SessionId.make("s1"), BranchId.make("b1"), "first"),
            ),
          )
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(
            submitAgentLoop(
              agentLoop,
              makeMessage(SessionId.make("s1"), BranchId.make("b1"), "second"),
            ),
          )
          const queuedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(queuedB._tag).toBe("Some")
          expect(calls).toBe(1)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiberA)
          yield* waitForPhase(
            agentLoop,
            { sessionId: SessionId.make("s1"), branchId: BranchId.make("b1") },
            "Idle",
          )
          expect(calls).toBe(2)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("interrupt scoped to session/branch", () =>
    Effect.gen(function* () {
      const gateA = yield* Deferred.make<void>()
      const gateB = yield* Deferred.make<void>()
      const startedA = yield* Deferred.make<void>()
      const startedB = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        let gate = gateB
        let started = startedB
        if (calls === 1) {
          gate = gateA
          started = startedA
        }
        return Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
              yield* Deferred.succeed(started, void 0)
              yield* Deferred.await(gate)
              return finishPart({ finishReason: "stop" })
            }),
          ).pipe(
            Stream.flatMap(() =>
              Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
            ),
          ),
        )
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageA = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "alpha")
          const messageB = makeMessage(SessionId.make("s2"), BranchId.make("b2"), "beta")
          const fiberA = yield* Effect.forkChild(runAgentLoop(agentLoop, messageA))
          const fiberB = yield* Effect.forkChild(runAgentLoop(agentLoop, messageB))
          yield* Deferred.await(startedA)
          yield* Deferred.await(startedB)
          yield* steerAgentLoop({
            _tag: "Interrupt",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            requestId: "req-interrupt-s1",
          })
          const finishedA = yield* Fiber.join(fiberA).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedA._tag).toBe("Some")
          const statusB = fiberB.pollUnsafe()
          expect(statusB).toBeUndefined()
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gateA, void 0)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gateB, void 0)
          yield* Fiber.join(fiberB)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("batches queued messages into one follow-up", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, void 0)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(
              Stream.flatMap(() =>
                Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
              ),
            ),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
        )
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageStorage = yield* MessageStorage
          const first = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "first")
          const second = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "second")
          const third = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "third")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* submitAgentLoop(agentLoop, second)
          yield* submitAgentLoop(agentLoop, third)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiber)
          yield* waitForPhase(
            agentLoop,
            { sessionId: SessionId.make("s1"), branchId: BranchId.make("b1") },
            "Idle",
          )
          const messages = yield* messageStorage.listMessages(BranchId.make("b1"))
          const userTexts = messages
            .filter((message) => message.role === "user")
            .map((message) =>
              message.parts
                .filter((part): part is Prompt.TextPart => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            )
          expect(userTexts).toEqual(["first", "second\nthird"])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("publishes StreamStarted and TurnCompleted events", () =>
    Effect.gen(function* () {
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(
          Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
        ),
      )
      const layer = makeRecordingLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const recorder = yield* SequenceRecorder
          yield* runAgentLoop(
            agentLoop,
            makeMessage(SessionId.make("s1"), BranchId.make("b1"), "inspect me"),
          )
          const calls = yield* recorder.getCalls
          const publishedEvents = calls
            .filter((call) => call.service === "EventStore" && call.method === "append")
            .map((call) => Schema.decodeUnknownOption(AgentEvent)(call.args))
            .filter(Option.isSome)
            .map(({ value }) => value._tag)
          expect(publishedEvents).toContain("StreamStarted")
          expect(publishedEvents).toContain("TurnCompleted")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("rolls back assistant message when durable MessageReceived append fails", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("not committed"), finishPart({ finishReason: "stop" })],
      ])
      const failingPublisherLayer = Layer.succeed(
        EventPublisher,
        EventPublisher.of({
          append: (event: AgentEvent) => {
            if (event._tag === "MessageReceived" && event.message.role === "assistant") {
              return Effect.fail(new EventStoreError({ message: "append failed" }))
            }
            return Effect.gen(function* () {
              return EventEnvelope.make({
                id: EventId.make(0),
                event,
                createdAt: yield* Clock.currentTimeMillis,
              })
            })
          },
          deliver: () => Effect.void,
          publish: () => Effect.void,
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("atomic-assistant-session"),
          BranchId.make("atomic-assistant-branch"),
          "hello",
        )
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(exit._tag).toBe("Failure")
        expect(assistant).toBeUndefined()
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("rolls back turn duration when TurnCompleted append fails", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("committed before finalize"), finishPart({ finishReason: "stop" })],
      ])
      const failingPublisherLayer = Layer.succeed(
        EventPublisher,
        EventPublisher.of({
          append: (event: AgentEvent) => {
            if (event._tag === "TurnCompleted") {
              return Effect.fail(new EventStoreError({ message: "append failed" }))
            }
            return Effect.gen(function* () {
              return EventEnvelope.make({
                id: EventId.make(0),
                event,
                createdAt: yield* Clock.currentTimeMillis,
              })
            })
          },
          deliver: () => Effect.void,
          publish: () => Effect.void,
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("atomic-turn-session"),
          BranchId.make("atomic-turn-branch"),
          "hello",
        )
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const user = yield* messageStorage.getMessage(message.id)
        expect(exit._tag).toBe("Failure")
        expect(user?.turnDurationMs).toBeUndefined()
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("persists assistant image parts from provider response streams", () =>
    Effect.gen(function* () {
      const messageStorage = yield* MessageStorage
      const agentLoop = yield* makeAgentLoopService
      const message = makeMessage(
        SessionId.make("image-session"),
        BranchId.make("image-branch"),
        "show image",
      )
      yield* runAgentLoop(agentLoop, message)
      const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
      expect(assistant).toBeDefined()
      expect(assistant?.parts).toEqual([
        Prompt.filePart({
          data: "data:image/png;base64,aGk=",
          mediaType: "image/png",
        }),
      ])
    }).pipe(
      Effect.provide(
        makeLayer(
          scriptedProvider([
            [
              Response.makePart("file", {
                mediaType: "image/png",
                data: new Uint8Array([104, 105]),
              }),
              finishPart({ finishReason: "stop" }),
            ],
          ]),
        ),
      ),
    ),
  )
  it.live("interjection runs before queued follow-up with scoped agent override", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      const providerCalls: Array<{
        latestUserText: string
      }> = []
      let streamCount = 0
      const providerLayer = LanguageModelLayers.testStream((options) => {
        const latestUserText = [...Prompt.make(options.prompt).content]
          .reverse()
          .find((message) => message.role === "user")
          ?.content.filter((part): part is Prompt.TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        providerCalls.push({
          latestUserText: latestUserText ?? "",
        })
        streamCount += 1
        if (streamCount === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, void 0)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(
              Stream.flatMap(() =>
                Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
              ),
            ),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
        )
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const first = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "first")
          const queued = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "queued")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* submitAgentLoop(agentLoop, queued)
          yield* steerAgentLoop({
            _tag: "Interject",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            requestId: "req-interject-priority",
            message: "steer now",
            agent: helperAgent.name,
          })
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiber)
          yield* waitForPhase(
            agentLoop,
            { sessionId: SessionId.make("s1"), branchId: BranchId.make("b1") },
            "Idle",
          )
          expect(providerCalls.length).toBe(3)
          expect(providerCalls[0]!.latestUserText).toBe("first")
          expect(providerCalls[1]!.latestUserText).toBe("steer now")
          expect(providerCalls[2]!.latestUserText).toBe("queued")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("getQueue reads without draining", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      let calls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, void 0)
                yield* Deferred.await(gate)
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(
              Stream.flatMap(() =>
                Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
              ),
            ),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
        )
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const first = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "first")
          const queuedA = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "queued a")
          const queuedB = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "queued b")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* submitAgentLoop(agentLoop, queuedA)
          yield* submitAgentLoop(agentLoop, queuedB)
          yield* steerAgentLoop({
            _tag: "Interject",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            requestId: "req-interject-visible-queue",
            message: "steer now",
          })
          const snapshot = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshot.steering).toEqual([
            expect.objectContaining({ _tag: "Steering", content: "steer now" }),
          ])
          expect(snapshot.followUp).toEqual([
            expect.objectContaining({ _tag: "FollowUp", content: "queued a\nqueued b" }),
          ])
          const secondSnapshot = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(secondSnapshot).toEqual(snapshot)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiber)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("flushes queued follow-ups after provider failure", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      const providerCalls: string[] = []
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream((options) => {
        const latestUserText =
          Prompt.make(options.prompt)
            .content.slice()
            .reverse()
            .flatMap((message) => {
              if (Array.isArray(message.content)) {
                return message.content
              }
              return []
            })
            .find(Schema.is(Prompt.TextPart))?.text ?? ""
        providerCalls.push(latestUserText)
        streamCalls += 1
        if (streamCalls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return
              }),
            ).pipe(
              Stream.flatMap(() =>
                Stream.fail(
                  AiError.make({
                    module: "Test",
                    method: "streamText",
                    reason: new AiError.UnknownError({ description: "provider exploded" }),
                  }),
                ),
              ),
            ),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
        )
      })
      const layer = makeLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const first = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "first")
          const queued = makeMessage(
            SessionId.make("s1"),
            BranchId.make("b1"),
            "queued after failure",
          )
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* submitAgentLoop(agentLoop, queued)
          const snapshotWhileRunning = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshotWhileRunning.followUp).toEqual([
            expect.objectContaining({ _tag: "FollowUp", content: "queued after failure" }),
          ])
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber).pipe(Effect.exit)
          yield* waitForPhase(
            agentLoop,
            { sessionId: SessionId.make("s1"), branchId: BranchId.make("b1") },
            "Idle",
          )
          expect(providerCalls).toEqual(["first", "queued after failure"])
          const snapshotAfterFailure = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshotAfterFailure).toEqual(emptyQueueSnapshot())
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live(
    "persists a continuation instruction after partial output and finishes the same turn",
    () =>
      Effect.gen(function* () {
        const eventsRef = yield* Ref.make<AgentEvent[]>([])
        const latestUserTexts: string[] = []
        let streamCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          latestUserTexts.push(
            [...Prompt.make(options.prompt).content]
              .reverse()
              .find((message) => message.role === "user")
              ?.content.filter((part): part is Prompt.TextPart => part.type === "text")
              .map((part) => part.text)
              .join("\n") ?? "",
          )
          streamCalls += 1
          if (streamCalls === 1) {
            return Effect.succeed(
              Stream.concat(
                Stream.fromIterable([textDeltaPart("partial ")]),
                Stream.fail(
                  AiError.make({
                    module: "Test",
                    method: "streamText",
                    reason: new AiError.UnknownError({ description: "connection reset" }),
                  }),
                ),
              ),
            )
          }
          return Effect.succeed(
            Stream.fromIterable([textDeltaPart("rest"), finishPart({ finishReason: "stop" })]),
          )
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const messageStorage = yield* MessageStorage
            const message = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "write it")
            yield* runAgentLoop(agentLoop, message)
            expect(streamCalls).toBe(2)
            expect(latestUserTexts[1]).toContain("Continue from where you stopped")
            const messages = yield* messageStorage.listMessages(BranchId.make("b1"))
            expect(
              messages
                .filter((item) => item.role === "assistant")
                .map((item) => item.parts.find((part) => part.type === "text")?.text),
            ).toEqual(["partial ", "rest"])
            const continuation = messages.find(
              (item) => item.metadata?.customType === "continuation",
            )
            expect(continuation).toMatchObject({
              id: `${message.id}:continuation:1`,
              role: "user",
              metadata: { customType: "continuation", details: { step: 1 } },
            })
            const events = yield* Ref.get(eventsRef)
            const completed = events.filter((event) => event._tag === "TurnCompleted")
            expect(completed).toHaveLength(1)
            expect(completed[0]).not.toMatchObject({ streamFailed: true })
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef))),
        )
      }),
  )
  it.live("bounds continuation instructions per turn and then reports the stream failure", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        streamCalls += 1
        return Effect.succeed(
          Stream.concat(
            Stream.fromIterable([textDeltaPart(`part ${streamCalls}`)]),
            Stream.fail(
              AiError.make({
                module: "Test",
                method: "streamText",
                reason: new AiError.UnknownError({ description: "connection reset" }),
              }),
            ),
          ),
        )
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageStorage = yield* MessageStorage
          const message = makeMessage(SessionId.make("s1"), BranchId.make("b1"), "write it")
          yield* runAgentLoop(agentLoop, message)
          // Two continuations, then the third partial failure ends the turn.
          expect(streamCalls).toBe(3)
          const messages = yield* messageStorage.listMessages(BranchId.make("b1"))
          expect(
            messages.filter((item) => item.metadata?.customType === "continuation"),
          ).toHaveLength(2)
          const events = yield* Ref.get(eventsRef)
          expect(events.filter((event) => event._tag === "TurnCompleted")).toMatchObject([
            { streamFailed: true },
          ])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef))),
      )
    }),
  )
  it.live("retries retryable provider stream-consumption failures before output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          if (streamCalls === 1) {
            return Stream.fail(retryableStreamError())
          }
          return Stream.fromIterable([
            textDeltaPart("after retry"),
            finishPart({ finishReason: "stop" }),
          ])
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("stream-retry-session"),
          BranchId.make("stream-retry-branch"),
          "retry",
        )
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(2)
        expect(tags).toContain("ProviderRetrying")
        expect(tags).not.toContain("ErrorOccurred")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "after retry" })])
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }),
  )
  it.live(
    "retries retryable provider stream-consumption failures after metadata but before output",
    () =>
      Effect.gen(function* () {
        const eventsRef = yield* Ref.make<AgentEvent[]>([])
        let streamCalls = 0
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.sync(() => {
            streamCalls += 1
            if (streamCalls === 1) {
              return Stream.concat(
                Stream.fromIterable([
                  Response.makePart("response-metadata", {
                    id: "response-before-output",
                    modelId: "test",
                    // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
                    timestamp: undefined,
                    // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
                    request: undefined,
                  }),
                  Response.makePart("text-start", { id: "text-before-output" }),
                ]),
                Stream.fail(retryableStreamError()),
              )
            }
            return Stream.fromIterable([
              textDeltaPart("after metadata retry"),
              finishPart({ finishReason: "stop" }),
            ])
          }),
        )
        yield* Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageStorage = yield* MessageStorage
          const message = makeMessage(
            SessionId.make("stream-metadata-retry-session"),
            BranchId.make("stream-metadata-retry-branch"),
            "retry",
          )
          yield* runAgentLoop(agentLoop, message)
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((event) => event._tag)
          expect(streamCalls).toBe(2)
          expect(tags).toContain("ProviderRetrying")
          expect(tags).not.toContain("ErrorOccurred")
          const assistant = yield* messageStorage.getMessage(
            assistantMessageIdForTurn(message.id, 1),
          )
          expect(assistant?.parts).toEqual([Prompt.textPart({ text: "after metadata retry" })])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
      }),
  )
  it.live("emits stream failure events after pre-output retries are exhausted", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          return Stream.fail(retryableStreamError())
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("stream-retry-exhausted-session"),
          BranchId.make("stream-retry-exhausted-branch"),
          "retry",
        )
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(3)
        expect(tags.filter((tag) => tag === "ProviderRetrying")).toHaveLength(2)
        expect(events.filter((event) => event._tag === "StreamEnded")).toEqual([
          expect.objectContaining({ messageId: message.id, step: 1 }),
        ])
        const completion = events.find((event) => event._tag === "TurnCompleted")
        expect(completion).toEqual(
          expect.objectContaining({
            _tag: "TurnCompleted",
            messageId: message.id,
            streamFailed: true,
          }),
        )
        expect(tags).toContain("StreamEnded")
        expect(tags).toContain("ErrorOccurred")
        expect(tags).toContain("TurnCompleted")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeUndefined()
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }),
  )
  it.live(
    "does not blindly retry after partial output; a durable continuation follows instead",
    () =>
      Effect.gen(function* () {
        const eventsRef = yield* Ref.make<AgentEvent[]>([])
        let streamCalls = 0
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.sync(() => {
            streamCalls += 1
            if (streamCalls === 1) {
              return Stream.concat(
                Stream.fromIterable([textDeltaPart("partial answer")]),
                Stream.fail(retryableStreamError()),
              )
            }
            return Stream.fromIterable([
              textDeltaPart("duplicate answer"),
              finishPart({ finishReason: "stop" }),
            ])
          }),
        )
        yield* Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const messageStorage = yield* MessageStorage
          const message = makeMessage(
            SessionId.make("stream-no-retry-session"),
            BranchId.make("stream-no-retry-branch"),
            "retry",
          )
          yield* runAgentLoop(agentLoop, message)
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((event) => event._tag)
          // The second call is a continuation step with the partial output kept,
          // not a provider retry of the same prompt.
          expect(streamCalls).toBe(2)
          expect(tags).not.toContain("ProviderRetrying")
          expect(tags).toContain("ErrorOccurred")
          const assistant = yield* messageStorage.getMessage(
            assistantMessageIdForTurn(message.id, 1),
          )
          expect(assistant?.parts).toEqual([Prompt.textPart({ text: "partial answer" })])
          const continuation = yield* messageStorage.getMessage(
            MessageId.make(`${message.id}:continuation:1`),
          )
          expect(continuation?.metadata?.customType).toBe("continuation")
          const second = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 2))
          expect(second?.parts).toEqual([Prompt.textPart({ text: "duplicate answer" })])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
      }),
  )
  it.live("native response error parts fail the stream and preserve partial output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(
          Stream.fromIterable([
            textDeltaPart("partial answer"),
            // oxlint-disable-next-line effect/noNewError -- This stream fixture models a native provider error part.
            Response.makePart("error", { error: new Error("native response part failed") }),
            textDeltaPart("unreachable"),
          ]),
        ),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("native-error-session"),
          BranchId.make("native-error-branch"),
          "fail natively",
        )
        yield* runAgentLoop(agentLoop, message)
        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(tags).toContain("StreamStarted")
        expect(tags).toContain("StreamChunk")
        expect(tags).toContain("StreamEnded")
        expect(tags).toContain("ErrorOccurred")
        expect(tags).toContain("TurnCompleted")
        const error = events.find((event) => event._tag === "ErrorOccurred")
        expect(error).toEqual(expect.objectContaining({ error: "native response part failed" }))
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "partial answer" })])
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }),
  )
})
// ============================================================================

// ── agent-loop/tool-binding-replay.test ─────────────────────────────────────

class ReplayResource extends Context.Service<ReplayResource, { readonly value: string }>()(
  "@gent/core/tests/runtime/agent-loop.test/ReplayResource",
) {}

const replayCases = [
  {
    name: "same-process capability",
    durable: false,
    saved: false,
    local: true,
    changed: false,
    reason: "",
  },
  {
    name: "missing process binding",
    durable: false,
    saved: false,
    local: false,
    changed: false,
    reason: "MissingBinding",
  },
  {
    name: "matching durable identity",
    durable: true,
    saved: true,
    local: false,
    changed: false,
    reason: "",
  },
  {
    name: "absent durable row with local identity",
    durable: true,
    saved: false,
    local: true,
    changed: false,
    reason: "MissingBinding",
  },
  {
    name: "changed durable source",
    durable: true,
    saved: true,
    local: true,
    changed: true,
    reason: "SourceMismatch",
  },
]

const makeTool = (): ToolCapability =>
  tool({
    id: "@test/replay-tool",
    description: "Replay test tool",
    params: Schema.Struct({ value: Schema.String }),
    output: Schema.String,
    execute: (_params: { readonly value: string }) =>
      Effect.gen(function* () {
        yield* ExtensionContext
        return "ok"
      }),
  })

const makeExtension = (toolCapability: ToolCapability): LoadedExtension => ({
  manifest: { id: ExtensionId.make("@test/replay-extension") },
  scope: "builtin",
  sourcePath: "/test/replay-extension",
  artifactIdentity: LoadedArtifactIdentity.make("replay-artifact-1"),
  contributions: { tools: [toolCapability] },
})

const makeBinding = () =>
  ToolBindingIdentity.make({
    toolId: ToolId.make("@test/replay-tool"),
    extensionId: ExtensionId.make("@test/replay-extension"),
    source: ToolBindingSource.cases.Static.make({
      sourceRevision: ToolSourceRevision.make("source/legacy"),
    }),
    schemaRevision: ToolSchemaRevision.make("schema/legacy"),
  })

describe("tool binding replay", () => {
  it.scopedLive(
    "validates an inner operation binding without an assistant tool-call storage row",
    () =>
      Effect.gen(function* () {
        const capability = makeTool()
        const layer = Layer.mergeAll(
          ExtensionRegistry.fromResolved(resolveExtensions([makeExtension(capability)])),
          ToolRunner.Live,
          GentPlatform.Test(),
        )
        const context = yield* Layer.build(layer)
        yield* Effect.gen(function* () {
          const sessionId = SessionId.make("inner-operation-session")
          const current = yield* captureCurrentToolBinding("@test/replay-tool")
          if (Option.isNone(current) || Predicate.isUndefined(current.value.binding))
            return yield* Effect.die("Missing fixture binding")
          const binding = current.value.binding
          const address = {
            sessionId,
            assistantMessageId: MessageId.make("outer-cell-message"),
            toolCallId: ToolCallId.make("inner-operation-call"),
          }
          const resolved = yield* resolveStoredToolBinding({ ...address, binding })
          expect(resolved.capability).toBe(capability)
          const changed = yield* resolveStoredToolBinding({
            ...address,
            binding: ToolBindingIdentity.make({
              ...binding,
              source: ToolBindingSource.cases.Static.make({
                sourceRevision: ToolSourceRevision.make("changed-source"),
              }),
            }),
          }).pipe(Effect.flip)
          expect(changed.reason).toBe("SourceMismatch")
          expect(changed.toolCallId).toBe(address.toolCallId)
        }).pipe(Effect.provideContext(context))
      }),
  )

  for (const scenario of replayCases) {
    it.scopedLive(`resolves ${scenario.name} through real storage and tool capture`, () =>
      Effect.gen(function* () {
        const capability = makeTool()
        const declared = defineExtension({
          id: "@test/replay-extension",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("tool", capability)
            yield* host.register(
              "resource",
              defineResource({
                id: "test/replay-policy-resource",
                tag: ReplayResource,
                scope: "process",
                layer: Layer.succeed(ReplayResource, ReplayResource.of({ value: "live" })),
              }),
            )
          }),
        })
        let extension = declared
        if (scenario.durable) {
          extension = {
            ...declared,
            artifactIdentity: LoadedArtifactIdentity.make("replay-artifact-1"),
          }
        }
        const layer = Layer.merge(
          createE2ELayer({
            agents: [],
            extensionInputs: [extension],
            providerLayer: LanguageModelLayers.debug(),
          }),
          ProcessLocalToolReplay.Live,
        )
        yield* Effect.gen(function* () {
          const sessionId = SessionId.make("replay-policy-session")
          const branchId = BranchId.make("replay-policy-branch")
          const assistantMessageId = MessageId.make("replay-policy-assistant")
          const toolCallId = ToolCallId.make("replay-policy-call")
          const address = { sessionId, branchId, assistantMessageId, toolCallId }
          const toolCall = Prompt.toolCallPart({
            id: toolCallId,
            name: "@test/replay-tool",
            params: { value: "input" },
            providerExecuted: false,
          })
          yield* ensureStorageParents({ sessionId, branchId })
          const messages = yield* MessageStorage
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: assistantMessageId,
              sessionId,
              branchId,
              role: "assistant",
              parts: [toolCall],
              createdAt: dateFromMillis(0),
            }),
          )
          const cache = yield* SessionProfileCache
          const profile = yield* cache.resolve("/tmp")
          const current = yield* captureCurrentToolBinding(toolCall.name)
          if (Option.isNone(current)) return yield* Effect.die("Expected captured capability")
          const replay = yield* ProcessLocalToolReplay
          const key = processLocalReplayBindingKey(address)
          if (scenario.local) {
            yield* replay.setBinding(key, { entry: current.value })
          }
          if (scenario.saved) {
            const storage = yield* ToolCallBindingStorage
            let binding = current.value.binding
            if (Predicate.isUndefined(binding))
              return yield* Effect.die("Expected durable identity")
            if (scenario.changed)
              binding = ToolBindingIdentity.make({
                ...binding,
                source: ToolBindingSource.cases.Static.make({
                  sourceRevision: ToolSourceRevision.make("old-source"),
                }),
              })
            yield* storage.save({ ...address, binding })
          }
          const result = yield* resolveReplayToolBinding({
            ...address,
            toolCall,
            generationId: profile.generationId,
          }).pipe(Effect.exit)
          if (Exit.isSuccess(result)) {
            expect(scenario.reason).toBe("")
            expect(result.value.capability).toBe(capability)
            return
          }
          expect(Cause.squash(result.cause)).toMatchObject({
            _tag: "ToolBindingReplayError",
            reason: scenario.reason,
          })
          expect(Option.isNone(yield* replay.getBinding(key))).toBe(true)
        }).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- Each scenario owns a production test root with its authored extension.
          Effect.provide(layer),
        )
      }).pipe(Effect.timeout("5 seconds")),
    )
  }

  it.scopedLive("resumes a process-local binding only inside its live process", () =>
    Effect.gen(function* () {
      const capability = makeTool()
      const extension = defineExtension({
        id: "@test/replay-extension",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register("tool", capability)
        }),
      })
      const layer = Layer.merge(
        createE2ELayer({
          agents: [],
          extensionInputs: [extension],
          providerLayer: LanguageModelLayers.debug(),
        }),
        ProcessLocalToolReplay.Live,
      )
      yield* Effect.gen(function* () {
        const sessionId = SessionId.make("process-local-session")
        const address = {
          sessionId,
          assistantMessageId: MessageId.make("process-local-assistant"),
          toolCallId: ToolCallId.make("process-local-call"),
        }
        const cache = yield* SessionProfileCache
        const profile = yield* cache.resolve("/tmp")
        const generationId = profile.generationId
        const current = yield* captureCurrentToolBinding("@test/replay-tool")
        if (Option.isNone(current)) return yield* Effect.die("Expected captured capability")
        // A source-loaded extension has no build artifact, so no durable identity.
        expect(current.value.binding).toBeUndefined()
        expect(Option.isNone(yield* innerOperationBindingIdentity(current.value))).toBe(true)
        const identity = yield* innerOperationBindingIdentity(current.value, generationId)
        if (Option.isNone(identity)) return yield* Effect.die("Expected process-local identity")
        expect(identity.value.source).toEqual({
          _tag: "ProcessLocal",
          sourceRevision: ToolSourceRevision.make(`process:${generationId}`),
        })

        const live = yield* resolveStoredToolBinding({
          ...address,
          binding: identity.value,
          generationId,
        })
        expect(live.capability).toBe(capability)

        const retired = yield* resolveStoredToolBinding({
          ...address,
          binding: ToolBindingIdentity.make({
            ...identity.value,
            source: ToolBindingSource.cases.ProcessLocal.make({
              sourceRevision: ToolSourceRevision.make("process:retired-process"),
            }),
          }),
          generationId,
        }).pipe(Effect.flip)
        expect(retired).toMatchObject({ _tag: "ToolBindingReplayError", reason: "SourceMismatch" })

        const withoutProcess = yield* resolveStoredToolBinding({
          ...address,
          binding: identity.value,
        }).pipe(Effect.flip)
        expect(withoutProcess).toMatchObject({
          _tag: "ToolBindingReplayError",
          reason: "SourceMismatch",
        })
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- The scenario owns a production test root with its authored extension.
        Effect.provide(layer),
      )
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.live("does not backfill a binding on an existing assistant message", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-existing-session")
      const branchId = BranchId.make("binding-replay-existing-branch")
      const messageId = MessageId.make("binding-replay-existing-message")
      const toolCallId = ToolCallId.make("binding-replay-existing-call")
      yield* ensureStorageParents({ sessionId, branchId })
      const messages = yield* MessageStorage
      const bindingStorage = yield* ToolCallBindingStorage
      const storageTransaction = yield* makeStorageTransaction
      const toolCallPart = Prompt.toolCallPart({
        id: toolCallId,
        name: "@test/replay-tool",
        params: { value: "legacy" },
        providerExecuted: false,
      })
      const message = Message.cases.regular.make({
        id: messageId,
        sessionId,
        branchId,
        role: "assistant",
        parts: [toolCallPart],
        createdAt: dateFromMillis(1_767_225_600_000),
      })
      yield* messages.createMessage(message)
      const capability = makeTool()
      const entry = {
        extensionId: ExtensionId.make("@test/replay-extension"),
        capability,
        binding: makeBinding(),
      } satisfies ResolvedToolCapability

      yield* persistAssistantPartsWithBindings({
        sessionId,
        branchId,
        messageId,
        parts: [toolCallPart],
        toolBindings: new Map([["@test/replay-tool", entry]]),
        storageTransaction,
      })

      expect(
        yield* bindingStorage.get({
          sessionId,
          branchId,
          assistantMessageId: messageId,
          toolCallId,
        }),
      ).toBeUndefined()
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(() => Layer.empty, {}),
          EventPublisher.Test(),
        ),
      ),
    ),
  )
  it.live("replays the structured terminal result for the current assistant only", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-session")
      const branchId = BranchId.make("binding-replay-result-branch")
      const oldAssistantId = MessageId.make("binding-replay-result-old-assistant")
      const assistantId = MessageId.make("binding-replay-result-assistant")
      const toolCallId = ToolCallId.make("binding-replay-result-call")
      const toolCall = Prompt.toolCallPart({
        id: toolCallId,
        name: "@test/replay-tool",
        params: { value: "current" },
        providerExecuted: false,
      })
      yield* ensureStorageParents({ sessionId, branchId })
      const makeAssistant = (id: MessageId, value: string) =>
        Message.cases.regular.make({
          id,
          sessionId,
          branchId,
          role: "assistant",
          parts: [
            Prompt.toolCallPart({
              id: toolCallId,
              name: "@test/replay-tool",
              params: { value },
              providerExecuted: false,
            }),
          ],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(
        MessageReceived.make({ message: makeAssistant(oldAssistantId, "old") }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "old display",
          resultJson: encodeToolOutput({ value: "old" }),
        }),
      )
      yield* eventStorage.appendEvent(
        MessageReceived.make({ message: makeAssistant(assistantId, "current") }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "current display",
          resultJson: encodeToolOutput({ value: "current" }),
        }),
      )
      const results = yield* findPersistedToolResults({
        sessionId,
        branchId,
        assistantMessageId: assistantId,
        toolCalls: [toolCall],
      })
      expect(results.get(toolCallId)?.result).toEqual({ value: "current" })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(() => Layer.empty, {}),
          EventPublisher.Test(),
        ),
      ),
    ),
  )
  it.live("does not replay a terminal result without its assistant anchor", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-no-anchor-session")
      const branchId = BranchId.make("binding-replay-result-no-anchor-branch")
      const toolCallId = ToolCallId.make("binding-replay-result-no-anchor-call")
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "unanchored display",
          resultJson: encodeToolOutput({ value: "unanchored" }),
        }),
      )

      const results = yield* findPersistedToolResults({
        sessionId,
        branchId,
        assistantMessageId: MessageId.make("binding-replay-result-missing-assistant"),
        toolCalls: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "@test/replay-tool",
            params: { value: "missing" },
            providerExecuted: false,
          }),
        ],
      })
      expect(results.size).toBe(0)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(() => Layer.empty, {}),
          EventPublisher.Test(),
        ),
      ),
    ),
  )
  it.live("stops result replay at the next assistant message", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-window-session")
      const branchId = BranchId.make("binding-replay-result-window-branch")
      const assistantId = MessageId.make("binding-replay-result-window-assistant")
      const laterAssistantId = MessageId.make("binding-replay-result-window-later")
      const toolCallId = ToolCallId.make("binding-replay-result-window-call")
      const makeAssistant = (id: MessageId) =>
        Message.cases.regular.make({
          id,
          sessionId,
          branchId,
          role: "assistant",
          parts: [
            Prompt.toolCallPart({
              id: toolCallId,
              name: "@test/replay-tool",
              params: { value: id },
              providerExecuted: false,
            }),
          ],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(MessageReceived.make({ message: makeAssistant(assistantId) }))
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "current display",
          resultJson: encodeToolOutput({ value: "current" }),
        }),
      )
      yield* eventStorage.appendEvent(
        MessageReceived.make({ message: makeAssistant(laterAssistantId) }),
      )
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "later display",
          resultJson: encodeToolOutput({ value: "later" }),
        }),
      )

      const results = yield* findPersistedToolResults({
        sessionId,
        branchId,
        assistantMessageId: assistantId,
        toolCalls: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "@test/replay-tool",
            params: { value: "current" },
            providerExecuted: false,
          }),
        ],
      })
      expect(results.get(toolCallId)?.result).toEqual({ value: "current" })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(() => Layer.empty, {}),
          EventPublisher.Test(),
        ),
      ),
    ),
  )
  it.live("rejects a corrupt structured terminal result", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("binding-replay-result-corrupt-session")
      const branchId = BranchId.make("binding-replay-result-corrupt-branch")
      const assistantId = MessageId.make("binding-replay-result-corrupt-assistant")
      const toolCallId = ToolCallId.make("binding-replay-result-corrupt-call")
      const message = Message.cases.regular.make({
        id: assistantId,
        sessionId,
        branchId,
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: toolCallId,
            name: "@test/replay-tool",
            params: { value: "corrupt" },
            providerExecuted: false,
          }),
        ],
        createdAt: dateFromMillis(1_767_225_600_000),
      })
      yield* ensureStorageParents({ sessionId, branchId })
      const eventStorage = yield* EventStorage
      yield* eventStorage.appendEvent(MessageReceived.make({ message }))
      yield* eventStorage.appendEvent(
        ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName: "@test/replay-tool",
          output: "display must not become authoritative",
          resultJson: "{invalid-json",
        }),
      )

      const exit = yield* Effect.exit(
        findPersistedToolResults({
          sessionId,
          branchId,
          assistantMessageId: assistantId,
          toolCalls: [
            Prompt.toolCallPart({
              id: toolCallId,
              name: "@test/replay-tool",
              params: { value: "corrupt" },
              providerExecuted: false,
            }),
          ],
        }),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error) && Schema.is(ToolResultReplayError)(error.value)).toBe(true)
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(() => Layer.empty, {}),
          EventPublisher.Test(),
        ),
      ),
    ),
  )
  it.live("isolates process-local replay state between server scopes", () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Scope.make(),
        (firstScope) =>
          Effect.acquireUseRelease(
            Scope.make(),
            (secondScope) =>
              Effect.gen(function* () {
                const firstContext = yield* Layer.buildWithScope(
                  ProcessLocalToolReplay.Live,
                  firstScope,
                )
                const secondContext = yield* Layer.buildWithScope(
                  ProcessLocalToolReplay.Live,
                  secondScope,
                )
                const first = Context.get(firstContext, ProcessLocalToolReplay)
                const second = Context.get(secondContext, ProcessLocalToolReplay)
                const key = "same-session:same-branch:assistant:call"
                const result = Prompt.toolResultPart({
                  id: "call",
                  name: "@test/replay-tool",
                  result: { value: "first-root" },
                  isFailure: false,
                  providerExecuted: false,
                })

                yield* first.setResults(key, new Map([[result.id, result]]))
                expect((yield* first.getResults(key)).get(result.id)).toEqual(result)
                expect((yield* second.getResults(key)).size).toBe(0)
              }),
            (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
          ),
        (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
      ),
    ),
  )
  it.live("clears process-local replay state when its server scope closes", () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          Effect.gen(function* () {
            const context = yield* Layer.buildWithScope(ProcessLocalToolReplay.Live, scope)
            const replay = Context.get(context, ProcessLocalToolReplay)
            const key = "shutdown-session:shutdown-branch:tool-result"
            const result = Prompt.toolResultPart({
              id: "shutdown-call",
              name: "@test/replay-tool",
              result: "result",
              isFailure: false,
              providerExecuted: false,
            })
            yield* replay.setResults(key, new Map([[result.id, result]]))
            return replay
          }),
        (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
      ),
    ).pipe(
      Effect.flatMap((service) =>
        Effect.gen(function* () {
          const results = yield* service.getResults("shutdown-session:shutdown-branch:tool-result")
          expect(results.size).toBe(0)
        }),
      ),
    ),
  )
})

// ── agent-loop/external-turn.test ───────────────────────────────────────────

/**
 * External turn execution — integration tests.
 *
 * Covers: collectExternalTurn with mock TurnExecutor, full agent loop
 * dispatch for external execution, event publishing, and cancellation.
 */

const messagePartsToolResultParts = (
  parts: Message["parts"],
): ReadonlyArray<Prompt.ToolResultPart> =>
  parts.flatMap((part) => {
    if (part.type === "tool-result") return [part]
    return []
  })
// ── Helpers ──
const sessionIdExternalTurn = SessionId.make("test-session")
const branchIdExternalTurn = BranchId.make("test-branch")
const makeMessageExternalTurn = (text: string) =>
  Message.cases.regular.make({
    id: MessageId.make(`${sessionIdExternalTurn}-${branchIdExternalTurn}-msg`),
    sessionId: sessionIdExternalTurn,
    branchId: branchIdExternalTurn,
    role: "user",
    parts: [Prompt.textPart({ text })],
    createdAt: dateFromMillis(1_767_225_600_000),
  })
const makeMessageWithParts = (parts: Message["parts"]) =>
  Message.cases.regular.make({
    id: MessageId.make(`${sessionIdExternalTurn}-${branchIdExternalTurn}-multipart-msg`),
    sessionId: sessionIdExternalTurn,
    branchId: branchIdExternalTurn,
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
const makeAgentLoopServiceExternalTurn = Effect.gen(function* () {
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
        yield* ref.execute(AgentLoopActor.SubmitAndWait.make(payload))
      }),
  } satisfies AgentLoopService
})
const runAgentLoopExternalTurn = (
  _agentLoop: AgentLoopService,
  message: Message,
  options?: {
    readonly agentOverride?: AgentName
    readonly runSpec?: RunSpec
    readonly interactive?: boolean
  },
) =>
  ensureStorageParents({
    sessionId: message.sessionId,
    branchId: message.branchId,
  }).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const actorClientFactory = yield* AgentLoopActor.Context
        const ref = yield* actorClientFactory(
          entityIdOf(DefaultWorkspaceId, message.sessionId, message.branchId),
        )
        yield* ref.execute(
          AgentLoopActor.SubmitAndWait.make({
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
  ensureStorageParents({
    sessionId: input.sessionId,
    branchId: input.branchId,
  }).pipe(Effect.flatMap(() => agentLoop.runOnce(input)))
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
const makeExtRegistryExternalTurn = (
  executor: TurnExecutor,
  tools?: ReadonlyArray<ToolCapability>,
) => ExtensionRegistry.fromResolved(makeResolved(executor, tools))
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
      deliver: () => Effect.void,
      publish: (event: AgentEvent) => Ref.update(eventsRef, (events) => [...events, event]),
      subscribe: () => Stream.empty,
      removeSession: () => Effect.void,
    }),
  )
const makeLayerWithEventsExternalTurn = (
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
    SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    makeExtRegistryExternalTurn(executor, options?.tools),
    makeDriverRegistry(executor, options?.tools),
    makeCountingEventStore(eventsRef),
    toolRunnerLayer,
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ApprovalService.Test(),
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          yield* runAgentLoopExternalTurn(agentLoop, makeMessageExternalTurn("test"), {
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef, {
        tools: [pendingTool],
        liveToolRunner: true,
        liveApproval: true,
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          yield* ensureStorageParents({
            sessionId: sessionIdExternalTurn,
            branchId: branchIdExternalTurn,
          })
          const message = makeMessageExternalTurn("park externally")
          const fiber = yield* Effect.forkChild(
            runAgentLoopExternalTurn(agentLoop, message, {
              agentOverride: AgentName.make("test-external"),
            }),
          )
          const actorClientFactory = yield* AgentLoopActor.Context
          const ref = yield* actorClientFactory(
            entityIdOf(DefaultWorkspaceId, sessionIdExternalTurn, branchIdExternalTurn),
          )
          const state = yield* waitFor(
            ref.execute(
              AgentLoopActor.GetState.make({
                workspaceId: DefaultWorkspaceId,
                sessionId: sessionIdExternalTurn,
                branchId: branchIdExternalTurn,
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
              sessionId: sessionIdExternalTurn,
              branchId: branchIdExternalTurn,
              assistantMessageId: assistant.id,
              toolCallId: ToolCallId.make(persistedCall.id),
            }),
          ).toBeUndefined()
          const approval = yield* ApprovalService
          const pendingRequestId = yield* approval.pendingRequestId({
            sessionId: sessionIdExternalTurn,
            branchId: branchIdExternalTurn,
          })
          expect(pendingRequestId).not.toBeUndefined()
          if (Predicate.isUndefined(pendingRequestId)) return
          yield* approval.storeResolution(pendingRequestId, { approved: true })
          yield* ref.execute(
            AgentLoopActor.RespondInteraction.make({
              workspaceId: DefaultWorkspaceId,
              sessionId: sessionIdExternalTurn,
              branchId: branchIdExternalTurn,
              requestId: pendingRequestId,
            }),
          )
          yield* waitFor(
            ref.execute(
              AgentLoopActor.GetState.make({
                workspaceId: DefaultWorkspaceId,
                sessionId: sessionIdExternalTurn,
                branchId: branchIdExternalTurn,
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
          const history = yield* messages.listMessages(branchIdExternalTurn)
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
  it.live("an external turn that produces nothing is marked unanswered", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      // An ACP prompt that completes without ever sending an update produces
      // exactly this: `executor.ts:328` filters the empty update stream away
      // and concatenates the terminal finish part on its own.
      const executor = makeMockExecutor([finish()])
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const loop = yield* makeAgentLoopServiceExternalTurn
          yield* runAgentLoopExternalTurn(loop, makeMessageExternalTurn("say nothing"), {
            agentOverride: externalAgent.name,
          })
          const completed = (yield* Ref.get(eventsRef)).filter(
            (event) => event._tag === "TurnCompleted",
          )
          expect(completed).toHaveLength(1)
          // `classifyStep` returned `External` before it read `observable`, so
          // every flag stayed false and headless mode exited 0 on an empty
          // transcript.
          expect(completed.every((event) => event.unanswered === true)).toBe(true)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef, {
        tools: [boundedTool],
        liveToolRunner: true,
      }).pipe(Layer.provideMerge(TestClock.layer()))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(1_767_225_600_000)
          const loop = yield* makeAgentLoopServiceExternalTurn
          const message = makeMessageExternalTurn("bound external calls")
          yield* runAgentLoopExternalTurn(loop, message, {
            agentOverride: externalAgent.name,
          })
          const storage = yield* MessageStorage
          const history = yield* storage.listMessages(branchIdExternalTurn)
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef, {
        tools: [contextProbeTool],
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          yield* runAgentLoopExternalTurn(agentLoop, makeMessageExternalTurn("read a file"), {
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          yield* runAgentLoopExternalTurn(agentLoop, makeMessageExternalTurn("run something"), {
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          yield* runAgentLoopExternalTurn(agentLoop, makeMessageExternalTurn("test error"), {
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef)
      const message = makeMessageExternalTurn("external native error")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          const messages = yield* MessageStorage
          yield* runAgentLoopExternalTurn(agentLoop, message, {
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          yield* runAgentLoopExternalTurn(
            agentLoop,
            makeMessageExternalTurn("test no tool re-exec"),
            {
              agentOverride: AgentName.make("test-external"),
            },
          )
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
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
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
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          yield* runAgentLoopExternalTurn(agentLoop, makeMessageExternalTurn("model turn"))
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef, {
        tools: [contextProbeTool],
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          yield* runAgentLoopExternalTurn(agentLoop, makeMessageExternalTurn("context check"), {
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef)
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
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          yield* runAgentLoopExternalTurn(agentLoop, message, {
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
      const layer = makeLayerWithEventsExternalTurn(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
          yield* runAgentLoopExternalTurn(agentLoop, makeMessageExternalTurn("reason test"), {
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
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
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
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
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
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
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
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
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
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
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
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
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
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
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
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
          const agentLoop = yield* makeAgentLoopServiceExternalTurn
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

// ── agent-runner.test ───────────────────────────────────────────────────────

const bashStubTool = tool({
  id: "bash",
  description: "Stub bash tool for tests",
  params: Schema.Struct({ command: Schema.String }),
  output: Schema.Struct({ output: Schema.String }),
  execute: (params) => Effect.succeed({ output: params.command }),
})
const readStubTool = tool({
  id: "read",
  description: "Stub read tool for tests",
  params: Schema.Struct({ path: Schema.String }),
  output: Schema.Struct({ output: Schema.String }),
  execute: (params) => Effect.succeed({ output: params.path }),
})
const testRegistryLayer = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: AllBuiltinAgents,
        tools: [bashStubTool],
      },
    },
  ]),
)
const withEventPublisher = (baseEventStoreLayer: Layer.Layer<EventStore>) =>
  Layer.provide(
    EventPublisherLive,
    Layer.mergeAll(
      baseEventStoreLayer,
      testRegistryLayer,
      RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ),
  )
const makeLiveAgentRunnerLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  delivery: "silent" | "live" = "silent",
  wrapSessionRuntime: (live: SessionRuntimeService) => SessionRuntimeService = (live) => live,
) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: AllBuiltinAgents,
        tools: [bashStubTool, readStubTool],
      },
    },
  ])
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const storageLayer = SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations)
  const clusterRunnerLayer = Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    Layer.merge(storageLayer, BunCrypto.layer),
  )
  const eventStoreLayer = EventStoreLive.pipe(Layer.provide(storageLayer))
  const eventPublisherLayer = Layer.provide(
    EventPublisherLive,
    Layer.mergeAll(
      storageLayer,
      eventStoreLayer,
      registryLayer,
      RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ),
  )
  const baseDeps = Layer.mergeAll(
    storageLayer,
    clusterRunnerLayer,
    eventStoreLayer,
    eventPublisherLayer,
    registryLayer,
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    ToolRunner.Test(),
    ApprovalService.Test(),
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    BunPlatformLive,
    ConfigService.Test(),
    ModelRegistry.Test(),
    parentServices,
    AgentLoopSessionGovernance.Live,
  )
  const sessionRuntimeLayer = Layer.effect(
    SessionRuntime,
    Effect.map(SessionRuntime, wrapSessionRuntime),
  ).pipe(
    Layer.provide(
      Layer.provide(
        SessionRuntime.Live({ baseSections: [] }),
        Layer.merge(baseDeps, eventPublisherLayer),
      ),
    ),
  )
  const sessionMutationsLayer = Layer.provide(
    SessionMutationsLive,
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionRuntimeLayer),
  )
  const deps = Layer.mergeAll(baseDeps, sessionMutationsLayer, sessionRuntimeLayer)
  let deliverySource: typeof ChildCompletionDelivery.Live = ChildCompletionDelivery.Silent
  if (delivery === "live") deliverySource = ChildCompletionDelivery.Live
  const deliveryLayer = Layer.provide(deliverySource, deps)
  const runnerLayer = InProcessRunner.pipe(Layer.provide(Layer.merge(deps, deliveryLayer)))
  return Layer.mergeAll(deps, deliveryLayer, runnerLayer)
}
type ChildHandle = Parameters<AgentRunner["inspect"]>[0]
const waitForCompletion = <E, R>(
  runtime: {
    readonly inspect: (
      handle: ChildHandle,
    ) => Effect.Effect<Effect.Success<ReturnType<AgentRunner["inspect"]>>, E, R>
  },
  handle: ChildHandle,
  timeoutMs = 2000,
) =>
  waitFor(
    runtime.inspect(handle),
    (observed) => Option.isSome(observed.completion),
    timeoutMs,
    "child completion",
  )
/** A branch-tool feature whose per-branch layer provides one recognizable service. */
const probeBranchTools: BranchToolFeature<never> = {
  migrations: {},
  storage: () => Layer.empty,
  branchLayer: () =>
    eraseResourceLayer(Layer.succeed(BranchToolWork, BranchToolWork.of({ cancel: Effect.void }))),
}

const runnerDeps = Layer.mergeAll(
  Layer.succeed(CurrentBranchToolFeature, probeBranchTools),
  BunPlatformLive,
  RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  ConfigService.Test(),
  ModelRegistry.Test(),
)
const parentServices = Layer.mergeAll(
  Layer.succeed(CurrentBranchToolFeature, probeBranchTools),
  RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
  ConfigService.Test(),
  ModelRegistry.Test(),
)
const sessionRuntimeStub = (
  onSubmit: SessionRuntimeService["sendUserMessage"] = () => Effect.void,
) =>
  Layer.effect(
    SessionRuntime,
    Effect.gen(function* () {
      const runtimeState = yield* SubscriptionRef.make<SessionRuntimeState>(
        SessionRuntimeStateSchema.cases.Idle.make({
          agent: DEFAULT_AGENT_NAME,
          queue: emptyQueueSnapshot(),
        }),
      )
      return {
        sendUserMessage: (input) =>
          Effect.gen(function* () {
            const agent = Option.getOrElse(
              Option.fromUndefinedOr(input.agentOverride),
              () => DEFAULT_AGENT_NAME,
            )
            yield* SubscriptionRef.set(
              runtimeState,
              SessionRuntimeStateSchema.cases.Running.make({
                agent,
                queue: emptyQueueSnapshot(),
              }),
            )
            yield* onSubmit(input).pipe(
              Effect.ensuring(
                SubscriptionRef.set(
                  runtimeState,
                  SessionRuntimeStateSchema.cases.Idle.make({ agent, queue: emptyQueueSnapshot() }),
                ),
              ),
            )
          }),
        steer: () => Effect.void,
        respondInteraction: () => Effect.void,
        queueFollowUp: () => Effect.void,
        dequeueFollowUp: () => Effect.succeed(false),
        requestExtension: () => Effect.void,
        drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
        getState: () => SubscriptionRef.get(runtimeState),
        watchState: () => Effect.succeed(SubscriptionRef.changes(runtimeState)),
        terminateSession: () => Effect.void,
      } satisfies SessionRuntimeService
    }),
  )
describe("helper run spec propagation", () => {
  it.scopedLive(
    "a private child with inherited history sees the parent branch messages and leaves no session behind",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep("pelican"),
            assertOptions: (options) => {
              const texts = [...Prompt.make(options.prompt).content].flatMap((message) => {
                if (message.role === "system") return []
                return message.content
                  .filter((part): part is Prompt.TextPart => part.type === "text")
                  .map((part) => part.text)
              })
              expect(texts.some((text) => text.includes("The codeword is pelican"))).toBe(true)
              expect(texts.some((text) => text.includes("Noted."))).toBe(true)
              // Hidden rows are outside the parent's own model view, so the child skips them too.
              expect(texts.some((text) => text.includes("hidden bookkeeping"))).toBe(false)
              expect(texts[texts.length - 1]).toContain("What is the codeword?")
            },
          },
        ])
        const layer = makeLiveAgentRunnerLayer(providerLayer)
        yield* Effect.gen(function* () {
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const messages = yield* MessageStorage
          const runner = yield* AgentRunnerService
          const now = dateFromMillis(1_767_225_600_000)
          const sessionId = SessionId.make("parent-history")
          const branchId = BranchId.make("parent-history-branch")
          yield* sessions.createSession(
            new Session({ id: sessionId, name: "Parent", createdAt: now, updatedAt: now }),
          )
          yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make("parent-history:user:1"),
              sessionId,
              branchId,
              role: "user",
              parts: [Prompt.textPart({ text: "The codeword is pelican" })],
              createdAt: now,
            }),
          )
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make("parent-history:assistant:1"),
              sessionId,
              branchId,
              role: "assistant",
              parts: [Prompt.textPart({ text: "Noted." })],
              createdAt: dateFromMillis(1_767_225_601_000),
            }),
          )
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make("parent-history:hidden:1"),
              sessionId,
              branchId,
              role: "user",
              parts: [Prompt.textPart({ text: "hidden bookkeeping" })],
              createdAt: dateFromMillis(1_767_225_602_000),
              metadata: { hidden: true },
            }),
          )
          const observed = yield* Ref.make<ReadonlyArray<string>>([])
          const result = yield* runner.run({
            agent: builtinAgent,
            prompt: "What is the codeword?",
            parentSessionId: sessionId,
            parentBranchId: branchId,
            cwd: process.cwd(),
            runSpec: makeRunSpec({ history: "inherit", visibility: "private" }),
            observe: (event) => {
              if (event._tag !== "StreamChunk") return Effect.void
              return Ref.update(observed, (chunks) => [...chunks, event.chunk])
            },
          })
          expect(result._tag).toBe("Success")
          if (result._tag === "Success") expect(result.text).toContain("pelican")
          // The observer saw the child's stream as it happened.
          expect((yield* Ref.get(observed)).join("")).toContain("pelican")
          // The parent branch keeps its three messages; the child never writes there.
          expect((yield* messages.listMessages(branchId)).length).toBe(3)
          // A private run deletes its own session once the answer is read.
          expect((yield* sessions.listSessions).map((session) => session.id)).toEqual([sessionId])
          yield* controls.assertDone
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      }).pipe(Effect.provide(BunServices.layer)),
  )
  it.scopedLive("durable helper-agent runSpec reaches the provider through AgentRunner", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("child result"),
          assertRequest: (request) => {
            expect(request.model).toBe("custom/model")
            expect(request.reasoning).toBe("high")
          },
          assertOptions: (options) => {
            expect(options.tools.map((tool) => tool.name)).toEqual(["bash"])
          },
        },
      ])
      const layer = makeLiveAgentRunnerLayer(providerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-runspec"),
            name: "Parent",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("parent-runspec-branch"),
            sessionId: SessionId.make("parent-runspec"),
            createdAt: now,
          }),
        )
        const result = yield* runner.run({
          agent: builtinAgent,
          prompt: "check forwarding",
          parentSessionId: SessionId.make("parent-runspec"),
          parentBranchId: BranchId.make("parent-runspec-branch"),
          cwd: process.cwd(),
          runSpec: {
            overrides: {
              modelId: ModelId.make("custom/model"),
              allowedTools: ["bash"],
              deniedTools: ["read"],
              reasoningEffort: "high",
              systemPromptAddendum: "Extra helper-agent instructions",
            },
          },
        })
        expect(result._tag).toBe("Success")
        if (result._tag === "Success") {
          expect(result.text).toContain("child result")
        }
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
describe("AgentRunner", () => {
  it.scopedLive(
    "extension RPC observes and cancels a child after its parent turn ends",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("start-child", {}),
          { ...textStep("child reply"), gated: true },
          textStep("parent finished"),
          // The cancelled child's completion arrives as a parent message and starts this turn.
          textStep("parent noticed"),
        ])
        const child = yield* Ref.make(Option.none<{ sessionId: SessionId; branchId: BranchId }>())
        const requestId = RequestId.make("rpc-child")
        const agent = new AgentDefinition({ name: AgentName.make("child") })
        const input = { agent, prompt: "Wait for the parent", requestId }
        const extension = defineExtension({
          id: "child-lifecycle",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }), agent)
            yield* host.register(
              "tool",
              tool({
                id: "start-child",
                description: "Start a durable child",
                params: Schema.Struct({}),
                output: Schema.Boolean,
                execute: Effect.fn("test.startChild")(function* () {
                  const ctx = yield* ExtensionContext
                  const first = yield* ctx.Agent.start(input)
                  expect(yield* ctx.Agent.start(input)).toEqual(first)
                  yield* Ref.set(child, Option.some(first))
                  // Hold the parent until the gated child model starts, fixing provider order.
                  yield* controls.waitForCall(1)
                  return true
                }),
              }),
            )
            yield* host.register(
              "request",
              request({
                id: "child-status",
                input: Schema.Literals(["inspect", "cancel", "unowned-start", "list"]),
                output: Schema.Boolean,
                execute: Effect.fn("test.childStatus")(
                  function* (action) {
                    const ctx = yield* ExtensionContext
                    if (action === "unowned-start") {
                      const error = yield* ctx.Agent.start(input).pipe(Effect.flip)
                      return error.message === "Child start requires a host-owned tool call"
                    }
                    if (action === "inspect")
                      return Option.isSome((yield* ctx.Agent.inspect({ requestId })).completion)
                    if (action === "cancel") {
                      yield* ctx.Agent.cancel({ requestId })
                      return true
                    }
                    const children = yield* ctx.Agent.list()
                    return children.length === 1 && children[0]?.requestId === requestId
                  },
                  Effect.mapError(
                    (cause) =>
                      new CapabilityError({
                        extensionId: ExtensionId.make("child-lifecycle"),
                        capabilityId: "child-status",
                        reason: String(cause),
                      }),
                  ),
                ),
              }),
            )
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME }), agent],
          extensionInputs: [extension],
          subagentRunner: "live",
        })
        yield* client.message.send({ sessionId, branchId, content: "Start a child" })
        const parentEvents = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.takeUntil((envelope) => envelope.event._tag === "TurnCompleted"),
          Stream.runCollect,
        )
        expect(parentEvents.filter((envelope) => envelope.event._tag === "ErrorOccurred")).toEqual(
          [],
        )
        expect(Option.isSome(yield* Ref.get(child))).toBe(true)
        const address = {
          sessionId,
          branchId,
          extensionId: ExtensionId.make("child-lifecycle"),
          capabilityId: "child-status",
        }
        expect(yield* client.extension.request({ ...address, input: "inspect" })).toBe(false)
        expect(yield* client.extension.request({ ...address, input: "list" })).toBe(true)
        expect(yield* client.extension.request({ ...address, input: "unowned-start" })).toBe(true)
        const other = yield* client.branch.create({ sessionId })
        const foreign = yield* client.extension
          .request({ ...address, branchId: other.branchId, input: "cancel" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(foreign)).toBe(true)
        expect(yield* client.extension.request({ ...address, input: "inspect" })).toBe(false)
        expect(yield* client.extension.request({ ...address, input: "cancel" })).toBe(true)
        yield* waitFor(
          client.extension.request({ ...address, input: "inspect" }),
          (completed) => completed === true,
          2000,
          "cancelled child completion",
        )
        const handle = yield* Effect.fromOption(yield* Ref.get(child))
        const messages = yield* client.message.list({ branchId: handle.branchId })
        expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
        // The parent receives the outcome as an ordinary message, never through the call.
        const parentMessages = yield* waitFor(
          client.message.list({ branchId }),
          (items) =>
            items.some(
              (item) =>
                item.role === "assistant" && messageSingleText(item.parts) === "parent noticed",
            ),
          4000,
          "parent follow-up turn",
        )
        const notice = parentMessages.find(
          (item) => item.role === "user" && item.metadata?.customType === "child-completion",
        )
        expect(notice).toBeDefined()
        expect(messageSingleText(notice?.parts ?? [])).toContain("interrupted")
        expect(messageSingleText(notice?.parts ?? [])).toContain(requestId)
        expect(yield* controls.callCount).toBe(4)
      }).pipe(Effect.timeout("8 seconds")),
    10000,
  )

  it.scopedLive(
    "starts one queue-owned child and returns before its model completes",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("durable child completed"), gated: true },
        ])
        const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer))
        yield* Effect.gen(function* () {
          const runtime = yield* AgentRunnerService
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const parentSessionId = SessionId.make("start-parent")
          const parentBranchId = BranchId.make("start-parent-branch")
          const now = dateFromMillis(1_767_225_600_000)
          yield* sessions.createSession(
            new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
          )
          yield* branches.createBranch(
            new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
          )
          const input = {
            agent: builtinAgent,
            prompt: "Run independently",
            cwd: "/tmp",
            parentSessionId,
            parentBranchId,
            toolCallId: ToolCallId.make("start-tool-call"),
            requestId: RequestId.make("stable-child-start"),
          }
          const first = yield* runtime.start(input).pipe(Effect.scoped)
          yield* controls.waitForCall(0)
          const handle = { requestId: input.requestId, parentSessionId, parentBranchId }
          expect(yield* runtime.inspect(handle)).toEqual({ ...first, completion: Option.none() })
          for (const invalid of [
            { ...handle, parentSessionId: SessionId.make("other-parent") },
            { ...handle, parentBranchId: BranchId.make("other-branch") },
            { ...handle, requestId: RequestId.make("missing-start") },
          ]) {
            const rejected = yield* runtime.inspect(invalid).pipe(Effect.flip)
            expect(rejected.message).toBe("Agent-start receipt not owned by parent")
          }
          const foreign = yield* runtime
            .inspect(handle)
            .pipe(
              Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("1".repeat(64))),
              Effect.flip,
            )
          expect(foreign.message).toBe("Agent-start receipt not owned by parent")
          expect(yield* runtime.inspect(handle)).toEqual({ ...first, completion: Option.none() })
          expect(yield* runtime.list({ parentSessionId, parentBranchId })).toEqual([
            {
              requestId: input.requestId,
              sessionId: first.sessionId,
              branchId: first.branchId,
              agentName: input.agent.name,
              completed: false,
            },
          ])
          expect(yield* runtime.start(input)).toEqual(first)
          expect(yield* controls.callCount).toBe(1)
          expect(
            yield* (yield* RelationshipStorage).getChildSessions(parentSessionId),
          ).toHaveLength(1)
          yield* controls.emitAll(0)
          const waited = yield* waitForCompletion(runtime, handle)
          expect(Option.isSome(waited.completion)).toBe(true)
          expect(yield* runtime.list({ parentSessionId, parentBranchId })).toMatchObject([
            { requestId: input.requestId, completed: true },
          ])
          const storage = yield* MessageStorage
          const completed = yield* waitFor(storage.listMessages(first.branchId), (messages) =>
            messages.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text === "durable child completed",
              ),
            ),
          )
          expect(completed.map((message) => message.role)).toEqual(["user", "assistant"])
          expect(completed[0]?.id).toBe(MessageId.make("agent-start:stable-child-start"))
          const events = yield* EventStorage
          const streamEnd = yield* events.getLatestEvent({
            ...first,
            tags: ["StreamEnded"],
            messageId: MessageId.make("agent-start:stable-child-start"),
          })
          expect(streamEnd).toEqual(
            expect.objectContaining({
              _tag: "StreamEnded",
              messageId: MessageId.make("agent-start:stable-child-start"),
              step: 1,
            }),
          )
          const completion = yield* waitFor(
            events.getLatestEvent({ ...first, tags: ["TurnCompleted"] }),
            (event) => event?._tag === "TurnCompleted",
          )
          expect(completion).toEqual(
            expect.objectContaining({
              messageId: MessageId.make("agent-start:stable-child-start"),
              streamFailed: false,
            }),
          )
          // A later turn receipt must not replace the admitted child's exact completion.
          yield* events.appendEvent(
            TurnCompleted.make({
              ...first,
              messageId: MessageId.make("unrelated-child-turn"),
              durationMs: 1,
              streamFailed: true,
            }),
          )
          expect(yield* runtime.inspect(handle)).toEqual({
            ...first,
            completion: Option.some(yield* Schema.decodeUnknownEffect(TurnCompleted)(completion)),
          })
          expect(yield* runtime.start(input)).toEqual(first)
          expect(yield* controls.callCount).toBe(1)
          yield* sessions.deleteSession(first.sessionId)
          const deleted = yield* runtime.inspect(handle).pipe(Effect.flip)
          expect(deleted.message).toBe("Agent-start child no longer exists")
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("6 seconds")),
    8000,
  )

  it.scopedLive(
    "a child admitted by an interrupted caller is still delivered to its parent",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("child says hi"), gated: true },
          textStep("parent noticed"),
        ])
        // Admission pauses inside the runtime so the caller can die mid-way:
        // the tool fiber of a cell worker that crashed during the op.
        const reached = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const context = yield* Layer.build(
          makeLiveAgentRunnerLayer(providerLayer, "live", (live) => ({
            ...live,
            sendUserMessage: (input) =>
              Deferred.succeed(reached, void 0).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(live.sendUserMessage(input)),
              ),
          })),
        )
        yield* Effect.gen(function* () {
          const runner = yield* AgentRunnerService
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const messages = yield* MessageStorage
          const parentSessionId = SessionId.make("interrupted-parent")
          const parentBranchId = BranchId.make("interrupted-parent-branch")
          const now = dateFromMillis(1_767_225_600_000)
          yield* sessions.createSession(
            new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
          )
          yield* branches.createBranch(
            new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
          )
          const requestId = RequestId.make("interrupted-child")
          const caller = yield* Effect.forkChild(
            runner.start({
              agent: builtinAgent,
              prompt: "Say hi",
              cwd: "/tmp",
              parentSessionId,
              parentBranchId,
              toolCallId: ToolCallId.make("interrupted-tool"),
              requestId,
            }),
          )
          yield* Deferred.await(reached)
          caller.interruptUnsafe()
          yield* Deferred.succeed(release, void 0)
          yield* Fiber.await(caller)
          const admitted = yield* runner.list({ parentSessionId, parentBranchId })
          expect(admitted.map((entry) => entry.requestId)).toEqual([requestId])
          yield* controls.waitForCall(0)
          yield* controls.emitAll(0)
          const noticed = yield* waitFor(
            messages.listMessages(parentBranchId),
            (items) => items.some((item) => item.metadata?.customType === "child-completion"),
            4000,
            "child completion after an interrupted caller",
          )
          expect(
            noticed.filter((item) => item.metadata?.customType === "child-completion"),
          ).toHaveLength(1)
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("8 seconds")),
    10000,
  )

  it.scopedLive(
    "delivers a finished child to its parent once, even when recovery runs again",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("child says hi"), gated: true },
          textStep("parent noticed"),
        ])
        const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer, "live"))
        yield* Effect.gen(function* () {
          const runner = yield* AgentRunnerService
          const delivery = yield* ChildCompletionDelivery
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const messages = yield* MessageStorage
          const events = yield* EventStorage
          const parentSessionId = SessionId.make("deliver-parent")
          const parentBranchId = BranchId.make("deliver-parent-branch")
          const now = dateFromMillis(1_767_225_600_000)
          yield* sessions.createSession(
            new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
          )
          yield* branches.createBranch(
            new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
          )
          // The parent branch has no history: the completion must wake it by itself.
          const requestId = RequestId.make("deliver-child")
          const child = yield* runner.start({
            agent: builtinAgent,
            prompt: "Say hi",
            cwd: "/tmp",
            parentSessionId,
            parentBranchId,
            toolCallId: ToolCallId.make("deliver-tool"),
            requestId,
          })
          yield* controls.waitForCall(0)
          expect(yield* messages.listMessages(parentBranchId)).toHaveLength(0)
          yield* controls.emitAll(0)
          const noticed = yield* waitFor(
            messages.listMessages(parentBranchId),
            (items) =>
              items.some(
                (item) =>
                  item.role === "assistant" && messageSingleText(item.parts) === "parent noticed",
              ),
            4000,
            "parent follow-up turn",
          )
          const isNotice = (item: { metadata?: { customType?: string } }) =>
            item.metadata?.customType === "child-completion"
          const notice = noticed.find(isNotice)
          expect(notice).toMatchObject({
            metadata: {
              customType: "child-completion",
              details: { requestId, sessionId: child.sessionId, branchId: child.branchId },
            },
          })
          const text = messageSingleText(notice?.parts ?? [])
          expect(text).toContain(`requestId ${requestId}`)
          expect(text).toContain("child says hi")
          // A repeated delivery and a startup pass find the message and stop.
          yield* delivery.deliver(requestId)
          yield* delivery.reconcile
          const after = yield* messages.listMessages(parentBranchId)
          expect(after.filter(isNotice)).toHaveLength(1)
          const receipts = yield* events.listEvents({ sessionId: parentSessionId })
          expect(receipts.filter((entry) => entry.event._tag === "AgentRunSucceeded")).toHaveLength(
            1,
          )
          expect(yield* controls.callCount).toBe(2)
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("8 seconds")),
    10000,
  )

  it.scopedLive(
    "cancels the owned child turn and leaves later work intact",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("cancelled reply"), gated: true },
          { ...textStep("later reply"), gated: true },
        ])
        const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer))
        yield* Effect.gen(function* () {
          const runner = yield* AgentRunnerService
          const runtime = yield* SessionRuntime
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const parentSessionId = SessionId.make("cancel-parent")
          const parentBranchId = BranchId.make("cancel-parent-branch")
          const now = dateFromMillis(1_767_225_600_000)
          yield* sessions.createSession(
            new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
          )
          yield* branches.createBranch(
            new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
          )
          const handle = {
            requestId: RequestId.make("cancel-child"),
            parentSessionId,
            parentBranchId,
          }
          const child = yield* runner.start({
            agent: builtinAgent,
            prompt: "Wait for cancellation",
            cwd: "/tmp",
            parentSessionId,
            parentBranchId,
            toolCallId: ToolCallId.make("cancel-tool"),
            requestId: handle.requestId,
          })
          yield* controls.waitForCall(0)
          const foreign = yield* runner
            .cancel({
              ...handle,
              parentBranchId: BranchId.make("foreign-branch"),
            })
            .pipe(Effect.flip)
          expect(foreign.message).toBe("Agent-start receipt not owned by parent")
          const transaction = yield* makeStorageTransaction
          const held = yield* transaction(runner.cancel(handle)).pipe(Effect.flip)
          expect(held.message).toBe("Child cancellation must run outside a caller transaction")
          yield* runner.cancel(handle)
          const stopped = yield* waitForCompletion(runner, handle)
          expect(Option.getOrUndefined(stopped.completion)?.interrupted).toBe(true)
          yield* runtime.sendUserMessage({
            ...child,
            content: "Later work",
            requestId: RequestId.make("later-child-work"),
            completion: "admission",
          })
          yield* controls.waitForCall(1)
          yield* runner.cancel(handle)
          yield* controls.emitAll(1)
          const messages = yield* waitFor(
            (yield* MessageStorage).listMessages(child.branchId),
            (items) =>
              items.some((item) =>
                item.parts.some((part) => part.type === "text" && part.text === "later reply"),
              ),
          )
          expect(messages.filter((message) => message.role === "user")).toHaveLength(2)
          expect(yield* controls.callCount).toBe(2)
          expect(yield* runner.inspect(handle)).toEqual(stopped)
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("6 seconds")),
    8000,
  )

  it.scopedLive(
    "a message sent as the child finishes still gets read",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("first reply"), gated: true },
          { ...textStep("read the correction"), gated: true },
        ])
        const sendReachedRuntime = yield* Deferred.make<void>()
        const childFinished = yield* Deferred.make<void>()
        // Holds the interjection between the runner's completion check and
        // the actor, which is where a real child can finish.
        const holdInterjection = (live: SessionRuntimeService): SessionRuntimeService => ({
          ...live,
          steer: (command) => {
            if (command._tag !== "Interject") return live.steer(command)
            return Deferred.succeed(sendReachedRuntime, void 0).pipe(
              Effect.andThen(Deferred.await(childFinished)),
              Effect.andThen(live.steer(command)),
            )
          },
        })
        const context = yield* Layer.build(
          makeLiveAgentRunnerLayer(providerLayer, "silent", holdInterjection),
        )
        yield* Effect.gen(function* () {
          const runner = yield* AgentRunnerService
          const sessions = yield* SessionStorage
          const branches = yield* BranchStorage
          const parentSessionId = SessionId.make("send-race-parent")
          const parentBranchId = BranchId.make("send-race-parent-branch")
          const now = dateFromMillis(1_767_225_600_000)
          yield* sessions.createSession(
            new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
          )
          yield* branches.createBranch(
            new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
          )
          const handle = {
            requestId: RequestId.make("send-race-child"),
            parentSessionId,
            parentBranchId,
          }
          const child = yield* runner.start({
            agent: builtinAgent,
            prompt: "First task",
            cwd: "/tmp",
            parentSessionId,
            parentBranchId,
            toolCallId: ToolCallId.make("send-race-tool"),
            requestId: handle.requestId,
          })
          yield* controls.waitForCall(0)
          const sending = yield* runner
            .send({ ...handle, message: "CORRECTION", sendId: RequestId.make("send-race-1") })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(sendReachedRuntime)
          yield* controls.emitAll(0)
          yield* waitForCompletion(runner, handle)
          yield* Deferred.succeed(childFinished, void 0)
          yield* Fiber.join(sending)
          yield* controls.waitForCall(1)
          yield* controls.emitAll(1)
          const messages = yield* waitFor(
            (yield* MessageStorage).listMessages(child.branchId),
            (items) =>
              items.some((item) =>
                item.parts.some(
                  (part) => part.type === "text" && part.text === "read the correction",
                ),
              ),
          )
          expect(
            messages.some((item) =>
              item.parts.some((part) => part.type === "text" && part.text === "CORRECTION"),
            ),
          ).toBe(true)
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("6 seconds")),
    8000,
  )
  it.scopedLive("reuses atomic child admission and rejects changed or deleted starts", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const parentSessionId = SessionId.make("admission-parent")
      const parentBranchId = BranchId.make("admission-parent-branch")
      const now = dateFromMillis(1_767_225_600_000)
      yield* sessions.createSession(
        new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
      )
      yield* branches.createBranch(
        new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
      )
      const input = {
        agent: { name: DEFAULT_AGENT_NAME },
        prompt: "Admitted child",
        cwd: "/tmp",
        parentSessionId,
        parentBranchId,
        admission: { requestId: RequestId.make("child-start") },
      }
      const results = yield* Effect.forEach([1, 2], () => admitChildSession(input), {
        concurrency: 2,
      })
      expect(results[0]).toEqual(results[1])
      const first = results[0]
      if (Predicate.isUndefined(first)) return yield* Effect.die("Missing child")
      expect(yield* (yield* RelationshipStorage).getChildSessions(parentSessionId)).toHaveLength(1)
      const changed = yield* admitChildSession({ ...input, prompt: "Changed" }).pipe(Effect.flip)
      expect(changed).toMatchObject({
        _tag: "AgentRunError",
        message: "Agent-start request input changed",
      })
      yield* sessions.deleteSession(first.sessionId)
      const deleted = yield* admitChildSession(input).pipe(Effect.flip)
      expect(deleted).toMatchObject({
        _tag: "AgentRunError",
        message: "Agent-start child no longer exists",
      })
      expect(yield* (yield* RelationshipStorage).getChildSessions(parentSessionId)).toEqual([])
    }).pipe(
      Effect.timeout("4 seconds"),
      Effect.provide(makeLiveAgentRunnerLayer(LanguageModelLayers.debug())),
    ),
  )

  it.scopedLive(
    "concurrent admission caps children and cancellation completes an unsubmitted child",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("finished"),
        ])
        const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer))
        yield* Effect.gen(function* () {
          const runner = yield* AgentRunnerService
          const parentSessionId = SessionId.make("limited-parent")
          const parentBranchId = BranchId.make("limited-branch")
          const now = dateFromMillis(1_767_225_600_000)
          yield* (yield* SessionStorage).createSession(
            new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
          )
          yield* (yield* BranchStorage).createBranch(
            new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
          )
          const toolCallId = ToolCallId.make("limited-start-tool")
          const runSpec = makeRunSpec({ parentToolCallId: toolCallId })
          const base = {
            agent: { name: DEFAULT_AGENT_NAME },
            prompt: "bounded child",
            cwd: "/tmp",
            parentSessionId,
            parentBranchId,
            toolCallId,
          }
          const inputs = [0, 1, 2, 3, 4].map((id) => ({
            ...base,
            admission: { requestId: RequestId.make(`limited-${id}`), runSpec },
          }))
          const results = yield* Effect.forEach(
            inputs,
            (input) =>
              admitChildSession(input).pipe(
                Effect.map((child) => ({ input, child })),
                Effect.exit,
              ),
            { concurrency: 5 },
          )
          const accepted = results.filter(Exit.isSuccess)
          expect(accepted).toHaveLength(4)
          expect(results.filter(Exit.isFailure)).toHaveLength(1)
          expect(yield* controls.callCount).toBe(0)
          const first = accepted[0]
          if (Predicate.isUndefined(first)) return yield* Effect.die("Missing admitted child")
          expect(yield* admitChildSession(first.value.input)).toEqual(first.value.child)
          const extra = {
            ...base,
            admission: { requestId: RequestId.make("limited-extra"), runSpec },
          }
          const full = yield* admitChildSession(extra).pipe(Effect.flip)
          expect(full.message).toBe("Parent branch already has 4 unfinished child starts")
          const wrongBranch = yield* admitChildSession({
            ...extra,
            parentBranchId: BranchId.make("not-parent-branch"),
          }).pipe(Effect.flip)
          expect(wrongBranch.message).toBe("Agent-start branch does not belong to parent")
          const handle = {
            parentSessionId,
            parentBranchId,
            requestId: first.value.input.admission.requestId,
          }
          yield* runner.cancel(handle)
          const cancelled = yield* waitForCompletion(runner, handle)
          expect(Option.getOrUndefined(cancelled.completion)?.interrupted).toBe(true)
          yield* runner.start({
            ...base,
            agent: builtinAgent,
            requestId: first.value.input.admission.requestId,
            runSpec,
          })
          yield* runner.cancel(handle)
          expect(
            yield* (yield* MessageStorage).listMessages(first.value.child.branchId),
          ).toHaveLength(1)
          yield* admitChildSession(extra)
          expect(
            yield* (yield* RelationshipStorage).getChildSessions(parentSessionId),
          ).toHaveLength(5)
          expect(yield* controls.callCount).toBe(0)
        }).pipe(Effect.provideContext(context))
      }).pipe(Effect.timeout("5 seconds")),
    7000,
  )

  it.scopedLive(
    "model attempts for one turn share a durable limit across concurrent calls and restarts",
    () =>
      Effect.gen(function* () {
        const operations = yield* SessionOperationStorage
        const branches = yield* BranchStorage
        const sessionId = SessionId.make("model-limit-session")
        const branchId = BranchId.make("model-limit-branch")
        const now = dateFromMillis(1_767_225_600_000)
        yield* (yield* SessionStorage).createSession(
          new Session({ id: sessionId, createdAt: now, updatedAt: now }),
        )
        yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
        const turn = { sessionId, branchId, messageId: MessageId.make("model-limit-turn"), max: 32 }
        const transaction = yield* makeStorageTransaction
        const held = yield* transaction(operations.reserveModelAttempt(turn)).pipe(Effect.flip)
        expect(held._tag).toBe("StorageError")
        const wrong = yield* operations
          .reserveModelAttempt({ ...turn, sessionId: SessionId.make("other-session") })
          .pipe(Effect.flip)
        expect(wrong._tag).toBe("StorageError")
        const results = yield* Effect.forEach(
          Array.from({ length: 33 }, (_, index) => index),
          () => operations.reserveModelAttempt(turn),
          { concurrency: 8 },
        )
        expect(results.filter((value) => value)).toHaveLength(32)
        expect(results.filter((value) => !value)).toHaveLength(1)
        // Another turn on the same branch has its own count.
        expect(
          yield* operations.reserveModelAttempt({
            ...turn,
            messageId: MessageId.make("model-limit-other-turn"),
          }),
        ).toBe(true)
        // The count is durable: a fresh storage layer sees it spent.
        const fresh = yield* Layer.build(Layer.fresh(SessionOperationStorage.Live))
        expect(yield* Context.get(fresh, SessionOperationStorage).reserveModelAttempt(turn)).toBe(
          false,
        )
      }).pipe(
        Effect.timeout("4 seconds"),
        Effect.provide(makeLiveAgentRunnerLayer(LanguageModelLayers.debug())),
      ),
  )

  it.scopedLive("stops a running child after 32 model attempts", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        ...Array.from({ length: 32 }, (_, index) =>
          toolCallStep("bash", { command: `step-${index}` }),
        ),
        textStep("Must not reach this response"),
      ])
      const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer))
      yield* Effect.gen(function* () {
        const parentSessionId = SessionId.make("running-limit-parent")
        const parentBranchId = BranchId.make("running-limit-branch")
        const now = dateFromMillis(1_767_225_600_000)
        yield* (yield* SessionStorage).createSession(
          new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
        )
        yield* (yield* BranchStorage).createBranch(
          new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
        )
        const runner = yield* AgentRunnerService
        const requestId = RequestId.make("running-limit-start")
        const child = yield* runner.start({
          agent: { name: DEFAULT_AGENT_NAME },
          prompt: "Keep calling bash",
          cwd: "/tmp",
          parentSessionId,
          parentBranchId,
          requestId,
          toolCallId: ToolCallId.make("running-limit-tool"),
        })
        const completed = yield* waitForCompletion(
          runner,
          { parentSessionId, parentBranchId, requestId },
          3000,
        )
        const receipt = yield* Effect.fromOption(completed.completion)
        expect(receipt.streamFailed).toBe(true)
        expect(yield* controls.callCount).toBe(32)
        const messages = yield* (yield* MessageStorage).listMessages(child.branchId)
        expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
        const events = yield* (yield* EventStorage).listEvents(child)
        expect(
          events.some(
            ({ event }) =>
              event._tag === "ErrorOccurred" &&
              event.error.includes("Model-attempt budget exhausted"),
          ),
        ).toBe(true)
      }).pipe(Effect.provideContext(context))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("a foreground child that never answers is an error, not a success", () =>
    Effect.gen(function* () {
      // An empty reply is re-prompted; once the continuations are spent the
      // receipt says `unanswered`. The caller must not read that as a result.
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        textStep(""),
        textStep(""),
        textStep(""),
      ])
      const context = yield* Layer.build(makeLiveAgentRunnerLayer(providerLayer))
      yield* Effect.gen(function* () {
        const parentSessionId = SessionId.make("unanswered-parent")
        const parentBranchId = BranchId.make("unanswered-branch")
        const now = dateFromMillis(1_767_225_600_000)
        yield* (yield* SessionStorage).createSession(
          new Session({ id: parentSessionId, createdAt: now, updatedAt: now }),
        )
        yield* (yield* BranchStorage).createBranch(
          new Branch({ id: parentBranchId, sessionId: parentSessionId, createdAt: now }),
        )
        const runner = yield* AgentRunnerService
        const result = yield* runner.run({
          agent: { name: DEFAULT_AGENT_NAME },
          prompt: "Say nothing",
          cwd: "/tmp",
          parentSessionId,
          parentBranchId,
        })
        expect(result).toMatchObject({
          _tag: "Error",
          error: expect.stringContaining("no answer produced"),
        })
      }).pipe(Effect.provideContext(context))
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.scopedLive("does not create a durable child for a missing parent", () =>
    Effect.gen(function* () {
      const agent = builtinAgent
      const runner = yield* AgentRunnerService
      const parentSessionId = SessionId.make("missing-parent")
      const result = yield* runner.run({
        agent,
        prompt: "Must not start",
        parentSessionId,
        parentBranchId: BranchId.make("missing-branch"),
        cwd: "/tmp",
      })
      expect(result._tag).toBe("Error")
      if (result._tag === "Error")
        expect(result.error).toContain("ancestry is missing or incomplete")
      expect(yield* (yield* RelationshipStorage).getChildSessions(parentSessionId)).toEqual([])
    }).pipe(
      Effect.timeout("4 seconds"),
      Effect.provide(makeLiveAgentRunnerLayer(LanguageModelLayers.debug())),
    ),
  )

  it.live("publishes spawn and complete events", () =>
    Effect.gen(function* () {
      const recorderLayer = SequenceRecorder.Live
      const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(),
        recorderLayer,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner.pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, runnerDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const recorder = yield* SequenceRecorder
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        yield* runner.run({
          agent: builtinAgent,
          prompt: "scan repo",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
        })
        const calls = yield* recorder.getCalls
        assertSequence(calls, [
          { service: "EventStore", method: "append", match: { _tag: "AgentRunSpawned" } },
          { service: "EventStore", method: "append", match: { _tag: "AgentRunSucceeded" } },
        ])
        const spawnRecord = calls.find((c) => {
          const event = Schema.decodeUnknownOption(AgentEvent)(c.args)
          return (
            c.service === "EventStore" &&
            c.method === "append" &&
            event._tag === "Some" &&
            event.value._tag === "AgentRunSpawned"
          )
        })
        expect(spawnRecord).toBeDefined()
        const spawnEvent = yield* Schema.decodeUnknownEffect(AgentEvent)(spawnRecord?.args)
        expect(spawnEvent._tag).toBe("AgentRunSpawned")
        if (spawnEvent._tag === "AgentRunSpawned") {
          const child = yield* sessions.getSession(spawnEvent.childSessionId)
          expect(child?.activeBranchId).toBe(spawnEvent.childBranchId)
        }
        // Verify enriched AgentRunSucceeded payload fields (args is the event object directly)
        const successEvent = calls
          .map((call) => ({
            call,
            event: Schema.decodeUnknownOption(AgentEvent)(call.args),
          }))
          .find(
            ({ call, event }) =>
              call.service === "EventStore" &&
              call.method === "append" &&
              Option.isSome(event) &&
              event.value._tag === "AgentRunSucceeded",
          )
        expect(successEvent).toBeDefined()
        if (Predicate.isUndefined(successEvent) || Option.isNone(successEvent.event)) return
        const event = successEvent.event.value
        if (event._tag !== "AgentRunSucceeded") return
        expect(event.preview).toBeDefined()
        expect(Predicate.isString(event.preview)).toBe(true)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("rolls back durable child session when spawn event append fails", () =>
    Effect.gen(function* () {
      const storageLayer = Layer.orDie(
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
      )
      const failingPublisherLayer = Layer.succeed(
        EventPublisher,
        EventPublisher.of({
          append: () => Effect.fail(new EventStoreError({ message: "spawn append failed" })),
          deliver: () => Effect.void,
          publish: () => Effect.fail(new EventStoreError({ message: "spawn publish failed" })),
        }),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        EventStore.Memory,
        failingPublisherLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(),
      )
      const runnerLayer = InProcessRunner.pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, runnerDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-spawn-rollback"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-spawn-rollback"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const result = yield* runner.run({
          agent: builtinAgent,
          prompt: "spawn rollback",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
        })
        expect(result._tag).toBe("Error")
        const sessionsResult = yield* sessions.listSessions
        expect(
          sessionsResult.filter((candidate) => candidate.parentSessionId === session.id),
        ).toEqual([])
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("propagates failures without retry (no maxAttempts)", () =>
    Effect.gen(function* () {
      const recorderLayer = SequenceRecorder.Live
      const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(() =>
          Effect.fail(new SessionRuntimeError({ message: "permanent failure" })),
        ),
        recorderLayer,
        eventStoreLayer,
        eventPublisherLayer,
      )
      const runnerLayer = InProcessRunner.pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, runnerDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-noretr"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-noretr"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const result = yield* runner.run({
          agent: builtinAgent,
          prompt: "fail test",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
        })
        // Without retry, failure propagates as error result
        expect(result._tag).toBe("Error")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("a child session persists after the run", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        sessionRuntimeStub(),
        eventStoreLayer,
        eventPublisherLayer,
      )
      const runnerLayer = InProcessRunner.pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, runnerDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        const session = new Session({
          id: SessionId.make("parent-session-durable"),
          name: "Parent",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("parent-branch-durable"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* sessions.createSession(session)
        yield* branches.createBranch(branch)
        const runResult = yield* runner.run({
          agent: builtinAgent,
          prompt: "persist this child",
          parentSessionId: session.id,
          parentBranchId: branch.id,
          cwd: process.cwd(),
        })
        const sessionsResult = yield* sessions.listSessions
        return { runResult, sessionsResult }
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result.runResult._tag).toBe("Success")
      if (result.runResult._tag === "Success") {
      }
      expect(result.sessionsResult).toHaveLength(2)
    }),
  )
  it.live("reasoning-only assistant response surfaces reasoning as text", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const storageLayer = SqliteStorage.TestWithSql(
        noBranchTools.storage,
        noBranchTools.migrations,
      )
      // Mock agent loop that writes a reasoning-only assistant message
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const messages = yield* MessageStorage
          const now = dateFromMillis(1_767_225_600_000)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [Prompt.reasoningPart({ text: "I analyzed the repository" })],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        mockRuntime,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner.pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, runnerDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-reasoning"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("branch-reasoning"),
            sessionId: SessionId.make("parent-reasoning"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: builtinAgent,
          prompt: "analyze",
          parentSessionId: SessionId.make("parent-reasoning"),
          parentBranchId: BranchId.make("branch-reasoning"),
          cwd: "/tmp",
        })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.text).toBe("I analyzed the repository")
      }
    }),
  )
  it.live("mixed text+reasoning returns text, not reasoning", () =>
    Effect.gen(function* () {
      const eventStoreLayer = EventStore.Memory
      const eventPublisherLayer = withEventPublisher(eventStoreLayer)
      const storageLayer = SqliteStorage.TestWithSql(
        noBranchTools.storage,
        noBranchTools.migrations,
      )
      const mockRuntime = sessionRuntimeStub((input) =>
        Effect.gen(function* () {
          const messages = yield* MessageStorage
          const now = dateFromMillis(1_767_225_600_000)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: MessageId.make(`${input.sessionId}:assistant:1`),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: [
                Prompt.reasoningPart({ text: "thinking step" }),
                Prompt.textPart({ text: "the actual answer" }),
              ],
              createdAt: now,
            }),
          )
        }).pipe(Effect.provide(storageLayer), Effect.orDie),
      )
      const deps = Layer.mergeAll(
        storageLayer,
        ExtensionRegistry.Test(),
        LanguageModelLayers.debug(),
        ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
        ToolRunner.Test(),
        ApprovalService.Test(),
        mockRuntime,
        eventStoreLayer,
        eventPublisherLayer,
        BunFileSystem.layer,
      )
      const runnerLayer = InProcessRunner.pipe(
        Layer.provide(ChildCompletionDelivery.Silent),
        Layer.provide(Layer.merge(deps, runnerDeps)),
      )
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const runner = yield* AgentRunnerService
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessions.createSession(
          new Session({
            id: SessionId.make("parent-mixed"),
            name: "P",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* branches.createBranch(
          new Branch({
            id: BranchId.make("branch-mixed"),
            sessionId: SessionId.make("parent-mixed"),
            createdAt: now,
          }),
        )
        return yield* runner.run({
          agent: builtinAgent,
          prompt: "analyze",
          parentSessionId: SessionId.make("parent-mixed"),
          parentBranchId: BranchId.make("branch-mixed"),
          cwd: "/tmp",
        })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        expect(result.text).toBe("the actual answer")
      }
    }),
  )
})
// ============================================================================
// Session depth guard
// ============================================================================
describe("session depth guard", () => {
  const depthStorage = SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations)
  const run = <A, E>(
    effect: Effect.Effect<A, E, SessionStorage | BranchStorage | RelationshipStorage>,
  ) => effect.pipe(Effect.timeout("4 seconds"), Effect.provide(depthStorage))

  /** Admission needs the publisher and platform too, not storage alone. */
  const admissionLayer = Layer.mergeAll(
    depthStorage,
    BunPlatformLive,
    Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(
        depthStorage,
        Layer.provide(EventStoreLive, depthStorage),
        ExtensionRegistry.fromResolved(resolveExtensions([])),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ),
    ),
  )
  const runAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.timeout("4 seconds"), Effect.provide(admissionLayer))
  const makeSession = (id: string, parentSessionId?: string) => {
    const fields = {
      id: SessionId.make(id),
      name: `session-${id}`,
      createdAt: dateFromMillis(1_767_225_600_000),
      updatedAt: dateFromMillis(1_767_225_600_000),
    }
    if (!Predicate.isUndefined(parentSessionId)) {
      Object.assign(fields, {
        parentSessionId: SessionId.make(parentSessionId),
        parentBranchId: BranchId.make(`branch-${parentSessionId}`),
      })
    }
    return new Session(fields)
  }
  const makeBranch = (sessionId: string) =>
    new Branch({
      id: BranchId.make(`branch-${sessionId}`),
      sessionId: SessionId.make(sessionId),
      createdAt: dateFromMillis(1_767_225_600_000),
    })
  const buildSessionChain = (depth: number) =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(makeSession("s0"))
      yield* branches.createBranch(makeBranch("s0"))
      for (let i = 1; i <= depth; i++) {
        yield* sessions.createSession(makeSession(`s${i}`, `s${i - 1}`))
        yield* branches.createBranch(makeBranch(`s${i}`))
      }
    })
  it.live("root session has depth 0", () =>
    run(
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(makeSession("root"))
        yield* branches.createBranch(makeBranch("root"))
        expect(yield* getSessionDepth(SessionId.make("root"))).toBe(0)
      }),
    ),
  )
  it.live("child of root has depth 1", () =>
    run(
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(makeSession("root"))
        yield* branches.createBranch(makeBranch("root"))
        yield* sessions.createSession(makeSession("child", "root"))
        yield* branches.createBranch(makeBranch("child"))
        expect(yield* getSessionDepth(SessionId.make("child"))).toBe(1)
      }),
    ),
  )
  it.live("grandchild has depth 2", () =>
    run(
      Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        yield* sessions.createSession(makeSession("root"))
        yield* branches.createBranch(makeBranch("root"))
        yield* sessions.createSession(makeSession("child", "root"))
        yield* branches.createBranch(makeBranch("child"))
        yield* sessions.createSession(makeSession("grandchild", "child"))
        yield* branches.createBranch(makeBranch("grandchild"))
        expect(yield* getSessionDepth(SessionId.make("grandchild"))).toBe(2)
      }),
    ),
  )
  it.live("chain at max depth reports correct depth", () =>
    run(
      Effect.gen(function* () {
        yield* buildSessionChain(DEFAULT_MAX_AGENT_RUN_DEPTH)
        const deepest = SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH}`)
        expect(yield* getSessionDepth(deepest)).toBe(DEFAULT_MAX_AGENT_RUN_DEPTH)
      }),
    ),
  )
  // These two assert the guard itself, not the arithmetic that feeds it: they
  // call admission, so removing the depth check in `admitChildSession` fails
  // them. Asserting `depth >= MAX` only restates `buildSessionChain`.
  const admitUnder = (parentSessionId: string) =>
    admitChildSession({
      agent: { name: DEFAULT_AGENT_NAME },
      prompt: "child of a deep parent",
      parentSessionId: SessionId.make(parentSessionId),
      parentBranchId: BranchId.make(`branch-${parentSessionId}`),
      cwd: "/tmp",
    })

  it.live("parent at max depth blocks child spawn", () =>
    runAdmission(
      Effect.gen(function* () {
        yield* buildSessionChain(DEFAULT_MAX_AGENT_RUN_DEPTH)
        const error = yield* admitUnder(`s${DEFAULT_MAX_AGENT_RUN_DEPTH}`).pipe(Effect.flip)
        expect(error.message).toContain(
          `Agent run depth limit reached (max ${DEFAULT_MAX_AGENT_RUN_DEPTH})`,
        )
      }),
    ),
  )
  it.live("parent below max depth allows child spawn", () =>
    runAdmission(
      Effect.gen(function* () {
        yield* buildSessionChain(DEFAULT_MAX_AGENT_RUN_DEPTH - 1)
        const child = yield* admitUnder(`s${DEFAULT_MAX_AGENT_RUN_DEPTH - 1}`)
        const stored = yield* (yield* SessionStorage).getSession(child.sessionId)
        expect(stored?.parentSessionId).toBe(SessionId.make(`s${DEFAULT_MAX_AGENT_RUN_DEPTH - 1}`))
      }),
    ),
  )
  it.live("missing ancestry cannot grant root-level child admission", () =>
    runAdmission(
      Effect.gen(function* () {
        const error = yield* admitUnder("nonexistent").pipe(Effect.flip)
        expect(error._tag).toBe("AgentRunError")
        expect(error.message).toContain("ancestry is missing or incomplete")
      }),
    ),
  )
})
