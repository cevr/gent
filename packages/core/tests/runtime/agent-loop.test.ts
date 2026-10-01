import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Duration,
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
  DefaultWorkspaceId,
} from "../../src/domain/ids"
import {
  AgentLoopLiveActor,
  AgentLoopSessionGovernance,
  type AgentLoopState,
  buildInitialAgentLoopState,
  emptyAdmissionGate,
  makeAgentLoopWorker,
  makeHoldCount,
  makeLoopInbox,
  type TurnWork,
  wantsWakeOnRecovery,
} from "../../src/runtime/agent-loop"
import { TestClock } from "effect/testing"
import {
  AgentDefinition,
  type AgentName,
  DEFAULT_AGENT_NAME,
  Model,
  ModelId,
  ProviderId,
} from "../../src/domain/agent"
import {
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  emptyQueueSnapshot,
  ensureStorageParents,
  recordingEventStore,
  testSqliteStorage,
} from "../../src/test-utils/harness"
import {
  finishPart,
  type LanguageModelStreamPart,
  reasoningDeltaPart,
  textDeltaPart,
  toolCallPart,
  Auth,
  DecisionModelResolver,
  ModelRegistry,
  ModelResolver,
} from "../../src/runtime/provider"
import {
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textStep,
  toolCallStep,
  turnRequestText,
  waitFor,
} from "../../src/test-utils/language-model"
import {
  assistantMessageIdForTurn,
  Branch,
  dateFromMillis,
  emptyLoopQueueState,
  encodeToolOutput,
  LoopQueueState,
  type LoopQueueState as LoopQueueStateType,
  Message,
  messagePartsReasoning,
  messagePartsText,
  messagePartsToolCallParts,
  type QueuedTurnItem,
  Session,
  type SteerCommand,
  toolResultMessageIdForTurn,
} from "../../src/domain/message"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  getToolId,
  request,
  tool,
  type ToolCapability,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import type { RequestCapability } from "../../src/domain/capability"
import {
  AgentLoopQueueStorage,
  BranchStorage,
  EventStorage,
  MessageStorage,
  SessionOperationStorage,
  SessionStorage,
  ToolCallBindingStorage,
} from "../../src/storage/storage"
import {
  actorTestRoot,
  makeAgentLoopService,
  makeExtRegistry,
  makeLayer,
  makeLayerWithEventStore,
  makeLayerWithEvents,
  makeMessage,
  respondAgentLoopInteraction,
  runAgentLoop,
  steerAgentLoop,
  submitAgentLoop,
  waitFor as waitForOption,
  waitForPhase,
} from "../helpers/agent-loop"
import * as Prompt from "effect/ai/Prompt"
import {
  type AgentEvent,
  EventEnvelope,
  EventId,
  EventStore,
  EventStoreError,
  MessageReceived,
  type StreamEnded,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "../../src/domain/event"
import { type ActiveStreamHandle, ToolResultReplayError, TurnOutcome } from "../../src/runtime/turn"
import { windowMarkerMessage } from "../../src/runtime/model-context"
import { e2ePreset, testAgents } from "../helpers/test-preset"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { type ModelDriverContribution, ProviderAuthError } from "../../src/domain/driver"
import { ConfigService, RuntimeEnvironment } from "../../src/runtime/config"
import { GentPlatform } from "../../src/runtime/gent-platform"
import {
  ApprovalService,
  ExtensionRegistry,
  resolveExtensions,
} from "../../src/runtime/extension-host"
import {
  noBranchTools,
  ProcessLocalToolReplay,
  ToolRunner,
  makeTurnInterruption,
} from "../../src/runtime/tools"
import {
  AgentLoop,
  AgentLoop as AgentLoopActor,
  AgentLoopError,
  buildIdleState,
  buildRunningState,
  entityIdOf,
  type FollowUpQueueFull,
  interjectionMessageId,
  type LoopState,
  type RunningState,
  toWaitingForInteractionState,
} from "../../src/domain/agent-loop"
import * as AiError from "effect/ai/AiError"
import { StorageError } from "../../src/domain/errors"
import type { LanguageModel } from "effect/ai"
import { SingleRunner } from "effect/cluster"
import { SessionRuntime } from "../../src/runtime/session"
import { test } from "bun:test"
import { InteractionPendingError } from "../../src/domain/interaction"
import * as Response from "effect/ai/Response"
import type { AnyResourceContribution, ExtensionContributions } from "../../src/domain/extension"

// ── op primary keys ─────────────────────────────────────────────────────────

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

// ── session termination markers ─────────────────────────────────────────────

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

// ── system prompt date ──────────────────────────────────────────────────────

describe("system prompt date", () => {
  it.scopedLive(
    "a turn after local midnight keeps the cached prefix and tells the model the new date after it",
    () =>
      Effect.gen(function* () {
        // One second before local midnight, set before the runtime starts: crossing midnight
        // later takes a two-second step, not a day of every runtime timer's ticks.
        const beforeMidnight = yield* DateTime.makeZoned(
          { year: 2026, month: 6, day: 15, hour: 23, minute: 59, second: 59 },
          { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
        ).pipe(Effect.fromOption)
        yield* TestClock.setTime(DateTime.toEpochMillis(beforeMidnight))
        // Per request: the leading system blocks (the cached prefix) and the
        // system message after the conversation (the turn's notices).
        const requests = yield* Ref.make<ReadonlyArray<{ prefix: string; tail: string }>>([])
        const secondCall = yield* Deferred.make<void>()
        const systemText = (messages: ReadonlyArray<Prompt.Message>) =>
          messages
            .flatMap((message) => {
              if (message.role !== "system") return []
              return [message.content]
            })
            .join("\n")
        const providerLayer = LanguageModelLayers.testStream((options) =>
          Ref.updateAndGet(requests, (all) => {
            const content = Prompt.make(options.prompt).content
            const firstTurn = content.findIndex((message) => message.role !== "system")
            const lastTurn = content.findLastIndex((message) => message.role !== "system")
            return [
              ...all,
              {
                prefix: systemText(content.slice(0, firstTurn)),
                tail: systemText(content.slice(lastTurn + 1)),
              },
            ]
          }).pipe(
            Effect.tap((all) =>
              Effect.when(Deferred.succeed(secondCall, void 0), Effect.succeed(all.length >= 2)),
            ),
            Effect.as(
              Stream.fromIterable([
                textDeltaPart("noted"),
                finishPart({ finishReason: "stop" }),
              ] satisfies LanguageModelStreamPart[]),
            ),
          ),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        const localDate = Effect.map(DateTime.now, (now) =>
          DateTime.formatIsoDate(DateTime.setZone(now, DateTime.zoneMakeLocal())),
        )
        const today = yield* localDate
        const firstCompleted = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(({ event }) => event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "first" })
        yield* Fiber.join(firstCompleted)
        // The process keeps running past local midnight.
        yield* TestClock.adjust("2 seconds")
        const tomorrow = yield* localDate
        yield* client.message.send({ sessionId, branchId, content: "second" })
        yield* Deferred.await(secondCall)
        const [first, second] = yield* Ref.get(requests)
        expect(today).not.toBe(tomorrow)
        expect(first?.prefix).toContain(`Date: ${today}`)
        expect(first?.tail).not.toContain("Date:")
        expect(second?.prefix).toBe(first?.prefix)
        expect(second?.tail).toContain(`Date: ${tomorrow}`)
      }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("8 seconds")),
    10_000,
  )
})

// ── turn notices ────────────────────────────────────────────────────────────

/** The text of the last message before the request's trailing system messages. */
const lastConversationText = (prompt: Prompt.Prompt): string => {
  const last = prompt.content.findLast((message) => message.role !== "system")
  if (last?.role !== "user") return ""
  return last.content
    .flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
    .join("")
}

describe("turn notices", () => {
  it.scopedLive(
    "a notice rides after the conversation until an answered turn reads it, and the system prompt never changes",
    () =>
      Effect.gen(function* () {
        const requests = yield* Ref.make<ReadonlyArray<ReturnType<typeof turnRequestText>>>([])
        const lastUserTexts = yield* Ref.make<ReadonlyArray<string>>([])
        // The second turn's stream fails: that turn does not answer.
        const providerLayer = LanguageModelLayers.testStream((options) =>
          Effect.gen(function* () {
            const prompt = Prompt.make(options.prompt)
            const call = (yield* Ref.updateAndGet(requests, (all) => [
              ...all,
              turnRequestText(prompt),
            ])).length
            yield* Ref.update(lastUserTexts, (all) => [...all, lastConversationText(prompt)])
            if (call === 2) {
              return yield* AiError.make({
                module: "Test",
                method: "streamText",
                reason: new AiError.AuthenticationError({
                  kind: "Unknown",
                  description: "the keychain is locked",
                }),
              })
            }
            return Stream.fromIterable([
              textDeltaPart(`reply ${call}`),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const unread = yield* Ref.make<ReadonlyArray<string>>([])
        const reads = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
        const notices = defineExtension({
          id: "@test/turn-notices",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.on("turnProjection", () =>
              Effect.map(Ref.get(unread), (keys) => {
                if (keys.length === 0) return {}
                return {
                  notices: [
                    { id: "test-notice", content: `# Test notice\n\n${keys.join("\n")}`, keys },
                  ],
                }
              }),
            )
            yield* host.on("turnAfter", (input: TurnAfterInput) =>
              Effect.gen(function* () {
                yield* Ref.update(reads, (all) => [...all, [...input.readNotices]])
                yield* Ref.update(unread, (keys) =>
                  keys.filter((key) => !input.readNotices.has(key)),
                )
              }),
            )
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          extensionInputs: [...e2ePreset.extensionInputs, notices],
          providerLayer,
        })
        const turn = (content: string, ended: number) =>
          client.message
            .send({ sessionId, branchId, content })
            .pipe(
              Effect.andThen(
                waitFor(
                  Ref.get(reads),
                  (all) => all.length === ended,
                  5_000,
                  `turn ${ended} ended`,
                ),
              ),
            )

        yield* turn("no notice yet", 1)
        yield* Ref.set(unread, ["fired-1"])
        yield* turn("the stream breaks", 2)
        yield* turn("now answer", 3)
        yield* turn("nothing left", 4)

        const sent = yield* Ref.get(requests)
        expect(sent).toHaveLength(4)
        // One system prompt, byte for byte, whether a notice came or went.
        expect(new Set(sent.map((request) => request.systemPrompt)).size).toBe(1)
        expect(sent[0]?.systemPrompt).not.toContain("# Test notice")
        // The notices say they are the host's, not the user's.
        const noticed =
          "Host status for this turn, not a message from the user.\n\n# Test notice\n\nfired-1"
        expect(sent.map((request) => request.notices)).toEqual(["", noticed, noticed, ""])
        // The notice follows the turn's own message: it is the request's last message.
        expect(yield* Ref.get(lastUserTexts)).toEqual([
          "no notice yet",
          "the stream breaks",
          "now answer",
          "nothing left",
        ])
        // The failed turn read nothing; the answered one read what it showed.
        expect(yield* Ref.get(reads)).toEqual([[], [], ["fired-1"], []])
        // No stored message carries the notice.
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(
          snapshot.messages.some((message) =>
            messagePartsText(message.parts).includes("# Test notice"),
          ),
        ).toBe(false)
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )
})

// ── loop residency ──────────────────────────────────────────────────────────

describe("loop residency", () => {
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

  // A phase-failed turn runs its receipt and hooks after the turn phase
  // ended. The loop is still busy with that turn, so it stays resident.
  it.scopedLive(
    "a failed turn's hook runs to its end past the entity idle limit",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const ended = yield* Deferred.make<"finished" | "interrupted">()
        const extension = defineExtension({
          id: "@gent/test-slow-failed-turn-hook",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.on("turnAfter", () =>
              Deferred.succeed(entered, void 0).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Deferred.succeed(ended, "finished")),
                Effect.onInterrupt(() => Deferred.succeed(ended, "interrupted")),
                Effect.asVoid,
              ),
            )
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer: LanguageModelLayers.testStream(() =>
            Effect.succeed(Stream.die("stream defect")),
          ),
          extensionInputs: [...e2ePreset.extensionInputs, extension],
        })
        yield* client.message.send({ sessionId, branchId, content: "fail this turn" })
        yield* Deferred.await(entered)
        // Idle past the entity idle limit (one minute) and the reaper's ticks.
        for (let step = 0; step < 12; step++) yield* TestClock.adjust("10 seconds")
        yield* Deferred.succeed(release, void 0)
        expect(yield* Deferred.await(ended)).toBe("finished")
      }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("8 seconds")),
    10_000,
  )

  it.live("a hold whose switch-on failed is not counted, so the next hold switches on", () =>
    Effect.gen(function* () {
      const switched: Array<boolean> = []
      let failNext = true
      const residency = yield* makeHoldCount((enabled) =>
        Effect.suspend(() => {
          switched.push(enabled)
          if (enabled && failNext) {
            failNext = false
            return Effect.die(new Error("keep-alive refused"))
          }
          return Effect.void
        }),
      )
      const first = yield* Effect.exit(Effect.scoped(residency.held))
      expect(Exit.isFailure(first)).toBe(true)
      yield* Effect.scoped(residency.held)
      expect(switched).toEqual([true, true, false])
    }),
  )

  it.scopedLive(
    "an idle loop stays resident while a client watches its runtime",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("AFTER-IDLE"), gated: true },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          extensions: [],
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
        })
        const seen: Array<string> = []
        const watching = yield* Deferred.make<void>()
        const watch = yield* client.session.watchRuntime({ sessionId, branchId }).pipe(
          Stream.tap((state) =>
            Effect.sync(() => seen.push(state._tag)).pipe(
              Effect.andThen(Deferred.succeed(watching, void 0)),
            ),
          ),
          Stream.takeUntil((state) => state._tag === "Running"),
          Stream.runDrain,
          Effect.forkScoped,
        )
        yield* Deferred.await(watching)
        // Idle past the entity idle limit (one minute) and the reaper's tick.
        yield* TestClock.adjust("10 seconds")
        yield* TestClock.adjust("2 minutes")
        const completed = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter(({ event }) => event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "Still watching?" })
        yield* controls.waitForCall(0)
        // The watch that opened before the idle stretch sees the new turn:
        // it did not end when the loop went idle.
        yield* Fiber.join(watch)
        expect(seen[0]).toBe("Idle")
        expect(seen.at(-1)).toBe("Running")
        yield* controls.emitAll(0)
        yield* Fiber.join(completed)
      }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("8 seconds")),
    10_000,
  )
})

// ── concurrency ─────────────────────────────────────────────────────────────

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
              if (running > 1) yield* Deferred.succeed(bothStarted, void 0)
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
          prompt: "run serial tools",
        })
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

// ── reasoning replay ────────────────────────────────────────────────────────

/**
 * A provider signs its reasoning (an Anthropic thinking signature, OpenAI
 * encrypted reasoning) so a later step can send it back. The loop stores the
 * step's parts and rebuilds the next prompt from storage, so the signature
 * must survive both.
 */
describe("reasoning replay", () => {
  const sessionId = SessionId.make("reasoning-replay-session")
  const branchId = BranchId.make("reasoning-replay-branch")
  const signature: Response.ReasoningDeltaPartMetadata = {
    anthropic: { info: { type: "thinking", signature: "sig-1" } },
  }

  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })

  it.live("the next step sends back the signed reasoning of the step before it", () =>
    Effect.gen(function* () {
      const replayed: Array<Prompt.ReasoningPart> = []
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          parts: [
            Response.makePart("reasoning-start", { id: "0" }),
            Response.makePart("reasoning-delta", { id: "0", delta: "plan the call" }),
            Response.makePart("reasoning-delta", { id: "0", delta: "", metadata: signature }),
            Response.makePart("reasoning-end", { id: "0" }),
            toolCallPart("echo", { text: "hi" }),
            finishPart({ finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }),
          ],
        },
        {
          ...textStep("done"),
          assertOptions: (options) => {
            for (const message of Prompt.make(options.prompt).content) {
              if (message.role !== "assistant") continue
              for (const part of message.content) {
                if (part.type === "reasoning") replayed.push(part)
              }
            }
          },
        },
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(
          agentLoop,
          Message.cases.regular.make({
            id: MessageId.make("reasoning-replay-msg"),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: "call echo" })],
            createdAt: dateFromMillis(1_767_225_600_000),
          }),
        )
        yield* controls.assertDone
        expect(replayed.map((part) => [part.text, part.options])).toEqual([
          ["plan the call", signature],
        ])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.timeout("4 seconds")),
  )
})

// ── turn stream lifecycle ───────────────────────────────────────────────────

describe("turn stream lifecycle", () => {
  it.live("a model turn stores its draft and publishes the lifecycle tags in order", () =>
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
      expect(modelDraft.text).toBe("hello from parity")
      expect(modelDraft.reasoning).toBe("thinking")
      expect(modelDraft.toolCalls).toEqual([])
      // Context projection is logged apart from the stream lifecycle.
      const modelTags = (yield* Ref.get(modelEventsRef))
        .map((event) => event._tag)
        .filter((tag): tag is AgentEvent["_tag"] => tag !== "ModelContextProjected")
      expect(modelTags).toEqual([...expectedTags])
    }),
  )
})

// ── tool projection reconciliation ──────────────────────────────────────────

describe("tool projection reconciliation", () => {
  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: (params) => Effect.succeed({ text: params.text }),
  })

  it.live("a turn resumed after a restart reports no usage total", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("restart-usage-session")
      const branchId = BranchId.make("restart-usage-branch")
      const toolCallId = ToolCallId.make("restart-usage-call")
      const providerLayer = scriptedProvider([
        [
          textDeltaPart("after restart"),
          finishPart({ finishReason: "stop", usage: { inputTokens: 7, outputTokens: 11 } }),
        ],
      ])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const messageStorage = yield* MessageStorage
          yield* ensureStorageParents({ sessionId, branchId })
          const turn = makeMessage(sessionId, branchId, "resume after restart")
          // A previous host settled step 1 and died: its usage never reached this process.
          yield* messageStorage.createMessage(
            Message.cases.regular.make({
              id: assistantMessageIdForTurn(turn.id, 1),
              sessionId,
              branchId,
              role: "assistant",
              parts: [
                Prompt.toolCallPart({
                  id: toolCallId,
                  name: "echo",
                  params: { text: "done" },
                  providerExecuted: false,
                }),
              ],
              createdAt: dateFromMillis(1_767_225_600_010),
            }),
          )
          yield* messageStorage.createMessage(
            Message.cases.regular.make({
              id: toolResultMessageIdForTurn(turn.id, 1),
              sessionId,
              branchId,
              role: "tool",
              parts: [
                Prompt.toolResultPart({
                  id: toolCallId,
                  name: "echo",
                  isFailure: false,
                  providerExecuted: false,
                  result: "done",
                }),
              ],
              createdAt: dateFromMillis(1_767_225_600_020),
            }),
          )

          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, turn)

          const completed = (yield* Ref.get(eventsRef)).find(
            (event) => event._tag === "TurnCompleted" && event.messageId === turn.id,
          )
          expect(completed?._tag).toBe("TurnCompleted")
          expect(completed?._tag === "TurnCompleted" && completed.usage).toBeUndefined()
        }).pipe(
          Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])),
          Effect.timeout("4 seconds"),
        ),
      )
    }),
  )
  it.live("an interrupted cold recovery keeps a stored tool result", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("interrupted-recovery-session")
      const branchId = BranchId.make("interrupted-recovery-branch")
      const toolCallId = ToolCallId.make("interrupted-recovery-call")
      const providerLayer = scriptedProvider([])
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const messageStorage = yield* MessageStorage
          const eventStorage = yield* EventStorage
          const operations = yield* SessionOperationStorage
          yield* ensureStorageParents({ sessionId, branchId })
          const turn = makeMessage(sessionId, branchId, "recover after a stop")
          // A previous host ran the call to success, then died before it wrote
          // the step's tool message. The turn was stopped while it was down.
          const assistant = Message.cases.regular.make({
            id: assistantMessageIdForTurn(turn.id, 1),
            sessionId,
            branchId,
            role: "assistant",
            parts: [
              Prompt.toolCallPart({
                id: toolCallId,
                name: "echo",
                params: { text: "done" },
                providerExecuted: false,
              }),
            ],
            createdAt: dateFromMillis(1_767_225_600_010),
          })
          yield* messageStorage.createMessage(assistant)
          yield* eventStorage.appendEvent(MessageReceived.make({ message: assistant }))
          yield* eventStorage.appendEvent(
            ToolCallSucceeded.make({
              sessionId,
              branchId,
              toolCallId,
              toolName: "echo",
              output: "done",
              resultJson: encodeToolOutput({ text: "done" }),
              assistantMessageId: assistant.id,
            }),
          )
          yield* operations.cancelTurn({ sessionId, branchId, messageId: turn.id })

          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, turn)

          const toolMessage = yield* messageStorage.getMessage(
            toolResultMessageIdForTurn(turn.id, 1),
          )
          expect(toolMessage?.parts).toEqual([
            Prompt.toolResultPart({
              id: toolCallId,
              name: "echo",
              isFailure: false,
              providerExecuted: false,
              result: { text: "done" },
            }),
          ])
          const failed = (yield* Ref.get(eventsRef)).filter(
            (event) => event._tag === "ToolCallFailed",
          )
          expect(failed).toEqual([])
        }).pipe(
          Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])),
          Effect.timeout("4 seconds"),
        ),
      )
    }),
  )
  for (const scenario of [
    { name: "beside a call left with nothing", lost: true },
    { name: "and the turn goes on", lost: false },
  ]) {
    it.live(`a cold resume keeps a stored tool result without its binding, ${scenario.name}`, () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make(`cold-binding-session-${scenario.lost}`)
        const branchId = BranchId.make(`cold-binding-branch-${scenario.lost}`)
        const doneCall = ToolCallId.make("cold-binding-done")
        const lostCall = ToolCallId.make("cold-binding-lost")
        const providerLayer = scriptedProvider([
          [textDeltaPart("after resume"), finishPart({ finishReason: "stop" })],
        ])
        const eventsRef = yield* Ref.make<AgentEvent[]>([])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const messageStorage = yield* MessageStorage
            const eventStorage = yield* EventStorage
            yield* ensureStorageParents({ sessionId, branchId })
            const turn = makeMessage(sessionId, branchId, "resume without bindings")
            // A previous host issued the step's calls and died before its tool
            // message. The finished call's terminal event is stored; a lost
            // call left nothing. No call has a stored binding.
            const calls = [
              Prompt.toolCallPart({
                id: doneCall,
                name: "echo",
                params: { text: "done" },
                providerExecuted: false,
              }),
            ]
            if (scenario.lost) {
              calls.push(
                Prompt.toolCallPart({
                  id: lostCall,
                  name: "echo",
                  params: { text: "lost" },
                  providerExecuted: false,
                }),
              )
            }
            const assistant = Message.cases.regular.make({
              id: assistantMessageIdForTurn(turn.id, 1),
              sessionId,
              branchId,
              role: "assistant",
              parts: calls,
              createdAt: dateFromMillis(1_767_225_600_010),
            })
            yield* messageStorage.createMessage(assistant)
            yield* eventStorage.appendEvent(MessageReceived.make({ message: assistant }))
            yield* eventStorage.appendEvent(
              ToolCallSucceeded.make({
                sessionId,
                branchId,
                toolCallId: doneCall,
                toolName: "echo",
                output: "done",
                resultJson: encodeToolOutput({ text: "done" }),
                assistantMessageId: assistant.id,
              }),
            )

            const agentLoop = yield* makeAgentLoopService
            const exit = yield* Effect.exit(runAgentLoop(agentLoop, turn))

            const toolMessage = yield* messageStorage.getMessage(
              toolResultMessageIdForTurn(turn.id, 1),
            )
            const results = (toolMessage?.parts ?? []).filter(
              (part): part is Prompt.ToolResultPart => part.type === "tool-result",
            )
            // The finished call keeps its stored success.
            expect(results.find((part) => part.id === doneCall)).toEqual(
              Prompt.toolResultPart({
                id: doneCall,
                name: "echo",
                isFailure: false,
                providerExecuted: false,
                result: { text: "done" },
              }),
            )
            if (scenario.lost) {
              // Only the call with no result and no binding is failed.
              expect(results.find((part) => part.id === lostCall)?.isFailure).toBe(true)
              return
            }
            // Every call has a result, so no binding is needed and the turn
            // answers instead of failing on the missing one.
            expect(exit._tag).toBe("Success")
          }).pipe(
            Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])),
            Effect.timeout("4 seconds"),
          ),
        )
      }),
    )
  }
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
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool]))),
      )
    }),
  )
})

// ── model context projection ────────────────────────────────────────────────

describe("model resolution failure", () => {
  it.live("a credential failure shows the user its own message, not the error tag", () => {
    const modelId = ModelId.make("signed-out-driver/model")
    const signInMessage =
      "ChatGPT sign-in expired: refresh token revoked. Sign in again with /auth."
    const driver: ModelDriverContribution = {
      id: "signed-out-driver",
      name: "Signed-out driver",
      resolveModel: () => Effect.fail(new ProviderAuthError({ message: signInMessage })),
    }
    const resolved = resolveExtensions([
      {
        manifest: { id: ExtensionId.make("signed-out-driver") },
        scope: "builtin",
        sourcePath: "test",
        contributions: { agents: testAgents, modelDrivers: [driver] },
      },
    ])
    return Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const layer = actorTestRoot({
        registry: ExtensionRegistry.fromResolved(resolved),
        eventStore: recordingEventStore(eventsRef),
        models: [
          Model.make({
            id: modelId,
            name: "Signed-out model",
            provider: ProviderId.make("signed-out-driver"),
            contextLength: 128_000,
          }),
        ],
        resolver: ModelResolver.Live.pipe(Layer.provide(Auth.Test())),
      })
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(
          agentLoop,
          makeMessage(
            SessionId.make("signed-out-session"),
            BranchId.make("signed-out-branch"),
            "hello",
          ),
          { runSpec: { overrides: { modelId } } },
        ).pipe(Effect.exit)
        const events = yield* Ref.get(eventsRef)
        const shown = events.flatMap((event) => {
          if (event._tag !== "ErrorOccurred") return []
          return [event.error]
        })
        expect(shown).toEqual([signInMessage])
      }).pipe(Effect.scoped, Effect.provide(layer))
    }).pipe(Effect.timeout("5 seconds"))
  })

  it.live("a classifier an agent names is refused before its driver resolves a chat model", () =>
    refusesClassifier({
      agents: [
        AgentDefinition.make({
          name: DEFAULT_AGENT_NAME,
          description: "Agent configured with a classifier",
          model: CLASSIFIER_MODEL_ID,
          contextLength: 128_000,
        }),
      ],
      overrides: {},
    }),
  )

  it.live(
    "a classifier a run override names is refused before its driver resolves a chat model",
    () => refusesClassifier({ agents: testAgents, overrides: { modelId: CLASSIFIER_MODEL_ID } }),
  )
})

const CLASSIFIER_MODEL_ID = ModelId.make("judge-driver/jev-latest")

/** Run one turn whose model is a classifier, and check it is refused by name and never resolved for chat. */
const refusesClassifier = (params: {
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly overrides: { readonly modelId?: ModelId }
}) => {
  const modelId = CLASSIFIER_MODEL_ID
  return Effect.gen(function* () {
    const chatResolves = yield* Ref.make(0)
    const driver: ModelDriverContribution = {
      id: "judge-driver",
      name: "Judge driver",
      resolveModel: () =>
        Ref.update(chatResolves, (count) => count + 1).pipe(
          Effect.andThen(Effect.die("a classifier reached chat resolution")),
        ),
    }
    const resolved = resolveExtensions([
      {
        manifest: { id: ExtensionId.make("judge-driver") },
        scope: "builtin",
        sourcePath: "test",
        contributions: { agents: params.agents, modelDrivers: [driver] },
      },
    ])
    const eventsRef = yield* Ref.make<AgentEvent[]>([])
    const layer = actorTestRoot({
      registry: ExtensionRegistry.fromResolved(resolved),
      eventStore: recordingEventStore(eventsRef),
      // A context window does not make a classifier a chat model.
      models: [
        Model.make({
          id: modelId,
          name: "Jev",
          provider: ProviderId.make("judge-driver"),
          contextLength: 128_000,
          kind: "classifier",
        }),
      ],
      resolver: ModelResolver.Live.pipe(Layer.provide(Auth.Test())),
    })
    yield* Effect.gen(function* () {
      const agentLoop = yield* makeAgentLoopService
      yield* runAgentLoop(
        agentLoop,
        makeMessage(
          SessionId.make("classifier-session"),
          BranchId.make("classifier-branch"),
          "hello",
        ),
        { runSpec: { overrides: params.overrides } },
      ).pipe(Effect.exit)
      const events = yield* Ref.get(eventsRef)
      const shown = events.flatMap((event) => {
        if (event._tag !== "ErrorOccurred") return []
        return [event.error]
      })
      expect(shown).toEqual([
        "judge-driver/jev-latest is a classifier model: it runs no turn; a cell asks it with models.decide",
      ])
      expect(yield* Ref.get(chatResolves)).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(layer))
  }).pipe(Effect.timeout("5 seconds"))
}

// ── admission withdrawal ────────────────────────────────────────────────────

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

const makeHarness = (
  initial: {
    state: LoopState
    queue: LoopQueueState
    turnFailure?: AgentLoopState["turnFailure"]
  },
  options: {
    /** Message ids whose turn fails, as a turn that fails its phase does. */
    readonly failing?: ReadonlySet<string>
    readonly answered?: ReadonlySet<InteractionRequestId>
    readonly sessionAgent?: Effect.Effect<AgentName, AgentLoopError>
    readonly completeFailedTurn?: (state: RunningState) => Effect.Effect<void>
    /** Settle the in-flight slot after each turn, as the real `runTurn` does. */
    readonly settles?: boolean
    /** The entity's keep-alive switch; by default a hold switches nothing, as with no cluster. */
    readonly keepAlive?: (enabled: boolean) => Effect.Effect<void>
  } = {},
) =>
  Effect.gen(function* () {
    const initialLoop: AgentLoopState = buildInitialAgentLoopState({
      state: initial.state,
      queue: initial.queue,
    })
    const loopRef = yield* TxSubscriptionRef.make<AgentLoopState>(
      Option.match(Option.fromUndefinedOr(initial.turnFailure), {
        onNone: () => initialLoop,
        onSome: (turnFailure) => ({ ...initialLoop, turnFailure }),
      }),
    )
    const inbox = yield* makeLoopInbox({
      sessionId,
      branchId,
      loopRef,
      queuePersistenceSemaphore: yield* Semaphore.make(1),
      persistenceFailures: yield* TxSubscriptionRef.make({
        epoch: 0,
        error: Option.none<AgentLoopError>(),
      }),
      startedRef: yield* Ref.make(true),
      turnSettled: () => Effect.succeed(false),
      steerDecided: () => Effect.succeed(false),
    })
    const ranTurns = yield* Ref.make<ReadonlyArray<string>>([])
    const interruptedTurns = yield* Ref.make<ReadonlyArray<boolean>>([])
    const turnWorkerQueue = yield* TxQueue.unbounded<TurnWork>()
    const gateRef = yield* Ref.make(emptyAdmissionGate)
    const sideMutationSemaphore = yield* Semaphore.make(1)
    const turnInterruption = yield* makeTurnInterruption
    const answered = options.answered ?? new Set<InteractionRequestId>()
    const failedTurns = yield* Ref.make<ReadonlyArray<string>>([])
    const loopScope = yield* Scope.make()
    const worker = makeAgentLoopWorker<never, never>({
      sessionId,
      branchId,
      sideMutationSemaphore,
      interruptSemaphore: yield* Semaphore.make(1),
      turnWorkerQueue,
      residency: yield* makeHoldCount(options.keepAlive ?? (() => Effect.void)),
      activeStreamRef: yield* Ref.make(Option.none<ActiveStreamHandle>()),
      turnInterruption,
      interruptToolWork: Effect.void,
      inbox,
      admissionGateRef: gateRef,
      recordTurnFailure: (cause, messageId) =>
        Ref.update(failedTurns, (ids) => [...ids, String(messageId)]).pipe(
          Effect.andThen(
            TxSubscriptionRef.update(loopRef, (s) => ({
              ...s,
              turnFailure: {
                epoch: (s.turnFailure?.epoch ?? 0) + 1,
                messageId,
                error: Cause.squash(cause),
              },
            })),
          ),
        ),
      publishEvent: () => Effect.void,
      completeFailedTurn: options.completeFailedTurn ?? (() => Effect.void),
      interactionAnswered: (requestId) => Effect.succeed(answered.has(requestId)),
      runTurn: (state) =>
        Effect.gen(function* () {
          yield* Ref.update(ranTurns, (ids) => [...ids, String(state.message.id)])
          const interrupted = yield* turnInterruption.interrupted
          yield* Ref.update(interruptedTurns, (all) => [...all, interrupted])
          if (options.settles === true) yield* inbox.settle(state.message.id).pipe(Effect.orDie)
          if (options.failing?.has(String(state.message.id)) === true) {
            return yield* new AgentLoopError({ message: `turn failed: ${state.message.id}` })
          }
          return TurnOutcome.cases.Done.make({})
        }),
      sessionAgent: options.sessionAgent ?? Effect.succeed(DEFAULT_AGENT_NAME),
      loopScope,
    })
    const phase = inbox.phase
    const queue = TxSubscriptionRef.get(loopRef).pipe(Effect.map((s) => s.queue))
    const setPhase = (next: LoopState) => inbox.moveToPhase(next)
    return {
      worker,
      inbox,
      phase,
      loop: TxSubscriptionRef.get(loopRef),
      queue,
      setPhase,
      ranTurns,
      failedTurns,
      interruptedTurns,
      turnWorkerQueue,
      /** Hands a turn to the worker, as the loop's own hand-over does. */
      handOver: (state: RunningState) =>
        Scope.make().pipe(
          Effect.flatMap((resident) => TxQueue.offer(turnWorkerQueue, { state, resident })),
          Effect.asVoid,
        ),
      gateRef,
      sideMutationSemaphore,
      loopScope,
    }
  }).pipe(Effect.provide(memoryQueueStorage))

const waitForEmptyWorkerQueue = (queue: TxQueue.TxQueue<TurnWork>): Effect.Effect<void> =>
  TxQueue.size(queue).pipe(
    Effect.flatMap((size) => {
      if (size === 0) return Effect.void
      return Effect.yieldNow.pipe(Effect.andThen(waitForEmptyWorkerQueue(queue)))
    }),
  )

describe("a turn whose agent cannot be read", () => {
  it.live("fails that turn, releases its admission, and the worker lives on", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const second = queuedItem("second")
      const initial = admitted(first, [])
      const reads = yield* Ref.make(0)
      const harness = yield* makeHarness(initial, {
        // The first read fails, as a busy database or an undecodable admission does.
        sessionAgent: Ref.getAndUpdate(reads, (count) => count + 1).pipe(
          Effect.flatMap((count) => {
            if (count === 0) return Effect.fail(new AgentLoopError({ message: "database busy" }))
            return Effect.succeed(DEFAULT_AGENT_NAME)
          }),
        ),
      })
      yield* harness.handOver(initial.state)
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      const settle = <A>(read: Effect.Effect<A>, until: (value: A) => boolean) =>
        read.pipe(
          Effect.repeat({ until, schedule: Schedule.spaced("5 millis") }),
          Effect.timeout("2 seconds"),
        )
      yield* settle(Ref.get(harness.failedTurns), (ids) => ids.length > 0)
      yield* settle(harness.phase, (phase) => phase._tag === "Idle")
      expect(yield* Ref.get(harness.failedTurns)).toEqual(["first"])
      expect(yield* Ref.get(harness.ranTurns)).toEqual([])
      expect((yield* harness.queue).inFlight).toBeUndefined()
      expect(Option.isNone((yield* Ref.get(harness.gateRef)).started)).toBe(true)
      // The same worker runs the next turn.
      yield* harness.handOver(buildRunningState(second, { startedAtMs: 1 }))
      yield* settle(Ref.get(harness.ranTurns), (ids) => ids.length > 0)
      expect(yield* Ref.get(harness.ranTurns)).toEqual(["second"])
      yield* Fiber.interrupt(loop)
    }),
  )

  it.live(
    "an interrupt while its receipt and hooks run is not held, and spares the next turn",
    () =>
      Effect.gen(function* () {
        const first = queuedItem("first")
        const second = queuedItem("second")
        const initial = admitted(first, [second])
        const reads = yield* Ref.make(0)
        const hooksStarted = yield* Deferred.make<void>()
        const releaseHooks = yield* Deferred.make<void>()
        const harness = yield* makeHarness(initial, {
          sessionAgent: Ref.getAndUpdate(reads, (count) => count + 1).pipe(
            Effect.flatMap((count) => {
              if (count === 0) return Effect.fail(new AgentLoopError({ message: "database busy" }))
              return Effect.succeed(DEFAULT_AGENT_NAME)
            }),
          ),
          // The failed turn's receipt and `turnAfter` hooks: a hook still runs.
          completeFailedTurn: () =>
            Deferred.succeed(hooksStarted, void 0).pipe(
              Effect.andThen(Deferred.await(releaseHooks)),
            ),
        })
        yield* harness.handOver(initial.state)
        const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
        yield* Deferred.await(hooksStarted).pipe(Effect.timeout("2 seconds"))
        // A normal turn's hooks run outside the interrupt permit; so do these.
        const interrupt = yield* harness.worker
          .interrupt()
          .pipe(Effect.timeout("1 second"), Effect.exit)
        yield* Deferred.succeed(releaseHooks, void 0)
        expect(interrupt._tag).toBe("Success")
        yield* Ref.get(harness.ranTurns).pipe(
          Effect.repeat({ until: (ids) => ids.length > 0, schedule: Schedule.spaced("5 millis") }),
          Effect.timeout("2 seconds"),
        )
        // The interrupt stopped the failed turn, not the one queued behind it.
        // (The stub turn never settles, so the worker keeps handing it back.)
        expect((yield* Ref.get(harness.ranTurns))[0]).toBe("second")
        expect((yield* Ref.get(harness.interruptedTurns))[0]).toBe(false)
        yield* Fiber.interrupt(loop)
      }),
  )
})

describe("a loop whose session cannot be read", () => {
  // The loop's branch tools run in the session's cwd. A failed read is not
  // "no session": opening in the host cwd would run them in another project.
  it.live("fails its open, and the next op opens it once the read succeeds", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("unreadable-open-session")
      const branchId = BranchId.make("unreadable-open-branch")
      const unreadable = yield* Ref.make(false)
      const storage = Layer.effect(
        SessionStorage,
        Effect.map(SessionStorage, (real) =>
          SessionStorage.of({
            ...real,
            getSession: (id) =>
              Effect.flatMap(Ref.get(unreadable), (failing) => {
                if (failing) return Effect.fail(new StorageError({ message: "session unreadable" }))
                return real.getSession(id)
              }),
          }),
        ),
      ).pipe(Layer.provideMerge(testSqliteStorage(noBranchTools.storage, noBranchTools.migrations)))
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      yield* Effect.gen(function* () {
        const now = dateFromMillis(1_767_225_600_000)
        yield* (yield* SessionStorage).createSession(
          new Session({
            id: sessionId,
            cwd: "/nonexistent/unreadable-open-cwd",
            createdAt: now,
            updatedAt: now,
          }),
        )
        yield* (yield* BranchStorage).createBranch(
          new Branch({ id: branchId, sessionId, createdAt: now }),
        )
        yield* Ref.set(unreadable, true)
        const ref = yield* (yield* AgentLoopActor.Context)(
          entityIdOf(DefaultWorkspaceId, sessionId, branchId),
        )
        const platform = yield* GentPlatform
        const getState = Effect.gen(function* () {
          return yield* ref.execute(
            AgentLoopActor.GetState.make({
              workspaceId: DefaultWorkspaceId,
              sessionId,
              branchId,
              commandId: ActorCommandId.make(yield* platform.randomId),
            }),
          )
        })
        expect(yield* Effect.flip(getState)).toBeInstanceOf(AgentLoopError)
        yield* Ref.set(unreadable, false)
        expect(Exit.isSuccess(yield* Effect.exit(getState))).toBe(true)
      }).pipe(
        Effect.provide(actorTestRoot({ provider: providerLayer, storage })),
        Effect.timeout("4 seconds"),
      )
    }),
  )
})

describe("a wake and a submit that race for an idle loop", () => {
  it.live("a wake waiting behind a reserved submit takes nothing, and both run once", () =>
    Effect.gen(function* () {
      const steered = queuedItem("steer-from-slash-command")
      const submitted = queuedItem("user-submit")
      const harness = yield* makeHarness(
        { state: buildIdleState(), queue: { ...emptyLoopQueueState(), steering: [steered] } },
        { settles: true },
      )
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      // An extension request holds the loop while it runs.
      yield* harness.sideMutationSemaphore.take(1)
      // Its own-branch wake waits for the permit before it takes anything.
      const wake = yield* Effect.forkChild(harness.worker.startNextIfIdle(), {
        startImmediately: true,
      })
      // A user's Submit arrives in that window and reserves the idle loop.
      const submit = yield* Effect.forkChild(
        harness.worker.admitAndStart(submitted, { queueOnly: false }),
        { startImmediately: true },
      )
      expect((yield* harness.loop).startingState?._tag).toBe("Running")
      yield* harness.sideMutationSemaphore.release(1)
      yield* Fiber.join(wake)
      yield* Fiber.join(submit)
      yield* Ref.get(harness.ranTurns).pipe(
        Effect.repeat({ until: (ids) => ids.length >= 2, schedule: Schedule.spaced("5 millis") }),
        Effect.timeout("1 second"),
      )
      // The wake refused past the reservation; the steering item runs next.
      expect(yield* Ref.get(harness.ranTurns)).toEqual(["user-submit", "steer-from-slash-command"])
      yield* Fiber.interrupt(loop)
    }),
  )
})

describe("a start interrupted while it waits for the loop", () => {
  // Each item runs exactly once; an idle admit starts ahead of queued items.
  const runsOf = (harness: Effect.Success<ReturnType<typeof makeHarness>>, count: number) =>
    Ref.get(harness.ranTurns).pipe(
      Effect.repeat({
        until: (ids) => ids.length >= count,
        schedule: Schedule.spaced("5 millis"),
      }),
      Effect.timeout("2 seconds"),
    )

  it.live("an idle take strands nothing, and both items run once", () =>
    Effect.gen(function* () {
      const first = queuedItem("queued-first")
      const second = queuedItem("submitted-second")
      const harness = yield* makeHarness(
        { state: buildIdleState(), queue: { ...emptyLoopQueueState(), followUp: [first] } },
        { settles: true },
      )
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      // Something holds the loop, so the starter waits for it.
      yield* harness.sideMutationSemaphore.take(1)
      const starter = yield* Effect.forkChild(harness.worker.startNextIfIdle(), {
        startImmediately: true,
      })
      yield* Fiber.interrupt(starter)
      // The start took nothing yet: the take waits for the permit, too.
      expect((yield* harness.loop).startingState).toBeUndefined()
      // An admission in the meantime reserves the idle loop for itself.
      const reserved = yield* Effect.forkChild(
        harness.worker.admitAndStart(second, { queueOnly: false }),
        { startImmediately: true },
      )
      yield* harness.sideMutationSemaphore.release(1)
      yield* Fiber.join(reserved)

      // Nothing starts a turn by hand: the interrupted start still runs.
      expect(yield* runsOf(harness, 2)).toEqual(["submitted-second", "queued-first"])
      expect((yield* harness.queue).followUp).toEqual([])
      yield* Fiber.interrupt(loop)
    }),
  )

  it.live("an interrupted caller's reserved start still runs, and keeps the failure mark", () =>
    Effect.gen(function* () {
      const first = queuedItem("reserved-first")
      const second = queuedItem("queued-second")
      const harness = yield* makeHarness(
        {
          state: buildIdleState(),
          queue: emptyLoopQueueState(),
          // The branch already had three failed turns.
          turnFailure: { epoch: 3, messageId: MessageId.make("earlier"), error: "boom" },
        },
        { settles: true, failing: new Set(["queued-second"]) },
      )
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      // Something holds the loop, so the reserved start waits for it.
      yield* harness.sideMutationSemaphore.take(1)
      const caller = yield* Effect.forkChild(
        harness.worker.admitAndStart(first, { queueOnly: false }),
        { startImmediately: true },
      )
      // The reservation stands, so the next admission queues behind it.
      const queued = yield* harness.worker.admitAndStart(second, { queueOnly: false })
      expect(Option.isNone(queued)).toBe(true)
      yield* Fiber.interrupt(caller)
      // A waiter for the queued item recorded 3 as its baseline; the mark stays.
      expect((yield* harness.loop).turnFailure?.epoch).toBe(3)
      yield* harness.sideMutationSemaphore.release(1)

      // Nothing starts a turn by hand: the loop runs both, in order, once each.
      expect(yield* runsOf(harness, 2)).toEqual(["reserved-first", "queued-second"])
      const failed = yield* harness.loop.pipe(
        Effect.repeat({
          until: (s) => s.turnFailure?.epoch === 4,
          schedule: Schedule.spaced("5 millis"),
        }),
        Effect.timeout("2 seconds"),
      )
      // The queued turn's failure is past the baseline, so its waiter fails.
      expect(failed.turnFailure?.messageId).toBe(second.message.id)
      expect(yield* Ref.get(harness.ranTurns)).toEqual(["reserved-first", "queued-second"])
      yield* Fiber.interrupt(loop)
    }),
  )

  it.live("closing the loop while a reserved start waits runs no turn and fails the caller", () =>
    Effect.gen(function* () {
      const reserved = queuedItem("reserved-then-closed")
      const harness = yield* makeHarness(
        { state: buildIdleState(), queue: emptyLoopQueueState() },
        { settles: true },
      )
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      // Something holds the loop, so the reserved start waits for it.
      yield* harness.sideMutationSemaphore.take(1)
      const caller = yield* Effect.forkChild(
        harness.worker.admitAndStart(reserved, { queueOnly: false }),
        { startImmediately: true },
      )
      yield* Scope.close(harness.loopScope, Exit.void)
      const exit = yield* Fiber.await(caller)
      yield* harness.sideMutationSemaphore.release(1)

      // The caller hears the close; it does not hang.
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain("closed before its turn started")
      }
      // The permit is free, and no start is left to take it.
      yield* Effect.yieldNow
      expect(yield* Ref.get(harness.ranTurns)).toEqual([])
      yield* Fiber.interrupt(loop)
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("closing the loop releases the hold of a turn handed over but not yet taken", () =>
    Effect.gen(function* () {
      const switched: Array<boolean> = []
      const harness = yield* makeHarness(
        { state: buildIdleState(), queue: emptyLoopQueueState() },
        { settles: true, keepAlive: (enabled) => Effect.sync(() => switched.push(enabled)) },
      )
      // No worker runs, so the handed-over turn stays in the worker queue,
      // as it does when the loop closes between a hand-over and the take.
      yield* harness.worker.admitAndStart(queuedItem("handed-over"), { queueOnly: false })
      expect(yield* TxQueue.size(harness.turnWorkerQueue)).toBe(1)
      expect(switched).toEqual([true])
      yield* Scope.close(harness.loopScope, Exit.void)
      // The entity may passivate again: the keep-alive is off.
      expect(switched).toEqual([true, false])
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("an admitted start strands nothing, and both items run once", () =>
    Effect.gen(function* () {
      const first = queuedItem("admitted-first")
      const second = queuedItem("submitted-second")
      const harness = yield* makeHarness(
        { state: buildIdleState(), queue: emptyLoopQueueState() },
        { settles: true },
      )
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      yield* harness.sideMutationSemaphore.take(1)
      const starter = yield* Effect.forkChild(
        harness.worker.admitAndStart(first, { queueOnly: false }),
        { startImmediately: true },
      )
      yield* Fiber.interrupt(starter)
      yield* harness.sideMutationSemaphore.release(1)
      yield* runsOf(harness, 1)
      expect((yield* harness.loop).startingState).toBeUndefined()
      yield* harness.worker.admitAndStart(second, { queueOnly: false })

      // Nothing starts a turn by hand: the reserved start ran on its own.
      expect(yield* runsOf(harness, 2)).toEqual(["admitted-first", "submitted-second"])
      expect((yield* harness.queue).followUp).toEqual([])
      yield* Fiber.interrupt(loop)
    }),
  )
})

describe("a turn parked on an interaction", () => {
  const requestId = InteractionRequestId.make("req-parked")
  const parked = (item: QueuedTurnItem) => ({
    state: toWaitingForInteractionState({
      state: buildRunningState(item, { startedAtMs: 1 }),
      pendingRequestId: requestId,
    }),
    queue: emptyLoopQueueState(),
  })

  it.effect("a cancel that loses the resume to an answer still stops the turn", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness(parked(first))
      // Something holds the loop, so the answer and the cancel both wait for it.
      yield* harness.sideMutationSemaphore.take(1)
      const answer = yield* Effect.forkChild(harness.worker.respondInteraction(requestId), {
        startImmediately: true,
      })
      const cancel = yield* Effect.forkChild(harness.worker.interrupt(), {
        startImmediately: true,
      })
      yield* harness.sideMutationSemaphore.release(1)
      yield* Fiber.join(answer)
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      yield* Fiber.join(cancel)
      yield* waitForEmptyWorkerQueue(harness.turnWorkerQueue)
      yield* Effect.yieldNow
      expect(yield* Ref.get(harness.ranTurns)).toEqual(["first"])
      expect(yield* Ref.get(harness.interruptedTurns)).toEqual([true])
      yield* Fiber.interrupt(loop)
    }),
  )

  it.live("a cancel returns while the resumed turn holds the loop", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness(parked(first))
      // The loop is held, as the worker holds it for a resumed turn.
      yield* harness.sideMutationSemaphore.take(1)
      const cancel = yield* Effect.forkChild(harness.worker.interrupt(), {
        startImmediately: true,
      })
      // An answer resumed the turn; the cancel's latch already stops it.
      yield* harness.setPhase(buildRunningState(first, { startedAtMs: 1 }))
      const exit = yield* Fiber.await(cancel).pipe(Effect.timeoutOption("2 seconds"))
      expect(Option.isSome(exit)).toBe(true)
      yield* harness.sideMutationSemaphore.release(1)
    }),
  )
})

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
      yield* harness.handOver(initial.state)
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
      yield* harness.handOver(initial.state)
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

  it.live("an interrupt aimed at a withdrawn admission does not stop the next turn", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const second = queuedItem("second")
      const harness = yield* makeHarness(admitted(first, [second]), { settles: true })
      // The user stops `first` before the worker claims it, then withdraws it.
      yield* harness.worker.interrupt(first.message.id)
      expect(yield* harness.worker.withdrawAdmittedTurn(first.message.id)).toBe(true)
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      const ran = yield* waitForOption(
        () =>
          Ref.get(harness.interruptedTurns).pipe(
            Effect.map(Option.liftPredicate((all) => all.length === 1)),
          ),
        "the promoted follow-up ran",
      )
      expect(yield* Ref.get(harness.ranTurns)).toEqual(["second"])
      expect(ran).toEqual([false])
      yield* Fiber.interrupt(loop)
    }).pipe(Effect.timeout("4 seconds")),
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

// ── turn lifecycle hooks ────────────────────────────────────────────────────

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

describe("a turn's joined steers", () => {
  it.scopedLive("turnAfter names the steer a step joined into the turn", () =>
    Effect.gen(function* () {
      const inputs = yield* Ref.make<ReadonlyArray<TurnAfterInput>>([])
      const watch = defineExtension({
        id: "@gent/test-turn-after-joined",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.on("turnAfter", (input: TurnAfterInput) =>
            Ref.update(inputs, (all) => [...all, input]),
          )
        }),
      })
      const streaming = yield* Deferred.make<void>()
      const steered = yield* Deferred.make<void>()
      const calls = yield* Ref.make(0)
      // Step one is cut off, so the turn takes another step; the steer
      // admitted while it ran joins at the boundary between them.
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
          if (call > 1) {
            return Stream.fromIterable([
              textDeltaPart("answered"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }
          yield* Deferred.succeed(streaming, void 0)
          yield* Deferred.await(steered)
          return Stream.fromIterable([
            textDeltaPart("part one"),
            finishPart({ finishReason: "length" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        extensionInputs: [...e2ePreset.extensionInputs, watch],
      })
      yield* client.message.send({ sessionId, branchId, content: "answer me" })
      yield* Deferred.await(streaming)
      const requestId = RequestId.make("req-joined-steer")
      yield* client.steer.command({
        command: {
          _tag: "Interject",
          sessionId,
          branchId,
          requestId,
          message: "steer now",
        } satisfies SteerCommand,
      })
      yield* Deferred.succeed(steered, void 0)
      const [ended] = yield* waitFor(
        Ref.get(inputs),
        (all) => all.length === 1,
        5_000,
        "turnAfter fired",
      )
      expect([...(ended?.joinedMessageIds ?? [])]).toEqual([interjectionMessageId(requestId)])
      expect(ended?.messageId).not.toBe(interjectionMessageId(requestId))
    }).pipe(Effect.timeout("8 seconds")),
  )
})

describe("a step that does not settle", () => {
  // Each `StreamEnded` names the model the step ran on, so a usage row is
  // never modelless: the step spent tokens on that model whether or not it
  // settled.
  it.scopedLive("an interrupted step and a broken step name their model", () =>
    Effect.gen(function* () {
      const { layer: signalLayer, controls } = yield* LanguageModelLayers.signal("one. two.")
      const interruptedRun = yield* createRpcHarness({ ...e2ePreset, providerLayer: signalLayer })
      const calls = yield* Ref.make(0)
      const brokenRun = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer: brokenAfterPartialOutput(calls),
      })
      const endedSteps = (run: typeof brokenRun) =>
        run.client.session.events({ sessionId: run.sessionId, branchId: run.branchId }).pipe(
          Stream.takeUntil(({ event }) => event._tag === "TurnCompleted"),
          Stream.runCollect,
          Effect.map((envelopes) => {
            const ended: Array<{
              readonly outcome: StreamEnded["outcome"]
              readonly model: Option.Option<ModelId>
            }> = []
            for (const { event } of envelopes) {
              if (event._tag === "StreamEnded") {
                ended.push({ outcome: event.outcome, model: Option.fromUndefinedOr(event.model) })
              }
            }
            return ended
          }),
          Effect.forkScoped,
        )

      const interruptedSteps = yield* endedSteps(interruptedRun)
      yield* interruptedRun.client.message.send({
        sessionId: interruptedRun.sessionId,
        branchId: interruptedRun.branchId,
        content: "answer me",
      })
      yield* controls.waitForStreamStart.pipe(Effect.timeout("5 seconds"))
      yield* interruptedRun.client.steer.command({
        command: {
          _tag: "Cancel",
          sessionId: interruptedRun.sessionId,
          branchId: interruptedRun.branchId,
          requestId: "req-interrupted-step-model",
        } satisfies SteerCommand,
      })

      const brokenSteps = yield* endedSteps(brokenRun)
      yield* brokenRun.client.message.send({
        sessionId: brokenRun.sessionId,
        branchId: brokenRun.branchId,
        content: "answer me",
      })

      const interrupted = yield* Fiber.join(interruptedSteps)
      const broken = yield* Fiber.join(brokenSteps)
      expect([...interrupted, ...broken].map((step) => step.outcome)).toEqual([
        "Interrupted",
        "Failed",
        "Failed",
        "Failed",
      ])
      // Both harnesses run the same agent, so every end names the same model.
      const models = [...interrupted, ...broken].map((step) => step.model)
      expect(models.every((model) => Option.isSome(model))).toBe(true)
      expect(new Set(models.map((model) => Option.getOrElse(model, () => "")))).toHaveProperty(
        "size",
        1,
      )
    }).pipe(Effect.timeout("20 seconds")),
  )
})

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
          _tag: "Cancel",
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

  // A defect in the stream fails the turn phase, not the stream: the turn
  // ends on its failed receipt, and its hooks run as a normal turn's do,
  // outside the permit an interrupt takes.
  const phaseFailingProvider = () =>
    LanguageModelLayers.testStream(() => Effect.succeed(Stream.die("stream defect")))

  // `Session.stop` sends the Cancel and returns, so this guards the path end
  // to end; the worker test "an interrupt while its receipt and hooks run"
  // proves the interrupt itself no longer waits for the hooks.
  it.scopedLive("a phase-failed turn's hook can stop its own branch", () =>
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<boolean>()
      const extension = defineExtension({
        id: "@gent/test-turn-after-stops-own-branch",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.on("turnAfter", (input: TurnAfterInput) =>
            Effect.gen(function* () {
              const ctx = yield* ExtensionContext
              yield* ctx.Session.stop({}).pipe(Effect.ignore)
              yield* Deferred.succeed(stopped, input.streamFailed)
            }),
          )
        }),
      })
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer: phaseFailingProvider(),
        extensionInputs: [...e2ePreset.extensionInputs, extension],
      })

      yield* client.message.send({ sessionId, branchId, content: "answer me" }).pipe(Effect.exit)
      expect(yield* Deferred.await(stopped).pipe(Effect.timeout("5 seconds"))).toBe(true)
    }),
  )
})

// ── loop open hooks ─────────────────────────────────────────────────────────

/** Answers every model call with one fixed text, and counts the calls. */
const countingReply = (text: string, calls: Ref.Ref<number>) =>
  LanguageModelLayers.testStream(() =>
    Ref.update(calls, (n) => n + 1).pipe(
      Effect.as(
        Stream.fromIterable([
          textDeltaPart(text),
          finishPart({ finishReason: "stop" }),
        ] satisfies LanguageModelStreamPart[]),
      ),
    ),
  )

const hasAssistantText = (messages: ReadonlyArray<Message>, text: string) =>
  messages.some(
    (message) => message.role === "assistant" && messagePartsText(message.parts) === text,
  )

describe("loop open hooks", () => {
  it.scopedLive(
    "a loop rebuilt after a restart runs its loopOpen hooks once, and a turn does not run them again",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-loop-open-")
        const dbPath = `${tempDir}/gent.db`
        const opened = yield* Ref.make<ReadonlyArray<string>>([])
        const extension = defineExtension({
          id: "@gent/test-loop-open-record",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.on("loopOpen", () =>
              Effect.gen(function* () {
                const ctx = yield* ExtensionContext
                yield* Ref.update(opened, (all) => [...all, `${ctx.sessionId}/${ctx.branchId}`])
              }),
            )
          }),
        })
        const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [...e2ePreset.extensionInputs, extension],
            storagePath: dbPath,
          })

        // First process: one answered turn, then the process stops.
        const firstCalls = yield* Ref.make(0)
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              layerFor(countingReply("first answer", firstCalls)),
            )
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message.send({ sessionId, branchId, content: "hello" })
            // The receipt is written before the loop goes idle: a restart
            // after this point has no turn to resume.
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (snapshot) =>
                snapshot.runtime._tag === "Idle" &&
                hasAssistantText(snapshot.messages, "first answer"),
              5_000,
              "the first turn settled",
            )
            return { sessionId, branchId }
          }),
        )
        yield* Ref.set(opened, [])

        // Second process: a snapshot rebuilds the loop, and no turn runs.
        const secondCalls = yield* Ref.make(0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              layerFor(countingReply("second answer", secondCalls)),
            )
            yield* client.session.getSnapshot(started)
            const seen = yield* waitFor(
              Ref.get(opened),
              (all) => all.length > 0,
              5_000,
              "the loopOpen hook ran",
            )
            expect(seen).toEqual([`${started.sessionId}/${started.branchId}`])
            expect(yield* Ref.get(secondCalls)).toBe(0)

            // A turn on the open loop does not open it again.
            yield* client.message.send({ ...started, content: "again" })
            yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (messages) => hasAssistantText(messages, "second answer"),
              5_000,
              "the second turn answered",
            )
            expect(yield* Ref.get(opened)).toEqual([`${started.sessionId}/${started.branchId}`])
          }),
        )
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a loop rebuilt with a turn to resume runs its loopOpen hooks while that turn streams",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-loop-open-resume-")
        const dbPath = `${tempDir}/gent.db`
        const armed = yield* Ref.make(false)
        const opened = yield* Deferred.make<void>()
        const extension = defineExtension({
          id: "@gent/test-loop-open-resume",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.on("loopOpen", () =>
              Effect.gen(function* () {
                if (yield* Ref.get(armed)) yield* Deferred.succeed(opened, void 0)
              }),
            )
          }),
        })
        const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [...e2ePreset.extensionInputs, extension],
            storagePath: dbPath,
          })

        // First process: the turn starts streaming, and the process stops.
        const first = yield* LanguageModelLayers.signal("never sent.")
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(layerFor(first.layer))
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message.send({ sessionId, branchId, content: "hello" })
            yield* first.controls.waitForStreamStart
            return { sessionId, branchId }
          }),
        )
        yield* Ref.set(armed, true)

        // Second process: a snapshot rebuilds the loop, which resumes the
        // turn. The resumed stream is held; the hook runs beside it.
        const second = yield* LanguageModelLayers.signal("resumed reply.")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(layerFor(second.layer))
            yield* client.session.getSnapshot(started)
            yield* second.controls.waitForStreamStart
            const ranDuringTurn = yield* Deferred.await(opened).pipe(
              Effect.timeout("3 seconds"),
              Effect.as(true),
              Effect.catchTag("TimeoutError", () => Effect.succeed(false)),
            )
            yield* second.controls.emitAll
            expect(ranDuringTurn).toBe(true)
          }),
        )
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a loopOpen hook that queues on its own branch wakes it without stalling the rebuild",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-loop-open-queue-")
        const dbPath = `${tempDir}/gent.db`
        const armed = yield* Ref.make(false)
        const extension = defineExtension({
          id: "@gent/test-loop-open-queue",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.on("loopOpen", () =>
              Effect.gen(function* () {
                if (!(yield* Ref.get(armed))) return
                const ctx = yield* ExtensionContext
                yield* ctx.Session.send({
                  delivery: "queue",
                  content: "work was lost in the restart",
                  sourceId: "test-loop-open-notice",
                })
              }),
            )
          }),
        })
        const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [...e2ePreset.extensionInputs, extension],
            storagePath: dbPath,
          })

        const firstCalls = yield* Ref.make(0)
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              layerFor(countingReply("first answer", firstCalls)),
            )
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message.send({ sessionId, branchId, content: "hello" })
            // The receipt is written before the loop goes idle: a restart
            // after this point has no turn to resume.
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (snapshot) =>
                snapshot.runtime._tag === "Idle" &&
                hasAssistantText(snapshot.messages, "first answer"),
              5_000,
              "the first turn settled",
            )
            return { sessionId, branchId }
          }),
        )
        yield* Ref.set(armed, true)

        const secondCalls = yield* Ref.make(0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              layerFor(countingReply("noticed the loss", secondCalls)),
            )
            yield* client.session.getSnapshot(started).pipe(Effect.timeout("3 seconds"))
            const isNotice = (message: Message) =>
              message.role === "user" &&
              messagePartsText(message.parts) === "work was lost in the restart"
            const messages = yield* waitFor(
              client.message.list({ branchId: started.branchId }),
              (all) => hasAssistantText(all, "noticed the loss") && all.some(isNotice),
              5_000,
              "the queued notice started a turn",
            )
            expect(messages.filter(isNotice).length).toBe(1)
            expect(yield* Ref.get(secondCalls)).toBe(1)
          }),
        )
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive("a failing loopOpen hook leaves the loop open and later hooks still run", () =>
    Effect.gen(function* () {
      const later = yield* Deferred.make<void>()
      const failing = defineExtension({
        id: "@gent/test-loop-open-fails",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.on("loopOpen", () => Effect.die("loopOpen broke"))
        }),
      })
      const recording = defineExtension({
        id: "@gent/test-loop-open-after-failure",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.on("loopOpen", () => Deferred.succeed(later, void 0))
        }),
      })
      const calls = yield* Ref.make(0)
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer: countingReply("still answering", calls),
        extensionInputs: [...e2ePreset.extensionInputs, failing, recording],
      })
      yield* client.message.send({ sessionId, branchId, content: "are you there?" })
      yield* Deferred.await(later)
      yield* waitFor(
        client.message.list({ branchId }),
        (all) => hasAssistantText(all, "still answering"),
        5_000,
        "the turn answered",
      )
      expect(yield* Ref.get(calls)).toBe(1)
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.scopedLive(
    "a loopOpen hook that never returns delays no turn and no other hook",
    () =>
      Effect.gen(function* () {
        const hanging = yield* Deferred.make<void>()
        const later = yield* Deferred.make<void>()
        const stuck = defineExtension({
          // Sorts before the recording hook, so a sequential run would stop there.
          id: "@gent/test-loop-open-a-hangs",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.on("loopOpen", () =>
              Deferred.succeed(hanging, void 0).pipe(Effect.andThen(Effect.never)),
            )
          }),
        })
        const recording = defineExtension({
          id: "@gent/test-loop-open-after-hang",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.on("loopOpen", () => Deferred.succeed(later, void 0))
          }),
        })
        const calls = yield* Ref.make(0)
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer: countingReply("not held up", calls),
          extensionInputs: [...e2ePreset.extensionInputs, stuck, recording],
        })
        yield* client.message.send({ sessionId, branchId, content: "are you there?" })
        yield* Deferred.await(hanging)
        yield* Deferred.await(later)
        yield* waitFor(
          client.message.list({ branchId }),
          (all) => hasAssistantText(all, "not held up"),
          5_000,
          "the turn answered while a loopOpen hook still ran",
        )
        expect(yield* Ref.get(calls)).toBe(1)
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
  )
})

// ── recovery race ───────────────────────────────────────────────────────────

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

        const layer = actorTestRoot({ provider: providerLayer, overrides: queueStorageLayer })

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

        const baseStorage = testSqliteStorage(noBranchTools.storage, noBranchTools.migrations)
        const wrappedQueueStorage = gatedQueueStorageLayer(
          reopenGate,
          reopenEntered,
          Layer.provide(AgentLoopQueueStorage.Live, baseStorage),
        )

        const layer = actorTestRoot({
          provider: providerLayer,
          storage: baseStorage,
          overrides: wrappedQueueStorage,
        })

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
              .pipe(Effect.andThen(Deferred.succeed(op2Done, void 0)), Effect.forkChild)

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
            yield* Deferred.succeed(gate, void 0)
            yield* Fiber.join(op1)
            yield* Fiber.join(op2)
            yield* Deferred.await(op2Done)
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
        )
      }),
    10000,
  )
})

describe("startup recovery", () => {
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
            yield* Deferred.succeed(providerCalled, void 0).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("recovered"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const layer = actorTestRoot({ provider: providerLayer })
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
            yield* Deferred.succeed(providerCalled, void 0).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("replayed"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const layer = actorTestRoot({ provider: providerLayer })
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
            yield* Deferred.succeed(providerCalled, void 0).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("replayed"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const layer = actorTestRoot({ provider: providerLayer })
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
            yield* Deferred.succeed(providerCalled, void 0).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("replayed"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const layer = actorTestRoot({ provider: providerLayer })
        const messageId = MessageId.make("msg-steering-replay")
        const message = Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: "answer me" })],
          createdAt: dateFromMillis(1_767_225_600_000),
        })
        // The shape older builds of `deliverSteeringAtStepBoundary` wrote,
        // still on disk: a user-role interjection carrying the `steering`
        // marker, with no completion of its own.
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
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )

  it.live(
    "startup does not replay a failed turn that newer completed turns followed",
    () =>
      Effect.gen(function* () {
        // A turn that failed writes no `TurnCompleted`. Once a later turn has
        // completed, the failed one is history: reopening must not answer it.
        const sessionId = SessionId.make("session-loop-stale-failure")
        const branchId = BranchId.make("branch-loop-stale-failure")
        const providerCalled = yield* Deferred.make<void>()
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(providerCalled, void 0).pipe(Effect.ignore)
            return Stream.fromIterable([
              textDeltaPart("replayed"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[])
          }),
        )
        const failed = makeMessage(sessionId, branchId, "the turn that failed")
        const answered = Message.cases.regular.make({
          ...makeMessage(sessionId, branchId, "the turn that answered"),
          createdAt: dateFromMillis(1_767_225_600_010),
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId, branchId })
            const eventStorage = yield* EventStorage
            yield* eventStorage.appendEvent(MessageReceived.make({ message: failed }))
            yield* eventStorage.appendEvent(MessageReceived.make({ message: answered }))
            yield* eventStorage.appendEvent(
              TurnCompleted.make({ sessionId, branchId, messageId: answered.id, durationMs: 1 }),
            )

            const agentLoop = yield* makeAgentLoopService
            const state = yield* agentLoop.getState({ sessionId, branchId })
            expect(state._tag).toBe("Idle")
            const called = yield* Deferred.await(providerCalled).pipe(
              Effect.timeout("500 millis"),
              Effect.option,
            )
            expect(Option.isNone(called)).toBe(true)
          }).pipe(Effect.provide(makeLayer(providerLayer))),
        )
      }),
    15000,
  )
})

// ── actor commands ──────────────────────────────────────────────────────────

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

const makeClusterRunnerLayer = <A>(storageLayer: ReturnType<typeof testSqliteStorage<A>>) =>
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
  const eventStoreLayer = EventStore.Memory
  const storageLayer = testSqliteStorage(noBranchTools.storage, noBranchTools.migrations)
  let toolRunnerLayer = ToolRunner.Test()
  if (tools.length > 0) toolRunnerLayer = ToolRunner.Live.pipe(Layer.provide(BunServices.layer))
  const baseDeps = Layer.mergeAll(
    storageLayer,
    makeClusterRunnerLayer(storageLayer),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    ExtensionRegistry.fromResolved(resolvedExtensions),
    eventStoreLayer,
    toolRunnerLayer,
    RuntimeEnvironment.Live({
      cwd: "/nonexistent/gent-test-cwd",
      home: "/nonexistent/gent-test-home",
    }),
    ConfigService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    DecisionModelResolver.Live.pipe(Layer.provide(Auth.Test())),
    GentPlatform.Test(),
    AgentLoopSessionGovernance.Live,
  )
  const approvalLayer = ApprovalService.Live.pipe(Layer.provide(baseDeps))
  return Layer.provideMerge(
    Layer.provideMerge(AgentLoopLiveActor({ baseSections: [] }), SessionRuntime.Client),
    Layer.mergeAll(baseDeps, approvalLayer, ProcessLocalToolReplay.Live),
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

describe("a submit whose caller is interrupted before its turn starts", () => {
  it.scopedLive("the turn runs on its own, and a waiting caller sees its own failure", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("interrupted-submit-session")
      const branchId = BranchId.make("interrupted-submit-branch")
      const earlier = makeMessage(sessionId, branchId, "earlier")
      const interrupted = makeMessage(sessionId, branchId, "interrupted")
      const waited = makeMessage(sessionId, branchId, "waited")
      const failing = new Set<string>([earlier.id, waited.id])
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      // A turn fails when its user line cannot be stored.
      const eventStore = Layer.effect(
        EventStore,
        Effect.gen(function* () {
          const memory = yield* EventStore
          return EventStore.of({
            ...memory,
            append: (event: AgentEvent) => {
              if (event._tag === "MessageReceived" && failing.has(event.message.id)) {
                return Effect.fail(new EventStoreError({ message: "append failed" }))
              }
              return memory.append(event)
            },
          })
        }),
      ).pipe(Layer.provide(EventStore.Memory))
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const hold = request({
        id: "hold-loop",
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) =>
          Deferred.succeed(entered, void 0).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(value),
          ),
      })
      const layer = actorTestRoot({
        provider: providerLayer,
        eventStore,
        registry: ExtensionRegistry.fromResolved(makeTestExtensions([], [hold])),
      })
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        // The branch already has one failed turn.
        expect((yield* Effect.exit(runAgentLoop(agentLoop, earlier)))._tag).toBe("Failure")
        // An extension request holds the idle loop.
        const holding = yield* Effect.forkChild(
          requestExtensionViaActor({
            sessionId,
            branchId,
            commandId: ActorCommandId.make("hold-loop"),
            capabilityId: "hold-loop",
            input: "held",
          }),
        )
        yield* Deferred.await(entered)
        // A Submit reserves the idle loop and waits for the permit.
        const caller = yield* Effect.forkChild(submitAgentLoop(agentLoop, interrupted))
        // A SubmitAndWait queues behind the reservation, with one failure as its baseline.
        const waiter = yield* Effect.forkChild(Effect.exit(runAgentLoop(agentLoop, waited)))
        const queue = yield* waitForOption(
          () =>
            agentLoop
              .getQueue({ sessionId, branchId })
              .pipe(Effect.map(Option.liftPredicate((q) => q.followUp.length === 1))),
          "waited message queued",
        )
        expect(queue.followUp.map((entry) => entry.id)).toEqual([waited.id])
        yield* Fiber.interrupt(caller)
        yield* Deferred.succeed(release, void 0)
        yield* Fiber.join(holding)

        // Nothing starts a turn by hand: the interrupted Submit's turn runs,
        // then the queued one, whose failure its caller sees.
        expect((yield* Fiber.join(waiter))._tag).toBe("Failure")
        const messages = yield* (yield* MessageStorage).listMessages(branchId)
        expect(messages.filter((message) => message.id === interrupted.id)).toHaveLength(1)
        expect(streamCalls).toBe(1)
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
})

describe("a full follow-up queue", () => {
  it.scopedLive("refuses a new id, takes a retry in place, and leaves the turn streaming", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("queue-full-session")
      const branchId = BranchId.make("queue-full-branch")
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const firstInterrupted = yield* Ref.make(false)
      const calls = yield* Ref.make(0)
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          const call = yield* Ref.getAndUpdate(calls, (n) => n + 1)
          if (call === 0) {
            yield* Deferred.succeed(firstStarted, void 0)
            yield* Deferred.await(releaseFirst).pipe(
              Effect.onInterrupt(() => Ref.set(firstInterrupted, true)),
            )
          }
          return Stream.fromIterable([
            textDeltaPart(`turn ${call}`),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const submit = (text: string) =>
          submitAgentLoop(agentLoop, makeMessage(sessionId, branchId, text))
        yield* submit("running")
        yield* Deferred.await(firstStarted)
        for (let i = 1; i <= 10; i++) yield* submit(`queued-${i}`)
        const refused = yield* Effect.flip(submit("one-too-many"))
        expect(refused._tag).toBe("FollowUpQueueFull")
        // A retry of a queued id is not a new item: it replaces that one in place.
        yield* submitAgentLoop(
          agentLoop,
          Message.cases.regular.make({
            ...makeMessage(sessionId, branchId, "queued-4"),
            parts: [Prompt.textPart({ text: "queued-4 (retry)" })],
          }),
        )
        // The refusal leaves the loop and its running turn alone.
        expect(yield* Ref.get(firstInterrupted)).toBe(false)
        expect(
          (yield* agentLoop.getQueue({ sessionId, branchId })).followUp.map((item) => item.content),
        ).toEqual(
          Array.from({ length: 10 }, (_, index) => `queued-${index + 1}`).with(
            3,
            "queued-4 (retry)",
          ),
        )
        yield* Deferred.succeed(releaseFirst, void 0)
        yield* waitForOption(
          () => Ref.get(calls).pipe(Effect.map(Option.liftPredicate((n) => n === 11))),
          "every admitted turn ran",
        )
        yield* waitForPhase(agentLoop, { sessionId, branchId }, "Idle")
        // The running turn streamed once: recovery never restarted it.
        expect(yield* Ref.get(calls)).toBe(11)
        expect(yield* Ref.get(firstInterrupted)).toBe(false)
      }).pipe(
        Effect.timeout("8 seconds"),
        Effect.provide(actorTestRoot({ provider: providerLayer })),
      )
    }),
  )
})

describe("a loop closed while a submitted turn waits to start", () => {
  it.scopedLive("no turn runs, and the waiting caller gets the close error", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("closed-submit-session")
      const branchId = BranchId.make("closed-submit-branch")
      const warm = makeMessage(sessionId, branchId, "warm")
      const waited = makeMessage(sessionId, branchId, "waited")
      const behind = makeMessage(sessionId, branchId, "behind")
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const hold = request({
        id: "hold-loop",
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) =>
          Deferred.succeed(entered, void 0).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(value),
          ),
      })
      const layer = actorTestRoot({
        provider: providerLayer,
        registry: ExtensionRegistry.fromResolved(makeTestExtensions([], [hold])),
      })
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        yield* runAgentLoop(agentLoop, warm)
        expect(streamCalls).toBe(1)
        // An extension request holds the idle loop.
        const holding = yield* Effect.forkChild(
          Effect.exit(
            requestExtensionViaActor({
              sessionId,
              branchId,
              commandId: ActorCommandId.make("hold-loop"),
              capabilityId: "hold-loop",
              input: "held",
            }),
          ),
        )
        yield* Deferred.await(entered)
        // A SubmitAndWait reserves the idle loop and waits for the permit.
        const waiter = yield* Effect.forkChild(Effect.exit(runAgentLoop(agentLoop, waited)))
        // A Submit queues behind the reservation, which proves it stands.
        const submitted = yield* Effect.forkChild(Effect.exit(submitAgentLoop(agentLoop, behind)))
        const queue = yield* waitForOption(
          () =>
            agentLoop
              .getQueue({ sessionId, branchId })
              .pipe(Effect.map(Option.liftPredicate((q) => q.followUp.length === 1))),
          "behind message queued",
        )
        expect(queue.followUp.map((entry) => entry.id)).toEqual([behind.id])
        // The branch closes under it.
        const actorClientFactory = yield* AgentLoopActor.Context
        const ref = yield* actorClientFactory(entityIdOf(DefaultWorkspaceId, sessionId, branchId))
        yield* ref.execute(
          AgentLoopActor.TerminateBranch.make({
            workspaceId: DefaultWorkspaceId,
            sessionId,
            branchId,
            commandId: ActorCommandId.make("close-branch"),
          }),
        )
        const exit = yield* Fiber.join(waiter)
        yield* Deferred.succeed(release, void 0)
        yield* Fiber.join(holding)
        // A Submit that only queued returned at admission.
        expect((yield* Fiber.join(submitted))._tag).toBe("Success")

        expect(exit._tag).toBe("Failure")
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(AgentLoopError)
        }
        // The closed start ran no turn, and nothing ran after it.
        expect(streamCalls).toBe(1)
        const messages = yield* (yield* MessageStorage).listMessages(branchId)
        expect(messages.map((message) => message.id)).not.toContain(waited.id)
        expect(messages.map((message) => message.id)).not.toContain(behind.id)
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
})

describe("agent-loop actor commands", () => {
  it.scopedLive("side-mutation commands are serialized per session", () =>
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
              yield* Deferred.succeed(firstEntered, void 0)
              yield* Deferred.await(releaseFirst)
            }
            completed++
            return value
          }),
      })
      const layer = makeRuntimeLayer(providerLayer, [], [blockingRequest])
      yield* Effect.gen(function* () {
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
        yield* Deferred.succeed(releaseFirst, void 0)
        yield* Fiber.join(firstFiber)
        yield* Fiber.join(secondFiber)
        expect(entered).toBe(2)
        expect(completed).toBe(2)
      }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer))
    }),
  )

  it.scopedLive("a side mutation waits for the active turn mutation owner", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(streamStarted, void 0)
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
      yield* Effect.gen(function* () {
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
        const earlyRequest = yield* Fiber.join(requestFiber).pipe(Effect.timeoutOption("1 millis"))
        expect(earlyRequest._tag).toBe("None")
        expect(executed).toBe(false)
        yield* Deferred.succeed(streamReleased, void 0)
        yield* Fiber.join(submitFiber)
        const result = yield* Fiber.join(requestFiber)
        expect(executed).toBe(true)
        expect(result).toEqual("blocked until turn completes")
      }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer))
    }),
  )

  it.scopedLive("a read-only request answers while the turn holds the mutation permit", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(streamStarted, void 0)
          yield* Deferred.await(streamReleased)
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const readProbe = request({
        id: "read-probe",
        answersDuringTurn: true,
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) => Effect.succeed(`read ${value}`),
      })
      const layer = makeRuntimeLayer(providerLayer, [], [readProbe])
      yield* Effect.gen(function* () {
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
        yield* Deferred.succeed(streamReleased, void 0)
        yield* Fiber.join(submitFiber)
      }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer))
    }),
  )

  it.scopedLive("TerminateBranch interrupts an active turn while a side mutation is waiting", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(streamStarted, void 0)
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
      yield* Effect.gen(function* () {
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
        yield* Deferred.succeed(streamReleased, void 0).pipe(Effect.ignore)
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
})

// ── turn queue ──────────────────────────────────────────────────────────────

describe("loop inbox", () => {
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
      readonly admit: (
        item: QueuedTurnItem,
      ) => Effect.Effect<unknown, AgentLoopError | FollowUpQueueFull>
      readonly queue: Effect.Effect<LoopQueueStateType>
      readonly inbox: Effect.Success<ReturnType<typeof makeLoopInbox>>
      readonly loopRef: TxSubscriptionRef.TxSubscriptionRef<AgentLoopState>
    }) => Effect.Effect<A, AgentLoopError | FollowUpQueueFull>,
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
        persistenceFailures: yield* TxSubscriptionRef.make({
          epoch: 0,
          error: Option.none<AgentLoopError>(),
        }),
        startedRef: yield* Ref.make(true),
        turnSettled: (messageId) => Effect.succeed(messageId === MessageId.make("settled")),
        // The running turn opened on "busy", so its message is stored.
        steerDecided: (messageId) => Effect.succeed(messageId === MessageId.make("busy")),
      }).pipe(
        Effect.provideService(AgentLoopQueueStorage, {
          getQueueState: () => Ref.get(rows),
          putQueueState: (_s, _b, queue) => Ref.set(rows, queue),
        }),
      )
      return yield* body({
        admit: (item) => inbox.admit(item, { queueOnly: true }),
        queue: TxSubscriptionRef.get(loopRef).pipe(Effect.map((s) => s.queue)),
        inbox,
        loopRef,
      })
    })

  // A stop's take-back and a step's join decide over the same queue: the
  // message is either taken back and never joined, or joined and not taken.
  it.live("a take-back that arrives while a step joins the steer does not also take it", () =>
    withInbox(({ inbox }) =>
      Effect.gen(function* () {
        const steer = queuedMessage("steer-racing-a-join", "CORRECTION")
        yield* inbox.steer({ message: steer })
        const joining = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const joined: Array<string> = []
        const delivery = yield* inbox
          .deliverSteering({
            finalStep: false,
            join: (item) =>
              Deferred.succeed(joining, void 0).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.sync(() => joined.push(String(item.message.id)))),
              ),
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(joining)
        const takeBack = yield* inbox.withdrawSteering(steer.id).pipe(Effect.forkChild)
        // The take-back runs its course before the join finishes, if nothing orders them.
        yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))
        yield* Deferred.succeed(release, void 0)
        yield* Fiber.join(delivery)
        const takenBack = yield* Fiber.join(takeBack)
        expect(joined).toEqual([String(steer.id)])
        expect(takenBack).toBe(false)
      }).pipe(Effect.timeout("2 seconds"), Effect.orDie),
    ),
  )

  it.effect("a take-back removes a queued copy of the steer whose turn is running", () =>
    withInbox(({ inbox, loopRef }) =>
      Effect.gen(function* () {
        const copy: QueuedTurnItem = { message: queuedMessage("busy", "busy (steer copy)") }
        yield* TxSubscriptionRef.update(loopRef, (s) => ({
          ...s,
          queue: { ...s.queue, steering: [copy] },
        }))
        expect(yield* inbox.withdrawSteering(copy.message.id)).toBe(true)
        expect((yield* TxSubscriptionRef.get(loopRef)).queue.steering).toEqual([])
      }),
    ),
  )

  it.effect("a queued follow-up that asks to wake makes the stored queue wake", () =>
    withInbox((inbox) =>
      Effect.gen(function* () {
        yield* inbox.admit({ message: queuedMessage("wake-a", "first") })
        expect(wantsWakeOnRecovery(yield* inbox.queue)).toEqual(
          Option.some({ unconditional: false }),
        )
        yield* inbox.admit({
          message: queuedMessage("wake-b", "second"),
          wake: true,
        })
        const woken = yield* inbox.queue
        expect(woken.followUp.map((item) => item.wake === true)).toEqual([false, true])
        expect(wantsWakeOnRecovery(woken)).toEqual(Option.some({ unconditional: true }))
      }),
    ),
  )

  it.effect("re-admitting a queued follow-up id replaces that item in place", () =>
    withInbox((inbox) =>
      Effect.gen(function* () {
        yield* inbox.admit({ message: queuedMessage("user-a", "first") })
        yield* inbox.admit({
          message: queuedMessage("follow-up:w:s:b:child-1", "child done"),
        })
        yield* inbox.admit({ message: queuedMessage("user-c", "third") })
        yield* inbox.admit({
          message: queuedMessage("follow-up:w:s:b:child-1", "child done (retry)"),
        })
        expect(
          (yield* inbox.queue).followUp.map((item) => [
            String(item.message.id),
            messagePartsText(item.message.parts),
          ]),
        ).toEqual([
          ["user-a", "first"],
          ["follow-up:w:s:b:child-1", "child done (retry)"],
          ["user-c", "third"],
        ])
      }),
    ),
  )

  // A replayed follow-up whose turn runs or ran is not a new turn. The running
  // turn gave up its in-flight slot when it started, so only the phase names it.
  it.effect("re-admitting the running turn's id queues nothing", () =>
    withInbox((inbox) =>
      Effect.gen(function* () {
        yield* inbox.admit({ message: queuedMessage("busy", "busy (replay)") })
        expect((yield* inbox.queue).followUp).toEqual([])
      }),
    ),
  )

  it.effect("re-admitting a settled turn's id queues nothing", () =>
    withInbox((inbox) =>
      Effect.gen(function* () {
        yield* inbox.admit({ message: queuedMessage("settled", "settled (replay)") })
        expect((yield* inbox.queue).followUp).toEqual([])
      }),
    ),
  )

  test("a recovered queue with nothing in it never wakes", () => {
    expect(wantsWakeOnRecovery(emptyLoopQueueState())).toEqual(Option.none())
  })
})

describe("queued follow-ups drain", () => {
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
        const layer = actorTestRoot({ provider: gatedProvider })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
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
                  yield* Deferred.succeed(secondFollowUpStored, void 0).pipe(
                    Effect.catchEager(() => Effect.void),
                  )
                }
              }),
          }),
        )
        const makeLayer = () =>
          actorTestRoot({ provider: queuedProvider, overrides: queueStorageLayer })
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
            yield* submitAgentLoop(agentLoop, makeMessage("msg-persist-race-0", "first"))
            const firstQueued = yield* Effect.forkChild(
              submitAgentLoop(agentLoop, makeMessage("msg-persist-race-1", "second")),
            )
            const secondQueued = yield* Effect.forkChild(
              submitAgentLoop(agentLoop, makeMessage("msg-persist-race-2", "third")),
            )
            yield* Fiber.join(firstQueued)
            yield* Fiber.join(secondQueued)
            expect((yield* agentLoop.getQueue({ sessionId, branchId })).followUp).toHaveLength(2)
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(makeLayer())),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const recovered = yield* agentLoop.getQueue({ sessionId, branchId })
            expect(recovered.followUp.map((item) => item.content)).toEqual(["second", "third"])
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(makeLayer())),
        )
        yield* Deferred.succeed(activeTurnReleased, void 0).pipe(
          Effect.catchEager(() => Effect.void),
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
        const storageLayer = testSqliteStorage(noBranchTools.storage, noBranchTools.migrations)
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
        const layer = actorTestRoot({
          provider: providerLayer,
          storage: storageLayer,
          overrides: queueStorageLayer,
          registry: makeExtRegistry([echoTool]),
        })
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
              submitAgentLoop(agentLoop, turn).pipe(Effect.ignore),
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
        const layer = actorTestRoot({ provider: heldProvider, overrides: queueStorageLayer })
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
            yield* submitAgentLoop(agentLoop, makeMessage("msg-persist-failure-0", "first"))

            const queuedExit = yield* Effect.exit(
              submitAgentLoop(agentLoop, makeMessage("msg-persist-failure-1", "second")),
            )

            expect(queuedExit._tag).toBe("Failure")
            expect((yield* agentLoop.getQueue({ sessionId, branchId })).followUp).toEqual([])
            expect((yield* Ref.get(storedQueueRef)).followUp).toEqual([])
          }).pipe(Effect.provide(layer)),
        )
        yield* Deferred.succeed(activeTurnReleased, void 0).pipe(
          Effect.catchEager(() => Effect.void),
        )
      }),
    15000,
  )
})

// ── interactions ────────────────────────────────────────────────────────────

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
    events: Ref.Ref<AgentEvent[]>,
  ) =>
    actorTestRoot({
      provider: makeInteractionProviderLayer(),
      registry: makeExtRegistry(tools),
      eventStore: recordingEventStore(events),
      toolRunner: ToolRunner.Live,
    })
  it.live("tool triggers InteractionPendingError and machine parks", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const events = yield* Ref.make<AgentEvent[]>([])
      const layer = makeInteractionRecordingLayer([tool], events)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
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
          const eventTags = (yield* Ref.get(events)).map((event) => event._tag)
          expect(eventTags).toContain("ToolCallStarted")
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(yield* Ref.get(callCount)).toBe(2)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("stale interaction response does not resume a different pending request", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeInteractionRecordingLayer([tool], yield* Ref.make<AgentEvent[]>([]))
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
              _tag: "Cancel",
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
            _tag: "Cancel",
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
            _tag: "Cancel",
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
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("a turn resumed after an interaction reports the usage of every step", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      let streamCall = 0
      const provider = LanguageModelLayers.testStream(() => {
        const call = streamCall++
        if (call === 0) {
          return Effect.succeed(
            Stream.fromIterable([
              toolCallPart(
                "interaction-tool",
                { value: "test" },
                { toolCallId: ToolCallId.make("tc-usage") },
              ),
              finishPart({
                finishReason: "tool-calls",
                usage: { inputTokens: 3, outputTokens: 5 },
              }),
            ] satisfies LanguageModelStreamPart[]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop", usage: { inputTokens: 7, outputTokens: 11 } }),
          ] satisfies LanguageModelStreamPart[]),
        )
      })
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const layer = makeLiveToolLayer(provider, [tool], [], recordingEventStore(eventsRef))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const message = makeIntMessage("usage across a park")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Fiber.join(fiber)
          const completed = (yield* Ref.get(eventsRef)).find(
            (event) => event._tag === "TurnCompleted" && event.messageId === message.id,
          )
          expect(completed?._tag === "TurnCompleted" && completed.usage).toEqual({
            inputTokens: 10,
            outputTokens: 16,
          })
        }).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("an interrupt during a parked interaction gives the parked call a result", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeLiveToolLayer(makeInteractionProviderLayer(), [tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const message = makeIntMessage("interrupt parked call")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* steerAgentLoop({
            _tag: "Cancel",
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: "req-interrupt-parked-call",
          })
          yield* Fiber.join(fiber)
          const results = yield* (yield* MessageStorage).getMessage(
            toolResultMessageIdForTurn(message.id, 1),
          )
          expect(results?.parts).toEqual([
            expect.objectContaining({ type: "tool-result", id: "tc-1", isFailure: true }),
          ])
          // The branch still projects: a later turn runs to an answer.
          yield* runAgentLoop(agentLoop, makeIntMessage("after the interrupt"))
          expect(yield* Ref.get(callCount)).toBe(1)
        }).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
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
      const loopLayer = actorTestRoot({ provider: providerLayer })
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
          .pipe(Effect.provide(layer))
          .pipe(Effect.timeout("2 seconds")),
      )
    }),
  )
})

// ── run completion ──────────────────────────────────────────────────────────

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
      }).pipe(Effect.provide(makeLayer(providerLayer)))
    }),
  )
})
describe("turn scheduling", () => {
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

  it.live(
    "concurrent sessions run independently",
    () =>
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
            // A's model stays open until the gate opens below, so B finishing
            // here is B running without A. B waiting on A never finishes, and
            // the test's deadlock bound fails it.
            const finishedB = yield* Fiber.await(fiberB)
            expect(Exit.isSuccess(finishedB)).toBe(true)
            const statusA = fiberA.pollUnsafe()
            expect(statusA).toBeUndefined()
            yield* Deferred.succeed(gate, void 0)
            yield* Fiber.join(fiberA)
          }).pipe(Effect.provide(layer)),
        )
      }).pipe(Effect.timeout("10 seconds")),
    15_000,
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
      const baseStorageLayer = testSqliteStorage(noBranchTools.storage, noBranchTools.migrations)
      const layer = actorTestRoot({ provider: providerLayer, storage: baseStorageLayer })
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
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiberA)
          yield* waitForPhase(
            agentLoop,
            { sessionId: SessionId.make("s1"), branchId: BranchId.make("b1") },
            "Idle",
          )
          expect(calls).toBe(2)
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
          // No writer sends `Interrupt` now; a stored steer row with it still cancels.
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
          yield* Deferred.succeed(gateA, void 0)
          yield* Deferred.succeed(gateB, void 0)
          yield* Fiber.join(fiberB)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
})

describe("a failed turn", () => {
  it.live("publishes StreamStarted and TurnCompleted events", () =>
    Effect.gen(function* () {
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(
          Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
        ),
      )
      const events = yield* Ref.make<AgentEvent[]>([])
      const layer = makeLayerWithEvents(providerLayer, events)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(
            agentLoop,
            makeMessage(SessionId.make("s1"), BranchId.make("b1"), "inspect me"),
          )
          const publishedEvents = (yield* Ref.get(events)).map((event) => event._tag)
          expect(publishedEvents).toContain("StreamStarted")
          expect(publishedEvents).toContain("TurnCompleted")
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
        EventStore,
        EventStore.of({
          subscribe: () => Stream.empty,
          removeSession: () => Effect.void,
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
      }).pipe(Effect.provide(makeLayerWithEventStore(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("a turn a phase failure stops ends with one failed TurnCompleted after its error", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("not committed"), finishPart({ finishReason: "stop" })],
      ])
      const seen = yield* Ref.make<ReadonlyArray<AgentEvent>>([])
      const record = (event: AgentEvent) => Ref.update(seen, (events) => [...events, event])
      // The assistant line's append fails: a storage failure inside a turn
      // phase, which the model stream never sees.
      const failingPublisherLayer = Layer.succeed(
        EventStore,
        EventStore.of({
          subscribe: () => Stream.empty,
          removeSession: () => Effect.void,
          append: (event: AgentEvent) => {
            if (event._tag === "MessageReceived" && event.message.role === "assistant") {
              return Effect.fail(new EventStoreError({ message: "append failed" }))
            }
            return Effect.gen(function* () {
              yield* record(event)
              return EventEnvelope.make({
                id: EventId.make(0),
                event,
                createdAt: yield* Clock.currentTimeMillis,
              })
            })
          },
          deliver: () => Effect.void,
          publish: record,
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const messageStorage = yield* MessageStorage
        const message = makeMessage(
          SessionId.make("phase-failure-session"),
          BranchId.make("phase-failure-branch"),
          "hello",
        )
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        expect(exit._tag).toBe("Failure")
        const events = yield* Ref.get(seen)
        const tags = events.map((event) => event._tag)
        expect(events.filter((event) => event._tag === "TurnCompleted")).toEqual([
          expect.objectContaining({ messageId: message.id, streamFailed: true }),
        ])
        // The error names the cause first; the receipt ends the turn.
        expect(tags.lastIndexOf("ErrorOccurred")).toBeGreaterThanOrEqual(0)
        expect(tags.lastIndexOf("ErrorOccurred")).toBeLessThan(tags.indexOf("TurnCompleted"))
        // The stored duration is the receipt's mark: the turn is complete.
        const stored = yield* messageStorage.getMessage(message.id)
        expect(stored?.turnDurationMs).toBeDefined()
      }).pipe(Effect.provide(makeLayerWithEventStore(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("a failure after the turn stored its receipt appends no second TurnCompleted", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("answered"), finishPart({ finishReason: "stop" })],
      ])
      const appended = yield* Ref.make<ReadonlyArray<AgentEvent>>([])
      // The receipt is stored, then its delivery breaks: the turn fails after
      // its completion is durable.
      const publisherLayer = Layer.succeed(
        EventStore,
        EventStore.of({
          subscribe: () => Stream.empty,
          removeSession: () => Effect.void,
          append: (event: AgentEvent) =>
            Effect.gen(function* () {
              yield* Ref.update(appended, (events) => [...events, event])
              return EventEnvelope.make({
                id: EventId.make(0),
                event,
                createdAt: yield* Clock.currentTimeMillis,
              })
            }),
          deliver: (envelope) => {
            if (envelope.event._tag === "TurnCompleted") return Effect.die("delivery broke")
            return Effect.void
          },
          publish: () => Effect.void,
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const message = makeMessage(
          SessionId.make("late-failure-session"),
          BranchId.make("late-failure-branch"),
          "hello",
        )
        yield* Effect.exit(runAgentLoop(agentLoop, message))
        const completions = (yield* Ref.get(appended)).filter(
          (event) => event._tag === "TurnCompleted",
        )
        expect(completions).toEqual([expect.objectContaining({ messageId: message.id })])
        expect(completions[0]).not.toHaveProperty("streamFailed", true)
      }).pipe(Effect.provide(makeLayerWithEventStore(providerLayer, publisherLayer)))
    }),
  )
  it.live("a waiting caller is not failed by an earlier turn's failure", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("foreign-failure-session")
      const branchId = BranchId.make("foreign-failure-branch")
      const first = makeMessage(sessionId, branchId, "first fails")
      const second = makeMessage(sessionId, branchId, "second waits")
      const firstStarted = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let streamCalls = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        streamCalls += 1
        const parts = Stream.fromIterable([
          textDeltaPart("ok"),
          finishPart({ finishReason: "stop" }),
        ])
        if (streamCalls > 1) return Effect.succeed(parts)
        return Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(firstStarted, void 0)
              yield* Deferred.await(gate)
            }),
          ).pipe(Stream.flatMap(() => parts)),
        )
      })
      const failFirstAssistant = Layer.succeed(
        EventStore,
        EventStore.of({
          subscribe: () => Stream.empty,
          removeSession: () => Effect.void,
          append: (event: AgentEvent) => {
            if (
              event._tag === "MessageReceived" &&
              event.message.id === assistantMessageIdForTurn(first.id, 1)
            ) {
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
        const firstFiber = yield* Effect.forkChild(Effect.exit(runAgentLoop(agentLoop, first)))
        yield* Deferred.await(firstStarted)
        const secondFiber = yield* Effect.forkChild(Effect.exit(runAgentLoop(agentLoop, second)))
        yield* waitForOption(
          () =>
            agentLoop
              .getQueue({ sessionId, branchId })
              .pipe(Effect.map(Option.liftPredicate((queue) => queue.followUp.length === 1))),
          "second message queued",
        )
        yield* Deferred.succeed(gate, void 0)
        const firstExit = yield* Fiber.join(firstFiber)
        const secondExit = yield* Fiber.join(secondFiber)
        expect(firstExit._tag).toBe("Failure")
        expect(secondExit._tag).toBe("Success")
        expect(streamCalls).toBe(2)
      }).pipe(
        Effect.timeout("4 seconds"),
        Effect.provide(makeLayerWithEventStore(providerLayer, failFirstAssistant)),
      )
    }),
  )
  it.live("a queue write that failed earlier does not fail a later waiting caller", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("stale-persistence-session")
      const branchId = BranchId.make("stale-persistence-branch")
      const failWrites = yield* Ref.make(false)
      const rows = yield* Ref.make<LoopQueueStateType>(emptyPersistedQueue())
      const queueStorageLayer = Layer.succeed(
        AgentLoopQueueStorage,
        AgentLoopQueueStorage.of({
          getQueueState: () => Ref.get(rows),
          putQueueState: (_s, _b, queue) =>
            Effect.gen(function* () {
              if (yield* Ref.get(failWrites)) {
                return yield* new StorageError({ message: "queue write failed once" })
              }
              yield* Ref.set(rows, queue)
            }),
        }),
      )
      const providerLayer = scriptedProvider([
        [textDeltaPart("answered"), finishPart({ finishReason: "stop" })],
      ])
      const layer = actorTestRoot({ provider: providerLayer, overrides: queueStorageLayer })
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        expect((yield* agentLoop.getState({ sessionId, branchId }))._tag).toBe("Idle")
        // One steering write fails while storage is down; the caller hears it.
        yield* Ref.set(failWrites, true)
        const steered = yield* Effect.exit(
          steerAgentLoop({
            _tag: "Interject",
            sessionId,
            branchId,
            requestId: "req-stale-persistence",
            message: "parked while storage is down",
          }),
        )
        expect(steered._tag).toBe("Failure")
        // Storage recovers. A turn submitted now owes nothing to that failure.
        yield* Ref.set(failWrites, false)
        const submitted = yield* Effect.exit(
          runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "after recovery")),
        )
        expect(submitted._tag).toBe("Success")
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.live("a queued turn that fails before it starts does not hold the queue", () =>
    Effect.gen(function* () {
      const sessionId = SessionId.make("unsaved-turn-session")
      const branchId = BranchId.make("unsaved-turn-branch")
      const first = makeMessage(sessionId, branchId, "first completes")
      const second = makeMessage(sessionId, branchId, "second is never saved")
      const third = makeMessage(sessionId, branchId, "third runs")
      const firstStarted = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let streamCalls = 0
      let secondAttempts = 0
      const providerLayer = LanguageModelLayers.testStream(() => {
        streamCalls += 1
        const parts = Stream.fromIterable([
          textDeltaPart("ok"),
          finishPart({ finishReason: "stop" }),
        ])
        if (streamCalls > 1) return Effect.succeed(parts)
        return Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(firstStarted, void 0)
              yield* Deferred.await(gate)
            }),
          ).pipe(Stream.flatMap(() => parts)),
        )
      })
      const failSecondUserMessage = Layer.succeed(
        EventStore,
        EventStore.of({
          subscribe: () => Stream.empty,
          removeSession: () => Effect.void,
          append: (event: AgentEvent) => {
            if (event._tag === "MessageReceived" && event.message.id === second.id) {
              secondAttempts += 1
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
        const firstFiber = yield* Effect.forkChild(Effect.exit(runAgentLoop(agentLoop, first)))
        yield* Deferred.await(firstStarted)
        const secondFiber = yield* Effect.forkChild(Effect.exit(runAgentLoop(agentLoop, second)))
        yield* waitForOption(
          () =>
            agentLoop
              .getQueue({ sessionId, branchId })
              .pipe(Effect.map(Option.liftPredicate((queue) => queue.followUp.length === 1))),
          "second message queued",
        )
        const thirdFiber = yield* Effect.forkChild(Effect.exit(runAgentLoop(agentLoop, third)))
        yield* waitForOption(
          () =>
            agentLoop
              .getQueue({ sessionId, branchId })
              .pipe(Effect.map(Option.liftPredicate((queue) => queue.followUp.length === 2))),
          "third message queued",
        )
        yield* Deferred.succeed(gate, void 0)
        expect((yield* Fiber.join(firstFiber))._tag).toBe("Success")
        expect((yield* Fiber.join(secondFiber))._tag).toBe("Failure")
        expect((yield* Fiber.join(thirdFiber))._tag).toBe("Success")
        // The failed admission runs once; it is not taken again.
        expect(secondAttempts).toBe(1)
        expect(streamCalls).toBe(2)
      }).pipe(
        Effect.timeout("4 seconds"),
        Effect.provide(makeLayerWithEventStore(providerLayer, failSecondUserMessage)),
      )
    }),
  )
  /** The last user message a model call answers. */
  it.live("rolls back turn duration when TurnCompleted append fails", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("committed before finalize"), finishPart({ finishReason: "stop" })],
      ])
      const failingPublisherLayer = Layer.succeed(
        EventStore,
        EventStore.of({
          subscribe: () => Stream.empty,
          removeSession: () => Effect.void,
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
      }).pipe(Effect.provide(makeLayerWithEventStore(providerLayer, failingPublisherLayer)))
    }),
  )
})

describe("queued follow-ups", () => {
  const lastUserPromptText = (prompt: Parameters<typeof Prompt.make>[0]): string => {
    const userTexts = Prompt.make(prompt).content.flatMap((message) => {
      if (message.role !== "user") return []
      return [
        message.content
          .flatMap((part) => {
            if (part.type !== "text") return []
            return [part.text]
          })
          .join(""),
      ]
    })
    return Option.getOrElse(Option.fromUndefinedOr(userTexts.at(-1)), () => "")
  }
  const openQueuedFollowUps = (params: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly aStarted: Deferred.Deferred<void>
    readonly gate: Deferred.Deferred<void>
    readonly streamCalls: () => number
    readonly promptTails: () => ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const { sessionId, branchId } = params
      const agentLoop = yield* makeAgentLoopService
      const messageStorage = yield* MessageStorage
      const x = makeMessage(sessionId, branchId, "x")
      const y = makeMessage(sessionId, branchId, "y")
      yield* submitAgentLoop(agentLoop, makeMessage(sessionId, branchId, "a"))
      yield* Deferred.await(params.aStarted)
      yield* submitAgentLoop(agentLoop, x)
      yield* submitAgentLoop(agentLoop, y)
      const settled = waitForOption(
        () =>
          Effect.gen(function* () {
            const state = yield* agentLoop.getState({ sessionId, branchId })
            const queue = yield* agentLoop.getQueue({ sessionId, branchId })
            return Option.some(true).pipe(
              Option.filter(
                () =>
                  state._tag === "Idle" &&
                  queue.followUp.length === 0 &&
                  queue.steering.length === 0,
              ),
            )
          }),
        "loop idle with an empty queue",
      )
      return {
        agentLoop,
        sessionId,
        branchId,
        x,
        y,
        release: Deferred.succeed(params.gate, void 0).pipe(Effect.asVoid),
        streamCalls: params.streamCalls,
        promptTails: params.promptTails,
        settled: settled.pipe(Effect.asVoid),
        followUpContents: agentLoop
          .getQueue({ sessionId, branchId })
          .pipe(Effect.map((queue) => queue.followUp.map((entry) => entry.content))),
        userRows: messageStorage
          .listMessages(branchId)
          .pipe(Effect.map((messages) => messages.filter((message) => message.role === "user"))),
      }
    })
  type QueuedFollowUps = Effect.Success<ReturnType<typeof openQueuedFollowUps>>

  /**
   * Each queued follow-up keeps its own id, its own parts, and its own turn.
   * These tests queue two plain follow-ups behind a held turn, then act on
   * the second one by id: retry, cancel, remove, re-submit.
   */
  const queuedFollowUpScenario = <A, E, R>(
    label: string,
    body: (context: QueuedFollowUps) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const aStarted = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let streamCalls = 0
      // The last user message each model call answers.
      const promptTails: Array<string> = []
      const providerLayer = LanguageModelLayers.testStream((options) => {
        streamCalls += 1
        promptTails.push(lastUserPromptText(options.prompt))
        const parts = Stream.fromIterable([
          textDeltaPart("ok"),
          finishPart({ finishReason: "stop" }),
        ])
        if (streamCalls > 1) return Effect.succeed(parts)
        return Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(aStarted, void 0)
              yield* Deferred.await(gate)
            }),
          ).pipe(Stream.flatMap(() => parts)),
        )
      })
      return yield* openQueuedFollowUps({
        sessionId: SessionId.make(`queued-${label}-session`),
        branchId: BranchId.make(`queued-${label}-branch`),
        aStarted,
        gate,
        streamCalls: () => streamCalls,
        promptTails: () => promptTails,
      }).pipe(
        Effect.flatMap(body),
        Effect.timeout("4 seconds"),
        Effect.provide(makeLayer(providerLayer)),
      )
    })

  const userTexts = (rows: ReadonlyArray<Message>) => rows.map((row) => messagePartsText(row.parts))

  it.live("queued follow-ups run one turn each, in order", () =>
    queuedFollowUpScenario("order", (context) =>
      Effect.gen(function* () {
        expect(yield* context.followUpContents).toEqual(["x", "y"])
        yield* context.release
        yield* context.settled
        expect(userTexts(yield* context.userRows)).toEqual(["a", "x", "y"])
        expect(context.promptTails()).toEqual(["a", "x", "y"])
      }),
    ),
  )

  it.live("a retried follow-up keeps every queued message once", () =>
    queuedFollowUpScenario("retry", (context) =>
      Effect.gen(function* () {
        yield* submitAgentLoop(context.agentLoop, context.y)
        expect(yield* context.followUpContents).toEqual(["x", "y"])
        yield* submitAgentLoop(context.agentLoop, context.x)
        expect(yield* context.followUpContents).toEqual(["x", "y"])
        yield* context.release
        yield* context.settled
        expect(userTexts(yield* context.userRows)).toEqual(["a", "x", "y"])
        expect(context.promptTails()).toEqual(["a", "x", "y"])
      }),
    ),
  )

  it.live("a cancel aimed at a queued follow-up stops that follow-up only", () =>
    queuedFollowUpScenario("cancel", (context) =>
      Effect.gen(function* () {
        yield* steerAgentLoop({
          _tag: "Cancel",
          sessionId: context.sessionId,
          branchId: context.branchId,
          requestId: "req-cancel-queued-y",
          messageId: context.y.id,
        })
        yield* context.release
        yield* context.settled
        // The cancelled follow-up never reaches the model; its neighbour does.
        expect(context.promptTails()).toEqual(["a", "x"])
      }),
    ),
  )

  it.live("removing a queued follow-up by id drops it and keeps its neighbour", () =>
    queuedFollowUpScenario("remove", (context) =>
      Effect.gen(function* () {
        const actorClientFactory = yield* AgentLoopActor.Context
        const ref = yield* actorClientFactory(
          entityIdOf(DefaultWorkspaceId, context.sessionId, context.branchId),
        )
        const removed = yield* ref.execute(
          AgentLoopActor.RemoveFollowUp.make({
            workspaceId: DefaultWorkspaceId,
            sessionId: context.sessionId,
            branchId: context.branchId,
            commandId: ActorCommandId.make("remove-queued-y"),
            messageId: context.y.id,
          }),
        )
        expect(removed).toBe(true)
        expect(yield* context.followUpContents).toEqual(["x"])
        yield* context.release
        yield* context.settled
        expect(userTexts(yield* context.userRows)).toEqual(["a", "x"])
      }),
    ),
  )

  it.live("a follow-up whose turn completed does not run again when re-submitted", () =>
    queuedFollowUpScenario("resubmit", (context) =>
      Effect.gen(function* () {
        yield* context.release
        yield* context.settled
        const callsBefore = context.streamCalls()
        const yRow = (yield* context.userRows).find((row) => row.id === context.y.id)
        expect(yRow?.turnDurationMs).toBeDefined()
        yield* runAgentLoop(context.agentLoop, context.y)
        expect(context.streamCalls()).toBe(callsBefore)
        expect(userTexts(yield* context.userRows)).toEqual(["a", "x", "y"])
      }),
    ),
  )

  it.live(
    "queued follow-ups survive a restart during the turn before them, in order",
    () =>
      Effect.gen(function* () {
        const sessionId = SessionId.make("queued-restart-session")
        const branchId = BranchId.make("queued-restart-branch")
        const a = makeMessage(sessionId, branchId, "a")
        const x = makeMessage(sessionId, branchId, "x")
        const y = makeMessage(sessionId, branchId, "y")
        const z = makeMessage(sessionId, branchId, "z")
        const aStarted = yield* Deferred.make<void>()
        const aGate = yield* Deferred.make<void>()
        const xStarted = yield* Deferred.make<void>()
        const parts = () =>
          Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })])
        let firstProcessCalls = 0
        // The first process holds "a" behind a gate, then dies inside the next turn.
        const held = (started: Deferred.Deferred<void>, hold: Effect.Effect<void>) =>
          Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(started, void 0)
                yield* hold
              }),
            ).pipe(Stream.flatMap(parts)),
          )
        const firstProvider = LanguageModelLayers.testStream(() => {
          firstProcessCalls += 1
          if (firstProcessCalls === 1) return held(aStarted, Deferred.await(aGate))
          return held(xStarted, Effect.never)
        })
        // The last user message each call of the second process answers.
        const secondPromptTails: Array<string> = []
        const secondProvider = LanguageModelLayers.testStream((options) => {
          secondPromptTails.push(lastUserPromptText(options.prompt))
          return Effect.succeed(parts())
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            // One database outlives both processes.
            const storage = yield* Layer.build(
              testSqliteStorage(noBranchTools.storage, noBranchTools.migrations),
            )
            const processLayer = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
              actorTestRoot({ provider: providerLayer, storage: Layer.succeedContext(storage) })
            yield* Effect.scoped(
              Effect.gen(function* () {
                const agentLoop = yield* makeAgentLoopService
                yield* submitAgentLoop(agentLoop, a)
                yield* Deferred.await(aStarted)
                yield* submitAgentLoop(agentLoop, x)
                yield* submitAgentLoop(agentLoop, y)
                yield* submitAgentLoop(agentLoop, z)
                yield* Deferred.succeed(aGate, void 0)
                yield* Deferred.await(xStarted)
              }).pipe(Effect.provide(processLayer(firstProvider))),
            )
            yield* Effect.gen(function* () {
              const agentLoop = yield* makeAgentLoopService
              const messageStorage = yield* MessageStorage
              // The first command wakes the loop; recovery reads the stored queue.
              yield* agentLoop.getState({ sessionId, branchId })
              const zRow = yield* waitForOption(
                () =>
                  messageStorage
                    .getMessage(z.id)
                    .pipe(
                      Effect.map((row) =>
                        Option.filter(Option.fromUndefinedOr(row), (stored) =>
                          Predicate.isNotUndefined(stored.turnDurationMs),
                        ),
                      ),
                    ),
                "the last queued follow-up answered after the restart",
              )
              expect(messagePartsText(zRow.parts)).toBe("z")
              yield* waitForPhase(agentLoop, { sessionId, branchId }, "Idle")
              // Each waiting follow-up ran its own turn, in submission order.
              expect(secondPromptTails).toEqual(["y", "z"])
              const texts = userTexts(
                (yield* messageStorage.listMessages(branchId)).filter((row) => row.role === "user"),
              )
              expect(texts).toEqual(["a", "x", "y", "z"])
            }).pipe(Effect.provide(processLayer(secondProvider)))
          }).pipe(Effect.timeout("8 seconds")),
        )
      }),
    15_000,
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
          })
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
            expect.objectContaining({ _tag: "FollowUp", content: "queued a" }),
            expect.objectContaining({ _tag: "FollowUp", content: "queued b" }),
          ])
          const secondSnapshot = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(secondSnapshot).toEqual(snapshot)
          yield* Deferred.succeed(gate, void 0)
          yield* Fiber.join(fiber)
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
                yield* Deferred.succeed(firstStarted, void 0)
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
          yield* Deferred.succeed(gate, void 0)
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
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
})

describe("provider retry in a turn", () => {
  it.live("a cancel during a retry wait ends the turn without waiting out the delay", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const sessionId = SessionId.make("retry-cancel-session")
      const branchId = BranchId.make("retry-cancel-branch")
      let streamCalls = 0
      // The provider asks for a long wait before the next attempt.
      const rateLimited = AiError.make({
        module: "Test",
        method: "streamText",
        reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(20) }),
      })
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.sync(() => {
          streamCalls += 1
          if (streamCalls === 1) return Stream.fail(rateLimited)
          return Stream.fromIterable([
            textDeltaPart("never after cancel"),
            finishPart({ finishReason: "stop" }),
          ])
        }),
      )
      yield* Effect.gen(function* () {
        const agentLoop = yield* makeAgentLoopService
        const message = makeMessage(sessionId, branchId, "wait for the rate limit")
        const turn = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
        yield* waitForOption(
          () =>
            Ref.get(eventsRef).pipe(
              Effect.map((events) =>
                Option.liftPredicate(events, (all) =>
                  all.some((event) => event._tag === "ProviderRetrying"),
                ),
              ),
            ),
          "the retry wait began",
        )
        yield* steerAgentLoop({
          _tag: "Cancel",
          sessionId,
          branchId,
          requestId: "req-cancel-retry-wait",
        })
        // The cancel reaches the wait: the turn ends well before 20 seconds.
        const ended = yield* Fiber.join(turn).pipe(Effect.timeoutOption("2 seconds"))
        expect(Option.isSome(ended)).toBe(true)
        expect(streamCalls).toBe(1)
        const completed = (yield* Ref.get(eventsRef)).find(
          (event) => event._tag === "TurnCompleted" && event.messageId === message.id,
        )
        expect(completed?._tag === "TurnCompleted" && completed.interrupted).toBe(true)
      }).pipe(
        Effect.timeout("6 seconds"),
        Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)),
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
        // The retry row names the provider's reason, not the SDK module and method.
        const retrying = events.find((event) => event._tag === "ProviderRetrying")
        expect(retrying?._tag === "ProviderRetrying" && retrying.error).toBe(
          retryableStreamError().reason.message,
        )
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "after retry" })])
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
        }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
      }),
  )
})

describe("provider stream parts", () => {
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
        // A stream failure may end the turn: it is not marked as a notice.
        expect(error).not.toHaveProperty("notice")
        const assistant = yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        expect(assistant?.parts).toEqual([Prompt.textPart({ text: "partial answer" })])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }),
  )
})

describe("a repeated durable send", () => {
  it.scopedLive(
    "opens the target's loop, so a turn the previous process left unfinished resumes",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-durable-repeat-")
        const dbPath = `${tempDir}/gent.db`
        const target = yield* Ref.make(Option.none<{ sessionId: SessionId; branchId: BranchId }>())
        // The sender repeats the same durable turn each time its own loop
        // opens, the way an extension re-sends work after a restart.
        const extension = defineExtension({
          id: "@gent/test-durable-repeat",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.on("loopOpen", () =>
              Effect.gen(function* () {
                const current = yield* Ref.get(target)
                if (Option.isNone(current)) return
                const ctx = yield* ExtensionContext
                if (ctx.sessionId === current.value.sessionId) return
                yield* ctx.Session.send({
                  delivery: "turn",
                  ...current.value,
                  content: "TARGET-TASK: answer",
                  commandId: ActorCommandId.make("durable-repeat-turn"),
                  completion: "admission",
                })
              }),
            )
          }),
        })
        const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [...e2ePreset.extensionInputs, extension],
            storagePath: dbPath,
          })
        const isTargetCall = (prompt: Prompt.RawInput) =>
          Prompt.make(prompt).content.some(
            (message) =>
              message.role === "user" &&
              message.content.some(
                (part) => part.type === "text" && part.text.includes("TARGET-TASK"),
              ),
          )

        // First process: the target's turn starts and hangs, then the process stops.
        const running = yield* Deferred.make<void>()
        const sender = yield* Effect.scoped(
          Effect.gen(function* () {
            const providerLayer = LanguageModelLayers.testStream((options) => {
              if (!isTargetCall(options.prompt)) return Effect.never
              return Deferred.succeed(running, void 0).pipe(Effect.andThen(Effect.never))
            })
            const { client } = yield* createRpcClient(layerFor(providerLayer))
            const created = yield* client.session.create({})
            yield* Ref.set(
              target,
              Option.some({ sessionId: created.sessionId, branchId: created.branchId }),
            )
            const opened = yield* client.session.create({})
            const senderTarget = { sessionId: opened.sessionId, branchId: opened.branchId }
            yield* client.session.getSnapshot(senderTarget)
            yield* Deferred.await(running)
            return senderTarget
          }),
        )
        const targetBranch = Option.getOrThrow(yield* Ref.get(target))

        // Second process: only the sender opens. Its repeat is answered from
        // the stored reply, and the target's turn still resumes.
        const targetCalls = yield* Ref.make(0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const providerLayer = LanguageModelLayers.testStream((options) => {
              if (!isTargetCall(options.prompt)) return Effect.never
              return Ref.update(targetCalls, (n) => n + 1).pipe(
                Effect.as(
                  Stream.fromIterable([
                    textDeltaPart("resumed answer"),
                    finishPart({ finishReason: "stop" }),
                  ] satisfies LanguageModelStreamPart[]),
                ),
              )
            })
            const { client } = yield* createRpcClient(layerFor(providerLayer))
            yield* client.session.getSnapshot(sender)
            yield* waitFor(
              client.message.list({ branchId: targetBranch.branchId }),
              (messages) => hasAssistantText(messages, "resumed answer"),
              5_000,
              "the target's unfinished turn resumed",
            )
            const messages = yield* client.message.list({ branchId: targetBranch.branchId })
            expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
            expect(yield* Ref.get(targetCalls)).toBe(1)
          }),
        )
      }).pipe(Effect.timeout("15 seconds")),
    20_000,
  )
})

// ── fixtures ────────────────────────────────────────────────────────────────

/** Scripted provider: returns stream parts from an array, one response per model stream call. */
const scriptedProvider = (
  responses: ReadonlyArray<ReadonlyArray<LanguageModelStreamPart>>,
): Layer.Layer<LanguageModel.LanguageModel> => {
  let index = 0
  return LanguageModelLayers.testStream(() =>
    Effect.succeed(
      Stream.fromIterable(responses[index++] ?? [finishPart({ finishReason: "stop" })]),
    ),
  )
}

const retryableStreamError = () =>
  AiError.make({
    module: "Test",
    method: "streamText",
    reason: new AiError.RateLimitError({
      retryAfter: Duration.zero,
    }),
  })

const makeLiveToolLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability> = [],
  resources: AnyResourceContribution[] = [],
  eventStoreLayer: Layer.Layer<EventStore> = EventStore.Memory,
) =>
  actorTestRoot({
    provider: providerLayer,
    registry: makeExtRegistry(tools, resources),
    eventStore: eventStoreLayer,
    toolRunner: ToolRunner.Live,
  })
