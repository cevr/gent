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
  type ToolCallId,
} from "@gent/core/extensions/api"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

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
  /** Marks the running jobs an earlier server process started as interrupted. */
  readonly reconcileInterrupted: Effect.Effect<void, BackgroundBashStorageError>
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
  /** The word holds an unquoted glob or brace pattern: the shell expands it to other words. */
  readonly pattern: boolean
}

interface ShellSegment {
  readonly words: Array<ShellWord>
  /** Here-strings and heredoc bodies: what the command reads on stdin. */
  readonly stdin: Array<ShellWord>
  /** The targets of its output redirections: files it writes. */
  readonly writes: Array<ShellWord>
  /**
   * The segment whose output this one reads on stdin: the command piped into
   * it, or into the subshell, group, loop or `if` around it.
   */
  readonly pipedFrom: Option.Option<ShellSegment>
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
  pipedFrom,
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
      pattern: PATTERN_TEXT.test(reader.plain),
    }
    if (reader.role === "argument") readCompoundWord(reader, word)
    if (reader.role === "argument" && !readCaseWord(reader, word)) reader.segment.words.push(word)
    if (reader.role === "here-string") reader.segment.stdin.push(word)
    if (reader.role === "redirect-target") reader.segment.writes.push(word)
    // `bash < <(cmd)`: the shell reads a script that only exists at run time.
    if (reader.role === "input-target" && isProcessSubstitution(word)) {
      reader.segment.stdin.push(word)
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
 */
const readSubstitution = (
  source: ShellSource,
  index: number,
  input: Option.Option<ShellSegment>,
): number => {
  if (source.text.charAt(index) === "`") {
    return readCommands(source, index + 1, Option.some("`"), input)
  }
  return readCommands(source, index + 2, Option.some(")"), input)
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

/** The `$(...)` and backticks of an expanding heredoc body run. */
const readExpansions = (source: ShellSource, from: number, to: number) => {
  for (let index = from; index < to; index++) {
    if (source.text.charAt(index) === "\\") index++
    else if (startsSubstitution(source.text, index))
      index = readSubstitution(source, index, Option.none()) - 1
  }
}

/** Read the bodies of the heredocs opened on the line that ends before `from`. */
const readHeredocBodies = (reader: CommandReader, from: number): number => {
  const source = reader.source
  let index = from
  for (const heredoc of reader.heredocs) {
    const { bodyEnd, next } = heredocBodyEnd(source.text, index, heredoc)
    heredoc.segment.stdin.push(sourceWord(source, index, bodyEnd, heredoc.expands))
    if (heredoc.expands) readExpansions(source, index, bodyEnd)
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
      pattern: false,
    },
    Option.none(),
  )

/** A word made of other text: no source offsets to rewrite, no safe insertion point. */
const derivedWord = (text: string, dynamic: boolean): ShellWord => ({
  text,
  map: Array.from({ length: text.length }, () => 0),
  safe: Array.from({ length: text.length }, () => false),
  end: 0,
  endSafe: false,
  dynamic,
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
}

/** Where an option's value starts: argument `word`, from character `from`. */
interface OptionValue {
  readonly word: number
  readonly from: number
}

/** One option read: its letter, or its long name as written, and its value when it takes one. */
interface ParsedOption {
  readonly name: string
  readonly long: boolean
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

/** Read the option word at `index`; returns the index of the next word. */
const readOption = (
  args: ReadonlyArray<string>,
  index: number,
  valued: ValueOptions,
  into: OptionsRead,
): number => {
  const arg = args[index] ?? ""
  if (arg.startsWith("--")) {
    const [name = ""] = arg.slice(2).split("=", 1)
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
    into.options.push({ name, long: true, value })
    return next
  }
  for (let at = 1; at < arg.length; at++) {
    const letter = arg.charAt(at)
    into.shorts.add(letter)
    if ((valued.short ?? "").includes(letter)) {
      // The rest of the cluster is the value; a bare letter takes the next word.
      if (at < arg.length - 1) {
        into.options.push({
          name: letter,
          long: false,
          value: Option.some({ word: index, from: at + 1 }),
        })
        return index + 1
      }
      into.options.push({
        name: letter,
        long: false,
        value: Option.some({ word: index + 1, from: 0 }),
      })
      return index + 2
    }
    into.options.push({ name: letter, long: false, value: Option.none() })
  }
  return index + 1
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

/** The values of the options named by a letter in `letters` or a long name in `names`. */
const optionValues = (
  parsed: ParsedArguments,
  letters: string,
  names: ReadonlyArray<string> = [],
): ReadonlyArray<OptionValue> =>
  parsed.options.flatMap((option) => {
    let named = letters.includes(option.name)
    if (option.long) named = names.some((name) => abbreviates(option.name, name))
    if (!named) return []
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

/** How a command that runs another command reads its own words first. */
interface Prefix {
  readonly valued: ValueOptions
  /** Words after the options that belong to the prefix (`timeout 5`, `ssh host`). */
  readonly positionals: number
  /** An optional name before a `{` compound: `coproc NAME { … }`. */
  readonly named: boolean
  /**
   * The command starts after the first of these words, not after the
   * options: `mise exec node@20 -- cmd`, `nix develop .#x -c cmd`.
   */
  readonly after: ReadonlyArray<string>
}

const prefix = (valued: ValueOptions = {}, positionals = 0, named = false): Prefix => ({
  valued,
  positionals,
  named,
  after: [],
})

const runsAfter = (...after: ReadonlyArray<string>): Prefix => ({ ...prefix(), after })

/** `env` options whose value is the next word; `-S` splits its value into the command it runs. */
const ENV_OPTIONS: ValueOptions = { short: "CPSu", long: ["unset", "chdir", "split-string"] }

/** `xargs` options whose value is the next word; `-e`, `-i` and `-l` take only an attached one. */
const XARGS_OPTIONS: ValueOptions = {
  short: "aEdILnPsJRS",
  long: ["arg-file", "delimiter", "max-lines", "max-args", "max-procs", "max-chars"],
}

const PARALLEL_OPTIONS: ValueOptions = {
  short: "aCdEIjLnNPSs",
  long: [
    ...["arg-file", "colsep", "delimiter", "jobs", "max-args", "max-replace-args", "max-lines"],
    ...["max-chars", "sshlogin", "sshloginfile", "results", "joblog", "tmpdir", "workdir"],
    ...["tagstring", "timeout", "retries", "load", "memfree", "basefile", "env", "halt", "delay"],
  ],
}

/**
 * Keywords and commands that run the command after them with its own words
 * (`sudo git push`, `if git diff`, `xargs git add`). The word after one is in
 * command position again. A command missing here runs nothing the guard
 * sees: its words are data.
 */
const WRAPPERS: ReadonlyMap<string, Prefix> = new Map([
  ...["!", "{", "if", "then", "elif", "else", "do", "while", "until", "time"].map(
    (keyword): readonly [string, Prefix] => [keyword, prefix()],
  ),
  ["coproc", prefix({}, 0, true)],
  // `function f { … }`: the word after the name opens the body.
  ["function", prefix({}, 1)],
  [
    "sudo",
    prefix({
      short: "CDghpRrTtUu",
      long: [
        ...["user", "group", "close-from", "chdir", "host", "prompt", "role", "type"],
        ...["command-timeout", "other-user", "chroot"],
      ],
    }),
  ],
  ["doas", prefix({ short: "uC" })],
  ["env", prefix(ENV_OPTIONS)],
  // Multicall binaries: the next word is the applet (`busybox rm -rf x`).
  ["busybox", prefix()],
  ["toybox", prefix()],
  ["nohup", prefix()],
  ["setsid", prefix()],
  ["chronic", prefix()],
  ["unbuffer", prefix()],
  ["command", prefix()],
  ["builtin", prefix()],
  ["exec", prefix({ short: "a" })],
  ...["nice", "gnice"].map((name): readonly [string, Prefix] => [
    name,
    prefix({ short: "n", long: ["adjustment"] }),
  ]),
  ["ionice", prefix({ short: "cnpPu", long: ["class", "classdata", "pid", "pgid", "uid"] })],
  ...["timeout", "gtimeout"].map((name): readonly [string, Prefix] => [
    name,
    prefix({ short: "sk", long: ["signal", "kill-after"] }, 1),
  ]),
  ["stdbuf", prefix({ short: "ioe", long: ["input", "output", "error"] })],
  ["caffeinate", prefix({ short: "tw" })],
  ["flock", prefix({ short: "Ew", long: ["timeout", "conflict-exit-code"] }, 1)],
  ["strace", prefix({ short: "abeEIoOpPsSuX", long: ["output", "attach", "user", "env"] })],
  ["ltrace", prefix({ short: "aeFnopsu", long: ["output"] })],
  ["chroot", prefix({ long: ["userspec", "groups"] }, 1)],
  ["taskset", prefix({}, 1)],
  ["runuser", prefix({ short: "gGsu", long: ["group", "supp-group", "shell", "user"] })],
  // BSD `script [-q] file command…`.
  ["script", prefix({ short: "cEIOT", long: ["command", "log-in", "log-out", "log-timing"] }, 1)],
  ["dotenv", prefix({ short: "ecv" })],
  ["xargs", prefix(XARGS_OPTIONS)],
  ["parallel", prefix(PARALLEL_OPTIONS)],
])

/** Commands that run the rest of their words joined into one script (`eval`, `ssh host cmd`). */
const SCRIPT_JOINERS: ReadonlyMap<string, Prefix> = new Map([
  ["eval", prefix()],
  ["ssh", prefix({ short: "bcDEeFIiJLlmOopQRSWwB" }, 1)],
  ["watch", prefix({ short: "n", long: ["interval"] })],
])

/**
 * Commands whose subcommand runs the command after it: `pnpm exec`, `uv
 * run`, `nix develop -c`. `valued` reads the options before the subcommand.
 */
interface SubcommandRunner {
  readonly valued: ValueOptions
  readonly subcommand: string
  readonly prefix: Prefix
}

const SUBCOMMAND_RUNNERS: ReadonlyMap<string, ReadonlyArray<SubcommandRunner>> = new Map([
  [
    "pnpm",
    [{ valued: { short: "CF", long: ["filter", "dir"] }, subcommand: "exec", prefix: prefix() }],
  ],
  [
    "npm",
    [
      {
        valued: { short: "w", long: ["workspace", "prefix"] },
        subcommand: "exec",
        prefix: prefix(),
      },
    ],
  ],
  ["yarn", [{ valued: { long: ["cwd"] }, subcommand: "exec", prefix: prefix() }]],
  [
    "uv",
    [
      {
        valued: { long: ["directory", "project"] },
        subcommand: "run",
        prefix: prefix({ long: ["with", "python", "package", "env-file", "extra", "group"] }),
      },
    ],
  ],
  ["op", [{ valued: {}, subcommand: "run", prefix: prefix({ long: ["env-file"] }) }]],
  [
    "mise",
    ["exec", "x"].map((subcommand) => ({ valued: {}, subcommand, prefix: runsAfter("--") })),
  ],
  ["direnv", [{ valued: {}, subcommand: "exec", prefix: prefix({}, 1) }]],
  [
    "nix",
    ["develop", "shell"].map((subcommand) => ({
      valued: {},
      subcommand,
      prefix: runsAfter("-c", "--command"),
    })),
  ],
])

/** The words a runner wraps, from its own command word, and how it reads them. */
const runnerOf = (
  command: ReadonlyArray<ShellWord>,
): Option.Option<{ readonly words: ReadonlyArray<ShellWord>; readonly spec: Prefix }> => {
  const name = commandName(command[0]?.text ?? "")
  const wrapper = Option.fromUndefinedOr(WRAPPERS.get(name))
  if (Option.isSome(wrapper)) return Option.some({ words: command, spec: wrapper.value })
  const runners = SUBCOMMAND_RUNNERS.get(name) ?? []
  return Option.map(
    Arr.findFirst(runners, (runner) => {
      const at = 1 + parseWords(command, runner.valued, "leading").end
      return command[at]?.text === runner.subcommand
    }),
    (runner) => {
      const at = 1 + parseWords(command, runner.valued, "leading").end
      return { words: command.slice(at), spec: runner.prefix }
    },
  )
}

/** The index of the first word after a prefix's own options and positionals. */
const prefixEnd = (words: ReadonlyArray<ShellWord>, spec: Prefix): number => {
  if (spec.after.length > 0) {
    const at = words.findIndex((word, index) => index > 0 && spec.after.includes(word.text))
    if (at === -1) return words.length
    return at + 1
  }
  let end = 1 + parseWords(words, spec.valued, "leading").end + spec.positionals
  if (spec.named && words[end + 1]?.text === "{") end++
  // No command is named `--`: after the positionals it ends the options (`ssh host -- cmd`).
  if (words[end]?.text === "--") end++
  return end
}

/** A command that runs an option's value as a shell script. */
interface ScriptOptions {
  /** Every option that takes a value, the script options included. */
  readonly valued: ValueOptions
  /** The options whose value is a script. */
  readonly scripts: ValueOptions
}

const scriptOptions = (scripts: ValueOptions, other: ValueOptions = {}): ScriptOptions => ({
  scripts,
  valued: {
    short: `${scripts.short ?? ""}${other.short ?? ""}`,
    long: [...(scripts.long ?? []), ...(other.long ?? [])],
  },
})

/** Commands that run an option's value as a shell script (`su -c`, `flock -c`, `nix-shell --run`). */
const OPTION_SCRIPTS: ReadonlyMap<string, ScriptOptions> = new Map([
  ["su", scriptOptions({ short: "c", long: ["command", "session-command"] }, { short: "gGsw" })],
  ["runuser", scriptOptions({ short: "c", long: ["command"] }, { short: "gGsuw" })],
  ["flock", scriptOptions({ short: "c", long: ["command"] }, { short: "Ew" })],
  ["script", scriptOptions({ short: "c", long: ["command"] }, { short: "EIOT" })],
  ["nix-shell", scriptOptions({ long: ["run", "command"] }, { short: "AIp", long: ["attr"] })],
])

/** The scripts the options of `words` run. */
const optionScripts = (words: ReadonlyArray<ShellWord>, spec: ScriptOptions) => {
  const parsed = parseWords(words, spec.valued, "anywhere")
  return optionValues(parsed, spec.scripts.short ?? "", spec.scripts.long).flatMap((value) =>
    Option.toArray(valueWord(words, value)),
  )
}

/** The words `env -S <string>` runs: the string, then the words after it. */
const envSplitWords = (
  words: ReadonlyArray<ShellWord>,
): Option.Option<ReadonlyArray<ShellWord>> => {
  if (commandName(words[0]?.text ?? "") !== "env") return Option.none()
  const parsed = parseWords(words, ENV_OPTIONS, "leading")
  const split = Arr.head(optionValues(parsed, "S", ["split-string"]))
  return Option.flatMap(split, (value) =>
    Option.map(valueWord(words, value), (script) => [script, ...words.slice(value.word + 2)]),
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
}

const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"])

/** The commands `words` runs: the first after env assignments, the one after each runner, and each `find -exec` command. */
const collectInvocations = (
  segment: ShellSegment,
  words: ReadonlyArray<ShellWord>,
  into: Array<Invocation>,
): void => {
  let start = words.findIndex((word) => !ASSIGNMENT.test(word.text))
  if (start === -1) start = words.length
  const command = words.slice(start)
  const assignments = words.slice(0, start)
  if (command.length === 0 && assignments.length === 0) return
  into.push({ segment, words: command, assignments })
  const runner = runnerOf(command)
  if (Option.isSome(runner)) {
    const { words: wrapped, spec } = runner.value
    collectInvocations(segment, wrapped.slice(prefixEnd(wrapped, spec)), into)
    return
  }
  if (commandName(command[0]?.text ?? "") !== "find") return
  for (const [index, word] of command.entries()) {
    if (!FIND_EXEC_ACTIONS.has(word.text)) continue
    const rest = command.slice(index + 1)
    let end = rest.findIndex((next) => next.text === ";" || next.text === "+")
    if (end === -1) end = rest.length
    collectInvocations(segment, rest.slice(0, end), into)
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
 * `printf` prints its format: escapes decoded, `%%` as `%`. A format with a
 * directive (`%s`) prints its arguments in a shape the guard does not
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
  if (text.replaceAll("%%", "").includes("%")) {
    return unreadableRun(`printf output with format directives: ${text}`)
  }
  if (!text.includes("%") && !text.includes("\\")) return scriptRuns([format.value])
  return decodedRuns({ ...format.value, text: text.replaceAll("%%", "%") }, "printf")
}

/**
 * The input of a command in `segment`: a here-string, a heredoc body, or the
 * text of the `echo`/`printf` whose output it reads. Only those producers
 * can be read: the output of any other command (`cat`, `tee`, a subshell or
 * group), and text a shell expands at run time, cannot.
 */
const segmentInputs = (segment: ShellSegment): SegmentRuns => {
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

/** A script file a shell or `source` runs: not read, unless it only exists at run time. */
const scriptFileRuns = (file: Option.Option<ShellWord>): SegmentRuns => {
  if (Option.exists(file, isProcessSubstitution)) {
    return unreadableRun("a script from a process substitution")
  }
  return NO_RUNS
}

/** Shell options whose value is the next word (`-o pipefail`, `--rcfile x`). */
const SHELL_OPTIONS: ValueOptions = { short: "oO", long: ["rcfile", "init-file"], plus: true }

/**
 * A shell: the argument after its options with `-c`; its stdin with `-s` or
 * with no argument; else a script file, which is not read: its content is
 * not in the command. A script that is not a literal (`sh -c '{}'` under
 * xargs, `sh -c "$CMD"`) takes the input as the script, as a pipe into a
 * shell does.
 */
const shellRuns = ({ segment, words }: Invocation): SegmentRuns => {
  const parsed = parseWords(words, SHELL_OPTIONS, "leading")
  let end = 1 + parsed.end
  // `-` ends the options as `--` does.
  if (!parsed.separated && words[end]?.text === "-") end++
  const operand = Option.fromUndefinedOr(words[end])
  if (!hasShort(parsed, "c")) {
    if (hasShort(parsed, "s") || Option.isNone(operand)) return segmentInputs(segment)
    return scriptFileRuns(operand)
  }
  const literal = Option.filter(operand, (word) => !word.dynamic && !word.text.includes("{}"))
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
 * `xargs` and `parallel` run their command with the input words appended, or
 * put into `{}`; `parallel ::: a b` also runs each word after `:::` when it
 * has no command, and `parallel` with no command runs each input line. Bare
 * `xargs` runs `echo`. The wrapped command is classified with its input when
 * it is a git command the guard checks. A shell under the wrapper reads its
 * input through `shellRuns`.
 */
const inputWrapperRuns = ({ segment, words }: Invocation, spec: Prefix): SegmentRuns => {
  const name = commandName(words[0]?.text ?? "")
  const rest = words.slice(prefixEnd(words, spec))
  const separator = rest.findIndex((word) => word.text === ":::")
  let command = rest
  let listed: ReadonlyArray<ShellWord> = []
  if (separator !== -1) {
    command = rest.slice(0, separator)
    listed = rest.slice(separator + 1)
  }
  const commandTexts = command.map((word) => word.text)
  if (command.length === 0 && name === "xargs") return NO_RUNS
  if (command.length === 0 || commandTexts.every((text) => text === "{}")) {
    const inputs = segmentInputs(segment)
    return { scripts: [...listed, ...inputs.scripts], unreadable: inputs.unreadable }
  }
  if (commandName(commandTexts[0] ?? "") !== "git") return NO_RUNS
  const checked = gitSubcommandIndex(commandTexts).pipe(
    Option.exists((at) => isRiskySubcommand(commandTexts[at] ?? "")),
  )
  if (!checked) return NO_RUNS
  let inputs = segmentInputs(segment)
  if (listed.length > 0) inputs = scriptRuns(listed)
  if (inputs.scripts.length === 0 && inputs.unreadable.length === 0) {
    return unreadableRun(`the input of \`${name}\``)
  }
  const input = inputs.scripts.map((word) => word.text).join(" ")
  let text = `${commandTexts.join(" ")} ${input}`
  if (commandTexts.some((word) => word.includes("{}")))
    text = commandTexts.join(" ").replaceAll("{}", input)
  const dynamic = inputs.scripts.some((word) => word.dynamic)
  return { scripts: [derivedWord(text, dynamic)], unreadable: inputs.unreadable }
}

/** Environment variables whose value a command runs as a shell command. */
const SHELL_VARIABLES = new Set([
  ...["GIT_SSH_COMMAND", "GIT_SSH", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER"],
  ...["GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "GIT_PROXY_COMMAND", "SSH_ASKPASS"],
  ...["EDITOR", "VISUAL", "PAGER"],
])

/** Builtins whose `NAME=value` arguments set variables. */
const DECLARATION_COMMANDS = new Set(["export", "declare", "typeset", "local", "readonly"])

/** `GIT_SSH_COMMAND=… git fetch`, `export EDITOR=…`: a value a later command runs as a script. */
const assignmentRuns = ({ words, assignments }: Invocation): SegmentRuns => {
  let candidates = assignments
  if (DECLARATION_COMMANDS.has(commandName(words[0]?.text ?? ""))) {
    candidates = [...assignments, ...words.slice(1)]
  }
  return scriptRuns(
    candidates.flatMap((word) => {
      const assignment = Option.fromNullishOr(ASSIGNMENT.exec(word.text))
      const named = Option.filter(assignment, (match) =>
        SHELL_VARIABLES.has(match[0].replace(/\+?=$/, "")),
      )
      return Option.toArray(Option.map(named, (match) => wordFrom(word, match[0].length)))
    }),
  )
}

/** Git global options whose value is the next word. */
const GIT_GLOBAL_OPTIONS: ValueOptions = {
  short: "cC",
  long: [...["git-dir", "work-tree", "namespace", "config-env", "super-prefix", "attr-source"]],
}

/** The index of the subcommand word of a git invocation (`words[0]` is `git`). */
const gitSubcommandIndex = (words: ReadonlyArray<string>): Option.Option<number> => {
  const at = 1 + parseArguments(words.slice(1), GIT_GLOBAL_OPTIONS, "leading").end
  if (at < words.length) return Option.some(at)
  return Option.none()
}

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

/** Git subcommands that run an option's value as a shell command. */
const GIT_SCRIPT_OPTIONS: ReadonlyMap<string, ScriptOptions> = new Map([
  [
    "rebase",
    scriptOptions(
      { short: "x", long: ["exec"] },
      { short: "sXC", long: ["strategy", "strategy-option", "onto"] },
    ),
  ],
  ["difftool", scriptOptions({ short: "x", long: ["extcmd"] }, { short: "t", long: ["tool"] })],
  ...["fetch", "pull", "ls-remote"].map((name): readonly [string, ScriptOptions] => [
    name,
    scriptOptions({ long: ["upload-pack"] }),
  ]),
  [
    "clone",
    scriptOptions(
      { short: "u", long: ["upload-pack"] },
      { short: "bco", long: ["branch", "origin", "config", "depth"] },
    ),
  ],
  [
    "push",
    scriptOptions(
      { long: ["receive-pack", "exec"] },
      { short: "o", long: ["push-option", "repo"] },
    ),
  ],
  [
    "archive",
    scriptOptions(
      { long: ["exec"] },
      { short: "o", long: ["output", "remote", "format", "prefix"] },
    ),
  ],
  [
    "filter-branch",
    scriptOptions(
      {
        long: [
          ...["setup", "env-filter", "tree-filter", "index-filter", "parent-filter"],
          ...["msg-filter", "commit-filter", "tag-name-filter"],
        ],
      },
      { short: "d", long: ["subdirectory-filter", "original", "state-branch"] },
    ),
  ],
])

/** Git subcommands whose action runs the words after it: `submodule foreach`, `bisect run`. */
const GIT_COMMAND_ACTIONS: ReadonlyMap<string, string> = new Map([
  ["submodule", "foreach"],
  ["bisect", "run"],
])

/** `git submodule foreach <cmd>` and `git bisect run <cmd>` run their remaining words. */
const gitCommandRuns = (subcommand: string, args: ReadonlyArray<ShellWord>): SegmentRuns => {
  const action = Option.fromUndefinedOr(GIT_COMMAND_ACTIONS.get(subcommand))
  const texts = args.map((word) => word.text)
  const at = parseArguments(texts, {}, "leading").end
  if (Option.isNone(action) || texts[at] !== action.value) return NO_RUNS
  const start = at + 1 + parseArguments(texts.slice(at + 1), {}, "leading").end
  return joinedRuns(`git ${subcommand} ${action.value}`, args.slice(start))
}

/**
 * What a git invocation runs beyond its own words. `git -c key=<value>` runs
 * an alias or a shell-running key (`core.pager`, `core.sshCommand`) now, so
 * the value keeps its source offsets. `git config key <value>` stores it
 * for later runs in any session: it is classified now, as a derived word
 * that nothing rewrites. `rebase -x`, `submodule foreach` and `bisect run`
 * run their commands. A subcommand known only at run time (`git $(…)`), or a
 * shell-running value read from the environment, cannot be read.
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
  const name = subcommand.value.text
  const args = words.slice(at + 1)
  const scripts = Option.fromUndefinedOr(GIT_SCRIPT_OPTIONS.get(name))
  if (Option.isSome(scripts))
    runs.push(scriptRuns(optionScripts([subcommand.value, ...args], scripts.value)))
  runs.push(gitCommandRuns(name, args))
  if (name === "config") {
    for (const [index, key] of args.entries()) {
      const value = Option.fromUndefinedOr(args[index + 1])
      const stored = Option.flatMap(value, (word) => configScript(key.text, word))
      if (Option.isSome(stored)) {
        runs.push(scriptRuns([derivedWord(stored.value.text, stored.value.dynamic)]))
      }
    }
  }
  return mergeRuns(runs)
}

/** `trap '<script>' SIGNAL`: the script runs when the signal (or `EXIT`) comes. */
const trapRuns = ({ words }: Invocation): SegmentRuns => {
  const parsed = parseWords(words, {}, "leading")
  const script = words.slice(1 + parsed.end, 2 + parsed.end)
  if (parsed.operands.length < 2) return NO_RUNS
  return joinedRuns("trap", script)
}

/**
 * The scripts one command's words run: the argument after a shell's `-c`,
 * what a shell with no script argument reads on stdin, the joined words of
 * `eval`, `ssh` and `watch`, the input of `xargs`/`parallel`, a `su -c`
 * script, and what git runs. Quoted text anywhere else, such as a commit
 * message or `cat <<EOF` notes, is data.
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
  const split = envSplitWords(words)
  if (Option.isSome(split)) return joinedRuns(name, split.value)
  if (SHELL_NAMES.has(name)) return shellRuns(invocation)
  if (FOREIGN_SHELLS.has(name)) return foreignShellRuns(invocation)
  if (name === "source" || name === ".") return scriptFileRuns(Option.fromUndefinedOr(words[1]))
  if (name === "git") return gitRuns(invocation)
  if (name === "trap") return trapRuns(invocation)
  const runs: Array<SegmentRuns> = []
  const options = Option.fromUndefinedOr(OPTION_SCRIPTS.get(name))
  if (Option.isSome(options)) runs.push(scriptRuns(optionScripts(words, options.value)))
  const joiner = Option.fromUndefinedOr(SCRIPT_JOINERS.get(name))
  if (Option.isSome(joiner))
    runs.push(joinedRuns(name, words.slice(prefixEnd(words, joiner.value))))
  const wrapper = Option.fromUndefinedOr(WRAPPERS.get(name))
  if ((name === "xargs" || name === "parallel") && Option.isSome(wrapper)) {
    runs.push(inputWrapperRuns(invocation, wrapper.value))
  }
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

/** The commands of `segments` and of the scripts they run, up to `maxDepth` levels deep. */
const viewCommand = (segments: ReadonlyArray<ShellSegment>, maxDepth: number): CommandView => {
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
        const nested = viewCommand(parseShell(script, input), maxDepth - 1)
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

/** The risk of each git subcommand that can lose work or reach a remote. */
const GIT_SUBCOMMAND_RISKS = {
  push: (args: ReadonlyArray<string>): Option.Option<BashRisk> => {
    const parsed = parseArguments(args, {
      short: "o",
      long: ["push-option", "receive-pack", "exec", "repo"],
    })
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
  },
  reset: (args: ReadonlyArray<string>) =>
    destructiveWhen(hasLong(parseArguments(args), "hard"), "git reset --hard"),
  clean: (args: ReadonlyArray<string>) => {
    const parsed = parseArguments(args, { short: "e", long: ["exclude"] })
    return destructiveWhen(!hasShort(parsed, "n") && !hasLong(parsed, "dry-run"), "git clean")
  },
  // A branch switch (`git checkout main`, `-b feat origin/main`) keeps work.
  // Paths do not: a tree-ish plus a path, `--ours`/`--theirs`, a merge
  // checkout, or a force. `-B` resets an existing branch. One bare word stays
  // safe: the classifier cannot tell a path from a branch without the file
  // system. `git checkout -` switches back to the previous branch.
  checkout: (args: ReadonlyArray<string>) => {
    const parsed = parseArguments(args, {
      short: "bB",
      long: ["orphan", "conflict", "pathspec-from-file"],
    })
    return destructiveWhen(
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
  },
  // Every form can lose work: the default and `--worktree` overwrite the
  // working tree, and `--staged` drops staged content the tree may not hold.
  restore: () => destructive("git restore (can discard changes)"),
  switch: (args: ReadonlyArray<string>) => {
    const parsed = parseArguments(args, {
      short: "cC",
      long: ["create", "force-create", "orphan", "conflict"],
    })
    return destructiveWhen(
      hasShort(parsed, "f", "C") || hasLong(parsed, "force", "discard-changes", "force-create"),
      "git switch --discard-changes/--force-create",
    )
  },
  // `-D`, `-d --force`, `-f <branch> <commit>`, `-M` and `-C` drop, move or
  // overwrite a branch.
  branch: (args: ReadonlyArray<string>) => {
    const parsed = parseArguments(args, { short: "u", long: ["set-upstream-to"] })
    return destructiveWhen(
      hasShort(parsed, "D", "M", "C", "f") || hasLong(parsed, "force"),
      "git branch -D/-M/-C/--force (can drop or overwrite a branch)",
    )
  },
  // Delegate children share one working tree. A stash takes a sibling's
  // uncommitted edits out of it, and a pop or apply writes them back over
  // work done since. Only the reads stay safe.
  stash: (args: ReadonlyArray<string>) => {
    const action = parseArguments(args, { short: "m", long: ["message"] }).operands[0] ?? "push"
    return destructiveWhen(
      !STASH_READS.has(action),
      `git stash ${action} (changes the working tree other agents share)`,
    )
  },
  // `git rm` keeps what is committed; a force also drops uncommitted edits.
  rm: (args: ReadonlyArray<string>) => {
    const parsed = parseArguments(args)
    return destructiveWhen(
      (hasShort(parsed, "f") || hasLong(parsed, "force")) && !hasLong(parsed, "cached"),
      "git rm --force (drops uncommitted changes)",
    )
  },
  worktree: (args: ReadonlyArray<string>) => {
    const parsed = parseArguments(args)
    return destructiveWhen(
      parsed.operands[0] === "remove" && (hasShort(parsed, "f") || hasLong(parsed, "force")),
      "git worktree remove --force (discards the worktree's changes)",
    )
  },
}

const isRiskySubcommand = (subcommand: string): subcommand is keyof typeof GIT_SUBCOMMAND_RISKS =>
  Object.hasOwn(GIT_SUBCOMMAND_RISKS, subcommand)

const gitSubcommandRisk = (
  subcommand: string,
  args: ReadonlyArray<string>,
): Option.Option<BashRisk> => {
  if (!isRiskySubcommand(subcommand)) return Option.none()
  return GIT_SUBCOMMAND_RISKS[subcommand](args)
}

/** A git invocation: the risk of its subcommand. */
const gitRisk = (args: ReadonlyArray<string>): Option.Option<BashRisk> => {
  const texts = ["git", ...args]
  return Option.flatMap(gitSubcommandIndex(texts), (at) =>
    gitSubcommandRisk(texts[at] ?? "", texts.slice(at + 1)),
  )
}

const KILL_SIGNALS = new Set(["9", "KILL", "SIGKILL"])

/** `kill -9`, `kill -KILL`, `kill -s KILL`, `kill -sKILL`, `kill --signal=KILL`. */
const killsHard = (args: ReadonlyArray<string>) =>
  args.some((arg, index) => {
    const signals = [arg.replace(/^-/, ""), /^(?:-[sn]|--signal=)(.+)$/.exec(arg)?.[1] ?? ""]
    if (["-s", "-n", "--signal"].includes(arg)) signals.push(args[index + 1] ?? "")
    return signals.some((signal) => KILL_SIGNALS.has(signal))
  })

const SQL_DESTRUCTIVE = /\b(drop|truncate)\s+table\b/i

/** A SQL client that drops or truncates a table, in its arguments or its input. */
const sqlRisk = (args: ReadonlyArray<string>, invocation: Invocation) => {
  const input = segmentInputs(invocation.segment).scripts.map((word) => word.text)
  const statement = Option.fromNullishOr(SQL_DESTRUCTIVE.exec([...args, ...input].join(" ")))
  return Option.flatMap(statement, (match) =>
    destructive(`${(match[1] ?? "").toUpperCase()} TABLE`),
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

const sensitiveOperands = (parsed: ParsedArguments): Option.Option<BashRisk> =>
  Arr.findFirst([...parsed.operands, ...parsed.pathspecs], (operand) => sensitiveFile(operand))

/** A command that writes, moves or deletes a key or secret file. */
const sensitiveRisk = (args: ReadonlyArray<string>): Option.Option<BashRisk> =>
  sensitiveOperands(parseArguments(args))

/** `sed -i` rewrites its files in place. */
const sedRisk = (args: ReadonlyArray<string>): Option.Option<BashRisk> => {
  const parsed = parseArguments(args)
  if (!hasShort(parsed, "i") && !hasLong(parsed, "in-place")) return Option.none()
  return sensitiveOperands(parsed)
}

type CommandRisk = (args: ReadonlyArray<string>, invocation: Invocation) => Option.Option<BashRisk>

const riskOf = (names: ReadonlyArray<string>, ...risks: ReadonlyArray<CommandRisk>) =>
  names.map((name): readonly [string, ReadonlyArray<CommandRisk>] => [name, risks])

const rmRisk: CommandRisk = (args) => {
  const parsed = parseArguments(args)
  return destructiveWhen(
    hasShort(parsed, "r", "R", "f") || hasLong(parsed, "recursive", "force"),
    "rm with -r/-f flags",
  )
}

/** `sudo rm`, with or without flags. */
const rootRmRisk: CommandRisk = (_args, { words }) => {
  const wrapped = Option.fromUndefinedOr(WRAPPERS.get(commandName(words[0]?.text ?? ""))).pipe(
    Option.flatMap((spec) => Option.fromUndefinedOr(words[prefixEnd(words, spec)])),
  )
  return destructiveWhen(
    Option.exists(wrapped, (word) => commandName(word.text) === "rm"),
    "sudo rm",
  )
}

/**
 * The command's subcommand is the action: the first word after its leading
 * options and any group words (`docker image push`, `npm -w pkg publish`,
 * `yarn workspace x npm publish`). The same word later is an argument:
 * `docker run alpine push` runs a container.
 */
const actionRisk = (
  action: string,
  reason: string,
  valued: ValueOptions = {},
  groups: ReadonlyMap<string, number> = new Map(),
): CommandRisk => {
  const subcommandIs = (args: ReadonlyArray<string>): boolean => {
    const at = parseArguments(args, valued, "leading").end
    const word = Option.fromUndefinedOr(args[at])
    if (Option.isNone(word)) return false
    const skip = Option.fromUndefinedOr(groups.get(word.value))
    if (Option.isSome(skip)) return subcommandIs(args.slice(at + 1 + skip.value))
    return word.value === action
  }
  return (args) => {
    let rest = args
    // `cargo +nightly publish`: a toolchain before the subcommand.
    if (rest[0]?.startsWith("+") === true) rest = rest.slice(1)
    return Option.filter(Option.some<BashRisk>({ level: "external", reason }), () =>
      subcommandIs(rest),
    )
  }
}

const PUBLISH_OPTIONS = ["tag", "access", "registry", "otp"]

/** Package managers: the options before their subcommand that take a value, and the words that group subcommands (`yarn workspace foo npm publish`). */
const PUBLISHERS: ReadonlyArray<readonly [string, ValueOptions, ReadonlyMap<string, number>]> = [
  [
    "npm",
    { short: "w", long: ["workspace", "prefix", "userconfig", "cache", ...PUBLISH_OPTIONS] },
    new Map(),
  ],
  ["pnpm", { short: "CF", long: ["filter", "dir", ...PUBLISH_OPTIONS] }, new Map()],
  [
    "yarn",
    { long: ["cwd", ...PUBLISH_OPTIONS] },
    new Map([
      ["workspace", 1],
      ["npm", 0],
    ]),
  ],
  ["bun", { short: "F", long: ["cwd", "filter", "config", ...PUBLISH_OPTIONS] }, new Map()],
  [
    "cargo",
    {
      short: "pZ",
      long: ["package", "manifest-path", "registry", "token", "config", "index", "color"],
    },
    new Map(),
  ],
]

/** Docker global options that take a value. */
const DOCKER_OPTIONS: ValueOptions = {
  short: "Hcl",
  long: ["host", "context", "config", "log-level", "tlscacert", "tlscert", "tlskey"],
}

/** The risk of each command the guard checks, read from its words. */
const COMMAND_RISKS: ReadonlyMap<string, ReadonlyArray<CommandRisk>> = new Map([
  ...riskOf(["git"], gitRisk),
  ...riskOf(["rm"], rmRisk, sensitiveRisk),
  ...riskOf(["cp", "mv", "chmod", "chown", "tee"], sensitiveRisk),
  ...riskOf(["sed"], sedRisk),
  ...riskOf(["find"], (args) => destructiveWhen(args.includes("-delete"), "find -delete")),
  ...riskOf(["kill"], (args) => destructiveWhen(killsHard(args), "kill -9")),
  ...riskOf(["pkill", "killall"], (_args, { words }) => destructive(words[0]?.text ?? "")),
  ...riskOf(["mkfs"], () => destructive("mkfs (format filesystem)")),
  ...riskOf(["dd"], (args) =>
    destructiveWhen(
      args.some((arg) => /^(if|of)=/.test(arg)),
      "dd (raw disk write)",
    ),
  ),
  ...riskOf(["sudo", "doas"], rootRmRisk),
  ...riskOf(["psql", "mysql", "mariadb", "sqlite3", "duckdb"], sqlRisk),
  ...PUBLISHERS.map(([name, valued, groups]): readonly [string, ReadonlyArray<CommandRisk>] => [
    name,
    [actionRisk("publish", "publishes a package", valued, groups)],
  ]),
  ...riskOf(["docker"], actionRisk("push", "docker push", DOCKER_OPTIONS, new Map([["image", 0]]))),
  ...riskOf(["twine"], actionRisk("upload", "twine upload")),
])

const invocationRisks = (invocation: Invocation): Array<BashRisk> => {
  let name = invocationName(invocation)
  if (name.startsWith("mkfs.")) name = "mkfs"
  const args = invocation.words.slice(1).map((word) => word.text)
  return (COMMAND_RISKS.get(name) ?? []).flatMap((risk) => Option.toArray(risk(args, invocation)))
}

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

/** `git commit` options whose value is the next word. */
const COMMIT_OPTIONS: ValueOptions = {
  short: "mFCct",
  long: [
    ...["message", "file", "reuse-message", "reedit-message", "template", "author", "date"],
    ...["cleanup", "fixup", "squash", "trailer", "pathspec-from-file"],
  ],
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
    if (invocationName(invocation) !== "git") continue
    const texts = invocation.words.map((word) => word.text)
    const at = Option.filter(gitSubcommandIndex(texts), (index) => texts[index] === "commit")
    if (Option.isNone(at)) continue
    if (namesSessionTrailer(texts.slice(at.value + 1))) continue
    const word = Option.fromUndefinedOr(invocation.words[at.value])
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
    yield* queueBackgroundFollowUp({
      target,
      sourceId: `bash:${target.toolCallId}:failure`,
      content: `Background command failed:\n\`\`\`\n$ ${command}\n${message}\n\`\`\``,
    })
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
          Effect.forkIn(scope),
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

    // Guardrail check — one durable approval per flagged call
    const risk = classifyBashCommand(command)
    if (risk.level !== "safe") {
      const decision = yield* ctx.Interaction.approve({
        text: `This command is classified as ${risk.level}: ${risk.reason}\n\n\`${command}\`\n\nAllow execution?`,
        metadata: { type: "bash-guardrail", level: risk.level },
      })
      if (!decision.approved) {
        // A decline in a session no user sees says who can answer instead.
        const notes = Option.match(Option.fromUndefinedOr(decision.notes), {
          onNone: () => "",
          onSome: (text) => `. ${text}`,
        })
        return {
          stdout: `Command blocked: ${risk.reason}${notes}`,
          stderr: "",
          exitCode: 1,
          status: "blocked",
        }
      }
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
  }),
})
