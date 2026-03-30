import { describe, it, test, expect } from "effect-bun-test"
import {
  WorkflowToolsExtension,
  SubagentToolsExtension,
  PlanExtension,
} from "@gent/core/extensions"
import {
  createExtensionHarness,
  createToolTestLayer,
} from "@gent/core/test-utils/extension-harness"
import { Effect, Layer } from "effect"
import { EventStore, SessionStarted, TurnCompleted } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { fromReducer } from "@gent/core/runtime/extensions/from-reducer"
import { ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { Storage } from "@gent/core/storage/sqlite-storage"

describe("createExtensionHarness", () => {
  test("WorkflowToolsExtension provides tools", () => {
    const harness = createExtensionHarness(WorkflowToolsExtension)
    expect(harness.tools.has("audit")).toBe(true)
    expect(harness.tools.has("plan")).toBe(true)
    expect(harness.spawnActor).toBeUndefined()
  })

  test("SubagentToolsExtension provides delegate/handoff tools", () => {
    const harness = createExtensionHarness(SubagentToolsExtension)
    expect(harness.tools.has("delegate")).toBe(true)
    expect(harness.tools.has("handoff")).toBe(true)
    expect(harness.tools.has("code_review")).toBe(true)
    expect(harness.spawnActor).toBeUndefined()
  })

  test("PlanExtension provides spawnActor", () => {
    const harness = createExtensionHarness(PlanExtension)
    expect(harness.spawnActor).toBeDefined()
  })
})

describe("createToolTestLayer", () => {
  it.live("provides all required services", () =>
    Effect.gen(function* () {
      const registry = yield* ExtensionRegistry
      const tc = yield* ExtensionTurnControl

      // Registry provides agents
      const cowork = yield* registry.getAgent("cowork")
      expect(cowork).toBeDefined()

      // TurnControl works (no-op in test)
      yield* tc.queueFollowUp({
        sessionId: "s" as never,
        branchId: "b" as never,
        content: "test",
      })
    }).pipe(Effect.provide(createToolTestLayer())),
  )

  it.live("loads extension tools when extensions provided", () =>
    Effect.gen(function* () {
      const registry = yield* ExtensionRegistry
      const tool = yield* registry.getTool("audit")
      expect(tool).toBeDefined()
    }).pipe(Effect.provide(createToolTestLayer({ extensions: [WorkflowToolsExtension] }))),
  )
})

// ── Actor lifecycle tests ──

const sessionId = "lifecycle-session" as SessionId
const branchId = "lifecycle-branch" as BranchId

const makeCounterExtension = (id: string): LoadedExtension => {
  const { spawnActor, projection } = fromReducer({
    id,
    initial: { count: 0 },
    reduce: (state: { count: number }, event) => {
      if (event._tag === "TurnCompleted") return { state: { count: state.count + 1 } }
      return { state }
    },
    derive: (state: { count: number }) => ({ uiModel: state }),
  })
  return {
    manifest: { id },
    kind: "builtin",
    sourcePath: "builtin",
    setup: { spawnActor, projection },
  }
}

const makeLifecycleLayer = (extensions: LoadedExtension[]) =>
  Layer.mergeAll(
    ExtensionStateRuntime.Live(extensions),
    EventStore.Memory,
    ExtensionTurnControl.Test(),
    Storage.Test(),
  )

describe("Actor lifecycle", () => {
  it.live("multiple extensions receive same event", () => {
    const ext1 = makeCounterExtension("counter-a")
    const ext2 = makeCounterExtension("counter-b")
    const layer = makeLifecycleLayer([ext1, ext2])

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.reduce(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })

      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      expect(snapshots.length).toBe(2)

      const a = snapshots.find((s) => s.extensionId === "counter-a")
      const b = snapshots.find((s) => s.extensionId === "counter-b")
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      expect((a!.model as { count: number }).count).toBe(1)
      expect((b!.model as { count: number }).count).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.live("terminated actor is removed from session", () => {
    const ext = makeCounterExtension("ephemeral")
    const layer = makeLifecycleLayer([ext])

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime

      // Spawn via reduce
      yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      const snap1 = yield* runtime.getUiSnapshots(sessionId, branchId)
      expect(snap1.length).toBe(1)

      // Terminate
      yield* runtime.terminateAll(sessionId)

      // After terminate + re-spawn, actor starts fresh
      yield* runtime.reduce(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })
      const snap2 = yield* runtime.getUiSnapshots(sessionId, branchId)
      // Re-spawned fresh — count is 1 not 2
      expect((snap2[0]!.model as { count: number }).count).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  test("PlanExtension harness exposes projection", () => {
    const harness = createExtensionHarness(PlanExtension)
    expect(harness.projection).toBeDefined()
    expect(harness.projection!.deriveTurn).toBeInstanceOf(Function)
    expect(harness.projection!.deriveUi).toBeInstanceOf(Function)
  })

  test("fromReducer deriveUi fallback uses safe sentinel when derive reads ctx.agent", () => {
    const { projection } = fromReducer({
      id: "sentinel-test",
      initial: { label: "" },
      reduce: (state: { label: string }) => ({ state }),
      // derive reads ctx.agent.name — would crash with undefined as never
      derive: (state: { label: string }, ctx) => ({
        uiModel: { label: state.label, agentName: ctx.agent.name },
      }),
    })
    expect(projection.deriveUi).toBeInstanceOf(Function)
    const ui = projection.deriveUi!({ label: "test" }) as { label: string; agentName: string }
    expect(ui.label).toBe("test")
    expect(ui.agentName).toBe("__derive_ui__")
  })
})
