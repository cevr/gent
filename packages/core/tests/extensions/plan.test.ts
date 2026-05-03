import { describe, test, expect } from "effect-bun-test"
import { Effect } from "effect"
import { PlanExtension, PLAN_EXTENSION_ID } from "@gent/extensions/plan"
import { testSetupCtx } from "@gent/core/test-utils"
import { modelCapabilities } from "@gent/core/domain/contribution"
import { getToolId } from "@gent/core/extensions/api"

describe("Plan extension", () => {
  test("has correct extension ID", () => {
    expect(PlanExtension.manifest.id).toBe(PLAN_EXTENSION_ID)
    expect(PLAN_EXTENSION_ID as string).toBe("@gent/plan")
  })

  test("registers plan tool", () =>
    Effect.gen(function* () {
      const contributions = yield* PlanExtension.setup(testSetupCtx())
      // tool({...}) outputs slot into the typed `tools:` bucket.
      const toolIds = modelCapabilities(contributions).map((cap) => String(getToolId(cap)))
      expect(toolIds).toContain("plan")
    }).pipe(Effect.runPromise))

  test("has no resources (tool-only extension)", () =>
    Effect.gen(function* () {
      const contributions = yield* PlanExtension.setup(testSetupCtx())
      expect(contributions.resources ?? []).toEqual([])
    }).pipe(Effect.runPromise))
})
