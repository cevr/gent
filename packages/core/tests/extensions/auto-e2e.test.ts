import { describe, it, expect } from "effect-bun-test"
import { Effect, Fiber, Ref, Stream } from "effect"
import {
  createSequenceProvider,
  toolCallStep,
  textStep,
  type SequenceStep,
} from "@gent/core/debug/provider"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { EventStore, SessionStarted, type EventEnvelope } from "@gent/core/domain/event"
import { Message, TextPart } from "@gent/core/domain/message"
import type { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"

const sessionId = "auto-e2e-session" as SessionId
const branchId = "auto-e2e-branch" as BranchId

const makeMessage = (text: string) =>
  new Message({
    id: `msg-${Date.now()}` as MessageId,
    sessionId,
    branchId,
    kind: "regular",
    role: "user",
    parts: [new TextPart({ type: "text", text })],
    createdAt: new Date(),
  })

const runE2ETest = (
  steps: Parameters<typeof createSequenceProvider>[0],
  test: (
    controls: Awaited<
      ReturnType<typeof Effect.runPromise<ReturnType<typeof createSequenceProvider>>>["then"]
    >["controls"],
  ) => Effect.Effect<void, unknown, AgentLoop | ExtensionStateRuntime>,
) =>
  Effect.gen(function* () {
    const { layer: providerLayer, controls } = yield* createSequenceProvider(steps)
    const e2eLayer = createE2ELayer({
      providerLayer,
    })

    yield* Effect.gen(function* () {
      const stateRuntime = yield* ExtensionStateRuntime
      yield* stateRuntime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      yield* stateRuntime.handleIntent(
        sessionId,
        "auto",
        { _tag: "StartAuto", goal: "Fix the bug" },
        0,
        branchId,
      )
      yield* test(controls)
    }).pipe(Effect.provide(e2eLayer))
  })

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
      ],
      (controls) =>
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const stateRuntime = yield* ExtensionStateRuntime

          yield* agentLoop.run(makeMessage("begin"))

          const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
          const autoSnapshot = snapshots.find((s) => s.extensionId === "auto")
          if (autoSnapshot === undefined) throw new Error("auto snapshot not found")
          expect((autoSnapshot.model as { active: boolean }).active).toBe(false)
          expect(yield* controls.callCount).toBe(2)
          yield* controls.assertDone()
        }),
    ),
  )

  it.live("multi-iteration: continue → counsel → checkpoint(complete)", () =>
    runE2ETest(
      [
        // Turn 1: initial message
        textStep("OK entering auto."),
        // Turn 2: auto kickoff → checkpoint(continue) → AwaitingCounsel
        toolCallStep("auto_checkpoint", {
          status: "continue",
          summary: "First pass done",
          learnings: "Found 3 issues",
          nextIdea: "Fix the issues",
        }),
        // Turn 3: counsel follow-up → call counsel tool → Working(iteration 2)
        toolCallStep("counsel", { prompt: "Reviewed iteration 1. Proceed." }),
        // Turn 4: iteration 2 → checkpoint(complete) → Inactive
        toolCallStep("auto_checkpoint", {
          status: "complete",
          summary: "All fixed",
          learnings: "Fixed all 3 issues",
        }),
      ],
      (controls) =>
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const stateRuntime = yield* ExtensionStateRuntime

          yield* agentLoop.run(makeMessage("begin"))

          const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
          const autoSnapshot = snapshots.find((s) => s.extensionId === "auto")
          if (autoSnapshot === undefined) throw new Error("auto snapshot not found")
          expect((autoSnapshot.model as { active: boolean }).active).toBe(false)
          expect(yield* controls.callCount).toBe(4)
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
        toolCallStep("counsel", { prompt: "Review iteration 1." }),
        toolCallStep("auto_checkpoint", {
          status: "complete",
          summary: "All fixed",
        }),
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

          // Should have auto_checkpoint (x2) and counsel (x1)
          const toolNames = toolSucceeded.map((e) => (e.event as { toolName: string }).toolName)
          expect(toolNames.filter((n) => n === "auto_checkpoint").length).toBe(2)
          expect(toolNames.filter((n) => n === "counsel").length).toBe(1)

          // Also verify TurnCompleted events
          const turnCompleted = envelopes.filter((e) => e.event._tag === "TurnCompleted")
          expect(turnCompleted.length).toBe(4)

          expect(yield* controls.callCount).toBe(4)
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
      const e2eLayer = createE2ELayer({ providerLayer })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const stateRuntime = yield* ExtensionStateRuntime

        yield* stateRuntime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        yield* stateRuntime.handleIntent(
          sessionId,
          "auto",
          { _tag: "StartAuto", goal: "Fix the bug" },
          0,
          branchId,
        )

        // Turn 1 (initial) + Turn 2 (auto kickoff follow-up, drained during finalization)
        yield* agentLoop.run(makeMessage("begin"))

        // Turns 3-6: simulate more turns. Each run produces TurnCompleted → TurnTick
        // turnsSinceCheckpoint: 1 (turn 2), 2 (turn 3), 3 (turn 4), 4 (turn 5), 5 (turn 6 → wedge!)
        for (let i = 0; i < 4; i++) {
          yield* agentLoop.run(makeMessage(`follow-up ${i + 1}`))
        }

        const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
        const autoSnapshot = snapshots.find((s) => s.extensionId === "auto")
        if (autoSnapshot === undefined) throw new Error("auto snapshot not found")
        expect((autoSnapshot.model as { active: boolean }).active).toBe(false)
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
      ])

      const e2eLayer = createE2ELayer({ providerLayer })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const stateRuntime = yield* ExtensionStateRuntime

        yield* stateRuntime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        yield* stateRuntime.handleIntent(
          sessionId,
          "auto",
          { _tag: "StartAuto", goal: "Verify phases" },
          0,
          branchId,
        )

        // Fork the run — it will process turn 1, then start turn 2 which blocks on the gate
        const runFiber = yield* Effect.forkChild(agentLoop.run(makeMessage("begin")))

        // Wait for the gated turn to start (provider.stream() called for step index 1)
        yield* controls.waitForCall(1)

        // At this point: turn 1 completed, auto is in Working state, turn 2 is blocked
        const midSnapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
        const midAuto = midSnapshots.find((s) => s.extensionId === "auto")
        if (midAuto === undefined) throw new Error("mid-sequence auto snapshot not found")
        const midModel = midAuto.model as { active: boolean; phase?: string }
        expect(midModel.active).toBe(true)
        expect(midModel.phase).toBe("working")

        // Release the gate — turn 2 completes with auto_checkpoint(complete)
        yield* controls.emitAll(1)

        // Wait for run to finish
        yield* Fiber.join(runFiber)

        // Final state: auto is inactive
        const finalSnapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
        const finalAuto = finalSnapshots.find((s) => s.extensionId === "auto")
        if (finalAuto === undefined) throw new Error("final auto snapshot not found")
        expect((finalAuto.model as { active: boolean }).active).toBe(false)
      }).pipe(Effect.provide(e2eLayer))
    }),
  )
})
