import {
  Array as Arr,
  Cause,
  Context,
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
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { countOf } from "./fs-tools.js"
import {
  type BranchId,
  defineExtension,
  defineResource,
  ExtensionContext,
  type ExtensionContextService,
  ExtensionHost,
  ExtensionId,
  headTailChars,
  lineCount,
  maximumModelToolResultChars,
  resolveDataDir,
  type SessionId,
  tool,
  ToolCallId,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

// Test seam: only tests read these exports. BackgroundBashStorage, its error,
// BackgroundBashSupervisorLive and BackgroundBashLayer let a test inject a
// storage fault; addBackgroundBashColumn lets it replay a migration race.
// BashParams encodes a model's tool input. splitCdCommand,
// stripBackground and injectGitTrailers are pure transforms with unit tests.

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
}

const BackgroundBashTerminalState = Schema.Struct({
  status: BackgroundBashTerminalStatus,
  command: Schema.String,
  exitCode: Schema.optional(Schema.Finite),
  message: Schema.optional(Schema.String),
})
type BackgroundBashTerminalState = typeof BackgroundBashTerminalState.Type

const BackgroundBashClaim = Schema.TaggedUnion({
  Started: {},
  AlreadyRunning: {},
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
  /** Marks the running jobs an earlier server process started as interrupted. */
  readonly reconcileInterrupted: Effect.Effect<void, BackgroundBashStorageError>
  /** The branch's jobs that did not finish and no answered turn has read, oldest first. */
  readonly interruptedJobs: (
    branch: BackgroundBashBranch,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly toolCallId: ToolCallId; readonly command: string }>,
    BackgroundBashStorageError
  >
  /**
   * Records whether a settled job's follow-up message was sent. A refused
   * send (a full follow-up queue, for one) marks the job, and the branch's
   * next turn reads it as a notice; a later accepted send, a replay after a
   * restart for one, clears the mark, so the model does not get it twice.
   */
  readonly recordDelivery: (
    key: BackgroundBashJobKeyFields,
    delivered: boolean,
  ) => Effect.Effect<void, BackgroundBashStorageError>
  /** The branch's settled jobs whose follow-up was refused and no answered turn has read, oldest first. */
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
        // The server process that owns the jobs this layer starts: every
        // profile in one process shares it, a restarted server has another.
        const generation = yield* Effect.sync(() => String(performance.timeOrigin))

        const selectJob = Effect.fn("BackgroundBashStorage.selectJob")(function* (
          key: BackgroundBashJobKeyFields,
        ) {
          const rows = yield* sql<BackgroundBashJobRow>`
          SELECT command, status, exit_code, message
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
              message = ${message}
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
                    return BackgroundBashClaim.cases.AlreadyRunning.make({})
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
                    owner_generation
                  )
                  VALUES (
                    ${input.sessionId},
                    ${input.branchId},
                    ${input.toolCallId},
                    ${input.command},
                    ${Option.getOrNull(input.cwd)},
                    'running',
                    ${startedAt},
                    ${generation}
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

          interruptedJobs: Effect.fn("BackgroundBashStorage.interruptedJobs")(
            function* (branch) {
              const rows = yield* sql<{ readonly tool_call_id: string; readonly command: string }>`
                SELECT tool_call_id, command
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
                SELECT tool_call_id, command, status, exit_code, message
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

          reconcileInterrupted: Effect.gen(function* () {
            const completedAt = (yield* DateTime.nowAsDate).getTime()
            yield* sql`
              UPDATE background_bash_jobs
              SET status = 'interrupted',
                  completed_at = ${completedAt},
                  message = 'Background command interrupted by server restart'
              WHERE status = 'running'
                AND (owner_generation IS NULL OR owner_generation != ${generation})
            `
          }).pipe(
            Effect.mapError(mapError("Failed to reconcile interrupted background bash jobs")),
          ),
        })
      }),
    )
}

// ── bash tool ───────────────────────────────────────────────────────────────
//
// The bash tool runs every command as given: nothing classifies it and
// nothing asks. It reads the command as shell words for one rewrite only:
// the session trailer on each `git commit` (`injectGitTrailers`).

// ── shell words ──
//
// Commands are read as shell words, not as raw text. Global options, env
// prefixes, wrappers, quoting and redirections cannot hide a command, and
// quoted text or a heredoc body is never read as a command. Each word keeps
// the source offset of every character, so a rewrite (the commit trailer)
// lands at the right place, also inside a script a shell runs.

interface ShellWord {
  readonly text: string
  /** Source offset of each character of `text`. */
  readonly map: ReadonlyArray<number>
  /**
   * For each character of `text`: text inserted after it stays inside one
   * script word at every level. Top-level text is always safe; a nested
   * script is safe only where its outer word was quoted (`'git commit'`),
   * not where it was escaped (`git\ commit`).
   */
  readonly safe: ReadonlyArray<boolean>
  /** Source offset just past the word, closing quote included. */
  readonly end: number
  /** Text inserted at `end` stays inside one script word at every level. */
  readonly endSafe: boolean
  /** The word holds a parameter expansion or a command substitution: its text is known only at run time. */
  readonly dynamic: boolean
}

interface ShellSegment {
  readonly words: Array<ShellWord>
  /** Here-strings and heredoc bodies: what the command reads on stdin. */
  readonly stdin: Array<ShellWord>
  /** The targets of its `<` redirections: files it reads on stdin in place of its pipe. */
  readonly reads: Array<ShellWord>
  /**
   * The segment whose output this one reads on stdin: the command piped into
   * it, or into the subshell, group, loop or `if` around it.
   */
  readonly pipedFrom: Option.Option<ShellSegment>
  /**
   * A file the command reads its input from in place of its stdin: the
   * `-a`/`--arg-file` or `::::` file of the `xargs` or `parallel` that runs it.
   */
  readonly inputFile: Option.Option<string>
}

interface PendingHeredoc {
  readonly segment: ShellSegment
  readonly delimiter: string
  readonly stripTabs: boolean
  /** An unquoted delimiter: the body expands `$(...)` and backticks. */
  readonly expands: boolean
}

/** What the next word of a segment is: an argument, or the operand of a redirection. */
type WordRole =
  | "argument"
  | "redirect-target"
  | "input-target"
  | "here-string"
  | "heredoc-delimiter"

/**
 * Where a command list is inside an open `case`: reading its subject, a
 * pattern (where `)` ends the pattern), or a body.
 */
type CaseState = "subject" | "pattern" | "body"

/** Characters a backslash escapes inside double quotes. */
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\"])

/** The text being parsed and the segments found so far. */
interface ShellSource {
  readonly text: string
  /** Source offset of each character of `text`. */
  readonly map: ReadonlyArray<number>
  /** See `ShellWord.safe`. */
  readonly safe: ReadonlyArray<boolean>
  readonly segments: Array<ShellSegment>
}

/** The state of one command list: the top level, or the inside of `$(...)`, `(...)` or backticks. */
interface CommandReader {
  readonly source: ShellSource
  segment: ShellSegment
  wordText: string
  wordMap: Array<number>
  wordSafe: Array<boolean>
  wordEnd: number
  wordEndSafe: boolean
  dynamic: boolean
  inWord: boolean
  quoted: boolean
  role: WordRole
  stripTabs: boolean
  readonly heredocs: Array<PendingHeredoc>
  /** The open `case` statements, innermost last. */
  readonly cases: Array<CaseState>
  /** The stdin of this command list: what the command around a `(…)` or `$(…)` reads. */
  readonly input: Option.Option<ShellSegment>
  /** The stdin of each open `{`, `if`, `while`, `until`, `for`, `select` or `case`, innermost last. */
  readonly compounds: Array<Option.Option<ShellSegment>>
}

const makeSegment = (pipedFrom: Option.Option<ShellSegment>): ShellSegment => ({
  words: [],
  stdin: [],
  reads: [],
  pipedFrom,
  inputFile: Option.none(),
})

const sourceOffset = (source: ShellSource, index: number) => source.map[index] ?? index
const sourceSafe = (source: ShellSource, index: number) => source.safe[index] ?? false

/** `$name`, `${…}`, `$1`, `$@`: a parameter expansion starts at `index`. */
const startsExpansion = (text: string, index: number) =>
  text.charAt(index) === "$" && /[\w{@*#?!$-]/.test(text.charAt(index + 1))

/** Text known only at run time: an expansion or a substitution. */
const DYNAMIC_TEXT = /\$[\w{(@*#?!$-]|`/

/** The characters `start` to `end` of the source as one word; `expands` when the shell expands it (a heredoc body). */
const sourceWord = (
  source: ShellSource,
  start: number,
  end: number,
  expands: boolean,
): ShellWord => {
  const map: Array<number> = []
  const safe: Array<boolean> = []
  for (let index = start; index < end; index++) {
    map.push(sourceOffset(source, index))
    safe.push(sourceSafe(source, index))
  }
  const text = source.text.slice(start, end)
  return {
    text,
    map,
    safe,
    end: sourceOffset(source, end - 1) + 1,
    endSafe: sourceSafe(source, end - 1),
    dynamic: expands && DYNAMIC_TEXT.test(text),
  }
}

/**
 * Add `text` as what the source character at `index` stands for (an escape
 * maps to its last character); `quoted` when a quote around it keeps an
 * insertion inside the word.
 */
const addText = (reader: CommandReader, text: string, index: number, quoted: boolean) => {
  for (const unit of text.split("")) {
    reader.wordText += unit
    reader.wordMap.push(sourceOffset(reader.source, index))
    reader.wordSafe.push(quoted && sourceSafe(reader.source, index))
  }
  reader.wordEnd = sourceOffset(reader.source, index) + 1
  reader.wordEndSafe = sourceSafe(reader.source, index)
  reader.inWord = true
}

const addChar = (reader: CommandReader, index: number, quoted: boolean) =>
  addText(reader, reader.source.text.charAt(index), index, quoted)

const addRange = (reader: CommandReader, start: number, end: number, quoted: boolean) => {
  for (let index = start; index < end && index < reader.source.text.length; index++) {
    addChar(reader, index, quoted)
  }
}

/** A quote character is part of the word but not of its text. */
const addQuote = (reader: CommandReader, index: number) => {
  if (index < reader.source.text.length) {
    reader.wordEnd = sourceOffset(reader.source, index) + 1
    reader.wordEndSafe = sourceSafe(reader.source, index)
  }
  reader.inWord = true
  reader.quoted = true
}

const clearWord = (reader: CommandReader) => {
  reader.wordText = ""
  reader.wordMap = []
  reader.wordSafe = []
  reader.wordEndSafe = false
  reader.dynamic = false
  reader.inWord = false
  reader.quoted = false
}

/**
 * The words that open, split and close a `case`: `case` in command position,
 * `in` after the subject, and `esac`. Pattern words are data. Returns true
 * when the word belongs to the `case` syntax and is no argument.
 */
const readCaseWord = (reader: CommandReader, word: ShellWord): boolean => {
  const keyword = !reader.quoted && !word.dynamic
  const depth = reader.cases.length - 1
  const state = reader.cases[depth]
  const commandPosition = reader.segment.words.length === 0
  if (state === "subject" && keyword && word.text === "in") {
    reader.cases[depth] = "pattern"
    return true
  }
  if (state === "pattern") {
    if (keyword && word.text === "esac") reader.cases.pop()
    return true
  }
  if (state === "body" && keyword && commandPosition && word.text === "esac") {
    reader.cases.pop()
    return true
  }
  if (keyword && commandPosition && word.text === "case") reader.cases.push("subject")
  return false
}

/** Words that open a compound command whose commands share its stdin, and the words that close one. */
const COMPOUND_OPENERS = new Set(["{", "if", "while", "until", "for", "select", "case"])
const COMPOUND_CLOSERS = new Set(["}", "fi", "done", "esac"])

/** A compound command in command position passes its stdin to the commands inside it. */
const readCompoundWord = (reader: CommandReader, word: ShellWord) => {
  if (reader.quoted || word.dynamic || reader.segment.words.length > 0) return
  if (COMPOUND_OPENERS.has(word.text)) reader.compounds.push(reader.segment.pipedFrom)
  if (COMPOUND_CLOSERS.has(word.text)) reader.compounds.pop()
}

/** The stdin of a command that no pipe feeds: that of the innermost compound around it. */
const inheritedInput = (reader: CommandReader): Option.Option<ShellSegment> =>
  Option.getOrElse(Arr.last(reader.compounds), () => reader.input)

const endWord = (reader: CommandReader) => {
  if (reader.inWord) {
    const word: ShellWord = {
      text: reader.wordText,
      map: reader.wordMap,
      safe: reader.wordSafe,
      end: reader.wordEnd,
      endSafe: reader.wordEndSafe,
      dynamic: reader.dynamic,
    }
    if (reader.role === "argument") readCompoundWord(reader, word)
    if (reader.role === "argument" && !readCaseWord(reader, word)) reader.segment.words.push(word)
    if (reader.role === "here-string") reader.segment.stdin.push(word)
    // `bash < <(cmd)`: the shell reads a script that only exists at run time.
    if (reader.role === "input-target" && isProcessSubstitution(word)) {
      reader.segment.stdin.push(word)
    } else if (reader.role === "input-target") {
      reader.segment.reads.push(word)
    }
    if (reader.role === "heredoc-delimiter") {
      reader.heredocs.push({
        segment: reader.segment,
        delimiter: word.text,
        stripTabs: reader.stripTabs,
        expands: !reader.quoted,
      })
    }
    reader.role = "argument"
  }
  clearWord(reader)
}

const endSegment = (reader: CommandReader, piped: boolean) => {
  endWord(reader)
  reader.role = "argument"
  const segment = reader.segment
  if (segment.words.length > 0 || segment.stdin.length > 0) {
    reader.source.segments.push(segment)
  }
  let pipedFrom = inheritedInput(reader)
  if (piped) pipedFrom = Option.some(segment)
  reader.segment = makeSegment(pipedFrom)
}

const startsSubstitution = (text: string, index: number) =>
  text.charAt(index) === "`" || (text.charAt(index) === "$" && text.charAt(index + 1) === "(")

/**
 * Read the commands of the `$(...)` or backticks at `index`; returns the
 * index after them. They read the stdin of the command around them, `input`.
 * `$((…))` is arithmetic: its words are data, and only the substitutions
 * inside it run.
 */
function readSubstitution(
  source: ShellSource,
  index: number,
  input: Option.Option<ShellSegment>,
): number {
  if (source.text.charAt(index) === "`") {
    return readCommands(source, index + 1, Option.some("`"), input)
  }
  if (source.text.startsWith("$((", index)) {
    const end = arithmeticEnd(source, index + 3)
    if (Option.isSome(end)) return readArithmetic(source, index + 3, end.value, input)
  }
  return readCommands(source, index + 2, Option.some(")"), input)
}

/**
 * Where the arithmetic that starts at `from` (after `((` or `$((`) ends: the
 * index of the first `)` of a closing `))`, as bash finds it. With no such
 * `))`, bash reads `((` as two subshells and `$((` as a substitution that
 * opens one. A substitution inside is read on a scratch copy of the source,
 * so its commands are found once, by the reader that decides.
 */
function arithmeticEnd(source: ShellSource, from: number): Option.Option<number> {
  const text = source.text
  const scratch: ShellSource = { ...source, segments: [] }
  let depth = 0
  let at = from
  while (at < text.length) {
    const skipped = skipQuotedText(scratch, at)
    if (Option.isNone(skipped)) return Option.none()
    const char = text.charAt(at)
    if (skipped.value === at && char === ")" && depth === 0) {
      return Option.filter(Option.some(at), () => text.charAt(at + 1) === ")")
    }
    if (skipped.value === at && char === "(") depth++
    if (skipped.value === at && char === ")") depth--
    at = Math.max(skipped.value, at + 1)
  }
  return Option.none()
}

/**
 * The index after the escape, quoted run or substitution at `at`, or `at`
 * for any other character; none for a quote that does not close.
 */
function skipQuotedText(source: ShellSource, at: number): Option.Option<number> {
  const text = source.text
  const char = text.charAt(at)
  if (char === "\\") return Option.some(at + 2)
  if (startsSubstitution(text, at)) return Option.some(readSubstitution(source, at, Option.none()))
  if (char === "'") {
    const close = text.indexOf("'", at + 1)
    return Option.filter(Option.some(close + 1), () => close !== -1)
  }
  if (char !== '"') return Option.some(at)
  let index = at + 1
  while (index < text.length && text.charAt(index) !== '"') {
    if (text.charAt(index) === "\\") index += 2
    else if (startsSubstitution(text, index)) index = readSubstitution(source, index, Option.none())
    else index++
  }
  return Option.filter(Option.some(index + 1), () => index < text.length)
}

/** The substitutions inside the arithmetic from `from` to `end` run; returns the index after its `))`. */
function readArithmetic(
  source: ShellSource,
  from: number,
  end: number,
  input: Option.Option<ShellSegment>,
): number {
  readExpansions(source, from, end, input)
  return end + 2
}

/**
 * Read the `${…}` at `index`: a `)`, `;` or quote inside it (`${x:-)}`) does
 * not end the word or the command list around it, and a substitution inside
 * it runs. `quoted` when the expansion is inside double quotes. Returns the
 * index after its `}`.
 */
function readParameterExpansion(reader: CommandReader, index: number, quoted: boolean): number {
  const text = reader.source.text
  let depth = 0
  let doubleQuoted = false
  let at = index
  while (at < text.length) {
    const char = text.charAt(at)
    if (char === "\\") {
      at += 2
    } else if (startsSubstitution(text, at)) {
      at = readSubstitution(reader.source, at, reader.segment.pipedFrom)
    } else if (char === '"') {
      doubleQuoted = !doubleQuoted
      at++
    } else if (doubleQuoted) {
      at++
    } else if (text.startsWith("${", at)) {
      depth++
      at += 2
    } else if (char === "}") {
      depth--
      at++
      if (depth === 0) break
    } else if (char === "'" && !quoted) {
      const close = text.indexOf("'", at + 1)
      at = text.length
      if (close !== -1) at = close + 1
    } else {
      at++
    }
  }
  const end = Math.min(at, text.length)
  addRange(reader, index, end, quoted)
  reader.dynamic = true
  return end
}

/** Read a double-quoted run from `from`; returns the index of the closing quote. */
const readDoubleQuoted = (reader: CommandReader, from: number): number => {
  const text = reader.source.text
  let index = from
  while (index < text.length && text.charAt(index) !== '"') {
    const next = text.charAt(index + 1)
    if (text.charAt(index) === "\\" && next === "\n") {
      index += 2
    } else if (text.charAt(index) === "\\" && DOUBLE_QUOTE_ESCAPES.has(next)) {
      addChar(reader, index + 1, true)
      index += 2
    } else if (startsSubstitution(text, index)) {
      const end = readSubstitution(reader.source, index, reader.segment.pipedFrom)
      addRange(reader, index, end, true)
      reader.dynamic = true
      index = end
    } else if (text.startsWith("${", index)) {
      index = readParameterExpansion(reader, index, true)
    } else {
      if (startsExpansion(text, index)) reader.dynamic = true
      addChar(reader, index, true)
      index++
    }
  }
  return index
}

/** One ANSI-C escape of `$'…'`: `\n`, `\'`, octal, `\x`, `\u`, `\U` or a `\c` control character. */
const ANSI_C_ESCAPE =
  /^\\(?:([abeEfnrtv\\'"?])|([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|c(.))/s

const ANSI_C_LETTERS = new Map([
  ["a", "\x07"],
  ["b", "\b"],
  ["e", "\x1b"],
  ["E", "\x1b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
])

/** The character an ANSI-C escape stands for. */
const ansiCChar = (escape: RegExpExecArray): string => {
  // One group matches; the others are empty.
  const [, letter = "", octal = "", hex = "", unicode = "", wide = "", control = ""] = escape
  if (letter !== "")
    return Option.getOrElse(Option.fromUndefinedOr(ANSI_C_LETTERS.get(letter)), () => letter)
  if (control !== "") return String.fromCharCode(control.charCodeAt(0) & 31)
  let code = Number.parseInt(`${hex}${unicode}${wide}`, 16)
  if (octal !== "") code = Number.parseInt(octal, 8)
  if (code > 0x10ffff) return "\ufffd"
  return String.fromCodePoint(code)
}

/** Read `$'…'` text from `from`: a backslash escape, `\'` included, does not close it. Returns the index of the closing quote. */
const readAnsiCQuoted = (reader: CommandReader, from: number): number => {
  const text = reader.source.text
  let index = from
  while (index < text.length && text.charAt(index) !== "'") {
    const escape = Option.fromNullishOr(ANSI_C_ESCAPE.exec(text.slice(index, index + 10)))
    if (Option.isSome(escape)) {
      const length = escape.value[0].length
      addText(reader, ansiCChar(escape.value), index + length - 1, true)
      index += length
    } else {
      addChar(reader, index, true)
      index++
    }
  }
  return index
}

const readSingleQuoted = (reader: CommandReader, from: number): number => {
  let index = from
  while (index < reader.source.text.length && reader.source.text.charAt(index) !== "'") {
    addChar(reader, index, true)
    index++
  }
  return index
}

/** Where a heredoc body that starts at `from` ends, and the index after its delimiter line. */
const heredocBodyEnd = (text: string, from: number, heredoc: PendingHeredoc) => {
  let index = from
  while (index < text.length) {
    let lineEnd = text.indexOf("\n", index)
    if (lineEnd === -1) lineEnd = text.length
    let line = text.slice(index, lineEnd)
    if (heredoc.stripTabs) line = line.replace(/^\t+/, "")
    const next = Math.min(lineEnd + 1, text.length)
    if (line === heredoc.delimiter) return { bodyEnd: index, next }
    index = next
  }
  return { bodyEnd: text.length, next: text.length }
}

/** The `$(...)` and backticks of an expanding heredoc body or of arithmetic run. */
function readExpansions(
  source: ShellSource,
  from: number,
  to: number,
  input: Option.Option<ShellSegment>,
) {
  for (let index = from; index < to; index++) {
    if (source.text.charAt(index) === "\\") index++
    else if (startsSubstitution(source.text, index))
      index = readSubstitution(source, index, input) - 1
  }
}

/** Read the bodies of the heredocs opened on the line that ends before `from`. */
const readHeredocBodies = (reader: CommandReader, from: number): number => {
  const source = reader.source
  let index = from
  for (const heredoc of reader.heredocs) {
    const { bodyEnd, next } = heredocBodyEnd(source.text, index, heredoc)
    heredoc.segment.stdin.push(sourceWord(source, index, bodyEnd, heredoc.expands))
    if (heredoc.expands) readExpansions(source, index, bodyEnd, Option.none())
    index = next
  }
  reader.heredocs.length = 0
  return index
}

/** A quoted run: `'…'`, `"…"`, and the ANSI-C and locale forms `$'…'` and `$"…"`. */
const readQuote = (reader: CommandReader, index: number): Option.Option<number> => {
  const text = reader.source.text
  const dollar = text.charAt(index) === "$"
  let open = index
  if (dollar) open++
  const quote = text.charAt(open)
  if (quote !== "'" && quote !== '"') return Option.none()
  addQuote(reader, open)
  let close = open + 1
  if (quote === '"') close = readDoubleQuoted(reader, close)
  else if (dollar) close = readAnsiCQuoted(reader, close)
  else close = readSingleQuoted(reader, close)
  addQuote(reader, close)
  return Option.some(close + 1)
}

/** A backslash escape, a line continuation, or a comment. */
const readEscape = (reader: CommandReader, index: number): Option.Option<number> => {
  const text = reader.source.text
  const char = text.charAt(index)
  if (char === "\\") {
    if (index + 1 < text.length && text.charAt(index + 1) !== "\n") {
      addChar(reader, index + 1, false)
      // An escaped character is quoted: `<<\EOF` is a literal heredoc, `\2>` no descriptor.
      reader.quoted = true
    }
    return Option.some(index + 2)
  }
  if (char !== "#" || reader.inWord) return Option.none()
  // A comment runs to the end of the line.
  const lineEnd = text.indexOf("\n", index)
  if (lineEnd === -1) return Option.some(text.length)
  return Option.some(lineEnd)
}

/** `$(...)` or backticks in a word: the commands run, and the text stays in the word. */
const readSubstitutionWord = (reader: CommandReader, index: number): Option.Option<number> => {
  if (!startsSubstitution(reader.source.text, index)) return Option.none()
  const end = readSubstitution(reader.source, index, reader.segment.pipedFrom)
  addRange(reader, index, end, false)
  reader.dynamic = true
  return Option.some(end)
}

/** `${…}` outside double quotes. */
const readParameterWord = (reader: CommandReader, index: number): Option.Option<number> => {
  if (!reader.source.text.startsWith("${", index)) return Option.none()
  return Option.some(readParameterExpansion(reader, index, false))
}

/**
 * Inside a `case`: in a pattern, `(` opens it, `|` joins patterns and `)`
 * ends it; in a body, `;;`, `;&` or `;;&` ends the body.
 */
const readCaseSeparator = (reader: CommandReader, index: number): Option.Option<number> => {
  const text = reader.source.text
  const char = text.charAt(index)
  if (reader.cases.length === 0 || !"()|;".includes(char)) return Option.none()
  // The word before the operator may close the `case` (`esac)`).
  endWord(reader)
  const depth = reader.cases.length - 1
  const state = reader.cases[depth]
  if (state === "pattern" && char === ")") {
    endSegment(reader, false)
    reader.cases[depth] = "body"
    return Option.some(index + 1)
  }
  if (state === "pattern" && (char === "(" || char === "|")) return Option.some(index + 1)
  const end = Option.fromNullishOr(/^;;&?|^;&/.exec(text.slice(index, index + 3)))
  if (state === "body" && Option.isSome(end)) {
    endSegment(reader, false)
    reader.cases[depth] = "pattern"
    return Option.some(index + end.value[0].length)
  }
  return Option.none()
}

const inCasePattern = (reader: CommandReader) =>
  Arr.last(reader.cases).pipe(Option.exists((state) => state === "pattern"))

/** A list or pipe operator, a subshell, or a newline (which reads pending heredoc bodies). */
const readSeparator = (reader: CommandReader, index: number): Option.Option<number> => {
  const text = reader.source.text
  const char = text.charAt(index)
  const pair = text.slice(index, index + 2)
  // `(( … ))` and `for (( … ))`: arithmetic, closed by `))`.
  if (pair === "((") {
    const end = arithmeticEnd(reader.source, index + 2)
    if (Option.isSome(end)) {
      endWord(reader)
      return Option.some(
        readArithmetic(reader.source, index + 2, end.value, reader.segment.pipedFrom),
      )
    }
  }
  if (char === "(") {
    // A subshell reads the stdin of the command in whose place it stands.
    const input = reader.segment.pipedFrom
    endSegment(reader, false)
    return Option.some(readCommands(reader.source, index + 1, Option.some(")"), input))
  }
  if (char === "\n") {
    endSegment(reader, false)
    return Option.some(readHeredocBodies(reader, index + 1))
  }
  if (pair === "&&" || pair === "||" || pair === "|&") {
    endSegment(reader, pair === "|&")
    return Option.some(index + 2)
  }
  if (char === "|") {
    endSegment(reader, true)
    return Option.some(index + 1)
  }
  if (char === ";" || char === ")" || char === "&") {
    endSegment(reader, false)
    return Option.some(index + 1)
  }
  return Option.none()
}

/** Read the redirection operator at `start` and set the role of the word after it. */
const readRedirectionOperator = (reader: CommandReader, start: number): number => {
  const op = reader.source.text.slice(start, start + 3)
  if (op === "<<<") {
    reader.role = "here-string"
    return start + 3
  }
  if (op.startsWith("<<")) {
    reader.stripTabs = op === "<<-"
    reader.role = "heredoc-delimiter"
    if (reader.stripTabs) return start + 3
    return start + 2
  }
  reader.role = "redirect-target"
  // `<>` opens its target for writing too.
  if (op.startsWith("<") && !op.startsWith("<>")) reader.role = "input-target"
  // `&>`, `&>>`, `>>`, `>|`, `>&`, `<&` and `<>` are one operator.
  if (op === "&>>") return start + 3
  if (/^(&>|>[>|&]|<[&>])/.test(op)) return start + 2
  return start + 1
}

/**
 * A redirection ends the word: `--hard>/dev/null` is `--hard`, and its target
 * is not an argument. A descriptor number (`2>`) belongs to the redirection.
 * `<(...)` and `>(...)` are process substitutions: their commands run, and
 * the word they stand for is a file known only at run time.
 */
const readRedirection = (reader: CommandReader, index: number): Option.Option<number> => {
  const text = reader.source.text
  const char = text.charAt(index)
  const next = text.charAt(index + 1)
  if (char === "&" && next !== ">") return Option.none()
  if (char !== "<" && char !== ">" && char !== "&") return Option.none()
  if (next === "(" && char !== "&") {
    const end = readCommands(reader.source, index + 2, Option.some(")"), Option.none())
    addRange(reader, index, end, false)
    reader.dynamic = true
    return Option.some(end)
  }
  if (reader.inWord && !reader.quoted && /^\d+$/.test(reader.wordText)) clearWord(reader)
  endWord(reader)
  return Option.some(readRedirectionOperator(reader, index))
}

/** Whitespace ends a word; any other character joins it. */
const readPlain = (reader: CommandReader, index: number): number => {
  if (/\s/.test(reader.source.text.charAt(index))) {
    endWord(reader)
    return index + 1
  }
  if (startsExpansion(reader.source.text, index)) reader.dynamic = true
  addChar(reader, index, false)
  return index + 1
}

const readStep = (reader: CommandReader, index: number): number =>
  readQuote(reader, index).pipe(
    Option.orElse(() => readEscape(reader, index)),
    Option.orElse(() => readSubstitutionWord(reader, index)),
    Option.orElse(() => readParameterWord(reader, index)),
    Option.orElse(() => readRedirection(reader, index)),
    Option.orElse(() => readCaseSeparator(reader, index)),
    Option.orElse(() => readSeparator(reader, index)),
    Option.getOrElse(() => readPlain(reader, index)),
  )

/** Read commands from `from` until an unquoted `stop`; returns the index after it. `input` is their stdin. */
function readCommands(
  source: ShellSource,
  from: number,
  stop: Option.Option<string>,
  input: Option.Option<ShellSegment>,
): number {
  const reader: CommandReader = {
    source,
    segment: makeSegment(input),
    wordText: "",
    wordMap: [],
    wordSafe: [],
    wordEnd: 0,
    wordEndSafe: false,
    dynamic: false,
    inWord: false,
    quoted: false,
    role: "argument",
    stripTabs: false,
    heredocs: [],
    cases: [],
    input,
    compounds: [],
  }
  let index = from
  while (index < source.text.length) {
    const char = source.text.charAt(index)
    if (Option.exists(stop, (end) => end === char)) {
      // `$(case a in a) …;; esac)`: a `)` that ends a case pattern does not end the list.
      endWord(reader)
      if (!inCasePattern(reader)) {
        endSegment(reader, false)
        return index + 1
      }
    }
    index = readStep(reader, index)
  }
  endSegment(reader, false)
  return source.text.length
}

/**
 * Split `text` into command segments of shell words. The script word gives
 * the source offset and insertion safety of each character. Command substitutions, subshells and
 * process substitutions become segments of their own, because they run.
 * `input` is the stdin of the script: what the command that runs it reads.
 */
const parseShell = (script: ShellWord, input: Option.Option<ShellSegment>): Array<ShellSegment> => {
  const source: ShellSource = {
    text: script.text,
    map: script.map,
    safe: script.safe,
    segments: [],
  }
  readCommands(source, 0, Option.none(), input)
  return source.segments
}

/** A whole command: every character is its own source offset, and every insertion point is safe. */
const parseCommand = (command: string): Array<ShellSegment> =>
  parseShell(
    {
      text: command,
      map: Array.from({ length: command.length }, (_, index) => index),
      safe: Array.from({ length: command.length }, () => true),
      end: command.length,
      endSafe: true,
      dynamic: false,
    },
    Option.none(),
  )

/**
 * A word made of other text: no source offsets to rewrite, no safe
 * insertion point.
 */
const derivedWord = (text: string, dynamic: boolean): ShellWord => ({
  text,
  map: Array.from({ length: text.length }, () => 0),
  safe: Array.from({ length: text.length }, () => false),
  end: 0,
  endSafe: false,
  dynamic,
})

/** The characters of `word` from `start` on, keeping their offsets and safety. */
const wordFrom = (word: ShellWord, start: number): ShellWord => ({
  ...word,
  text: word.text.slice(start),
  map: word.map.slice(start),
  safe: word.safe.slice(start),
})

/** The words joined by single spaces: the command `eval` runs. */
const joinWords = (words: ReadonlyArray<ShellWord>): Option.Option<ShellWord> => {
  const last = Arr.last(words)
  if (Option.isNone(last)) return Option.none()
  const map: Array<number> = []
  const safe: Array<boolean> = []
  for (const [index, word] of words.entries()) {
    if (index > 0) {
      map.push(words[index - 1]?.end ?? word.end)
      safe.push(false)
    }
    map.push(...word.map)
    // The end of a joined word is a word boundary in the joined script too.
    safe.push(
      ...word.safe.map((charSafe, at) => charSafe || (at === word.safe.length - 1 && word.endSafe)),
    )
  }
  return Option.some({
    text: words.map((word) => word.text).join(" "),
    map,
    safe,
    end: last.value.end,
    endSafe: last.value.endSafe,
    dynamic: words.some((word) => word.dynamic),
  })
}

/** Shells whose `-c` script is read as shell words. */
const SHELL_NAMES = new Set([
  ...["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "yash", "rbash"],
  ...["csh", "tcsh", "fish", "nu", "xonsh", "elvish"],
])
/** `NAME=value` before a command sets its environment. */
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/

const commandName = (word: string): string => word.slice(word.lastIndexOf("/") + 1)

// ── options ──
//
// One reader for the options of every command: wrappers, shells and git. A
// table of `ValueOptions` per command says which options take a value.

/** The options of a command that take the next word (or the rest of a short cluster) as a value. */
interface ValueOptions {
  readonly short?: string
  readonly long?: ReadonlyArray<string>
  /** `+o`, `+x`: a `+` cluster is options too (shells). */
  readonly plus?: boolean
  /**
   * A valued letter in a cluster takes the next unused word and the cluster
   * goes on (shells: `bash -oc pipefail '…'` is `-o pipefail -c '…'`).
   */
  readonly nextWord?: boolean
  /** Letters whose value is only the rest of their cluster, when there is one (`xargs -i%`, `-l`). */
  readonly attached?: string
  /** A `-name` word is one long option, not a cluster of letters (`arch -arm64`, `-arch x`). */
  readonly singleDash?: boolean
  /**
   * Options known to take no value (`git -P`, `--no-pager`): the word after
   * one is not its value, so it hides no subcommand.
   */
  readonly flags?: { readonly short: string; readonly long: ReadonlyArray<string> }
  /**
   * Options whose value is more than one word, by letter or long name, with
   * the count (hyperfine `-L NAME VALUES`, `-P NAME MIN MAX`). The value
   * read is the first word; the reader skips the others.
   */
  readonly words?: ReadonlyMap<string, number>
}

/** The words after the first that the value of option `name` takes. */
const moreValueWords = (valued: ValueOptions, name: string) => (valued.words?.get(name) ?? 1) - 1

const names = (text: string) => text.split(" ").filter((name) => name.length > 0)

/**
 * Options that take a value: the letters, and the long names separated by
 * spaces; then the options known to take none, the same way.
 */
const options = (short: string, long = "", flagShort = "", flagLong = ""): ValueOptions => ({
  short,
  long: names(long),
  flags: { short: flagShort, long: names(flagLong) },
})

/** Where an option's value starts: argument `word`, from character `from`. */
interface OptionValue {
  readonly word: number
  readonly from: number
}

/** One option read: its letter, or its long name as written, its word, and its value when it takes one. */
interface ParsedOption {
  readonly name: string
  readonly long: boolean
  /** The index of the argument that holds the option. */
  readonly at: number
  readonly value: Option.Option<OptionValue>
}

/** The options and operands of one command (a git subcommand, `sudo`, `npm`). */
interface ParsedArguments {
  /** Letters of every short option cluster (`-fd` holds `f` and `d`). */
  readonly shorts: ReadonlySet<string>
  /** Long option names as written, without `--` and `=value`. */
  readonly longs: ReadonlyArray<string>
  readonly options: ReadonlyArray<ParsedOption>
  /**
   * The index in the arguments of each operand before `--`; for a leading
   * read, of every word from the first operand on.
   */
  readonly operandsAt: ReadonlyArray<number>
  /** The index of the first operand, or of the word after `--`. */
  readonly end: number
  readonly separated: boolean
}

/**
 * Where options may be: `anywhere` (GNU permutes them among the operands),
 * or `leading`, before the first operand (a wrapper, a shell, git's global
 * options: the first operand starts what they run).
 */
type OptionOrder = "anywhere" | "leading"

/**
 * Git reads any unambiguous prefix of a long option as that option
 * (`--ha` is `--hard`), as getopt_long does. A written name that is a prefix
 * of `name` is read as `name`.
 */
const abbreviates = (written: string, name: string) =>
  written.length > 0 && name.startsWith(written)

interface OptionsRead {
  readonly shorts: Set<string>
  readonly longs: Array<string>
  readonly options: Array<ParsedOption>
}

/**
 * Read the long option word at `index`: `--name`, `--name=value`, `--name
 * value`. As getopt_long does, a name written in full is that option before
 * it is a prefix of a longer one: `docker --tls` is the flag, not
 * `--tlscacert`.
 */
const readLongOption = (
  arg: string,
  index: number,
  valued: ValueOptions,
  into: OptionsRead,
): number => {
  let dashes = 1
  if (arg.startsWith("--")) dashes = 2
  const [name = ""] = arg.slice(dashes).split("=", 1)
  into.longs.push(name)
  const equals = arg.indexOf("=")
  const long = valued.long ?? []
  let value = Option.none<OptionValue>()
  let next = index + 1
  if (equals !== -1) {
    value = Option.some({ word: index, from: equals + 1 })
    next = index + 1 + moreValueWords(valued, name)
  } else if (
    long.includes(name) ||
    (!(valued.flags?.long ?? []).includes(name) && long.some((option) => abbreviates(name, option)))
  ) {
    value = Option.some({ word: index + 1, from: 0 })
    next = index + 2 + moreValueWords(valued, name)
  }
  into.options.push({ name, long: true, at: index, value })
  return next
}

/** Read the option word at `index`; returns the index of the next word. */
const readOption = (
  args: ReadonlyArray<string>,
  index: number,
  valued: ValueOptions,
  into: OptionsRead,
): number => {
  const arg = args[index] ?? ""
  if (arg.startsWith("--") || valued.singleDash === true) {
    return readLongOption(arg, index, valued, into)
  }
  const short = valued.short ?? ""
  const attached = valued.attached ?? ""
  let taken = 0
  for (let at = 1; at < arg.length; at++) {
    const letter = arg.charAt(at)
    into.shorts.add(letter)
    if (short.includes(letter) && valued.nextWord === true) {
      taken++
      into.options.push({
        name: letter,
        long: false,
        at: index,
        value: Option.some({ word: index + taken, from: 0 }),
      })
    } else if (short.includes(letter) || attached.includes(letter)) {
      // The rest of the cluster is the value; a bare letter takes the next
      // word, unless its value can only be attached.
      let value = Option.some<OptionValue>({ word: index + 1, from: 0 })
      let next = index + 2
      if (at < arg.length - 1) {
        value = Option.some({ word: index, from: at + 1 })
        next = index + 1
      } else if (attached.includes(letter)) {
        value = Option.none()
        next = index + 1
      }
      into.options.push({ name: letter, long: false, at: index, value })
      if (Option.isNone(value)) return next
      return next + moreValueWords(valued, letter)
    } else {
      into.options.push({ name: letter, long: false, at: index, value: Option.none() })
    }
  }
  return index + 1 + taken
}

const isOptionWord = (arg: string, valued: ValueOptions) =>
  arg.length > 1 && (arg.startsWith("-") || (valued.plus === true && arg.startsWith("+")))

const parseArguments = (
  args: ReadonlyArray<string>,
  valued: ValueOptions = {},
  order: OptionOrder = "anywhere",
): ParsedArguments => {
  const into: OptionsRead = { shorts: new Set(), longs: [], options: [] }
  const operandsAt: Array<number> = []
  let index = 0
  while (index < args.length) {
    const arg = args[index] ?? ""
    if (arg === "--") return { ...into, operandsAt, end: index + 1, separated: true }
    if (isOptionWord(arg, valued)) {
      index = readOption(args, index, valued, into)
    } else if (order === "leading") {
      return {
        ...into,
        operandsAt: args.map((_, at) => at).slice(index),
        end: index,
        separated: false,
      }
    } else {
      operandsAt.push(index)
      index++
    }
  }
  return { ...into, operandsAt, end: args.length, separated: false }
}

/** Whether `option` is named by a letter in `letters` or a long name in `names`. */
const isNamed = (option: ParsedOption, letters: string, names: ReadonlyArray<string> = []) => {
  if (option.long) return names.some((name) => abbreviates(option.name, name))
  return letters.includes(option.name)
}

/** The values of the options named by a letter in `letters` or a long name in `names`. */
const optionValues = (
  parsed: ParsedArguments,
  letters: string,
  names: ReadonlyArray<string> = [],
): ReadonlyArray<OptionValue> =>
  parsed.options.flatMap((option) => {
    if (!isNamed(option, letters, names)) return []
    return Option.toArray(option.value)
  })

/** The text of an option value in `args`. */
const valueText = (args: ReadonlyArray<string>, value: OptionValue) =>
  (args[value.word] ?? "").slice(value.from)

const hasShort = (parsed: ParsedArguments, ...letters: ReadonlyArray<string>) =>
  letters.some((letter) => parsed.shorts.has(letter))

const hasLong = (parsed: ParsedArguments, ...names: ReadonlyArray<string>) =>
  parsed.longs.some((written) => names.some((name) => abbreviates(written, name)))

/** The options of the words after a command word, read in `order`. */
const parseWords = (
  words: ReadonlyArray<ShellWord>,
  valued: ValueOptions,
  order: OptionOrder,
): ParsedArguments =>
  parseArguments(
    words.slice(1).map((word) => word.text),
    valued,
    order,
  )

/** The word an option value of `parseWords(words)` stands for, from its first character. */
const valueWord = (words: ReadonlyArray<ShellWord>, value: OptionValue): Option.Option<ShellWord> =>
  Option.map(Option.fromUndefinedOr(words[value.word + 1]), (word) => wordFrom(word, value.from))

// ── commands that run commands ──
//
// One table, `COMMAND_SPECS`, describes every command that runs a command or
// a script, keyed by command path (`sudo`, `git rebase`, `docker compose
// exec`): the options that take a value at that level, and what the words
// after it run. `resolveCommand` walks the leading options, then the
// subcommand word, then the next level. Each command has one reading: an
// option the table does not name takes no value. A rewrite needs a sure
// reading, so a word that only may be a command is left as it is.

/**
 * What the words after a command path run.
 * - `Command`: the command after the options and `positionals` more words
 *   (`timeout 5 cmd`), after a `named` word before `{` (`coproc NAME { … }`),
 *   or after the first of `after` (`nix develop .#x -c cmd`). `head` is the
 *   command it is a subcommand of (`yarn workspace x npm exec`). The
 *   value of an `entry` option is the command word, and those words are its
 *   arguments (`docker run --entrypoint git image commit`). `entryForm` says
 *   how the values make the command (`EntryForm`). With `entryScript`, the
 *   value is split into words (`docker compose run --entrypoint 'git
 *   commit' web x`): it and those words are one script.
 * - `Joined`: the words after the options and `positionals`, `take` of them,
 *   joined into one script (`eval`, `ssh host cmd`, `trap 'cmd' EXIT`).
 * - `Operands`: each operand, with options anywhere, and the value of each
 *   `short`/`long` option, is a script of its own (`hyperfine 'cmd'
 *   --prepare 'cmd'`). A script that names a `parameters` option's
 *   parameter (`-L NAME a,b` makes `{NAME}`) is text made at run time, and
 *   is not read.
 * - `OperandCommands`: each operand after the leading options and the first
 *   `skip`, split into commands as a shell splits a line, is a `head`
 *   command (tmux `if-shell true 'run-shell "cmd"'`).
 * - `OptionScript`: the values of these options are scripts (`su -c`,
 *   `git rebase -x`). With `rest`, the value and the words after it are one
 *   script, and only leading options count (`env -S`).
 * - `Stdin`: the command after the options runs with its input as arguments
 *   or in its placeholder (`xargs`, `parallel`).
 * - `FindExec`: the command after each of `actions`, up to `;` or `+`.
 * - `InputShell`: with one of the `short` or `long` options (any, when both
 *   are empty), and no
 *   command or script option of the same path, it starts a shell that runs
 *   its input (`sudo -s`, `doas -s`, a bare `su`).
 */
const Run = Schema.TaggedUnion({
  Command: {
    positionals: Schema.Int,
    after: Schema.Array(Schema.String),
    named: Schema.Boolean,
    head: Schema.String,
    entry: Schema.Array(Schema.String),
    entryForm: Schema.Literals(["last", "json", "every"]),
    entryScript: Schema.Boolean,
  },
  Joined: { positionals: Schema.Int, take: Schema.Int },
  Operands: {
    short: Schema.String,
    long: Schema.Array(Schema.String),
    parameters: Schema.Struct({ short: Schema.String, long: Schema.Array(Schema.String) }),
  },
  OperandCommands: { head: Schema.String, skip: Schema.Int },
  OptionScript: { short: Schema.String, long: Schema.Array(Schema.String), rest: Schema.Boolean },
  Stdin: {},
  FindExec: { actions: Schema.Array(Schema.String) },
  InputShell: { short: Schema.String, long: Schema.Array(Schema.String) },
})
type Run = typeof Run.Type
type CommandFields = Partial<Omit<typeof Run.cases.Command.Type, "_tag">>

/**
 * How the values of an `entry` option make the command a container runs:
 * - `last`: the last value is the command word (docker's string option).
 * - `json`: the last value, and a JSON array of strings is the command
 *   word and its first arguments (podman: `'["rm","-rf","x"]'`).
 * - `every`: every value in order, each a word (nerdctl's string array:
 *   `--entrypoint rm --entrypoint -rf`).
 */
type EntryForm = typeof Run.cases.Command.Type.entryForm

const command = (fields: CommandFields = {}): Run =>
  Run.cases.Command.make({
    positionals: 0,
    after: [],
    named: false,
    head: "",
    entry: [],
    entryForm: "last",
    entryScript: false,
    ...fields,
  })

const joined = (positionals = 0, take = Number.MAX_SAFE_INTEGER): Run =>
  Run.cases.Joined.make({ positionals, take })

/** Each operand after the first `skip` is a tmux command. */
const tmuxCommands = (skip: number): Run => Run.cases.OperandCommands.make({ head: "tmux", skip })

const optionScript = (short: string, long: ReadonlyArray<string> = [], rest = false): Run =>
  Run.cases.OptionScript.make({ short, long, rest })

const inputShell = (short: string, long: ReadonlyArray<string> = []): Run =>
  Run.cases.InputShell.make({ short, long })

/** How a command path reads the words after it. */
interface CommandSpec {
  /** The options at this level that take a value; a subcommand word comes after them. */
  readonly valued: ValueOptions
  readonly runs: ReadonlyArray<Run>
  /** The words as the command splits them before it reads them (`tmuxWords`). */
  readonly split?: (words: ReadonlyArray<ShellWord>) => ReadonlyArray<ShellWord>
  /** The subcommand a written word names: an alias or a prefix (`tmuxCommandName`). */
  readonly subcommand?: (written: string) => string
}

const spec = (valued: ValueOptions, runs: ReadonlyArray<Run> = []): CommandSpec => ({
  valued,
  runs,
})

const NO_SPEC = spec({})

/** A command path found in a command: `words` holds the words from its last word on. */
interface ResolvedCommand {
  readonly path: string
  readonly spec: CommandSpec
  readonly words: ReadonlyArray<ShellWord>
}

/** The path under `resolved` whose subcommand word is `words[next]`, when `COMMAND_SPECS` names it. */
const childCommand = (resolved: ResolvedCommand, next: number): Option.Option<ResolvedCommand> => {
  const written = resolved.words[next]?.text ?? ""
  const key = `${resolved.path} ${resolved.spec.subcommand?.(written) ?? written}`
  if (!COMMAND_SPECS.has(key) && !SPEC_PARENTS.has(key)) return Option.none()
  return Option.some({
    path: key,
    spec: COMMAND_SPECS.get(key) ?? NO_SPEC,
    words: resolved.words.slice(next),
  })
}

/**
 * The command path under `resolved`: the path that the word after its
 * leading options names, read down to the last level, or `resolved` itself
 * when that word names no path.
 */
const resolveUnder = (resolved: ResolvedCommand): ResolvedCommand => {
  if (!SPEC_PARENTS.has(resolved.path)) return resolved
  const next = 1 + parseWords(resolved.words, resolved.spec.valued, "leading").end
  return Option.match(childCommand(resolved, next), {
    onNone: () => resolved,
    onSome: resolveUnder,
  })
}

/** The command path in `words`, whose first word is the command word: the longest path `COMMAND_SPECS` names. */
const resolveCommand = (words: ReadonlyArray<ShellWord>): ResolvedCommand => {
  const path = commandName(words[0]?.text ?? "")
  const spec = COMMAND_SPECS.get(path) ?? NO_SPEC
  return resolveUnder({ path, spec, words: spec.split?.(words) ?? words })
}

/** The index in `words` (from a path's last word) of the first word a `Command`, `Joined` or `Stdin` run runs. */
const commandStart = (
  words: ReadonlyArray<ShellWord>,
  valued: ValueOptions,
  run: CommandFields,
): number => {
  const after = run.after ?? []
  if (after.length > 0) {
    const at = words.findIndex((word, index) => index > 0 && after.includes(word.text))
    if (at === -1) return words.length
    return at + 1
  }
  let end = 1 + parseWords(words, valued, "leading").end + (run.positionals ?? 0)
  if (run.named === true && words[end + 1]?.text === "{") end++
  // No command is named `--`: after the positionals it ends the options (`ssh host -- cmd`).
  if (words[end]?.text === "--") end++
  return end
}

/** The commands a run starts, each from its command word. */
const runCommands = (
  resolved: ResolvedCommand,
  run: Run,
): ReadonlyArray<ReadonlyArray<ShellWord>> => {
  const { words } = resolved
  if (run._tag === "Stdin") return [wrapperWords(resolved).command]
  if (run._tag === "FindExec") {
    return words.flatMap((word, index) => {
      if (!run.actions.includes(word.text)) return []
      const rest = words.slice(index + 1)
      let end = rest.findIndex((next) => next.text === ";" || next.text === "+")
      if (end === -1) end = rest.length
      return [rest.slice(0, end)]
    })
  }
  if (run._tag === "OperandCommands") {
    const start = 1 + parseWords(words, resolved.spec.valued, "leading").end + run.skip
    return words
      .slice(start)
      .flatMap((operand) =>
        parseShell(operand, Option.none()).map((segment) => [
          derivedWord(run.head, false),
          ...segment.words,
        ]),
      )
  }
  if (run._tag !== "Command") return []
  const { entry, rest } = commandReading(resolved, run)
  if (entry.length > 0) {
    // The script `entryScripts` reads.
    if (run.entryScript) return []
    return [[...entry, ...rest]]
  }
  if (run.head === "") return [rest]
  // No words, no subcommand: the head alone would read this command again.
  if (rest.length === 0) return []
  return [[derivedWord(run.head, false), ...rest]]
}

/**
 * What a `Command` run runs: the words its `entry` options make (none
 * without an entry), and the words after the command word or the image.
 */
interface CommandReading {
  readonly entry: ReadonlyArray<ShellWord>
  readonly rest: ReadonlyArray<ShellWord>
}

/** A podman entry value that is a JSON array of strings. */
const decodeJsonWords = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
)

/**
 * The words the `entry` values make, in `form` (`EntryForm`). An empty
 * value that is not expanded clears the entry (`--entrypoint ''`); an
 * empty nerdctl value is dropped, and the other values stay.
 */
const entryWords = (
  values: ReadonlyArray<ShellWord>,
  form: EntryForm,
): ReadonlyArray<ShellWord> => {
  const given = (word: ShellWord) => word.text !== "" || word.dynamic
  if (form === "every") return values.filter(given)
  return Option.match(Option.filter(Arr.last(values), given), {
    onNone: () => [],
    onSome: (word) => {
      if (form !== "json" || !word.text.startsWith("[")) return [word]
      return Option.match(decodeJsonWords(word.text), {
        onNone: () => [word],
        onSome: (texts) => texts.map((text) => derivedWord(text, word.dynamic)),
      })
    },
  })
}

/**
 * What a `Command` run runs, from its start (`commandStart`). The values of
 * the `entry` options before the start are read with the options anywhere
 * (`docker run --group-add g --entrypoint sh img -c …`).
 */
const commandReading = (
  { words, spec: { valued } }: ResolvedCommand,
  run: typeof Run.cases.Command.Type,
): CommandReading => {
  const start = commandStart(words, valued, run)
  const before = words.slice(0, start)
  const entry = entryWords(
    optionValues(parseWords(before, valued, "anywhere"), "", run.entry).flatMap((value) =>
      Option.toArray(valueWord(before, value)),
    ),
    run.entryForm,
  )
  return { entry, rest: words.slice(start) }
}

/**
 * The script of an `entryScript` run with an entry: the entry's words, then
 * the words after the image or the service, each quoted as it is.
 */
const entryScripts = (
  resolved: ResolvedCommand,
  run: typeof Run.cases.Command.Type,
): ReadonlyArray<ShellWord> => {
  if (!run.entryScript) return []
  const { entry, rest } = commandReading(resolved, run)
  if (entry.length === 0) return []
  return Option.toArray(
    joinWords([...entry, ...rest.map((arg) => derivedWord(shellQuote(arg.text), arg.dynamic))]),
  )
}

/** The operands of `words` after its command word, with options anywhere, and every word after `--`. */
const operandWords = (
  words: ReadonlyArray<ShellWord>,
  valued: ValueOptions,
): ReadonlyArray<ShellWord> => {
  const parsed = parseWords(words, valued, "anywhere")
  let after: ReadonlyArray<ShellWord> = []
  // `end` is the index in the arguments of the word after `--`.
  if (parsed.separated) after = words.slice(parsed.end + 1)
  const operands = parsed.operandsAt.flatMap((at) =>
    Option.toArray(Option.fromUndefinedOr(words[at + 1])),
  )
  return [...operands, ...after]
}

/** The scripts the option values of an `OptionScript` run are. */
const optionScripts = (
  { words, spec: { valued } }: ResolvedCommand,
  run: typeof Run.cases.OptionScript.Type,
): ReadonlyArray<ShellWord> => {
  let order: OptionOrder = "anywhere"
  if (run.rest) order = "leading"
  const values = optionValues(parseWords(words, valued, order), run.short, run.long)
  if (!run.rest) return values.flatMap((value) => Option.toArray(valueWord(words, value)))
  return Option.match(Arr.head(values), {
    onNone: () => [],
    onSome: (value) =>
      Option.toArray(
        joinWords([...Option.toArray(valueWord(words, value)), ...words.slice(value.word + 2)]),
      ),
  })
}

/**
 * The input an `InputShell` run's shell runs: none when a command or a script
 * option of the same path gives the shell its script instead.
 */
const inputShellScripts = (
  invocation: Invocation,
  resolved: ResolvedCommand,
  run: typeof Run.cases.InputShell.Type,
): ReadonlyArray<ShellWord> => {
  if (!inputShellStarts(resolved, run)) return []
  return segmentInputs(invocation.segment)
}

/**
 * Whether an `InputShell` run starts a shell that reads its input: its
 * shell option is given (any option, when it names none), and no script
 * option or command of the same path gives the shell its script.
 */
const inputShellStarts = (
  resolved: ResolvedCommand,
  run: typeof Run.cases.InputShell.Type,
): boolean => {
  const parsed = parseWords(resolved.words, resolved.spec.valued, "leading")
  const any = run.short === "" && run.long.length === 0
  if (!any && !hasShort(parsed, ...run.short) && !hasLong(parsed, ...run.long)) return false
  return !resolved.spec.runs.some((other) => {
    if (other._tag === "OptionScript") {
      return hasShort(parsed, ...other.short) || hasLong(parsed, ...other.long)
    }
    return runCommands(resolved, other).some((wrapped) => wrapped.length > 0)
  })
}

/** The scripts of an `Operands` run: each operand, and the value of each of its script options. */
const operandScripts = (
  { words, spec: { valued } }: ResolvedCommand,
  run: typeof Run.cases.Operands.Type,
): ReadonlyArray<ShellWord> => [
  ...operandWords(words, valued),
  ...optionValues(parseWords(words, valued, "anywhere"), run.short, run.long).flatMap((value) =>
    Option.toArray(valueWord(words, value)),
  ),
]

/**
 * The scripts of an `Operands` run, less each that names a parameter of a
 * `parameters` option (`-L NAME a,b` makes `{NAME}`): the run makes that
 * text at run time.
 */
const operandRunScripts = (
  resolved: ResolvedCommand,
  run: typeof Run.cases.Operands.Type,
): ReadonlyArray<ShellWord> => {
  const { words, spec } = resolved
  const parameters = parseWords(words, spec.valued, "anywhere")
    .options.filter((option) => isNamed(option, run.parameters.short, run.parameters.long))
    .flatMap((option) =>
      Option.toArray(option.value).flatMap((value) =>
        Option.toArray(valueWord(words, value)).map((name) => `{${name.text}}`),
      ),
    )
  return operandScripts(resolved, run)
    .filter((script) => !parameters.some((name) => script.text.includes(name)))
    .flatMap((script) => Option.toArray(joinWords([script])))
}

/** What a run runs beyond the commands it starts: its scripts, and its input. */
const specScripts = (
  invocation: Invocation,
  resolved: ResolvedCommand,
  run: Run,
): ReadonlyArray<ShellWord> => {
  const { words, spec } = resolved
  if (run._tag === "Command") return entryScripts(resolved, run)
  if (run._tag === "Operands") return operandRunScripts(resolved, run)
  if (run._tag === "OptionScript") return optionScripts(resolved, run)
  if (run._tag === "InputShell") return inputShellScripts(invocation, resolved, run)
  if (run._tag !== "Joined") return []
  const start = commandStart(words, spec.valued, run)
  return Option.toArray(joinWords(words.slice(start, start + run.take)))
}

/**
 * One command a segment runs: its words from the command word on. Only a
 * word in command position is a command; the same name as an argument
 * (`grep bash`, `echo git commit`, `ls rm`) is data.
 */
interface Invocation {
  readonly segment: ShellSegment
  readonly words: ReadonlyArray<ShellWord>
  /** The `NAME=value` words before it: its environment. */
  readonly assignments: ReadonlyArray<ShellWord>
  /**
   * Reached through `xargs`, `parallel` or `find -exec`: matches a word that
   * holds the input (`{}`, `xargs -I %`, parallel's `{1}`).
   */
  readonly placeholder: Option.Option<RegExp>
}

/**
 * Whether `into` holds the invocation already. Two runs of one command can
 * reach the same words (`kubectl exec pod -- cmd` reads the command after
 * `--` and after the pod); each is read once.
 */
const isCollected = (into: ReadonlyArray<Invocation>, found: Invocation) =>
  into.some(
    (invocation) =>
      invocation.segment === found.segment &&
      invocation.words[0] === found.words[0] &&
      invocation.words.length === found.words.length &&
      invocation.assignments[0] === found.assignments[0] &&
      invocation.assignments.length === found.assignments.length &&
      Option.getOrUndefined(invocation.placeholder)?.source ===
        Option.getOrUndefined(found.placeholder)?.source,
  )

/** The commands `words` runs: the first after env assignments, and each command a run of its path starts. */
const collectInvocations = (
  segment: ShellSegment,
  words: ReadonlyArray<ShellWord>,
  into: Array<Invocation>,
  placeholder = Option.none<RegExp>(),
): void => {
  let start = words.findIndex((word) => !ASSIGNMENT.test(word.text))
  if (start === -1) start = words.length
  const command = words.slice(start)
  const assignments = words.slice(0, start)
  if (command.length === 0 && assignments.length === 0) return
  const found: Invocation = { segment, words: command, assignments, placeholder }
  if (isCollected(into, found)) return
  into.push(found)
  const resolved = resolveCommand(command)
  for (const run of resolved.spec.runs) {
    let fed = placeholder
    let input = segment
    if (run._tag === "FindExec") fed = Option.some(/\{\}/)
    if (run._tag === "Stdin") {
      // The command reads what the wrapper reads: its pipe, its file or its sources.
      const use = inputUse(resolved)
      fed = Option.orElse(use.marker, () => placeholder)
      input = wrapperSegment(segment, use, wrapperWords(resolved).sources)
    }
    for (const wrapped of runCommands(resolved, run)) {
      collectInvocations(input, wrapped, into, fed)
    }
  }
}

const invocationName = (invocation: Invocation) => commandName(invocation.words[0]?.text ?? "")

/** `<(cmd)`: a file whose content only exists at run time. */
const isProcessSubstitution = (word: ShellWord) => word.dynamic && /^[<>]\(/.test(word.text)

/**
 * The text `echo` prints: its arguments joined by spaces. None with `-e`
 * and a backslash: the decoded escapes are text made at run time.
 */
const echoScripts = (args: ReadonlyArray<ShellWord>): ReadonlyArray<ShellWord> => {
  let index = 0
  let escapes = false
  while (/^-[neE]+$/.test(args[index]?.text ?? "")) {
    const flags = args[index]?.text ?? ""
    if (flags.includes("e") || flags.includes("E"))
      escapes = flags.lastIndexOf("e") > flags.lastIndexOf("E")
    index++
  }
  const joined = joinWords(args.slice(index))
  if (Option.isNone(joined)) return []
  if (escapes && joined.value.text.includes("\\")) return []
  return [joined.value]
}

/**
 * The text `printf` prints, when its format holds no directive and no
 * escape: the format as written. `-v` prints nothing.
 */
const printfScripts = (args: ReadonlyArray<ShellWord>): ReadonlyArray<ShellWord> => {
  // `-v` is an option only before `--`: `printf -- '-v; …'` prints it.
  if (args[0]?.text.startsWith("-v") === true) return []
  let rest = args
  if (rest[0]?.text === "--") rest = rest.slice(1)
  return Option.toArray(Option.fromUndefinedOr(rest[0])).filter(
    (format) => !format.text.includes("%") && !format.text.includes("\\"),
  )
}

/**
 * The input of a command in `segment` that reads as a script: a
 * here-string, a heredoc body, or the text of the `echo`/`printf` whose
 * output it reads. The output of any other command, and a file, are not read.
 */
const segmentInputs = (segment: ShellSegment): ReadonlyArray<ShellWord> => {
  if (Option.exists(segment.inputFile, (name) => !STDIN_FILES.has(name))) return []
  const scripts = [...segment.stdin]
  if (Option.isSome(segment.pipedFrom)) {
    const from = segment.pipedFrom.value
    const name = commandName(from.words[0]?.text ?? "")
    if (name === "echo") scripts.push(...echoScripts(from.words.slice(1)))
    if (name === "printf") scripts.push(...printfScripts(from.words.slice(1)))
  }
  return scripts
}

/** File names of the stdin of the process that opens them. */
const STDIN_FILES = new Set(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"])

/**
 * A script file a shell or `source` runs is not read: its content is not in
 * the command. A stdin file is the stdin of the command in `segment`.
 */
const scriptFileScripts = (
  segment: ShellSegment,
  file: Option.Option<ShellWord>,
): ReadonlyArray<ShellWord> => {
  if (Option.exists(file, (word) => STDIN_FILES.has(word.text))) return segmentInputs(segment)
  return []
}

/** Shell options whose value is the next word (`-o pipefail`, `--rcfile x`). */
const SHELL_OPTIONS: ValueOptions = {
  short: "oO",
  long: ["rcfile", "init-file"],
  plus: true,
  nextWord: true,
}

/**
 * Options whose value a shell runs as a script, beyond the `-c` argument:
 * fish's `-C`/`--init-command`, and `--command`, its long `-c`.
 */
const SHELL_SCRIPT_OPTIONS: ReadonlyMap<string, ValueOptions> = new Map([
  ["fish", options("C", "command init-command")],
])

/**
 * A shell: the value of each of its script options; the argument after its
 * options with `-c`; its stdin with `-s` or with no argument; else a script
 * file, which is not read. A script that is not a literal (`sh -c '{}'`
 * under xargs or `find -exec`, `sh -c "$CMD"`) takes the input as the
 * script too, as a pipe into a shell does.
 */
const shellScripts = (invocation: Invocation): ReadonlyArray<ShellWord> => {
  const { words } = invocation
  const scriptOptions = SHELL_SCRIPT_OPTIONS.get(commandName(words[0]?.text ?? "")) ?? {}
  const parsed = parseWords(
    words,
    {
      ...SHELL_OPTIONS,
      short: `${SHELL_OPTIONS.short ?? ""}${scriptOptions.short ?? ""}`,
      long: [...(SHELL_OPTIONS.long ?? []), ...(scriptOptions.long ?? [])],
    },
    "leading",
  )
  const values = optionValues(parsed, scriptOptions.short ?? "", scriptOptions.long).flatMap(
    (value) => Option.toArray(valueWord(words, value)),
  )
  return [...values.filter((word) => !word.dynamic), ...shellOperandScripts(invocation, parsed)]
}

/** What a shell runs from its `-c` argument, its stdin or a script file. */
const shellOperandScripts = (
  { segment, words, placeholder }: Invocation,
  parsed: ParsedArguments,
): ReadonlyArray<ShellWord> => {
  let end = 1 + parsed.end
  // `-` ends the options as `--` does.
  if (!parsed.separated && words[end]?.text === "-") end++
  const operand = Option.fromUndefinedOr(words[end])
  if (!hasShort(parsed, "c")) {
    if (hasShort(parsed, "s") || Option.isNone(operand)) return segmentInputs(segment)
    return scriptFileScripts(segment, operand)
  }
  const literal = Option.filter(
    operand,
    (word) => !word.dynamic && !Option.exists(placeholder, (marker) => marker.test(word.text)),
  )
  if (Option.isSome(literal)) return [literal.value]
  return [...Option.toArray(operand), ...segmentInputs(segment)]
}

/** `text` as one single-quoted shell word. */
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/** `text` as a pattern that matches only itself. */
const literalPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/**
 * parallel's replacement strings: `{}` (or the `-I` value), `{.}` without
 * the extension, `{/}` the base name, `{//}` the directory, `{/.}` both,
 * `{#}` the job number, `{%}` the slot, each with an argument number before
 * the modifier (`{1}`, `{2.}`, `{-1}`), and `{= perl =}`.
 */
const PARALLEL_REPLACEMENT = "\\{(-?\\d+)?(//|/\\.|/|\\.|#|%)?\\}|\\{-?\\d*="

/** parallel options that add replacement strings. */
const PARALLEL_REPLACE_OPTIONS = [
  ...["extensionreplace", "er", "basenamereplace", "bnr", "dirnamereplace", "dnr"],
  ...["basenameextensionreplace", "bner", "seqreplace", "slotreplace", "rpl"],
]

/** How `xargs` or `parallel` passes its input to its command. */
interface InputUse {
  /**
   * Matches a command word that holds the input: `{}`, or the `-I`/`-J`
   * value, and for parallel every replacement string (`{1}`, `{.}`, `{/}`).
   */
  readonly marker: Option.Option<RegExp>
  /** `-a`/`--arg-file`: the files it reads its input from in place of its stdin. */
  readonly argFiles: ReadonlyArray<string>
}

/**
 * The input use of an `xargs` or `parallel` invocation. xargs `-I R`,
 * `--replace[=R]` and `-i[R]` (R is `{}` when not given) put each line into
 * R; BSD `-J R` puts the input in place of the word R, else appends it.
 * parallel puts it into `{}` (or its `-I` value) and its other replacement
 * strings, else appends it. `--plus`, `--rpl` and the options that name a
 * replacement string make strings this reader does not know: every word may
 * hold the input.
 */
const inputUse = ({ path, words, spec }: ResolvedCommand): InputUse => {
  const texts = words.slice(1).map((word) => word.text)
  const parsed = parseArguments(texts, spec.valued, "leading")
  const argFiles = optionValues(parsed, "a", ["arg-file"]).map((at) => valueText(texts, at))
  if (path === "parallel") {
    const replace = Option.getOrElse(
      Option.map(Arr.last(optionValues(parsed, "I")), (at) => valueText(texts, at)),
      () => "{}",
    )
    let marker = new RegExp(`${literalPattern(replace)}|${PARALLEL_REPLACEMENT}`)
    if (hasLong(parsed, "plus", ...PARALLEL_REPLACE_OPTIONS)) marker = /(?:)/
    return { marker: Option.some(marker), argFiles }
  }
  let marker = Option.none<RegExp>()
  for (const option of parsed.options) {
    const given = Option.map(option.value, (at) => valueText(texts, at))
    if (isNamed(option, "Ii", ["replace"])) {
      marker = Option.some(new RegExp(literalPattern(Option.getOrElse(given, () => "{}"))))
    } else if (isNamed(option, "J")) {
      marker = Option.map(given, (text) => new RegExp(`^${literalPattern(text)}$`))
    }
  }
  return { marker, argFiles }
}

/** `parallel … ::: a b` (`:::+` links), `:::: file`: where its command ends and its input starts. */
const PARALLEL_SOURCE = /^::::?\+?$/

/** One input source of parallel after its command: `::: a b`, `:::+ a b`, `:::: file`. */
interface ParallelSource {
  readonly marker: string
  readonly words: Array<ShellWord>
}

const isFileSource = (source: ParallelSource) => source.marker.startsWith("::::")

/** The command an `xargs` or `parallel` runs, and parallel's input sources after it. */
interface WrapperWords {
  readonly command: ReadonlyArray<ShellWord>
  readonly sources: ReadonlyArray<ParallelSource>
}

/** The words of an `xargs` or `parallel`: its command after its options, and parallel's sources. */
const wrapperWords = ({ path, words, spec: { valued } }: ResolvedCommand): WrapperWords => {
  const rest = words.slice(commandStart(words, valued, {}))
  if (path !== "parallel") return { command: rest, sources: [] }
  const command: Array<ShellWord> = []
  const sources: Array<ParallelSource> = []
  for (const word of rest) {
    const source = Arr.last(sources)
    if (PARALLEL_SOURCE.test(word.text)) sources.push({ marker: word.text, words: [] })
    else if (Option.isSome(source)) source.value.words.push(word)
    else command.push(word)
  }
  return { command, sources }
}

/**
 * The segment whose input the wrapper and the commands it runs read: its
 * own, the `-a`/`::::` file in place of its stdin, or the words of its
 * `:::` sources.
 */
const wrapperSegment = (
  segment: ShellSegment,
  use: InputUse,
  sources: ReadonlyArray<ParallelSource>,
): ShellSegment => {
  const files = [
    ...use.argFiles,
    ...sources.filter(isFileSource).map((source) => source.words[0]?.text ?? ""),
  ]
  // `< file` replaces the pipe when the wrapper reads its stdin.
  if (files.length === 0 && sources.length === 0) {
    files.push(...Option.toArray(Arr.last(segment.reads)).map((word) => word.text))
  }
  const file = Arr.findFirst(files, (name) => !STDIN_FILES.has(name))
  if (Option.isSome(file)) return { ...segment, inputFile: file }
  if (sources.length === 0) return segment
  return {
    ...segment,
    stdin: sources.flatMap((source) => source.words),
    pipedFrom: Option.none(),
  }
}

/** Environment variables whose value a command runs as a shell command. */
const SHELL_VARIABLES = new Set([
  ...["GIT_SSH_COMMAND", "GIT_SSH", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER"],
  ...["GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "GIT_PROXY_COMMAND", "SSH_ASKPASS"],
  ...["EDITOR", "VISUAL", "PAGER", "PROMPT_COMMAND"],
])

/** Builtins whose `NAME=value` arguments set variables. */
const DECLARATION_COMMANDS = new Set(["export", "declare", "typeset", "local", "readonly"])

/**
 * `GIT_SSH_COMMAND=… git fetch`, `export EDITOR=…`: a value a later command
 * runs as a script. Git also reads config from `GIT_CONFIG_KEY_<n>` and
 * `GIT_CONFIG_VALUE_<n>` pairs.
 */
const assignmentScripts = ({ words, assignments }: Invocation): ReadonlyArray<ShellWord> => {
  let candidates = assignments
  if (DECLARATION_COMMANDS.has(commandName(words[0]?.text ?? ""))) {
    candidates = [...assignments, ...words.slice(1)]
  }
  const assigned = candidates.flatMap((word) =>
    Option.toArray(Option.fromNullishOr(ASSIGNMENT.exec(word.text))).map(
      (match): readonly [string, ShellWord] => [
        match[0].replace(/\+?=$/, ""),
        wordFrom(word, match[0].length),
      ],
    ),
  )
  const values = new Map(assigned)
  return assigned.flatMap(([name, value]) => {
    const configured = Option.fromNullishOr(/^GIT_CONFIG_KEY_(\d+)$/.exec(name)).pipe(
      Option.flatMap((match) => Option.fromUndefinedOr(values.get(`GIT_CONFIG_VALUE_${match[1]}`))),
      Option.flatMap((word) => configScript(value.text, word)),
    )
    if (SHELL_VARIABLES.has(name)) return [value, ...Option.toArray(configured)]
    return Option.toArray(configured)
  })
}

/** Git global options whose value is the next word. */
const GIT_GLOBAL_OPTIONS = options(
  "cC",
  "git-dir work-tree namespace config-env super-prefix attr-source",
  "Pp",
  "no-pager paginate bare no-replace-objects literal-pathspecs glob-pathspecs noglob-pathspecs icase-pathspecs no-optional-locks no-advice",
)

/** Git config keys whose value git runs as a shell command. */
const GIT_SHELL_KEYS =
  /^(core\.(pager|editor|sshcommand|fsmonitor|askpass|gitproxy)|sequence\.editor|diff\.external|gpg\.([^.]+\.)?program|credential\.(.+\.)?helper|interactive\.difffilter|pager\.[^.]+|(filter|diff|merge)\..+\.(clean|smudge|process|textconv|command|driver)|remote\..+\.(uploadpack|receivepack|proxy)|sendemail\.(smtpserver|tocmd|cccmd)|uploadpack\.packobjectshook)$/i

/** The value of an alias definition as the script it runs: `!cmd` runs a shell, anything else a git command. */
const aliasScript = (value: ShellWord): ShellWord => {
  if (value.text.startsWith("!")) return wordFrom(value, 1)
  const gitPrefix = derivedWord("git ", false)
  return {
    ...value,
    text: `${gitPrefix.text}${value.text}`,
    map: [...gitPrefix.map, ...value.map],
    safe: [...gitPrefix.safe, ...value.safe],
  }
}

/** The script a config value runs: an alias, or the value of a shell-running key (`!` optional). */
const configScript = (key: string, value: ShellWord): Option.Option<ShellWord> => {
  if (/^alias\.[^=]+$/i.test(key)) return Option.some(aliasScript(value))
  if (!GIT_SHELL_KEYS.test(key)) return Option.none()
  if (value.text.startsWith("!")) return Option.some(wordFrom(value, 1))
  return Option.some(value)
}

/**
 * What a git invocation runs beyond its own words and its path's runs: the
 * value of each `git -c key=<value>` that sets an alias or a shell-running
 * key (`core.pager`, `core.sshCommand`). It runs now, so it keeps its
 * source offsets. `git config key <value>` stores a value for later runs in
 * any session, and is not read.
 */
const gitScripts = ({ words }: Invocation): ReadonlyArray<ShellWord> => {
  const texts = words.slice(1).map((word) => word.text)
  const global = parseArguments(texts, GIT_GLOBAL_OPTIONS, "leading")
  return optionValues(global, "c").flatMap((value) =>
    Option.toArray(valueWord(words, value)).flatMap((definition) => {
      const equals = definition.text.indexOf("=")
      if (equals === -1) return []
      const key = definition.text.slice(0, equals)
      return Option.toArray(configScript(key, wordFrom(definition, equals + 1)))
    }),
  )
}

/**
 * `alias ci='git commit'`: the value of each `name=value` of an `alias`
 * command runs where the name is a command word, once the shell expands
 * aliases (`shopt -s expand_aliases`). The value is read where it is
 * defined, with its source offsets.
 */
const aliasScripts = ({ words }: Invocation): ReadonlyArray<ShellWord> =>
  words.slice(1).flatMap((word) => {
    const equals = word.text.indexOf("=")
    if (equals <= 0 || word.text.startsWith("-")) return []
    return [wordFrom(word, equals + 1)]
  })

/**
 * The scripts one command's words run: the argument after a shell's `-c`,
 * what a shell with no script argument reads on stdin, what its path's runs
 * run (`eval`, `ssh host`, `su -c`), and what git runs. Quoted text
 * anywhere else, such as a commit message or `cat <<EOF` notes, is data. A
 * command word known only at run time (`$G commit`) runs nothing this
 * reader can follow.
 */
const commandScripts = (invocation: Invocation): ReadonlyArray<ShellWord> => {
  const name = invocationName(invocation)
  const { words } = invocation
  const head = Option.fromUndefinedOr(words[0])
  if (Option.isNone(head) || head.value.dynamic) return []
  if (SHELL_NAMES.has(name)) return shellScripts(invocation)
  if (name === "source" || name === ".") {
    return scriptFileScripts(invocation.segment, Option.fromUndefinedOr(words[1]))
  }
  const resolved = resolveCommand(words)
  const scripts = resolved.spec.runs.flatMap((run) => specScripts(invocation, resolved, run))
  if (name === "git") scripts.push(...gitScripts(invocation))
  if (name === "alias") scripts.push(...aliasScripts(invocation))
  return scripts
}

const MAX_NESTED_COMMAND_DEPTH = 4

/**
 * The stdin of a script a command in `segment` runs: the command's own. Its
 * heredoc or here-string reaches the script through the command, a producer
 * this reader does not trace.
 */
const scriptInput = (segment: ShellSegment): Option.Option<ShellSegment> => {
  if (segment.stdin.length === 0) return segment.pipedFrom
  return Option.some(makeSegment(Option.none()))
}

/**
 * The scripts one command line has read, by text, with the input each read
 * (none, or its segment). Nested runners build the same script many ways
 * (`ssh -X h ssh -X h ls`); each is read once.
 */
type ViewedScripts = Map<string, Array<Option.Option<ShellSegment>>>

const isSameInput = (seen: Option.Option<ShellSegment>, input: Option.Option<ShellSegment>) =>
  Option.match(seen, {
    onNone: () => Option.isNone(input),
    onSome: (segment) => Option.exists(input, (other) => other === segment),
  })

/** The commands of `segments` and of the scripts they run, up to `maxDepth` levels deep. */
const viewCommand = (
  segments: ReadonlyArray<ShellSegment>,
  maxDepth: number,
  viewed: ViewedScripts = new Map(),
): ReadonlyArray<Invocation> => {
  const invocations: Array<Invocation> = []
  for (const segment of segments) {
    const found: Array<Invocation> = []
    collectInvocations(segment, segment.words, found)
    invocations.push(...found)
    if (maxDepth <= 0) continue
    for (const invocation of found) {
      for (const script of [...assignmentScripts(invocation), ...commandScripts(invocation)]) {
        const input = scriptInput(invocation.segment)
        const key = `${script.dynamic}:${script.text}`
        const inputs = viewed.get(key) ?? []
        if (inputs.some((seen) => isSameInput(seen, input))) continue
        viewed.set(key, [...inputs, input])
        invocations.push(...viewCommand(parseShell(script, input), maxDepth - 1, viewed))
      }
    }
  }
  return invocations
}

const runner = (valued: ValueOptions = {}, fields: CommandFields = {}) =>
  spec(valued, [command(fields)])

/** One spec under each of `paths`. */
const each = (paths: ReadonlyArray<string>, value: CommandSpec) =>
  Object.fromEntries(paths.map((path) => [path, value]))

/** `rows` under each of `tools`: the key `""` is the tool itself, any other a path under it. */
const under = (
  tools: ReadonlyArray<string>,
  rows: Readonly<Record<string, CommandSpec>>,
): Record<string, CommandSpec> =>
  Object.fromEntries(
    tools.flatMap((tool) =>
      Object.entries(rows).map(([path, value]) => [
        [tool, path].filter((part) => part !== "").join(" "),
        value,
      ]),
    ),
  )

/** Package manager options that take a value. */
const PACKAGE_OPTIONS = "tag access registry otp"
/** Package manager options that take no value. */
const PACKAGE_FLAGS = "silent quiet verbose json"

/** `git commit` options whose value is the next word. */
const COMMIT_OPTIONS = options(
  "mFCct",
  "message file reuse-message reedit-message template author date cleanup fixup squash trailer pathspec-from-file",
)

const FILTER_BRANCH_SCRIPTS =
  "setup env-filter tree-filter index-filter parent-filter msg-filter commit-filter tag-name-filter"

/** `docker compose` options before the subcommand whose value is the next word. */
const COMPOSE_OPTIONS = options(
  "fp",
  "file project-name profile env-file project-directory ansi progress parallel",
)

/** kubectl global options whose value is the next word. */
const KUBECTL_OPTIONS = options(
  "nsv",
  "namespace context kubeconfig cluster user server token as as-group request-timeout v",
)

/** `docker exec` and `docker compose exec` options whose value is the next word, then those that take none. */
const CONTAINER_EXEC_OPTIONS = options(
  "euw",
  "env env-file user workdir detach-keys index",
  "ditT",
  "detach interactive tty privileged no-tty",
)

/**
 * `docker run`, `docker create` and `docker compose run` options whose
 * value is the next word, then those that take none.
 */
const CONTAINER_RUN_OPTIONS = options(
  "acehlmpuvw",
  "attach cpu-shares env env-file hostname label memory publish user volume workdir name network entrypoint mount platform pull restart cpus add-host device dns ipc log-driver log-opt pid runtime security-opt shm-size stop-signal tmpfs ulimit cap-add cap-drop cidfile gpus health-cmd health-interval health-retries health-start-period health-start-interval health-timeout cpuset-cpus env-from-file",
  "diPqtT",
  "rm detach interactive tty privileged init read-only publish-all quiet no-deps service-ports use-aliases build remove-orphans quiet-pull no-tty oom-kill-disable",
)

/** `docker service create` options whose value is the next word, then those that take none. */
const SERVICE_CREATE_OPTIONS = options(
  "elpuw",
  "cap-add cap-drop config constraint container-label credential-spec dns dns-option dns-search endpoint-mode entrypoint env env-file generic-resource group health-cmd health-interval health-retries health-start-period health-timeout host hostname isolation label limit-cpu limit-memory limit-pids log-driver log-opt mode mount name network placement-pref publish replicas replicas-max-per-node reserve-cpu reserve-memory restart-condition restart-delay restart-max-attempts restart-window secret stop-grace-period stop-signal sysctl ulimit user workdir",
  "dqt",
  "detach init no-healthcheck no-resolve-image quiet tty read-only with-registry-auth",
)

/** `kubectl exec` options whose value is the next word; the global options may follow the subcommand. */
const KUBECTL_EXEC_OPTIONS = options(
  `${KUBECTL_OPTIONS.short ?? ""}cf`,
  `${(KUBECTL_OPTIONS.long ?? []).join(" ")} container filename pod-running-timeout`,
  "itq",
  "stdin tty quiet",
)

/** `oc rsh` options whose value is the next word, as `kubectl exec`'s, then those that take none. */
const OC_RSH_OPTIONS = options(
  `${KUBECTL_OPTIONS.short ?? ""}cf`,
  `${(KUBECTL_OPTIONS.long ?? []).join(" ")} container filename shell timeout`,
  "tT",
  "tty no-tty",
)

/**
 * The command a container runs, after the container, service or image word;
 * it shares volumes, mounts and databases with the host. `run --entrypoint
 * cmd` runs `cmd` with the words after the image. The container runs its
 * `--health-cmd` value in a shell, again and again.
 */
const HEALTH_CMD = optionScript("", ["health-cmd"])
const CONTAINER_EXEC = runner(CONTAINER_EXEC_OPTIONS, { positionals: 1 })
const containerRun = (entryForm: EntryForm) =>
  spec(CONTAINER_RUN_OPTIONS, [
    command({ positionals: 1, entry: ["entrypoint"], entryForm }),
    HEALTH_CMD,
  ])

/**
 * The paths under `docker compose`, `docker-compose` and `podman-compose`.
 * `run --entrypoint` splits its value into words, as a shell does
 * (`COMPOSE_ROWS`); nerdctl's takes every value as a word
 * (`NERDCTL_COMPOSE_ROWS`).
 */
const COMPOSE_READS = {
  "": spec(COMPOSE_OPTIONS),
  exec: CONTAINER_EXEC,
}
const COMPOSE_ROWS = {
  ...COMPOSE_READS,
  run: runner(CONTAINER_RUN_OPTIONS, { positionals: 1, entry: ["entrypoint"], entryScript: true }),
}
const NERDCTL_COMPOSE_ROWS = {
  ...COMPOSE_READS,
  run: runner(CONTAINER_RUN_OPTIONS, { positionals: 1, entry: ["entrypoint"], entryForm: "every" }),
}

/**
 * The paths under `docker`, and under podman and nerdctl, which take its
 * command lines; each reads `--entrypoint` in its own form (`EntryForm`).
 */
const containerRows = (entryForm: EntryForm, compose: Readonly<Record<string, CommandSpec>>) => ({
  "": spec(
    options(
      "Hcl",
      "host context config log-level tlscacert tlscert tlskey",
      "D",
      "debug tls tlsverify",
    ),
  ),
  ...under(["compose"], compose),
  ...each(["exec", "container exec"], CONTAINER_EXEC),
  // `create` stores the command; `start` runs it.
  ...each(["run", "container run", "create", "container create"], containerRun(entryForm)),
  "service create": spec(SERVICE_CREATE_OPTIONS, [
    command({ positionals: 1, entry: ["entrypoint"], entryScript: true }),
    HEALTH_CMD,
  ]),
})

/**
 * A command given as one word is a shell script, as more words a command
 * and its arguments, which run directly (tmux, screen): each reading is
 * read. A one-word reading of several words reads only the command word.
 */
const COMMAND_OR_SCRIPT: ReadonlyArray<Run> = [command(), joined(0, 1)]

/** screen's options, and the command it runs (`screen`, and the `screen` screen command). */
const SCREEN = spec(options("cehpSsTt", "", "aAdDfilLmOqrRUvwxX"), COMMAND_OR_SCRIPT)

/** A `;` word (`\;`, `';'`) ends a tmux command: the words after it are another. */
const TMUX_NEXT = command({ after: [";"], head: "tmux" })

/** A tmux subcommand's options and runs, and the tmux command after a `;` word. */
const tmuxRow = (short: string, flags: string, runs: ReadonlyArray<Run>) =>
  spec(options(short, "", flags), [...runs, TMUX_NEXT])

/** Every tmux command (tmux 3.4 `list-commands`), and the alias of each that has one. */
const TMUX_COMMANDS = names(
  "attach-session bind-key break-pane capture-pane choose-buffer choose-client choose-tree clear-history clear-prompt-history clock-mode command-prompt confirm-before copy-mode customize-mode delete-buffer detach-client display-menu display-message display-popup display-panes find-window has-session if-shell join-pane kill-pane kill-server kill-session kill-window last-pane last-window link-window list-buffers list-clients list-commands list-keys list-panes list-sessions list-windows load-buffer lock-client lock-server lock-session move-pane move-window new-session new-window next-layout next-window paste-buffer pipe-pane previous-layout previous-window refresh-client rename-session rename-window resize-pane resize-window respawn-pane respawn-window rotate-window run-shell save-buffer select-layout select-pane select-window send-keys send-prefix server-access set-buffer set-environment set-hook set-option set-window-option show-buffer show-environment show-hooks show-messages show-options show-prompt-history show-window-options source-file split-window start-server suspend-client swap-pane swap-window switch-client unbind-key unlink-window wait-for",
)
const TMUX_ALIASES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    attach: "attach-session",
    bind: "bind-key",
    breakp: "break-pane",
    capturep: "capture-pane",
    clearhist: "clear-history",
    clearphist: "clear-prompt-history",
    confirm: "confirm-before",
    deleteb: "delete-buffer",
    detach: "detach-client",
    menu: "display-menu",
    display: "display-message",
    popup: "display-popup",
    displayp: "display-panes",
    findw: "find-window",
    has: "has-session",
    if: "if-shell",
    joinp: "join-pane",
    killp: "kill-pane",
    killw: "kill-window",
    lastp: "last-pane",
    last: "last-window",
    linkw: "link-window",
    lsb: "list-buffers",
    lsc: "list-clients",
    lscm: "list-commands",
    lsk: "list-keys",
    lsp: "list-panes",
    ls: "list-sessions",
    lsw: "list-windows",
    loadb: "load-buffer",
    lockc: "lock-client",
    lock: "lock-server",
    locks: "lock-session",
    movep: "move-pane",
    movew: "move-window",
    new: "new-session",
    neww: "new-window",
    nextl: "next-layout",
    next: "next-window",
    pasteb: "paste-buffer",
    pipep: "pipe-pane",
    prevl: "previous-layout",
    prev: "previous-window",
    refresh: "refresh-client",
    rename: "rename-session",
    renamew: "rename-window",
    resizep: "resize-pane",
    resizew: "resize-window",
    respawnp: "respawn-pane",
    respawnw: "respawn-window",
    rotatew: "rotate-window",
    run: "run-shell",
    saveb: "save-buffer",
    selectl: "select-layout",
    selectp: "select-pane",
    selectw: "select-window",
    send: "send-keys",
    setb: "set-buffer",
    setenv: "set-environment",
    set: "set-option",
    setw: "set-window-option",
    showb: "show-buffer",
    showenv: "show-environment",
    showmsgs: "show-messages",
    show: "show-options",
    showphist: "show-prompt-history",
    showw: "show-window-options",
    source: "source-file",
    splitw: "split-window",
    start: "start-server",
    suspendc: "suspend-client",
    swapp: "swap-pane",
    swapw: "swap-window",
    switchc: "switch-client",
    unbind: "unbind-key",
    unlinkw: "unlink-window",
    wait: "wait-for",
  }),
)

/**
 * The tmux command a written name names: the command, its alias, or the
 * command it is a prefix of (`split` is `split-window`). An ambiguous prefix
 * reads as the first command it prefixes that has a row.
 */
const tmuxCommandName = (written: string): string => {
  if (written === "" || TMUX_COMMANDS.includes(written)) return written
  const prefixed = TMUX_COMMANDS.filter((name) => name.startsWith(written))
  return Option.fromUndefinedOr(TMUX_ALIASES.get(written)).pipe(
    Option.orElse(() => Arr.findFirst(prefixed, (name) => COMMAND_SPECS.has(`tmux ${name}`))),
    Option.orElse(() => Arr.head(prefixed)),
    Option.getOrElse(() => written),
  )
}

/**
 * tmux's words: a word that ends in `;` ends a tmux command, as a `;` word
 * does (`tmux new -d 'true;' new …`, `tmux neww\; splitw`); one that ends
 * in `\;` is a literal `;`.
 */
const tmuxWords = (words: ReadonlyArray<ShellWord>): ReadonlyArray<ShellWord> =>
  words.flatMap((word, index) => {
    const { text } = word
    if (index === 0 || text.length < 2 || !text.endsWith(";") || text.endsWith("\\;")) return [word]
    const kept = {
      ...word,
      text: text.slice(0, -1),
      map: word.map.slice(0, -1),
      safe: word.safe.slice(0, -1),
    }
    return [kept, derivedWord(";", false)]
  })

/**
 * Every command that runs a command or a script, by command path, and the
 * parents that lead to one. A word in command position after a `Command`
 * run is a command again (`sudo git commit`, `if git diff`, `xargs git
 * add`). A command missing here runs nothing the reader follows: its words
 * are data. A row is needed where options, a computed command word or a
 * quoted script matter.
 */
const COMMAND_SPECS: ReadonlyMap<string, CommandSpec> = new Map(
  Object.entries({
    // Keywords, and commands that run the command after them as it is.
    // Multicall binaries: the next word is the applet (`busybox rm -rf x`).
    ...each(["!", "{", "if", "then", "elif", "else", "do", "while", "until"], runner()),
    ...each(["busybox", "toybox", "nohup", "builtin"], runner()),
    // bash's `time -p`, and GNU and BSD `/usr/bin/time -o FILE -f FORMAT`.
    time: runner(options("fo", "format output")),
    ...each(["setsid", "chronic", "unbuffer", "command"], runner()),
    coproc: runner({}, { named: true }),
    // `function f { … }`: the word after the name opens the body.
    function: runner({}, { positionals: 1 }),
    sudo: spec(
      options(
        "cCDghpRrTtUu",
        "user group close-from chdir host prompt role type command-timeout other-user chroot",
        "AbBEeHiKklnPSsVv",
        "askpass background bell preserve-env edit set-home login remove-timestamp reset-timestamp list non-interactive preserve-groups stdin shell validate",
      ),
      [command(), inputShell("si", ["shell", "login"])],
    ),
    doas: spec(options("uC", "", "Lns"), [command(), inputShell("s")]),
    // systemd's `run0`: with no command, it starts a root shell.
    run0: spec(
      options(
        "uDg",
        "unit property description slice user group nice chdir setenv background machine shell-prompt-prefix area lightweight",
        "hVi",
        "no-ask-password slice-inherit pty pipe via-shell empower help version",
      ),
      [command(), inputShell("")],
    ),
    // `-S` splits its value into the command it runs.
    env: spec(
      options("aCLPSUu", "argv0 unset chdir split-string", "0iv", "ignore-environment null debug"),
      [command(), optionScript("S", ["split-string"], true)],
    ),
    exec: runner(options("a")),
    pkexec: runner(options("", "user")),
    // macOS `arch -arm64 cmd`, `arch -arch x86_64 -e VAR=v cmd`.
    arch: runner({ long: ["arch", "e", "d"], singleDash: true }),
    unshare: runner(
      options(
        "SGRw",
        "setuid setgid root wd propagation map-user map-group map-users map-groups setgroups",
      ),
    ),
    "systemd-run": runner(
      options(
        "HMCpuE",
        "host machine capsule property unit setenv description slice uid gid nice working-directory service-type on-active on-boot on-startup on-unit-active on-unit-inactive on-calendar timer-property path-property socket-property",
      ),
    ),
    // `sg group cmd` and `sg group -c cmd` run a shell script. Shadow's sg
    // runs only the first word; the words after it are read too, in case
    // another sg joins them.
    sg: spec(options("c"), [joined(1), optionScript("c")]),
    ...each(["nice", "gnice"], runner(options("n", "adjustment"))),
    ionice: runner(options("cnpPu", "class classdata pid pgid uid")),
    ...each(
      ["timeout", "gtimeout"],
      runner(options("sk", "signal kill-after", "v", "preserve-status foreground verbose"), {
        positionals: 1,
      }),
    ),
    stdbuf: runner(options("ioe", "input output error")),
    caffeinate: runner(options("tw")),
    flock: spec(options("cEw", "command timeout conflict-exit-code"), [
      command({ positionals: 1 }),
      optionScript("c", ["command"]),
    ]),
    strace: runner(
      options(
        "abeEIoOpPsSuX",
        "output attach user env",
        "AcCdDfFhiknqrtTvVwxyzZ",
        "follow-forks output-separately summary-only summary",
      ),
    ),
    ltrace: runner(options("aeFnopsu", "output")),
    chroot: runner(options("", "userspec groups"), { positionals: 1 }),
    taskset: runner({}, { positionals: 1 }),
    runuser: spec(options("cgGsuw", "command group supp-group shell user"), [
      command(),
      optionScript("c", ["command"]),
    ]),
    // BSD `script [-q] file command…`.
    script: spec(options("cEIOT", "command log-in log-out log-timing"), [
      command({ positionals: 1 }),
      optionScript("c", ["command"]),
    ]),
    // With no `-c`, `su` starts the user's shell, and it runs its input.
    su: spec(options("cgGsw", "command session-command"), [
      optionScript("c", ["command", "session-command"]),
      inputShell(""),
    ]),
    "nix-shell": spec(options("AIp", "run command attr"), [optionScript("", ["run", "command"])]),
    dotenv: runner(options("ecpv")),
    // A command as another user, in another process's namespaces, under a
    // fake root or display, or with a password typed for it.
    ...each(["gosu", "su-exec"], runner({}, { positionals: 1 })),
    // `-m`, `-u`, … take a namespace file only attached (`-m/proc/1/ns/mnt`).
    nsenter: runner({
      ...options(
        "tSG",
        "target setuid setgid",
        "aFZe",
        "all no-fork follow-context preserve-credentials env mount uts ipc net pid user cgroup time root wd",
      ),
      attached: "muinpUCTrw",
    }),
    fakeroot: runner(options("lisb", "lib faked fd-base", "uhv", "unknown-is-real help version")),
    sshpass: runner({ ...options("fdpP", "", "hvV"), attached: "e" }),
    "xvfb-run": runner(
      options(
        "efnpsw",
        "error-file auth-file server-num xauth-protocol server-args wait",
        "al",
        "auto-servernum listen-tcp help",
      ),
    ),
    // watchexec joins its words into a shell script, or runs them as they
    // are (`-n`).
    watchexec: spec(
      options(
        "efiwWdsE",
        "exts filter ignore watch watch-non-recursive debounce signal shell stop-signal stop-timeout delay-run on-busy-update env project-origin workdir filter-file ignore-file emit-events-to wrap-process",
        "crnpNqv",
        "restart postpone notify no-vcs-ignore no-project-ignore no-global-ignore no-default-ignore no-discover-ignore no-meta no-environment quiet verbose",
      ),
      [command(), joined()],
    ),
    // screen runs the command after its options. With `-X`, the words after
    // the options are a screen command: `screen` and `exec` run a command,
    // and `eval` runs each of its words as a screen command. The screen
    // commands are read as paths under `screen` with or without `-X`.
    screen: SCREEN,
    "screen screen": SCREEN,
    // `exec [fdpat] cmd`: a first word such as `.!.` routes the descriptors.
    "screen exec": spec({}, [command(), command({ positionals: 1 })]),
    "screen eval": spec({}, [Run.cases.OperandCommands.make({ head: "screen", skip: 0 })]),
    // `at`, and `batch`, which is `at -b`, run their input as a shell
    // script later.
    ...each(["at", "batch"], spec(options("fqt", "", "bcdlmMrvV"), [inputShell("")])),
    // hyperfine runs each operand, and its `--prepare`, `--setup`,
    // `--cleanup`, `--conclude` and `--reference` values, in a shell, the
    // `--shell` value with `-c` and each of them. `-L NAME a,b` and `-P
    // NAME 1 9` put each value in place of `{NAME}` in the commands.
    hyperfine: spec(
      {
        ...options(
          "wmMrpscSunPLD",
          "warmup min-runs max-runs runs prepare setup cleanup conclude reference shell time-unit command-name parameter-scan parameter-list parameter-step-size style sort export-asciidoc export-csv export-json export-markdown export-orgmode output input",
          "hiNV",
          "ignore-failure show-output help version",
        ),
        words: new Map([
          ...["L", "parameter-list"].map((name): [string, number] => [name, 2]),
          ...["P", "parameter-scan"].map((name): [string, number] => [name, 3]),
        ]),
      },
      [
        Run.cases.Operands.make({
          short: "pscS",
          long: ["prepare", "setup", "cleanup", "conclude", "reference", "shell"],
          parameters: { short: "LP", long: ["parameter-list", "parameter-scan"] },
        }),
      ],
    ),
    // tmux runs a shell command in a new session, window, pane or popup;
    // `run-shell` and `if-shell` run a script, `pipe-pane` pipes a pane into
    // a script, and `-c` runs a
    // script in tmux's shell. A `;` word, or a word that ends in `;`, starts
    // the next tmux command (`tmux new -d \; split-window cmd`). A command
    // name may be an alias or a prefix (`tmuxCommandName`).
    tmux: {
      ...spec(options("cfLST", "", "2CDlNuVv"), [optionScript("c"), TMUX_NEXT]),
      split: tmuxWords,
      subcommand: tmuxCommandName,
    },
    ...under(["tmux"], {
      "new-session": tmuxRow("cefFnstxy", "AdDEPX", COMMAND_OR_SCRIPT),
      "new-window": tmuxRow("ceFnt", "abdkPS", COMMAND_OR_SCRIPT),
      "split-window": tmuxRow("celtF", "bdfhIvPZ", COMMAND_OR_SCRIPT),
      ...each(["respawn-pane", "respawn-window"], tmuxRow("cet", "k", COMMAND_OR_SCRIPT)),
      "display-popup": tmuxRow("bcdehsStTwxy", "BCEkN", COMMAND_OR_SCRIPT),
      // `-C` runs the words as a tmux command.
      "run-shell": tmuxRow("cdt", "bC", [joined(), tmuxCommands(0)]),
      // `if-shell 'cmd' 'tmux command' ['tmux command']`.
      "if-shell": tmuxRow("t", "bF", [joined(0, 1), tmuxCommands(1)]),
      "confirm-before": tmuxRow("cpt", "by", [tmuxCommands(0)]),
      // A hook, and a key binding, run their tmux command later; `send-keys`
      // presses the key.
      "set-hook": tmuxRow("t", "agpRuw", [tmuxCommands(1)]),
      "bind-key": tmuxRow("NT", "nr", [command({ positionals: 1, head: "tmux" }), tmuxCommands(1)]),
      // The keys `send-keys` types are text, not a script; a `;` word after them starts a tmux command.
      "send-keys": tmuxRow("cNt", "FHKlMRX", []),
      "pipe-pane": tmuxRow("t", "IOo", [joined()]),
    }),
    // `-e`, `-i` and `-l` take only an attached value; so do `--max-lines`,
    // `--replace` and `--eof`, after `=`.
    xargs: spec(
      {
        ...options(
          "aEdILnPsJRS",
          "arg-file delimiter max-args max-procs max-chars process-slot-var",
        ),
        attached: "eil",
      },
      [Run.cases.Stdin.make({})],
    ),
    parallel: spec(
      options(
        "aCdEIjLnNPSs",
        `arg-file colsep delimiter jobs max-args max-replace-args max-lines max-chars sshlogin sshloginfile results joblog tmpdir workdir tagstring timeout retries load memfree basefile env halt delay nice ${PARALLEL_REPLACE_OPTIONS.join(" ")}`,
        "0kmqtuvX",
        "tag keep-order ungroup group line-buffer lb verbose dry-run bar progress eta quote xargs pipe shuf no-notice will-cite null",
      ),
      [Run.cases.Stdin.make({})],
    ),
    // find runs the command after each action, up to `;` or `+`.
    find: spec({}, [Run.cases.FindExec.make({ actions: ["-exec", "-execdir", "-ok", "-okdir"] })]),
    fd: spec({}, [Run.cases.FindExec.make({ actions: ["-x", "-X", "--exec", "--exec-batch"] })]),
    eval: spec({}, [joined()]),
    ssh: spec(options("bcDEeFIiJLlmOopQRSWwB"), [joined(1)]),
    // autossh takes ssh's options, and `-M port` for its monitor.
    autossh: spec(options("bcDEeFIiJLlmMOopQRSWwB"), [joined(1)]),
    // Scripts run on a VM or a host (`vagrant ssh -c`, `gcloud compute ssh
    // --command`, ansible's shell module arguments), when a file changes
    // (`nodemon --exec cmd args`, `entr -s 'cmd'`, `entr cmd args`), or in
    // Tcl (`expect -c 'spawn cmd'`, whose words the shell reader splits).
    "vagrant ssh": spec(options("c", "command", "pt", "plain tty no-tty"), [
      optionScript("c", ["command"]),
    ]),
    ...each(
      ["gcloud compute ssh", "gcloud beta compute ssh", "gcloud alpha compute ssh"],
      spec(
        options(
          "",
          "command zone project ssh-key-file ssh-flag container strict-host-key-checking account configuration",
          "",
          "internal-ip tunnel-through-iap dry-run plain force-key-file-overwrite quiet",
        ),
        [optionScript("", ["command"])],
      ),
    ),
    nodemon: spec(
      options(
        "xweid",
        "exec watch ext ignore delay signal config",
        "qLIVvhC",
        "quiet legacy-watch no-stdin verbose version help no-colors",
      ),
      [optionScript("x", ["exec"]), optionScript("x", ["exec"], true)],
    ),
    entr: spec(options("", "", "acdnprsz"), [command(), joined(0, 1)]),
    ansible: spec(
      options(
        "aBcefilMmPtTu",
        "args background connection extra-vars forks inventory limit module-path module-name poll tree timeout user become-user become-method private-key vault-password-file vault-id",
        "bCDkKov",
        "become check diff ask-pass ask-become-pass one-line verbose",
      ),
      [optionScript("a", ["args"])],
    ),
    expect: spec(options("cfD", "", "bdinNv"), [optionScript("c")]),
    watch: spec(options("n", "interval"), [joined()]),
    // `trap '<script>' SIGNAL`: the script runs when the signal (or `EXIT`) comes.
    trap: spec({}, [joined(0, 1)]),
    // Package managers and runners.
    pnpm: spec(
      options("CF", `filter dir loglevel ${PACKAGE_OPTIONS}`, "rs", `${PACKAGE_FLAGS} recursive`),
    ),
    npm: spec(
      options(
        "w",
        `workspace prefix userconfig cache loglevel omit include ${PACKAGE_OPTIONS}`,
        "gsq",
        `${PACKAGE_FLAGS} global`,
      ),
    ),
    yarn: spec(options("", `cwd ${PACKAGE_OPTIONS}`, "", PACKAGE_FLAGS)),
    bun: spec(options("F", `cwd filter config ${PACKAGE_OPTIONS}`, "", PACKAGE_FLAGS)),
    // `pnpm exec -c` (`--shell-mode`) runs its words as a shell script; so
    // does Yarn Berry's `yarn exec`.
    "pnpm exec": spec(options("c", "resume-from shell-mode"), [
      command(),
      optionScript("c", ["shell-mode"], true),
    ]),
    "yarn exec": spec({}, [joined()]),
    // `npx -c '<script>'` runs a shell script.
    ...each(
      ["npm exec", "npm x", "npx"],
      spec(
        options(
          "pcw",
          "package call workspace",
          "y",
          "yes no workspaces include-workspace-root quiet silent no-install",
        ),
        [command(), optionScript("c", ["call"])],
      ),
    ),
    ...each(
      ["bunx", "bun x"],
      runner(options("p", "package", "", "bun no-install verbose silent")),
    ),
    "yarn workspace": runner({}, { positionals: 1, head: "yarn" }),
    // Docker, and podman and nerdctl, which take its command lines.
    ...under(["docker"], containerRows("last", COMPOSE_ROWS)),
    ...under(["podman"], containerRows("json", COMPOSE_ROWS)),
    ...under(["nerdctl"], containerRows("every", NERDCTL_COMPOSE_ROWS)),
    // podman's own: `unshare` runs a command in its user namespace, `machine
    // ssh [name] [cmd…]` a command in its VM.
    "podman unshare": runner(options("", "", "", "rootless-netns rootless-cni")),
    "podman machine ssh": spec(options("", "username"), [joined(), joined(1)]),
    ...under(["docker-compose", "podman-compose"], COMPOSE_ROWS),
    // Kubernetes, and OpenShift's `oc`, which takes kubectl's command lines.
    // `oc rsh` runs a command in a pod, after the pod word.
    ...under(["kubectl", "oc"], {
      "": spec(KUBECTL_OPTIONS),
      // `kubectl exec` takes the command after `--`, or after the pod in
      // the old form; `kubectl debug` and `kubectl run` after `--`.
      exec: spec(KUBECTL_EXEC_OPTIONS, [command({ after: ["--"] }), command({ positionals: 1 })]),
      ...each(["debug", "run"], runner({}, { after: ["--"] })),
    }),
    "oc rsh": runner(OC_RSH_OPTIONS, { positionals: 1 }),
    uv: spec(options("", "directory project")),
    "uv run": runner(
      options(
        "",
        "with with-editable with-requirements python package env-file extra group",
        // `-m`/`--module`: the command word is a module name.
        "qvm",
        "frozen locked no-sync isolated no-project no-dev all-extras all-packages exact offline quiet verbose module",
      ),
    ),
    "op run": runner(options("", "env-file", "", "no-masking")),
    ...each(["mise exec", "mise x"], runner({}, { after: ["--"] })),
    "direnv exec": runner({}, { positionals: 1 }),
    ...each(["nix develop", "nix shell"], runner({}, { after: ["-c", "--command"] })),
    // Git: the subcommands that run a script.
    git: spec(GIT_GLOBAL_OPTIONS),
    "git commit": spec(COMMIT_OPTIONS),
    "git rebase": spec(options("xsXC", "exec strategy strategy-option onto"), [
      optionScript("x", ["exec"]),
    ]),
    "git difftool": spec(options("xt", "extcmd tool"), [optionScript("x", ["extcmd"])]),
    ...each(
      ["git fetch", "git pull", "git ls-remote"],
      spec(options("", "upload-pack"), [optionScript("", ["upload-pack"])]),
    ),
    "git clone": spec(options("ubco", "upload-pack branch origin config depth"), [
      optionScript("u", ["upload-pack"]),
    ]),
    "git push": spec(options("o", "push-option receive-pack exec repo"), [
      optionScript("", ["receive-pack", "exec"]),
    ]),
    "git archive": spec(options("o", "exec output remote format prefix"), [
      optionScript("", ["exec"]),
    ]),
    "git filter-branch": spec(
      options("d", `${FILTER_BRANCH_SCRIPTS} subdirectory-filter original state-branch`),
      [optionScript("", FILTER_BRANCH_SCRIPTS.split(" "))],
    ),
    ...each(["git submodule foreach", "git bisect run"], spec({}, [joined()])),
    // `-e` names the program that runs the transfer.
    rsync: spec(
      options("efT", "rsh rsync-path filter exclude include files-from backup-dir temp-dir"),
      [optionScript("e", ["rsh"])],
    ),
  }),
)

/** The paths with a longer path under them: the resolver reads a subcommand word after them. */
const SPEC_PARENTS: ReadonlySet<string> = new Set(
  [...COMMAND_SPECS.keys()].flatMap((path) => {
    const parts = path.split(" ")
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join(" "))
  }),
)

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
  /** The gent data directory, resolved at start: the job fiber has no ExtensionContext. */
  readonly dataDir: string
}

/** Characters that make bash expand a directory word (`~`, `$VAR`, backticks, globs). */
const SHELL_EXPANSION = /[~$`*?[{]/

/**
 * Detect `cd dir && cmd` or `cd dir; cmd` and split into cwd + command.
 * Models often emit this despite instructions to use the cwd param.
 * A directory word that bash would expand is left in the command, so bash
 * resolves it; only a single-quoted word is always literal.
 */
export function splitCdCommand(cmd: string): Option.Option<{ cwd: string; command: string }> {
  const match = Option.fromNullishOr(
    cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*(.+)$/s),
  )
  if (Option.isNone(match)) return Option.none()
  const expandable = Option.fromNullishOr(match.value[1]).pipe(
    Option.orElse(() => Option.fromNullishOr(match.value[3])),
  )
  // `cd -` names the previous directory, which only bash knows.
  if (Option.exists(expandable, (word) => word === "-" || SHELL_EXPANSION.test(word))) {
    return Option.none()
  }
  const cwd = Option.fromNullishOr(match.value[2]).pipe(
    Option.orElse(() => expandable),
    Option.getOrElse(() => ""),
  )
  const command = Option.getOrElse(Option.fromNullishOr(match.value[4]), () => "")
  if (cwd.length > 0 && command.length > 0) return Option.some({ cwd, command })
  return Option.none()
}

/** A commit that already passes a `Session-Id` trailer; a message that reads `--trailer` passes none. */
const namesSessionTrailer = (args: ReadonlyArray<string>) =>
  optionValues(parseArguments(args, COMMIT_OPTIONS), "", ["trailer"]).some((value) =>
    /^session-id\s*[:=]/i.test(valueText(args, value)),
  )

/** A session id bash reads as one plain word: the trailer needs no quoting at any depth. */
const SHELL_PLAIN_WORD = /^[\w.:@%+-]+$/

/**
 * Add the session trailer to each `git commit`, right after its `commit`
 * word, so it lands before any `--` pathspec. Commits are found from shell
 * words, so a message, a heredoc body or other quoted text that mentions
 * `git commit` is never changed. A commit that passes its own `Session-Id`
 * trailer keeps it; another trailer does not stop this one. A command found
 * only by name among another command's words (`nix develop -c git commit`)
 * gets none: it may be data. A commit in a script a shell runs (`bash -c '...'`, `$(...)`, a
 * `-c alias.x=` alias) gets the trailer too, when the id needs no quoting and
 * the insertion stays inside the quoted script word. An escaped script word
 * (`bash -c git\\ commit`) gets none: an unescaped space would split it. A
 * stored alias (`git config alias.ci 'commit'`) gets none: it runs later, in
 * other sessions. Only a `git` in command position commits: `echo git commit`
 * prints.
 */
export function injectGitTrailers(cmd: string, sessionId: SessionId): string {
  let trailer = `--trailer=Session-Id:${sessionId}`
  let maxDepth = MAX_NESTED_COMMAND_DEPTH
  if (!SHELL_PLAIN_WORD.test(sessionId)) {
    trailer = `'--trailer=Session-Id: ${sessionId.replaceAll("'", `'\\''`)}'`
    maxDepth = 0
  }
  const offsets = new Set<number>()
  for (const invocation of viewCommand(parseCommand(cmd), maxDepth)) {
    const { path, words } = resolveCommand(invocation.words)
    if (path !== "git commit") continue
    if (namesSessionTrailer(words.slice(1).map((word) => word.text))) continue
    const word = Option.fromUndefinedOr(words[0])
    if (Option.isSome(word) && word.value.endSafe) offsets.add(word.value.end)
  }
  let result = cmd
  for (const offset of [...offsets].sort((a, b) => b - a)) {
    result = `${result.slice(0, offset)} ${trailer}${result.slice(offset)}`
  }
  return result
}

/**
 * Strip a trailing `&` so the whole command does not escape tool control.
 * An inner `cmd & other` job is not stripped.
 */
export function stripBackground(cmd: string): string {
  return cmd.replace(/\s*&\s*$/, "")
}

const decodeUtf8 = (chunks: Iterable<Uint8Array>): string => {
  const decoder = new TextDecoder()
  let out = ""
  // `stream: true` holds a partial multibyte sequence until the next chunk.
  for (const chunk of chunks) out += decoder.decode(chunk, { stream: true })
  return out + decoder.decode()
}

/**
 * Spawn `bash -c <command>` and collect stdout, stderr, exit code.
 * Scope owns the spawn finalizer — closing the scope kills the process
 * group via SIGTERM with SIGKILL fallback after SIGKILL_DELAY_MS.
 */
export const runBashCommand = (command: string, cwd: Option.Option<string>) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make("bash", ["-c", command], {
      cwd: Option.getOrUndefined(cwd),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: Duration.millis(SIGKILL_DELAY_MS),
    })
    const [exitCode, stdoutChunks, stderrChunks] = yield* Effect.all(
      [handle.exitCode, Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr)],
      { concurrency: "unbounded" },
    )
    return {
      stdout: decodeUtf8(stdoutChunks),
      stderr: decodeUtf8(stderrChunks),
      exitCode: Number(exitCode),
    }
  })

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

// ── job output files ──
//
// A job's file is the one owner of its output: stdout and stderr go to a
// file under the data directory as they arrive, so the read tool (`tools.read`
// in a cell) reads a running job's output, and a job that prints for hours
// holds none of it in memory. Memory keeps the head and tail, enough for the
// completion message; a cut message names the file for the middle. A file,
// not a reader behind `context.read`: every agent has the read tool, and no
// other module learns how a job keeps its output.

/**
 * `<data dir>/background-bash/<sessionId>/<branchId>/<toolCallId>.txt`: one
 * file per job key. The path is absolute: a relative `GENT_DATA_DIR` resolves
 * against the server's cwd, as the database does, and the read tool resolves
 * a relative path against the session cwd instead.
 */
const jobOutputFile = (path: Path.Path, dataDir: string, key: BackgroundBashJobKeyFields) =>
  path.resolve(
    dataDir,
    "background-bash",
    key.sessionId,
    key.branchId,
    `${key.toolCallId.replace(/[^\w.:-]/g, "_")}.txt`,
  )

/**
 * Characters of a job's output kept in memory at each end. A completion
 * message is at most `maximumModelToolResultChars`, so each end holds all a
 * message can show of it.
 */
const jobOutputEndChars = maximumModelToolResultChars

/** A job's output as memory keeps it: its ends, its length, and its file. */
interface JobOutput {
  /** The first `jobOutputEndChars` characters. */
  readonly head: string
  /** The last `jobOutputEndChars` characters after the head. */
  readonly tail: string
  readonly totalChars: number
  /** The file with all of it; none when the file could not be written. */
  readonly file: Option.Option<string>
}

/** `output` after `text` arrives; each end stays within `jobOutputEndChars`. */
const appendJobOutput = (output: JobOutput, text: string): JobOutput => {
  const room = Math.max(0, jobOutputEndChars - output.head.length)
  const rest = text.slice(room)
  return {
    ...output,
    head: output.head + text.slice(0, room),
    tail: `${output.tail}${rest}`.slice(-jobOutputEndChars),
    totalChars: output.totalChars + text.length,
  }
}

/** A cut never splits a surrogate pair: a lone half at the cut goes with the middle. */
const HIGH_SURROGATE_END = /[\uD800-\uDBFF]$/
const LOW_SURROGATE_START = /^[\uDC00-\uDFFF]/

/**
 * The output within `maxChars`, as `headTailChars` cuts it. When the middle
 * never reached memory, the cut is made from the ends and the marker counts
 * the whole middle. Needs `maxChars` at most `2 * jobOutputEndChars`.
 */
const cutJobOutput = (output: JobOutput, maxChars: number): string => {
  const kept = output.head + output.tail
  if (output.totalChars === kept.length) return headTailChars(kept, maxChars).text
  const marker = (cut: number) => `\n\n... [${cut} characters truncated] ...\n\n`
  const room = maxChars - marker(output.totalChars).length
  if (room < 0) return headTailChars(kept, maxChars).text
  const head = output.head.slice(0, Math.floor(room / 2)).replace(HIGH_SURROGATE_END, "")
  let tail = ""
  if (room > head.length) {
    tail = output.tail.slice(-(room - head.length)).replace(LOW_SURROGATE_START, "")
  }
  return `${head}${marker(output.totalChars - head.length - tail.length)}${tail}`
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

/**
 * Spawn `bash -c <command>`. Its stdout and stderr go to `file` as they
 * arrive, in arrival order; memory keeps the ends. A file that cannot be
 * written is logged once, and the job runs on with only the ends. The scope
 * owns the spawn finalizer and the open file.
 */
const streamBackgroundCommand = (command: string, cwd: Option.Option<string>, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const writeFailed = (cause: Cause.Cause<unknown>) =>
      Effect.logWarning("exec-tools.background.output.write.failed").pipe(
        Effect.annotateLogs({ file, cause: Cause.pretty(cause) }),
        Effect.as(Option.none<FileSystem.File>()),
      )
    let sink = yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(
        Effect.andThen(fs.open(file, { flag: "w" })),
        Effect.asSome,
        Effect.catchCause(writeFailed),
      )
    let output: JobOutput = {
      head: "",
      tail: "",
      totalChars: 0,
      file: Option.as(sink, file),
    }
    const encoder = new TextEncoder()
    const record = (text: string) =>
      Effect.gen(function* () {
        if (text.length === 0) return
        output = appendJobOutput(output, text)
        if (Option.isNone(sink)) return
        const open = sink.value
        sink = yield* open
          .writeAll(encoder.encode(text))
          .pipe(Effect.as(Option.some(open)), Effect.catchCause(writeFailed))
        if (Option.isNone(sink)) output = { ...output, file: Option.none() }
      })
    const handle = yield* ChildProcess.make("bash", ["-c", command], {
      cwd: Option.getOrUndefined(cwd),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: Duration.millis(SIGKILL_DELAY_MS),
    })
    // One decoder per stream: `stream: true` holds a partial multibyte
    // sequence until that stream's next chunk.
    const stdout = new TextDecoder()
    const stderr = new TextDecoder()
    const texts = Stream.merge(
      handle.stdout.pipe(Stream.map((chunk) => stdout.decode(chunk, { stream: true }))),
      handle.stderr.pipe(Stream.map((chunk) => stderr.decode(chunk, { stream: true }))),
    )
    const [exitCode] = yield* Effect.all(
      [
        handle.exitCode,
        Stream.runForEach(texts, record).pipe(
          Effect.andThen(Effect.suspend(() => record(stdout.decode() + stderr.decode()))),
        ),
      ],
      { concurrency: "unbounded" },
    )
    return { exitCode: Number(exitCode), output }
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
// whose message the follow-up queue refused is shown the same way, with its
// outcome, so no finished job goes unreported.

const maximumNoticeJobs = 10
const maximumNoticeCommandChars = 200
const maximumNoticeOutputChars = 2_000

const noticeCommand = (command: string) => {
  const line = command.replace(/\s+/g, " ").trim()
  const chars = Array.from(line)
  if (chars.length <= maximumNoticeCommandChars) return line
  return `${chars.slice(0, maximumNoticeCommandChars - 1).join("")}…`
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
    if (info.value.size === FileSystem.Size(0)) return "it wrote no output before the stop"
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
      savedOutput(jobOutputFile(path, dataDir, { ...branch, toolCallId: job.toolCallId })).pipe(
        Effect.map((where): readonly [ToolCallId, string] => [job.toolCallId, where]),
      ),
    ),
  )
  const interrupted = jobNotice(stopped, {
    id: "exec-tools-interrupted",
    intro:
      "# Interrupted background commands\n\nThese background commands stopped before they finished (a server restart or a reload). They are not running. A file named below holds only the output written before the stop; output after that is lost. Tell the user which commands did not finish; start one again only when the user asks for it.",
    line: (job) =>
      `- \`${noticeCommand(job.command)}\` · call ${job.toolCallId} · ${saved.get(job.toolCallId) ?? "no output was saved"}`,
    rest: "interrupted commands",
  })
  const finished = yield* storage.undeliveredJobs(branch)
  const outputs = new Map(
    yield* Effect.forEach(finished.slice(0, maximumNoticeJobs), (job) =>
      storedOutputFile(
        jobOutputFile(path, dataDir, { ...branch, toolCallId: job.toolCallId }),
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
      "# Background commands finished\n\nThese background commands finished while the follow-up queue was full, so no message reported them. Tell the user what they returned.",
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
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | ExtensionContext
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
    const completed = yield* Ref.make<ReadonlySet<BackgroundBashJobKey>>(new Set())
    const rememberCompleted = (key: BackgroundBashJobKey) =>
      Ref.update(completed, (keys) => new Set(keys).add(key))

    const runBackgroundJob = Effect.fn("BackgroundBashSupervisor.runBackgroundJob")(function* (
      job: BackgroundBashJob,
      target: BackgroundBashTarget,
    ) {
      const path = yield* Path.Path
      const file = jobOutputFile(path, target.dataDir, target)
      const { exitCode, output } = yield* streamBackgroundCommand(job.command, job.cwd, file).pipe(
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
     * writer of the row's delivery mark: a refused send marks the row, and
     * the branch's next turn reads the job as a notice; an accepted send (a
     * replay of a refused one, for one) clears it.
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
              const file = jobOutputFile(yield* Path.Path, target.dataDir, target)
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
        const target: BackgroundBashTarget = {
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          toolCallId: ctx.toolCallId,
          Session: ctx.Session,
          dataDir: yield* resolveDataDir(ctx.home),
        }
        const file = jobOutputFile(yield* Path.Path, target.dataDir, target)
        const key = backgroundJobKey(target)
        const keyFields = backgroundJobKeyFields(target)
        if ((yield* Ref.get(completed)).has(key)) return file
        const claim = yield* storage.claimStart({
          ...keyFields,
          command: job.command,
          cwd: job.cwd,
        })
        if (claim._tag === "AlreadyRunning") return file
        if (claim._tag === "Terminal") {
          yield* deliverTerminal(target, claim.state)
          yield* rememberCompleted(key)
          return file
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
          Effect.ensuring(rememberCompleted(key)),
          Effect.updateContext(
            (
              _: Context.Context<
                ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
              >,
            ) => jobContext,
          ),
          // A fiber interrupted before its first step runs none of it, the
          // interrupt mark included. Starting at once installs the mark
          // before the claim is visible to anything that could stop it.
          Effect.forkIn(scope, { startImmediately: true }),
        )
        return file
      }).pipe(gate.withPermits(1))

    return BackgroundBashSupervisor.of({ start })
  }),
)

// Bash Tool

export const BashTool = tool({
  id: "bash",
  destructive: true,
  description:
    "Execute shell command. Use for git, npm, system commands. Prefer dedicated tools for file ops. Large output is kept whole; the prompt shows the head and tail, and context.read(toolCallId, { offset, limit }) pages the rest.",
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

    // Strip background operator
    let command = stripBackground(params.command)

    // Inject git commit trailers for session traceability
    command = injectGitTrailers(command, ctx.sessionId)

    // Split cd + command patterns into cwd + command. One server serves
    // every workspace, so the directory resolves against the session's
    // cwd, never the server process directory.
    // A `cd` in the command resolves against `params.cwd`, as bash would.
    const path = yield* Path.Path
    let directory = path.resolve(ctx.cwd, params.cwd ?? ".")
    const split = splitCdCommand(command)
    if (Option.isSome(split)) {
      directory = path.resolve(directory, split.value.cwd)
      command = split.value.command
    }
    const cwd = Option.some(directory)

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

    // Sync mode — spawn into an explicit scope so on timeout we can
    // fork-and-forget the scope-close (which fires SIGTERM/SIGKILL via
    // the spawn finalizer) instead of awaiting forceKillAfter on the
    // calling fiber: the tool returns immediately on timeout and the kill
    // happens async.
    const spawnScope = yield* Scope.make()
    const closeSpawnScope = Scope.close(spawnScope, Exit.void).pipe(Effect.ignore)
    const result = yield* runBashCommand(command, cwd).pipe(
      Scope.provide(spawnScope),
      Effect.timeoutOrElse({
        duration: Duration.millis(timeout),
        orElse: () =>
          Effect.forkDetach(closeSpawnScope).pipe(
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

    // The full result is stored and the transcript bounds the model-facing
    // copy at `maximumModelToolResultChars`; the cell pages the rest with
    // `context.read(toolCallId, { offset, limit })`.
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
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

// A job still marked running that an earlier server process started belongs
// to a process that is gone: mark it interrupted before the supervisor takes
// new work. A job this process runs stays running when another profile builds.
const ReconcileInterruptedJobs = Layer.effectDiscard(
  Effect.gen(function* () {
    const storage = yield* BackgroundBashStorage
    yield* storage.reconcileInterrupted
  }),
)

export const BackgroundBashLayer = BackgroundBashSupervisorLive.pipe(
  Layer.provideMerge(ReconcileInterruptedJobs),
  Layer.provideMerge(BackgroundBashStorage.Live),
)

export const ExecToolsExtension = defineExtension({
  id: EXEC_TOOLS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", BashTool)
    yield* host.register(
      "resource",
      defineResource({
        id: "@gent/exec-tools/background-bash",
        scope: "process",
        layer: BackgroundBashLayer,
      }),
    )
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
  }),
})
