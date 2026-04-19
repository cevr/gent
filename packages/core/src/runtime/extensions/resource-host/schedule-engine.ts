/**
 * Schedule engine — host-side cron reconciliation for `Resource.schedule`
 * entries.
 *
 * Replaces the legacy `scheduler.ts` (`extractJobs` + `JobContribution`).
 * Same wire format and reconciliation semantics:
 *   - Sources desired jobs from every Resource's `schedule` array
 *   - Renders a Bun-spawn wrapper script per job
 *   - Installs/removes via `Bun.cron`
 *   - Persists managed-job state in `~/.gent/scheduler/managed-jobs.json`
 *   - Returns failures (per-job) instead of throwing
 *
 * Resource-scope routing: today only `scope: "process"` Resources
 * contribute schedules. Session/branch/cwd schedules are not yet a thing
 * (no caller has asked for one); when one does, the engine grows a
 * `scopes` filter parameter the way `collectSubscriptions` did in C3.1.
 *
 * @module
 */

import { Cause, Effect, FileSystem, Path, Schema } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
import type { AnyResourceContribution, ResourceSchedule } from "../../../domain/resource.js"

const extractResources = (ext: LoadedExtension): ReadonlyArray<AnyResourceContribution> =>
  ext.contributions.resources ?? []

export type ScheduledJobCommand = readonly [string, ...ReadonlyArray<string>]

/**
 * Per-job failure descriptor returned by `reconcileScheduledJobs`.
 *
 * Same shape as the legacy `SchedulerFailure`/`ScheduledJobFailureInfo`
 * pair so the existing extension-health snapshot serializer (in
 * `server/extension-health.ts`) consumes this without change.
 */
export interface SchedulerFailure {
  readonly extensionId: string
  readonly jobId: string
  readonly error: string
}

class SchedulerRuntimeError extends Schema.TaggedErrorClass<SchedulerRuntimeError>()(
  "@gent/core/runtime/extensions/resource-host/schedule-engine/SchedulerRuntimeError",
  {
    operation: Schema.Literals(["install", "remove"]),
    jobName: Schema.String,
    cause: Schema.Unknown,
  },
) {}

interface SchedulerState {
  readonly jobs: Readonly<Record<string, string>>
}

const SchedulerStateSchema = Schema.Struct({
  jobs: Schema.Record(Schema.String, Schema.String),
})

const SchedulerStateJson = Schema.fromJsonString(SchedulerStateSchema)
const decodeSchedulerState = Schema.decodeUnknownEffect(SchedulerStateJson)
const encodeSchedulerState = Schema.encodeEffect(SchedulerStateJson)

interface CronRuntime {
  readonly install: (
    entryPath: string,
    schedule: string,
    name: string,
  ) => Effect.Effect<void, SchedulerRuntimeError>
  readonly remove: (name: string) => Effect.Effect<void, SchedulerRuntimeError>
}

interface DesiredScheduledJob {
  readonly extensionId: string
  readonly jobId: string
  readonly name: string
  readonly schedule: string
  readonly scriptPath: string
  readonly script: string
}

const SCHEDULER_DIR = [".gent", "scheduler"] as const
const JOBS_DIR = [...SCHEDULER_DIR, "jobs"] as const
const STATE_FILE = [...SCHEDULER_DIR, "managed-jobs.json"] as const

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, "-")

const jobName = (extensionId: string, jobId: string) =>
  `gent-${sanitize(extensionId)}-${sanitize(jobId)}`

const renderCommand = (
  baseCommand: ScheduledJobCommand,
  job: ResourceSchedule,
): ReadonlyArray<string> => [
  ...baseCommand,
  "--headless",
  "--agent",
  job.target.agent,
  job.target.prompt,
]

const renderWrapperScript = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  cwd: string | undefined,
  name: string,
) => {
  const spawnOptions = [
    `stdout: "inherit"`,
    `stderr: "inherit"`,
    `stdin: "ignore"`,
    `env: { ...process.env, ...${JSON.stringify(env)} }`,
    ...(cwd !== undefined ? [`cwd: ${JSON.stringify(cwd)}`] : []),
  ].join(",\n  ")

  return `const command = ${JSON.stringify(command)}\nconst proc = Bun.spawn(command, {\n  ${spawnOptions}\n})\nconst exitCode = await proc.exited\nif (exitCode !== 0) {\n  console.error(${JSON.stringify(`[scheduled-job] ${name} failed`)}, { exitCode, command })\n  process.exit(exitCode)\n}\n`
}

const readState = (
  statePath: string,
): Effect.Effect<SchedulerState, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(statePath).pipe(Effect.catchEager(() => Effect.succeed(false)))
    if (!exists) return { jobs: {} }
    const raw = yield* fs
      .readFileString(statePath)
      .pipe(Effect.catchEager(() => Effect.succeed("")))
    if (raw.trim().length === 0) return { jobs: {} }
    return yield* decodeSchedulerState(raw).pipe(
      Effect.catchEager(() => Effect.succeed({ jobs: {} })),
    )
  })

const writeState = (
  statePath: string,
  state: SchedulerState,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const encoded = yield* encodeSchedulerState(state).pipe(
      Effect.catchEager(() => Effect.succeed('{"jobs":{}}')),
    )
    yield* fs
      .makeDirectory(path.dirname(statePath), { recursive: true })
      .pipe(Effect.catchEager(() => Effect.void))
    yield* fs.writeFileString(statePath, encoded).pipe(Effect.catchEager(() => Effect.void))
  }).pipe(Effect.catchEager(() => Effect.void))

const resolveCronRuntime = (): CronRuntime | undefined => {
  const bunLike = globalThis as { readonly Bun?: unknown }
  if (typeof bunLike.Bun !== "object" || bunLike.Bun === null) return undefined
  const cron = (bunLike.Bun as { readonly cron?: unknown }).cron
  if (typeof cron !== "function") return undefined
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const cronWithRemove = cron as ((entryPath: string, schedule: string, name: string) => void) & {
    readonly remove?: (name: string) => void
  }
  if (typeof cronWithRemove.remove !== "function") return undefined
  const remove = cronWithRemove.remove
  return {
    install: (entryPath, schedule, name) =>
      Effect.try({
        try: () => cronWithRemove(entryPath, schedule, name),
        catch: (error) =>
          new SchedulerRuntimeError({
            operation: "install",
            jobName: name,
            cause: error,
          }),
      }),
    remove: (name) =>
      Effect.try({
        try: () => remove(name),
        catch: (error) =>
          new SchedulerRuntimeError({
            operation: "remove",
            jobName: name,
            cause: error,
          }),
      }),
  }
}

/**
 * Collect every `ResourceSchedule` from every Resource matching the
 * requested scopes. Mirrors `collectSubscriptions` / `collectProcessLayers`
 * from C3.1: scope filtering at the collector boundary so non-process
 * schedules cannot accidentally be installed at process scope.
 *
 * Returned tuples carry the owning extension id so reconciliation can
 * namespace + report failures per extension.
 */
export const collectSchedules = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<{ readonly extensionId: string; readonly schedule: ResourceSchedule }> =>
  extensions.flatMap((ext) =>
    extractResources(ext)
      .filter((r) => r.scope === "process")
      .flatMap((r) =>
        (r.schedule ?? []).map((s) => ({ extensionId: ext.manifest.id, schedule: s })),
      ),
  )

const resolveDesiredJobs = (
  extensions: ReadonlyArray<LoadedExtension>,
  baseCommand: ScheduledJobCommand,
  schedulerHome: string,
  env: Readonly<Record<string, string>>,
): Effect.Effect<ReadonlyArray<DesiredScheduledJob>, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const jobsDir = path.join(schedulerHome, ...JOBS_DIR)

    const desired: DesiredScheduledJob[] = []
    for (const { extensionId, schedule } of collectSchedules(extensions)) {
      const name = jobName(extensionId, schedule.id)
      const scriptPath = path.join(
        jobsDir,
        `${sanitize(extensionId)}--${sanitize(schedule.id)}.mjs`,
      )
      desired.push({
        extensionId,
        jobId: schedule.id,
        name,
        schedule: schedule.cron,
        scriptPath,
        script: renderWrapperScript(
          renderCommand(baseCommand, schedule),
          env,
          schedule.target.cwd,
          name,
        ),
      })
    }
    return desired
  })

export const reconcileScheduledJobs = (params: {
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly home: string
  readonly command: ScheduledJobCommand | undefined
  readonly env?: Readonly<Record<string, string>>
  readonly runtime?: CronRuntime
}): Effect.Effect<ReadonlyArray<SchedulerFailure>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (params.command === undefined) return []

    const runtime = params.runtime ?? resolveCronRuntime()
    if (runtime === undefined) return []

    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const schedulerHome = path.join(params.home)
    const desired = yield* resolveDesiredJobs(
      params.extensions,
      params.command,
      schedulerHome,
      params.env ?? {},
    )
    const statePath = path.join(schedulerHome, ...STATE_FILE)
    const previous = yield* readState(statePath)
    const desiredNames = new Set(desired.map((job) => job.name))
    const failures: SchedulerFailure[] = []

    for (const [name, scriptPath] of Object.entries(previous.jobs)) {
      if (desiredNames.has(name)) continue
      yield* runtime.remove(name).pipe(Effect.catchEager(() => Effect.void))
      yield* fs.remove(scriptPath).pipe(Effect.catchEager(() => Effect.void))
    }

    const nextStateJobs: Record<string, string> = {}
    for (const job of desired) {
      yield* fs
        .makeDirectory(path.dirname(job.scriptPath), { recursive: true })
        .pipe(Effect.catchEager(() => Effect.void))
      const wroteScript = yield* fs.writeFileString(job.scriptPath, job.script).pipe(
        Effect.as(true),
        Effect.catchEager((error) => {
          failures.push({
            extensionId: job.extensionId,
            jobId: job.jobId,
            error: String(error),
          })
          return Effect.succeed(false)
        }),
      )
      if (!wroteScript) {
        continue
      }

      const exit = yield* runtime.install(job.scriptPath, job.schedule, job.name).pipe(Effect.exit)

      if (exit._tag === "Failure") {
        failures.push({
          extensionId: job.extensionId,
          jobId: job.jobId,
          error: String(Cause.squash(exit.cause)),
        })
        continue
      }

      nextStateJobs[job.name] = job.scriptPath
    }

    yield* writeState(statePath, { jobs: nextStateJobs })
    return failures
  })
