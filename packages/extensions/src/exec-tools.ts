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
  type SessionId,
  tool,
  ToolCallId,
} from "@gent/core/extensions/api"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

// Test seam: only tests read these exports. BackgroundBashStorage, its error,
// BackgroundBashSupervisorLive and BackgroundBashLayer let a test inject a
// storage fault. BashParams encodes a model's tool input. splitCdCommand,
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
  /** The branch's jobs that did not finish, oldest first. */
  readonly interruptedJobs: (branch: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<
    ReadonlyArray<{ readonly toolCallId: ToolCallId; readonly command: string }>,
    BackgroundBashStorageError
  >
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
              PRIMARY KEY (session_id, branch_id, tool_call_id)
            )
          `,
          )
          .pipe(Effect.mapError(mapError("Failed to create background bash jobs table")))
        // A table from before `owner_generation` gets the column; its rows keep NULL.
        const columns = yield* sql<{ readonly name: string }>`
          SELECT name FROM pragma_table_info('background_bash_jobs')
        `.pipe(Effect.mapError(mapError("Failed to read background bash jobs columns")))
        if (!columns.some((column) => column.name === "owner_generation")) {
          yield* sql
            .unsafe(`ALTER TABLE background_bash_jobs ADD COLUMN owner_generation TEXT`)
            .pipe(Effect.mapError(mapError("Failed to add background bash jobs owner column")))
        }
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
                ORDER BY started_at, tool_call_id
              `
              return rows.map((row) => ({
                toolCallId: ToolCallId.make(row.tool_call_id),
                command: row.command,
              }))
            },
            Effect.mapError(mapError("Failed to read interrupted background bash jobs")),
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

/** A glob (`*`, `?`, `[…]`) or a brace expansion (`{a,b}`, `{1..3}`) in unquoted text. */
const PATTERN_TEXT = /[*?]|\[[^\]]*\]|\{[^{}]*(,|\.\.)[^{}]*\}/

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
}

const names = (text: string) => text.split(" ").filter((name) => name.length > 0)

/** Options that take a value: the letters, and the long names separated by spaces. */
const options = (short: string, long = ""): ValueOptions => ({ short, long: names(long) })

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

/** Read the long option word at `index`: `--name`, `--name=value`, `--name value`. */
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
  let value = Option.none<OptionValue>()
  let next = index + 1
  if (equals !== -1) {
    value = Option.some({ word: index, from: equals + 1 })
  } else if ((valued.long ?? []).some((option) => abbreviates(name, option))) {
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
  let index = 0
  while (index < args.length) {
    const arg = args[index] ?? ""
    if (arg === "--") {
      return {
        ...into,
        operands,
        pathspecs: args.slice(index + 1),
        end: index + 1,
        separated: true,
      }
    }
    if (isOptionWord(arg, valued)) {
      index = readOption(args, index, valued, into)
    } else if (order === "leading") {
      return { ...into, operands: args.slice(index), pathspecs: [], end: index, separated: false }
    } else {
      operands.push(arg)
      index++
    }
  }
  return { ...into, operands, pathspecs: [], end: args.length, separated: false }
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
 *   command it is a subcommand of (`yarn workspace x npm publish`).
 * - `Joined`: the words after the options and `positionals`, `take` of them,
 *   joined into one script (`eval`, `ssh host cmd`, `trap 'cmd' EXIT`).
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
  },
  Joined: { positionals: Schema.Int, take: Schema.Int },
  OptionScript: { short: Schema.String, long: Schema.Array(Schema.String), rest: Schema.Boolean },
  Stdin: {},
  FindExec: { actions: Schema.Array(Schema.String) },
  InputShell: { short: Schema.String, long: Schema.Array(Schema.String) },
})
type Run = typeof Run.Type
type CommandFields = Partial<Omit<typeof Run.cases.Command.Type, "_tag">>

const command = (fields: CommandFields = {}): Run =>
  Run.cases.Command.make({ positionals: 0, after: [], named: false, head: "", ...fields })

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
  if (!option.long) return !`${valued.short ?? ""}${valued.attached ?? ""}`.includes(option.name)
  if ((valued.long ?? []).includes(option.name)) return false
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

/**
 * The readings of the command path under `resolved`. The first takes every
 * option the parent's table does not name to have no value, and stops at
 * the parent when the next word names no path. Each later word that may be
 * the subcommand (`laterCommandWords`) and names a path is a reading too
 * (`npm --loglevel silent exec -- cmd`). An unnamed option alone adds none:
 * `git --no-pager status` has one reading.
 */
const readingsUnder = (resolved: ResolvedCommand): Arr.NonEmptyReadonlyArray<ResolvedCommand> => {
  if (!SPEC_PARENTS.has(resolved.path)) return [resolved]
  const rest = resolved.words
  let from = 0
  if (resolved.spec.toolchain === true && rest[1]?.text.startsWith("+") === true) from = 1
  const args = rest.slice(1).map((word) => word.text)
  const { valued } = resolved.spec
  // `args[index]` is `rest[index + 1]`.
  const first = from + parseArguments(args.slice(from), valued, "leading").end
  const others = laterCommandWords(args, valued, from)
    .filter((index) => index !== first)
    .flatMap((index) =>
      Option.match(childCommand(resolved, index + 1), {
        onNone: () => [],
        onSome: readingsUnder,
      }),
    )
  const head = Option.match(childCommand(resolved, first + 1), {
    onNone: (): Arr.NonEmptyReadonlyArray<ResolvedCommand> => [resolved],
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
  const {
    words,
    spec: { valued },
  } = resolved
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
  let starts = commandStarts(words, valued, run)
  if (readings === "first") starts = starts.slice(0, 1)
  return starts.map((start) => {
    const rest = words.slice(start)
    if (run.head === "") return rest
    return [derivedWord(run.head, false), ...rest]
  })
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

/** What a `Joined`, `OptionScript`, `Stdin` or `InputShell` run runs beyond the commands it starts. */
const specRuns = (invocation: Invocation, resolved: ResolvedCommand, run: Run): SegmentRuns => {
  const { path, words, spec } = resolved
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

/** `eval`, `ssh host`, `watch` and `env -S` run `script` joined; an expanded word is known only at run time. */
const joinedRuns = (name: string, script: ReadonlyArray<ShellWord>): SegmentRuns => {
  const joined = joinWords(script)
  const unreadable = Option.toArray(joined)
    .filter((word) => word.dynamic)
    .map((word) => `${name} of text expanded at run time: ${word.text}`)
  return { scripts: Option.toArray(joined), unreadable }
}

/**
 * How `xargs` or `parallel` divides its input into arguments: xargs at
 * blanks and newlines, with quotes and backslash escapes; xargs `-I` at
 * newlines only, with the same quoting and leading blanks dropped; or at a
 * delimiter with no quoting (`-0`, `-d`, and every parallel line).
 */
const InputDivision = Schema.TaggedUnion({
  Blanks: {},
  Lines: {},
  Delimiter: { text: Schema.String },
})
type InputDivision = typeof InputDivision.Type

/**
 * How many input arguments (`-n N`, parallel `-N N`) or lines (`-L N`, `-I`)
 * one command takes, or all of the input in one command.
 */
const InputBatch = Schema.TaggedUnion({
  Args: { size: Schema.Int },
  Lines: { size: Schema.Int },
  All: {},
})
type InputBatch = typeof InputBatch.Type

/** How `xargs` or `parallel` builds its commands from its input. */
interface InputUse {
  /** The text in its command that stands for the input: `{}`, or the `-I`/`-J` value. */
  readonly placeholder: Option.Option<string>
  /**
   * Matches a command word that holds the input: the placeholder, and for
   * parallel every replacement string (`{1}`, `{.}`, `{/}`).
   */
  readonly marker: Option.Option<RegExp>
  /**
   * `within`: the placeholder takes one input line inside any word and the
   * input is never appended (`xargs -I`); `word`: the first word that is the
   * placeholder takes every argument, else they are appended (BSD
   * `xargs -J`); `insert`: the placeholder takes the arguments, or they are
   * appended.
   */
  readonly replace: "within" | "word" | "insert"
  /** None: a count the guard does not read (`-n "$N"`, `-I` with `-n`). */
  readonly batch: Option.Option<InputBatch>
  /** None: a delimiter the guard does not read. */
  readonly division: Option.Option<InputDivision>
  /** parallel runs its command words as one shell script; xargs runs them as they are. */
  readonly shell: boolean
  /** `-a`/`--arg-file`: the files it reads its input from in place of its stdin. */
  readonly argFiles: ReadonlyArray<string>
  /** parallel `-m`, `-X`, `--xargs`: the input is divided among the job slots. */
  readonly spread: boolean
  /** parallel options that make replacement strings the guard does not rebuild (`--plus`, `--er`). */
  readonly otherReplacements: boolean
}

/** A `-d` value as a character: a literal one, or `\n`, `\t`, `\0`. */
const DELIMITER_ESCAPES = new Map([
  ["\\n", "\n"],
  ["\\t", "\t"],
  ["\\0", "\0"],
])

const delimiterDivision = (value: string): Option.Option<InputDivision> => {
  let text = Option.fromUndefinedOr(DELIMITER_ESCAPES.get(value))
  if (value.length === 1) text = Option.some(value)
  return Option.map(text, (delimiter) => InputDivision.cases.Delimiter.make({ text: delimiter }))
}

/** `-0`/`--null`, or the last `-d`/`--delimiter`: the delimiter that divides the input. */
const givenDelimiter = (
  parsed: ParsedArguments,
  texts: ReadonlyArray<string>,
): Option.Option<Option.Option<InputDivision>> => {
  let division = Option.none<Option.Option<InputDivision>>()
  for (const option of parsed.options) {
    if (isNamed(option, "0", ["null"])) {
      division = Option.some(Option.some(InputDivision.cases.Delimiter.make({ text: "\0" })))
    } else if (isNamed(option, "d", ["delimiter"])) {
      const value = Option.map(option.value, (at) => valueText(texts, at))
      division = Option.some(Option.flatMap(value, delimiterDivision))
    }
  }
  return division
}

/** A count option's value: a whole number above zero. */
const batchSize = (text: string): Option.Option<number> => {
  if (!/^[1-9]\d{0,5}$/.test(text)) return Option.none()
  return Option.some(Number(text))
}

/** `text` as a pattern that matches only itself. */
const literalPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/**
 * parallel's replacement strings: `{}` (or the `-I` value), `{.}` without
 * the extension, `{/}` the base name, `{//}` the directory, `{/.}` both,
 * `{#}` the job number, `{%}` the slot, each with an argument number before
 * the modifier (`{1}`, `{2.}`, `{-1}`), and `{= perl =}`, which the guard
 * does not rebuild.
 */
const PARALLEL_REPLACEMENT = "\\{(-?\\d+)?(//|/\\.|/|\\.|#|%)?\\}|\\{-?\\d*="

/** parallel options that add replacement strings: their text is not rebuilt. */
const PARALLEL_REPLACE_OPTIONS = [
  ...["extensionreplace", "er", "basenamereplace", "bnr", "dirnamereplace", "dnr"],
  ...["basenameextensionreplace", "bner", "seqreplace", "slotreplace", "rpl"],
]

const replacementPattern = (replace: string) =>
  new RegExp(`${literalPattern(replace)}|${PARALLEL_REPLACEMENT}`, "g")

/**
 * The input use of `parallel`: one command per line, or per `-N`/`-n`/`-L`
 * lines; `{}` (or its `-I` value) and the other replacement strings take the
 * input, else it is appended.
 */
const parallelInputUse = (
  parsed: ParsedArguments,
  texts: ReadonlyArray<string>,
  argFiles: ReadonlyArray<string>,
): InputUse => {
  const replace = Option.getOrElse(
    Option.map(Arr.last(optionValues(parsed, "I")), (at) => valueText(texts, at)),
    () => "{}",
  )
  let batch = Option.some<InputBatch>(InputBatch.cases.Args.make({ size: 1 }))
  for (const option of parsed.options) {
    const size = Option.flatMap(
      Option.map(option.value, (at) => valueText(texts, at)),
      batchSize,
    )
    if (isNamed(option, "nN", ["max-args", "max-replace-args"])) {
      batch = Option.map(size, (value) => InputBatch.cases.Args.make({ size: value }))
    } else if (isNamed(option, "L", ["max-lines"])) {
      batch = Option.map(size, (value) => InputBatch.cases.Lines.make({ size: value }))
    }
  }
  // `--colsep` divides a line into arguments at a pattern.
  let division = Option.getOrElse(givenDelimiter(parsed, texts), () =>
    Option.some(InputDivision.cases.Delimiter.make({ text: "\n" })),
  )
  if (hasShort(parsed, "C") || hasLong(parsed, "colsep")) division = Option.none()
  return {
    placeholder: Option.some(replace),
    marker: Option.some(new RegExp(replacementPattern(replace).source)),
    replace: "insert",
    batch,
    division,
    shell: true,
    argFiles,
    spread: hasShort(parsed, "m", "X") || hasLong(parsed, "xargs"),
    otherReplacements: hasLong(parsed, "plus", ...PARALLEL_REPLACE_OPTIONS),
  }
}

/**
 * The input use of an `xargs` or `parallel` invocation. For xargs, `-I R`,
 * `--replace[=R]` and `-i[R]` (R is `{}` when not given) replace R in each
 * line; BSD `-J R` replaces the first word R with all of the input. `-n N`
 * runs one command per N arguments, `-L N` and `-l` one per N lines; the
 * last of them counts. GNU and BSD xargs differ on `-I` with `-n` or `-L`,
 * so that count is not read.
 */
const inputUse = ({ path, words, spec }: ResolvedCommand): InputUse => {
  const texts = words.slice(1).map((word) => word.text)
  const parsed = parseArguments(texts, spec.valued, "leading")
  const value = (option: ParsedOption) => Option.map(option.value, (at) => valueText(texts, at))
  const argFiles = optionValues(parsed, "a", ["arg-file"]).map((at) => valueText(texts, at))
  if (path === "parallel") return parallelInputUse(parsed, texts, argFiles)
  let use: InputUse = {
    placeholder: Option.none(),
    marker: Option.none(),
    replace: "insert",
    batch: Option.some(InputBatch.cases.All.make({})),
    division: Option.some(InputDivision.cases.Blanks.make({})),
    shell: false,
    argFiles,
    spread: false,
    otherReplacements: false,
  }
  let replaced = false
  let counted = false
  for (const option of parsed.options) {
    const given = value(option)
    if (isNamed(option, "Ii", ["replace"])) {
      const placeholder = Option.orElse(given, () => Option.some("{}"))
      const division = Option.some(InputDivision.cases.Lines.make({}))
      const batch = Option.some(InputBatch.cases.Lines.make({ size: 1 }))
      replaced = true
      use = {
        ...use,
        placeholder,
        marker: Option.map(placeholder, (text) => new RegExp(literalPattern(text))),
        replace: "within",
        batch,
        division,
      }
    } else if (isNamed(option, "J")) {
      use = {
        ...use,
        placeholder: given,
        marker: Option.map(given, (text) => new RegExp(`^${literalPattern(text)}$`)),
        replace: "word",
      }
    } else if (isNamed(option, "n", ["max-args"])) {
      counted = true
      use = {
        ...use,
        batch: Option.map(Option.flatMap(given, batchSize), (size) =>
          InputBatch.cases.Args.make({ size }),
        ),
      }
    } else if (isNamed(option, "Ll", ["max-lines"])) {
      // `-l` and `--max-lines` with no value mean one line.
      counted = true
      use = {
        ...use,
        batch: Option.map(batchSize(Option.getOrElse(given, () => "1")), (size) =>
          InputBatch.cases.Lines.make({ size }),
        ),
      }
    }
  }
  if (replaced && counted) use = { ...use, batch: Option.none() }
  return { ...use, division: Option.getOrElse(givenDelimiter(parsed, texts), () => use.division) }
}

/** One input line: its arguments, and whether it ends in a blank. */
interface InputLine {
  readonly args: ReadonlyArray<string>
  /** `-L` reads a line that ends in a blank as going on into the next one. */
  readonly continued: boolean
}

/** The state of the xargs quoting reader. */
interface QuoteReader {
  readonly lines: Array<InputLine>
  line: Array<string>
  arg: string
  inArg: boolean
  quote: string
  escaped: boolean
  /** The character read before the current one. */
  previous: string
}

const endArg = (reader: QuoteReader) => {
  if (reader.inArg) reader.line.push(reader.arg)
  reader.arg = ""
  reader.inArg = false
}

const isBlank = (char: string) => char === " " || char === "\t"

/** Read one character outside quotes and escapes; blanks end an argument only with `blanks`. */
const readUnquoted = (reader: QuoteReader, char: string, blanks: boolean) => {
  if (char === "\\") {
    reader.escaped = true
  } else if (char === "'" || char === '"') {
    reader.quote = char
    reader.inArg = true
  } else if (char === "\n") {
    endArg(reader)
    reader.lines.push({ args: reader.line, continued: isBlank(reader.previous) })
    reader.line = []
  } else if (isBlank(char) && (blanks || !reader.inArg)) {
    endArg(reader)
  } else {
    reader.arg += char
    reader.inArg = true
  }
}

/**
 * The arguments of each input line as xargs reads them: quotes and backslash
 * escapes, blanks between arguments (or, without `blanks`, inside the one
 * argument of a line, whose leading blanks are dropped). Blank lines are
 * dropped. None when a quote is open at a newline or at the end, as xargs
 * then fails.
 */
const quotedLines = (text: string, blanks: boolean): Option.Option<ReadonlyArray<InputLine>> => {
  const reader: QuoteReader = {
    lines: [],
    line: [],
    arg: "",
    inArg: false,
    quote: "",
    escaped: false,
    previous: "",
  }
  for (const char of text) {
    if (reader.escaped) {
      reader.arg += char
      reader.inArg = true
      reader.escaped = false
    } else if (reader.quote === "") {
      readUnquoted(reader, char, blanks)
    } else if (char === reader.quote) {
      reader.quote = ""
    } else if (char === "\n") {
      return Option.none()
    } else {
      reader.arg += char
    }
    reader.previous = char
  }
  if (reader.quote !== "" || reader.escaped) return Option.none()
  endArg(reader)
  reader.lines.push({ args: reader.line, continued: false })
  return Option.some(reader.lines.filter((line) => line.args.length > 0))
}

/** The arguments of each input line: one per line for a delimiter, whose final empty item ends the input. */
const dividedLines = (
  text: string,
  division: InputDivision,
): Option.Option<ReadonlyArray<InputLine>> => {
  if (division._tag === "Blanks") return quotedLines(text, true)
  if (division._tag === "Lines") return quotedLines(text, false)
  const items = text.split(division.text)
  if (items.at(-1) === "") items.pop()
  return Option.some(items.map((item) => ({ args: [item], continued: /[ \t]$/.test(item) })))
}

/**
 * The lines `-L` counts: with blank division, a line that ends in a blank
 * and the next one are one line. Other divisions: none when such a line is
 * not the last, as the implementations differ there.
 */
const logicalLines = (
  lines: ReadonlyArray<InputLine>,
  division: InputDivision,
): Option.Option<ReadonlyArray<ReadonlyArray<string>>> => {
  if (division._tag !== "Blanks") {
    if (lines.slice(0, -1).some((line) => line.continued)) return Option.none()
    return Option.some(lines.map((line) => line.args))
  }
  const merged: Array<Array<string>> = []
  let open = false
  for (const line of lines) {
    const last = Arr.last(merged)
    if (open && Option.isSome(last)) last.value.push(...line.args)
    else merged.push([...line.args])
    open = line.continued
  }
  return Option.some(merged)
}

/** The argument lists of the commands `batch` builds from the input lines. */
const commandGroups = (
  lines: ReadonlyArray<InputLine>,
  batch: InputBatch,
  division: InputDivision,
): Option.Option<ReadonlyArray<ReadonlyArray<string>>> => {
  const args = lines.flatMap((line) => line.args)
  if (batch._tag === "All") return Option.some([args])
  if (batch._tag === "Args") return Option.some(Arr.chunksOf(args, batch.size))
  return Option.map(logicalLines(lines, division), (logical) =>
    Arr.chunksOf(logical, batch.size).map((chunk) => chunk.flat()),
  )
}

/** `text` as one single-quoted shell word. */
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * The script of one command xargs builds from `args`. xargs runs its words
 * as they are, so each word is quoted.
 */
const xargsCommand = (
  commandTexts: ReadonlyArray<string>,
  use: InputUse,
  args: ReadonlyArray<string>,
): string => {
  const placeholder = Option.getOrElse(use.placeholder, () => "")
  if (use.replace === "within") {
    const line = args.join(" ")
    const replaced = (text: string) => {
      if (placeholder === "") return text
      return text.replaceAll(placeholder, line)
    }
    return commandTexts.map((text) => shellQuote(replaced(text))).join(" ")
  }
  const quoted = commandTexts.map(shellQuote)
  let at = -1
  if (use.replace === "word") at = commandTexts.indexOf(placeholder)
  if (at === -1) return [...quoted, ...args.map(shellQuote)].join(" ")
  return [...quoted.slice(0, at), ...args.map(shellQuote), ...quoted.slice(at + 1)].join(" ")
}

/** An argument as a parallel replacement modifier shows it. */
const modifiedArgument = (arg: string, modifier: string) => {
  const slash = arg.lastIndexOf("/")
  const base = arg.slice(slash + 1)
  const noExtension = (text: string) => text.replace(/\.[^./]*$/, "")
  if (modifier === ".") return arg.slice(0, slash + 1) + noExtension(base)
  if (modifier === "/") return base
  if (modifier === "/.") return noExtension(base)
  if (modifier !== "//") return arg
  if (slash === -1) return "."
  return arg.slice(0, slash)
}

/** Job argument `number` (from 1; negative counts from the end), or empty when the job has fewer. */
const numberedArgument = (args: ReadonlyArray<string>, number: number): string => {
  let index = args.length + number
  if (number > 0) index = number - 1
  return Option.getOrElse(Arr.get(args, index), () => "")
}

/**
 * The script of one parallel job: every replacement string takes the job's
 * arguments, quoted (not when the arguments are the command); with none, the
 * arguments are appended. None for a perl expression.
 */
const parallelScript = (
  commandTexts: ReadonlyArray<string>,
  replace: string,
  args: ReadonlyArray<string>,
  quote: boolean,
): Option.Option<string> => {
  const script = commandTexts.join(" ")
  const shown = (text: string) => {
    if (quote) return shellQuote(text)
    return text
  }
  let built = ""
  let last = 0
  let found = false
  for (const match of script.matchAll(replacementPattern(replace))) {
    const text = match[0]
    const modifier = Option.getOrElse(Option.fromUndefinedOr(match[2]), () => "")
    if (text.endsWith("=")) return Option.none()
    if (text === "{}" && replace !== "{}") continue
    found = true
    let value = "1"
    if (modifier !== "#" && modifier !== "%") {
      const values = Option.match(Option.fromUndefinedOr(match[1]), {
        onNone: () => args,
        onSome: (number) => [numberedArgument(args, Number(number))],
      })
      value = values.map((arg) => shown(modifiedArgument(arg, modifier))).join(" ")
    }
    built += script.slice(last, match.index) + value
    last = match.index + text.length
  }
  if (found) return Option.some(built + script.slice(last))
  return Option.some([script, ...args.map(shown)].filter((text) => text.length > 0).join(" "))
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

/** Past this many jobs, the product of parallel's sources is not rebuilt. */
const MAX_PARALLEL_JOBS = 1024

/**
 * The arguments of each job of parallel's `:::` sources: every combination,
 * the first source varying slowest; a `:::+` source is linked to the one
 * before it, the shorter one wrapping.
 */
const sourceJobs = (
  sources: ReadonlyArray<ParallelSource>,
): Option.Option<ReadonlyArray<ReadonlyArray<string>>> => {
  const groups: Array<Array<ReadonlyArray<string>>> = []
  for (const source of sources) {
    const items = source.words.map((word) => word.text)
    const group = Arr.last(groups)
    if (source.marker.endsWith("+") && Option.isSome(group)) group.value.push(items)
    else groups.push([items])
  }
  let jobs: ReadonlyArray<ReadonlyArray<string>> = [[]]
  for (const group of groups) {
    const size = Math.max(...group.map((items) => items.length))
    const rows = Array.from({ length: size }, (_, index) =>
      group.map((items) => items[index % items.length] ?? ""),
    )
    jobs = jobs.flatMap((job) => rows.map((row) => [...job, ...row]))
    if (jobs.length > MAX_PARALLEL_JOBS) return Option.none()
  }
  return Option.some(jobs)
}

/**
 * The arguments of each parallel job: one per `:::` combination, or per
 * input line; `-N`/`-n`/`-L` group them from one source. None when the
 * groups are not known: several sources with a count, or `-m`/`-X` with
 * more than one argument.
 */
const parallelGroups = (
  text: string,
  use: InputUse,
  sources: ReadonlyArray<ParallelSource>,
): Option.Option<ReadonlyArray<ReadonlyArray<string>>> => {
  if (sources.some(isFileSource) || use.otherReplacements) return Option.none()
  if (sources.length > 0 && use.argFiles.length > 0) return Option.none()
  let lines: Option.Option<ReadonlyArray<InputLine>>
  if (sources.length > 0) {
    lines = Option.map(sourceJobs(sources), (jobs) =>
      jobs.map((args) => ({ args, continued: false })),
    )
  } else {
    lines = Option.flatMap(use.division, (division) => dividedLines(text, division))
  }
  return Option.flatMap(
    Option.all([lines, use.batch, use.division]),
    ([found, batch, division]) => {
      const args = found.flatMap((line) => line.args)
      if (use.spread && args.length > 1) return Option.none()
      if (use.spread) return Option.some([args])
      if (batch._tag !== "All" && batch.size === 1)
        return Option.some(found.map((line) => line.args))
      if (sources.length > 1) return Option.none()
      return commandGroups(found, batch, division)
    },
  )
}

/**
 * `xargs` and `parallel` run their command with the input appended, or put
 * into the placeholder; `parallel ::: a b` also runs each word after `:::`
 * when it has no command, and `parallel` with no command runs each input
 * line. Bare `xargs` runs `echo`. When the input can be read, it is divided
 * into arguments and grouped into commands as the wrapper does it, and each
 * command it builds is classified whole, so a runner (`xargs env`) or a
 * subcommand in the input (`xargs git`) is read as it would run. Input the
 * guard cannot divide or group asks. When the input cannot be read, the
 * wrapper asks only if the input names what runs or may be its flags (see
 * `inputNamesCommand`); anything else stays quiet (`find … | xargs rm --`,
 * `find … | xargs wc -l`). A shell under the wrapper
 * reads its input through `shellRuns`. Each reading of the wrapper's
 * options (`wrapperStarts`) is read.
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
  const inputs = segmentInputs(wrapperSegment(segment, use, sources))
  const commandTexts = command.map((word) => word.text)
  const isMarked = (text: string) => Option.exists(use.marker, (marker) => marker.test(text))
  const placeholder = Option.getOrElse(use.placeholder, () => "")
  if (command.length === 0 && name === "xargs") return NO_RUNS
  const holdsInput = (text: string) => {
    if (use.shell) return isMarked(text)
    return text === placeholder
  }
  // The input is the command: `parallel`, `xargs -I{} {}`.
  const inputIsCommand = command.length === 0 || commandTexts.every(holdsInput)
  if (inputIsCommand && !use.shell) return inputs
  if (inputs.scripts.length === 0 || inputs.unreadable.length > 0) {
    let appends = !commandTexts.some(isMarked)
    if (use.replace === "within") appends = false
    if (!inputNamesCommand(command, isMarked, appends)) return NO_RUNS
    if (inputs.unreadable.length > 0) return { scripts: [], unreadable: inputs.unreadable }
    return unreadableRun(`the input of \`${name}\``)
  }
  const text = inputs.scripts.map((word) => word.text).join("\n")
  let groups: Option.Option<ReadonlyArray<ReadonlyArray<string>>>
  if (use.shell) {
    groups = parallelGroups(text, use, sources)
  } else {
    groups = Option.flatMap(Option.all([use.division, use.batch]), ([division, batch]) =>
      Option.flatMap(dividedLines(text, division), (lines) =>
        commandGroups(lines, batch, division),
      ),
    )
  }
  const built = Option.flatMap(groups, (found) =>
    Option.all(
      found.map((args) => {
        if (use.shell) return parallelScript(commandTexts, placeholder, args, !inputIsCommand)
        return Option.some(xargsCommand(commandTexts, use, args))
      }),
    ),
  )
  if (Option.isNone(built)) {
    return unreadableRun(`\`${name}\` input the guard cannot rebuild into commands`)
  }
  const dynamic = inputs.scripts.some((word) => word.dynamic)
  return scriptRuns(built.value.map((script) => derivedWord(script, dynamic)))
}

/**
 * Whether the input fills the script a `Joined`, `OptionScript` or
 * `InputShell` run runs: its script is missing or holds the placeholder, or
 * the appended input joins it (`ssh host ls`, `env -S`), or it starts a
 * shell whose options the appended input gives (`su`). A `FindExec` run
 * takes its actions from the appended input.
 */
const inputFillsScript = (
  resolved: ResolvedCommand,
  run: Run,
  isMarked: (text: string) => boolean,
  appends: boolean,
): boolean => {
  const { words, spec } = resolved
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
 * Whether input that cannot be read names what `command` runs under `xargs`
 * or `parallel`: follow its runners (`env A=b`, `sudo`, `timeout 5`) to the
 * innermost command, whose word is missing or is the placeholder, or whose
 * script the input fills, or which is git with a risky subcommand, or with
 * its subcommand missing or the placeholder, or which has risks and takes
 * the input before `--`, where it may be a flag (`xargs rm` given `-rf x`).
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
  const risky = readings.some((resolved) => resolved.spec.risks.length > 0)
  if (commandName(head.value.text) !== "git") {
    return risky && inputBeforeSeparator(words, isMarked, appends)
  }
  if (risky) return true
  const subcommand = Option.fromUndefinedOr(words[commandStart(words, GIT_GLOBAL_OPTIONS, {})])
  return Option.match(subcommand, {
    onNone: () => true,
    onSome: (word) => isMarked(word.text),
  })
}

/** Environment variables whose value a command runs as a shell command. */
const SHELL_VARIABLES = new Set([
  ...["GIT_SSH_COMMAND", "GIT_SSH", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER"],
  ...["GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "GIT_PROXY_COMMAND", "SSH_ASKPASS"],
  ...["EDITOR", "VISUAL", "PAGER"],
])

/** Builtins whose `NAME=value` arguments set variables. */
const DECLARATION_COMMANDS = new Set(["export", "declare", "typeset", "local", "readonly"])

/**
 * `GIT_SSH_COMMAND=… git fetch`, `export EDITOR=…`: a value a later command
 * runs as a script. Git also reads config from `GIT_CONFIG_KEY_<n>` and
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
  if (subcommand.value.dynamic) {
    runs.push(unreadableRun(`a git subcommand known only at run time: ${subcommand.value.text}`))
  }
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

/**
 * `alias w='rm -rf x'`: the value of each `name=value` runs where the name
 * is a command word, once the shell expands aliases (`shopt -s
 * expand_aliases`). As with a git alias, it is read where it is defined.
 */
const shellAliasRuns = ({ words }: Invocation): SegmentRuns =>
  scriptRuns(
    words.slice(1).flatMap((word) => {
      const equals = word.text.indexOf("=")
      if (equals <= 0 || word.text.startsWith("-")) return []
      return [wordFrom(word, equals + 1)]
    }),
  )

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
 * The first statement of `text` that does not start as a read, by the word
 * that shows it. The text is split at `;` and new lines, and no quote is
 * read: a `;` in a string only makes more statements. A client command
 * (`\d`, `.tables`) is judged by the client's own list. `name=value` (a
 * psql variable) is its value, and one plain word there is data.
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
    if (!SQL_READ_STARTS.has(start)) return Option.some(start)
    return Option.map(Option.fromNullishOr(SQL_OVERWRITES.exec(statement)), ([word]) => word)
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
    return Option.flatMap(Arr.findFirst(commandTexts, sqlWrite), (word) =>
      destructive(`SQL that writes: ${word.toUpperCase()}`),
    )
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

const PUBLISH = risky(external("publishes a package"))

/** `gh` groups whose `delete` removes something on the remote. */
const GH_DELETES = [
  ...["repo", "release", "gist", "issue", "label", "secret", "variable", "run", "cache"],
  ...["ssh-key", "gpg-key", "codespace", "project"],
]
const GH_REPO_OPTIONS = options("R", "repo")
const PUBLISH_OPTIONS = "tag access registry otp"

/** `git commit` options whose value is the next word. */
const COMMIT_OPTIONS = options(
  "mFCct",
  "message file reuse-message reedit-message template author date cleanup fixup squash trailer pathspec-from-file",
)

const FILTER_BRANCH_SCRIPTS =
  "setup env-filter tree-filter index-filter parent-filter msg-filter commit-filter tag-name-filter"

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
      ),
      [command(), inputShell("si", ["shell", "login"])],
      rootRmRisk,
    ),
    doas: spec(options("uC"), [command(), inputShell("s")], rootRmRisk),
    // `-S` splits its value into the command it runs.
    env: spec(options("aCLPSUu", "argv0 unset chdir split-string"), [
      command(),
      optionScript("S", ["split-string"], true),
    ]),
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
      runner(options("sk", "signal kill-after"), { positionals: 1 }),
    ),
    stdbuf: runner(options("ioe", "input output error")),
    caffeinate: runner(options("tw")),
    flock: spec(options("cEw", "command timeout conflict-exit-code"), [
      command({ positionals: 1 }),
      optionScript("c", ["command"]),
    ]),
    strace: runner(options("abeEIoOpPsSuX", "output attach user env")),
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
      ),
      [Run.cases.Stdin.make({})],
    ),
    find: spec(
      {},
      [Run.cases.FindExec.make({ actions: ["-exec", "-execdir", "-ok", "-okdir"] })],
      ({ texts }) => destructiveWhen(texts.includes("-delete"), "find -delete"),
    ),
    fd: spec({}, [Run.cases.FindExec.make({ actions: ["-x", "-X", "--exec", "--exec-batch"] })]),
    eval: spec({}, [joined()]),
    ssh: spec(options("bcDEeFIiJLlmOopQRSWwB"), [joined(1)]),
    watch: spec(options("n", "interval"), [joined()]),
    // `trap '<script>' SIGNAL`: the script runs when the signal (or `EXIT`) comes.
    trap: spec({}, [joined(0, 1)]),
    // Package managers and runners.
    pnpm: spec(options("CF", `filter dir ${PUBLISH_OPTIONS}`)),
    npm: spec(options("w", `workspace prefix userconfig cache ${PUBLISH_OPTIONS}`)),
    yarn: spec(options("", `cwd ${PUBLISH_OPTIONS}`)),
    bun: spec(options("F", `cwd filter config ${PUBLISH_OPTIONS}`)),
    cargo: {
      ...spec(options("pZ", "package manifest-path registry token config index color")),
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
      spec(options("pcw", "package call workspace"), [command(), optionScript("c", ["call"])]),
    ),
    ...each(["bunx", "bun x"], runner(options("p", "package"))),
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
    docker: spec(options("Hcl", "host context config log-level tlscacert tlscert tlskey")),
    ...each(["docker push", "docker image push"], risky(external("docker push"))),
    ...each(
      ["docker volume rm", "docker volume remove", "docker volume prune", "docker system prune"],
      risky(({ resolved }) => destructive(`${resolved.path} (deletes volumes or containers)`)),
    ),
    uv: spec(options("", "directory project")),
    "uv run": runner(options("", "with python package env-file extra group")),
    "op run": runner(options("", "env-file")),
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

/** `"$@"`, `$*`, `"${a[@]}"`: the positional parameters or the array elements, each a word of its own. */
const EXPANDS_TO_WORDS = /^\$(?:[@*]|\{[@*]\}|\{\w+\[[@*]\]\})$/

/**
 * A word before `--` known only at run time, where the command may read it
 * as a flag a risk reads (`-rf`, `--hard`): an unquoted expansion splits
 * (`rm $F`), `"$@"` passes on the words of a function's caller or of `set
 * --`, and a quoted `"$F"` stays one word that may still be `-rf`. Only the
 * value of an option the table names (`cp -t "$d"`, `psql -d "$DB"`) is no
 * flag, and only when it does not split.
 */
const runTimeOptions = (
  resolved: ResolvedCommand,
  { texts, parsed }: Pick<CommandArgs, "texts" | "parsed">,
): Option.Option<BashRisk> => {
  const args = resolved.words.slice(1)
  let end = args.findIndex((word) => word.text === "--")
  if (end === -1) end = args.length
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
        word.splits || EXPANDS_TO_WORDS.test(word.text) || (word.dynamic && !values.has(index)),
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
    const texts = resolved.words.slice(1).map((word) => word.text)
    const args: CommandArgs = {
      texts,
      parsed: parseArguments(texts, resolved.spec.valued),
      resolved,
      invocation,
    }
    return [
      ...resolved.spec.risks.flatMap((risk) => Option.toArray(risk(args))),
      ...Option.toArray(runTimeOptions(resolved, args)),
    ]
  })

const RISK_RANK = {
  safe: 0,
  sensitive: 1,
  external: 2,
  destructive: 3,
} satisfies Record<BashRiskLevel, number>

/**
 * The strongest risk of every command in `command` and in every script it
 * runs (`bash -c '...'`, `eval "..."`, `$(...)`, a heredoc fed to a shell, a
 * git alias), and of every file it redirects into. A script the guard cannot
 * read asks, as a destructive command does.
 */
export function classifyBashCommand(command: string): BashRisk {
  const view = viewCommand(parseCommand(command), MAX_NESTED_COMMAND_DEPTH)
  const risks: Array<BashRisk> = [
    ...view.invocations.flatMap(invocationRisks),
    ...view.writes.flatMap((word) => Option.toArray(sensitiveFile(word.text))),
    ...view.unreadable.map((reason): BashRisk => ({
      level: "destructive",
      reason: `runs a script the guard cannot read: ${reason}`,
    })),
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

const queueBackgroundFollowUp = (params: {
  readonly target: BackgroundBashTarget
  readonly sourceId: string
  readonly content: string
}) =>
  Effect.gen(function* () {
    if (!(yield* targetStillExists(params.target))) return
    yield* params.target.Session.send({
      delivery: "queue",
      sourceId: params.sourceId,
      content: params.content,
    }).pipe(Effect.catchEager(() => Effect.void))
  })

/**
 * The completion notice is a user-role message, and core bounds only tool
 * results, so this bounds it here at the same budget. The full output stays in
 * the stored tool result, which the notice points at: the cell pages the rest
 * with `context.read(toolCallId, { offset, limit })`.
 */
const boundedNotice = (toolCallId: ToolCallId, message: string): string => {
  const bounded = headTailChars(message, maximumModelToolResultChars)
  if (!bounded.truncated) return bounded.text
  const omitted = bounded.totalChars - maximumModelToolResultChars
  return `${bounded.text}\n\n[${omitted} of ${bounded.totalChars} characters omitted; read the rest with context.read("${toolCallId}", { offset, limit })]`
}

const queueTerminalFollowUp = (target: BackgroundBashTarget, state: BackgroundBashTerminalState) =>
  Effect.gen(function* () {
    const command = state.command
    const message = boundedNotice(target.toolCallId, state.message ?? "")
    if (state.status === "completed") {
      const exitCode = state.exitCode ?? 0
      yield* queueBackgroundFollowUp({
        target,
        sourceId: `bash:${target.toolCallId}:complete`,
        content: `Background command completed (exit code ${exitCode}):\n\`\`\`\n$ ${command}\n${message}\n\`\`\``,
      })
      return
    }
    // An interrupted job has no output: the process died with its server.
    let content = `Background command failed:\n\`\`\`\n$ ${command}\n${message}\n\`\`\``
    if (state.status === "interrupted") {
      content = `Background command did not finish before the previous server stopped:\n\`\`\`\n$ ${command}\n\`\`\`\nNo output was captured. Run it again if you still need it.`
    }
    yield* queueBackgroundFollowUp({
      target,
      sourceId: `bash:${target.toolCallId}:failure`,
      content,
    })
  })

/**
 * On a branch's loop open, one notice per background job on it that did not
 * finish. It is the job's terminal notice, keyed like a failure, so it wakes
 * the branch the way a completion does, and a later open or a repeated start
 * of the same call finds the key taken and adds nothing.
 */
const noticeInterruptedJobs = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const storage = yield* BackgroundBashStorage
  const jobs = yield* storage.interruptedJobs({ sessionId: ctx.sessionId, branchId: ctx.branchId })
  yield* Effect.forEach(
    jobs,
    (job) =>
      queueTerminalFollowUp(
        {
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          toolCallId: job.toolCallId,
          Session: ctx.Session,
        },
        { status: "interrupted", command: job.command },
      ),
    { discard: true },
  )
})

interface BackgroundBashSupervisorService {
  readonly start: (
    job: BackgroundBashJob,
  ) => Effect.Effect<
    void,
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
      const bgResult = yield* runBashCommand(job.command, job.cwd).pipe(
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

      let outputText = bgResult.stdout
      if (bgResult.stderr.length > 0) outputText = `${bgResult.stdout}\n${bgResult.stderr}`

      const keyFields = backgroundJobKeyFields(target)
      yield* storage.markCompleted(keyFields, {
        exitCode: bgResult.exitCode,
        message: outputText,
      })
      yield* queueTerminalFollowUp(target, {
        status: "completed",
        command: job.command,
        exitCode: bgResult.exitCode,
        message: outputText,
      })
    })

    const queueFailure = (job: BackgroundBashJob, target: BackgroundBashTarget, message: string) =>
      Effect.gen(function* () {
        const keyFields = backgroundJobKeyFields(target)
        yield* storage.markFailed(keyFields, message).pipe(
          Effect.andThen(
            queueTerminalFollowUp(target, { status: "failed", command: job.command, message }),
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
        }
        const key = backgroundJobKey(target)
        const keyFields = backgroundJobKeyFields(target)
        if ((yield* Ref.get(completed)).has(key)) return
        const claim = yield* storage.claimStart({
          ...keyFields,
          command: job.command,
          cwd: job.cwd,
        })
        if (claim._tag === "AlreadyRunning") return
        if (claim._tag === "Terminal") {
          yield* queueTerminalFollowUp(target, claim.state)
          yield* rememberCompleted(key)
          return
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
          // The notice waits for the branch's next loop open.
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
      yield* supervisor.start({ command, cwd })

      return {
        stdout: `Command started in background: \`${command}\`\nYou will be notified when it completes.`,
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
    yield* host.on("loopOpen", () =>
      noticeInterruptedJobs.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("exec-tools.interrupted-notice.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    )
  }),
})
