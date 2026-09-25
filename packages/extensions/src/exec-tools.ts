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
                    message = 'Background command did not finish: the server stopped'
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

// Bash command classification for guardrails.
//
// A command is read as shell words (see below), and each command in command
// position is checked against a table of risky commands: destructive,
// external and sensitive. There are no saved rules: every flagged call asks
// for one durable approval, and a call with no answerer fails closed.

type BashRiskLevel = "safe" | "destructive" | "external" | "sensitive"

interface BashRisk {
  level: BashRiskLevel
  reason: string
}

const SAFE_RISK: BashRisk = { level: "safe", reason: "" }

// ── shell words ──
//
// Commands are read as shell words, not as raw text. Global options, env
// prefixes, wrappers, quoting and redirections cannot move a flag out of
// sight, and quoted text or a heredoc body is never read as a command. Each
// word keeps the source offset of every character, so a rewrite (the commit
// trailer) lands at the right place, also inside a script a shell runs.

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
  /**
   * The word holds an unquoted expansion or substitution: the shell splits
   * its value into more words (`$ARGS` may be `app -c 'DROP TABLE t'`).
   */
  readonly splits: boolean
  /** The word holds an unquoted glob or brace pattern: the shell expands it to other words. */
  readonly pattern: boolean
  /** The word holds an unquoted brace expansion (`{-rf,x}`): one word becomes several. */
  readonly braces: boolean
}

interface ShellSegment {
  readonly words: Array<ShellWord>
  /** Here-strings and heredoc bodies: what the command reads on stdin. */
  readonly stdin: Array<ShellWord>
  /** The targets of its output redirections: files it writes. */
  readonly writes: Array<ShellWord>
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
  splits: boolean
  /** The unquoted characters of the word: where a glob or brace pattern can be. */
  plain: string
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
  writes: [],
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

/** A brace expansion (`{a,b}`, `{1..3}`): one word becomes several. */
const BRACE_TEXT = /\{[^{}]*(?:,|\.\.)[^{}]*\}/

/** A glob (`*`, `?`, `[…]`) or a brace expansion in unquoted text. */
const PATTERN_TEXT = new RegExp(String.raw`[*?]|\[[^\]]*\]|${BRACE_TEXT.source}`)

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
    splits: false,
    pattern: false,
    braces: false,
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
  reader.splits = false
  reader.plain = ""
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
      splits: reader.splits,
      pattern: PATTERN_TEXT.test(reader.plain),
      braces: BRACE_TEXT.test(reader.plain),
    }
    if (reader.role === "argument") readCompoundWord(reader, word)
    if (reader.role === "argument" && !readCaseWord(reader, word)) reader.segment.words.push(word)
    if (reader.role === "here-string") reader.segment.stdin.push(word)
    if (reader.role === "redirect-target") reader.segment.writes.push(word)
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
  if (segment.words.length > 0 || segment.stdin.length > 0 || segment.writes.length > 0) {
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
  if (!quoted) reader.splits = true
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
  reader.splits = true
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
  if (startsExpansion(reader.source.text, index)) {
    reader.dynamic = true
    reader.splits = true
  }
  reader.plain += reader.source.text.charAt(index)
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
    splits: false,
    plain: "",
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
      splits: false,
      pattern: false,
      braces: false,
    },
    Option.none(),
  )

/**
 * A word made of other text: no source offsets to rewrite, no safe
 * insertion point. Its quoting is lost, so dynamic text may split.
 */
const derivedWord = (text: string, dynamic: boolean): ShellWord => ({
  text,
  map: Array.from({ length: text.length }, () => 0),
  safe: Array.from({ length: text.length }, () => false),
  end: 0,
  endSafe: false,
  dynamic,
  splits: dynamic,
  pattern: false,
  braces: false,
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
    splits: words.some((word) => word.splits),
    pattern: words.some((word) => word.pattern),
    braces: words.some((word) => word.braces),
  })
}

/** Shells whose `-c` script the guard reads as shell words. */
const SHELL_NAMES = new Set([
  ...["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "yash", "rbash"],
  ...["csh", "tcsh", "fish", "nu", "xonsh", "elvish"],
])
/** Shells whose scripts are not shell words: any script they are given cannot be read. */
const FOREIGN_SHELLS = new Set(["pwsh", "powershell"])
/** A PowerShell option that runs text: `-c`, `-Command` and its prefixes, `-e`/`-EncodedCommand`. */
const FOREIGN_SCRIPT_OPTION = /^-(c|com\w*|e|ec|enc\w*)$/i
/** `NAME=value` before a command sets its environment. */
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/

const commandName = (word: string): string => word.slice(word.lastIndexOf("/") + 1)

// ── options ──
//
// One reader for the options of every command: wrappers, shells, git and
// the commands the guard classifies. A table of `ValueOptions` per command
// says which options take a value.

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
}

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

/** The options and operands of one command (a git subcommand, `rm`, `npm`). */
interface ParsedArguments {
  /** Letters of every short option cluster (`-fd` holds `f` and `d`). */
  readonly shorts: ReadonlySet<string>
  /** Long option names as written, without `--` and `=value`. */
  readonly longs: ReadonlyArray<string>
  readonly options: ReadonlyArray<ParsedOption>
  /** Operands before `--`; for a leading read, every word from the first operand on. */
  readonly operands: ReadonlyArray<string>
  /** The index in the arguments of each of `operands`. */
  readonly operandsAt: ReadonlyArray<number>
  /** Operands after `--`. */
  readonly pathspecs: ReadonlyArray<string>
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
 * of `name` is read as `name`. An ambiguous prefix makes the command exit
 * with an error, so reading it as the risky option asks for approval of a
 * command that would do nothing.
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
  } else if (
    long.includes(name) ||
    (!(valued.flags?.long ?? []).includes(name) && long.some((option) => abbreviates(name, option)))
  ) {
    value = Option.some({ word: index + 1, from: 0 })
    next = index + 2
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
      return next
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
  const operands: Array<string> = []
  const operandsAt: Array<number> = []
  let index = 0
  while (index < args.length) {
    const arg = args[index] ?? ""
    if (arg === "--") {
      return {
        ...into,
        operands,
        operandsAt,
        pathspecs: args.slice(index + 1),
        end: index + 1,
        separated: true,
      }
    }
    if (isOptionWord(arg, valued)) {
      index = readOption(args, index, valued, into)
    } else if (order === "leading") {
      return {
        ...into,
        operands: args.slice(index),
        operandsAt: args.map((_, at) => at).slice(index),
        pathspecs: [],
        end: index,
        separated: false,
      }
    } else {
      operands.push(arg)
      operandsAt.push(index)
      index++
    }
  }
  return { ...into, operands, operandsAt, pathspecs: [], end: args.length, separated: false }
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
// One table, `COMMAND_SPECS` (below the risks it names), describes every
// command the guard reads, keyed by command path (`sudo`, `git rebase`,
// `docker image push`): the options that take a value at that level, what
// the words after it run, and its risks. `resolveCommand` walks the leading
// options, then the subcommand word, then the next level.

/**
 * What the words after a command path run.
 * - `Command`: the command after the options and `positionals` more words
 *   (`timeout 5 cmd`), after a `named` word before `{` (`coproc NAME { … }`),
 *   or after the first of `after` (`nix develop .#x -c cmd`). `head` is the
 *   command it is a subcommand of (`yarn workspace x npm publish`). The
 *   value of an `entry` option is the command word, and those words are its
 *   arguments (`docker run --entrypoint rm image -rf x`). With
 *   `entryScript`, the value is split into words (`docker compose run
 *   --entrypoint 'rm -rf' web x`): it and those words are one script.
 * - `Joined`: the words after the options and `positionals`, `take` of them,
 *   joined into one script (`eval`, `ssh host cmd`, `trap 'cmd' EXIT`).
 * - `Operands`: each operand, with options anywhere, is a script of its own
 *   (`hyperfine 'cmd' 'cmd'`).
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
    entryScript: Schema.Boolean,
  },
  Joined: { positionals: Schema.Int, take: Schema.Int },
  Operands: {},
  OptionScript: { short: Schema.String, long: Schema.Array(Schema.String), rest: Schema.Boolean },
  Stdin: {},
  FindExec: { actions: Schema.Array(Schema.String) },
  InputShell: { short: Schema.String, long: Schema.Array(Schema.String) },
})
type Run = typeof Run.Type
type CommandFields = Partial<Omit<typeof Run.cases.Command.Type, "_tag">>

const command = (fields: CommandFields = {}): Run =>
  Run.cases.Command.make({
    positionals: 0,
    after: [],
    named: false,
    head: "",
    entry: [],
    entryScript: false,
    ...fields,
  })

const joined = (positionals = 0, take = Number.MAX_SAFE_INTEGER): Run =>
  Run.cases.Joined.make({ positionals, take })

const optionScript = (short: string, long: ReadonlyArray<string> = [], rest = false): Run =>
  Run.cases.OptionScript.make({ short, long, rest })

const inputShell = (short: string, long: ReadonlyArray<string> = []): Run =>
  Run.cases.InputShell.make({ short, long })

/** How a command path reads the words after it. */
interface CommandSpec {
  /** The options at this level that take a value; a subcommand word comes after them. */
  readonly valued: ValueOptions
  readonly runs: ReadonlyArray<Run>
  readonly risks: ReadonlyArray<CommandRisk>
  /** `cargo +nightly publish`: a toolchain word comes first. */
  readonly toolchain?: boolean
}

const spec = (
  valued: ValueOptions,
  runs: ReadonlyArray<Run> = [],
  ...risks: ReadonlyArray<CommandRisk>
): CommandSpec => ({ valued, runs, risks })

const NO_SPEC = spec({})

/** A command path found in a command: `words` holds the words from its last word on. */
interface ResolvedCommand {
  readonly path: string
  readonly spec: CommandSpec
  readonly words: ReadonlyArray<ShellWord>
}

/**
 * Whether the words after `option` may be read wrong: its table does not
 * name it as written (a letter, or a long name in full), and no `=value`
 * shows that it takes no word after it. It may take none, one or more of
 * them (`uv run --directory sub pytest`); an abbreviated name may be another
 * option (parallel's `--tag` is not `--tagstring`).
 */
const isUnsure = (valued: ValueOptions, option: ParsedOption) => {
  const flags = valued.flags ?? { short: "", long: [] }
  if (!option.long) {
    return !`${valued.short ?? ""}${valued.attached ?? ""}${flags.short}`.includes(option.name)
  }
  if ([...(valued.long ?? []), ...flags.long].includes(option.name)) return false
  return !Option.exists(option.value, (value) => value.word === option.at)
}

/**
 * Where a command or subcommand word may be after the leading options of
 * `args`, read from `from`, beyond the usual reading's word, as indexes into
 * `args`. A table names only the options that take a value. After an option
 * it does not name, which word comes next is not known (`uv --cache-dir x
 * run`, `timeout --gent-probe-unknown 5 x cmd`): each later word that is not
 * an option may be it, and each is read.
 */
const laterCommandWords = (
  args: ReadonlyArray<string>,
  valued: ValueOptions,
  from: number,
): ReadonlyArray<number> => {
  const { options: read } = parseArguments(args.slice(from), valued, "leading")
  return Option.match(
    Arr.findFirst(read, (option) => isUnsure(valued, option)),
    {
      onNone: () => [],
      // `at` counts from `args[from]`.
      onSome: ({ at }) =>
        args.flatMap((arg, index) => {
          if (index <= from + at || isOptionWord(arg, valued)) return []
          return [index]
        }),
    },
  )
}

/** The path under `resolved` whose subcommand word is `words[next]`, when `COMMAND_SPECS` names it. */
const childCommand = (resolved: ResolvedCommand, next: number): Option.Option<ResolvedCommand> => {
  const key = `${resolved.path} ${resolved.words[next]?.text ?? ""}`
  if (!COMMAND_SPECS.has(key) && !SPEC_PARENTS.has(key)) return Option.none()
  return Option.some({
    path: key,
    spec: COMMAND_SPECS.get(key) ?? NO_SPEC,
    words: resolved.words.slice(next),
  })
}

/** The index in `resolved.words` after a toolchain word (`cargo +nightly`), where the options start. */
const optionsStart = (resolved: ResolvedCommand): number => {
  if (resolved.spec.toolchain === true && resolved.words[1]?.text.startsWith("+") === true) return 2
  return 1
}

/** The index in `resolved.words` of its usual subcommand word: the word after its leading options. */
const subcommandAt = (resolved: ResolvedCommand): number => {
  const start = optionsStart(resolved)
  const texts = resolved.words.slice(start).map((word) => word.text)
  return start + parseArguments(texts, resolved.spec.valued, "leading").end
}

/**
 * `docker volume "$A" x`, `git {reset,status} --hard`: a subcommand word the
 * shell makes at run time may be any path under the parent. Under a parent
 * with a risky path (`RISKY_PARENTS`) it is a reading that asks.
 */
const runTimeChild = (resolved: ResolvedCommand, next: number): Option.Option<ResolvedCommand> =>
  Option.map(
    Option.filter(
      Option.fromUndefinedOr(resolved.words[next]),
      (word) => RISKY_PARENTS.has(resolved.path) && (word.dynamic || word.braces),
    ),
    (word): ResolvedCommand => ({
      path: `${resolved.path} ${word.text}`,
      spec: spec({}, [], () =>
        Option.some({
          level: "destructive",
          reason: `${resolved.path} with a subcommand known only at run time: ${word.text}`,
        }),
      ),
      words: resolved.words.slice(next),
    }),
  )

/**
 * The readings of the command path under `resolved`. The first takes every
 * option the parent's table does not name to have no value, and stops at
 * the parent when the next word names no path. Each later word that may be
 * the subcommand (`laterCommandWords`) and names a path is a reading too
 * (`uv --cache-dir x run cmd`). An unnamed option alone adds none:
 * `git --no-pager status` has one reading. A subcommand word known only at
 * run time adds a reading that asks (`runTimeChild`) in the usual position,
 * and, after an option the table does not name, at the first later word
 * known only at run time (`npm --omit dev "$CMD"`). After a flag the table
 * names there are no later words: `git -P show "$SHA"` reads `$SHA` as an
 * operand.
 */
const readingsUnder = (resolved: ResolvedCommand): Arr.NonEmptyReadonlyArray<ResolvedCommand> => {
  if (!SPEC_PARENTS.has(resolved.path)) return [resolved]
  const from = optionsStart(resolved) - 1
  const args = resolved.words.slice(1).map((word) => word.text)
  // `args[index]` is `resolved.words[index + 1]`.
  const first = subcommandAt(resolved) - 1
  const later = laterCommandWords(args, resolved.spec.valued, from).filter(
    (index) => index !== first,
  )
  const runTime = Arr.findFirst(later, (index) => Option.isSome(runTimeChild(resolved, index + 1)))
  const others = [
    ...later.flatMap((index) => Option.toArray(childCommand(resolved, index + 1))),
    ...Option.toArray(Option.flatMap(runTime, (index) => runTimeChild(resolved, index + 1))),
  ].flatMap(readingsUnder)
  const head = Option.match(childCommand(resolved, first + 1), {
    onNone: (): Arr.NonEmptyReadonlyArray<ResolvedCommand> => [
      resolved,
      ...Option.toArray(runTimeChild(resolved, first + 1)),
    ],
    onSome: readingsUnder,
  })
  return Arr.appendAll(head, others)
}

/**
 * Every reading of the command path in `words`, whose first word is the
 * command word: the longest path `COMMAND_SPECS` names. Where an option a
 * parent does not name hides the subcommand word, there are more readings,
 * and the strongest risk of them wins. The first is the usual one.
 */
const resolveReadings = (
  words: ReadonlyArray<ShellWord>,
): Arr.NonEmptyReadonlyArray<ResolvedCommand> => {
  let path = commandName(words[0]?.text ?? "")
  if (path.startsWith("mkfs.")) path = "mkfs"
  return readingsUnder({ path, spec: COMMAND_SPECS.get(path) ?? NO_SPEC, words })
}

/** The usual reading of the command path in `words`: every unnamed parent option takes no value. */
const resolveCommand = (words: ReadonlyArray<ShellWord>): ResolvedCommand =>
  Arr.headNonEmpty(resolveReadings(words))

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

/**
 * Where the command of a `Command`, `Joined` or `Stdin` run may start, as
 * indexes into `words`: the reading that takes each option the runner's
 * table does not name to have no value, then each word `laterCommandWords`
 * finds. Each is read, and the strongest risk wins.
 */
const commandStarts = (
  words: ReadonlyArray<ShellWord>,
  valued: ValueOptions,
  run: CommandFields,
): ReadonlyArray<number> => {
  const start = commandStart(words, valued, run)
  if ((run.after ?? []).length > 0) return [start]
  const args = words.slice(1).map((word) => word.text)
  // `args[index]` is `words[index + 1]`.
  const later = laterCommandWords(args, valued, 0).map((index) => index + 1)
  return [start, ...later.filter((index) => index !== start)]
}

/**
 * The commands a run starts, each from its command word: one per reading of
 * the runner's options (`commandStarts`), or only the reading that takes
 * each option it does not name to have no value (`first`).
 */
const runCommands = (
  resolved: ResolvedCommand,
  run: Run,
  readings: "every" | "first" = "every",
): ReadonlyArray<ReadonlyArray<ShellWord>> => {
  const { words } = resolved
  if (run._tag === "Stdin") {
    let starts = wrapperStarts(resolved)
    if (readings === "first") starts = starts.slice(0, 1)
    return starts.map((start) => wrapperWords(resolved, start).command)
  }
  if (run._tag === "FindExec") {
    return words.flatMap((word, index) => {
      if (!run.actions.includes(word.text)) return []
      const rest = words.slice(index + 1)
      let end = rest.findIndex((next) => next.text === ";" || next.text === "+")
      if (end === -1) end = rest.length
      return [rest.slice(0, end)]
    })
  }
  if (run._tag !== "Command") return []
  return commandReadings(resolved, run, readings).flatMap(({ entry, rest }) => {
    if (Option.isSome(entry)) {
      // The script `entryScriptRuns` reads.
      if (run.entryScript) return []
      return [[entry.value, ...rest]]
    }
    if (run.head === "") return [rest]
    // No words, no subcommand: the head alone would read this command again.
    if (rest.length === 0) return []
    return [[derivedWord(run.head, false), ...rest]]
  })
}

/** One reading of a `Command` run: the value of its `entry` option, and the words after the command word or the image. */
interface CommandReading {
  readonly entry: Option.Option<ShellWord>
  readonly rest: ReadonlyArray<ShellWord>
}

/**
 * The readings of a `Command` run, one per start (`commandStarts`). The
 * value of the last `entry` option before a start is read with the options
 * anywhere, past an option the table does not name (`docker run --group-add
 * g --entrypoint sh img -c …`). An empty value that is not expanded clears
 * the entry (`--entrypoint ''`). With an entry, the word at a later start is
 * the image, and the words after it are the entry's arguments.
 */
const commandReadings = (
  { words, spec: { valued } }: ResolvedCommand,
  run: typeof Run.cases.Command.Type,
  readings: "every" | "first" = "every",
): ReadonlyArray<CommandReading> => {
  let starts = commandStarts(words, valued, run)
  if (readings === "first") starts = starts.slice(0, 1)
  return starts.map((start, index) => {
    const before = words.slice(0, start)
    const entry = Option.filter(
      Arr.last(
        optionValues(parseWords(before, valued, "anywhere"), "", run.entry).flatMap((value) =>
          Option.toArray(valueWord(before, value)),
        ),
      ),
      (word) => word.text !== "" || word.dynamic,
    )
    if (index === 0 || Option.isNone(entry)) return { entry, rest: words.slice(start) }
    return { entry, rest: words.slice(start + 1) }
  })
}

/**
 * The script of an `entryScript` run with an entry: the entry's words, then
 * the words after the image or the service, each quoted as it is.
 */
const entryScriptRuns = (
  resolved: ResolvedCommand,
  run: typeof Run.cases.Command.Type,
): SegmentRuns => {
  if (!run.entryScript) return NO_RUNS
  return mergeRuns(
    commandReadings(resolved, run).flatMap(({ entry, rest }) =>
      Option.toArray(entry).map((word) =>
        joinedRuns(resolved.path, [
          word,
          ...rest.map((arg) => derivedWord(shellQuote(arg.text), arg.dynamic)),
        ]),
      ),
    ),
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
const optionScriptRuns = (
  { path, words, spec: { valued } }: ResolvedCommand,
  run: typeof Run.cases.OptionScript.Type,
): SegmentRuns => {
  let order: OptionOrder = "anywhere"
  if (run.rest) order = "leading"
  const values = optionValues(parseWords(words, valued, order), run.short, run.long)
  if (!run.rest)
    return scriptRuns(values.flatMap((value) => Option.toArray(valueWord(words, value))))
  return Option.match(Arr.head(values), {
    onNone: () => NO_RUNS,
    onSome: (value) =>
      joinedRuns(path, [
        ...Option.toArray(valueWord(words, value)),
        ...words.slice(value.word + 2),
      ]),
  })
}

/**
 * The input an `InputShell` run's shell runs: none when a command or a script
 * option of the same path gives the shell its script instead.
 */
const inputShellRuns = (
  invocation: Invocation,
  resolved: ResolvedCommand,
  run: typeof Run.cases.InputShell.Type,
): SegmentRuns => {
  if (!inputShellStarts(resolved, run)) return NO_RUNS
  return segmentInputs(invocation.segment)
}

/**
 * Whether an `InputShell` run starts a shell that reads its input, with no
 * script of its own. After an option the table does not name (other than
 * the shell's own), the word the first reading takes as the command may be
 * that option's value (`doas -a style -s`, `doas -s -a style`): the shell
 * option may come after it, and only a script option stops the shell.
 */
const inputShellStarts = (
  resolved: ResolvedCommand,
  run: typeof Run.cases.InputShell.Type,
): boolean => {
  const { valued } = resolved.spec
  const leading = parseWords(resolved.words, valued, "leading")
  const unsure = leading.options.some(
    (option) => isUnsure(valued, option) && !isNamed(option, run.short, run.long),
  )
  let parsed = leading
  if (unsure) parsed = parseWords(resolved.words, valued, "anywhere")
  const any = run.short === "" && run.long.length === 0
  if (!any && !hasShort(parsed, ...run.short) && !hasLong(parsed, ...run.long)) return false
  return !resolved.spec.runs.some((other) => {
    if (other._tag === "OptionScript") {
      return hasShort(parsed, ...other.short) || hasLong(parsed, ...other.long)
    }
    if (unsure) return false
    return runCommands(resolved, other, "first").some((wrapped) => wrapped.length > 0)
  })
}

/** What a run runs beyond the commands it starts: its scripts, and its input. */
const specRuns = (invocation: Invocation, resolved: ResolvedCommand, run: Run): SegmentRuns => {
  const { path, words, spec } = resolved
  if (run._tag === "Command") return entryScriptRuns(resolved, run)
  if (run._tag === "Operands") {
    return mergeRuns(operandWords(words, spec.valued).map((word) => joinedRuns(path, [word])))
  }
  if (run._tag === "OptionScript") return optionScriptRuns(resolved, run)
  if (run._tag === "Stdin") return inputWrapperRuns(invocation, resolved)
  if (run._tag === "InputShell") return inputShellRuns(invocation, resolved, run)
  if (run._tag !== "Joined") return NO_RUNS
  return mergeRuns(
    commandStarts(words, spec.valued, run).map((start) =>
      joinedRuns(path, words.slice(start, start + run.take)),
    ),
  )
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
 * Whether `into` holds the invocation already. Readings of nested runners
 * reach the same words many ways (`sudo -E sudo -E ls`); each is read once.
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
  for (const resolved of resolveReadings(command)) {
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
}

const invocationName = (invocation: Invocation) => commandName(invocation.words[0]?.text ?? "")

/** `<(cmd)`: a file whose content only exists at run time. */
const isProcessSubstitution = (word: ShellWord) => word.dynamic && /^[<>]\(/.test(word.text)

/**
 * What a command runs beyond its own words: scripts to parse, and runs whose
 * text the guard cannot read. An unreadable run asks for approval: approval
 * costs little, a missed reset costs work.
 */
interface SegmentRuns {
  readonly scripts: ReadonlyArray<ShellWord>
  readonly unreadable: ReadonlyArray<string>
}

const NO_RUNS: SegmentRuns = { scripts: [], unreadable: [] }

const mergeRuns = (runs: ReadonlyArray<SegmentRuns>): SegmentRuns => ({
  scripts: runs.flatMap((run) => run.scripts),
  unreadable: runs.flatMap((run) => run.unreadable),
})

const scriptRuns = (scripts: ReadonlyArray<ShellWord>): SegmentRuns => ({ scripts, unreadable: [] })

const unreadableRun = (reason: string): SegmentRuns => ({ scripts: [], unreadable: [reason] })

/**
 * The text of `word` with its backslash escapes decoded, as `printf` and
 * `echo -e` print it. `\c` (stop printing) and `\0NNN` (echo's octal) are
 * not decoded: that text cannot be read.
 */
const decodedRuns = (word: ShellWord, command: string): SegmentRuns => {
  if (/\\[c0]/.test(word.text)) return unreadableRun(`text \`${command}\` decodes: ${word.text}`)
  let text = ""
  let index = 0
  while (index < word.text.length) {
    const escape = Option.fromNullishOr(ANSI_C_ESCAPE.exec(word.text.slice(index, index + 10)))
    if (Option.isSome(escape)) {
      text += ansiCChar(escape.value)
      index += escape.value[0].length
    } else {
      text += word.text.charAt(index)
      index++
    }
  }
  return scriptRuns([derivedWord(text, word.dynamic)])
}

/** `echo` prints its arguments joined by spaces; `-e` decodes escapes, `-E` does not. */
const echoRuns = (args: ReadonlyArray<ShellWord>): SegmentRuns => {
  let index = 0
  let escapes = false
  while (/^-[neE]+$/.test(args[index]?.text ?? "")) {
    const flags = args[index]?.text ?? ""
    if (flags.includes("e") || flags.includes("E"))
      escapes = flags.lastIndexOf("e") > flags.lastIndexOf("E")
    index++
  }
  const joined = joinWords(args.slice(index))
  if (Option.isNone(joined)) return NO_RUNS
  if (escapes && joined.value.text.includes("\\")) return decodedRuns(joined.value, "echo -e")
  return scriptRuns([joined.value])
}

/**
 * `printf` prints its format: escapes decoded, `%%` as `%`. Each `%s` takes
 * the next argument as it is, and the format repeats until every argument is
 * used. Any other directive prints its argument in a shape the guard does not
 * rebuild, and `-v` prints nothing.
 */
const printfRuns = (args: ReadonlyArray<ShellWord>): SegmentRuns => {
  // `-v` is an option only before `--`: `printf -- '-v; …'` prints it.
  if (args[0]?.text.startsWith("-v") === true) return NO_RUNS
  let rest = args
  if (rest[0]?.text === "--") rest = rest.slice(1)
  const format = Option.fromUndefinedOr(rest[0])
  if (Option.isNone(format)) return NO_RUNS
  const text = format.value.text
  const directives = text.replaceAll("%%", "")
  if (directives.replaceAll("%s", "").includes("%")) {
    return unreadableRun(`printf output with format directives: ${text}`)
  }
  if (!text.includes("%") && !text.includes("\\")) return scriptRuns([format.value])
  if (!directives.includes("%s")) {
    return decodedRuns({ ...format.value, text: text.replaceAll("%%", "%") }, "printf")
  }
  // An argument prints as it is: its backslashes stay through the escape decode.
  const values = rest.slice(1)
  let printed = ""
  let used = 0
  do {
    printed += text.replace(/%%|%s/g, (directive) => {
      if (directive === "%%") return "%"
      used++
      return (values[used - 1]?.text ?? "").replaceAll("\\", "\\\\")
    })
  } while (used < values.length)
  const dynamic = format.value.dynamic || values.some((word) => word.dynamic)
  return decodedRuns(derivedWord(printed, dynamic), "printf")
}

/**
 * The input of a command in `segment`: a here-string, a heredoc body, or the
 * text of the `echo`/`printf` whose output it reads. Only those producers
 * can be read: the output of any other command (`cat`, `tee`, a subshell or
 * group), and text a shell expands at run time, cannot.
 */
const segmentInputs = (segment: ShellSegment): SegmentRuns => {
  const file = Option.filter(segment.inputFile, (name) => !STDIN_FILES.has(name))
  if (Option.isSome(file)) return unreadableRun(`the input file \`${file.value}\``)
  const runs: Array<SegmentRuns> = [scriptRuns(segment.stdin)]
  if (Option.isSome(segment.pipedFrom)) {
    const from = segment.pipedFrom.value
    const name = commandName(from.words[0]?.text ?? "")
    if (name === "echo") runs.push(echoRuns(from.words.slice(1)))
    else if (name === "printf") runs.push(printfRuns(from.words.slice(1)))
    else if (name === "") runs.push(unreadableRun("the output of a compound command"))
    else runs.push(unreadableRun(`the output of \`${name}\``))
  }
  const inputs = mergeRuns(runs)
  const expanded = inputs.scripts
    .filter((word) => word.dynamic)
    .map((word) => `text expanded at run time: ${word.text}`)
  return { scripts: inputs.scripts, unreadable: [...inputs.unreadable, ...expanded] }
}

/** File names of the stdin of the process that opens them. */
const STDIN_FILES = new Set(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"])

/**
 * A script file a shell or `source` runs: not read, unless it only exists at
 * run time. A stdin file is the stdin of the command in `segment`.
 */
const scriptFileRuns = (segment: ShellSegment, file: Option.Option<ShellWord>): SegmentRuns => {
  if (Option.exists(file, isProcessSubstitution)) {
    return unreadableRun("a script from a process substitution")
  }
  if (Option.exists(file, (word) => STDIN_FILES.has(word.text))) return segmentInputs(segment)
  return NO_RUNS
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
 * file, which is not read: its content is not in the command. A script that
 * is not a literal (`sh -c '{}'` under xargs or `find -exec`, `sh -c "$CMD"`)
 * takes the input as the script, as a pipe into a shell does.
 */
const shellRuns = (invocation: Invocation): SegmentRuns => {
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
  const optionScripts: SegmentRuns = {
    scripts: values.filter((word) => !word.dynamic),
    unreadable: values
      .filter((word) => word.dynamic)
      .map((word) => `a shell script expanded at run time: ${word.text}`),
  }
  return mergeRuns([optionScripts, shellOperandRuns(invocation, parsed)])
}

/** What a shell runs from its `-c` argument, its stdin or a script file. */
const shellOperandRuns = (
  { segment, words, placeholder }: Invocation,
  parsed: ParsedArguments,
): SegmentRuns => {
  let end = 1 + parsed.end
  // `-` ends the options as `--` does.
  if (!parsed.separated && words[end]?.text === "-") end++
  const operand = Option.fromUndefinedOr(words[end])
  if (!hasShort(parsed, "c")) {
    if (hasShort(parsed, "s") || Option.isNone(operand)) return segmentInputs(segment)
    return scriptFileRuns(segment, operand)
  }
  const literal = Option.filter(
    operand,
    (word) => !word.dynamic && !Option.exists(placeholder, (marker) => marker.test(word.text)),
  )
  if (Option.isSome(literal)) return scriptRuns([literal.value])
  const inputs = segmentInputs(segment)
  let unreadable = inputs.unreadable
  if (inputs.scripts.length === 0 && unreadable.length === 0) {
    unreadable = ["a shell script that is not in the command"]
  }
  return { scripts: [...Option.toArray(operand), ...inputs.scripts], unreadable }
}

/** PowerShell: a script it is given, as an option or on stdin, cannot be read. */
const foreignShellRuns = ({ segment, words }: Invocation): SegmentRuns => {
  const name = commandName(words[0]?.text ?? "")
  const given =
    Option.isSome(segment.pipedFrom) ||
    segment.stdin.length > 0 ||
    words.some((word) => FOREIGN_SCRIPT_OPTION.test(word.text))
  if (given) return unreadableRun(`a ${name} script`)
  return NO_RUNS
}

/** `text` as one single-quoted shell word. */
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/** `eval`, `ssh host`, `watch` and `env -S` run `script` joined; an expanded word is known only at run time. */
const joinedRuns = (name: string, script: ReadonlyArray<ShellWord>): SegmentRuns => {
  const joined = joinWords(script)
  const unreadable = Option.toArray(joined)
    .filter((word) => word.dynamic)
    .map((word) => `${name} of text expanded at run time: ${word.text}`)
  return { scripts: Option.toArray(joined), unreadable }
}

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
  /** xargs `-I`: the input goes only into the words that hold it, never after them. */
  readonly within: boolean
  /** `-a`/`--arg-file`: the files it reads its input from in place of its stdin. */
  readonly argFiles: ReadonlyArray<string>
}

/**
 * The input use of an `xargs` or `parallel` invocation. xargs `-I R`,
 * `--replace[=R]` and `-i[R]` (R is `{}` when not given) put each line into
 * R; BSD `-J R` puts the input in place of the word R, else appends it.
 * parallel puts it into `{}` (or its `-I` value) and its other replacement
 * strings, else appends it. `--plus`, `--rpl` and the options that name a
 * replacement string make strings the guard does not know: every word may
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
    return { marker: Option.some(marker), within: false, argFiles }
  }
  let use: InputUse = { marker: Option.none(), within: false, argFiles }
  for (const option of parsed.options) {
    const given = Option.map(option.value, (at) => valueText(texts, at))
    if (isNamed(option, "Ii", ["replace"])) {
      const placeholder = Option.getOrElse(given, () => "{}")
      use = { ...use, marker: Option.some(new RegExp(literalPattern(placeholder))), within: true }
    } else if (isNamed(option, "J")) {
      const marker = Option.map(given, (text) => new RegExp(`^${literalPattern(text)}$`))
      use = { ...use, marker, within: false }
    }
  }
  return use
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

/**
 * Where the command of an `xargs` or `parallel` may start (`commandStarts`):
 * a later reading starts before parallel's first source, so every reading
 * has the same sources.
 */
const wrapperStarts = ({ path, words, spec: { valued } }: ResolvedCommand) => {
  const [first = words.length, ...later] = commandStarts(words, valued, {})
  if (path !== "parallel") return [first, ...later]
  const source = words.findIndex((word, index) => index > 0 && PARALLEL_SOURCE.test(word.text))
  return [first, ...later.filter((start) => source === -1 || start < source)]
}

/** The words of an `xargs` or `parallel` whose command starts at `start` (the first reading by default). */
const wrapperWords = (
  { path, words, spec: { valued } }: ResolvedCommand,
  start = commandStart(words, valued, {}),
): WrapperWords => {
  const rest = words.slice(start)
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

/**
 * `xargs` and `parallel` run their command with the input appended, or put
 * into the words that hold it; `parallel ::: a b` also runs each word after
 * `:::` when it has no command, and `parallel` with no command runs each
 * input line. Bare `xargs` runs `echo`. The guard does not rebuild the
 * commands the wrapper makes, even from input it can read (`echo a b`,
 * `::: a b`): the wrapper asks when the input names what runs or may be its
 * flags (see `inputNamesCommand`), and anything else stays quiet (`find … |
 * xargs rm --`, `find … | xargs wc -l`). A shell under the wrapper reads
 * its input through `shellRuns`. Each reading of the wrapper's options
 * (`wrapperStarts`) is read.
 */
const inputWrapperRuns = ({ segment }: Invocation, resolved: ResolvedCommand): SegmentRuns =>
  mergeRuns(wrapperStarts(resolved).map((start) => inputWrapperReading(segment, resolved, start)))

/** What `inputWrapperRuns` reads when the wrapper's command starts at `start`. */
const inputWrapperReading = (
  segment: ShellSegment,
  resolved: ResolvedCommand,
  start: number,
): SegmentRuns => {
  const name = commandName(resolved.words[0]?.text ?? "")
  const use = inputUse(resolved)
  const { command, sources } = wrapperWords(resolved, start)
  if (command.length === 0 && name === "xargs") return NO_RUNS
  const isMarked = (text: string) => Option.exists(use.marker, (marker) => marker.test(text))
  const appends = !use.within && !command.some((word) => isMarked(word.text))
  if (!inputNamesCommand(command, isMarked, appends)) return NO_RUNS
  const { unreadable } = segmentInputs(wrapperSegment(segment, use, sources))
  if (unreadable.length > 0) return { scripts: [], unreadable }
  return unreadableRun(`the input of \`${name}\``)
}

/**
 * Whether the input fills the script a `Joined`, `OptionScript`,
 * `Operands`, `InputShell` or entry-script run runs: its script is missing
 * or holds the placeholder, or the appended input joins it (`ssh host ls`,
 * `env -S`) or is a script of its own (`hyperfine`), or it starts a shell
 * whose options the appended input gives (`su`). A `FindExec` run takes its
 * actions from the appended input.
 */
const inputFillsScript = (
  resolved: ResolvedCommand,
  run: Run,
  isMarked: (text: string) => boolean,
  appends: boolean,
): boolean => {
  const { words, spec } = resolved
  if (run._tag === "Command") {
    return (
      run.entryScript &&
      commandReadings(resolved, run).some(
        ({ entry, rest }) =>
          Option.isSome(entry) &&
          (appends || [entry.value, ...rest].some((word) => isMarked(word.text))),
      )
    )
  }
  if (run._tag === "Operands") {
    return appends || operandWords(words, spec.valued).some((word) => isMarked(word.text))
  }
  if (run._tag === "Joined") {
    return commandStarts(words, spec.valued, run).some((start) => {
      const script = words.slice(start, start + run.take)
      // The script reaches past the last word: appended input joins it.
      const reachesEnd = start + run.take > words.length
      return (
        script.length === 0 || script.some((word) => isMarked(word.text)) || (appends && reachesEnd)
      )
    })
  }
  if (run._tag === "OptionScript") {
    let order: OptionOrder = "anywhere"
    if (run.rest) order = "leading"
    const values = optionValues(parseWords(words, spec.valued, order), run.short, run.long)
    return values.some((value) =>
      Option.match(valueWord(words, value), {
        onNone: () => true,
        onSome: (word) => isMarked(word.text) || (run.rest && appends),
      }),
    )
  }
  if (run._tag === "InputShell") return appends && inputShellStarts(resolved, run)
  return run._tag === "FindExec" && appends
}

/** Whether the input lands before the `--` of `words`: appended with no `--`, or in a placeholder before it. */
const inputBeforeSeparator = (
  words: ReadonlyArray<ShellWord>,
  isMarked: (text: string) => boolean,
  appends: boolean,
): boolean => {
  const end = words.findIndex((word, index) => index > 0 && word.text === "--")
  if (end === -1) return appends || words.some((word) => isMarked(word.text))
  return words.slice(0, end).some((word) => isMarked(word.text))
}

/**
 * Whether the input gives a shell under `xargs` or `parallel` its script:
 * the shell has no script word and the input is appended, as its script or
 * its `-c` (`xargs -n1 sh -c`, `xargs bash`), or its `-c` script word holds
 * the input (`xargs -I % sh -c %`). PowerShell reads any input it is given
 * as a script.
 */
const inputNamesShellScript = (
  words: ReadonlyArray<ShellWord>,
  isMarked: (text: string) => boolean,
  appends: boolean,
): boolean => {
  const name = commandName(words[0]?.text ?? "")
  if (FOREIGN_SHELLS.has(name)) return appends || words.some((word) => isMarked(word.text))
  if (!SHELL_NAMES.has(name)) return false
  const parsed = parseWords(words, SHELL_OPTIONS, "leading")
  let end = 1 + parsed.end
  if (!parsed.separated && words[end]?.text === "-") end++
  return Option.match(Option.fromUndefinedOr(words[end]), {
    onNone: () => appends,
    onSome: (word) => hasShort(parsed, "c") && isMarked(word.text),
  })
}

/**
 * Whether input names what `command` runs under `xargs` or `parallel`:
 * follow its runners (`env A=b`, `sudo`, `timeout 5`) to the innermost
 * command, whose word is missing or is the placeholder, or a shell whose
 * script the input gives (`inputNamesShellScript`), or whose
 * script the input fills, or which is git with a risky subcommand, or a
 * parent with a risky path under it whose subcommand is missing or the
 * placeholder (`xargs docker volume`), or which has risks and takes the
 * input before `--`, where it may be a flag (`xargs rm` given `-rf x`).
 * `appends`: the input is appended to the command.
 */
const inputNamesCommand = (
  command: ReadonlyArray<ShellWord>,
  isMarked: (text: string) => boolean,
  appends: boolean,
  // Readings of nested runners reach the same words many ways: a command
  // read once and found not to be named is not read again.
  read = new Map<ShellWord, Set<number>>(),
): boolean => {
  let start = command.findIndex((word) => !ASSIGNMENT.test(word.text))
  if (start === -1) start = command.length
  const words = command.slice(start)
  const head = Option.fromUndefinedOr(words[0])
  if (Option.isNone(head) || isMarked(head.value.text)) return true
  if (inputNamesShellScript(words, isMarked, appends)) return true
  const lengths = read.get(head.value) ?? new Set<number>()
  if (lengths.has(words.length)) return false
  read.set(head.value, lengths.add(words.length))
  const readings = resolveReadings(words)
  const fills = readings.some((resolved) =>
    resolved.spec.runs.some((run) => inputFillsScript(resolved, run, isMarked, appends)),
  )
  if (fills) return true
  const wrapped = readings.flatMap((resolved) =>
    resolved.spec.runs.flatMap((run) => {
      if (run._tag !== "Command" && run._tag !== "Stdin") return []
      return runCommands(resolved, run)
    }),
  )
  if (wrapped.length > 0) {
    return wrapped.some((inner) => inputNamesCommand(inner, isMarked, appends, read))
  }
  const namesSubcommand = readings.some(
    (resolved) =>
      RISKY_PARENTS.has(resolved.path) &&
      Option.match(Option.fromUndefinedOr(resolved.words[subcommandAt(resolved)]), {
        onNone: () => true,
        onSome: (word) => isMarked(word.text),
      }),
  )
  if (namesSubcommand) return true
  const risky = readings.some((resolved) => resolved.spec.risks.length > 0)
  if (commandName(head.value.text) === "git") return risky
  return risky && inputBeforeSeparator(words, isMarked, appends)
}

/** Environment variables whose value a command runs as a shell command. */
const SHELL_VARIABLES = new Set([
  ...["GIT_SSH_COMMAND", "GIT_SSH", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER"],
  ...["GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "GIT_PROXY_COMMAND", "SSH_ASKPASS"],
  ...["EDITOR", "VISUAL", "PAGER", "PROMPT_COMMAND"],
])

/**
 * Variables a shell expands when it uses them, running their command
 * substitutions: the prompts (PS4 under `set -x`, PS0 and PS1 in an
 * interactive shell) and the startup file names (`BASH_ENV`, `ENV`). They
 * are read wherever they are set, whether or not a shell uses them later.
 * The startup file itself is not read, as a `source`d file is not.
 */
const EXPANDED_VARIABLES = new Set(["PS0", "PS1", "PS4", "BASH_ENV", "ENV"])

/** Builtins whose `NAME=value` arguments set variables. */
const DECLARATION_COMMANDS = new Set(["export", "declare", "typeset", "local", "readonly"])

/**
 * `PS4='$(cmd)'; set -x`: bash decodes a prompt's backslash escapes (`\$`
 * is `$`), then expands it as a double-quoted word, so a command
 * substitution in it runs. The script read for an `EXPANDED_VARIABLES`
 * value is `: "<value>"` with every backslash and double quote dropped:
 * only the substitutions in it run, and `(` or `;` in the text stays data.
 */
const promptScript = (value: ShellWord): ShellWord =>
  derivedWord(`: "${value.text.replaceAll(/[\\"]/g, "")}"`, value.dynamic)

/**
 * `GIT_SSH_COMMAND=… git fetch`, `export EDITOR=…`: a value a later command
 * runs as a script. An `EXPANDED_VARIABLES` value (`PS4`, `BASH_ENV`) runs
 * its command substitutions (`promptScript`). Git also reads config from `GIT_CONFIG_KEY_<n>` and
 * `GIT_CONFIG_VALUE_<n>` pairs, and from the `'key=value'` or
 * `'key'='value'` entries of `GIT_CONFIG_PARAMETERS`.
 */
const assignmentRuns = ({ words, assignments }: Invocation): SegmentRuns => {
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
  const runs: Array<SegmentRuns> = []
  for (const [name, value] of assigned) {
    if (SHELL_VARIABLES.has(name)) runs.push(scriptRuns([value]))
    if (EXPANDED_VARIABLES.has(name)) runs.push(scriptRuns([promptScript(value)]))
    const configured = Option.fromNullishOr(/^GIT_CONFIG_KEY_(\d+)$/.exec(name)).pipe(
      Option.flatMap((match) => Option.fromUndefinedOr(values.get(`GIT_CONFIG_VALUE_${match[1]}`))),
      Option.flatMap((word) => configScript(value.text, word)),
    )
    runs.push(scriptRuns(Option.toArray(configured)))
    if (name !== "GIT_CONFIG_PARAMETERS") continue
    for (const entry of value.text.replaceAll("'='", "=").matchAll(/'([^']*)'/g)) {
      runs.push(configDefinitionRuns(derivedWord(entry[1] ?? "", value.dynamic)))
    }
  }
  return mergeRuns(runs)
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

/** `-c key=value`: the value runs now, with its source offsets. */
const configDefinitionRuns = (definition: ShellWord): SegmentRuns => {
  const equals = definition.text.indexOf("=")
  if (equals === -1) return NO_RUNS
  const key = definition.text.slice(0, equals)
  return scriptRuns(Option.toArray(configScript(key, wordFrom(definition, equals + 1))))
}

/**
 * What a git invocation runs beyond its own words and its path's runs.
 * `git -c key=<value>` runs an alias or a shell-running key (`core.pager`,
 * `core.sshCommand`) now, so the value keeps its source offsets. `git config
 * key <value>` stores it for later runs in any session: it is classified
 * now, as a derived word that nothing rewrites. A subcommand known only at
 * run time (`git $(…)`), or a shell-running value read from the environment,
 * cannot be read.
 */
const gitRuns = ({ words }: Invocation): SegmentRuns => {
  const texts = words.slice(1).map((word) => word.text)
  const global = parseArguments(texts, GIT_GLOBAL_OPTIONS, "leading")
  const runs: Array<SegmentRuns> = []
  for (const value of optionValues(global, "c")) {
    runs.push(...Option.toArray(Option.map(valueWord(words, value), configDefinitionRuns)))
  }
  for (const value of optionValues(global, "", ["config-env"])) {
    const key = valueText(texts, value).split("=", 1)[0] ?? ""
    if (GIT_SHELL_KEYS.test(key) || /^alias\./i.test(key)) {
      runs.push(unreadableRun(`a git config value read from the environment: ${key}`))
    }
  }
  const at = 1 + global.end
  const subcommand = Option.fromUndefinedOr(words[at])
  if (Option.isNone(subcommand)) return mergeRuns(runs)
  if (subcommand.value.text !== "config") return mergeRuns(runs)
  const args = words.slice(at + 1)
  for (const [index, key] of args.entries()) {
    const value = Option.fromUndefinedOr(args[index + 1])
    const stored = Option.flatMap(value, (word) => configScript(key.text, word))
    if (Option.isSome(stored)) {
      runs.push(scriptRuns([derivedWord(stored.value.text, stored.value.dynamic)]))
    }
  }
  return mergeRuns(runs)
}

/** The `name=value` words of an `alias` command: each name, and its value. */
const aliasDefinitions = ({ words }: Invocation): ReadonlyArray<readonly [string, ShellWord]> =>
  words.slice(1).flatMap((word): ReadonlyArray<readonly [string, ShellWord]> => {
    const equals = word.text.indexOf("=")
    if (equals <= 0 || word.text.startsWith("-")) return []
    return [[word.text.slice(0, equals), wordFrom(word, equals + 1)]]
  })

/**
 * `alias w='rm -rf x'`: the value of each `name=value` runs where the name
 * is a command word, once the shell expands aliases (`shopt -s
 * expand_aliases`). As with a git alias, the value as written is read where
 * it is defined, so a value with its own risk asks there. Where the name
 * is used, `aliasUseView` reads the value with the words after the name.
 */
const shellAliasRuns = (invocation: Invocation): SegmentRuns =>
  scriptRuns(aliasDefinitions(invocation).map(([, value]) => value))

/**
 * The scripts one command's words run: the argument after a shell's `-c`,
 * what a shell with no script argument reads on stdin, what its path's runs
 * run (`eval`, `ssh host`, `su -c`, the input of `xargs`), and what git
 * runs. Quoted text anywhere else, such as a commit message or `cat <<EOF`
 * notes, is data.
 */
const commandRuns = (invocation: Invocation): SegmentRuns => {
  const name = invocationName(invocation)
  const { words } = invocation
  const head = Option.fromUndefinedOr(words[0])
  if (Option.isNone(head)) return NO_RUNS
  // `$(printf git) reset --hard`, `$G reset --hard`: the command itself is computed.
  if (head.value.dynamic)
    return unreadableRun(`a command known only at run time: ${head.value.text}`)
  // `/bin/r? -rf x`, `{rm,-rf,/}`: the shell expands the command word to other words.
  if (head.value.pattern)
    return unreadableRun(`a command word the shell expands: ${head.value.text}`)
  if (SHELL_NAMES.has(name)) return shellRuns(invocation)
  if (FOREIGN_SHELLS.has(name)) return foreignShellRuns(invocation)
  if (name === "source" || name === ".")
    return scriptFileRuns(invocation.segment, Option.fromUndefinedOr(words[1]))
  const runs = resolveReadings(words).flatMap((resolved) =>
    resolved.spec.runs.map((run) => specRuns(invocation, resolved, run)),
  )
  if (name === "git") runs.push(gitRuns(invocation))
  if (name === "alias") runs.push(shellAliasRuns(invocation))
  return mergeRuns(runs)
}

/** What one command runs: the scripts of its words and of its environment. */
const invocationRuns = (invocation: Invocation): SegmentRuns =>
  mergeRuns([assignmentRuns(invocation), commandRuns(invocation)])

const MAX_NESTED_COMMAND_DEPTH = 4

/** Every command of a command line and of the scripts it runs, the files it redirects into, and what could not be read. */
interface CommandView {
  readonly invocations: ReadonlyArray<Invocation>
  readonly writes: ReadonlyArray<ShellWord>
  readonly unreadable: ReadonlyArray<string>
}

/**
 * The stdin of a script a command in `segment` runs: the command's own. Its
 * heredoc or here-string reaches the script through the command, a producer
 * the guard does not trace.
 */
const scriptInput = (segment: ShellSegment): Option.Option<ShellSegment> => {
  if (segment.stdin.length === 0) return segment.pipedFrom
  return Option.some(makeSegment(Option.none()))
}

/**
 * The scripts one command line has read, by text, with the input each read
 * (none, or its segment). Readings of nested runners build the same script
 * many ways (`ssh -X h ssh -X h ls`); each is read once. A script read
 * first at a deeper level asks where it nests too deep.
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
): CommandView => {
  const invocations: Array<Invocation> = []
  const writes: Array<ShellWord> = []
  const unreadable: Array<string> = []
  for (const segment of segments) {
    writes.push(...segment.writes)
    const found: Array<Invocation> = []
    collectInvocations(segment, segment.words, found)
    invocations.push(...found)
    for (const invocation of found) {
      const runs = invocationRuns(invocation)
      unreadable.push(...runs.unreadable)
      if (runs.scripts.length > 0 && maxDepth <= 0) unreadable.push("scripts nested too deep")
      if (maxDepth <= 0) continue
      for (const script of runs.scripts) {
        const input = scriptInput(invocation.segment)
        const key = `${script.dynamic}:${script.text}`
        const inputs = viewed.get(key) ?? []
        if (inputs.some((seen) => isSameInput(seen, input))) continue
        viewed.set(key, [...inputs, input])
        const nested = viewCommand(parseShell(script, input), maxDepth - 1, viewed)
        invocations.push(...nested.invocations)
        writes.push(...nested.writes)
        unreadable.push(...nested.unreadable)
      }
    }
  }
  return { invocations, writes, unreadable }
}

/**
 * `alias w=rm` then `w -rf x`: where a name an `alias` command of `view`
 * defines is a command word, the shell runs the value with the words after
 * the name appended. The value is read there as `value "$@"`, so those
 * words are run-time words and a risky command asks. A name matches in any
 * order in the command line. A derived word has no insertion point, so no
 * git trailer is written into an alias use. One view per name used.
 */
const aliasUseViews = (
  view: CommandView,
): ReadonlyArray<{ readonly name: string; readonly view: CommandView }> => {
  const values = new Map<string, Array<ShellWord>>()
  for (const invocation of view.invocations) {
    if (invocationName(invocation) !== "alias") continue
    for (const [name, value] of aliasDefinitions(invocation)) {
      values.set(name, [...(values.get(name) ?? []), value])
    }
  }
  const used = new Set(view.invocations.map((invocation) => invocation.words[0]?.text ?? ""))
  return [...values].flatMap(([name, definitions]) => {
    if (!used.has(name)) return []
    const scripts = new Map(
      definitions.map((value): readonly [string, ShellWord] => {
        const script = derivedWord(`${value.text} "$@"`, value.dynamic)
        return [script.text, script]
      }),
    )
    const views = [...scripts.values()].map((script) =>
      viewCommand(parseShell(script, Option.none()), MAX_NESTED_COMMAND_DEPTH - 1),
    )
    return [
      {
        name,
        view: {
          invocations: views.flatMap((read) => read.invocations),
          writes: views.flatMap((read) => read.writes),
          unreadable: views.flatMap((read) => read.unreadable),
        },
      },
    ]
  })
}

// ── command classification ──

const destructive = (reason: string) => Option.some<BashRisk>({ level: "destructive", reason })

const destructiveWhen = (condition: boolean, reason: string): Option.Option<BashRisk> => {
  if (condition) return destructive(reason)
  return Option.none()
}

/** `git stash` actions that only read. */
const STASH_READS = new Set(["list", "show", "create"])

/** The words after a command path, as a risk reads them. */
interface CommandArgs {
  readonly texts: ReadonlyArray<string>
  /** `texts` read with the path's valued options, anywhere. */
  readonly parsed: ParsedArguments
  readonly resolved: ResolvedCommand
  readonly invocation: Invocation
}

type CommandRisk = (args: CommandArgs) => Option.Option<BashRisk>

const external =
  (reason: string): CommandRisk =>
  () =>
    Option.some<BashRisk>({ level: "external", reason })

const pushRisk: CommandRisk = ({ parsed }) => {
  const refspecs = [...parsed.operands, ...parsed.pathspecs]
  if (
    hasShort(parsed, "f") ||
    hasLong(parsed, "force", "force-with-lease", "force-if-includes") ||
    refspecs.some((refspec) => /^\+./.test(refspec))
  ) {
    return destructive("git push --force")
  }
  if (
    hasShort(parsed, "d") ||
    hasLong(parsed, "delete", "mirror", "prune") ||
    refspecs.some((refspec) => /^:./.test(refspec))
  ) {
    return destructive("git push that can delete remote refs")
  }
  return Option.some({ level: "external", reason: "git push" })
}

// A branch switch (`git checkout main`, `-b feat origin/main`) keeps work.
// Paths do not: a tree-ish plus a path, `--ours`/`--theirs`, a merge
// checkout, or a force. `-B` resets an existing branch. One bare word stays
// safe: the classifier cannot tell a path from a branch without the file
// system. `git checkout -` switches back to the previous branch.
const checkoutRisk: CommandRisk = ({ parsed }) =>
  destructiveWhen(
    parsed.pathspecs.length > 0 ||
      parsed.operands.includes(".") ||
      parsed.operands.length >= 2 ||
      hasShort(parsed, "f", "p", "m", "B") ||
      hasLong(
        parsed,
        "force",
        "patch",
        "merge",
        "ours",
        "theirs",
        "conflict",
        "pathspec-from-file",
      ),
    "git checkout that discards working-tree changes",
  )

const KILL_SIGNALS = new Set(["9", "KILL", "SIGKILL"])

/** `kill -9`, `kill -KILL`, `kill -s KILL`, `kill -sKILL`, `kill --signal=KILL`. */
const killsHard = (args: ReadonlyArray<string>) =>
  args.some((arg, index) => {
    const signals = [arg.replace(/^-/, ""), /^(?:-[sn]|--signal=)(.+)$/.exec(arg)?.[1] ?? ""]
    if (["-s", "-n", "--signal"].includes(arg)) signals.push(args[index + 1] ?? "")
    return signals.some((signal) => KILL_SIGNALS.has(signal))
  })

/**
 * A word that deletes, drops or truncates, that builds and runs SQL the
 * guard cannot see (`PREPARE`, `EXECUTE`, a `DO` block), or that starts a
 * program (`COPY … TO PROGRAM`), in any case. No statement is parsed: a
 * comment, a string, a body or a WHERE does not change the answer, so
 * `DELETE … WHERE id = 1` and `SELECT 'drop'` ask too.
 */
const SQL_DESTRUCTIVE =
  /\b(delete|drop|truncate|prepare|execute|program)\b|\b(do)\s+(?:\$|e?'|u&'|language\b)/i

/**
 * The words a SQL statement may start with and stay safe: it reads, adds
 * rows (`INSERT`) or frames a transaction. Any other start asks: `UPDATE`,
 * `REPLACE`, `COPY … TO`, `ALTER`, `CREATE`, `VACUUM INTO`, `ATTACH`, `SET`.
 * DuckDB reads with `FROM t` and `SUMMARIZE t`.
 */
const SQL_READ_STARTS = new Set([
  ...["select", "with", "values", "table", "from", "show", "explain", "describe", "desc"],
  ...["summarize", "pragma", "insert", "begin", "commit", "rollback", "end", "use"],
])

/**
 * Words that write over rows or to a file in a statement that starts as a
 * read: `WITH x AS (UPDATE …)`, `EXPLAIN ANALYZE UPDATE`, `ON CONFLICT DO
 * UPDATE`, `INSERT OR REPLACE`, `INTO OUTFILE`. Functions too: every
 * large-object function (`lo_put`, `lo_import`, `lo_truncate`, `lowrite`;
 * `lo_get` only reads, an accepted over-ask), adminpack's server-file
 * functions (`pg_file_write`, `pg_file_unlink`), `pg_terminate_backend`,
 * `pg_promote`, and `dblink`, which runs SQL the guard does not read.
 */
const SQL_OVERWRITES =
  /\b(update|merge|upsert|overwrite|outfile|dumpfile|lo_\w+|lowrite|pg_file_\w+|pg_terminate_backend|pg_promote|dblink\w*|or\s+replace)\b/i

/**
 * Why `text` may write, as the reason the guard gives: the first statement
 * that does not start as a read, as written (a comment `-- note`, or `b'`
 * after the `;` of `'a;b'`), or the word that writes in one that does
 * (`EXPLAIN ANALYZE UPDATE`). The text is split at `;` and new lines, and
 * no quote is read: a `;` in a string only makes more statements. A client
 * command (`\d`, `.tables`) is judged by the client's own list.
 * `name=value` (a psql variable) is its value, and one plain word there is
 * data.
 */
const sqlWrite = (text: string): Option.Option<string> => {
  const variable = Option.fromNullishOr(/^[A-Za-z_]\w*=/.exec(text))
  const sql = Option.match(variable, {
    onNone: () => text,
    onSome: ([name]) => text.slice(name.length),
  })
  if (Option.isSome(variable) && /^[\w.:/+-]*$/.test(sql)) return Option.none()
  return Arr.findFirst(sql.split(/[;\n]/), (statement) => {
    const start = /^[\s(]*([A-Za-z_]+|\S)/.exec(statement)?.[1]?.toLowerCase() ?? ""
    if (start === "" || start === "\\" || start === ".") return Option.none()
    if (!SQL_READ_STARTS.has(start)) {
      return Option.some(`SQL that does not start as a read: ${statement.trim()}`)
    }
    return Option.map(
      Option.fromNullishOr(SQL_OVERWRITES.exec(statement)),
      ([word]) => `SQL that writes: ${word.toUpperCase()}`,
    )
  })
}

/** `text`, and each text after a letter of its leading short option cluster (`-XcDELETE`). */
const sqlTexts = (text: string): ReadonlyArray<string> => {
  const letters = /^-[A-Za-z]+/.exec(text)?.[0].length ?? 0
  return [text, ...Array.from({ length: Math.max(letters - 2, 0) }, (_, at) => text.slice(at + 2))]
}

/** How the guard reads one SQL client's words. */
interface SqlClient {
  readonly valued: ValueOptions
  /** Options whose values name the connection (host, port, user, database, password), not SQL. */
  readonly names: ValueOptions
  /** How many leading operands name the database or the user. */
  readonly nameOperands: number
  /** Options whose values are SQL or client commands. */
  readonly sql: ValueOptions
  /** Options that write the output to a file or a program (`-o '|cmd'`, `--pager=cmd`). */
  readonly output: ValueOptions
  /** Each client command in `text` outside the client's read-only list. */
  readonly commands: (text: string) => ReadonlyArray<string>
}

/** The names that match `pattern` in `text`: its first group, at each match. */
const matchedNames = (text: string, pattern: RegExp) =>
  Array.from(text.matchAll(pattern), (match) => match[1] ?? "")

/**
 * psql backslash commands that only describe, list or set the display. Any
 * other (`\!`, `\copy`, `\gexec`, `\gset`, `\o`, `\i`, `\set`) asks, and so
 * does a backquote beside one: psql runs backquoted text in a client
 * command as a shell command.
 */
const PSQL_READS =
  /^(?:d[A-Za-z]*|l|list|x|timing|conninfo|q|quit|\?|h|help|a|t|pset|echo|encoding)$/

const psqlCommands = (text: string) => {
  const found = matchedNames(text, /\\([A-Za-z]+|[^A-Za-z\s])/g)
  const asks = found.filter((name) => !PSQL_READS.test(name))
  if (found.length > 0 && text.includes("`")) asks.push("`")
  return asks
}

/**
 * MySQL client commands: a short form (`\!`) anywhere, a long form at the
 * start of a statement. The ones that run a program, read a file or write
 * one ask: `system`, `source`, `pager`, `tee`, `edit`. A backslash before a
 * character that is not a command is a string escape (`'a\nb'`).
 */
const MYSQL_ASKS = { short: "!.PTe", long: new Set(["system", "source", "pager", "tee", "edit"]) }

const mysqlCommands = (text: string) => [
  ...matchedNames(text, /\\(.)/g).filter((name) => MYSQL_ASKS.short.includes(name)),
  ...matchedNames(text, /(?:^|[;\n])\s*([A-Za-z_]+)/g).filter((name) =>
    MYSQL_ASKS.long.has(name.toLowerCase()),
  ),
]

/**
 * SQLite and DuckDB dot-commands that only describe or set the display,
 * written in full. Any other asks (`.shell`, `.system`, `.output`, `.once`,
 * `.read`, `.restore`, `.open`), and so does an abbreviation: the shell
 * reads `.rea` as `.read`.
 */
const DOT_READS = new Set([
  ...["tables", "schema", "fullschema", "indexes", "indices", "databases", "show", "help"],
  ...["mode", "headers", "header", "width", "nullvalue", "separator", "timer", "changes"],
  ...["echo", "print", "quit", "exit"],
])

/**
 * The dot-commands outside `DOT_READS`, and the SQL functions the SQLite
 * shell adds that run a program or write a file: `edit()` runs `$EDITOR`,
 * `writefile()` overwrites a file, `load_extension()` loads code.
 */
const dotCommands = (text: string) => [
  ...matchedNames(text, /(?:^|[;\n])\s*\.([A-Za-z_]\w*)/g).filter((name) => !DOT_READS.has(name)),
  ...matchedNames(text, /\b(edit|writefile|load_extension)\s*\(/gi),
]

const PSQL: SqlClient = {
  valued: options(
    "cdfhLoOpPTUvFR",
    "command dbname file host log-file output port pset username variable set field-separator record-separator",
  ),
  names: options("dhpU", "dbname host port username"),
  nameOperands: 2,
  // A variable's value reaches the input as written where `:name` is used,
  // client commands included.
  sql: options("cv", "command variable set"),
  output: options("o", "output"),
  commands: psqlCommands,
}

const MYSQL: SqlClient = {
  valued: {
    ...options("eDhPSu", "execute database host port socket user init-command"),
    attached: "p",
  },
  names: { ...options("DhPSu", "database host port socket user password"), attached: "p" },
  nameOperands: 1,
  sql: options("e", "execute init-command"),
  // `--pager` alone runs `$PAGER`.
  output: options("", "pager tee"),
  commands: mysqlCommands,
}

const SQLITE: SqlClient = {
  valued: { long: names("cmd init separator newline nullvalue vfs c s f"), singleDash: true },
  names: { long: names("vfs"), singleDash: true },
  nameOperands: 1,
  sql: { long: names("cmd c s"), singleDash: true },
  output: {},
  commands: dotCommands,
}

/** Indexes into a SQL client's arguments. */
interface SqlWords {
  /** The words that carry SQL or client commands, or may: every word but the connection names. */
  readonly all: ReadonlyArray<number>
  /** The operands among them. */
  readonly operands: ReadonlyArray<number>
}

const sqlWords = (
  texts: ReadonlyArray<string>,
  parsed: ParsedArguments,
  client: SqlClient,
): SqlWords => {
  const nameWords = new Set<number>()
  const optionWords = new Set<number>()
  for (const option of parsed.options) {
    optionWords.add(option.at)
    const named = isNamed(option, `${client.names.short ?? ""}${client.names.attached ?? ""}`, [
      ...(client.names.long ?? []),
    ])
    for (const value of Option.toArray(option.value)) {
      optionWords.add(value.word)
      if (named) nameWords.add(value.word)
    }
  }
  const operands = texts.flatMap((text, index) => {
    if (optionWords.has(index) || text === "--") return []
    return [index]
  })
  for (const index of operands.slice(0, client.nameOperands)) nameWords.add(index)
  const all: Array<number> = []
  for (let index = 0; index < texts.length; index++) {
    if (!nameWords.has(index)) all.push(index)
  }
  return { all, operands: operands.slice(client.nameOperands) }
}

/**
 * A SQL client asks when the guard cannot see what it runs: SQL from a
 * file (`-f`, `--file`, `-init`, a `<` redirect), input the guard cannot
 * read, SQL known only at run time (any word but a connection name holds a
 * `$VAR` or `$(…)`, or any word holds one unquoted: it splits, and a name
 * may bring options with it), a client command outside its read-only list, or output
 * sent to a file or a program. Else it asks when its text holds a word of
 * `SQL_DESTRUCTIVE`: any argument, option values as written, or its
 * readable input. Else it asks when a statement of its SQL does not start
 * as a read (`sqlWrite`).
 */
const sqlRisk =
  (client: SqlClient): CommandRisk =>
  ({ texts, parsed, resolved, invocation: { segment } }) => {
    const input = segmentInputs(segment)
    const inputTexts = input.scripts.map((word) => word.text)
    if (
      hasShort(parsed, "f") ||
      hasLong(parsed, "file", "init") ||
      segment.reads.length > 0 ||
      input.unreadable.length > 0
    ) {
      return destructive("SQL the guard cannot read: a file or unreadable input")
    }
    const words = sqlWords(texts, parsed, client)
    if (
      resolved.words.slice(1).some((word) => word.splits) ||
      words.all.some((index) => resolved.words[index + 1]?.dynamic === true)
    ) {
      return destructive("SQL known only at run time")
    }
    const outputs = parsed.options.filter((option) =>
      isNamed(option, client.output.short ?? "", client.output.long),
    )
    if (outputs.length > 0) return destructive("SQL client output to a file or a program")
    // Client commands: in the values of the SQL options, the operands that
    // are not names, and the input.
    const commandTexts = [
      ...optionValues(parsed, client.sql.short ?? "", client.sql.long).map((value) =>
        valueText(texts, value),
      ),
      ...words.operands.map((index) => texts[index] ?? ""),
      ...inputTexts,
    ]
    const command = Arr.findFirst(commandTexts, (text) => Arr.head(client.commands(text)))
    if (Option.isSome(command)) {
      return destructive(`a SQL client command outside the read-only list: ${command.value}`)
    }
    const trigger = Arr.findFirst([...texts, ...inputTexts].flatMap(sqlTexts), (text) =>
      Option.flatMap(Option.fromNullishOr(SQL_DESTRUCTIVE.exec(text)), ([, word, block]) =>
        destructive(`SQL ${(word ?? block ?? "").toUpperCase()}`),
      ),
    )
    if (Option.isSome(trigger)) return trigger
    return Option.flatMap(Arr.findFirst(commandTexts, sqlWrite), destructive)
  }

/**
 * Files that hold keys or secrets: anything under `.ssh`, `.gnupg` or `.aws`,
 * a `.env` file, an SSH private key, a `.pem`/`.key`/`.p12`/`.pfx` file, and
 * a `credentials` or `secrets` file with no extension or a config extension.
 * A source file only named like one (`credentials.ts`, `api.key.ts`) is code.
 */
const SENSITIVE_FILES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)\.(ssh|gnupg|aws)(\/|$)/, "modifies a file in a key directory (.ssh, .gnupg, .aws)"],
  [/(^|\/)\.env(\.(?!(example|sample|template)(\.|$))[\w.-]+)?$/, "modifies .env file"],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, "modifies SSH key"],
  [/\.(pem|key|p12|pfx)$/, "modifies a key file"],
  [/(^|\/)(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt))?$/i, "modifies credentials"],
]

/** A key or secret file named by `path`. */
const sensitiveFile = (path: string): Option.Option<BashRisk> =>
  Option.map(
    Option.fromUndefinedOr(SENSITIVE_FILES.find(([pattern]) => pattern.test(path))),
    ([, reason]): BashRisk => ({ level: "sensitive", reason }),
  )

/** A command that writes, moves or deletes a key or secret file: an operand or an option value (`cp -t ~/.ssh`). */
const sensitiveRisk: CommandRisk = ({ texts, parsed }) =>
  Arr.findFirst(
    [
      ...parsed.operands,
      ...parsed.pathspecs,
      ...parsed.options.flatMap((option) =>
        Option.toArray(option.value).map((value) => valueText(texts, value)),
      ),
    ],
    (operand) => sensitiveFile(operand),
  )

/** `sed -i` rewrites its files in place. */
const sedRisk: CommandRisk = (args) => {
  if (!hasShort(args.parsed, "i") && !hasLong(args.parsed, "in-place")) return Option.none()
  return sensitiveRisk(args)
}

const rmRisk: CommandRisk = ({ parsed }) =>
  destructiveWhen(
    hasShort(parsed, "r", "R", "f") || hasLong(parsed, "recursive", "force"),
    "rm with -r/-f flags",
  )

/** `sudo rm`, with or without flags, in any reading of sudo's options. */
const rootRmRisk: CommandRisk = ({ resolved }) => {
  const { words, spec } = resolved
  return destructiveWhen(
    commandStarts(words, spec.valued, {}).some(
      (start) => commandName(words[start]?.text ?? "") === "rm",
    ),
    "sudo rm",
  )
}

const runner = (valued: ValueOptions = {}, fields: CommandFields = {}) =>
  spec(valued, [command(fields)])

const risky = (...risks: ReadonlyArray<CommandRisk>) => spec({}, [], ...risks)

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

const PUBLISH = risky(external("publishes a package"))

/** `gh` groups whose `delete` removes something on the remote. */
const GH_DELETES = [
  ...["repo", "release", "gist", "issue", "label", "secret", "variable", "run", "cache"],
  ...["ssh-key", "gpg-key", "codespace", "project"],
]
const GH_REPO_OPTIONS = options("R", "repo")
const PUBLISH_OPTIONS = "tag access registry otp"
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
  "attach cpu-shares env env-file hostname label memory publish user volume workdir name network entrypoint mount platform pull restart cpus add-host device dns ipc log-driver log-opt pid runtime security-opt shm-size stop-signal tmpfs ulimit cap-add cap-drop cidfile gpus health-cmd health-interval health-retries health-start-period health-start-interval health-timeout",
  "diPqtT",
  "rm detach interactive tty privileged init read-only publish-all quiet no-deps service-ports use-aliases build remove-orphans quiet-pull no-tty",
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
const CONTAINER_RUN = spec(CONTAINER_RUN_OPTIONS, [
  command({ positionals: 1, entry: ["entrypoint"] }),
  HEALTH_CMD,
])

/**
 * The paths under `docker compose`, `docker-compose` and `podman-compose`: `down -v` deletes
 * the named volumes, `rm -f` removes stopped containers without asking.
 * `run --entrypoint` splits its value into words, as a shell does.
 */
const COMPOSE_ROWS = {
  "": spec(COMPOSE_OPTIONS),
  down: risky(({ parsed, resolved }) =>
    destructiveWhen(
      hasShort(parsed, "v") || hasLong(parsed, "volumes"),
      `${resolved.path} -v (deletes volumes)`,
    ),
  ),
  rm: risky(({ parsed, resolved }) =>
    destructiveWhen(
      hasShort(parsed, "f") || hasLong(parsed, "force"),
      `${resolved.path} -f (removes containers)`,
    ),
  ),
  exec: CONTAINER_EXEC,
  run: runner(CONTAINER_RUN_OPTIONS, { positionals: 1, entry: ["entrypoint"], entryScript: true }),
}

/** `terraform apply` options whose value may be the next word (`-var x=1`). */
const TERRAFORM_APPLY_OPTIONS: ValueOptions = {
  long: names("var var-file target replace state state-out backup lock-timeout parallelism"),
  singleDash: true,
}

/**
 * A command given as one word is a shell script, as more words a command
 * and its arguments (tmux, screen, watchexec): each reading is read.
 */
const COMMAND_OR_SCRIPT: ReadonlyArray<Run> = [command(), joined()]

/** A `;` word (`\;`, `';'`) ends a tmux command: the words after it are another. */
const TMUX_NEXT = command({ after: [";"], head: "tmux" })

/** A tmux subcommand's options and runs, and the tmux command after a `;` word. */
const tmuxRow = (short: string, flags: string, runs: ReadonlyArray<Run>) =>
  spec(options(short, "", flags), [...runs, TMUX_NEXT])

/** find primaries that write their output over the file they name. */
const FIND_OUTPUTS = ["fprint", "fprint0", "fprintf", "fls"]

/**
 * Every command the guard reads, by command path. A word in command position
 * after a `Command` run is a command again (`sudo git push`, `if git diff`,
 * `xargs git add`). A command missing here runs nothing the guard sees: its
 * words are data.
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
      rootRmRisk,
    ),
    doas: spec(options("uC", "", "Lns"), [command(), inputShell("s")], rootRmRisk),
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
        "cCdDfFhiknqrtTvVwxyzZ",
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
    // watchexec runs its words through a shell, or as they are (`-n`).
    watchexec: spec(
      options(
        "efiwWdsE",
        "exts filter ignore watch watch-non-recursive debounce signal shell stop-signal stop-timeout delay-run on-busy-update env project-origin workdir filter-file ignore-file emit-events-to wrap-process",
        "crnpNqv",
        "restart postpone notify no-vcs-ignore no-project-ignore no-global-ignore no-default-ignore no-discover-ignore no-meta no-environment quiet verbose",
      ),
      COMMAND_OR_SCRIPT,
    ),
    // screen runs the command after its options. `-X` sends a screen
    // command: its words (`stuff` text, typed into a shell) are one script.
    screen: spec(options("cehpSsTtX", "", "aAdDfilLmOqrRUvwx"), COMMAND_OR_SCRIPT),
    // `at`, and `batch`, which is `at -b`, run their input as a shell
    // script later.
    ...each(["at", "batch"], spec(options("fqt", "", "bcdlmMrvV"), [inputShell("")])),
    // hyperfine runs each operand, and its `--prepare`, `--setup`,
    // `--cleanup`, `--conclude` and `--reference` values, in a shell.
    hyperfine: spec(
      options(
        "wmMrpscSunPLD",
        "warmup min-runs max-runs runs prepare setup cleanup conclude reference shell time-unit command-name parameter-scan parameter-list parameter-step-size style sort export-asciidoc export-csv export-json export-markdown export-orgmode output input",
        "hiNV",
        "ignore-failure show-output help version",
      ),
      [
        Run.cases.Operands.make({}),
        optionScript("psc", ["prepare", "setup", "cleanup", "conclude", "reference"]),
      ],
    ),
    // tmux runs a shell command in a new session, window, pane or popup;
    // `run-shell` and `if-shell` run a script, `send-keys` types its keys
    // into a pane, `pipe-pane` pipes a pane into a script, and `-c` runs a
    // script in tmux's shell. A `;` word starts the next tmux command
    // (`tmux new -d \; split-window cmd`).
    tmux: spec(options("cfLST", "", "2CDlNuVv"), [optionScript("c"), TMUX_NEXT]),
    ...under(["tmux"], {
      ...each(["new-session", "new"], tmuxRow("cefFnstxy", "AdDEPX", COMMAND_OR_SCRIPT)),
      ...each(["new-window", "neww"], tmuxRow("ceFnt", "abdkPS", COMMAND_OR_SCRIPT)),
      ...each(["split-window", "splitw"], tmuxRow("celtF", "bdfhIvPZ", COMMAND_OR_SCRIPT)),
      ...each(
        ["respawn-pane", "respawnp", "respawn-window", "respawnw"],
        tmuxRow("cet", "k", COMMAND_OR_SCRIPT),
      ),
      ...each(["display-popup", "popup"], tmuxRow("bcdehsStTwxy", "BCEkN", COMMAND_OR_SCRIPT)),
      ...each(["run-shell", "run"], tmuxRow("cdt", "bC", [joined()])),
      ...each(["if-shell", "if"], tmuxRow("t", "bF", [joined()])),
      ...each(["send-keys", "send"], tmuxRow("cNt", "FHKlMRX", [joined()])),
      ...each(["pipe-pane", "pipep"], tmuxRow("t", "IOo", [joined()])),
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
    // The primaries that take a value. find reads no abbreviation, but the
    // parser does: no name here starts with `a`, so the `-a` operator takes
    // no value (`find x -a "$X"` still asks). `-fprint`, `-fprint0`,
    // `-fprintf` and `-fls` write over their file, read as a redirect is.
    find: spec(
      {
        long: names(
          `name iname path ipath wholename iwholename regex iregex lname ilname type xtype newer cnewer mtime mmin ctime cmin size maxdepth mindepth user group uid gid perm links inum samefile fstype ${FIND_OUTPUTS.join(" ")}`,
        ),
        singleDash: true,
      },
      [Run.cases.FindExec.make({ actions: ["-exec", "-execdir", "-ok", "-okdir"] })],
      ({ texts }) => destructiveWhen(texts.includes("-delete"), "find -delete"),
      ({ texts, parsed }) =>
        Arr.findFirst(optionValues(parsed, "", FIND_OUTPUTS), (value) =>
          sensitiveFile(valueText(texts, value)),
        ),
    ),
    fd: spec({}, [Run.cases.FindExec.make({ actions: ["-x", "-X", "--exec", "--exec-batch"] })]),
    eval: spec({}, [joined()]),
    ssh: spec(options("bcDEeFIiJLlmOopQRSWwB"), [joined(1)]),
    watch: spec(options("n", "interval"), [joined()]),
    // `trap '<script>' SIGNAL`: the script runs when the signal (or `EXIT`) comes.
    trap: spec({}, [joined(0, 1)]),
    // Package managers and runners.
    pnpm: spec(
      options("CF", `filter dir loglevel ${PUBLISH_OPTIONS}`, "rs", `${PACKAGE_FLAGS} recursive`),
    ),
    npm: spec(
      options(
        "w",
        `workspace prefix userconfig cache loglevel omit include ${PUBLISH_OPTIONS}`,
        "gsq",
        `${PACKAGE_FLAGS} global`,
      ),
    ),
    yarn: spec(options("", `cwd ${PUBLISH_OPTIONS}`, "", PACKAGE_FLAGS)),
    bun: spec(options("F", `cwd filter config ${PUBLISH_OPTIONS}`, "", PACKAGE_FLAGS)),
    cargo: {
      ...spec(
        options(
          "pZ",
          "package manifest-path registry token config index color",
          "qv",
          "locked frozen offline quiet verbose",
        ),
      ),
      toolchain: true,
    },
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
          "yes no workspaces include-workspace-root quiet silent",
        ),
        [command(), optionScript("c", ["call"])],
      ),
    ),
    ...each(
      ["bunx", "bun x"],
      runner(options("p", "package", "", "bun no-install verbose silent")),
    ),
    ...each(
      ["pnpm publish", "npm publish", "yarn publish", "yarn npm publish", "bun publish"],
      PUBLISH,
    ),
    "cargo publish": PUBLISH,
    "yarn workspace": runner({}, { positionals: 1, head: "yarn" }),
    "twine upload": risky(external("twine upload")),
    ...each(
      [...GH_DELETES.map((group) => `gh ${group} delete`), "gh release delete-asset"],
      risky(({ resolved }) => destructive(`${resolved.path} (deletes on the remote)`)),
    ),
    // `-R/--repo` may come before or after the group: `gh --repo o/r release
    // delete v1`, `gh release -R o/r delete v1`.
    gh: spec(GH_REPO_OPTIONS),
    ...each(
      GH_DELETES.map((group) => `gh ${group}`),
      spec(GH_REPO_OPTIONS),
    ),
    "gh api": spec(
      options("XHfFpt", "method header field raw-field preview template jq input hostname cache"),
      [],
      ({ texts, parsed }) =>
        destructiveWhen(
          optionValues(parsed, "X", ["method"]).some(
            (value) => valueText(texts, value).toUpperCase() === "DELETE",
          ),
          "gh api DELETE",
        ),
    ),
    // Docker, and podman and nerdctl, which take its command lines.
    ...under(["docker", "podman", "nerdctl"], {
      "": spec(
        options(
          "Hcl",
          "host context config log-level tlscacert tlscert tlskey",
          "D",
          "debug tls tlsverify",
        ),
      ),
      ...each(
        ["push", "image push"],
        risky(({ resolved }) =>
          Option.some<BashRisk>({ level: "external", reason: resolved.path }),
        ),
      ),
      ...each(
        ["volume rm", "volume remove", "volume prune", "system prune"],
        risky(({ resolved }) => destructive(`${resolved.path} (deletes volumes or containers)`)),
      ),
      ...under(["compose"], COMPOSE_ROWS),
      ...each(["exec", "container exec"], CONTAINER_EXEC),
      // `create` stores the command; `start` runs it.
      ...each(["run", "container run", "create", "container create"], CONTAINER_RUN),
      "service create": spec(SERVICE_CREATE_OPTIONS, [
        command({ positionals: 1, entry: ["entrypoint"], entryScript: true }),
        HEALTH_CMD,
      ]),
    }),
    ...under(["docker-compose", "podman-compose"], COMPOSE_ROWS),
    // Kubernetes, and OpenShift's `oc`, which takes kubectl's command lines.
    // `oc rsh` runs a command in a pod, after the pod word.
    ...under(["kubectl", "oc"], {
      "": spec(KUBECTL_OPTIONS),
      // `kubectl exec` takes the command after `--`, or after the pod in
      // the old form; `kubectl debug` and `kubectl run` after `--`.
      exec: spec(KUBECTL_EXEC_OPTIONS, [command({ after: ["--"] }), command({ positionals: 1 })]),
      ...each(["debug", "run"], runner({}, { after: ["--"] })),
      ...each(
        ["delete", "drain"],
        spec(options("fl", "filename selector"), [], ({ resolved }) =>
          destructive(`${resolved.path} (deletes or evicts cluster resources)`),
        ),
      ),
      replace: spec(options("f", "filename"), [], ({ parsed, resolved }) =>
        destructiveWhen(
          hasLong(parsed, "force"),
          `${resolved.path} --force (deletes and recreates)`,
        ),
      ),
    }),
    "oc rsh": runner(OC_RSH_OPTIONS, { positionals: 1 }),
    // Terraform and OpenTofu: `destroy`, `apply` that does not stop to ask
    // (`-auto-approve`, or a saved plan file), and `state rm`.
    ...each(["terraform", "tofu"], spec({ long: ["chdir"], singleDash: true })),
    ...each(
      ["terraform destroy", "tofu destroy"],
      risky(({ resolved }) => destructive(`${resolved.path} (destroys infrastructure)`)),
    ),
    ...each(
      ["terraform apply", "tofu apply"],
      spec(TERRAFORM_APPLY_OPTIONS, [], ({ parsed, resolved }) =>
        destructiveWhen(
          hasLong(parsed, "auto-approve") || parsed.operands.length > 0,
          `${resolved.path} without a confirmation`,
        ),
      ),
    ),
    ...each(
      ["terraform state rm", "tofu state rm"],
      risky(({ resolved }) => destructive(`${resolved.path} (forgets managed resources)`)),
    ),
    uv: spec(options("", "directory project")),
    "uv run": runner(
      options(
        "",
        "with python package env-file extra group",
        "qv",
        "frozen locked no-sync isolated no-project no-dev all-extras all-packages exact offline quiet verbose",
      ),
    ),
    "op run": runner(options("", "env-file", "", "no-masking")),
    ...each(["mise exec", "mise x"], runner({}, { after: ["--"] })),
    "direnv exec": runner({}, { positionals: 1 }),
    ...each(["nix develop", "nix shell"], runner({}, { after: ["-c", "--command"] })),
    // Git: the subcommands that run a script or can lose work or reach a remote.
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
    "git push": spec(
      options("o", "push-option receive-pack exec repo"),
      [optionScript("", ["receive-pack", "exec"])],
      pushRisk,
    ),
    "git archive": spec(options("o", "exec output remote format prefix"), [
      optionScript("", ["exec"]),
    ]),
    "git filter-branch": spec(
      options("d", `${FILTER_BRANCH_SCRIPTS} subdirectory-filter original state-branch`),
      [optionScript("", FILTER_BRANCH_SCRIPTS.split(" "))],
    ),
    ...each(["git submodule foreach", "git bisect run"], spec({}, [joined()])),
    "git reset": risky(({ parsed }) =>
      destructiveWhen(hasLong(parsed, "hard"), "git reset --hard"),
    ),
    "git clean": spec(options("e", "exclude"), [], ({ parsed }) =>
      destructiveWhen(!hasShort(parsed, "n") && !hasLong(parsed, "dry-run"), "git clean"),
    ),
    "git checkout": spec(options("bB", "orphan conflict pathspec-from-file"), [], checkoutRisk),
    // Every form can lose work: the default and `--worktree` overwrite the
    // working tree, and `--staged` drops staged content the tree may not hold.
    "git restore": risky(() => destructive("git restore (can discard changes)")),
    "git switch": spec(options("cC", "create force-create orphan conflict"), [], ({ parsed }) =>
      destructiveWhen(
        hasShort(parsed, "f", "C") || hasLong(parsed, "force", "discard-changes", "force-create"),
        "git switch --discard-changes/--force-create",
      ),
    ),
    // `-D`, `-d --force`, `-f <branch> <commit>`, `-M` and `-C` drop, move or
    // overwrite a branch.
    "git branch": spec(options("u", "set-upstream-to"), [], ({ parsed }) =>
      destructiveWhen(
        hasShort(parsed, "D", "M", "C", "f") || hasLong(parsed, "force"),
        "git branch -D/-M/-C/--force (can drop or overwrite a branch)",
      ),
    ),
    // Delegate children share one working tree. A stash takes a sibling's
    // uncommitted edits out of it, and a pop or apply writes them back over
    // work done since. Only the reads stay safe.
    "git stash": spec(options("m", "message"), [], ({ parsed }) => {
      const action = parsed.operands[0] ?? "push"
      return destructiveWhen(
        !STASH_READS.has(action),
        `git stash ${action} (changes the working tree other agents share)`,
      )
    }),
    // `git rm` keeps what is committed; a force also drops uncommitted edits.
    "git rm": risky(({ parsed }) =>
      destructiveWhen(
        (hasShort(parsed, "f") || hasLong(parsed, "force")) && !hasLong(parsed, "cached"),
        "git rm --force (drops uncommitted changes)",
      ),
    ),
    "git worktree": risky(({ parsed }) =>
      destructiveWhen(
        parsed.operands[0] === "remove" && (hasShort(parsed, "f") || hasLong(parsed, "force")),
        "git worktree remove --force (discards the worktree's changes)",
      ),
    ),
    // Plumbing that does what `reset --hard` or `branch -D` does.
    "git checkout-index": risky(({ parsed }) =>
      destructiveWhen(
        hasShort(parsed, "f") || hasLong(parsed, "force"),
        "git checkout-index --force (overwrites working-tree files)",
      ),
    ),
    "git read-tree": risky(({ parsed }) =>
      destructiveWhen(
        hasShort(parsed, "u") || hasLong(parsed, "reset"),
        "git read-tree -u/--reset (overwrites the index or the working tree)",
      ),
    ),
    "git update-ref": risky(() => destructive("git update-ref (moves or deletes a ref)")),
    "git reflog": risky(({ parsed }) =>
      destructiveWhen(
        ["expire", "delete"].includes(parsed.operands[0] ?? ""),
        "git reflog expire/delete (drops the record of lost commits)",
      ),
    ),
    // Commands that delete, kill, format or write secrets.
    rm: risky(rmRisk, sensitiveRisk),
    ...each(["cp", "mv"], spec(options("tS", "target-directory suffix"), [], sensitiveRisk)),
    ...each(["chmod", "chown", "tee"], risky(sensitiveRisk)),
    sed: risky(sedRisk),
    kill: risky(({ texts }) => destructiveWhen(killsHard(texts), "kill -9")),
    ...each(
      ["pkill", "killall"],
      risky(({ invocation }) => destructive(invocation.words[0]?.text ?? "")),
    ),
    mkfs: risky(() => destructive("mkfs (format filesystem)")),
    ...each(
      ["truncate", "shred", "rimraf", "dropdb"],
      risky(({ resolved }) => destructive(`${resolved.path} (deletes content)`)),
    ),
    // `-e` names the program that runs the transfer.
    rsync: spec(
      options("efT", "rsh rsync-path filter exclude include files-from backup-dir temp-dir"),
      [optionScript("e", ["rsh"])],
      ({ parsed }) =>
        destructiveWhen(
          parsed.longs.some((name) => /^del(ete(-.+)?)?$/.test(name)),
          "rsync --delete (deletes files the source lacks)",
        ),
    ),
    // `-r` removes the whole table, and a file replaces it.
    crontab: spec(options("u"), [], ({ parsed }) =>
      destructiveWhen(
        hasShort(parsed, "r") || parsed.operands.length > 0,
        "crontab -r or a new table (drops the current one)",
      ),
    ),
    // `hash -p /bin/rm ls`: `ls` runs rm from then on.
    hash: spec(options("p"), [], ({ parsed }) =>
      destructiveWhen(hasShort(parsed, "p"), "hash -p (binds a command name to another program)"),
    ),
    dd: risky(({ texts }) =>
      destructiveWhen(
        texts.some((arg) => /^(if|of)=/.test(arg)),
        "dd (raw disk write)",
      ),
    ),
    // Each client's options that take a value, so that one is not read as `-f` or `--file`.
    psql: spec(PSQL.valued, [], sqlRisk(PSQL)),
    ...each(["mysql", "mariadb"], spec(MYSQL.valued, [], sqlRisk(MYSQL))),
    ...each(["sqlite3", "duckdb"], spec(SQLITE.valued, [], sqlRisk(SQLITE))),
  }),
)

/** The paths with a longer path under them: the resolver reads a subcommand word after them. */
const SPEC_PARENTS: ReadonlySet<string> = new Set(
  [...COMMAND_SPECS.keys()].flatMap((path) => {
    const parts = path.split(" ")
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join(" "))
  }),
)

/** The parents with a path under them that has risks (`docker volume` over `docker volume rm`). */
const RISKY_PARENTS: ReadonlySet<string> = new Set(
  [...COMMAND_SPECS].flatMap(([path, { risks }]) => {
    if (risks.length === 0) return []
    const parts = path.split(" ")
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join(" "))
  }),
)

/** `"$@"`, `$*`, `"${a[@]}"`: the positional parameters or the array elements, each a word of its own. */
const EXPANDS_TO_WORDS = /^\$(?:[@*]|\{[@*]\}|\{\w+\[[@*]\]\})$/

/** A brace word that makes more words than this is read as words known only at run time. */
const MAX_BRACE_WORDS = 256

/** bash's sequence expression: `{1..10}`, `{01..10..2}`, `{a..e}`. */
const BRACE_SEQUENCE = /^(?:(-?\d+)\.\.(-?\d+)|([^{}])\.\.([^{}]))(?:\.\.(-?\d+))?$/

/** The words of a sequence expression, at most one more than `MAX_BRACE_WORDS`. */
const sequenceWords = (body: string): Option.Option<ReadonlyArray<string>> =>
  Option.map(Option.fromNullishOr(BRACE_SEQUENCE.exec(body)), (match) => {
    const step = Math.max(1, Math.abs(Number(match[5] ?? "1")))
    const numeric = /^-?\d+\.\.-?\d+(?:\.\.|$)/.test(body)
    let from = (match[3] ?? "").codePointAt(0) ?? 0
    let to = (match[4] ?? "").codePointAt(0) ?? 0
    let width = 0
    if (numeric) {
      from = Number(match[1])
      to = Number(match[2])
      // `{01..10}`: a leading zero pads every number to the wider end.
      const ends = [match[1] ?? "", match[2] ?? ""]
      if (ends.some((end) => /^-?0\d/.test(end))) {
        width = Math.max(...ends.map((end) => end.length))
      }
    }
    const direction = Math.sign(to - from) || 1
    const words: Array<string> = []
    for (
      let at = from;
      direction * (to - at) >= 0 && words.length <= MAX_BRACE_WORDS;
      at += direction * step
    ) {
      if (numeric) words.push(String(at).padStart(width, "0"))
      else words.push(String.fromCodePoint(at))
    }
    return words
  })

/** The parts of a brace body split at its top-level commas. */
const braceParts = (body: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let depth = 0
  let start = 0
  for (let at = 0; at < body.length; at++) {
    const char = body.charAt(at)
    if (char === "{") depth++
    if (char === "}") depth--
    if (char === "," && depth === 0) {
      parts.push(body.slice(start, at))
      start = at + 1
    }
  }
  parts.push(body.slice(start))
  return parts
}

/** The index of the `}` that closes the `{` at `open`. */
const braceClose = (text: string, open: number): Option.Option<number> => {
  let depth = 0
  for (let at = open; at < text.length; at++) {
    if (text.charAt(at) === "{") depth++
    if (text.charAt(at) === "}") depth--
    if (depth === 0) return Option.some(at)
  }
  return Option.none()
}

/** The words the first brace expansion in `text` makes; none when it has none. */
const firstBraceWords = (text: string): Option.Option<ReadonlyArray<string>> => {
  for (let open = text.indexOf("{"); open !== -1; open = text.indexOf("{", open + 1)) {
    const expanded = Option.flatMap(braceClose(text, open), (close) => {
      const body = text.slice(open + 1, close)
      const parts = braceParts(body)
      const alternatives = Option.orElse(
        Option.liftPredicate(parts, (found) => found.length > 1),
        () => sequenceWords(body),
      )
      return Option.map(alternatives, (words) =>
        words.map((word) => `${text.slice(0, open)}${word}${text.slice(close + 1)}`),
      )
    })
    if (Option.isSome(expanded)) return expanded
  }
  return Option.none()
}

/**
 * The words the shell makes of a brace word, as the command receives them
 * (`f{,.bak}` is `f f.bak`); none when there are more than
 * `MAX_BRACE_WORDS`. The text is read as unquoted, so a quoted brace
 * beside an unquoted one expands too, and makes more words.
 */
const braceWords = (text: string): Option.Option<ReadonlyArray<string>> => {
  let words: ReadonlyArray<string> = [text]
  let expanding = true
  while (expanding) {
    expanding = false
    const next: Array<string> = []
    for (const word of words) {
      const expanded = firstBraceWords(word)
      if (Option.isSome(expanded)) expanding = true
      next.push(...Option.getOrElse(expanded, () => [word]))
      if (next.length > MAX_BRACE_WORDS) return Option.none()
    }
    words = next
  }
  // An unquoted word that expands to nothing is no word.
  return Option.some(words.filter((word) => word.length > 0))
}

/**
 * The command path as the command receives its words: each brace word
 * after the path's last word is the words it makes, each as dynamic as the
 * brace word.
 */
const receivedCommand = (resolved: ResolvedCommand): ResolvedCommand => {
  const args = resolved.words.slice(1)
  if (!args.some((word) => word.braces)) return resolved
  const received = args.flatMap((word): ReadonlyArray<ShellWord> => {
    if (!word.braces) return [word]
    return Option.match(braceWords(word.text), {
      onNone: () => [word],
      onSome: (texts) =>
        texts.map((text) => ({
          ...derivedWord(text, word.dynamic),
          splits: word.splits,
          pattern: word.pattern,
        })),
    })
  })
  return { ...resolved, words: [...resolved.words.slice(0, 1), ...received] }
}

/**
 * A word before `--` known only at run time, where the command may read it
 * as a flag a risk reads (`-rf`, `--hard`): an unquoted expansion splits
 * (`rm $F`), `"$@"` passes on the words of a function's caller or of `set
 * --`, and a quoted `"$F"` stays one word that may still be `-rf`. A brace
 * expansion that starts the word (`rm {-rf,x}`) or follows a `-` (`git
 * reset --{hard,}`) also makes the words at run time, as does one that makes
 * too many words to read; after other text (`cp f{,.bak}`) each word starts
 * with that text and is no flag, and the risks read the words it makes
 * (`receivedTexts`). A glob matches only names of files (`rm *.log`). Only
 * the value of an option the
 * table names (`cp -t "$d"`, `psql -d "$DB"`) is no flag, and only when it
 * does not split. A path that runs a command (`sudo`) reads only the words
 * before the first start of that command: the words from it on are the
 * command's, read where it is classified (`sudo ls "$D"` is safe, `sudo
 * "$CMD"` asks for its computed command word).
 */
const runTimeOptions = (
  resolved: ResolvedCommand,
  { texts, parsed }: Pick<CommandArgs, "texts" | "parsed">,
): Option.Option<BashRisk> => {
  const args = resolved.words.slice(1)
  let end = args.findIndex((word) => word.text === "--")
  if (end === -1) end = args.length
  for (const run of resolved.spec.runs) {
    if (run._tag !== "Command") continue
    // `args[index]` is `resolved.words[index + 1]`.
    const starts = commandStarts(resolved.words, resolved.spec.valued, run)
    end = Math.min(end, ...starts.map((start) => start - 1))
  }
  const values = new Set(
    parsed.options.flatMap((option) =>
      Option.toArray(option.value).flatMap((value) => {
        // `-t"$d"`: the option letters before the value must be written out.
        if (DYNAMIC_TEXT.test((texts[value.word] ?? "").slice(0, value.from))) return []
        return [value.word]
      }),
    ),
  )
  return Option.map(
    Arr.findFirst(
      args.slice(0, end),
      (word, index) =>
        word.splits ||
        EXPANDS_TO_WORDS.test(word.text) ||
        (word.braces && (/^[-{]/.test(word.text) || Option.isNone(braceWords(word.text)))) ||
        (word.dynamic && !values.has(index)),
    ),
    (word): BashRisk => ({
      level: "destructive",
      reason: `${resolved.path} with options known only at run time: ${word.text}`,
    }),
  )
}

const invocationRisks = (invocation: Invocation): Array<BashRisk> =>
  resolveReadings(invocation.words).flatMap((resolved) => {
    if (resolved.spec.risks.length === 0) return []
    const argsOf = (command: ResolvedCommand): CommandArgs => {
      const texts = command.words.slice(1).map((word) => word.text)
      return {
        texts,
        parsed: parseArguments(texts, command.spec.valued),
        resolved: command,
        invocation,
      }
    }
    const written = argsOf(resolved)
    const received = receivedCommand(resolved)
    let args = written
    if (received !== resolved) args = argsOf(received)
    return [
      ...resolved.spec.risks.flatMap((risk) => Option.toArray(risk(args))),
      ...Option.toArray(runTimeOptions(resolved, written)),
    ]
  })

const RISK_RANK = {
  safe: 0,
  sensitive: 1,
  external: 2,
  destructive: 3,
} satisfies Record<BashRiskLevel, number>

/** The risks of the commands of `view`, of the files they write, and of what could not be read. */
const viewRisks = (view: CommandView): ReadonlyArray<BashRisk> => [
  ...view.invocations.flatMap(invocationRisks),
  ...view.writes.flatMap((word) => Option.toArray(sensitiveFile(word.text))),
  ...view.unreadable.map((reason): BashRisk => ({
    level: "destructive",
    reason: `runs a script the guard cannot read: ${reason}`,
  })),
]

/**
 * The strongest risk of every command in `command` and in every script it
 * runs (`bash -c '...'`, `eval "..."`, `$(...)`, a heredoc fed to a shell, a
 * git alias, a shell alias where it is used), and of every file it
 * redirects into. A script the guard cannot read asks, as a destructive
 * command does.
 */
export function classifyBashCommand(command: string): BashRisk {
  const direct = viewCommand(parseCommand(command), MAX_NESTED_COMMAND_DEPTH)
  const risks: Array<BashRisk> = [
    ...viewRisks(direct),
    // The reason names the alias; `"$@"` stands for the words after its name.
    ...aliasUseViews(direct).flatMap(({ name, view }) =>
      viewRisks(view).map((risk) => ({
        ...risk,
        reason: `alias ${name}: ${risk.reason.replaceAll("$@", `the words after ${name}`)}`,
      })),
    ),
  ]
  let strongest = SAFE_RISK
  for (const risk of risks) {
    if (RISK_RANK[risk.level] > RISK_RANK[strongest.level]) strongest = risk
  }
  return strongest
}

/**
 * One durable approval per flagged command: `subject` names it in the
 * question, `question` asks. Returns the block message when the approval is
 * declined; a decline in a session no user sees says who can answer instead.
 */
export const approveBashCommand = Effect.fn("approveBashCommand")(function* (
  command: string,
  subject: string,
  question: string,
) {
  const risk = classifyBashCommand(command)
  if (risk.level === "safe") return Option.none<string>()
  const ctx = yield* ExtensionContext
  const decision = yield* ctx.Interaction.approve({
    text: `${subject} is classified as ${risk.level}: ${risk.reason}\n\n\`${command}\`\n\n${question}`,
    // A key a client extension can pick a renderer by; the shipped TUI has none.
    metadata: { type: "bash-guardrail" },
  })
  if (decision.approved) return Option.none<string>()
  const notes = Option.match(Option.fromUndefinedOr(decision.notes), {
    onNone: () => "",
    onSome: (note) => `. ${note}`,
  })
  return Option.some(`Command blocked: ${risk.reason}${notes}`)
})

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
  /** Absent when the command ran to its end. A blocked or background command has no real exit code yet. */
  status: Schema.optional(Schema.Literals(["blocked", "background"])),
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
  for (const invocation of viewCommand(parseCommand(cmd), maxDepth).invocations) {
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
 * A stored row's message within `maxChars`. A completed row holds the
 * output already cut to the notice bound, its file line included; a longer
 * message (a failure's text) is cut to its head and tail.
 */
const storedJobOutput = (message: string) => (maxChars: number) =>
  headTailChars(message, maxChars).text

// ── job notices ──
//
// A job the server stopped has no output and no end to report. Opening its
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
  const interrupted = jobNotice(yield* storage.interruptedJobs(branch), {
    id: "exec-tools-interrupted",
    intro:
      "# Interrupted background commands\n\nThe previous server stopped before these background commands finished. They are not running; what each printed before the stop is in its output file. Tell the user which commands did not finish; start one again only when the user asks for it.",
    line: (job) =>
      `- \`${noticeCommand(job.command)}\` · call ${job.toolCallId} · output ${jobOutputFile(path, dataDir, { ...branch, toolCallId: job.toolCallId })}`,
    rest: "interrupted commands",
  })
  const finished = yield* storage.undeliveredJobs(branch)
  const undelivered = jobNotice(finished, {
    id: "exec-tools-undelivered",
    intro:
      "# Background commands finished\n\nThese background commands finished while the follow-up queue was full, so no message reported them. Tell the user what they returned.",
    line: (job) => {
      let outcome = "failed"
      if (job.state.status === "completed") outcome = `exit code ${job.state.exitCode ?? 0}`
      const output = storedJobOutput(job.state.message ?? "")(maximumNoticeOutputChars)
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
      output: (maxChars: number) => string = storedJobOutput(state.message ?? ""),
    ) =>
      queueTerminalFollowUp(target, state, output).pipe(
        Effect.flatMap((delivered) =>
          storage.recordDelivery(backgroundJobKeyFields(target), delivered),
        ),
      )

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
    if (output.status === "blocked") return output.stdout
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

    // The command is quoted without its `cd`, so the question names where it runs.
    let subject = "This command"
    if (directory !== ctx.cwd) subject = `This command (in \`${directory}\`)`
    const blocked = yield* approveBashCommand(command, subject, "Allow execution?")
    if (Option.isSome(blocked)) {
      return { stdout: blocked.value, stderr: "", exitCode: 1, status: "blocked" }
    }

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
