import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { MemoryExtension } from "@gent/extensions/memory"
import { testSetupCtx } from "@gent/core/test-utils"
import { extractLifecycle, extractResources } from "@gent/core/domain/contribution"

describe("memory scheduled jobs", () => {
  it.live("declares durable schedules on a Resource instead of startup hooks", () =>
    Effect.gen(function* () {
      const contributions = yield* MemoryExtension.setup(
        testSetupCtx({ cwd: "/repo", home: "/home/test", source: "builtin" }),
      )

      expect(extractLifecycle(contributions, "startup")).toEqual([])
      expect(extractLifecycle(contributions, "shutdown")).toEqual([])
      const schedules = extractResources(contributions).flatMap((r) => r.schedule ?? [])
      expect(schedules.map((s) => s.id)).toEqual(["reflect", "meditate"])
      expect(schedules.every((s) => s.target.kind === "headless-agent")).toBe(true)
      expect(schedules.every((s) => s.target.cwd === undefined)).toBe(true)
    }),
  )
})
