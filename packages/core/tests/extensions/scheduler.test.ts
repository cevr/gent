import { BunFileSystem } from "@effect/platform-bun"
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Path } from "effect"
import * as Fs from "node:fs"
import * as NodePath from "node:path"
import * as Os from "node:os"
import type { LoadedExtension } from "@gent/core/domain/extension"
import {
  reconcileScheduledJobs,
  collectSchedules,
} from "@gent/core/runtime/extensions/resource-host/schedule-engine"
import { defineResource } from "@gent/core/domain/contribution"
import type { ResourceSchedule } from "@gent/core/domain/resource"

const fsLayer = Layer.merge(BunFileSystem.layer, Path.layer)

const makeLoaded = (id: string, jobs: ReadonlyArray<ResourceSchedule>): LoadedExtension => ({
  manifest: { id },
  kind: "builtin",
  sourcePath: "builtin",
  contributions: [
    defineResource({
      scope: "process",
      layer: Layer.empty,
      schedule: jobs,
    }),
  ],
})

describe("scheduled jobs", () => {
  it.live("reconciles desired jobs and removes stale managed jobs", () =>
    Effect.gen(function* () {
      const home = Fs.mkdtempSync(NodePath.join(Os.tmpdir(), "gent-scheduler-"))
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
              kind: "headless-agent",
              agent: "memory:reflect" as never,
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
      const wrapper = Fs.readFileSync(installed.entryPath, "utf-8")
      expect(wrapper).toContain("/usr/local/bin/gent")
      expect(wrapper).toContain("--headless")
      expect(wrapper).toContain("memory:reflect")
      expect(wrapper).toContain('cwd: "/repo"')

      const statePath = NodePath.join(home, ".gent", "scheduler", "managed-jobs.json")
      const state = JSON.parse(Fs.readFileSync(statePath, "utf-8")) as {
        readonly jobs: Record<string, string>
      }
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
      expect(Fs.existsSync(installed.entryPath)).toBe(false)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("scheduler install failure is isolated instead of crashing reconciliation", () =>
    Effect.gen(function* () {
      const home = Fs.mkdtempSync(NodePath.join(Os.tmpdir(), "gent-scheduler-failure-"))
      const runtime = {
        install: (_entryPath: string, _schedule: string, name: string) => {
          if (name.includes("meditate")) {
            return Effect.fail(new Error("cron install boom"))
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
                kind: "headless-agent",
                agent: "memory:reflect" as never,
                prompt: "Reflect on recent sessions.",
              },
            },
            {
              id: "meditate",
              cron: "0 9 * * 0",
              target: {
                kind: "headless-agent",
                agent: "memory:meditate" as never,
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
      expect(failures[0]!.extensionId).toBe("@gent/memory")
      expect(failures[0]!.jobId).toBe("meditate")
      expect(failures[0]!.error).toContain("cron install boom")

      const statePath = NodePath.join(home, ".gent", "scheduler", "managed-jobs.json")
      const state = JSON.parse(Fs.readFileSync(statePath, "utf-8")) as {
        readonly jobs: Record<string, string>
      }
      expect(Object.keys(state.jobs)).toHaveLength(1)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("collectSchedules filters by process scope by default", () =>
    Effect.sync(() => {
      const sessionExt = makeLoaded("@gent/test-session", [])
      // Override the default makeLoaded process Resource with a session one
      const sessionLoaded: LoadedExtension = {
        ...sessionExt,
        contributions: [
          defineResource({
            scope: "session",
            layer: Layer.empty,
            schedule: [
              {
                id: "session-only",
                cron: "* * * * *",
                target: {
                  kind: "headless-agent",
                  agent: "session-agent" as never,
                  prompt: "session prompt",
                },
              },
            ],
          }),
        ],
      }
      const processExt = makeLoaded("@gent/test-process", [
        {
          id: "process-only",
          cron: "* * * * *",
          target: { kind: "headless-agent", agent: "p" as never, prompt: "p" },
        },
      ])
      const collected = collectSchedules([sessionLoaded, processExt])
      expect(collected.map((c) => c.schedule.id)).toEqual(["process-only"])
    }),
  )
})
