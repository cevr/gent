import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Exit, FileSystem, Option, PlatformError, Ref, Schema, Stream } from "effect"
import {
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textDeltaPart,
  textStep,
  waitFor,
  createRpcHarness,
  runToolWithCtx,
  testToolContext,
} from "@gent/core/test-utils"
import { BranchId, SessionId, ToolCallId } from "@gent/core/protocol"
import { e2ePreset } from "./helpers/test-preset"
import {
  continuationPrompt,
  formatGoalUsage,
  GOAL_CONTEXT_MESSAGE_TYPE,
  GOAL_EXTENSION_ID,
  goalContinuationSource,
  GoalSnapshot,
  type GoalState,
  GoalTool,
  remainingTokens,
} from "../src/goal.js"
import { BunServices } from "@effect/platform-bun"
import * as AiError from "effect/unstable/ai/AiError"

// ── goal/goal.test ──────────────────────────────────────────────────────────

/**
 * `/goal` keeps a durable per-branch objective and re-prompts the loop after
 * each ordinary turn until the goal completes or its token budget runs out.
 */

const sampleGoal: GoalState = {
  goalId: "g1",
  branchId: BranchId.make("b1"),
  objective: "Ship <it> & test",
  status: "active",
  tokenBudget: 100,
  tokensUsed: 40,
  timeUsedMs: 2_500,
  continuationsUsed: 2,
  createdAt: 0,
  updatedAt: 0,
}

describe("goals", () => {
  it.live("remaining budget is absent for unbounded goals and never negative", () =>
    Effect.sync(() => {
      expect(remainingTokens(sampleGoal)).toEqual(Option.some(60))
      expect(remainingTokens({ ...sampleGoal, tokensUsed: 500 })).toEqual(Option.some(0))
      const { tokenBudget: _budget, ...unbounded } = sampleGoal
      expect(remainingTokens(unbounded)).toEqual(Option.none())
    }),
  )

  it.live("the continuation prompt escapes the objective and reports usage", () =>
    Effect.sync(() => {
      const prompt = continuationPrompt(sampleGoal)
      expect(prompt).toContain("Ship &lt;it&gt; &amp; test")
      expect(prompt).toContain("remaining tokens: 60")
      expect(formatGoalUsage(sampleGoal)).toBe(
        "active · 2 continuations · 40 tokens · 3s · 60 remaining of 100",
      )
    }),
  )

  it.live(
    "a budgeted goal continues after each turn until the budget is spent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Each text turn costs 10 input tokens plus a few output tokens. A budget
          // of 15 allows one continuation; the second turn exhausts it.
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            textStep("first pass"),
            textStep("second pass"),
            textStep("budget report"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          const command = (input: string) =>
            client.extension.request({
              sessionId,
              branchId,
              extensionId: GOAL_EXTENSION_ID,
              capabilityId: "goal-command",
              input,
            })
          const readGoal = () =>
            client.extension
              .request({
                sessionId,
                branchId,
                extensionId: GOAL_EXTENSION_ID,
                capabilityId: "goal.get",
                input: {},
              })
              .pipe(
                Effect.map((snapshot) =>
                  Option.fromUndefinedOr(Schema.decodeUnknownSync(GoalSnapshot)(snapshot).goal),
                ),
              )

          yield* command("--budget 15 Write the pelican poem")
          const created = yield* readGoal()
          expect(Option.isSome(created)).toBe(true)
          if (Option.isSome(created)) {
            expect(created.value.objective).toBe("Write the pelican poem")
            expect(created.value.status).toBe("active")
            expect(created.value.tokenBudget).toBe(15)
          }

          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle" && current.messages.length >= 6,
            8_000,
            "goal turns settle",
          )
          const goalMessages = snapshot.messages.filter(
            (message) => message.metadata?.customType === GOAL_CONTEXT_MESSAGE_TYPE,
          )
          expect(goalMessages.length).toBe(3)
          expect(new Set(goalMessages.map((message) => message.id)).size).toBe(3)
          expect(
            goalMessages[2]?.parts.some(
              (part) => part.type === "text" && part.text.includes("reached its token budget"),
            ),
          ).toBe(true)

          const limited = yield* readGoal()
          expect(Option.isSome(limited)).toBe(true)
          if (Option.isSome(limited)) {
            expect(limited.value.status).toBe("budget_limited")
            expect(limited.value.continuationsUsed).toBe(1)
            expect(limited.value.tokensUsed).toBeGreaterThanOrEqual(15)
          }
          expect(yield* controls.callCount).toBe(3)

          // A second goal is refused while one is pending, and a spent budget needs a new one.
          const refused = yield* Effect.exit(command("Another objective"))
          expect(Exit.isFailure(refused)).toBe(true)
          if (Exit.isFailure(refused)) {
            expect(Cause.pretty(refused.cause)).toContain("already budget_limited")
          }
          const resumed = yield* Effect.exit(command("resume"))
          expect(Exit.isFailure(resumed)).toBe(true)
          if (Exit.isFailure(resumed)) {
            expect(Cause.pretty(resumed.cause)).toContain("budget is spent")
          }
          // Clear forgets the goal; status reports none afterwards.
          yield* command("clear")
          expect(yield* readGoal()).toEqual(Option.none())
          yield* controls.assertDone
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})

// ── goal/goal-store.test ────────────────────────────────────────────────────

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

// ── goal/goal-stream-failure.test ───────────────────────────────────────────

/**
 * A goal must not be driven on by a turn that never answered.
 *
 * `continueGoal` reads `turnAfter`. Before it read `streamFailed`, a turn that
 * died on a broken provider stream still charged the budget and queued another
 * continuation prompt, so the goal spent itself against an answer that never
 * arrived and the queued prompt woke the branch for one more turn.
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
        const readGoal = () =>
          client.extension
            .request({
              sessionId,
              branchId,
              extensionId: GOAL_EXTENSION_ID,
              capabilityId: "goal.get",
              input: {},
            })
            .pipe(
              Effect.map((snapshot) =>
                Option.fromUndefinedOr(Schema.decodeUnknownSync(GoalSnapshot)(snapshot).goal),
              ),
            )

        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: GOAL_EXTENSION_ID,
          capabilityId: "goal-command",
          input: "Write the pelican poem",
        })
        const created = yield* readGoal()
        expect(Option.map(created, (goal) => goal.status)).toEqual(Option.some("active"))

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

        // Creating the goal queues the first continuation, which starts the turn
        // that then fails. The failed turn must not queue a second one: that is
        // the prompt that would wake the branch and spend the goal again.
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
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
})
