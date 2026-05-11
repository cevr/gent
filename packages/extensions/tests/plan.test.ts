import { describe, expect, it, test } from "effect-bun-test"
import { Effect } from "effect"
import { PlanExtension, PLAN_EXTENSION_ID } from "../src/plan.js"
import { provideTestSetupContext } from "@gent/core-internal/test-utils"
import { modelCapabilities } from "@gent/core-internal/domain/contribution"
import { getToolId } from "@gent/core/extensions/api"

describe("Plan extension", () => {
  test("has correct extension ID", () => {
    expect(PlanExtension.manifest.id).toBe(PLAN_EXTENSION_ID)
    expect(PLAN_EXTENSION_ID as string).toBe("@gent/plan")
  })

  it.live("registers plan tool", () =>
    Effect.gen(function* () {
      const contributions = yield* PlanExtension.setup.pipe(provideTestSetupContext())
      // tool({...}) outputs slot into the typed `tools:` bucket.
      const toolIds = modelCapabilities(contributions).map((cap) => String(getToolId(cap)))
      expect(toolIds).toContain("plan")
    }),
  )

  it.live("has no resources (tool-only extension)", () =>
    Effect.gen(function* () {
      const contributions = yield* PlanExtension.setup.pipe(provideTestSetupContext())
      expect(contributions.resources ?? []).toEqual([])
    }),
  )
})
