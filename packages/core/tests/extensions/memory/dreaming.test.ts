import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { MemoryExtension } from "@gent/extensions/memory"
import { testSetupCtx } from "@gent/core/test-utils"
import { extractJobs, extractLifecycle } from "@gent/core/domain/contribution"

describe("memory scheduled jobs", () => {
  it.live("declares durable jobs instead of startup hooks", () =>
    Effect.gen(function* () {
      const contributions = yield* MemoryExtension.setup(
        testSetupCtx({ cwd: "/repo", home: "/home/test", source: "builtin" }),
      )

      expect(extractLifecycle(contributions, "startup")).toEqual([])
      expect(extractLifecycle(contributions, "shutdown")).toEqual([])
      const jobs = extractJobs(contributions)
      expect(jobs.map((job) => job.id)).toEqual(["reflect", "meditate"])
      expect(jobs.every((job) => job.target.kind === "headless-agent")).toBe(true)
      expect(jobs.every((job) => job.target.cwd === undefined)).toBe(true)
    }),
  )
})
