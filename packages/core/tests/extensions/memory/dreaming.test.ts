import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { MemoryExtension } from "@gent/core/extensions/memory"

describe("memory scheduled jobs", () => {
  it.live("declares durable jobs instead of startup hooks", () =>
    Effect.gen(function* () {
      const setup = yield* MemoryExtension.setup({
        cwd: "/repo",
        home: "/home/test",
        source: "builtin",
      })

      expect(setup.onStartup).toBeUndefined()
      expect(setup.onShutdown).toBeUndefined()
      expect(setup.scheduledJobs?.map((job) => job.id)).toEqual(["reflect", "meditate"])
      expect(setup.scheduledJobs?.every((job) => job.target.kind === "headless-agent")).toBe(true)
      expect(setup.scheduledJobs?.every((job) => job.target.cwd === undefined)).toBe(true)
    }),
  )
})
