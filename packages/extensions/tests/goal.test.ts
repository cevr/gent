import { describe, expect, it, test } from "effect-bun-test"
import {
  Cause,
  Clock,
  ConfigProvider,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Ref,
  Schema,
  Stream,
  Struct,
} from "effect"
import {
  advanceUntil,
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textDeltaPart,
  textStep,
  toolCallPart,
  toolCallStep,
  waitFor,
  createRpcHarness,
  runToolWithCtx,
  testLeafContext,
  testToolContext,
} from "@gent/core/test-utils"
import {
  AgentName,
  BranchId,
  MessageId,
  SessionId,
  SteerCommand,
  ToolCallId,
  decodeRequestReply,
} from "@gent/core/protocol"
import {
  ExtensionContext,
  ExtensionServiceError,
  RequestId,
  type TurnAfterInput,
  WakeNext,
} from "@gent/core/extensions/api"
import { e2ePreset } from "./helpers/test-preset"
import {
  continuationPrompt,
  continueGoal,
  formatGoalUsage,
  GOAL_CONTEXT_MESSAGE_TYPE,
  GOAL_EXTENSION_ID,
  GOAL_PAUSED_RESUME_MISSED,
  GOAL_PAUSED_RESUME_UNSET,
  GOAL_PAUSED_UNQUEUED,
  GOAL_PAUSED_STREAM_FAILED,
  GOAL_PAUSED_USAGE_LIMIT,
  goalContinuationSource,
  goalResumeDue,
  GoalSnapshot,
  type GoalState,
  GoalTool,
} from "../src/goal.js"
import { BunServices } from "@effect/platform-bun"
import * as AiError from "effect/ai/AiError"
import { TestClock } from "effect/testing"

/**
 * `/goal` keeps a durable per-branch objective and re-prompts the loop after
 * each ordinary turn until the model marks the goal complete.
 */

type GoalHarness = Pick<
  Effect.Success<ReturnType<typeof createRpcHarness>>,
  "client" | "sessionId" | "branchId"
>

/** The branch's goal as `goal.get` answers it; none when the branch has none. */
const goalOn = ({ client, sessionId, branchId }: GoalHarness) =>
  client.extension
    .request({
      sessionId,
      branchId,
      extensionId: GOAL_EXTENSION_ID,
      capabilityId: "goal.get",
      input: {},
    })
    .pipe(
      Effect.flatMap(decodeRequestReply(GoalSnapshot)),
      Effect.map((snapshot) => Option.fromUndefinedOr(snapshot.goal)),
    )

const goalCommandOn = ({ client, sessionId, branchId }: GoalHarness, input: string) =>
  client.extension.request({
    sessionId,
    branchId,
    extensionId: GOAL_EXTENSION_ID,
    capabilityId: "goal-command",
    input,
  })

const sampleGoal: GoalState = {
  goalId: "g1",
  branchId: BranchId.make("b1"),
  objective: "Ship <it> & test",
  status: "active",
  tokensUsed: 40,
  timeUsedMs: 2_500,
  continuationsUsed: 2,
  createdAt: 0,
  updatedAt: 0,
}

describe("goals", () => {
  test("the continuation prompt escapes the objective and reports no limit", () => {
    const prompt = continuationPrompt(sampleGoal)
    expect(prompt).toContain("Ship &lt;it&gt; &amp; test")
    expect(prompt).not.toMatch(/budget|tokens/i)
    expect(formatGoalUsage(sampleGoal)).toBe("active · 2 continuations · 40 tokens · 3s")
  })

  it.live(
    "a goal continues after every turn until the model completes it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            textStep("first pass"),
            textStep("second pass"),
            toolCallStep(
              "goal",
              { action: "complete" },
              { toolCallId: ToolCallId.make("complete-1") },
            ),
            textStep("done"),
          ])
          const harness = yield* createRpcHarness({ ...e2ePreset, providerLayer })
          const { client, sessionId, branchId } = harness
          yield* goalCommandOn(harness, "Write the pelican poem")
          const completed = yield* waitFor(
            goalOn(harness),
            (goal) => Option.exists(goal, (value) => value.finalized === true),
            8_000,
            "the completing turn ends",
          )
          expect(Option.map(completed, (goal) => goal.status)).toEqual(Option.some("complete"))
          expect(Option.map(completed, (goal) => goal.continuationsUsed)).toEqual(Option.some(2))
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "the branch is idle",
          )
          // One continuation starts the goal and one follows each turn but the last.
          const goalMessages = snapshot.messages.filter(
            (message) => message.metadata?.customType === GOAL_CONTEXT_MESSAGE_TYPE,
          )
          expect(goalMessages.length).toBe(3)
          expect(new Set(goalMessages.map((message) => message.id)).size).toBe(3)
          expect(yield* controls.callCount).toBe(4)
          yield* controls.assertDone
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a pending goal refuses a new goal, and a status change names the state it refuses",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            { ...textStep("working"), gated: true },
          ])
          const harness = yield* createRpcHarness({ ...e2ePreset, providerLayer })
          const command = (input: string) => goalCommandOn(harness, input)
          yield* command("Write the pelican poem")
          yield* controls.waitForCall(0)
          const refused = yield* Effect.exit(command("Another objective"))
          expect(Exit.isFailure(refused)).toBe(true)
          if (Exit.isFailure(refused)) {
            expect(Cause.pretty(refused.cause)).toContain("A goal is already active")
          }
          const resumedActive = yield* Effect.exit(command("resume"))
          expect(Exit.isFailure(resumedActive)).toBe(true)
          if (Exit.isFailure(resumedActive)) {
            expect(Cause.pretty(resumedActive.cause)).toContain(
              "Cannot resume a goal that is active",
            )
          }
          yield* command("pause")
          const pausedTwice = yield* Effect.exit(command("pause"))
          expect(Exit.isFailure(pausedTwice)).toBe(true)
          if (Exit.isFailure(pausedTwice)) {
            expect(Cause.pretty(pausedTwice.cause)).toContain("Cannot pause a goal that is paused")
          }
          yield* controls.emitAll(0)
          yield* waitFor(
            harness.client.session.getSnapshot(harness),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "the paused goal's turn ends",
          )
          yield* controls.assertDone
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a turn end with no goal does not pulse the goal widget",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("one"),
            textStep("two"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          // The first turn's hook runs before the second turn ends.
          const events = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.map((envelope) => envelope.event),
            Stream.filter(
              (event) =>
                event._tag === "TurnCompleted" ||
                (event._tag === "ExtensionStateChanged" && event.extensionId === GOAL_EXTENSION_ID),
            ),
            Stream.takeUntil(
              (() => {
                let completed = 0
                return (event: { readonly _tag: string }) =>
                  event._tag === "TurnCompleted" && ++completed === 2
              })(),
            ),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* client.message.send({ sessionId, branchId, content: "first" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle" && current.messages.length === 2,
            5_000,
            "first turn idle",
          )
          yield* client.message.send({ sessionId, branchId, content: "second" })
          const seen = Array.from(yield* Fiber.join(events))
          expect(seen.filter((event) => event._tag === "ExtensionStateChanged")).toEqual([])
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "the goal reads while a turn runs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            { ...textStep("working"), gated: true },
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "work" })
          yield* controls.waitForCall(0)
          const snapshot = yield* client.extension
            .request({
              sessionId,
              branchId,
              extensionId: GOAL_EXTENSION_ID,
              capabilityId: "goal.get",
              input: {},
            })
            .pipe(
              Effect.timeoutOrElse({
                duration: "2 seconds",
                orElse: () => Effect.die(new Error("goal.get waited for the turn")),
              }),
            )
          expect(yield* decodeRequestReply(GoalSnapshot)(snapshot)).toEqual({})
          yield* controls.emitAll(0)
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle" && current.messages.length === 2,
            5_000,
            "the turn ended",
          )
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})

// ── goal store ──────────────────────────────────────────────────────────────

/**
 * Goal state lives in one file per branch. Writes replace the file atomically
 * and status changes pull the continuation that is still waiting in the queue.
 */

describe("goal store", () => {
  it.scopedLive("completing a goal pulls its queued continuation and leaves one clean file", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("goal-store-")
      const dequeued = yield* Ref.make<ReadonlyArray<string>>([])
      const branchId = BranchId.make("goal-branch")
      const ctx = testToolContext({
        sessionId: SessionId.make("goal-session"),
        branchId,
        toolCallId: ToolCallId.make("tc-goal"),
        home,
        Session: {
          ...testToolContext().Session,
          dequeueFollowUp: ({ sourceId }) =>
            Ref.update(dequeued, (all) => [...all, sourceId]).pipe(Effect.as(true)),
        },
        State: { changed: () => Effect.void },
      })
      const created = yield* runToolWithCtx(
        GoalTool,
        { action: "create", objective: "Write the pelican poem" },
        ctx,
      )
      expect(created.goal?.status).toBe("active")
      const completed = yield* runToolWithCtx(GoalTool, { action: "complete" }, ctx)
      expect(completed.goal?.status).toBe("complete")
      // Completion removes the continuation queued for the active state.
      expect(yield* Ref.get(dequeued)).toEqual([
        goalContinuationSource({ ...created.goal!, status: "active" }),
      ])
      // Only the final snapshot remains; staging files are renamed away.
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readDirectory(`${home}/.gent/goals`)).toEqual([`${branchId}.json`])
      const snapshot = yield* Schema.decodeEffect(Schema.fromJsonString(GoalSnapshot))(
        yield* fs.readFileString(`${home}/.gent/goals/${branchId}.json`),
      )
      expect(Option.fromUndefinedOr(snapshot.goal?.status)).toEqual(Option.some("complete"))
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("a file removed while it is being read reads as no goal", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("goal-store-vanished-")
      const fs = yield* FileSystem.FileSystem
      // An empty write removes the file after a check would have seen it: every
      // probe says the file is there, and the read finds nothing.
      const vanishing: FileSystem.FileSystem = { ...fs, exists: () => Effect.succeed(true) }
      const ctx = testToolContext({
        sessionId: SessionId.make("goal-session"),
        branchId: BranchId.make("goal-branch"),
        toolCallId: ToolCallId.make("tc-goal"),
        home,
        State: { changed: () => Effect.void },
      })
      const read = yield* runToolWithCtx(GoalTool, { action: "get" }, ctx).pipe(
        Effect.provideService(FileSystem.FileSystem, vanishing),
      )
      expect(read.goal).toBeUndefined()
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("a run with its own data directory keeps branch state there, not in home", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("goal-store-home-")
      const dataDir = yield* makeTempDirectoryScoped("goal-store-data-")
      const branchId = BranchId.make("goal-branch")
      const ctx = testToolContext({
        sessionId: SessionId.make("goal-session"),
        branchId,
        toolCallId: ToolCallId.make("tc-goal"),
        home,
        State: { changed: () => Effect.void },
      })
      yield* runToolWithCtx(
        GoalTool,
        { action: "create", objective: "Write the pelican poem" },
        ctx,
      ).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { GENT_DATA_DIR: dataDir } }),
        ),
      )
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readDirectory(`${dataDir}/goals`)).toEqual([`${branchId}.json`])
      expect(yield* fs.exists(`${home}/.gent`)).toBe(false)
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("a write the disk rejects mid-flight leaves no staging file behind", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("goal-store-enospc-")
      const branchId = BranchId.make("goal-branch")
      const fs = yield* FileSystem.FileSystem
      // The disk fills after the entry is created: the write creates the file, then reports ENOSPC.
      const filling: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (path) =>
          fs.writeFileString(path, "").pipe(
            Effect.andThen(
              Effect.fail(
                // oxlint-disable-next-line effect/preferTaggedConstructors -- `_tag` is the reason option systemError takes, not a tagged value
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "writeFileString",
                  pathOrDescriptor: path,
                  description: "ENOSPC: no space left on device",
                }),
              ),
            ),
          ),
      }
      const ctx = testToolContext({
        sessionId: SessionId.make("goal-session"),
        branchId,
        toolCallId: ToolCallId.make("tc-goal"),
        home,
        State: { changed: () => Effect.void },
      })
      const created = yield* runToolWithCtx(
        GoalTool,
        { action: "create", objective: "Write the pelican poem" },
        ctx,
      ).pipe(Effect.provideService(FileSystem.FileSystem, filling), Effect.exit)
      expect(Exit.isFailure(created)).toBe(true)
      // The failed write leaves nothing: no target, no staging sibling.
      expect(yield* fs.readDirectory(`${home}/.gent/goals`)).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)),
  )
})

// ── stream failure ──────────────────────────────────────────────────────────

/**
 * A goal is not driven on by a turn that never answered.
 *
 * `continueGoal` reads `streamFailed` from `turnAfter`: a turn that died on a
 * broken provider stream pauses the goal and queues no continuation prompt,
 * so no prompt wakes the branch for another turn against an answer that never
 * arrived.
 */

describe("goal stream failure", () => {
  it.scopedLive(
    "a goal pauses when the stream keeps breaking, and queues nothing more",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        // Writes something, then breaks, on every call. The driver retries a
        // break before any output; the loop spends its two continuations on a
        // break after partial output. The third failure ends the turn.
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
            return Stream.concat(
              Stream.fromIterable([textDeltaPart(`part ${call}`)]),
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
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        const readGoal = () => goalOn({ client, sessionId, branchId })

        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: GOAL_EXTENSION_ID,
          capabilityId: "goal-command",
          input: "Write the pelican poem",
        })
        // The command queued the first turn, which can fail and pause the
        // goal before this read: the goal exists, active or already paused.
        const created = yield* readGoal()
        expect(Option.isSome(created)).toBe(true)

        const paused = yield* waitFor(
          readGoal(),
          (goal) =>
            Option.contains(
              Option.map(goal, (value) => value.status),
              "paused",
            ),
          10_000,
          "goal pauses on the stream failure",
        )
        expect(Option.map(paused, (goal) => goal.continuationsUsed)).toEqual(Option.some(0))
        expect(Option.map(paused, (goal) => goal.pausedReason)).toEqual(
          Option.some(GOAL_PAUSED_STREAM_FAILED),
        )
        // The failed turn still spent its time; it is charged like any other turn end.
        expect(Option.exists(paused, (goal) => goal.timeUsedMs > 0)).toBe(true)

        // Creating the goal queues the first continuation, which starts the turn
        // that then fails. The failed turn must not queue a second one: that is
        // the prompt that would wake the branch and spend the goal again. The
        // goal pauses before the turn ends, so the check waits for Idle first.
        const snapshot = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) => current.runtime._tag === "Idle",
          5_000,
          "the failed turn ended",
        )
        expect(snapshot.runtime._tag).toBe("Idle")
        const goalMessages = snapshot.messages.filter(
          (message) => message.metadata?.customType === GOAL_CONTEXT_MESSAGE_TYPE,
        )
        expect(goalMessages.length).toBe(1)
        // Two continuations inside the one turn, then the failure. No fourth call.
        expect(yield* Ref.get(calls)).toBe(3)
      }).pipe(Effect.timeout("14 seconds")),
    18_000,
  )

  it.scopedLive(
    "a failed turn charges the tokens its steps reported before the break",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        // Step one reports usage and is cut off, so the loop continues the
        // turn; every later step breaks after partial output.
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
            if (call === 1) {
              return Stream.fromIterable([
                textDeltaPart("part one"),
                finishPart({
                  finishReason: "length",
                  usage: { inputTokens: 30, outputTokens: 12 },
                }),
              ])
            }
            return Stream.concat(
              Stream.fromIterable([textDeltaPart(`part ${call}`)]),
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
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        yield* goalCommandOn({ client, sessionId, branchId }, "Write the pelican poem")
        const paused = yield* waitFor(
          goalOn({ client, sessionId, branchId }),
          (goal) => Option.exists(goal, (value) => value.status === "paused"),
          10_000,
          "the failed turn pauses the goal",
        )
        expect(Option.map(paused, (goal) => goal.pausedReason)).toEqual(
          Option.some(GOAL_PAUSED_STREAM_FAILED),
        )
        expect(Option.map(paused, (goal) => goal.tokensUsed)).toEqual(Option.some(42))
      }).pipe(Effect.timeout("14 seconds")),
    18_000,
  )
})

// ── usage limit ─────────────────────────────────────────────────────────────

/** A model step that stops on a usage limit: it resets in a minute, past every retry cap. */
const usageLimitStream = () =>
  Stream.fail(
    AiError.make({
      module: "Test",
      method: "streamText",
      reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(60) }),
    }),
  )

/** The first model call hits the usage limit; each later call takes the next step of `after`. */
const limitedModel = (after: ReadonlyArray<ScriptedStepLike>, calls: Ref.Ref<number>) =>
  LanguageModelLayers.testStream(() =>
    Ref.getAndUpdate(calls, (count) => count + 1).pipe(
      Effect.map((count) => {
        if (count === 0) return usageLimitStream()
        const step = after[Math.min(count - 1, after.length - 1)] ?? textStep("done")
        return Stream.fromIterable(step.parts)
      }),
    ),
  )

type ScriptedStepLike = ReturnType<typeof textStep>

const isPaused = (goal: Option.Option<GoalState>) =>
  Option.exists(goal, (value) => value.status === "paused")

/** Moves the virtual clock to `at` in one-second steps, so each timer due on the way fires. */
const advanceTo = (at: number) =>
  advanceUntil(Clock.currentTimeMillis, (time) => time >= at, {
    label: `the clock reaches ${at}`,
    step: "1 second",
    timeoutMs: 10_000,
  })

describe("goal usage limit", () => {
  it.live(
    "a usage limit pauses the goal until the reset, then the goal resumes on its own",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const providerLayer = limitedModel(
          [toolCallStep("goal", { action: "complete" }), textStep("The poem is done.")],
          calls,
        )
        const harness = yield* createRpcHarness({ ...e2ePreset, providerLayer })
        yield* goalCommandOn(harness, "Write the pelican poem")
        // The virtual clock starts at 0: the limit resets at 60 s, the goal resumes 30 s later.
        const paused = yield* advanceUntil(goalOn(harness), isPaused, {
          label: "the usage limit pauses the goal",
          step: "0 millis",
        })
        expect(
          Option.map(paused, (goal) => ({
            pausedReason: goal.pausedReason,
            resumeAt: goal.resumeAt,
            continuationsUsed: goal.continuationsUsed,
          })),
        ).toEqual(
          Option.some({
            pausedReason: GOAL_PAUSED_USAGE_LIMIT,
            resumeAt: 90_000,
            continuationsUsed: 0,
          }),
        )
        expect(Option.map(paused, formatGoalUsage)).toEqual(
          Option.some(
            `paused: ${GOAL_PAUSED_USAGE_LIMIT}; resumes at 1970-01-01T00:01:30.000Z · 0 continuations · 0 tokens · 0s`,
          ),
        )
        // Nothing runs before the resume time.
        yield* advanceTo(85_000)
        expect(yield* Ref.get(calls)).toBe(1)
        expect((yield* goalOn(harness)).pipe(isPaused)).toBe(true)

        const completed = yield* advanceUntil(
          goalOn(harness),
          (goal) => Option.exists(goal, (value) => value.finalized === true),
          { label: "the resumed goal completes", step: "1 second", timeoutMs: 10_000 },
        )
        expect(Option.map(completed, (goal) => goal.status)).toEqual(Option.some("complete"))
        expect(Option.map(completed, (goal) => goal.continuationsUsed)).toEqual(Option.some(1))
        expect(yield* Ref.get(calls)).toBe(3)
        const snapshot = yield* harness.client.session.getSnapshot({
          sessionId: harness.sessionId,
          branchId: harness.branchId,
        })
        const goalMessages = snapshot.messages.filter(
          (message) => message.metadata?.customType === GOAL_CONTEXT_MESSAGE_TYPE,
        )
        expect(goalMessages.length).toBe(2)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("25 seconds")),
    30_000,
  )

  it.live(
    "a goal paused while it waits on a usage limit stays paused past the reset",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const providerLayer = limitedModel([textStep("Still writing.")], calls)
        const harness = yield* createRpcHarness({ ...e2ePreset, providerLayer })
        yield* goalCommandOn(harness, "Write the pelican poem")
        yield* advanceUntil(goalOn(harness), isPaused, {
          label: "the usage limit pauses the goal",
          step: "0 millis",
        })
        yield* goalCommandOn(harness, "pause")
        const held = yield* goalOn(harness)
        expect(Option.map(held, (goal) => goal.status)).toEqual(Option.some("paused"))
        expect(Option.flatMap(held, (goal) => Option.fromUndefinedOr(goal.resumeAt))).toEqual(
          Option.none(),
        )
        yield* advanceTo(120_000)
        expect(yield* Ref.get(calls)).toBe(1)
        expect((yield* goalOn(harness)).pipe(isPaused)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("25 seconds")),
    30_000,
  )
})

describe("goal resume fire", () => {
  const branchId = BranchId.make("goal-branch")
  const waiting: GoalState = {
    goalId: "g1",
    branchId,
    objective: "Write the pelican poem",
    status: "paused",
    pausedReason: GOAL_PAUSED_USAGE_LIMIT,
    resumeAt: 90_000,
    tokensUsed: 0,
    timeUsedMs: 0,
    continuationsUsed: 0,
    createdAt: 0,
    updatedAt: 0,
  }
  const active: GoalState = {
    ...Struct.omit(waiting, ["pausedReason", "resumeAt"]),
    status: "active",
  }

  const refused = (operation: string) =>
    new ExtensionServiceError({ service: "Session", operation, message: `${operation} refused` })

  /**
   * A branch whose stored goal is `goal`, over a stub context: `send` and
   * `wakeAt` fail while their refusal count lasts. Runs `hook` on the virtual
   * clock set to `at`; returns its answer, the stored goal after and the
   * accepted sends and wakes.
   */
  const onBranch = <A, E, R>(
    goal: GoalState,
    at: number,
    hook: Effect.Effect<A, E, R>,
    refuse: { readonly sends?: number; readonly wakes?: number } = {},
  ) =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("goal-resume-")
      const fs = yield* FileSystem.FileSystem
      const file = `${home}/.gent/goals/${branchId}.json`
      yield* fs.makeDirectory(`${home}/.gent/goals`, { recursive: true })
      yield* fs.writeFileString(
        file,
        yield* Schema.encodeEffect(Schema.fromJsonString(GoalSnapshot))({ goal }),
      )
      const sends = yield* Ref.make(0)
      const wakes = yield* Ref.make<ReadonlyArray<number>>([])
      const sendRefusals = yield* Ref.make(refuse.sends ?? 0)
      const wakeRefusals = yield* Ref.make(refuse.wakes ?? 0)
      /** Fails while `left` is above 0, counting it down; otherwise runs `accept`. */
      const gated = (left: Ref.Ref<number>, operation: string, accept: Effect.Effect<void>) =>
        Effect.gen(function* () {
          if ((yield* Ref.getAndUpdate(left, (n) => Math.max(0, n - 1))) > 0)
            return yield* refused(operation)
          yield* accept
        })
      const base = testToolContext()
      const ctx = testToolContext({
        sessionId: SessionId.make("goal-session"),
        branchId,
        toolCallId: ToolCallId.make("tc-goal"),
        home,
        Session: {
          ...base.Session,
          dequeueFollowUp: () => Effect.succeed(false),
          send: () =>
            gated(
              sendRefusals,
              "send",
              Ref.update(sends, (count) => count + 1),
            ),
        },
        Wakes: (extensionId) => ({
          ...base.Wakes(extensionId),
          wakeAt: (params) =>
            gated(
              wakeRefusals,
              "wakeAt",
              Ref.update(wakes, (all) => [
                ...all,
                ...Option.toArray(Option.fromUndefinedOr(params.at)),
              ]),
            ),
        }),
        State: { changed: () => Effect.void },
      })
      yield* TestClock.setTime(at)
      const answer = yield* hook.pipe(Effect.provideService(ExtensionContext, testLeafContext(ctx)))
      const snapshot = yield* Schema.decodeEffect(Schema.fromJsonString(GoalSnapshot))(
        yield* fs.readFileString(file),
      )
      return {
        answer,
        goal: snapshot.goal,
        sends: yield* Ref.get(sends),
        wakes: yield* Ref.get(wakes),
      }
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, TestClock.layer())))

  const fire = (sourceId: string, cause: "due" | "start") =>
    goalResumeDue({ sourceId, at: Option.some(90_000), cause })

  it.scopedLive("a fire from the startup pass within ten minutes resumes the goal", () =>
    Effect.gen(function* () {
      const { answer, goal, sends } = yield* onBranch(
        waiting,
        90_000 + 60_000,
        fire("goal-resume:g1", "start"),
      )
      expect(answer).toEqual(WakeNext.cases.Done.make({}))
      expect(goal?.status).toBe("active")
      expect(goal?.resumeAt).toBeUndefined()
      expect(goal?.continuationsUsed).toBe(1)
      expect(sends).toBe(1)
    }),
  )

  it.scopedLive("a fire over ten minutes late leaves the goal paused and says why", () =>
    Effect.gen(function* () {
      const { answer, goal, sends } = yield* onBranch(
        waiting,
        90_000 + 10 * 60_000 + 1,
        fire("goal-resume:g1", "due"),
      )
      expect(answer).toEqual(WakeNext.cases.Done.make({}))
      expect(goal?.status).toBe("paused")
      expect(goal?.pausedReason).toBe(GOAL_PAUSED_RESUME_MISSED)
      expect(goal?.resumeAt).toBeUndefined()
      expect(sends).toBe(0)
    }),
  )

  it.scopedLive("a fire before the resume time waits for it and changes nothing", () =>
    Effect.gen(function* () {
      // Core picked the record at its old time; a later limit moved the goal's resume to 90 s.
      const { answer, goal, sends } = yield* onBranch(
        waiting,
        60_000,
        fire("goal-resume:g1", "due"),
      )
      expect(answer).toEqual(WakeNext.cases.At.make({ at: 90_000 }))
      expect(goal).toEqual(waiting)
      expect(sends).toBe(0)
    }),
  )

  it.scopedLive(
    "a refused continuation fails the fire and leaves the goal waiting for the retry",
    () =>
      Effect.gen(function* () {
        const hook = Effect.gen(function* () {
          const first = yield* Effect.exit(fire("goal-resume:g1", "due"))
          // Core keeps a failed fire's record and fires it again after a backoff.
          // The retry sends only if the failed fire left the goal waiting.
          const retry = yield* fire("goal-resume:g1", "due")
          return { firstFailed: Exit.isFailure(first), retry }
        })
        const { answer, goal, sends } = yield* onBranch(waiting, 90_000, hook, { sends: 1 })
        expect(answer).toEqual({ firstFailed: true, retry: WakeNext.cases.Done.make({}) })
        expect(goal?.status).toBe("active")
        expect(goal?.continuationsUsed).toBe(1)
        expect(sends).toBe(1)
      }),
  )

  it.scopedLive("a fire for a goal this branch no longer holds changes nothing", () =>
    Effect.gen(function* () {
      const { goal, sends } = yield* onBranch(waiting, 90_000, fire("goal-resume:g0", "due"))
      expect(goal).toEqual(waiting)
      expect(sends).toBe(0)
    }),
  )

  /** A turn that ended on a usage limit resetting at 60 s. */
  const limitedTurn: TurnAfterInput = {
    sessionId: SessionId.make("goal-session"),
    branchId,
    messageId: MessageId.make("goal-turn"),
    joinedMessageIds: new Set(),
    startedAtMs: 1_000,
    durationMs: 1_000,
    agentName: AgentName.make("main"),
    interrupted: false,
    streamFailed: true,
    retryAt: Option.some(60_000),
    unanswered: true,
    usage: {
      known: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: Option.none(),
      },
      complete: false,
    },
    readNotices: new Set(),
  }

  it.scopedLive("a usage limit sets the resume before the goal shows its time", () =>
    Effect.gen(function* () {
      const { goal, wakes, sends } = yield* onBranch(active, 2_000, continueGoal(limitedTurn))
      expect(wakes).toEqual([90_000])
      expect(goal?.resumeAt).toBe(90_000)
      expect(goal?.pausedReason).toBe(GOAL_PAUSED_USAGE_LIMIT)
      expect(sends).toBe(0)
    }),
  )

  it.scopedLive(
    "a resume that cannot be set leaves a pause that waits for /goal resume, with no time shown",
    () =>
      Effect.gen(function* () {
        const { goal, wakes, sends } = yield* onBranch(active, 2_000, continueGoal(limitedTurn), {
          wakes: 1,
        })
        expect(wakes).toEqual([])
        expect(goal?.status).toBe("paused")
        expect(goal?.resumeAt).toBeUndefined()
        expect(goal?.pausedReason).toBe(GOAL_PAUSED_RESUME_UNSET)
        expect(sends).toBe(0)
      }),
  )

  const answeredTurn: TurnAfterInput = {
    ...limitedTurn,
    streamFailed: false,
    retryAt: Option.none(),
    unanswered: false,
  }

  it.scopedLive("a turn end queues the next prompt and keeps the goal active", () =>
    Effect.gen(function* () {
      const { goal, sends } = yield* onBranch(active, 2_000, continueGoal(answeredTurn))
      expect(goal?.status).toBe("active")
      expect(goal?.continuationsUsed).toBe(1)
      expect(sends).toBe(1)
    }),
  )

  it.scopedLive(
    "a turn end whose next prompt is refused saves a pause that waits for /goal resume",
    () =>
      Effect.gen(function* () {
        const { goal, sends } = yield* onBranch(active, 2_000, continueGoal(answeredTurn), {
          sends: 1,
        })
        expect(sends).toBe(0)
        expect(goal?.status).toBe("paused")
        expect(goal?.pausedReason).toBe(GOAL_PAUSED_UNQUEUED)
        expect(goal?.continuationsUsed).toBe(1)
      }),
  )
})

describe("goal phase failure", () => {
  it.scopedLive(
    "a goal pauses when its turn fails outside the model stream",
    () =>
      Effect.gen(function* () {
        // A defect in the stream is not a broken stream the loop retries: the
        // turn phase fails, and the turn ends on its failed receipt.
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.succeed(Stream.die("stream defect")),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        const readGoal = () => goalOn({ client, sessionId, branchId })

        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: GOAL_EXTENSION_ID,
          capabilityId: "goal-command",
          input: "Write the pelican poem",
        })
        const paused = yield* waitFor(
          readGoal(),
          (goal) =>
            Option.contains(
              Option.map(goal, (value) => value.status),
              "paused",
            ),
          10_000,
          "goal pauses on the failed turn",
        )
        expect(Option.map(paused, (goal) => goal.pausedReason)).toEqual(
          Option.some(GOAL_PAUSED_STREAM_FAILED),
        )
      }).pipe(Effect.timeout("14 seconds")),
    18_000,
  )
})

// ── partial usage ───────────────────────────────────────────────────────────

/**
 * A turn whose usage is partly unknown still spent its known tokens. The
 * goal is charged the steps that reported usage and continues: usage is a
 * report, not a limit.
 */

describe("goal partial usage", () => {
  it.scopedLive(
    "a turn with one step of unknown usage charges the known steps and continues the goal",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const continuing = yield* Deferred.make<void>()
        // Step one reports usage and is cut off at the output limit, so the
        // loop continues the turn. Step two answers and reports no usage. The
        // continuation the goal queues stays open.
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
            if (call === 1) {
              return Stream.fromIterable([
                textDeltaPart("part one"),
                finishPart({
                  finishReason: "length",
                  usage: { inputTokens: 30, outputTokens: 12 },
                }),
              ])
            }
            if (call === 2) {
              return Stream.fromIterable([
                textDeltaPart("the answer"),
                finishPart({ finishReason: "stop" }),
              ])
            }
            yield* Deferred.succeed(continuing, void 0)
            return Stream.never
          }),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: GOAL_EXTENSION_ID,
          capabilityId: "goal-command",
          input: "Write the pelican poem",
        })
        yield* Deferred.await(continuing)
        const goal = Option.getOrThrow(yield* goalOn({ client, sessionId, branchId }))
        expect(goal.status).toBe("active")
        expect(goal.tokensUsed).toBe(42)
        expect(goal.continuationsUsed).toBe(1)
        expect(goal.pausedReason).toBeUndefined()
      }).pipe(Effect.timeout("14 seconds")),
    18_000,
  )
})

// ── interrupted turn ────────────────────────────────────────────────────────

/**
 * Every turn end is charged. An interrupted turn is charged its known tokens
 * and its time, and a completing turn that the person interrupts still
 * finalizes the goal, so the next unrelated turn is not charged to it.
 */

const stalledAfter = (opened: Deferred.Deferred<void>) =>
  Stream.make(textDeltaPart("working")).pipe(
    Stream.concat(Stream.fromEffect(Deferred.succeed(opened, void 0)).pipe(Stream.drain)),
    Stream.concat(Stream.never),
  )

type StepPart =
  | ReturnType<typeof textDeltaPart>
  | ReturnType<typeof finishPart>
  | ReturnType<typeof toolCallPart>

const interruptedGoalHarness = (firstStep: ReadonlyArray<StepPart>) =>
  Effect.gen(function* () {
    const stalled = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    const providerLayer = LanguageModelLayers.testStream(() =>
      Ref.updateAndGet(calls, (n) => n + 1).pipe(
        Effect.map((call) => {
          if (call === 1) return Stream.fromIterable<StepPart>(firstStep)
          return stalledAfter(stalled)
        }),
      ),
    )
    const harness = yield* createRpcHarness({ ...e2ePreset, providerLayer })
    const { client, sessionId, branchId } = harness
    const readGoal = () => goalOn({ client, sessionId, branchId })
    yield* client.extension.request({
      sessionId,
      branchId,
      extensionId: GOAL_EXTENSION_ID,
      capabilityId: "goal-command",
      input: "Write the pelican poem",
    })
    yield* Deferred.await(stalled)
    yield* client.steer.command({
      command: SteerCommand.cases.Cancel.make({
        sessionId,
        branchId,
        requestId: RequestId.make("interrupt-goal-turn"),
      }),
    })
    yield* waitFor(
      client.session.getSnapshot({ sessionId, branchId }),
      (current) => current.runtime._tag === "Idle",
      5_000,
      "the interrupted turn ended",
    )
    return { ...harness, readGoal, calls }
  })

describe("goal interrupted turn", () => {
  it.scopedLive(
    "an interrupted turn charges its known tokens and queues nothing more",
    () =>
      Effect.gen(function* () {
        const { client, sessionId, branchId, readGoal, calls } = yield* interruptedGoalHarness([
          textDeltaPart("part one"),
          finishPart({ finishReason: "length", usage: { inputTokens: 30, outputTokens: 12 } }),
        ])
        const charged = yield* waitFor(
          readGoal(),
          (goal) =>
            Option.contains(
              Option.map(goal, (value) => value.tokensUsed),
              42,
            ),
          5_000,
          "the interrupted turn is charged",
        )
        // Stopping work pauses the durable goal until an explicit resume.
        expect(Option.map(charged, (goal) => goal.status)).toEqual(Option.some("paused"))
        expect(Option.map(charged, (goal) => goal.continuationsUsed)).toEqual(Option.some(0))
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        const goalMessages = snapshot.messages.filter(
          (message) => message.metadata?.customType === GOAL_CONTEXT_MESSAGE_TYPE,
        )
        expect(goalMessages.length).toBe(1)
        expect(yield* Ref.get(calls)).toBe(2)
      }).pipe(Effect.timeout("10 seconds")),
    12_000,
  )

  it.scopedLive(
    "a completing turn that is interrupted still finalizes the goal",
    () =>
      Effect.gen(function* () {
        const { readGoal } = yield* interruptedGoalHarness([
          toolCallPart(
            "goal",
            { action: "complete" },
            { toolCallId: ToolCallId.make("complete-1") },
          ),
          finishPart({
            finishReason: "tool-calls",
            usage: { inputTokens: 30, outputTokens: 12 },
          }),
        ])
        const finalized = yield* waitFor(
          readGoal(),
          (goal) => Option.exists(goal, (value) => value.finalized === true),
          5_000,
          "the completed goal is finalized",
        )
        expect(Option.map(finalized, (goal) => goal.status)).toEqual(Option.some("complete"))
        expect(Option.map(finalized, (goal) => goal.tokensUsed)).toEqual(Option.some(42))
      }).pipe(Effect.timeout("10 seconds")),
    12_000,
  )
})

describe("goal stop commands", () => {
  for (const verb of ["clear", "cancel", "stop"]) {
    it.scopedLive(
      `${verb} removes the goal and cannot be resumed`,
      () =>
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            { ...textStep("working"), gated: true },
          ])
          const harness = yield* createRpcHarness({ ...e2ePreset, providerLayer })
          yield* goalCommandOn(harness, "Write the pelican poem")
          yield* controls.waitForCall(0)
          yield* goalCommandOn(harness, verb).pipe(Effect.timeout("2 seconds"))
          expect(yield* goalOn(harness)).toEqual(Option.none())
          yield* controls.emitAll(0)
          yield* waitFor(
            harness.client.session.getSnapshot(harness),
            (snapshot) => snapshot.runtime._tag === "Idle",
            5_000,
            "the cleared goal's last turn ends",
          )
          const resumed = yield* Effect.exit(goalCommandOn(harness, "resume"))
          expect(Exit.isFailure(resumed)).toBe(true)
          if (Exit.isFailure(resumed)) expect(Cause.pretty(resumed.cause)).toContain("No goal")
          expect(yield* goalOn(harness)).toEqual(Option.none())
          yield* controls.assertDone
        }).pipe(Effect.timeout("10 seconds")),
      12_000,
    )
  }

  it.scopedLive(
    "pause answers during work and resume keeps the same objective and usage",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("goal work"), gated: true },
          { ...textStep("unrelated work"), gated: true },
          { ...textStep("resumed work"), gated: true },
        ])
        const harness = yield* createRpcHarness({ ...e2ePreset, providerLayer })
        const command = (input: string) => goalCommandOn(harness, input)
        const idle = () =>
          waitFor(
            harness.client.session.getSnapshot(harness),
            (snapshot) => snapshot.runtime._tag === "Idle",
            5_000,
            "the paused goal's turn ends",
          )
        yield* command("Write the pelican poem")
        yield* controls.waitForCall(0)
        yield* command("pause").pipe(Effect.timeout("2 seconds"))
        const paused = Option.getOrThrow(yield* goalOn(harness))
        expect(paused.status).toBe("paused")
        yield* controls.emitAll(0)
        yield* idle()
        expect(yield* controls.callCount).toBe(1)
        const charged = Option.getOrThrow(yield* goalOn(harness))
        expect(charged.status).toBe("paused")
        expect(charged.tokensUsed).toBeGreaterThan(paused.tokensUsed)
        expect(charged.timeUsedMs).toBeGreaterThan(paused.timeUsedMs)
        expect(charged.pausedTurnStartedAtMs).toBeUndefined()
        yield* harness.client.message.send({ ...harness, content: "An unrelated question" })
        yield* controls.waitForCall(1)
        yield* controls.emitAll(1)
        yield* idle()
        expect(yield* goalOn(harness)).toEqual(Option.some(charged))
        yield* command("resume")
        yield* controls.waitForCall(2)
        const resumed = Option.getOrThrow(yield* goalOn(harness))
        expect(resumed.goalId).toBe(paused.goalId)
        expect(resumed.objective).toBe(paused.objective)
        expect(resumed.tokensUsed).toBe(charged.tokensUsed)
        expect(resumed.timeUsedMs).toBe(charged.timeUsedMs)
        expect(resumed.continuationsUsed).toBe(paused.continuationsUsed + 1)
        expect(resumed.status).toBe("active")
        yield* command("pause").pipe(Effect.timeout("2 seconds"))
        yield* controls.emitAll(2)
        const settled = yield* idle()
        expect(
          settled.messages.filter((m) => m.metadata?.customType === GOAL_CONTEXT_MESSAGE_TYPE),
        ).toHaveLength(2)
        yield* controls.assertDone
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )

  it.scopedLive(
    "a resume before the current turn ends leaves only one continuation",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...textStep("first pass"), gated: true },
          { ...textStep("second pass"), gated: true },
        ])
        const harness = yield* createRpcHarness({ ...e2ePreset, providerLayer })
        yield* goalCommandOn(harness, "Write the pelican poem")
        yield* controls.waitForCall(0)
        yield* goalCommandOn(harness, "pause").pipe(Effect.timeout("2 seconds"))
        yield* goalCommandOn(harness, "resume").pipe(Effect.timeout("2 seconds"))
        yield* controls.emitAll(0)
        yield* controls.waitForCall(1)
        expect((yield* harness.client.queue.get(harness)).followUp).toHaveLength(0)
        yield* goalCommandOn(harness, "pause").pipe(Effect.timeout("2 seconds"))
        yield* controls.emitAll(1)
        const settled = yield* waitFor(
          harness.client.session.getSnapshot(harness),
          (snapshot) => snapshot.runtime._tag === "Idle",
          5_000,
          "the resumed goal stops after pause",
        )
        expect(
          settled.messages.filter((m) => m.metadata?.customType === GOAL_CONTEXT_MESSAGE_TYPE),
        ).toHaveLength(2)
        expect(yield* controls.callCount).toBe(2)
        expect(Option.map(yield* goalOn(harness), (goal) => goal.status)).toEqual(
          Option.some("paused"),
        )
        yield* controls.assertDone
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )
})

// ── a goal created mid-turn ─────────────────────────────────────────────────

describe("a goal created mid-turn", () => {
  it.scopedLive(
    "the turn that created the goal is not charged its tokens",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const continuing = yield* Deferred.make<void>()
        // Step one spends tokens and creates the goal; step two
        // answers. The continuation the goal queues stays open.
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
            if (call === 1) {
              return Stream.fromIterable([
                toolCallPart(
                  "goal",
                  { action: "create", objective: "Write the pelican poem" },
                  { toolCallId: ToolCallId.make("create-1") },
                ),
                finishPart({
                  finishReason: "tool-calls",
                  usage: { inputTokens: 30, outputTokens: 12 },
                }),
              ])
            }
            if (call === 2) {
              return Stream.fromIterable([
                textDeltaPart("goal set"),
                finishPart({ finishReason: "stop", usage: { inputTokens: 40, outputTokens: 3 } }),
              ])
            }
            yield* Deferred.succeed(continuing, void 0)
            return Stream.never
          }),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "set a goal and start" })
        yield* Deferred.await(continuing)
        const goal = yield* goalOn({ client, sessionId, branchId })
        expect(Option.map(goal, (value) => value.status)).toEqual(Option.some("active"))
        expect(Option.map(goal, (value) => value.tokensUsed)).toEqual(Option.some(0))
        expect(Option.map(goal, (value) => value.continuationsUsed)).toEqual(Option.some(1))
      }).pipe(Effect.timeout("10 seconds")),
    12_000,
  )
})
