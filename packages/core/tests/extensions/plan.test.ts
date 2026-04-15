import { describe, test, expect } from "effect-bun-test"
import { Effect } from "effect"
import { PlanExtension, PLAN_EXTENSION_ID } from "@gent/core/extensions/plan"
import { testSetupCtx } from "@gent/core/test-utils"

describe("Plan extension", () => {
  test("has correct extension ID", () => {
    expect(PlanExtension.manifest.id).toBe(PLAN_EXTENSION_ID)
    expect(PLAN_EXTENSION_ID).toBe("@gent/plan")
  })

  test("registers plan tool", () =>
    Effect.gen(function* () {
      const setup = yield* PlanExtension.setup(testSetupCtx())
      const toolNames = setup.tools.map((t) => t.name)
      expect(toolNames).toContain("plan")
    }).pipe(Effect.runPromise))

  test("has no actor (tool-only extension)", () =>
    Effect.gen(function* () {
      const setup = yield* PlanExtension.setup(testSetupCtx())
      expect(setup.actor).toBeUndefined()
    }).pipe(Effect.runPromise))
})
