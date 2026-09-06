import { describe, it, expect } from "effect-bun-test"
import { Effect, Option } from "effect"
import { MemoryExtension } from "../../src/memory/index.js"
import { provideTestSetupContext } from "@gent/core-internal/test-utils"

describe("memory scheduled jobs", () => {
  it.live("declares durable scheduled jobs separately from Resources", () =>
    Effect.gen(function* () {
      const contributions = yield* MemoryExtension.setup.pipe(
        provideTestSetupContext({ cwd: "/repo", home: "/home/test", source: "builtin" }),
      )

      const resources = contributions.resources ?? []
      expect(
        resources.every(
          (r) =>
            Option.isNone(Option.fromUndefinedOr(r.start)) &&
            Option.isNone(Option.fromUndefinedOr(r.stop)),
        ),
      ).toBe(true)
      const schedules = contributions.scheduledJobs ?? []
      expect(schedules.map((s) => s.id)).toEqual(["reflect", "meditate"])
      expect(schedules.every((s) => s.target.agent.startsWith("memory:"))).toBe(true)
      expect(schedules.every((s) => Option.isNone(Option.fromUndefinedOr(s.target.cwd)))).toBe(true)
    }),
  )
})
