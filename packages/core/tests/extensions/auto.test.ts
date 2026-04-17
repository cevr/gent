import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import {
  EventStore,
  SessionStarted,
  TurnCompleted,
  ToolCallSucceeded,
} from "@gent/core/domain/event"
import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import type { LoadedExtension } from "@gent/core/domain/extension"
import {
  AUTO_EXTENSION_ID,
  AutoExtension,
  type AutoState,
  type AutoUiModel,
} from "@gent/extensions/auto"
import { AutoJournal, type JournalRow } from "@gent/extensions/auto-journal"
import { AutoProtocol } from "@gent/extensions/auto-protocol"
import { Session } from "@gent/core/domain/message"
import { testSetupCtx } from "@gent/core/test-utils"
import { WorkflowRuntime } from "@gent/core/runtime/extensions/workflow-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { Storage } from "@gent/core/storage/sqlite-storage"

// ── Runtime integration tests ──

const sessionId = SessionId.of("auto-session")
const branchId = BranchId.of("auto-branch")

const autoExtension: LoadedExtension = {
  manifest: AutoExtension.manifest,
  kind: "builtin",
  sourcePath: "builtin",
  contributions: Effect.runSync(AutoExtension.setup(testSetupCtx())),
}

const makeLayer = () =>
  Layer.mergeAll(
    WorkflowRuntime.Live([autoExtension]).pipe(Layer.provideMerge(ExtensionTurnControl.Test())),
    EventStore.Memory,
    Storage.Test(),
  )

const getSnapshot = (runtime: WorkflowRuntime) =>
  Effect.gen(function* () {
    const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
    return snapshots.find((s) => s.extensionId === AUTO_EXTENSION_ID)
  })

const sendAuto = (
  runtime: WorkflowRuntime,
  intent:
    | { readonly _tag: "StartAuto"; readonly goal: string; readonly maxIterations?: number }
    | { readonly _tag: "CancelAuto" }
    | { readonly _tag: "ToggleAuto"; readonly goal?: string; readonly maxIterations?: number },
) => {
  switch (intent._tag) {
    case "StartAuto":
      return runtime.send(
        sessionId,
        AutoProtocol.StartAuto({ goal: intent.goal, maxIterations: intent.maxIterations }),
        branchId,
      )
    case "CancelAuto":
      return runtime.send(sessionId, AutoProtocol.CancelAuto(), branchId)
    case "ToggleAuto":
      return runtime.send(
        sessionId,
        AutoProtocol.ToggleAuto({ goal: intent.goal, maxIterations: intent.maxIterations }),
        branchId,
      )
  }
}

const checkpointSignal = (output: Record<string, unknown>) =>
  new ToolCallSucceeded({
    sessionId,
    branchId,
    toolCallId: ToolCallId.of("tc-checkpoint"),
    toolName: "auto_checkpoint",
    output: JSON.stringify(output),
  })

const reviewSignal = () =>
  new ToolCallSucceeded({
    sessionId,
    branchId,
    toolCallId: ToolCallId.of("tc-review"),
    toolName: "review",
  })

const turnCompleted = () => new TurnCompleted({ sessionId, branchId, durationMs: 100 })

describe("Auto runtime integration", () => {
  it.live("full lifecycle: start → checkpoint → review → iterate → complete", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      // Start auto
      yield* sendAuto(runtime, { _tag: "StartAuto", goal: "fix all bugs", maxIterations: 3 })

      const snap1 = yield* getSnapshot(runtime)
      const ui1 = snap1!.model as AutoUiModel
      expect(ui1.active).toBe(true)
      expect(ui1.phase).toBe("working")
      expect(ui1.iteration).toBe(1)

      // Checkpoint with continue → AwaitingReview
      yield* runtime.publish(
        checkpointSignal({ status: "continue", summary: "Found issues", learnings: "auth bad" }),
        { sessionId, branchId },
      )

      const snap2 = yield* getSnapshot(runtime)
      const ui2 = snap2!.model as AutoUiModel
      expect(ui2.phase).toBe("awaiting-review")
      expect(ui2.learningsCount).toBe(1)

      // Counsel → Working (iteration 2)
      yield* runtime.publish(reviewSignal(), { sessionId, branchId })

      const snap3 = yield* getSnapshot(runtime)
      const ui3 = snap3!.model as AutoUiModel
      expect(ui3.phase).toBe("working")
      expect(ui3.iteration).toBe(2)

      // Complete
      yield* runtime.publish(checkpointSignal({ status: "complete", summary: "All fixed" }), {
        sessionId,
        branchId,
      })

      const snap4 = yield* getSnapshot(runtime)
      const ui4 = snap4!.model as AutoUiModel
      expect(ui4.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("TurnCompleted does not advance the loop, only increments watchdog", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendAuto(runtime, { _tag: "StartAuto", goal: "test" })

      // TurnCompleted should not change UI iteration
      yield* runtime.publish(turnCompleted(), { sessionId, branchId })

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoUiModel
      expect(ui.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("cancel mid-working returns to Inactive", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendAuto(runtime, { _tag: "StartAuto", goal: "test" })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: true })

      yield* sendAuto(runtime, { _tag: "CancelAuto" })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: false })
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("cancel from AwaitingReview returns to Inactive", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendAuto(runtime, { _tag: "StartAuto", goal: "test" })

      // Move to AwaitingReview
      yield* runtime.publish(checkpointSignal({ status: "continue", summary: "x" }), {
        sessionId,
        branchId,
      })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ phase: "awaiting-review" })

      yield* sendAuto(runtime, { _tag: "CancelAuto" })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ active: false })
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("wedge prevention: 5 turns without checkpoint → auto-cancel", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendAuto(runtime, { _tag: "StartAuto", goal: "test" })

      // 5 turns without checkpoint
      for (let i = 0; i < 5; i++) {
        yield* runtime.publish(turnCompleted(), { sessionId, branchId })
      }

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoUiModel
      expect(ui.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  // ── Wrong-state regression locks ──
  // `mapEvent` unconditionally maps every `auto_checkpoint`/`review` event;
  // the machine only ignores them via the absence of a handler for
  // (state, event) pairs. These tests pin that contract so a future machine
  // edit cannot accidentally accept them in the wrong phase. (Counsel C8c
  // flagged this gap after the pure-reducer block was deleted.)

  it.live("Inactive ignores all events", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      // Auto starts Inactive — publish a checkpoint, review, and turn
      yield* runtime.publish(checkpointSignal({ status: "continue", summary: "x" }), {
        sessionId,
        branchId,
      })
      yield* runtime.publish(reviewSignal(), { sessionId, branchId })
      yield* runtime.publish(turnCompleted(), { sessionId, branchId })

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoUiModel
      expect(ui.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("unrelated tool does not advance the loop", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendAuto(runtime, { _tag: "StartAuto", goal: "test" })

      // An unrelated tool call must not transition the machine
      yield* runtime.publish(
        new ToolCallSucceeded({
          sessionId,
          branchId,
          toolCallId: ToolCallId.of("tc-unrelated"),
          toolName: "bash",
          output: "{}",
        }),
        { sessionId, branchId },
      )

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoUiModel
      expect(ui.phase).toBe("working")
      expect(ui.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("review while Working is ignored (must checkpoint first)", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendAuto(runtime, { _tag: "StartAuto", goal: "test", maxIterations: 3 })

      // Review fired without a preceding checkpoint — must not advance
      yield* runtime.publish(reviewSignal(), { sessionId, branchId })

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoUiModel
      expect(ui.phase).toBe("working")
      expect(ui.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("checkpoint while AwaitingReview is ignored (must review first)", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendAuto(runtime, { _tag: "StartAuto", goal: "test", maxIterations: 3 })

      // First checkpoint moves to AwaitingReview
      yield* runtime.publish(checkpointSignal({ status: "continue", summary: "first" }), {
        sessionId,
        branchId,
      })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ phase: "awaiting-review" })

      // Second checkpoint without review — must not advance back to Working
      yield* runtime.publish(checkpointSignal({ status: "continue", summary: "second" }), {
        sessionId,
        branchId,
      })
      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoUiModel
      expect(ui.phase).toBe("awaiting-review")
      expect(ui.iteration).toBe(1)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("maxIterations reached after review → Inactive", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendAuto(runtime, { _tag: "StartAuto", goal: "test", maxIterations: 1 })

      // Checkpoint continue at iteration 1/1
      yield* runtime.publish(checkpointSignal({ status: "continue", summary: "done" }), {
        sessionId,
        branchId,
      })
      expect((yield* getSnapshot(runtime))!.model).toMatchObject({ phase: "awaiting-review" })

      // Counsel at max → should go Inactive, not Working
      yield* runtime.publish(reviewSignal(), { sessionId, branchId })

      const snap = yield* getSnapshot(runtime)
      const ui = snap!.model as AutoUiModel
      expect(ui.active).toBe(false)
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("persistence: state survives actor hydration", () =>
    Effect.gen(function* () {
      const storage = yield* Storage

      const autoState: AutoState = {
        _tag: "Working",
        iteration: 3,
        maxIterations: 10,
        goal: "audit security",
        learnings: [
          { iteration: 1, content: "found XSS" },
          { iteration: 2, content: "fixed XSS" },
        ],
        metrics: [],
        turnsSinceCheckpoint: 1,
      }
      yield* storage.saveExtensionState({
        sessionId,
        extensionId: AUTO_EXTENSION_ID,
        stateJson: JSON.stringify(autoState),
        version: 5,
      })

      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      const snap = yield* getSnapshot(runtime)
      expect(snap).toBeDefined()
      expect(snap!.epoch).toBe(5)
      const ui = snap!.model as AutoUiModel
      expect(ui.active).toBe(true)
      expect(ui.iteration).toBe(3)
      expect(ui.learningsCount).toBe(2)
      expect(ui.goal).toBe("audit security")
    }).pipe(Effect.provide(makeLayer())),
  )

  it.live("derive injects learnings into prompt sections", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      yield* sendAuto(runtime, { _tag: "StartAuto", goal: "audit" })

      // Checkpoint with learnings
      yield* runtime.publish(
        checkpointSignal({
          status: "continue",
          summary: "found issues",
          learnings: "SQL injection in user service",
        }),
        { sessionId, branchId },
      )

      // Move to next iteration
      yield* runtime.publish(reviewSignal(), { sessionId, branchId })

      // Check prompt sections have the learning
      const projections = yield* runtime.deriveAll(sessionId, {
        agent: undefined as never,
        allTools: [],
      })
      const pm = projections.find((p) => p.extensionId === AUTO_EXTENSION_ID)
      const section = pm!.projection.promptSections![0]!
      expect(section.content).toContain("SQL injection in user service")
    }).pipe(Effect.provide(makeLayer())),
  )
})

// ── JSONL replay tests ──

describe("Auto JSONL replay via onInit", () => {
  const parentId = SessionId.of("parent-session")
  const childId = SessionId.of("child-session")
  const childBranchId = BranchId.of("child-branch")

  /** Build a mock AutoJournal that returns pre-built rows */
  const mockJournal = (rows: JournalRow[], originSessionId?: string) =>
    Layer.succeed(AutoJournal, {
      start: () => Effect.succeed("/tmp/test.jsonl"),
      appendCheckpoint: () => Effect.void,
      appendReview: () => Effect.void,
      finish: () => Effect.void,
      readActive: () =>
        Effect.succeed({
          rows,
          path: "/tmp/test.jsonl",
          sessionId: originSessionId,
        }),
      getActivePath: () => Effect.succeed("/tmp/test.jsonl" as string | undefined),
    })

  const makeReplayLayer = (rows: JournalRow[], originSessionId?: string) =>
    Layer.mergeAll(
      WorkflowRuntime.Live([autoExtension]).pipe(Layer.provideMerge(ExtensionTurnControl.Test())),
      EventStore.Memory,
      Storage.Test(),
      mockJournal(rows, originSessionId),
    )

  const getAutoSnapshot = (runtime: WorkflowRuntime) =>
    Effect.gen(function* () {
      const snapshots = yield* runtime.getUiSnapshots(childId, childBranchId)
      return snapshots.find((s) => s.extensionId === AUTO_EXTENSION_ID)
    })

  it.live("replays config + checkpoint + review → correct iteration", () =>
    Effect.gen(function* () {
      const storage = yield* Storage

      // Create parent → child session chain
      const now = new Date()
      yield* storage.createSession(new Session({ id: parentId, createdAt: now, updatedAt: now }))
      yield* storage.createSession(
        new Session({ id: childId, parentSessionId: parentId, createdAt: now, updatedAt: now }),
      )

      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId: childId, branchId: childBranchId }), {
        sessionId: childId,
        branchId: childBranchId,
      })

      const snap = yield* getAutoSnapshot(runtime)
      expect(snap).toBeDefined()
      const ui = snap!.model as AutoUiModel
      // After replay: config → Working(1), checkpoint(continue) → AwaitingReview(1),
      // review → Working(2)
      expect(ui.active).toBe(true)
      expect(ui.phase).toBe("working")
      expect(ui.iteration).toBe(2)
      expect(ui.goal).toBe("fix all bugs")
      expect(ui.learningsCount).toBe(1)
    }).pipe(
      Effect.provide(
        makeReplayLayer(
          [
            { type: "config", goal: "fix all bugs", maxIterations: 5, startedAt: Date.now() },
            {
              type: "checkpoint",
              iteration: 1,
              status: "continue",
              summary: "Found 3 issues",
              learnings: "Auth needs refactor",
            },
            { type: "review", iteration: 1 },
          ],
          parentId,
        ),
      ),
    ),
  )

  it.live("root session never replays journal", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const now = new Date()
      yield* storage.createSession(new Session({ id: parentId, createdAt: now, updatedAt: now }))

      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId: parentId, branchId }), {
        sessionId: parentId,
        branchId,
      })

      const snapshots = yield* runtime.getUiSnapshots(parentId, branchId)
      const autoSnap = snapshots.find((s) => s.extensionId === AUTO_EXTENSION_ID)
      expect(autoSnap).toBeDefined()
      const ui = autoSnap!.model as AutoUiModel
      expect(ui.active).toBe(false) // Not replayed — root session
    }).pipe(
      Effect.provide(
        makeReplayLayer(
          [{ type: "config", goal: "should not replay", maxIterations: 3, startedAt: Date.now() }],
          parentId,
        ),
      ),
    ),
  )

  it.live("unrelated child session does not replay", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const now = new Date()
      // Create two separate lineages
      const otherParentId = SessionId.of("other-parent")
      yield* storage.createSession(
        new Session({ id: otherParentId, createdAt: now, updatedAt: now }),
      )
      yield* storage.createSession(
        new Session({
          id: childId,
          parentSessionId: otherParentId,
          createdAt: now,
          updatedAt: now,
        }),
      )

      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId: childId, branchId: childBranchId }), {
        sessionId: childId,
        branchId: childBranchId,
      })

      const snap = yield* getAutoSnapshot(runtime)
      expect(snap).toBeDefined()
      const ui = snap!.model as AutoUiModel
      expect(ui.active).toBe(false) // Not replayed — ancestry doesn't match
    }).pipe(
      Effect.provide(
        makeReplayLayer(
          [{ type: "config", goal: "scoped to parentId", maxIterations: 3, startedAt: Date.now() }],
          parentId, // Journal scoped to parentId, but child is under otherParent
        ),
      ),
    ),
  )

  it.live("legacy pointer without sessionId fails closed — no replay", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const now = new Date()
      yield* storage.createSession(new Session({ id: parentId, createdAt: now, updatedAt: now }))
      yield* storage.createSession(
        new Session({ id: childId, parentSessionId: parentId, createdAt: now, updatedAt: now }),
      )

      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new SessionStarted({ sessionId: childId, branchId: childBranchId }), {
        sessionId: childId,
        branchId: childBranchId,
      })

      const snap = yield* getAutoSnapshot(runtime)
      expect(snap).toBeDefined()
      const ui = snap!.model as AutoUiModel
      expect(ui.active).toBe(false) // Not replayed — no sessionId in pointer = fail closed
    }).pipe(
      Effect.provide(
        makeReplayLayer(
          [{ type: "config", goal: "legacy pointer", maxIterations: 3, startedAt: Date.now() }],
          undefined, // No sessionId — simulates legacy active.json without scoping
        ),
      ),
    ),
  )
})
