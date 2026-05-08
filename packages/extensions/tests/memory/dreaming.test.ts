import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { MemoryExtension } from "../../src/memory/index.js"
import { testSetupCtx } from "@gent/core-internal/test-utils"

describe("memory scheduled jobs", () => {
  it.live("declares durable scheduled jobs separately from Resources", () =>
    Effect.gen(function* () {
      const contributions = yield* MemoryExtension.setup(
        testSetupCtx({ cwd: "/repo", home: "/home/test", source: "builtin" }),
      )

      const resources = contributions.resources ?? []
      expect(resources.every((r) => r.start === undefined && r.stop === undefined)).toBe(true)
      const schedules = contributions.scheduledJobs ?? []
      expect(schedules.map((s) => s.id)).toEqual(["reflect", "meditate"])
      expect(schedules.every((s) => s.target.agent.startsWith("memory:"))).toBe(true)
      expect(schedules.every((s) => s.target.cwd === undefined)).toBe(true)
    }),
  )
})
