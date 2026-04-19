import { describe, test, expect } from "effect-bun-test"
import { Effect } from "effect"
import { PlanExtension, PLAN_EXTENSION_ID } from "@gent/extensions/plan"
import { testSetupCtx } from "@gent/core/test-utils"
import { extractCapabilities, extractMachine } from "@gent/core/domain/contribution"

describe("Plan extension", () => {
  test("has correct extension ID", () => {
    expect(PlanExtension.manifest.id).toBe(PLAN_EXTENSION_ID)
    expect(PLAN_EXTENSION_ID).toBe("@gent/plan")
  })

  test("registers plan tool", () =>
    Effect.gen(function* () {
      const contributions = yield* PlanExtension.setup(testSetupCtx())
      // After C4.4, `tool(...)` lowers to a Capability(audiences:["model"]).
      const toolIds = extractCapabilities(contributions)
        .filter((cap) => cap.audiences.includes("model"))
        .map((cap) => cap.id)
      expect(toolIds).toContain("plan")
    }).pipe(Effect.runPromise))

  test("has no actor (tool-only extension)", () =>
    Effect.gen(function* () {
      const contributions = yield* PlanExtension.setup(testSetupCtx())
      expect(extractMachine(contributions)).toBeUndefined()
    }).pipe(Effect.runPromise))
})
