/**
 * C8 migration shape — regression locks for `defineExtension` adopters.
 *
 * Counsel C8d flagged that the C8 wave migrated four concrete extensions to
 * `defineExtension({ contributions })` without tests asserting their lowered
 * `Contribution[]` shape. The generic substrate is covered by
 * `define-extension.test.ts` and `workflow-contribution.test.ts`; this file
 * pins what the migrated consumers actually contribute. If a future refactor
 * accidentally drops a contribution kind from these extensions, this fails
 * before any runtime test does.
 *
 * Coverage:
 *  - `MemoryExtension`     — workflow + projection + tools + agents + layer + jobs
 *  - `AcpAgentsExtension`  — agents + externalDrivers + onShutdown
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
import {
  extractAgents,
  extractExternalDrivers,
  extractInterceptors,
  extractJobs,
  extractLayer,
  extractLifecycle,
  extractProjections,
  extractTools,
  extractWorkflow,
} from "@gent/core/domain/contribution"

describe("C8 migration shape", () => {
  it.live("MemoryExtension lowers into workflow + projection + tools + agents + layer + jobs", () =>
    Effect.gen(function* () {
      const contributions = yield* MemoryExtension.setup(testSetupCtx())
      const workflow = extractWorkflow(contributions)
      expect(workflow).toBeDefined()
      expect(workflow?.machine).toBeDefined()
      // Memory's session state survives as a workflow with `turn.project` (the
      // C8 transitional bridge for `composability-not-flags`-pure projections).
      expect(workflow?.turn).toBeDefined()
      // Vault is the durable UI surface — owned by a projection, not the actor.
      expect(workflow?.snapshot).toBeUndefined()
      expect(extractProjections(contributions).length).toBeGreaterThan(0)
      expect(extractTools(contributions).length).toBeGreaterThan(0)
      expect(extractAgents(contributions).length).toBeGreaterThan(0)
      expect(extractLayer(contributions)).toBeDefined()
      expect(extractJobs(contributions).length).toBeGreaterThan(0)
    }),
  )

  it.live("AcpAgentsExtension lowers into agents + externalDrivers + onShutdown", () =>
    Effect.gen(function* () {
      const contributions = yield* AcpAgentsExtension.setup(testSetupCtx())
      // No actor — ACP "session manager" is a per-process resource cache.
      expect(extractWorkflow(contributions)).toBeUndefined()
      // Agents and external drivers come in matching pairs (one per ACP_AGENTS entry).
      const agents = extractAgents(contributions)
      const externalDrivers = extractExternalDrivers(contributions)
      expect(agents.length).toBeGreaterThan(0)
      expect(externalDrivers.length).toBeGreaterThan(0)
      expect(agents.length).toBe(externalDrivers.length)
      // Subprocess shutdown is registered as a finalizer.
      expect(extractLifecycle(contributions, "shutdown").length).toBeGreaterThan(0)
    }),
  )

  it.live("HandoffExtension lowers into workflow + tool + turn.after interceptor", () =>
    Effect.gen(function* () {
      const contributions = yield* HandoffExtension.setup(testSetupCtx())
      const workflow = extractWorkflow(contributions)
      expect(workflow).toBeDefined()
      // Cooldown workflow has no UI — handoff state is invisible to the user;
      // the reply protocol exposes it for interceptor self-reads only.
      expect(workflow?.snapshot).toBeUndefined()
      expect(workflow?.turn).toBeUndefined()
      expect(extractTools(contributions).length).toBeGreaterThan(0)
      // turn.after interceptor (auto-handoff at context-fill threshold)
      const interceptors = extractInterceptors(contributions)
      expect(interceptors.some((i) => i.key === "turn.after")).toBe(true)
    }),
  )

  it.live(
    "AutoExtension lowers into workflow (with transitional bridge) + tool + 2 interceptors + layer",
    () =>
      Effect.gen(function* () {
        const contributions = yield* AutoExtension.setup(testSetupCtx())
        const workflow = extractWorkflow(contributions)
        expect(workflow).toBeDefined()
        // Auto's UI is derived from machine state (active/phase/iteration/goal),
        // so the C8 transitional `snapshot`/`turn` bridge IS present here. C12
        // moves these into a `ProjectionContribution` and removes the bridge.
        expect(workflow?.snapshot).toBeDefined()
        expect(workflow?.turn).toBeDefined()
        expect(extractTools(contributions).length).toBeGreaterThan(0)
        // tool.result (journal) + turn.after (handoff request) interceptors
        const keys = extractInterceptors(contributions).map((i) => i.key)
        expect(keys).toContain("tool.result")
        expect(keys).toContain("turn.after")
        expect(extractLayer(contributions)).toBeDefined()
      }),
  )
})
