import { BunFileSystem } from "@effect/platform-bun"
import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import type { LoadedExtension } from "../../src/domain/extension.js"
import {
  reconcileScheduledJobs,
  collectSchedules,
  type CronRuntimeShape,
} from "../../src/runtime/extensions/resource-host/schedule-engine"
import type { ScheduledJobContribution } from "@gent/core-internal/domain/scheduled-job"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { AgentName } from "@gent/core-internal/domain/agent"

const fsLayer = Layer.merge(BunFileSystem.layer, Path.layer)

const makeLoaded = (
  id: string,
  jobs: ReadonlyArray<ScheduledJobContribution>,
): LoadedExtension => ({
  manifest: { id: ExtensionId.make(id) },
  scope: "builtin",
  sourcePath: "builtin",
  contributions: {
    scheduledJobs: jobs,
  },
})

describe("scheduled jobs", () => {
  it.scopedLive("reconciles desired jobs and removes stale managed jobs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const installs: Array<{ entryPath: string; schedule: string; name: string }> = []
      const removes: string[] = []

      const runtime = {
        install: (entryPath: string, schedule: string, name: string) => {
          installs.push({ entryPath, schedule, name })
          return Effect.void
        },
        remove: (name: string) => {
          removes.push(name)
          return Effect.void
        },
      }

      const extensions = [
        makeLoaded("@gent/memory", [
          {
            id: "reflect",
            cron: "0 21 * * 1-5",
            target: {
              agent: AgentName.make("memory:reflect"),
              prompt: "Reflect on recent sessions.",
              cwd: "/repo",
            },
          },
        ]),
      ]

      const failures = yield* reconcileScheduledJobs({
        extensions,
        home,
        command: ["/usr/local/bin/gent"],
        env: { HOME: home, GENT_DB_PATH: `${home}/data.db` },
        runtime,
      })

      expect(failures).toEqual([])
      expect(installs).toHaveLength(1)
      expect(removes).toEqual([])

      const installed = installs[0]!
      expect(installed.name).toContain("memory")
      const wrapper = yield* fs.readFileString(installed.entryPath)
      expect(wrapper).toContain("/usr/local/bin/gent")
      expect(wrapper).toContain("--headless")
      expect(wrapper).toContain("memory:reflect")
      expect(wrapper).toContain('cwd: "/repo"')

      const statePath = path.join(home, ".gent", "scheduler", "managed-jobs.json")
      const state = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ jobs: Schema.Record(Schema.String, Schema.String) })),
      )(yield* fs.readFileString(statePath))
      expect(Object.keys(state.jobs)).toEqual([installed.name])
      expect(state.jobs[installed.name]).toBe(installed.entryPath)

      const clearedFailures = yield* reconcileScheduledJobs({
        extensions: [],
        home,
        command: ["/usr/local/bin/gent"],
        env: { HOME: home },
        runtime,
      })

      expect(clearedFailures).toEqual([])
      expect(removes).toEqual([installed.name])
      expect(yield* fs.exists(installed.entryPath)).toBe(false)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.scopedLive("scheduler install failure is isolated instead of crashing reconciliation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const runtime: CronRuntimeShape = {
        install: (_entryPath: string, _schedule: string, name: string) => {
          if (name.includes("meditate")) {
            return Effect.die(new Error("cron install boom"))
          }
          return Effect.void
        },
        remove: (_name: string) => Effect.void,
      }

      const failures = yield* reconcileScheduledJobs({
        extensions: [
          makeLoaded("@gent/memory", [
            {
              id: "reflect",
              cron: "0 21 * * 1-5",
              target: {
                agent: AgentName.make("memory:reflect"),
                prompt: "Reflect on recent sessions.",
              },
            },
            {
              id: "meditate",
              cron: "0 9 * * 0",
              target: {
                agent: AgentName.make("memory:meditate"),
                prompt: "Meditate on the memory vault.",
              },
            },
          ]),
        ],
        home,
        command: ["/usr/local/bin/gent"],
        env: { HOME: home },
        runtime,
      })

      expect(failures).toHaveLength(1)
      expect(failures[0]!.extensionId).toBe(ExtensionId.make("@gent/memory"))
      expect(failures[0]!.jobId).toBe("meditate")
      expect(failures[0]!.error).toContain("cron install boom")

      const statePath = path.join(home, ".gent", "scheduler", "managed-jobs.json")
      const state = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ jobs: Schema.Record(Schema.String, Schema.String) })),
      )(yield* fs.readFileString(statePath))
      expect(Object.keys(state.jobs)).toHaveLength(1)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.scopedLive("missing cron runtime reports desired schedules as degraded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()

      const failures = yield* reconcileScheduledJobs({
        extensions: [
          makeLoaded("@gent/memory", [
            {
              id: "reflect",
              cron: "0 21 * * 1-5",
              target: {
                agent: AgentName.make("memory:reflect"),
                prompt: "Reflect on recent sessions.",
              },
            },
          ]),
        ],
        home,
        command: ["/usr/local/bin/gent"],
        env: { HOME: home },
      })

      expect(failures).toEqual([
        {
          extensionId: ExtensionId.make("@gent/memory"),
          jobId: "reflect",
          error: "Cron runtime unavailable",
        },
      ])
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("collectSchedules ignores extensions without Resources", () =>
    Effect.sync(() => {
      const emptyExt = makeLoaded("@gent/test-empty", [])
      const processExt = makeLoaded("@gent/test-process", [
        {
          id: "process-only",
          cron: "* * * * *",
          target: { agent: AgentName.make("p"), prompt: "p" },
        },
      ])
      const collected = collectSchedules([emptyExt, processExt])
      expect(collected.map((c) => c.schedule.id)).toEqual(["process-only"])
    }),
  )
})
