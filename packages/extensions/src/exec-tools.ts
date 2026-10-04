import {
  ByteSize,
  Cause,
  Clock,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  References,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import { Hex } from "effect/encoding"
import { countOf } from "./fs-tools.js"
import {
  type BranchId,
  defineExtension,
  defineResource,
  ExtensionContext,
  type ExtensionContextService,
  ExtensionHost,
  ExtensionId,
  runProcess,
  headChars,
  headTailChars,
  lineCount,
  maximumModelToolResultChars,
  resolveDataDir,
  type SessionId,
  tailChars,
  tool,
  ToolCallId,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// Test seam: only tests read these exports. BackgroundBashStorage, its error,
// BackgroundBashSupervisorLive and BackgroundBashLayer let a test inject a
// storage fault; addBackgroundBashColumn lets it replay a migration race.
// BashParams encodes a model's tool input.

// ── background bash storage ─────────────────────────────────────────────────

export class BackgroundBashStorageError extends Schema.TaggedError<BackgroundBashStorageError>()(
  "BackgroundBashStorageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** A background job asked for outside the tool call that would own it. */
class BackgroundBashError extends Schema.TaggedError<BackgroundBashError>()("BackgroundBashError", {
  message: Schema.String,
}) {}

const BackgroundBashStatus = Schema.Literals(["running", "completed", "failed", "interrupted"])
type BackgroundBashStatus = typeof BackgroundBashStatus.Type
const BackgroundBashTerminalStatus = Schema.Literals(["completed", "failed", "interrupted"])
type BackgroundBashTerminalStatus = typeof BackgroundBashTerminalStatus.Type

interface BackgroundBashJobKeyFields {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly toolCallId: ToolCallId
}

interface BackgroundBashStartInput extends BackgroundBashJobKeyFields {
  readonly command: string
  readonly cwd: Option.Option<string>
  readonly outputFile?: string
}

const BackgroundBashTerminalState = Schema.Struct({
  status: BackgroundBashTerminalStatus,
  command: Schema.String,
  exitCode: Schema.optional(Schema.Finite),
  message: Schema.optional(Schema.String),
  outputFile: Schema.optional(Schema.String),
})
type BackgroundBashTerminalState = typeof BackgroundBashTerminalState.Type

const BackgroundBashClaim = Schema.TaggedUnion({
  Started: {},
  AlreadyRunning: { outputFile: Schema.optional(Schema.String) },
  Terminal: {
    state: BackgroundBashTerminalState,
  },
})
type BackgroundBashClaim = typeof BackgroundBashClaim.Type

const BackgroundBashJobRow = Schema.Struct({
  command: Schema.String,
  status: BackgroundBashStatus,
  exit_code: Schema.NullOr(Schema.Finite),
  message: Schema.NullOr(Schema.String),
  output_file: Schema.NullOr(Schema.String),
})
type BackgroundBashJobRow = typeof BackgroundBashJobRow.Type

interface BackgroundBashStorageService {
  readonly claimStart: (
    input: BackgroundBashStartInput,
  ) => Effect.Effect<BackgroundBashClaim, BackgroundBashStorageError>
  readonly markCompleted: (
    key: BackgroundBashJobKeyFields,
    result: { readonly exitCode: number; readonly message: string },
  ) => Effect.Effect<void, BackgroundBashStorageError>
  readonly markFailed: (
    key: BackgroundBashJobKeyFields,
    message: string,
  ) => Effect.Effect<void, BackgroundBashStorageError>
  /**
   * Marks a job interrupted when this process stops its fiber: the server
   * stopped, or the resource that owns the job closed. A job that already
   * settled keeps its outcome.
   */
  readonly markInterrupted: (
    key: BackgroundBashJobKeyFields,
  ) => Effect.Effect<void, BackgroundBashStorageError>
  /**
   * Records the process a running job started: its pid and its start time
   * (`processStartIdentity`), so a later server can tell that pid still
   * names this job's process.
   */
  readonly recordProcess: (
    key: BackgroundBashJobKeyFields,
    process: JobProcess,
  ) => Effect.Effect<void, BackgroundBashStorageError>
  /** The jobs an earlier server process left running that recorded their process. */
  readonly staleProcesses: Effect.Effect<ReadonlyArray<JobProcess>, BackgroundBashStorageError>
  /**
   * Marks the running jobs an earlier server process started as interrupted.
   * Run after `staleProcesses` were stopped: a job that recorded its process
   * is not running, unless its pid is in `unstopped`; one that did not record
   * its process, or could not be stopped, may still run.
   */
  readonly reconcileInterrupted: (
    unstopped: ReadonlyArray<number>,
  ) => Effect.Effect<void, BackgroundBashStorageError>
  /** The branch's jobs that did not finish and no answered turn has read, oldest first. */
  readonly interruptedJobs: (branch: BackgroundBashBranch) => Effect.Effect<
    ReadonlyArray<{
      readonly toolCallId: ToolCallId
      readonly command: string
      readonly outputFile?: string
      /** A restart could not tell whether its process still runs. */
      readonly mayStillRun: boolean
    }>,
    BackgroundBashStorageError
  >
  /**
   * Settled jobs start with a pending delivery mark. An accepted follow-up
   * clears it; a refused send keeps it, and the next turn reads a notice.
   * Recording a refusal also marks older rows that predate this contract.
   */
  readonly recordDelivery: (
    key: BackgroundBashJobKeyFields,
    delivered: boolean,
  ) => Effect.Effect<void, BackgroundBashStorageError>
  /** The branch's settled jobs whose follow-up was not delivered and no answered turn has read, oldest first. */
  readonly undeliveredJobs: (
    branch: BackgroundBashBranch,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly toolCallId: ToolCallId; readonly state: BackgroundBashTerminalState }>,
    BackgroundBashStorageError
  >
  /** Marks these interrupted or undelivered jobs' notices read: an answered turn showed them. */
  readonly markNoticesRead: (
    branch: BackgroundBashBranch,
    toolCallIds: ReadonlyArray<ToolCallId>,
  ) => Effect.Effect<void, BackgroundBashStorageError>
}

interface BackgroundBashBranch {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

/** The process a job started: the group leader's pid and its start time. */
interface JobProcess {
  readonly pid: number
  readonly startIdentity: string
}

/** The message of a job a restart found running and stopped, or found gone. */
const RESTART_STOPPED_MESSAGE = "Background command stopped when the server restarted"
/** The message of a job a restart found running with no process it could check. */
const RESTART_UNCHECKED_MESSAGE =
  "Background command may still be running: the server restarted and could not check its process"

const mapError = (message: string) => (cause: unknown) =>
  new BackgroundBashStorageError({ message, cause })

const terminalState = (row: BackgroundBashJobRow): BackgroundBashTerminalState => {
  let status: BackgroundBashTerminalStatus = "interrupted"
  if (row.status !== "running") status = row.status
  return {
    status,
    command: row.command,
    exitCode: Option.getOrUndefined(Option.fromNullishOr(row.exit_code)),
    message: Option.getOrUndefined(Option.fromNullishOr(row.message)),
    outputFile: Option.getOrUndefined(Option.fromNullishOr(row.output_file)),
  }
}

const backgroundBashColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('background_bash_jobs')
  `
  return rows.map((row) => row.name)
}).pipe(Effect.mapError(mapError("Failed to read background bash jobs columns")))

/**
 * Adds a column the table read as `columns` lacks. Another process may have
 * read the same old table and added it first: when the add fails, the table
 * is read again, and a column that is there now is no failure.
 */
export const addBackgroundBashColumn = (
  columns: ReadonlyArray<string>,
  name: string,
  type: "TEXT" | "INTEGER",
) =>
  Effect.gen(function* () {
    if (columns.includes(name)) return
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`ALTER TABLE background_bash_jobs ADD COLUMN ${name} ${type}`).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(backgroundBashColumns, (current) => {
          if (current.includes(name)) return Effect.void
          return Effect.failCause(cause)
        }),
      ),
      Effect.mapError(mapError(`Failed to add background bash jobs column ${name}`)),
    )
  })

export class BackgroundBashStorage extends Context.Service<
  BackgroundBashStorage,
  BackgroundBashStorageService
>()("@gent/extensions/src/exec-tools/BackgroundBashStorage") {
  static Live: Layer.Layer<BackgroundBashStorage, BackgroundBashStorageError, SqlClient.SqlClient> =
    Layer.effect(
      BackgroundBashStorage,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        yield* sql
          .unsafe(
            `
            CREATE TABLE IF NOT EXISTS background_bash_jobs (
              session_id TEXT NOT NULL,
              branch_id TEXT NOT NULL,
              tool_call_id TEXT NOT NULL,
              command TEXT NOT NULL,
              cwd TEXT,
              status TEXT NOT NULL,
              started_at INTEGER NOT NULL,
              completed_at INTEGER,
              exit_code INTEGER,
              message TEXT,
              owner_generation TEXT,
              notice_read_at INTEGER,
              undelivered_at INTEGER,
              output_file TEXT,
              pid INTEGER,
              process_start_id TEXT,
              PRIMARY KEY (session_id, branch_id, tool_call_id)
            )
          `,
          )
          .pipe(Effect.mapError(mapError("Failed to create background bash jobs table")))
        // A table from before `owner_generation` gets the column; its rows keep
        // NULL. One from before `notice_read_at` gets it too, and its
        // interrupted jobs stay unread: the earlier code told a branch only
        // when its loop opened, so a job is shown once more at worst, never lost.
        // One from before `undelivered_at` gets it with NULL: no old job is owed a notice.
        const columns = yield* backgroundBashColumns
        yield* addBackgroundBashColumn(columns, "owner_generation", "TEXT")
        yield* addBackgroundBashColumn(columns, "notice_read_at", "INTEGER")
        yield* addBackgroundBashColumn(columns, "undelivered_at", "INTEGER")
        // NULL belongs to the earlier sanitized layout. New claims retain
        // their exact artifact pointer even if opening the file fails or stops.
        yield* addBackgroundBashColumn(columns, "output_file", "TEXT")
        // NULL: the job recorded no process (an earlier build, or a start time
        // that could not be read), so a restart cannot check it.
        yield* addBackgroundBashColumn(columns, "pid", "INTEGER")
        yield* addBackgroundBashColumn(columns, "process_start_id", "TEXT")
        // The server process that owns the jobs this layer starts: every
        // profile in one process shares it, a restarted server has another.
        const generation = yield* Effect.sync(() => String(performance.timeOrigin))

        const selectJob = Effect.fn("BackgroundBashStorage.selectJob")(function* (
          key: BackgroundBashJobKeyFields,
        ) {
          const rows = yield* sql<BackgroundBashJobRow>`
          SELECT command, status, exit_code, message, output_file
          FROM background_bash_jobs
          WHERE session_id = ${key.sessionId}
            AND branch_id = ${key.branchId}
            AND tool_call_id = ${key.toolCallId}
          LIMIT 1
        `
          return Option.fromNullishOr(rows[0])
        })

        const markTerminal = Effect.fn("BackgroundBashStorage.markTerminal")(function* (
          key: BackgroundBashJobKeyFields,
          status: Exclude<BackgroundBashStatus, "running">,
          message: string,
          exitCode: Option.Option<number>,
        ) {
          const completedAt = (yield* DateTime.nowAsDate).getTime()
          yield* sql`
          UPDATE background_bash_jobs
          SET status = ${status},
              completed_at = ${completedAt},
              exit_code = ${Option.getOrNull(exitCode)},
              message = ${message},
              undelivered_at = COALESCE(undelivered_at, ${completedAt})
          WHERE session_id = ${key.sessionId}
            AND branch_id = ${key.branchId}
            AND tool_call_id = ${key.toolCallId}
        `
        })

        return BackgroundBashStorage.of({
          claimStart: Effect.fn("BackgroundBashStorage.claimStart")(
            function* (input) {
              return yield* Effect.gen(function* () {
                const existing = yield* selectJob(input)
                if (Option.isSome(existing)) {
                  if (existing.value.status === "running")
                    return BackgroundBashClaim.cases.AlreadyRunning.make({
                      outputFile: Option.getOrUndefined(
                        Option.fromNullishOr(existing.value.output_file),
                      ),
                    })
                  return BackgroundBashClaim.cases.Terminal.make({
                    state: terminalState(existing.value),
                  })
                }

                const startedAt = (yield* DateTime.nowAsDate).getTime()
                yield* sql`
                  INSERT INTO background_bash_jobs (
                    session_id,
                    branch_id,
                    tool_call_id,
                    command,
                    cwd,
                    status,
                    started_at,
                    owner_generation,
                    output_file
                  )
                  VALUES (
                    ${input.sessionId},
                    ${input.branchId},
                    ${input.toolCallId},
                    ${input.command},
                    ${Option.getOrNull(input.cwd)},
                    'running',
                    ${startedAt},
                    ${generation},
                    ${Option.getOrNull(Option.fromUndefinedOr(input.outputFile))}
                  )
                `
                return BackgroundBashClaim.cases.Started.make({})
              }).pipe(sql.withTransaction)
            },
            Effect.mapError(mapError("Failed to claim background bash job")),
          ),

          markCompleted: Effect.fn("BackgroundBashStorage.markCompleted")(
            function* (key, result) {
              yield* markTerminal(key, "completed", result.message, Option.some(result.exitCode))
            },
            Effect.mapError(mapError("Failed to mark background bash job completed")),
          ),

          markFailed: Effect.fn("BackgroundBashStorage.markFailed")(
            function* (key, message) {
              yield* markTerminal(key, "failed", message, Option.none())
            },
            Effect.mapError(mapError("Failed to mark background bash job failed")),
          ),

          markInterrupted: Effect.fn("BackgroundBashStorage.markInterrupted")(
            function* (key) {
              const completedAt = (yield* DateTime.nowAsDate).getTime()
              yield* sql`
                UPDATE background_bash_jobs
                SET status = 'interrupted',
                    completed_at = ${completedAt},
                    message = 'Background command stopped before it finished (a server restart or a reload)'
                WHERE session_id = ${key.sessionId}
                  AND branch_id = ${key.branchId}
                  AND tool_call_id = ${key.toolCallId}
                  AND status = 'running'
              `
            },
            Effect.mapError(mapError("Failed to mark background bash job interrupted")),
          ),

          recordProcess: Effect.fn("BackgroundBashStorage.recordProcess")(
            function* (key, process) {
              yield* sql`
                UPDATE background_bash_jobs
                SET pid = ${process.pid},
                    process_start_id = ${process.startIdentity}
                WHERE session_id = ${key.sessionId}
                  AND branch_id = ${key.branchId}
                  AND tool_call_id = ${key.toolCallId}
                  AND status = 'running'
              `
            },
            Effect.mapError(mapError("Failed to record background bash job process")),
          ),

          staleProcesses: Effect.gen(function* () {
            const rows = yield* sql<{ readonly pid: number; readonly process_start_id: string }>`
              SELECT pid, process_start_id
              FROM background_bash_jobs
              WHERE status = 'running'
                AND (owner_generation IS NULL OR owner_generation != ${generation})
                AND pid IS NOT NULL
                AND process_start_id IS NOT NULL
            `
            return rows.map((row) => ({ pid: row.pid, startIdentity: row.process_start_id }))
          }).pipe(Effect.mapError(mapError("Failed to read stale background bash processes"))),

          interruptedJobs: Effect.fn("BackgroundBashStorage.interruptedJobs")(
            function* (branch) {
              const rows = yield* sql<{
                readonly tool_call_id: string
                readonly command: string
                readonly output_file: BackgroundBashJobRow["output_file"]
                readonly message: BackgroundBashJobRow["message"]
              }>`
                SELECT tool_call_id, command, output_file, message
                FROM background_bash_jobs
                WHERE session_id = ${branch.sessionId}
                  AND branch_id = ${branch.branchId}
                  AND status = 'interrupted'
                  AND notice_read_at IS NULL
                ORDER BY started_at, tool_call_id
              `
              return rows.map((row) => ({
                toolCallId: ToolCallId.make(row.tool_call_id),
                command: row.command,
                outputFile: Option.getOrUndefined(Option.fromNullishOr(row.output_file)),
                mayStillRun: row.message === RESTART_UNCHECKED_MESSAGE,
              }))
            },
            Effect.mapError(mapError("Failed to read interrupted background bash jobs")),
          ),

          recordDelivery: Effect.fn("BackgroundBashStorage.recordDelivery")(
            function* (key, delivered) {
              if (delivered) {
                yield* sql`
                  UPDATE background_bash_jobs
                  SET undelivered_at = NULL
                  WHERE session_id = ${key.sessionId}
                    AND branch_id = ${key.branchId}
                    AND tool_call_id = ${key.toolCallId}
                    AND undelivered_at IS NOT NULL
                `
                return
              }
              const undeliveredAt = (yield* DateTime.nowAsDate).getTime()
              yield* sql`
                UPDATE background_bash_jobs
                SET undelivered_at = ${undeliveredAt}
                WHERE session_id = ${key.sessionId}
                  AND branch_id = ${key.branchId}
                  AND tool_call_id = ${key.toolCallId}
                  AND status IN ('completed', 'failed')
                  AND undelivered_at IS NULL
              `
            },
            Effect.mapError(mapError("Failed to record background bash job delivery")),
          ),

          undeliveredJobs: Effect.fn("BackgroundBashStorage.undeliveredJobs")(
            function* (branch) {
              const rows = yield* sql<BackgroundBashJobRow & { readonly tool_call_id: string }>`
                SELECT tool_call_id, command, status, exit_code, message, output_file
                FROM background_bash_jobs
                WHERE session_id = ${branch.sessionId}
                  AND branch_id = ${branch.branchId}
                  AND undelivered_at IS NOT NULL
                  AND notice_read_at IS NULL
                ORDER BY completed_at, tool_call_id
              `
              return rows.map((row) => ({
                toolCallId: ToolCallId.make(row.tool_call_id),
                state: terminalState(row),
              }))
            },
            Effect.mapError(mapError("Failed to read undelivered background bash jobs")),
          ),

          markNoticesRead: Effect.fn("BackgroundBashStorage.markNoticesRead")(
            function* (branch, toolCallIds) {
              if (toolCallIds.length === 0) return
              const readAt = (yield* DateTime.nowAsDate).getTime()
              yield* sql`
                UPDATE background_bash_jobs
                SET notice_read_at = ${readAt}
                WHERE session_id = ${branch.sessionId}
                  AND branch_id = ${branch.branchId}
                  AND tool_call_id IN ${sql.in(toolCallIds)}
                  AND (status = 'interrupted' OR undelivered_at IS NOT NULL)
                  AND notice_read_at IS NULL
              `
            },
            Effect.mapError(mapError("Failed to mark background bash notices read")),
          ),

          reconcileInterrupted: Effect.fn("BackgroundBashStorage.reconcileInterrupted")(
            function* (unstopped: ReadonlyArray<number>) {
              const completedAt = (yield* DateTime.nowAsDate).getTime()
              let stopped = sql`pid IS NOT NULL AND process_start_id IS NOT NULL`
              if (unstopped.length > 0) {
                stopped = sql`pid IS NOT NULL AND process_start_id IS NOT NULL AND pid NOT IN ${sql.in(unstopped)}`
              }
              yield* sql`
                UPDATE background_bash_jobs
                SET status = 'interrupted',
                    completed_at = ${completedAt},
                    message = CASE
                      WHEN ${stopped} THEN ${RESTART_STOPPED_MESSAGE}
                      ELSE ${RESTART_UNCHECKED_MESSAGE}
                    END
                WHERE status = 'running'
                  AND (owner_generation IS NULL OR owner_generation != ${generation})
              `
            },
            Effect.mapError(mapError("Failed to reconcile interrupted background bash jobs")),
          ),
        })
      }),
    )
}

// ── bash tool ───────────────────────────────────────────────────────────────
//
// The bash tool runs every command as given: nothing classifies it, nothing
// asks, and nothing rewrites it.

// Bash Tool Error

class BashError extends Schema.TaggedError<BashError>()("BashError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.optional(Schema.Finite),
  stderr: Schema.optional(Schema.String),
}) {}

// Bash Tool Params

export const BashParams = Schema.Struct({
  command: Schema.String.annotate({
    description: "Shell command to execute",
  }),
  timeout: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Timeout in milliseconds (default: 120000, max: 600000)",
    }),
  ),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description: "Working directory for command execution",
    }),
  ),
  run_in_background: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Run in background. Returns immediately, notifies when done. Use for long-running commands.",
    }),
  ),
})

// Bash Tool Result

const BashResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Finite,
  /** Absent when the command ran to its end. A background command has no real exit code yet. */
  status: Schema.optional(Schema.Literals(["background"])),
  /**
   * The file with all of a foreground command's output, stdout and stderr in
   * arrival order; present once the output passed what the result keeps whole.
   */
  outputFile: Schema.optionalKey(Schema.String),
  /** The length of all the output in `outputFile`, in characters. */
  outputChars: Schema.optionalKey(Schema.Finite),
})

const SIGKILL_DELAY_MS = 3000

type BackgroundBashJobKey = string

interface BackgroundBashJob {
  readonly command: string
  readonly cwd: Option.Option<string>
}

interface BackgroundBashTarget {
  readonly sessionId: SessionId
  readonly branchId: ExtensionContextService["branchId"]
  readonly toolCallId: ToolCallId
  readonly Session: Pick<ExtensionContextService["Session"], "getSession" | "listBranches" | "send">
  /** Resolved before ownership transfer: the job fiber has no ExtensionContext or Crypto. */
  readonly outputFile: string
}

const backgroundJobKey = (target: BackgroundBashTarget): BackgroundBashJobKey =>
  `${target.sessionId}:${target.branchId}:${target.toolCallId}`

const backgroundJobKeyFields = (target: BackgroundBashTarget): BackgroundBashJobKeyFields => ({
  sessionId: target.sessionId,
  branchId: target.branchId,
  toolCallId: target.toolCallId,
})

const targetStillExists = (target: BackgroundBashTarget) =>
  Effect.gen(function* () {
    const session = yield* Effect.option(target.Session.getSession())
    if (Option.isNone(session)) return false
    const branches = yield* target.Session.listBranches.pipe(Effect.orElseSucceed(() => []))
    return branches.some((branch) => branch.id === target.branchId)
  })

/** `metadata.customType` on a settled job's message: a notice, not something the user wrote. */
const BACKGROUND_BASH_MESSAGE_TYPE = "background-bash"

/**
 * Queues a settled job's message; false when the send was refused (a full
 * follow-up queue, for one), so the caller keeps the result for a notice. A
 * deleted session or branch is owed nothing.
 */
const queueBackgroundFollowUp = (params: {
  readonly target: BackgroundBashTarget
  readonly sourceId: string
  readonly content: string
}) =>
  Effect.gen(function* () {
    if (!(yield* targetStillExists(params.target))) return true
    return yield* params.target.Session.send({
      delivery: "queue",
      sourceId: params.sourceId,
      content: params.content,
      metadata: { customType: BACKGROUND_BASH_MESSAGE_TYPE },
    }).pipe(
      Effect.as(true),
      Effect.catchEager((error) =>
        Effect.logWarning("exec-tools.background.follow-up.refused").pipe(
          Effect.annotateLogs({ toolCallId: params.target.toolCallId, error: error.message }),
          Effect.as(false),
        ),
      ),
    )
  })

// ── command output ──
//
// Every shell command runs through one spawn (`spawnBashCommand`): a
// background job, a foreground call, and each monitor check. Output reaches
// the caller as it arrives and memory keeps only the ends of each stream, so a
// command that prints for hours holds none of the middle. The rest goes to a
// file under the data directory: a background job's file opens at its start,
// so the read tool (`tools.read` in a cell) reads a running job's output; a
// foreground call's file opens only once its output passes what the result
// keeps; a monitor check keeps no file, since only its verdict and its tail
// reach a message. A file, not a reader behind `context.read`: every agent has
// the read tool, and no other module learns how a command keeps its output.

/**
 * `<data dir>/background-bash/<sessionId>/<branchId>/<sanitized call id>.txt`:
 * the file of a job row stored without `output_file`, which only an older
 * build wrote.
 */
const sanitizedOutputFile = (path: Path.Path, dataDir: string, key: BackgroundBashJobKeyFields) =>
  path.resolve(
    sessionOutputDirectory(path, dataDir, key.sessionId),
    key.branchId,
    `${key.toolCallId.replace(/[^\w.:-]/g, "_")}.txt`,
  )

/** A job row's output file: the one it stored, else `sanitizedOutputFile`. */
const rowOutputFile = (
  path: Path.Path,
  dataDir: string,
  key: BackgroundBashJobKeyFields,
  stored?: string,
) => stored ?? sanitizedOutputFile(path, dataDir, key)

const encodeCallIdentity = Schema.encodeSync(Schema.fromJsonString(ToolCallId))
/**
 * `<data dir>/background-bash/<sessionId>/<branchId>/calls/<digest>.txt`: one
 * file per bash call. The digest is SHA-256 of the whole JSON-encoded call id,
 * every UTF-16 code unit included; the separate `calls` directory keeps new
 * writes from overwriting a file an older build named. The path is absolute:
 * a relative `GENT_DATA_DIR` resolves against the server's cwd, as the
 * database does, and the read tool resolves a relative path against the
 * session cwd instead.
 */
const jobOutputFile = Effect.fn("ExecTools.jobOutputFile")(function* (
  path: Path.Path,
  dataDir: string,
  key: BackgroundBashJobKeyFields,
) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(encodeCallIdentity(key.toolCallId)),
  )
  return path.resolve(
    sessionOutputDirectory(path, dataDir, key.sessionId),
    key.branchId,
    "calls",
    `${Hex.encode(digest)}.txt`,
  )
})

/** `<data dir>/background-bash/<sessionId>`: every output file one session's calls kept. */
const sessionOutputDirectory = (path: Path.Path, dataDir: string, sessionId: SessionId) =>
  path.resolve(dataDir, "background-bash", sessionId)

/**
 * A deleted session's output files go with it (`sessionDeleted`): the files
 * are the extension's own, outside the database, so nothing else removes them.
 */
const removeSessionOutputs = Effect.fn("ExecTools.removeSessionOutputs")(function* (
  sessionId: SessionId,
) {
  const ctx = yield* ExtensionContext
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dataDir = yield* resolveDataDir(ctx.home)
  yield* fs.remove(sessionOutputDirectory(path, dataDir, sessionId), {
    recursive: true,
    force: true,
  })
})

/**
 * Characters of a background job's output kept in memory at each end. A
 * completion message is at most `maximumModelToolResultChars`, so each end
 * holds all a message can show of it.
 */
const jobOutputEndChars = maximumModelToolResultChars

/**
 * Characters of a foreground command's stdout, and of its stderr, kept at
 * each end. A stream up to twice this comes back whole, so a cell parses most
 * outputs whole, and the result stays within a cell's reply frame.
 */
const commandOutputEndChars = 128 * 1024

/** The longest stream a foreground command or a monitor check keeps whole, as text for a description. */
export const wholeCommandOutputText = (2 * commandOutputEndChars).toLocaleString("en-US")

/** One output as memory keeps it: its ends and its length. */
interface OutputEnds {
  /** The first characters, up to the end size. */
  readonly head: string
  /** The last characters after the head, up to the end size. */
  readonly tail: string
  readonly totalChars: number
}

const noOutput: OutputEnds = { head: "", tail: "", totalChars: 0 }

/**
 * `ends` after `text` arrives; each end stays within `endChars` and is cut
 * between code points. The head takes text only while nothing has passed it.
 */
const appendOutput = (ends: OutputEnds, text: string, endChars: number): OutputEnds => {
  let added = ""
  if (ends.totalChars === ends.head.length) added = headChars(text, endChars - ends.head.length)
  return {
    head: ends.head + added,
    tail: tailChars(`${ends.tail}${text.slice(added.length)}`, endChars),
    totalChars: ends.totalChars + text.length,
  }
}

/** A background job's output as memory keeps it: its ends, its length, and its file. */
interface JobOutput extends OutputEnds {
  /** The file with all of it; none when the file could not be written. */
  readonly file: Option.Option<string>
}

/**
 * The output within `maxChars`, as `headTailChars` cuts it. When the middle
 * never reached memory, the cut is made from the ends and the marker counts
 * the whole middle. Needs `maxChars` at most the two ends' size.
 */
const cutJobOutput = (output: OutputEnds, maxChars: number): string => {
  const kept = output.head + output.tail
  if (output.totalChars === kept.length) return headTailChars(kept, maxChars).text
  const marker = (cut: number) => `\n\n... [${cut} characters truncated] ...\n\n`
  const room = maxChars - marker(output.totalChars).length
  if (room < 0) return headTailChars(kept, maxChars).text
  const head = headChars(output.head, Math.floor(room / 2))
  const tail = tailChars(output.tail, room - head.length)
  return `${head}${marker(output.totalChars - head.length - tail.length)}${tail}`
}

/** One stream as a foreground result keeps it: whole, or its ends around a marker that counts the middle. */
const commandOutputText = (ends: OutputEnds): string => {
  if (ends.totalChars === ends.head.length + ends.tail.length) return ends.head + ends.tail
  return cutJobOutput(ends, 2 * commandOutputEndChars)
}

/**
 * One stream's text as memory kept it, with no marker: the whole text, or
 * its head and its tail as two pieces, since the middle between them is gone.
 */
const keptOutputPieces = (ends: OutputEnds): ReadonlyArray<string> => {
  if (ends.totalChars === ends.head.length + ends.tail.length) return [ends.head + ends.tail]
  return [ends.head, ends.tail]
}

/**
 * The output within `maxChars`, the file line included. A cut output keeps
 * its head and tail and names the file that holds all of it; the cut marker
 * states the one omitted count.
 */
const jobOutputText = (output: JobOutput, maxChars: number): string => {
  if (output.totalChars <= maxChars) return output.head + output.tail
  const where = Option.match(output.file, {
    onNone: () => "[The whole output could not be saved.]",
    onSome: (file) =>
      `[The whole output is in ${file} (${output.totalChars} characters); page it with the read tool's offset and limit.]`,
  })
  const cut = cutJobOutput(output, Math.max(0, maxChars - where.length - 2))
  // A file line longer than the whole budget is cut too.
  return headTailChars(`${cut}\n\n${where}`, maxChars).text
}

/** The file a command's output goes to, stdout and stderr in arrival order. */
interface OutputFile {
  /** Opens the file now, before any output: a reader finds it while the command runs. */
  readonly open: Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<void>
  /** The file, when it holds all the output so far. */
  readonly written: () => Option.Option<string>
  /**
   * Removes the file, and writes no more: for a command that ended with no
   * result to name it (a timeout, an interrupt), so nothing stays on disk.
   */
  readonly discard: Effect.Effect<void>
}

/**
 * An output file that opens once more than `openAfter` characters arrived,
 * or at `open`; until then they wait in memory, so a short output never
 * touches the disk. A file that cannot be written is logged once, and the
 * command runs on without it. The scope owns the open file.
 */
const makeOutputFile = (file: string, openAfter: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const scope = yield* Scope.Scope
    const encoder = new TextEncoder()
    const writeFailed = (cause: Cause.Cause<unknown>) =>
      Effect.logWarning("exec-tools.output.write.failed").pipe(
        Effect.annotateLogs({ file, cause: Cause.pretty(cause) }),
        Effect.as(Option.none<FileSystem.File>()),
      )
    let pending = ""
    let sink = Option.none<FileSystem.File>()
    let failed = false
    const append = (text: string) =>
      Effect.gen(function* () {
        if (Option.isNone(sink)) return
        const opened = sink.value
        sink = yield* opened
          .writeAll(encoder.encode(text))
          .pipe(Effect.as(Option.some(opened)), Effect.catchCause(writeFailed))
        failed = Option.isNone(sink)
      })
    const open = Effect.gen(function* () {
      if (failed || Option.isSome(sink)) return
      sink = yield* fs
        .makeDirectory(path.dirname(file), { recursive: true })
        .pipe(
          Effect.andThen(fs.open(file, { flag: "w" })),
          Effect.asSome,
          Effect.catchCause(writeFailed),
          Scope.provide(scope),
        )
      failed = Option.isNone(sink)
      const held = pending
      pending = ""
      if (held.length > 0) yield* append(held)
    })
    const output: OutputFile = {
      open,
      write: (text) =>
        Effect.gen(function* () {
          if (failed) return
          if (Option.isSome(sink)) return yield* append(text)
          pending += text
          if (pending.length > openAfter) yield* open
        }),
      written: () => {
        if (failed) return Option.none()
        return Option.as(sink, file)
      },
      discard: Effect.gen(function* () {
        const opened = Option.isSome(sink)
        failed = true
        pending = ""
        sink = Option.none()
        if (!opened) return
        // The scope still closes the handle; removing the path first is safe.
        yield* fs
          .remove(file, { force: true })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("exec-tools.output.discard.failed").pipe(
                Effect.annotateLogs({ file, cause: Cause.pretty(cause) }),
              ),
            ),
          )
      }),
    }
    return output
  })

/** Where each stream's decoded text goes as it arrives. */
interface OutputSinks {
  readonly stdout: (text: string) => Effect.Effect<void>
  readonly stderr: (text: string) => Effect.Effect<void>
}

const PROCESS_CHECK_TIMEOUT = Duration.seconds(5)

/**
 * The start time of process `pid` as `ps` prints it, in a fixed locale and
 * zone, or none when no such process runs. A pid with the same start time is
 * the same process: the system reuses a pid only after its process ended.
 */
const processStartIdentity = (pid: number) =>
  runProcess("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { LC_ALL: "C", TZ: "UTC0" },
    extendEnv: true,
    timeout: PROCESS_CHECK_TIMEOUT,
  }).pipe(
    Effect.map((result) =>
      Option.some(result.stdout.trim()).pipe(
        Option.filter((identity) => result.exitCode === 0 && identity !== ""),
      ),
    ),
  )

/**
 * Send `signal` to process group `pid`: `taken` when the group took it,
 * `gone` when no such group exists (ESRCH), `unknown` for any other refusal,
 * such as a group of another user (EPERM). `kill` exits 1 for both errors, so
 * the C-locale `strerror` text tells them apart. A pid of 1 or less names
 * every process (`-1`) or none, never one job's group.
 */
const signalProcessGroup = (pid: number, signal: "TERM" | "KILL" | "0") => {
  if (pid <= 1) return Effect.succeed("unknown" as const)
  return runProcess("kill", [`-${signal}`, "--", `-${pid}`], {
    env: { LC_ALL: "C" },
    extendEnv: true,
    timeout: PROCESS_CHECK_TIMEOUT,
  }).pipe(
    Effect.map((result): "taken" | "gone" | "unknown" => {
      if (result.exitCode === 0) return "taken"
      if (result.stderr.includes("No such process")) return "gone"
      return "unknown"
    }),
  )
}

/**
 * Stop the process group an earlier server left running: SIGTERM, then
 * SIGKILL after `SIGKILL_DELAY_MS`. True only when the job's group is
 * shown gone; a refused signal leaves the job one that may still run.
 *
 * The system does not reuse a pid while a process group with that id lives
 * (POSIX "Process ID Reuse"; Linux keeps the pid allocated while a task holds
 * it as its group id, macOS skips a pid that names a live group). So when
 * another process holds the pid, the job's group is gone. When no process
 * holds it, a group with that id still holds the job's descendants that
 * outlived the leader, and they stop as the leader's group does.
 */
const stopStaleProcess = (job: JobProcess) =>
  Effect.gen(function* () {
    const identity = yield* processStartIdentity(job.pid)
    if (Option.isSome(identity) && identity.value !== job.startIdentity) return true
    const termed = yield* signalProcessGroup(job.pid, "TERM")
    if (termed !== "taken") return termed === "gone"
    const deadline = (yield* Clock.currentTimeMillis) + SIGKILL_DELAY_MS
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const probe = yield* signalProcessGroup(job.pid, "0")
      if (probe !== "taken") return probe === "gone"
      yield* Effect.sleep(Duration.millis(100))
    }
    yield* signalProcessGroup(job.pid, "KILL")
    return (yield* signalProcessGroup(job.pid, "0")) === "gone"
  }).pipe(
    Effect.catchTag("ProcessError", (error) =>
      Effect.logWarning("exec-tools.stale-process.stop.failed").pipe(
        Effect.annotateLogs({ pid: job.pid, error: error.message }),
        Effect.as(false),
      ),
    ),
  )

/**
 * Spawn `bash -c <command>`: the one spawn every shell command shares. Each
 * stream's text goes to its sink as it arrives, one piece at a time, in
 * arrival order across the two; nothing else is kept. `started` runs beside
 * the streams with the pid of `bash`, which leads its own process group. The
 * scope owns the spawn finalizer: closing it ends the process group via
 * SIGTERM, with SIGKILL after `SIGKILL_DELAY_MS`.
 */
const spawnBashCommand = (
  command: string,
  cwd: Option.Option<string>,
  sinks: OutputSinks,
  started: (
    pid: number,
  ) => Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make("bash", ["-c", command], {
      cwd: Option.getOrUndefined(cwd),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: Duration.millis(SIGKILL_DELAY_MS),
    })
    const deliver = (sink: (text: string) => Effect.Effect<void>, text: string) => {
      if (text.length === 0) return Effect.void
      return sink(text)
    }
    // One decoder per stream: `stream: true` holds a partial multibyte
    // sequence until that stream's next chunk.
    const stdout = new TextDecoder()
    const stderr = new TextDecoder()
    const texts = Stream.merge(
      handle.stdout.pipe(
        Stream.map((chunk) => ({
          sink: sinks.stdout,
          text: stdout.decode(chunk, { stream: true }),
        })),
      ),
      handle.stderr.pipe(
        Stream.map((chunk) => ({
          sink: sinks.stderr,
          text: stderr.decode(chunk, { stream: true }),
        })),
      ),
    )
    const [exitCode] = yield* Effect.all(
      [
        handle.exitCode,
        Stream.runForEach(texts, ({ sink, text }) => deliver(sink, text)).pipe(
          Effect.andThen(Effect.suspend(() => deliver(sinks.stdout, stdout.decode()))),
          Effect.andThen(Effect.suspend(() => deliver(sinks.stderr, stderr.decode()))),
        ),
        started(handle.pid),
      ],
      { concurrency: "unbounded" },
    )
    return Number(exitCode)
  })

/** A command run to its end: each stream as the result keeps it, and the file with all of it. */
interface CommandOutput {
  readonly exitCode: number
  /** The display text: whole, or the ends around a marker that counts the middle. */
  readonly stdout: string
  readonly stderr: string
  /**
   * The stdout data memory kept, with no marker: one piece when whole, else
   * its head and its tail. A monitor tests `until` on these, never on the
   * display text.
   */
  readonly stdoutPieces: ReadonlyArray<string>
  /**
   * The file with all the output, stdout and stderr in arrival order, and
   * its length; none until the output passed what memory keeps whole, or
   * when the file could not be written.
   */
  readonly spilled: Option.Option<{ readonly file: string; readonly totalChars: number }>
}

/**
 * Run a command to its end: a foreground call, or a monitor check. Each
 * stream comes back whole up to `2 * commandOutputEndChars` characters, else
 * as its ends around a marker that counts the middle. Given a `spill` file,
 * output past that also goes to the file, whole, and a run that ends
 * without a result removes it. The scope owns the process and the file.
 */
export const runBashCommand = (
  command: string,
  cwd: Option.Option<string>,
  spill: Option.Option<string>,
) =>
  Effect.gen(function* () {
    let stdout = noOutput
    let stderr = noOutput
    const file = yield* Option.match(spill, {
      onNone: () => Effect.succeed(Option.none<OutputFile>()),
      onSome: (path) => Effect.asSome(makeOutputFile(path, 2 * commandOutputEndChars)),
    })
    const toFile = (text: string) =>
      Option.match(file, { onNone: () => Effect.void, onSome: (output) => output.write(text) })
    const exitCode = yield* spawnBashCommand(command, cwd, {
      stdout: (text) =>
        Effect.suspend(() => {
          stdout = appendOutput(stdout, text, commandOutputEndChars)
          return toFile(text)
        }),
      stderr: (text) =>
        Effect.suspend(() => {
          stderr = appendOutput(stderr, text, commandOutputEndChars)
          return toFile(text)
        }),
    }).pipe(
      // Only a result names the file: a run that ends without one (a
      // timeout, an interrupt, a spawn failure) removes it.
      Effect.onError(() =>
        Option.match(file, { onNone: () => Effect.void, onSome: (output) => output.discard }),
      ),
    )
    const output: CommandOutput = {
      exitCode,
      stdout: commandOutputText(stdout),
      stderr: commandOutputText(stderr),
      stdoutPieces: keptOutputPieces(stdout),
      spilled: Option.map(
        Option.flatMap(file, (opened) => opened.written()),
        (written) => ({ file: written, totalChars: stdout.totalChars + stderr.totalChars }),
      ),
    }
    return output
  })

/**
 * Spawn a background job. Its stdout and stderr go to `file` from the start,
 * in arrival order; memory keeps the ends. `started` gets the job's pid. The
 * scope owns the process and the open file.
 */
const streamBackgroundCommand = (
  command: string,
  cwd: Option.Option<string>,
  file: string,
  started: (pid: number) => Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.gen(function* () {
    const sink = yield* makeOutputFile(file, 0)
    yield* sink.open
    let output = noOutput
    const record = (text: string) =>
      Effect.suspend(() => {
        output = appendOutput(output, text, jobOutputEndChars)
        return sink.write(text)
      })
    const exitCode = yield* spawnBashCommand(
      command,
      cwd,
      { stdout: record, stderr: record },
      started,
    )
    const job: JobOutput = { ...output, file: sink.written() }
    return { exitCode, output: job }
  })

/** The longest command a follow-up notice repeats; the rest is cut from its middle. */
const maximumFollowUpCommandChars = 1_000

/**
 * Queues the settled job's message; false when the send was refused. The
 * notice is a user-role message, and core bounds only tool results, so the
 * whole notice, its frame included, is bounded here at the same budget.
 * `output` renders the job's output within a budget: from memory for a job
 * this process ran, from the row's message for a stored one.
 */
const queueTerminalFollowUp = (
  target: BackgroundBashTarget,
  state: BackgroundBashTerminalState,
  output: (maxChars: number) => string,
) =>
  Effect.gen(function* () {
    // An interrupted job wakes nobody: the next turn reads it as a notice.
    if (state.status === "interrupted") return true
    const command = headTailChars(state.command, maximumFollowUpCommandChars).text
    let header = "Background command failed:"
    let sourceId = `bash:${target.toolCallId}:failure`
    if (state.status === "completed") {
      header = `Background command completed (exit code ${state.exitCode ?? 0}):`
      sourceId = `bash:${target.toolCallId}:complete`
    }
    const frame = (text: string) => `${header}\n\`\`\`\n$ ${command}\n${text}\n\`\`\``
    const message = output(maximumModelToolResultChars - frame("").length)
    return yield* queueBackgroundFollowUp({ target, sourceId, content: frame(message) })
  })

/**
 * A stored row's message within `maxChars`, cut to its head and tail. A
 * completed row holds the output already cut to the notice bound, its file
 * line included; a failure's text is its own. A row from a build before that
 * bound holds up to a follow-up's worth: when it is cut and the job's file
 * exists, the cut names the file.
 */
const storedJobOutput = (message: string, file: Option.Option<string>) => (maxChars: number) => {
  if (message.length <= maxChars || Option.isNone(file))
    return headTailChars(message, maxChars).text
  // The whole message is in memory: one end holds all of it.
  return jobOutputText({ head: message, tail: "", totalChars: message.length, file }, maxChars)
}

/** A completed job's file when it exists; a failure's text has none. Nothing is written. */
const storedOutputFile = (file: string, state: BackgroundBashTerminalState) =>
  Effect.gen(function* () {
    if (state.status !== "completed") return Option.none<string>()
    const exists = yield* (yield* FileSystem.FileSystem)
      .exists(file)
      .pipe(Effect.orElseSucceed(() => false))
    return Option.liftPredicate(file, () => exists)
  })

// ── job notices ──
//
// A job that stopped before it finished (a server restart, or a reload that
// closed the resource that ran it) has no end to report, and its file holds
// only the output written before the stop. Opening its
// session must not spend a turn with no user present, so the job wakes
// nobody: every step of the branch's next turn shows it as a turn notice,
// and the turn that answered with it shown marks it read on its row. A job
// whose follow-up was refused or interrupted before admission is shown the
// same way, with its outcome, so no finished job goes unreported.

const maximumNoticeJobs = 10
const maximumNoticeCommandChars = 200
const maximumNoticeOutputChars = 2_000

const noticeCommand = (command: string) => {
  const line = command.replace(/\s+/g, " ").trim()
  if (line.length <= maximumNoticeCommandChars) return line
  return `${headChars(line, maximumNoticeCommandChars - 1)}…`
}

/** One notice naming at most `maximumNoticeJobs` jobs, the rest a count; none for no jobs. */
const jobNotice = <J extends { readonly toolCallId: ToolCallId }>(
  jobs: ReadonlyArray<J>,
  params: {
    readonly id: string
    readonly intro: string
    readonly line: (job: J) => string
    readonly rest: string
  },
) => {
  if (jobs.length === 0) return []
  const named = jobs.slice(0, maximumNoticeJobs)
  const lines = named.map(params.line)
  const unnamed = jobs.length - named.length
  if (unnamed > 0)
    lines.push(`- and ${unnamed} more ${params.rest}, named once you have read these.`)
  return [
    {
      id: params.id,
      keys: named.map((job) => job.toolCallId),
      content: `${params.intro}\n\n${lines.join("\n")}`,
    },
  ]
}

/** Where a stopped job's output is: its file when the file holds output. */
const savedOutput = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(file).pipe(Effect.option)
    if (Option.isNone(info)) return "no output was saved"
    if (info.value.size === ByteSize.zero) return "it wrote no output before the stop"
    return `output up to the stop is in ${file}`
  })

/**
 * The branch's unread interrupted jobs as one turn notice, and its unread
 * undelivered jobs as another, each the oldest first and at most
 * `maximumNoticeJobs`; the rest are a count. The keys are the tool call ids a
 * notice names, so an answered turn clears exactly those.
 */
const jobNotices = Effect.fn("ExecTools.jobNotices")(function* () {
  const ctx = yield* ExtensionContext
  const storage = yield* BackgroundBashStorage
  const branch = { sessionId: ctx.sessionId, branchId: ctx.branchId }
  const path = yield* Path.Path
  const dataDir = yield* resolveDataDir(ctx.home)
  const stopped = yield* storage.interruptedJobs(branch)
  const saved = new Map(
    yield* Effect.forEach(stopped.slice(0, maximumNoticeJobs), (job) =>
      savedOutput(
        rowOutputFile(path, dataDir, { ...branch, toolCallId: job.toolCallId }, job.outputFile),
      ).pipe(Effect.map((where): readonly [ToolCallId, string] => [job.toolCallId, where])),
    ),
  )
  const interrupted = jobNotice(stopped, {
    id: "exec-tools-interrupted",
    intro:
      "# Interrupted background commands\n\nThese background commands stopped before they finished (a server restart or a reload). They are not running, except one marked as possibly still running. A file named below holds only the output written before the stop; output after that is lost. Tell the user which commands did not finish; start one again only when the user asks for it.",
    line: (job) => {
      let state = ""
      if (job.mayStillRun) state = " · may still be running: check before starting it again"
      return `- \`${noticeCommand(job.command)}\` · call ${job.toolCallId}${state} · ${saved.get(job.toolCallId) ?? "no output was saved"}`
    },
    rest: "interrupted commands",
  })
  const finished = yield* storage.undeliveredJobs(branch)
  const outputs = new Map(
    yield* Effect.forEach(finished.slice(0, maximumNoticeJobs), (job) =>
      storedOutputFile(
        rowOutputFile(
          path,
          dataDir,
          { ...branch, toolCallId: job.toolCallId },
          job.state.outputFile,
        ),
        job.state,
      ).pipe(
        Effect.map((file): readonly [ToolCallId, string] => [
          job.toolCallId,
          storedJobOutput(job.state.message ?? "", file)(maximumNoticeOutputChars),
        ]),
      ),
    ),
  )
  const undelivered = jobNotice(finished, {
    id: "exec-tools-undelivered",
    intro:
      "# Background commands finished\n\nThese background commands finished before a follow-up reported them. Tell the user what they returned.",
    line: (job) => {
      let outcome = "failed"
      if (job.state.status === "completed") outcome = `exit code ${job.state.exitCode ?? 0}`
      const output = outputs.get(job.toolCallId) ?? ""
      return `- \`${noticeCommand(job.state.command)}\` · ${outcome} · call ${job.toolCallId}\n\`\`\`\n${output}\n\`\`\``
    },
    rest: "finished commands",
  })
  return [...interrupted, ...undelivered]
})

/**
 * Marks read the interrupted and undelivered jobs the turn read. The runtime
 * hands back only what an answered turn showed: an interrupted, failed or
 * unanswered turn keeps them, and so does every job the turn did not show.
 */
const markReadJobNotices = Effect.fn("ExecTools.markJobNoticesRead")(function* (
  input: TurnAfterInput,
) {
  if (input.readNotices.size === 0) return
  yield* (yield* BackgroundBashStorage).markNoticesRead(
    { sessionId: input.sessionId, branchId: input.branchId },
    [...input.readNotices].map((id) => ToolCallId.make(id)),
  )
})

interface BackgroundBashSupervisorService {
  /** Starts the job at most once; returns the file its output streams to. */
  readonly start: (
    job: BackgroundBashJob,
  ) => Effect.Effect<
    string,
    BackgroundBashStorageError | BackgroundBashError,
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | Path.Path
    | Crypto.Crypto
    | ExtensionContext
  >
}

class BackgroundBashSupervisor extends Context.Service<
  BackgroundBashSupervisor,
  BackgroundBashSupervisorService
>()("@gent/extensions/src/exec-tools/BackgroundBashSupervisor") {}

export const BackgroundBashSupervisorLive: Layer.Layer<
  BackgroundBashSupervisor,
  never,
  BackgroundBashStorage
> = Layer.effect(
  BackgroundBashSupervisor,
  Effect.gen(function* () {
    const storage = yield* BackgroundBashStorage
    const scope = yield* Effect.scope
    const gate = yield* Semaphore.make(1)
    // Keys this process already delivered a terminal notice for. The durable
    // row outlives them, so without this a repeated start of a finished job
    // would replay its notice; the fibers themselves need no map, because the
    // durable claim answers AlreadyRunning and scope close interrupts them.
    const completed = yield* Ref.make<ReadonlyMap<BackgroundBashJobKey, string>>(new Map())
    const rememberCompleted = (key: BackgroundBashJobKey, file: string) =>
      Ref.update(completed, (keys) => new Map(keys).set(key, file))

    const runBackgroundJob = Effect.fn("BackgroundBashSupervisor.runBackgroundJob")(function* (
      job: BackgroundBashJob,
      target: BackgroundBashTarget,
    ) {
      const file = target.outputFile
      // A server that ends without its finalizers leaves the process behind;
      // the row names it so the next server can stop it. A failed record
      // leaves the job running, and a restart reports it as unchecked.
      const recordProcess = (pid: number) =>
        processStartIdentity(pid).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (startIdentity) =>
                storage.recordProcess(backgroundJobKeyFields(target), { pid, startIdentity }),
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("exec-tools.job-process.record.failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            ),
          ),
        )
      const { exitCode, output } = yield* streamBackgroundCommand(
        job.command,
        job.cwd,
        file,
        recordProcess,
      ).pipe(
        Effect.scoped,
        Effect.catchTag("PlatformError", (e) =>
          Effect.fail(
            new BashError({
              message: `Background command failed: ${e.message}`,
              command: job.command,
            }),
          ),
        ),
      )

      // The row keeps the output as a notice shows it; the file keeps all of it.
      const state: BackgroundBashTerminalState = {
        status: "completed",
        command: job.command,
        exitCode,
        message: jobOutputText(output, maximumNoticeOutputChars),
      }
      yield* storage.markCompleted(backgroundJobKeyFields(target), {
        exitCode,
        message: state.message ?? "",
      })
      yield* deliverTerminal(target, state, (maxChars) => jobOutputText(output, maxChars))
    })

    /**
     * Queues the settled job's message and records the outcome, the one
     * writer that clears the terminal update's pending delivery mark after
     * admission succeeds. A refused or interrupted send leaves a notice for
     * the next turn; replay uses the same stable follow-up identity.
     */
    const deliverTerminal = (
      target: BackgroundBashTarget,
      state: BackgroundBashTerminalState,
      output?: (maxChars: number) => string,
    ) =>
      Effect.gen(function* () {
        // A replay has only the row: it names the job's file when the file exists.
        const text = yield* Option.match(Option.fromUndefinedOr(output), {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.gen(function* () {
              const file = target.outputFile
              return storedJobOutput(state.message ?? "", yield* storedOutputFile(file, state))
            }),
        })
        const delivered = yield* queueTerminalFollowUp(target, state, text)
        return yield* storage.recordDelivery(backgroundJobKeyFields(target), delivered)
      })

    const queueFailure = (job: BackgroundBashJob, target: BackgroundBashTarget, message: string) =>
      Effect.gen(function* () {
        const keyFields = backgroundJobKeyFields(target)
        yield* storage.markFailed(keyFields, message).pipe(
          Effect.andThen(
            deliverTerminal(target, { status: "failed", command: job.command, message }),
          ),
          Effect.catchTag("BackgroundBashStorageError", () => Effect.void),
        )
      })

    const start = (job: BackgroundBashJob) =>
      Effect.gen(function* () {
        const ctx = yield* ExtensionContext
        if (Predicate.isUndefined(ctx.toolCallId)) {
          return yield* new BackgroundBashError({
            message: "Background bash requires a host-owned tool call",
          })
        }
        const keyFields = {
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          toolCallId: ctx.toolCallId,
        }
        const path = yield* Path.Path
        const dataDir = yield* resolveDataDir(ctx.home)
        const file = yield* jobOutputFile(path, dataDir, keyFields).pipe(
          Effect.catchTag("PlatformError", (e) => new BackgroundBashError({ message: e.message })),
        )
        const target: BackgroundBashTarget = {
          ...keyFields,
          Session: ctx.Session,
          outputFile: file,
        }
        const key = backgroundJobKey(target)
        const completedFile = (yield* Ref.get(completed)).get(key)
        if (Predicate.isNotUndefined(completedFile)) return completedFile
        // Commit the claim and install its worker owner without an interruption gap.
        // Permit acquisition and terminal replay remain interruptible; the child
        // fork is interruptible independently of this transfer mask.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const claim = yield* storage.claimStart({
              ...keyFields,
              command: job.command,
              cwd: job.cwd,
              outputFile: file,
            })
            if (claim._tag === "AlreadyRunning")
              return rowOutputFile(path, dataDir, keyFields, claim.outputFile)
            if (claim._tag === "Terminal") {
              const outputFile = rowOutputFile(path, dataDir, keyFields, claim.state.outputFile)
              yield* restore(deliverTerminal({ ...target, outputFile }, claim.state))
              yield* rememberCompleted(key, outputFile)
              return outputFile
            }

            const fullContext = yield* Effect.context<
              ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
            >()
            // forkIn inherits the parent fiber's full context, and provideContext
            // would only merge on top — request-scoped tags carried by the caller
            // (e.g., CurrentInteraction) would leak into the long-lived background
            // fork. updateContext replaces the forked fiber's context outright,
            // pinning it to the explicit slice the background helpers need.
            const jobContext = Context.pick(
              ChildProcessSpawner.ChildProcessSpawner,
              FileSystem.FileSystem,
              Path.Path,
              References.CurrentLoggers,
              References.MinimumLogLevel,
            )(fullContext)
            yield* runBackgroundJob(job, target).pipe(
              // The server stopped or the resource closed: the row must not stay
              // running under this process, where no reconcile would reach it.
              // The branch's next turn reads it as a notice.
              Effect.onInterrupt(() => storage.markInterrupted(keyFields).pipe(Effect.ignore)),
              Effect.catchTag("BashError", (e) => queueFailure(job, target, e.message)),
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.void
                return queueFailure(job, target, `Internal error: ${Cause.pretty(cause)}`)
              }),
              Effect.ensuring(rememberCompleted(key, file)),
              Effect.updateContext(
                (
                  _: Context.Context<
                    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
                  >,
                ) => jobContext,
              ),
              // A fiber interrupted before its first step runs none of it, the
              // interrupt mark included. Starting at once installs the mark
              // before transferring the claim to the resource scope.
              Effect.forkIn(scope, { startImmediately: true }),
            )
            return file
          }),
        )
      }).pipe(gate.withPermits(1))

    return BackgroundBashSupervisor.of({ start })
  }),
)

// A job still marked running that an earlier server process started has lost
// its server. A crash skips the finalizers, so its process may still run:
// stop each recorded process group that still holds the job (its leader
// is the recorded process, or exited and left descendants in the group),
// then mark the jobs interrupted before the supervisor takes new
// work. A job this process runs stays running when another profile builds.
const ReconcileInterruptedJobs = Layer.effectDiscard(
  Effect.gen(function* () {
    const storage = yield* BackgroundBashStorage
    const stale = yield* storage.staleProcesses
    const stopped = yield* Effect.forEach(stale, stopStaleProcess, { concurrency: 8 })
    yield* storage.reconcileInterrupted(stale.filter((_, i) => !stopped[i]).map((job) => job.pid))
  }),
)

export const BackgroundBashLayer = BackgroundBashSupervisorLive.pipe(
  Layer.provideMerge(ReconcileInterruptedJobs),
  Layer.provideMerge(BackgroundBashStorage.Live),
)

/** The background shell supervisor: one per process, for every bash call. */
const BackgroundBashResource = defineResource({
  id: "@gent/exec-tools/background-bash",
  scope: "process",
  layer: BackgroundBashLayer,
})

// Bash Tool

export const BashTool = tool({
  id: "bash",
  destructive: true,
  resources: [BackgroundBashResource],
  description: `Execute shell command. Use for git, npm, system commands. Prefer dedicated tools for file ops. stdout and stderr each come back whole up to ${wholeCommandOutputText} characters; past that the result keeps each one's head and tail, and outputFile names a file with all the output (outputChars long, stdout and stderr in arrival order): page it with the read tool's offset and limit.`,
  promptSnippet: "Execute shell commands",
  params: BashParams,
  output: BashResult,
  summary: (_input, output) => {
    if (output.status === "background") return "started in background"
    return `exit ${output.exitCode} · ${countOf(lineCount(output.stdout) + lineCount(output.stderr), "line")}`
  },
  execute: Effect.fn("BashTool.execute")(function* (params: typeof BashParams.Type) {
    const ctx = yield* ExtensionContext
    const timeout = Math.min(
      Option.getOrElse(Option.fromNullishOr(params.timeout), () => 120000),
      600000,
    )

    // Bash owns directory changes, expansion and control operators. Only
    // the explicit cwd parameter resolves against the session directory.
    const command = params.command
    const path = yield* Path.Path
    const cwd = Option.some(path.resolve(ctx.cwd, params.cwd ?? "."))

    // Background mode — hand the process to the process-scoped supervisor.
    // The tool returns immediately; the resource owns process lifetime and
    // completion follow-up.
    if (params.run_in_background === true) {
      const supervisor = yield* BackgroundBashSupervisor
      const file = yield* supervisor.start({ command, cwd })

      return {
        stdout: `Command started in background: \`${command}\`\nIts output streams to ${file}; read that file to see it while the command runs. You will be notified when it completes.`,
        stderr: "",
        exitCode: 0,
        status: "background",
      }
    }

    // Sync mode: the process lives in its own scope. On timeout a detached
    // fiber closes it (SIGTERM, then SIGKILL after `SIGKILL_DELAY_MS`), and
    // starts at once, so the scope is already closing when the `ensuring`
    // below runs and that close returns without waiting: the call returns at
    // its timeout even when the command ignores SIGTERM. Any other end closes
    // the scope in the `ensuring`.
    // Output past what the result keeps goes to the call's file, where a
    // background job's output goes; a call with no host id keeps only the ends.
    const dataDir = yield* resolveDataDir(ctx.home)
    let spill = Option.none<string>()
    if (!Predicate.isUndefined(ctx.toolCallId)) {
      spill = Option.some(
        yield* jobOutputFile(path, dataDir, {
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          toolCallId: ctx.toolCallId,
        }).pipe(
          Effect.catchTag("PlatformError", (e) => new BashError({ command, message: e.message })),
        ),
      )
    }
    const spawnScope = yield* Scope.make()
    const closeSpawnScope = Scope.close(spawnScope, Exit.void).pipe(Effect.ignore)
    const result = yield* runBashCommand(command, cwd, spill).pipe(
      Scope.provide(spawnScope),
      Effect.timeoutOrElse({
        duration: Duration.millis(timeout),
        orElse: () =>
          Effect.forkDetach(closeSpawnScope, { startImmediately: true }).pipe(
            Effect.andThen(
              Effect.fail(
                new BashError({ message: `Command timed out after ${timeout}ms`, command }),
              ),
            ),
          ),
      }),
      Effect.ensuring(closeSpawnScope),
      Effect.catchTag("PlatformError", (e) =>
        Effect.fail(new BashError({ message: `Failed to execute command: ${e.message}`, command })),
      ),
    )

    // The stored result keeps each stream whole or its ends, and names the
    // file with all of it; the transcript bounds the model-facing copy at
    // `maximumModelToolResultChars`.
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ...Option.match(result.spilled, {
        onNone: () => ({}),
        onSome: (spilled) => ({ outputFile: spilled.file, outputChars: spilled.totalChars }),
      }),
    }
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

/**
 * @gent/exec-tools — shell-execution capability surface.
 *
 * Background shell work is owned by a process-scoped supervisor resource. The
 * bash tool submits keyed jobs and returns immediately; the resource owns the
 * child process scope and completion follow-up.
 */

const EXEC_TOOLS_EXTENSION_ID = ExtensionId.make("@gent/exec-tools")

export const ExecToolsExtension = defineExtension({
  id: EXEC_TOOLS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", BashTool)
    yield* host.register("resource", BackgroundBashResource)
    yield* host.on("turnProjection", () =>
      jobNotices().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("exec-tools.job-notice.read.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            Effect.as([]),
          ),
        ),
        Effect.map((notices) => ({ notices })),
      ),
    )
    yield* host.on("turnAfter", (input) =>
      markReadJobNotices(input).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("exec-tools.job-notice.clear.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    )
    yield* host.on("sessionDeleted", ({ sessionId }) => removeSessionOutputs(sessionId))
  }),
})
