/**
 * Schedule engine — host-side cron reconciliation for scheduled job
 * entries.
 *
 * Reconciles desired schedules from extension contributions into Bun cron jobs:
 *   - Sources desired jobs from every extension's `scheduledJobs` bucket
 *   - Renders a Bun-spawn wrapper script per job
 *   - Installs/removes via `Bun.cron`
 *   - Persists managed-job state in `~/.gent/scheduler/managed-jobs.json`
 *   - Returns failures (per-job) instead of throwing
 *
 * Resource-scope routing: today only `scope: "process"` Resources
 * contribute schedules. Session/branch/cwd schedules are not yet a thing
 * (no caller has asked for one).
 *
 * @module
 */

import { Predicate, Cause, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
import type { ExtensionId } from "../../../domain/ids.js"
import type { ScheduledJobContribution } from "../../../domain/scheduled-job.js"

export type ScheduledJobCommand = readonly [string, ...ReadonlyArray<string>]

/**
 * Per-job failure descriptor returned by `reconcileScheduledJobs`.
 *
 * Failure descriptor consumed by the extension-health snapshot serializer in
 * `server/extension-health.ts`.
 */
export interface SchedulerFailure {
  readonly extensionId: ExtensionId
  readonly jobId: string
  readonly error: string
}

export class SchedulerRuntimeError extends Schema.TaggedError<SchedulerRuntimeError>()(
  "@gent/core-internal/runtime/extensions/resource-host/schedule-engine/SchedulerRuntimeError",
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

export interface CronRuntimeApi {
  readonly install: (
    entryPath: string,
    schedule: string,
    name: string,
  ) => Effect.Effect<void, SchedulerRuntimeError>
  readonly remove: (name: string) => Effect.Effect<void, SchedulerRuntimeError>
}

export class CronRuntime extends Context.Service<CronRuntime, CronRuntimeApi>()(
  "@gent/core/src/runtime/extensions/resource-host/schedule-engine/CronRuntime",
) {
  static unavailable = (reason: string): Layer.Layer<CronRuntime> =>
    Layer.succeed(
      CronRuntime,
      CronRuntime.of({
        install: (_entryPath, _schedule, name) =>
          Effect.fail(
            new SchedulerRuntimeError({
              operation: "install",
              jobName: name,
              cause: reason,
            }),
          ),
        remove: (name) =>
          Effect.fail(
            new SchedulerRuntimeError({
              operation: "remove",
              jobName: name,
              cause: reason,
            }),
          ),
      }),
    )
}

interface DesiredScheduledJob {
  readonly extensionId: ExtensionId
  readonly jobId: string
  readonly name: string
  readonly schedule: string
  readonly scriptPath: string
  readonly script: string
}

const SCHEDULER_DIR = [".gent", "scheduler"]
const JOBS_DIR = [...SCHEDULER_DIR, "jobs"]
const STATE_FILE = [...SCHEDULER_DIR, "managed-jobs.json"]
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, "-")

const jobName = (extensionId: ExtensionId, jobId: string) =>
  `gent-${sanitize(extensionId)}-${sanitize(jobId)}`

const renderCommand = (
  baseCommand: ScheduledJobCommand,
  job: ScheduledJobContribution,
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
  cwd: Option.Option<string>,
  name: string,
) => {
  const spawnOptions = [
    `stdout: "inherit"`,
    `stderr: "inherit"`,
    `stdin: "ignore"`,
    `env: { ...process.env, ...${encodeJson(env)} }`,
    ...Option.match(cwd, {
      onNone: () => [],
      onSome: (value) => [`cwd: ${encodeJson(value)}`],
    }),
  ].join(",\n  ")

  // The emitted script runs in a spawned Bun subprocess (the scheduled job),
  // not inside the gent runtime — `process.exit` here is fine and is NOT a
  // GentPlatform.exit candidate.
  return `const command = ${encodeJson(command)}\nconst proc = Bun.spawn(command, {\n  ${spawnOptions}\n})\nconst exitCode = await proc.exited\nif (exitCode !== 0) {\n  console.error(${encodeJson(`[scheduled-job] ${name} failed`)}, { exitCode, command })\n  // process.exit in the spawned scheduled-job script — not the gent runtime\n  process.exit(exitCode)\n}\n`
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

/**
 * Collect every scheduled job contribution. Returned tuples carry the owning
 * extension id so reconciliation can namespace + report failures per extension.
 */
export const collectSchedules = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<{
  readonly extensionId: ExtensionId
  readonly schedule: ScheduledJobContribution
}> =>
  extensions.flatMap((ext) =>
    (ext.contributions.scheduledJobs ?? []).map((schedule) => ({
      extensionId: ext.manifest.id,
      schedule,
    })),
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
          Option.fromUndefinedOr(schedule.target.cwd),
          name,
        ),
      })
    }
    return desired
  })

export const reconcileScheduledJobs = (params: {
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly home: string
  // oxlint-disable-next-line effect/noNullish -- The scheduler command is an optional host boundary input.
  readonly command: ScheduledJobCommand | undefined
  readonly env?: Readonly<Record<string, string>>
  readonly runtime?: CronRuntimeApi
}): Effect.Effect<ReadonlyArray<SchedulerFailure>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (Predicate.isUndefined(params.command)) return []

    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const schedulerHome = path.join(params.home)
    const desired = yield* resolveDesiredJobs(
      params.extensions,
      params.command,
      schedulerHome,
      Option.getOrElse(Option.fromUndefinedOr(params.env), () => ({})),
    )
    const runtimeOption = yield* Effect.serviceOption(CronRuntime)
    const runtime = Option.fromUndefinedOr(params.runtime).pipe(Option.orElse(() => runtimeOption))
    if (Option.isNone(runtime) && desired.length > 0) {
      return desired.map((job) => ({
        extensionId: job.extensionId,
        jobId: job.jobId,
        error: "Cron runtime unavailable",
      }))
    }
    if (Option.isNone(runtime)) return []

    const statePath = path.join(schedulerHome, ...STATE_FILE)
    const previous = yield* readState(statePath)
    const desiredNames = new Set(desired.map((job) => job.name))
    const failures: SchedulerFailure[] = []

    for (const [name, scriptPath] of Object.entries(previous.jobs)) {
      if (desiredNames.has(name)) continue
      yield* runtime.value.remove(name).pipe(Effect.catchEager(() => Effect.void))
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

      const exit = yield* runtime.value
        .install(job.scriptPath, job.schedule, job.name)
        .pipe(Effect.exit)

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
