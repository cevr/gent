/**
 * C8 migration shape — regression locks for `defineExtension` adopters.
 *
 * Counsel C8d flagged that the C8 wave migrated four concrete extensions to
 * `defineExtension({ contributions })` without tests asserting their lowered
 * `ExtensionSetup` shape. The generic substrate is covered by
 * `define-extension.test.ts` and `workflow-contribution.test.ts`; this file
 * pins what the migrated consumers actually contribute. If a future refactor
 * accidentally drops a contribution kind from these extensions, this fails
 * before any runtime test does.
 *
 * Coverage:
 *  - `MemoryExtension`     — workflow + projection + tools + agents + layer + jobs
 *  - `AcpAgentsExtension`  — agents + turnExecutors + onShutdown
 *  - `HandoffExtension`    — workflow + tool + interceptor (turn.after)
 *  - `AutoExtension`       — workflow (with transitional snapshot/turn) + tool +
 *                            two interceptors + layer
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { testSetupCtx } from "@gent/core/test-utils"
import { MemoryExtension } from "@gent/extensions/memory"
import { AcpAgentsExtension } from "@gent/extensions/acp-agents"
import { HandoffExtension } from "@gent/extensions/handoff"
import { AutoExtension } from "@gent/extensions/auto"

describe("C8 migration shape", () => {
  it.live("MemoryExtension lowers into workflow + projection + tools + agents + layer + jobs", () =>
    Effect.gen(function* () {
      const setup = yield* MemoryExtension.setup(testSetupCtx())
      expect(setup.actor).toBeDefined()
      expect(setup.actor?.machine).toBeDefined()
      // Memory's session state survives as a workflow with `turn.project` (the
      // C8 transitional bridge for `composability-not-flags`-pure projections).
      expect(setup.actor?.turn).toBeDefined()
      // Vault is the durable UI surface — owned by a projection, not the actor.
      expect(setup.actor?.snapshot).toBeUndefined()
      expect(setup.projections?.length ?? 0).toBeGreaterThan(0)
      expect((setup.tools?.length ?? 0) > 0).toBe(true)
      expect((setup.agents?.length ?? 0) > 0).toBe(true)
      expect(setup.layer).toBeDefined()
      expect((setup.jobs?.length ?? 0) > 0).toBe(true)
    }),
  )

  it.live("AcpAgentsExtension lowers into agents + turnExecutors + onShutdown", () =>
    Effect.gen(function* () {
      const setup = yield* AcpAgentsExtension.setup(testSetupCtx())
      // No actor — ACP "session manager" is a per-process resource cache.
      expect(setup.actor).toBeUndefined()
      // Agents and turn executors come in matching pairs (one per ACP_AGENTS entry).
      expect((setup.agents?.length ?? 0) > 0).toBe(true)
      expect((setup.turnExecutors?.length ?? 0) > 0).toBe(true)
      expect(setup.agents?.length).toBe(setup.turnExecutors?.length)
      // Subprocess shutdown is registered as a finalizer.
      expect(setup.onShutdown).toBeDefined()
    }),
  )

  it.live("HandoffExtension lowers into workflow + tool + turn.after interceptor", () =>
    Effect.gen(function* () {
      const setup = yield* HandoffExtension.setup(testSetupCtx())
      expect(setup.actor).toBeDefined()
      // Cooldown workflow has no UI — handoff state is invisible to the user;
      // the reply protocol exposes it for interceptor self-reads only.
      expect(setup.actor?.snapshot).toBeUndefined()
      expect(setup.actor?.turn).toBeUndefined()
      expect((setup.tools?.length ?? 0) > 0).toBe(true)
      // turn.after interceptor (auto-handoff at context-fill threshold)
      const interceptors = setup.hooks?.interceptors ?? []
      expect(interceptors.some((i) => i.key === "turn.after")).toBe(true)
    }),
  )

  it.live(
    "AutoExtension lowers into workflow (with transitional bridge) + tool + 2 interceptors + layer",
    () =>
      Effect.gen(function* () {
        const setup = yield* AutoExtension.setup(testSetupCtx())
        expect(setup.actor).toBeDefined()
        // Auto's UI is derived from machine state (active/phase/iteration/goal),
        // so the C8 transitional `snapshot`/`turn` bridge IS present here. C12
        // moves these into a `ProjectionContribution` and removes the bridge.
        expect(setup.actor?.snapshot).toBeDefined()
        expect(setup.actor?.turn).toBeDefined()
        expect((setup.tools?.length ?? 0) > 0).toBe(true)
        // tool.result (journal) + turn.after (handoff request) interceptors
        const keys = (setup.hooks?.interceptors ?? []).map((i) => i.key)
        expect(keys).toContain("tool.result")
        expect(keys).toContain("turn.after")
        expect(setup.layer).toBeDefined()
      }),
  )
})
