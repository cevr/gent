import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { SessionStarted, ToolCallSucceeded } from "@gent/core/domain/event"
import { Message, TextPart } from "@gent/core/domain/message"
import type { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import type { PlanUiModel } from "@gent/core/extensions/plan"

const sessionId = "plan-e2e-session" as SessionId
const branchId = "plan-e2e-branch" as BranchId

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
    const planSnapshot = snapshots.find((s) => s.extensionId === "plan")
    if (planSnapshot === undefined) throw new Error("plan snapshot not found")
    return planSnapshot.model as PlanUiModel
  })

describe("Plan extension E2E", () => {
  it.live("plan mode: text accumulation → TurnCompleted → todos extracted", () =>
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
        yield* stateRuntime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // Toggle plan mode
        yield* stateRuntime.handleIntent(sessionId, "plan", { _tag: "TogglePlan" }, 0, branchId)

        // Verify plan mode is active
        const before = yield* getPlanSnapshot(stateRuntime)
        expect(before.mode).toBe("plan")
        expect(before.todos.length).toBe(0)

        // Run a turn — provider emits text with checkboxes
        // StreamChunk events accumulate in pendingText
        // TurnCompleted triggers extractTodos
        yield* agentLoop.run(makeMessage("Create a plan"))

        const after = yield* getPlanSnapshot(stateRuntime)
        expect(after.mode).toBe("plan")
        expect(after.todos.length).toBe(3)
        expect(after.todos[0]?.text).toBe("Fix the authentication bug")
        expect(after.todos[1]?.text).toBe("Add unit tests")
        expect(after.todos[2]?.text).toBe("Update documentation")
        expect(after.todos.every((t) => t.status === "pending")).toBe(true)
        expect(after.progress.total).toBe(3)
        expect(after.progress.done).toBe(0)
      }).pipe(Effect.provide(e2eLayer))
    }),
  )

  it.live(
    "plan tool observation: ToolCallSucceeded(plan, decision=yes) → executing with todos",
    () =>
      Effect.gen(function* () {
        // Reducer-level integration: inject synthetic ToolCallSucceeded and verify
        // the actor transitions to executing mode with extracted todos.
        // A full E2E test driving the plan tool through AgentLoop would require
        // mocking SubagentRunner + PromptPresenter; pure reducer coverage is in plan.test.ts.
        const { layer: providerLayer } = yield* createSequenceProvider([textStep("ok")])
        const e2eLayer = createE2ELayer({ providerLayer })

        yield* Effect.gen(function* () {
          const stateRuntime = yield* ExtensionStateRuntime

          yield* stateRuntime.reduce(new SessionStarted({ sessionId, branchId }), {
            sessionId,
            branchId,
          })

          yield* stateRuntime.reduce(
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
          expect(after.todos.length).toBe(2)
          expect(after.todos[0]?.text).toBe("Fix auth")
          expect(after.todos[1]?.text).toBe("Add tests")
        }).pipe(Effect.provide(e2eLayer))
      }),
  )
})
