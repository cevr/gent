import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { SessionStarted } from "@gent/core/domain/event"
import { Message, TextPart } from "@gent/core/domain/message"
import type { BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
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

  it.live("execute plan: heuristic advances todos through StreamStarted/TurnCompleted", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* createSequenceProvider([
        // Turn 1: plan output
        textStep("- [ ] Fix auth\n- [ ] Add tests\n- [ ] Update docs"),
        // Turn 2: executing — first todo
        textStep("Fixed the auth bug."),
        // Turn 3: executing — second todo
        textStep("Added tests."),
        // Turn 4: executing — third todo (should auto-complete → normal mode)
        textStep("Updated docs."),
      ])

      const e2eLayer = createE2ELayer({ providerLayer })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const stateRuntime = yield* ExtensionStateRuntime

        yield* stateRuntime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // Toggle plan mode + run to extract todos
        yield* stateRuntime.handleIntent(sessionId, "plan", { _tag: "TogglePlan" }, 0, branchId)
        yield* agentLoop.run(makeMessage("Create a plan"))

        const planned = yield* getPlanSnapshot(stateRuntime)
        expect(planned.todos.length).toBe(3)

        // Execute plan (use high epoch to avoid stale rejection after many events)
        yield* stateRuntime.handleIntent(
          sessionId,
          "plan",
          { _tag: "ExecutePlan" },
          Number.MAX_SAFE_INTEGER,
          branchId,
        )
        const executing = yield* getPlanSnapshot(stateRuntime)
        expect(executing.mode).toBe("executing")

        // Run 3 turns — heuristic: StreamStarted marks first pending in-progress,
        // TurnCompleted marks all in-progress as done
        yield* agentLoop.run(makeMessage("Execute step 1"))
        yield* agentLoop.run(makeMessage("Execute step 2"))
        yield* agentLoop.run(makeMessage("Execute step 3"))

        const final = yield* getPlanSnapshot(stateRuntime)
        // All todos done → mode should be "normal"
        expect(final.mode).toBe("normal")
        expect(final.progress.done).toBe(3)
        expect(final.progress.total).toBe(3)
        expect(final.todos.every((t) => t.status === "done")).toBe(true)
      }).pipe(Effect.provide(e2eLayer))
    }),
  )
})
