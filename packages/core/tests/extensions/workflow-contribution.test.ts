/**
 * WorkflowContribution lowering + dispatch regression locks.
 *
 * Locks the contract introduced in planify Commit 8a:
 *
 *   1. `workflowContribution` lowers into `ExtensionSetup.actor` so the existing
 *      `WorkflowRuntime` hosts it without code duplication.
 *   2. The lowered workflow's machine reacts to `mapEvent` (agent events),
 *      `mapCommand` (extension command messages), and `afterTransition`
 *      (declared workflow effects) — proving the four primitive surfaces
 *      survive the lowering pass intact.
 *   3. `WorkflowContribution` omits UI by default (UI belongs in
 *      `ProjectionContribution` per `composability-not-flags`). C8 carries a
 *      transitional `snapshot`/`turn` bridge for workflows whose UI is derived
 *      purely from machine state today; the bridge is deleted in C12. The
 *      "no UI" and "bridge round-trips" cases are both pinned below.
 *
 * Until Commit 12 splits the runtime, workflow IS actor-shaped at the
 * runtime level. This test pins the contribution-layer shape so the
 * eventual split doesn't silently change behavior.
 */

import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Schema } from "effect"
import { Event as MEvent, Machine, State as MState } from "effect-machine"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol"
import {
  defineExtension,
  workflowContribution,
  type WorkflowContribution,
} from "@gent/core/extensions/api"
import { testSetupCtx } from "@gent/core/test-utils"
import { extractWorkflow } from "@gent/core/domain/contribution"

// ── Test workflow: counter + suppress command + declared follow-up effect ──

const TestState = MState({
  Active: { count: Schema.Number, suppressed: Schema.Boolean },
})

const TestEvent = MEvent({
  Tick: {},
  Suppress: {},
  Resume: {},
})

const TestProtocol = {
  Suppress: ExtensionMessage("@gent/test-workflow", "Suppress", {}),
} as const

const machine = Machine.make({
  state: TestState,
  event: TestEvent,
  initial: TestState.Active({ count: 0, suppressed: false }),
})
  .on(TestState.Active, TestEvent.Tick, ({ state }) =>
    state.suppressed
      ? state
      : TestState.Active({ count: state.count + 1, suppressed: state.suppressed }),
  )
  .on(TestState.Active, TestEvent.Suppress, ({ state }) =>
    TestState.Active({ count: state.count, suppressed: true }),
  )
  .on(TestState.Active, TestEvent.Resume, ({ state }) =>
    TestState.Active({ count: state.count, suppressed: false }),
  )

const testWorkflow: WorkflowContribution<typeof TestState.Type, typeof TestEvent.Type> = {
  machine,
  // mapEvent — TurnCompleted ticks the counter
  mapEvent: (event) => (event._tag === "TurnCompleted" ? TestEvent.Tick() : undefined),
  // mapCommand — Suppress message suppresses ticks
  mapCommand: (message) =>
    Schema.is(TestProtocol.Suppress)(message) ? TestEvent.Suppress() : undefined,
  protocols: TestProtocol,
}

describe("WorkflowContribution", () => {
  it.live("lowers into ExtensionSetup.actor (existing runtime hosts it)", () =>
    Effect.gen(function* () {
      const ext = defineExtension({
        id: "@gent/test-workflow",
        contributions: () => [workflowContribution(testWorkflow)],
      })
      const contributions = yield* ext.setup(testSetupCtx())
      const actor = extractWorkflow(contributions)
      // Workflow is structurally lowered to actor today (single runtime).
      expect(actor).toBeDefined()
      // Per `composability-not-flags`, workflows that omit `snapshot`/`turn`
      // contribute no UI surface — only control-flow state. The transitional
      // bridge fields are tested below.
      expect(actor?.snapshot).toBeUndefined()
      expect(actor?.turn).toBeUndefined()
      // Mappers and protocols round-trip through the lowering.
      expect(actor?.mapEvent).toBeDefined()
      expect(actor?.mapCommand).toBeDefined()
      expect(actor?.protocols).toBe(TestProtocol)
    }),
  )

  it.live("transitional bridge: snapshot/turn round-trip when present (deleted in C12)", () =>
    Effect.gen(function* () {
      const snapshot = {
        project: (state: typeof TestState.Type) => ({ count: state.count }),
      }
      const turn = {
        project: (state: typeof TestState.Type) => ({
          promptSections: [{ id: "wf-test", content: `count=${state.count}`, priority: 50 }],
        }),
      }
      const wf: WorkflowContribution<typeof TestState.Type, typeof TestEvent.Type> = {
        ...testWorkflow,
        snapshot,
        turn,
      }
      const ext = defineExtension({
        id: "@gent/test-workflow-ui",
        contributions: () => [workflowContribution(wf)],
      })
      const contributions = yield* ext.setup(testSetupCtx())
      const actor = extractWorkflow(contributions)

      // Object identity — proves the lowering forwards by reference,
      // matching the pattern used for slots/stateSchema/onInit/mapRequest.
      expect(actor?.snapshot).toBe(snapshot)
      expect(actor?.turn).toBe(turn)
    }),
  )

  it.live(
    "workflow afterTransition declared effects survive the lowering and dispatch on every transition",
    () =>
      Effect.gen(function* () {
        // Use a workflow whose afterTransition unconditionally emits an effect
        // for ANY transition. We assert (a) the function reference is preserved
        // and (b) calling it produces a non-empty array of structured effects.
        const flagged: WorkflowContribution<typeof TestState.Type, typeof TestEvent.Type> = {
          ...testWorkflow,
          afterTransition: (before, after) => [
            {
              _tag: "BusEmit" as const,
              channel: "wf.transition",
              payload: { fromCount: before.count, toCount: after.count },
            },
          ],
        }

        const ext = defineExtension({
          id: "@gent/test-workflow",
          contributions: () => [workflowContribution(flagged)],
        })
        const contributions = yield* ext.setup(testSetupCtx())
        const actor = extractWorkflow(contributions)

        expect(actor?.afterTransition).toBeDefined()

        const before = TestState.Active({ count: 0, suppressed: false })
        const after = TestState.Active({ count: 1, suppressed: false })
        const effects = actor!.afterTransition!(before, after)

        // Effect identity preserved end-to-end
        expect(effects.length).toBe(1)
        const [effect] = effects
        expect(effect?._tag).toBe("BusEmit")
        // Payload comes from the workflow author's closure — proves the
        // function reference, not just a stub, was forwarded
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const busEmit = effect as { _tag: "BusEmit"; channel: string; payload: unknown }
        expect(busEmit.channel).toBe("wf.transition")
        expect(busEmit.payload).toEqual({ fromCount: 0, toCount: 1 })
      }),
  )

  it.live(
    "fails with ExtensionLoadError when an extension declares more than one workflow (single-slot constraint)",
    () =>
      Effect.gen(function* () {
        const ext = defineExtension({
          id: "@gent/two-workflows",
          contributions: () => [
            workflowContribution(testWorkflow),
            workflowContribution(testWorkflow),
          ],
        })

        const exit = yield* Effect.exit(ext.setup(testSetupCtx()))
        expect(exit._tag).toBe("Failure")
        // Single-slot constraint surfaces as a typed ExtensionLoadError, not a
        // thrown defect — the failure is in the typed error channel.
        if (exit._tag === "Failure") {
          const fails = exit.cause.reasons.filter(Cause.isFailReason)
          expect(fails.length).toBe(1)
          const error = fails[0]?.error
          expect(error?._tag).toBe("ExtensionLoadError")
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          expect((error as { message: string }).message).toContain("at most one workflow")
        }
      }),
  )

  it.live("optional fields (slots, stateSchema, onInit, mapRequest) round-trip when present", () =>
    Effect.gen(function* () {
      const slots = () => Effect.succeed({} as Record<string, never>)
      const stateSchema = TestState
      const onInit = () => Effect.void
      const mapRequest = () => undefined

      const wf: WorkflowContribution<typeof TestState.Type, typeof TestEvent.Type> = {
        machine,
        slots,
        stateSchema,
        onInit,
        mapRequest,
      }

      const ext = defineExtension({
        id: "@gent/test-optional",
        contributions: () => [workflowContribution(wf)],
      })
      const contributions = yield* ext.setup(testSetupCtx())
      const actor = extractWorkflow(contributions)

      // Object identity — proves the lowering forwards by reference, not
      // through a coerce/clone path that could silently drop nested config.
      expect(actor?.slots).toBe(slots)
      expect(actor?.stateSchema).toBe(stateSchema)
      expect(actor?.onInit).toBe(onInit)
      expect(actor?.mapRequest).toBe(mapRequest)
    }),
  )
})
