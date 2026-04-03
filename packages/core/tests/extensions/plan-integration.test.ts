import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { EventStore, SessionStarted, ToolCallSucceeded } from "@gent/core/domain/event"
import { Message, TextPart } from "@gent/core/domain/message"
import type { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { PLAN_EXTENSION_ID, PlanExtension, type PlanUiModel } from "@gent/core/extensions/plan"
import { PlanProtocol } from "@gent/core/extensions/plan-protocol"
import { Storage } from "@gent/core/storage/sqlite-storage"

const sessionId = "plan-e2e-session" as SessionId
const branchId = "plan-e2e-branch" as BranchId

const planExtension = {
  manifest: PlanExtension.manifest,
  kind: "builtin" as const,
  sourcePath: "builtin",
  setup: Effect.runSync(PlanExtension.setup({ cwd: "/tmp", source: "test", home: "/tmp" })),
}

const makeMessage = (text: string) =>
  new Message({
    id: `msg-${Date.now()}-${Math.random()}` as MessageId,
    sessionId,
    branchId,
    kind: "regular",
    role: "user",
    parts: [new TextPart({ type: "text", text })],
    createdAt: new Date(),
  })

const getPlanSnapshot = (stateRuntime: ExtensionStateRuntime["Type"]) =>
  Effect.gen(function* () {
    const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
    const planSnapshot = snapshots.find((s) => s.extensionId === PLAN_EXTENSION_ID)
    if (planSnapshot === undefined) throw new Error("plan snapshot not found")
    return planSnapshot.model as PlanUiModel
  })

describe("Plan extension E2E", () => {
  it.live("plan mode: text accumulation → TurnCompleted → steps extracted", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* createSequenceProvider([
        // The agent outputs a plan with markdown checkboxes
        textStep(
          "## Plan\n\n- [ ] Fix the authentication bug\n- [ ] Add unit tests\n- [ ] Update documentation",
        ),
      ])

      const e2eLayer = createE2ELayer({ providerLayer })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const stateRuntime = yield* ExtensionStateRuntime

        // Initialize extension actors
        yield* stateRuntime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // Toggle plan mode
        yield* stateRuntime.send(sessionId, PlanProtocol.TogglePlan(), branchId)

        // Verify plan mode is active
        const before = yield* getPlanSnapshot(stateRuntime)
        expect(before.mode).toBe("plan")
        expect(before.steps.length).toBe(0)

        // Run a turn — provider emits text with checkboxes
        // StreamChunk events accumulate in pendingText
        // TurnCompleted triggers extractSteps
        yield* agentLoop.run(makeMessage("Create a plan"))

        const after = yield* getPlanSnapshot(stateRuntime)
        expect(after.mode).toBe("plan")
        expect(after.steps.length).toBe(3)
        expect(after.steps[0]?.text).toBe("Fix the authentication bug")
        expect(after.steps[1]?.text).toBe("Add unit tests")
        expect(after.steps[2]?.text).toBe("Update documentation")
        expect(after.steps.every((t) => t.status === "pending")).toBe(true)
        expect(after.progress.total).toBe(3)
        expect(after.progress.completed).toBe(0)
      }).pipe(Effect.provide(e2eLayer))
    }),
  )

  it.live(
    "plan tool observation: ToolCallSucceeded(plan, decision=yes) → executing with steps",
    () =>
      Effect.gen(function* () {
        const layer = Layer.mergeAll(
          ExtensionStateRuntime.Live([planExtension]).pipe(
            Layer.provideMerge(ExtensionTurnControl.Test()),
          ),
          EventStore.Memory,
          Storage.Test(),
        )

        yield* Effect.gen(function* () {
          const stateRuntime = yield* ExtensionStateRuntime

          yield* stateRuntime.publish(new SessionStarted({ sessionId, branchId }), {
            sessionId,
            branchId,
          })

          yield* stateRuntime.publish(
            new ToolCallSucceeded({
              sessionId,
              branchId,
              toolCallId: "tc-plan" as ToolCallId,
              toolName: "plan",
              output: JSON.stringify({
                mode: "plan-only",
                decision: "yes",
                plan: "## Plan\n- [ ] Fix auth\n- [ ] Add tests",
                path: "/tmp/plan.md",
              }),
            }),
            { sessionId, branchId },
          )

          const after = yield* getPlanSnapshot(stateRuntime)
          expect(after.mode).toBe("executing")
          expect(after.steps.length).toBe(2)
          expect(after.steps[0]?.text).toBe("Fix auth")
          expect(after.steps[1]?.text).toBe("Add tests")
        }).pipe(Effect.provide(layer))
      }),
  )
})
