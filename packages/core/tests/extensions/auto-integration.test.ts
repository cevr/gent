import { describe, it, expect } from "effect-bun-test"
import { Effect, Fiber, type Layer, Ref, Stream } from "effect"
import {
  createSequenceProvider,
  toolCallStep,
  textStep,
  type SequenceStep,
} from "@gent/core/debug/provider"
import {
  createE2ELayer,
  withTinyContextWindow,
  trackingApprovalService,
} from "@gent/core/test-utils/e2e-layer"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { e2ePreset } from "./helpers/test-preset.js"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { EventStore, SessionStarted, type EventEnvelope } from "@gent/core/domain/event"
import { Message, TextPart } from "@gent/core/domain/message"
import type { AgentName } from "@gent/core/domain/agent"
import { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { AutoProtocol } from "@gent/extensions/auto-protocol"

const sessionId = SessionId.make("auto-e2e-session")
const branchId = BranchId.make("auto-e2e-branch")

const makeMessage = (text: string) =>
  Message.cases.regular.make({
    id: MessageId.make(`msg-${Date.now()}`),
    sessionId,
    branchId,
    role: "user",
    parts: [new TextPart({ type: "text", text })],
    createdAt: new Date(),
  })

/** Mock subagent runner that returns valid review JSON for review tool compatibility */
const reviewCompatibleRunner = {
  run: (params: { prompt: string }) =>
    Effect.succeed({
      _tag: "success" as const,
      text: params.prompt.includes("Synthesize")
        ? JSON.stringify([
            { file: "test.ts", line: 1, severity: "low", type: "suggestion", text: "ok" },
          ])
        : "No issues found.",
      sessionId: SessionId.make("test-subagent-session"),
      agentName: "cowork" as AgentName,
    }),
}

const runE2ETest = (
  steps: Parameters<typeof createSequenceProvider>[0],
  test: (
    controls: Awaited<
      ReturnType<typeof Effect.runPromise<ReturnType<typeof createSequenceProvider>>>["then"]
    >["controls"],
  ) => Effect.Effect<void, unknown, AgentLoop | MachineEngine>,
) =>
  Effect.gen(function* () {
    const { layer: providerLayer, controls } = yield* createSequenceProvider(steps)
    const e2eLayer = createE2ELayer({
      ...e2ePreset,
      providerLayer,
      subagentRunner: reviewCompatibleRunner,
    })

    yield* Effect.gen(function* () {
      const stateRuntime = yield* MachineEngine
      yield* stateRuntime.publish(SessionStarted.make({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      yield* stateRuntime.send(
        sessionId,
        AutoProtocol.StartAuto.make({ goal: "Fix the bug" }),
        branchId,
      )
      yield* test(controls)
    }).pipe(Effect.provide(e2eLayer))
  })

const waitForAutoActive = (
  runtime: typeof MachineEngine.Type,
  active: boolean,
  timeoutMs = 3_000,
) =>
  waitFor(
    runtime
      .execute(sessionId, AutoProtocol.GetSnapshot.make(), branchId)
      .pipe(Effect.catchEager(() => Effect.succeed(undefined as { active: boolean } | undefined))),
    (snap) => (snap as { active: boolean } | undefined)?.active === active,
    timeoutMs,
    `auto active = ${String(active)}`,
  )

describe("Auto extension E2E", () => {
  it.live("single iteration: start → checkpoint(complete)", () =>
    runE2ETest(
      [
        textStep("Starting auto mode."),
        toolCallStep("auto_checkpoint", {
          status: "complete",
          summary: "Task done",
          learnings: "Everything worked",
        }),
        textStep("Auto mode complete."), // continuation after tool call
      ],
      (controls) =>
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const stateRuntime = yield* MachineEngine

          yield* agentLoop.run(makeMessage("begin"))

          const model = (yield* stateRuntime.execute(
            sessionId,
            AutoProtocol.GetSnapshot.make(),
            branchId,
          )) as { active: boolean }
          expect(model.active).toBe(false)
          expect(yield* controls.callCount).toBe(3)
          yield* controls.assertDone()
        }),
    ),
  )

  it.live("multi-iteration: continue → review → checkpoint(complete)", () =>
    runE2ETest(
      [
        // Step 1: initial message → text response
        textStep("OK entering auto."),
        // Step 2: auto kickoff → checkpoint(continue) → AwaitingReview
        toolCallStep("auto_checkpoint", {
          status: "continue",
          summary: "First pass done",
          learnings: "Found 3 issues",
          nextIdea: "Fix the issues",
        }),
        // Step 3: tool continuation → text (loop stops, queued review follow-up dequeued)
        textStep("Checkpoint recorded."),
        // Step 4: review follow-up → call review tool → Working(iteration 2)
        toolCallStep("review", {
          content: "diff placeholder",
          description: "Reviewed iteration 1. Proceed.",
        }),
        // Step 5: tool continuation → text (loop stops, queued iteration-2 follow-up dequeued)
        textStep("Review complete."),
        // Step 6: iteration 2 → checkpoint(complete) → Inactive
        toolCallStep("auto_checkpoint", {
          status: "complete",
          summary: "All fixed",
          learnings: "Fixed all 3 issues",
        }),
        // Step 7: tool continuation → text (loop stops, no more items)
        textStep("All done."),
      ],
      (controls) =>
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const stateRuntime = yield* MachineEngine

          yield* agentLoop.run(makeMessage("begin"))

          const model = (yield* stateRuntime.execute(
            sessionId,
            AutoProtocol.GetSnapshot.make(),
            branchId,
          )) as { active: boolean }
          expect(model.active).toBe(false)
          expect(yield* controls.callCount).toBe(7)
          yield* controls.assertDone()
        }),
    ),
  )

  it.live("event-store assertions: ToolCallSucceeded events published", () =>
    runE2ETest(
      [
        textStep("OK entering auto."),
        toolCallStep("auto_checkpoint", {
          status: "continue",
          summary: "First pass",
          learnings: "Found issues",
          nextIdea: "Fix them",
        }),
        textStep("Checkpoint recorded."),
        toolCallStep("review", { content: "diff placeholder", description: "Review iteration 1." }),
        textStep("Review done."),
        toolCallStep("auto_checkpoint", {
          status: "complete",
          summary: "All fixed",
        }),
        textStep("All done."),
      ],
      (controls) =>
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const eventStore = yield* EventStore

          // Subscribe to events before running
          const envelopesRef = yield* Ref.make<EventEnvelope[]>([])
          yield* Effect.forkChild(
            eventStore.subscribe({ sessionId, branchId }).pipe(
              Stream.runForEach((env) => Ref.update(envelopesRef, (current) => [...current, env])),
              Effect.catchCause(() => Effect.void),
            ),
          )

          yield* agentLoop.run(makeMessage("begin"))

          const envelopes = yield* Ref.get(envelopesRef)
          const toolSucceeded = envelopes.filter((e) => e.event._tag === "ToolCallSucceeded")

          // Should have auto_checkpoint (x2) and review (x1)
          const toolNames = toolSucceeded.map((e) => (e.event as { toolName: string }).toolName)
          expect(toolNames.filter((n) => n === "auto_checkpoint").length).toBe(2)
          expect(toolNames.filter((n) => n === "review").length).toBe(1)

          // TurnCompleted fires once per user-initiated turn, plus once per queued follow-up turn
          // With tool continuation, each tool-call step auto-continues within the same turn
          const turnCompleted = envelopes.filter((e) => e.event._tag === "TurnCompleted")
          expect(turnCompleted.length).toBe(4)

          expect(yield* controls.callCount).toBe(7)
        }),
    ),
  )

  it.live("wedge prevention: turns without checkpoint auto-cancel", () =>
    Effect.gen(function* () {
      // 1 initial + 1 kickoff + 5 text turns (TurnTick w/o checkpoint) + extra
      const steps = [
        textStep("OK starting."), // Turn 1: initial
        textStep("Working on it..."), // Turn 2: auto kickoff
        textStep("Still working..."), // Turn 3: manual follow-up
        textStep("Making progress..."), // Turn 4
        textStep("Almost there..."), // Turn 5
        textStep("Just a bit more..."), // Turn 6 — turnsSinceCheckpoint hits 5, wedge
        textStep("Shouldn't reach here."), // Turn 7 — auto is now inactive
      ]

      const { layer: providerLayer } = yield* createSequenceProvider(steps)
      const e2eLayer = createE2ELayer({ ...e2ePreset, providerLayer })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const stateRuntime = yield* MachineEngine

        yield* stateRuntime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        yield* stateRuntime.send(
          sessionId,
          AutoProtocol.StartAuto.make({ goal: "Fix the bug" }),
          branchId,
        )

        // Turn 1 (initial) + Turn 2 (auto kickoff follow-up, drained during finalization)
        yield* agentLoop.run(makeMessage("begin"))

        // Turns 3-6: simulate more turns. Each run produces TurnCompleted → TurnTick
        // turnsSinceCheckpoint: 1 (turn 2), 2 (turn 3), 3 (turn 4), 4 (turn 5), 5 (turn 6 → wedge!)
        for (let i = 0; i < 4; i++) {
          yield* agentLoop.run(makeMessage(`follow-up ${i + 1}`))
        }

        const model = yield* waitForAutoActive(stateRuntime, false)
        expect(model.active).toBe(false)
      }).pipe(Effect.provide(e2eLayer))
    }),
  )

  it.live("gated mid-sequence assertions: verify UI phases between turns", () =>
    Effect.gen(function* () {
      const gatedCheckpoint: SequenceStep = {
        ...toolCallStep("auto_checkpoint", { status: "complete", summary: "Done" }),
        gated: true,
      }

      const { layer: providerLayer, controls } = yield* createSequenceProvider([
        textStep("Starting."), // Turn 1: initial
        gatedCheckpoint, // Turn 2: gated — held until we release
        textStep("Done."), // Continuation after checkpoint tool result
      ])

      const e2eLayer = createE2ELayer({ ...e2ePreset, providerLayer })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const stateRuntime = yield* MachineEngine

        yield* stateRuntime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        yield* stateRuntime.send(
          sessionId,
          AutoProtocol.StartAuto.make({ goal: "Verify phases" }),
          branchId,
        )

        // Fork the run — it will process turn 1, then start turn 2 which blocks on the gate
        const runFiber = yield* Effect.forkChild(agentLoop.run(makeMessage("begin")))

        // Wait for the gated turn to start (provider.stream() called for step index 1)
        yield* controls.waitForCall(1)

        // At this point: turn 1 completed, auto is in Working state, turn 2 is blocked
        const midModel = (yield* stateRuntime.execute(
          sessionId,
          AutoProtocol.GetSnapshot.make(),
          branchId,
        )) as { active: boolean; phase?: string }
        expect(midModel.active).toBe(true)
        expect(midModel.phase).toBe("working")

        // Release the gate — turn 2 completes with auto_checkpoint(complete)
        yield* controls.emitAll(1)

        // Wait for run to finish
        yield* Fiber.join(runFiber)

        // Final state: auto is inactive
        const finalModel = (yield* stateRuntime.execute(
          sessionId,
          AutoProtocol.GetSnapshot.make(),
          branchId,
        )) as { active: boolean }
        expect(finalModel.active).toBe(false)
      }).pipe(Effect.provide(e2eLayer))
    }),
  )

  it.live("handoff dedup: handoff extension skips when auto is active", () =>
    Effect.gen(function* () {
      const { layer: handoffLayer, presentCalled } = yield* trackingApprovalService()

      const { layer: providerLayer } = yield* createSequenceProvider([
        textStep("Starting auto."),
        toolCallStep("auto_checkpoint", {
          status: "continue",
          summary: "First pass",
          nextIdea: "Keep going",
        }),
        toolCallStep("review", { content: "diff placeholder", description: "Review" }),
        toolCallStep("auto_checkpoint", {
          status: "complete",
          summary: "Done",
        }),
        textStep("Done."),
        textStep("Acknowledged handoff request."),
      ])

      const e2eLayer = createE2ELayer({
        ...e2ePreset,
        providerLayer,
        extraLayers: [handoffLayer as Layer.Layer<never>],
      })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const stateRuntime = yield* MachineEngine

        yield* stateRuntime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        yield* stateRuntime.send(
          sessionId,
          AutoProtocol.StartAuto.make({ goal: "Test handoff dedup" }),
          branchId,
        )

        yield* agentLoop.run(makeMessage("begin"))

        expect(yield* Ref.get(presentCalled)).toBe(false)

        // Also verify no HandoffPresented events were published
        const eventStore = yield* EventStore
        const envelopesRef = yield* Ref.make<EventEnvelope[]>([])
        yield* eventStore.subscribe({ sessionId, branchId }).pipe(
          Stream.take(100),
          Stream.runForEach((env) => Ref.update(envelopesRef, (curr) => [...curr, env])),
          Effect.timeout("100 millis"),
          Effect.catchEager(() => Effect.void),
        )
        const envelopes = yield* Ref.get(envelopesRef)
        const handoffEvents = envelopes.filter((e) => e.event._tag === "HandoffPresented")
        expect(handoffEvents.length).toBe(0)
      }).pipe(Effect.provide(e2eLayer))
    }),
  )

  it.live("auto handoff emits QueueFollowUp, not HandoffPresented", () =>
    Effect.gen(function* () {
      const { layer: handoffLayer, presentCalled } = yield* trackingApprovalService()

      const { layer: providerLayer, controls } = yield* createSequenceProvider([
        textStep("Working on it."),
        toolCallStep("auto_checkpoint", {
          status: "complete",
          summary: "All done",
        }),
        textStep("Acknowledged handoff request."),
      ])

      const e2eLayer = createE2ELayer({
        ...e2ePreset,
        providerLayer,
        extraLayers: [handoffLayer as Layer.Layer<never>],
      })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const stateRuntime = yield* MachineEngine

        yield* stateRuntime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        yield* stateRuntime.send(
          sessionId,
          AutoProtocol.StartAuto.make({ goal: "Verify no direct handoff" }),
          branchId,
        )

        yield* agentLoop.run(makeMessage("begin"))

        expect(yield* Ref.get(presentCalled)).toBe(false)
        expect(yield* controls.callCount).toBe(3)
        yield* controls.assertDone()
      }).pipe(Effect.provide(e2eLayer))
    }),
  )

  it.live("threshold: auto active queues follow-up instead of HandoffPresented", () =>
    Effect.gen(function* () {
      yield* withTinyContextWindow(
        Effect.gen(function* () {
          const { layer: handoffLayer, presentCalled } = yield* trackingApprovalService()

          const { layer: providerLayer, controls } = yield* createSequenceProvider([
            textStep("x".repeat(2000)), // ~500 tokens — context over 85%
            toolCallStep("auto_checkpoint", {
              status: "complete",
              summary: "Done with threshold test",
            }),
            // Extra step for the queued handoff follow-up turn
            textStep("Acknowledged handoff request."),
          ])

          const e2eLayer = createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extraLayers: [handoffLayer as Layer.Layer<never>],
          })

          yield* Effect.gen(function* () {
            const agentLoop = yield* AgentLoop
            const stateRuntime = yield* MachineEngine

            yield* stateRuntime.publish(SessionStarted.make({ sessionId, branchId }), {
              sessionId,
              branchId,
            })
            yield* stateRuntime.send(
              sessionId,
              AutoProtocol.StartAuto.make({ goal: "Threshold handoff test" }),
              branchId,
            )

            yield* agentLoop.run(makeMessage("begin"))

            // Auto's interceptor queued a follow-up, NOT a direct HandoffPresented
            expect(yield* Ref.get(presentCalled)).toBe(false)
            expect(yield* controls.callCount).toBe(3)
            yield* controls.assertDone()
          }).pipe(Effect.provide(e2eLayer))
        }),
      )
    }),
  )
})
