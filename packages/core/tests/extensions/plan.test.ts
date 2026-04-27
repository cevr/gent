import { describe, test, expect } from "effect-bun-test"
import { Effect } from "effect"
import { PlanExtension, PLAN_EXTENSION_ID } from "@gent/extensions/plan"
import { testSetupCtx } from "@gent/core/test-utils"
import { modelCapabilities } from "@gent/core/domain/contribution"

describe("Plan extension", () => {
  test("has correct extension ID", () => {
    expect(PlanExtension.manifest.id).toBe(PLAN_EXTENSION_ID)
    expect(PLAN_EXTENSION_ID).toBe("@gent/plan")
  })

  test("registers plan tool", () =>
    Effect.gen(function* () {
      const contributions = yield* PlanExtension.setup(testSetupCtx())
      // W10-3b: tool({...}) outputs slot into the typed `tools:` bucket.
      const toolIds = modelCapabilities(contributions).map((cap) => cap.id)
      expect(toolIds).toContain("plan")
    }).pipe(Effect.runPromise))

  test("has no actor (tool-only extension)", () =>
    Effect.gen(function* () {
      const contributions = yield* PlanExtension.setup(testSetupCtx())
      const machine = (contributions.resources ?? []).find((r) => r.machine !== undefined)?.machine
      expect(machine).toBeUndefined()
    }).pipe(Effect.runPromise))
})
