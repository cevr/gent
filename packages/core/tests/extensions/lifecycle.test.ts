import { describe, test, expect } from "bun:test"
import {
  WorkflowToolsExtension,
  SubagentToolsExtension,
  PlanModeExtension,
} from "@gent/core/extensions"
import {
  createExtensionHarness,
  createToolTestLayer,
} from "@gent/core/test-utils/extension-harness"
import { Effect } from "effect"
import { ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ExtensionEventBus } from "@gent/core/runtime/extensions/event-bus"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"

describe("createExtensionHarness", () => {
  test("WorkflowToolsExtension provides tools and tag injections", () => {
    const harness = createExtensionHarness(WorkflowToolsExtension)
    expect(harness.tools.has("audit")).toBe(true)
    expect(harness.tools.has("loop")).toBe(true)
    expect(harness.tools.has("plan")).toBe(true)
    expect(harness.spawnActor).toBeUndefined()
    expect(harness.tagInjections).toBeDefined()
    expect(harness.tagInjections!.length).toBeGreaterThan(0)
    const loopTag = harness.tagInjections!.find((t) => t.tag === "loop-evaluation")
    expect(loopTag).toBeDefined()
    expect(loopTag!.tools.map((t) => t.name)).toContain("loop_evaluation")
  })

  test("SubagentToolsExtension provides delegate/handoff tools", () => {
    const harness = createExtensionHarness(SubagentToolsExtension)
    expect(harness.tools.has("delegate")).toBe(true)
    expect(harness.tools.has("handoff")).toBe(true)
    expect(harness.tools.has("code_review")).toBe(true)
    expect(harness.spawnActor).toBeUndefined()
  })

  test("PlanModeExtension provides spawnActor", () => {
    const harness = createExtensionHarness(PlanModeExtension)
    expect(harness.spawnActor).toBeDefined()
  })
})

describe("createToolTestLayer", () => {
  test("provides all required services", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const bus = yield* ExtensionEventBus
        const tc = yield* ExtensionTurnControl

        // Registry provides agents
        const cowork = yield* registry.getAgent("cowork")
        expect(cowork).toBeDefined()

        // EventBus works
        yield* bus.emit("test:ch", { data: 1 })

        // TurnControl works (no-op in test)
        yield* tc.queueFollowUp({
          sessionId: "s" as never,
          branchId: "b" as never,
          content: "test",
        })
      }).pipe(Effect.provide(createToolTestLayer())),
    )
  })

  test("loads extension tools when extensions provided", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const tool = yield* registry.getTool("audit")
        expect(tool).toBeDefined()
      }).pipe(Effect.provide(createToolTestLayer({ extensions: [WorkflowToolsExtension] }))),
    )
  })
})
