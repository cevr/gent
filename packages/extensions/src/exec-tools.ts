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
import { countOf, lineCount } from "./fs-tools.js"
import {
  type BranchId,
  defineExtension,
  defineResource,
  ExtensionContext,
  type ExtensionContextService,
  ExtensionHost,
  ExtensionId,
  headTailChars,
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
              PRIMARY KEY (session_id, branch_id, tool_call_id)
            )
          `,
          )
          .pipe(Effect.mapError(mapError("Failed to create background bash jobs table")))

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
                    started_at
                  )
                  VALUES (
                    ${input.sessionId},
                    ${input.branchId},
                    ${input.toolCallId},
                    ${input.command},
                    ${Option.getOrNull(input.cwd)},
                    'running',
                    ${startedAt}
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
  /** The segment that pipes into this one. */
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
  let pipedFrom = Option.none<ShellSegment>()
  if (piped) pipedFrom = Option.some(segment)
  reader.segment = makeSegment(pipedFrom)
}

const startsSubstitution = (text: string, index: number) =>
  text.charAt(index) === "`" || (text.charAt(index) === "$" && text.charAt(index + 1) === "(")

/** Read the commands of the `$(...)` or backticks at `index`; returns the index after them. */
const readSubstitution = (source: ShellSource, index: number): number => {
  if (source.text.charAt(index) === "`") return readCommands(source, index + 1, Option.some("`"))
  return readCommands(source, index + 2, Option.some(")"))
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
      at = readSubstitution(reader.source, at)
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
      const end = readSubstitution(reader.source, index)
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
    else if (startsSubstitution(source.text, index)) index = readSubstitution(source, index) - 1
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
  const end = readSubstitution(reader.source, index)
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
    endSegment(reader, false)
    return Option.some(readCommands(reader.source, index + 1, Option.some(")")))
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
    const end = readCommands(reader.source, index + 2, Option.some(")"))
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

/** Read commands from `from` until an unquoted `stop`; returns the index after it. */
function readCommands(source: ShellSource, from: number, stop: Option.Option<string>): number {
  const reader: CommandReader = {
    source,
    segment: makeSegment(Option.none()),
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
 */
const parseShell = (script: ShellWord): Array<ShellSegment> => {
  const source: ShellSource = {
    text: script.text,
    map: script.map,
    safe: script.safe,
    segments: [],
  }
  readCommands(source, 0, Option.none())
  return source.segments
}

/** A whole command: every character is its own source offset, and every insertion point is safe. */
const parseCommand = (command: string): Array<ShellSegment> =>
  parseShell({
    text: command,
    map: Array.from({ length: command.length }, (_, index) => index),
    safe: Array.from({ length: command.length }, () => true),
    end: command.length,
    endSafe: true,
    dynamic: false,
    pattern: false,
  })

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

const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"])
/** Shell options whose value is the next word (`-o pipefail`). */
const SHELL_OPTIONS_WITH_VALUE = /^[-+][oO]$/
/** A short option cluster that holds `-c`: the script is the next argument. */
const SHELL_COMMAND_OPTION = /^-[a-zA-Z]*c[a-zA-Z]*$/
/** Commands whose printed text is their own arguments. */
const PRINTING_COMMANDS = new Set(["echo", "printf"])
/** `NAME=value` before a command sets its environment. */
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/

const commandName = (word: string): string => word.slice(word.lastIndexOf("/") + 1)

/** How a command that runs another command reads its own words first. */
interface Prefix {
  /** Options whose value is the next word. */
  readonly valued: ReadonlySet<string>
  /** Words after the options that belong to the prefix (`timeout 5`, `ssh host`). */
  readonly positionals: number
}

const prefix = (valued: ReadonlyArray<string> = [], positionals = 0): Prefix => ({
  valued: new Set(valued),
  positionals,
})

const INPUT_WRAPPER_OPTIONS = ["-I", "-n", "-P", "-L", "-a", "-d", "-s", "-E", "-j"]

/**
 * Keywords and commands that run the command after them with its own words
 * (`sudo git push`, `if git diff`, `xargs git add`). The word after one is in
 * command position again.
 */
const WRAPPERS: ReadonlyMap<string, Prefix> = new Map([
  ...["!", "{", "if", "then", "elif", "else", "do", "while", "until", "time"].map(
    (keyword): readonly [string, Prefix] => [keyword, prefix()],
  ),
  ["sudo", prefix(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user"])],
  ["doas", prefix(["-u", "-C"])],
  ["env", prefix(["-u", "-C", "--unset", "--chdir"])],
  // Multicall binaries: the next word is the applet (`busybox rm -rf x`).
  ["busybox", prefix()],
  ["toybox", prefix()],
  ["nohup", prefix()],
  ["command", prefix()],
  ["builtin", prefix()],
  ["exec", prefix(["-a"])],
  ["nice", prefix(["-n", "--adjustment"])],
  ["ionice", prefix(["-c", "-n", "-p", "-P", "-u"])],
  ["timeout", prefix(["-s", "-k", "--signal", "--kill-after"], 1)],
  ["stdbuf", prefix(["-i", "-o", "-e"])],
  ["caffeinate", prefix(["-t", "-w"])],
  ["xargs", prefix(INPUT_WRAPPER_OPTIONS)],
  ["parallel", prefix(INPUT_WRAPPER_OPTIONS)],
])

/** Commands that run the rest of their words joined into one script (`eval`, `ssh host cmd`). */
const SCRIPT_JOINERS: ReadonlyMap<string, Prefix> = new Map([
  ["eval", prefix()],
  [
    "ssh",
    prefix(
      [
        ...["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O"],
        ...["-o", "-p", "-Q", "-R", "-S", "-W", "-w", "-B"],
      ],
      1,
    ),
  ],
  ["watch", prefix(["-n", "--interval"])],
])

/** The index of the first word after a prefix's own options and positionals. */
const prefixEnd = (words: ReadonlyArray<ShellWord>, spec: Prefix): number => {
  let cursor = 1
  while (cursor < words.length) {
    const text = words[cursor]?.text ?? ""
    if (text === "--") {
      cursor++
      break
    }
    if (!text.startsWith("-") || text.length === 1) break
    if (spec.valued.has(text)) cursor++
    cursor++
  }
  return cursor + spec.positionals
}

/** `env` options whose value is the next word. */
const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "-C", "--unset", "--chdir"])
/** An `env` flag cluster that ends in `-S`: `-S`, `-iS`, `-S'cmd'`. */
const ENV_SPLIT_OPTION = /^-[iv0]*S/
const ENV_SPLIT_LONG = "--split-string="

/**
 * `env -S <string>` splits the string into words and runs them, followed by
 * the words after it. The command it runs is those words joined, from the
 * string on.
 */
const envSplitWords = (
  words: ReadonlyArray<ShellWord>,
): Option.Option<ReadonlyArray<ShellWord>> => {
  if (commandName(words[0]?.text ?? "") !== "env") return Option.none()
  let valueNext = false
  for (const [index, word] of words.entries()) {
    const text = word.text
    const rest = words.slice(index + 1)
    if (index === 0 || valueNext) {
      valueNext = false
      continue
    }
    if (text === "--" || !text.startsWith("-")) return Option.none()
    if (text === "--split-string") return Option.some(rest)
    if (text.startsWith(ENV_SPLIT_LONG)) {
      return Option.some([wordFrom(word, ENV_SPLIT_LONG.length), ...rest])
    }
    const split = Option.fromNullishOr(ENV_SPLIT_OPTION.exec(text))
    if (Option.isSome(split)) {
      const after = split.value[0].length
      if (after === text.length) return Option.some(rest)
      return Option.some([wordFrom(word, after), ...rest])
    }
    valueNext = ENV_OPTIONS_WITH_VALUE.has(text)
  }
  return Option.none()
}

/**
 * One command a segment runs: its words from the command word on. Only a
 * word in command position is a command; the same name as an argument
 * (`grep bash`, `echo git commit`) is data.
 */
interface Invocation {
  readonly segment: ShellSegment
  readonly words: ReadonlyArray<ShellWord>
}

const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"])

/** The commands `words` runs: the first after env assignments, the one after each wrapper, and each `find -exec` command. */
const collectInvocations = (
  segment: ShellSegment,
  words: ReadonlyArray<ShellWord>,
  into: Array<Invocation>,
): void => {
  const start = words.findIndex((word) => !ASSIGNMENT.test(word.text))
  if (start === -1) return
  const command = words.slice(start)
  into.push({ segment, words: command })
  const name = commandName(command[0]?.text ?? "")
  const wrapper = Option.fromUndefinedOr(WRAPPERS.get(name))
  if (Option.isSome(wrapper)) {
    collectInvocations(segment, command.slice(prefixEnd(command, wrapper.value)), into)
  }
  if (name !== "find") return
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

/**
 * The input of a command in `segment`: a here-string, a heredoc body, the
 * arguments of an `echo`/`printf` piped into it, or the stdin of a bare `cat`
 * piped into it. The output of any other
 * command, and text a shell expands at run time, cannot be read.
 */
const segmentInputs = (segment: ShellSegment): SegmentRuns => {
  const scripts: Array<ShellWord> = [...segment.stdin]
  const unreadable: Array<string> = []
  if (Option.isSome(segment.pipedFrom)) {
    const from = segment.pipedFrom.value
    const name = commandName(from.words[0]?.text ?? "")
    // `cat` with no file prints its own stdin: `cat <<EOF | sh`.
    if (name === "cat" && from.words.length === 1) scripts.push(...from.stdin)
    else if (PRINTING_COMMANDS.has(name)) scripts.push(...from.words.slice(1))
    else unreadable.push(`the output of \`${name}\``)
  }
  for (const word of scripts) {
    if (word.dynamic) unreadable.push(`text expanded at run time: ${word.text}`)
  }
  return { scripts, unreadable }
}

/** A script file a shell or `source` runs: not read, unless it only exists at run time. */
const scriptFileRuns = (file: Option.Option<ShellWord>): SegmentRuns => {
  if (Option.exists(file, isProcessSubstitution)) {
    return { scripts: [], unreadable: ["a script from a process substitution"] }
  }
  return NO_RUNS
}

/**
 * A shell: the argument after `-c`, or its stdin when it has no script
 * argument. A script that is not a literal (`sh -c '{}'` under xargs,
 * `sh -c "$CMD"`) takes the input as the script, as a pipe into a shell
 * does. A script file is not read: its content is not in the command.
 */
const shellRuns = ({ segment, words }: Invocation): SegmentRuns => {
  let cursor = 1
  let fromArgument = false
  while (cursor < words.length && /^[-+]/.test(words[cursor]?.text ?? "")) {
    const option = words[cursor]?.text ?? ""
    if (SHELL_COMMAND_OPTION.test(option)) fromArgument = true
    if (SHELL_OPTIONS_WITH_VALUE.test(option)) cursor++
    cursor++
  }
  if (!fromArgument && cursor < words.length) {
    return scriptFileRuns(Option.fromUndefinedOr(words[cursor]))
  }
  if (!fromArgument) return segmentInputs(segment)
  const script = Option.fromUndefinedOr(words[cursor])
  const literal = Option.filter(script, (word) => !word.dynamic && !word.text.includes("{}"))
  if (Option.isSome(literal)) return { scripts: [literal.value], unreadable: [] }
  const inputs = segmentInputs(segment)
  let unreadable = inputs.unreadable
  if (inputs.scripts.length === 0 && unreadable.length === 0) {
    unreadable = ["a shell script that is not in the command"]
  }
  return { scripts: [...Option.toArray(script), ...inputs.scripts], unreadable }
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
 * has no command. The wrapped command is classified with its input when it
 * is a git command the guard checks. A shell under the wrapper reads its
 * input through `shellRuns`.
 */
const inputWrapperRuns = ({ segment, words }: Invocation, spec: Prefix): SegmentRuns => {
  const rest = words.slice(prefixEnd(words, spec))
  const separator = rest.findIndex((word) => word.text === ":::")
  let command = rest
  let listed: ReadonlyArray<ShellWord> = []
  if (separator !== -1) {
    command = rest.slice(0, separator)
    listed = rest.slice(separator + 1)
  }
  const commandTexts = command.map((word) => word.text)
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
  if (listed.length > 0) inputs = { scripts: listed, unreadable: [] }
  if (inputs.scripts.length === 0 && inputs.unreadable.length === 0) {
    return { scripts: [], unreadable: [`the input of \`${commandName(words[0]?.text ?? "")}\``] }
  }
  const input = inputs.scripts.map((word) => word.text).join(" ")
  let text = `${commandTexts.join(" ")} ${input}`
  if (commandTexts.some((word) => word.includes("{}")))
    text = commandTexts.join(" ").replaceAll("{}", input)
  const dynamic = inputs.scripts.some((word) => word.dynamic)
  return { scripts: [derivedWord(text, dynamic)], unreadable: inputs.unreadable }
}

/** Git global options whose value is the next word. */
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--attr-source",
])

/** The index of the subcommand word of a git invocation (`words[0]` is `git`). */
const gitSubcommandIndex = (words: ReadonlyArray<string>): Option.Option<number> => {
  let cursor = 1
  while (cursor < words.length && (words[cursor] ?? "").startsWith("-")) {
    if (GIT_OPTIONS_WITH_VALUE.has(words[cursor] ?? "")) cursor++
    cursor++
  }
  if (cursor < words.length) return Option.some(cursor)
  return Option.none()
}

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

/**
 * What a git invocation runs beyond its own words. `git -c alias.x=<value> x`
 * runs the value now, so it keeps its source offsets. `git config alias.x
 * <value>` stores the value for later runs in any session: it is classified
 * now, as a derived word that nothing rewrites. A subcommand known only at
 * run time (`git $(…)`) cannot be read.
 */
const gitRuns = ({ words }: Invocation): SegmentRuns => {
  const texts = words.map((word) => word.text)
  const scripts: Array<ShellWord> = []
  const unreadable: Array<string> = []
  const at = gitSubcommandIndex(texts)
  const end = Option.getOrElse(at, () => words.length)
  for (let index = 1; index < end; index++) {
    const value = Option.fromUndefinedOr(words[index + 1])
    const definition = Option.flatMap(value, (word) =>
      Option.fromNullishOr(/^alias\.[^=]+=/.exec(word.text)),
    )
    if (texts[index] === "-c" && Option.isSome(value) && Option.isSome(definition)) {
      scripts.push(aliasScript(wordFrom(value.value, definition.value[0].length)))
    }
  }
  if (Option.isNone(at)) return { scripts, unreadable }
  const subcommand = words[at.value]
  if (subcommand?.dynamic === true) {
    unreadable.push(`a git subcommand known only at run time: ${subcommand.text}`)
  }
  if (subcommand?.text !== "config") return { scripts, unreadable }
  for (let index = at.value + 1; index < words.length; index++) {
    const value = Option.fromUndefinedOr(words[index + 1])
    if (/^alias\.[^=]+$/.test(texts[index] ?? "") && Option.isSome(value)) {
      const stored = aliasScript(value.value)
      scripts.push(derivedWord(stored.text, stored.dynamic))
    }
  }
  return { scripts, unreadable }
}

/**
 * The scripts one command runs: the argument after a shell's `-c`, what a
 * shell with no script argument reads on stdin, the joined words of `eval`,
 * `ssh` and `watch`, the input of `xargs`/`parallel`, and git aliases.
 * Quoted text anywhere else, such as a commit message or `cat <<EOF` notes,
 * is data.
 */
const invocationRuns = (invocation: Invocation): SegmentRuns => {
  const name = invocationName(invocation)
  const { words } = invocation
  // `$(printf git) reset --hard`, `$G reset --hard`: the command itself is computed.
  if (words[0]?.dynamic === true) {
    return { scripts: [], unreadable: [`a command known only at run time: ${words[0].text}`] }
  }
  const split = envSplitWords(words)
  if (Option.isSome(split)) return joinedRuns(name, split.value)
  if (SHELL_NAMES.has(name)) return shellRuns(invocation)
  if (name === "source" || name === ".") {
    return scriptFileRuns(Option.fromUndefinedOr(invocation.words[1]))
  }
  if (name === "git") return gitRuns(invocation)
  const joiner = Option.fromUndefinedOr(SCRIPT_JOINERS.get(name))
  if (Option.isSome(joiner)) {
    return joinedRuns(name, words.slice(prefixEnd(words, joiner.value)))
  }
  const wrapper = Option.fromUndefinedOr(WRAPPERS.get(name))
  if ((name === "xargs" || name === "parallel") && Option.isSome(wrapper)) {
    return inputWrapperRuns(invocation, wrapper.value)
  }
  return NO_RUNS
}

const MAX_NESTED_COMMAND_DEPTH = 4

/** Every command of a command line and of the scripts it runs, and what could not be read. */
interface CommandView {
  readonly invocations: ReadonlyArray<Invocation>
  readonly unreadable: ReadonlyArray<string>
}

/** The commands of `segments` and of the scripts they run, up to `maxDepth` levels deep. */
const viewCommand = (segments: ReadonlyArray<ShellSegment>, maxDepth: number): CommandView => {
  const invocations: Array<Invocation> = []
  const unreadable: Array<string> = []
  for (const segment of segments) {
    const found: Array<Invocation> = []
    collectInvocations(segment, segment.words, found)
    invocations.push(...found)
    const runs = mergeRuns(found.map(invocationRuns))
    unreadable.push(...runs.unreadable)
    if (runs.scripts.length > 0 && maxDepth <= 0) unreadable.push("scripts nested too deep")
    if (maxDepth <= 0) continue
    for (const script of runs.scripts) {
      const nested = viewCommand(parseShell(script), maxDepth - 1)
      invocations.push(...nested.invocations)
      unreadable.push(...nested.unreadable)
    }
  }
  return { invocations, unreadable }
}

// ── command classification ──

/** The options and operands of one command (a git subcommand, `rm`, `npm`). */
interface ParsedArguments {
  /** Letters of every short option cluster (`-fd` holds `f` and `d`). */
  readonly shorts: ReadonlySet<string>
  /** Long option names as written, without `--` and `=value`. */
  readonly longs: ReadonlyArray<string>
  /** Operands before `--`. */
  readonly operands: ReadonlyArray<string>
  /** Operands after `--`. */
  readonly pathspecs: ReadonlyArray<string>
}

/** The options of a command that take the next word (or the rest of a short cluster) as a value. */
interface ValueOptions {
  readonly short?: string
  readonly long?: ReadonlyArray<string>
}

/**
 * Git reads any unambiguous prefix of a long option as that option
 * (`--ha` is `--hard`). A written name that is a prefix of `name` is read as
 * `name`. An ambiguous prefix makes git exit with an error, so reading it as
 * the risky option asks for approval of a command that would do nothing.
 */
const abbreviates = (written: string, name: string) =>
  written.length > 0 && name.startsWith(written)

/** Record one option word; returns true when the next word is its value. */
const readOption = (
  arg: string,
  valued: ValueOptions,
  shorts: Set<string>,
  longs: Array<string>,
): boolean => {
  if (arg.startsWith("--")) {
    const [name = ""] = arg.slice(2).split("=", 1)
    longs.push(name)
    return !arg.includes("=") && (valued.long ?? []).some((option) => abbreviates(name, option))
  }
  for (let at = 1; at < arg.length; at++) {
    const letter = arg.charAt(at)
    shorts.add(letter)
    // The rest of the cluster is the value; a bare letter takes the next word.
    if ((valued.short ?? "").includes(letter)) return at === arg.length - 1
  }
  return false
}

const parseArguments = (
  args: ReadonlyArray<string>,
  valued: ValueOptions = {},
): ParsedArguments => {
  const shorts = new Set<string>()
  const longs: Array<string> = []
  const operands: Array<string> = []
  let options = args
  let pathspecs: ReadonlyArray<string> = []
  const separator = args.indexOf("--")
  if (separator !== -1) {
    options = args.slice(0, separator)
    pathspecs = args.slice(separator + 1)
  }
  for (let index = 0; index < options.length; index++) {
    const arg = options[index] ?? ""
    if (arg.startsWith("-") && arg.length > 1) {
      if (readOption(arg, valued, shorts, longs)) index++
    } else {
      operands.push(arg)
    }
  }
  return { shorts, longs, operands, pathspecs }
}

const hasShort = (parsed: ParsedArguments, ...letters: ReadonlyArray<string>) =>
  letters.some((letter) => parsed.shorts.has(letter))

const hasLong = (parsed: ParsedArguments, ...names: ReadonlyArray<string>) =>
  parsed.longs.some((written) => names.some((name) => abbreviates(written, name)))

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

/** `kill -9`, `kill -KILL`, `kill -s KILL`. */
const killsHard = (args: ReadonlyArray<string>) =>
  args.some(
    (arg, index) =>
      KILL_SIGNALS.has(arg.replace(/^-/, "")) ||
      ((arg === "-s" || arg === "-n") && KILL_SIGNALS.has(args[index + 1] ?? "")),
  )

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

/** A command that writes, moves or deletes a key or secret file. */
const sensitiveRisk = (args: ReadonlyArray<string>): Option.Option<BashRisk> => {
  const parsed = parseArguments(args)
  for (const operand of [...parsed.operands, ...parsed.pathspecs]) {
    for (const [pattern, reason] of SENSITIVE_FILES) {
      if (pattern.test(operand)) return Option.some({ level: "sensitive", reason })
    }
  }
  return Option.none()
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

/** The first two operands name the action: `docker push`, `docker image push`, `yarn npm publish`. */
const actionIs = (args: ReadonlyArray<string>, action: string) =>
  parseArguments(args).operands.slice(0, 2).includes(action)

const externalWhen = (condition: boolean, reason: string) =>
  Option.filter(Option.some<BashRisk>({ level: "external", reason }), () => condition)

/** The risk of each command the guard checks, read from its words. */
const COMMAND_RISKS: ReadonlyMap<string, ReadonlyArray<CommandRisk>> = new Map([
  ...riskOf(["git"], gitRisk),
  ...riskOf(["rm"], rmRisk, sensitiveRisk),
  ...riskOf(["cp", "mv", "chmod", "chown", "tee"], sensitiveRisk),
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
  ...riskOf(["npm", "pnpm", "yarn", "bun", "cargo"], (args) =>
    externalWhen(actionIs(args, "publish"), "publishes a package"),
  ),
  ...riskOf(["docker"], (args) => externalWhen(actionIs(args, "push"), "docker push")),
  ...riskOf(["twine"], (args) => externalWhen(actionIs(args, "upload"), "twine upload")),
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
 * git alias). A script the guard cannot read asks, as a destructive command
 * does.
 */
export function classifyBashCommand(command: string): BashRisk {
  const view = viewCommand(parseCommand(command), MAX_NESTED_COMMAND_DEPTH)
  const risks: Array<BashRisk> = [
    ...view.invocations.flatMap(invocationRisks),
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

/** A session id bash reads as one plain word: the trailer needs no quoting at any depth. */
const SHELL_PLAIN_WORD = /^[\w.:@%+-]+$/

/**
 * Add the session trailer to each `git commit`, right after its `commit`
 * word, so it lands before any `--` pathspec. Commits are found from shell
 * words, so a message, a heredoc body or other quoted text that mentions
 * `git commit` is never changed. A commit that passes its own `--trailer`
 * keeps it. A commit in a script a shell runs (`bash -c '...'`, `$(...)`, a
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
    if (texts.slice(at.value + 1).some((arg) => arg.startsWith("--trailer"))) continue
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

// A job still marked running belongs to a process that is gone: mark it
// interrupted before the supervisor takes new work.
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
