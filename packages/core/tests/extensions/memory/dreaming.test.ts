import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { MemoryExtension } from "@gent/extensions/memory"
import { testSetupCtx } from "@gent/core/test-utils"
import { extractResources } from "@gent/core/domain/contribution"

describe("memory scheduled jobs", () => {
  it.live("declares durable schedules on a Resource", () =>
    Effect.gen(function* () {
      const contributions = yield* MemoryExtension.setup(
        testSetupCtx({ cwd: "/repo", home: "/home/test", source: "builtin" }),
      )

      const resources = extractResources(contributions)
      expect(resources.every((r) => r.start === undefined && r.stop === undefined)).toBe(true)
      const schedules = resources.flatMap((r) => r.schedule ?? [])
      expect(schedules.map((s) => s.id)).toEqual(["reflect", "meditate"])
      expect(schedules.every((s) => s.target.kind === "headless-agent")).toBe(true)
      expect(schedules.every((s) => s.target.cwd === undefined)).toBe(true)
    }),
  )
})
