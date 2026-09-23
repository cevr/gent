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
// Regex-based heuristic that flags destructive, external, and sensitive
// commands for one durable approval request per call. There are no saved
// rules: every flagged call asks, and a call with no answerer fails closed.

type BashRiskLevel = "safe" | "destructive" | "external" | "sensitive"

interface BashRisk {
  level: BashRiskLevel
  reason: string
}

const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-\w*[rf]\w*\s+|.*--recursive|.*--force)/, "rm with -r/-f flags"],
  [/\bdrop\s+table\b/i, "DROP TABLE"],
  [/\btruncate\s+table\b/i, "TRUNCATE TABLE"],
  [/\bkill\s+-9\b/, "kill -9"],
  [/\bpkill\b/, "pkill"],
  [/\bmkfs\b/, "mkfs (format filesystem)"],
  [/\bdd\s+if=/, "dd (raw disk write)"],
  [/\bsudo\s+rm\b/, "sudo rm"],
]

const EXTERNAL_PATTERNS: Array<[RegExp, string]> = [
  [/\bcurl\b.*\|\s*(ba)?sh\b/, "curl piped to shell"],
  [/\bwget\b.*\|\s*(ba)?sh\b/, "wget piped to shell"],
  [/\bnpm\s+publish\b/, "npm publish"],
  [/\bdocker\s+push\b/, "docker push"],
  [/\bpip\s+upload\b/, "pip upload"],
]

// Sensitive patterns only match write-context commands, not read-only tools
// like grep/rg/cat/less/head/tail that may reference these filenames. The
// exemption holds only when every segment of a compound command is read-only
// and nothing hides a second command in a substitution or heredoc.
const READ_ONLY_PREFIX = /^\s*(cat|less|head|tail|grep|rg|ag|ack|wc|file|stat|ls|bat|find)\b/
const SEGMENT_SEPARATOR = /;|&&|\|\|?|\n/
const HIDDEN_COMMAND = /\$\(|`|<<|\beval\b|\bxargs\b|-exec\b|-delete\b/
function isReadOnlyCommand(command: string): boolean {
  if (HIDDEN_COMMAND.test(command)) return false
  return command
    .split(SEGMENT_SEPARATOR)
    .filter((segment) => segment.trim() !== "")
    .every((segment) => READ_ONLY_PREFIX.test(segment))
}
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*\.env\b/, "modifies .env file"],
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*credentials/i, "modifies credentials"],
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*\bsecrets?\b/i, "modifies secrets"],
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*\bid_rsa\b/, "modifies SSH key"],
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*\.pem\b/, "modifies .pem file"],
  [/\b(cp|mv|rm|edit|write|chmod|chown)\b.*\.key\b/, "modifies .key file"],
]

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
  /** Source offset just past the word, closing quote included. */
  readonly end: number
}

interface ShellSegment {
  readonly words: Array<ShellWord>
  /** Here-strings and heredoc bodies: what the command reads on stdin. */
  readonly stdin: Array<ShellWord>
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
type WordRole = "argument" | "redirect-target" | "here-string" | "heredoc-delimiter"

/** Characters a backslash escapes inside double quotes. */
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\"])

/** The text being parsed and the segments found so far. */
interface ShellSource {
  readonly text: string
  /** Source offset of each character of `text`. */
  readonly map: ReadonlyArray<number>
  readonly segments: Array<ShellSegment>
}

/** The state of one command list: the top level, or the inside of `$(...)`, `(...)` or backticks. */
interface CommandReader {
  readonly source: ShellSource
  segment: ShellSegment
  wordText: string
  wordMap: Array<number>
  wordEnd: number
  inWord: boolean
  quoted: boolean
  role: WordRole
  stripTabs: boolean
  readonly heredocs: Array<PendingHeredoc>
}

const makeSegment = (pipedFrom: Option.Option<ShellSegment>): ShellSegment => ({
  words: [],
  stdin: [],
  pipedFrom,
})

const sourceOffset = (source: ShellSource, index: number) => source.map[index] ?? index

/** The characters `start` to `end` of the source as one word. */
const sourceWord = (source: ShellSource, start: number, end: number): ShellWord => {
  const map: Array<number> = []
  for (let index = start; index < end; index++) map.push(sourceOffset(source, index))
  return { text: source.text.slice(start, end), map, end: sourceOffset(source, end - 1) + 1 }
}

const addChar = (reader: CommandReader, index: number) => {
  reader.wordText += reader.source.text.charAt(index)
  reader.wordMap.push(sourceOffset(reader.source, index))
  reader.wordEnd = sourceOffset(reader.source, index) + 1
  reader.inWord = true
}

const addRange = (reader: CommandReader, start: number, end: number) => {
  for (let index = start; index < end && index < reader.source.text.length; index++) {
    addChar(reader, index)
  }
}

/** A quote character is part of the word but not of its text. */
const addQuote = (reader: CommandReader, index: number) => {
  if (index < reader.source.text.length) reader.wordEnd = sourceOffset(reader.source, index) + 1
  reader.inWord = true
  reader.quoted = true
}

const clearWord = (reader: CommandReader) => {
  reader.wordText = ""
  reader.wordMap = []
  reader.inWord = false
  reader.quoted = false
}

const endWord = (reader: CommandReader) => {
  if (reader.inWord) {
    const word: ShellWord = { text: reader.wordText, map: reader.wordMap, end: reader.wordEnd }
    if (reader.role === "argument") reader.segment.words.push(word)
    if (reader.role === "here-string") reader.segment.stdin.push(word)
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
  if (segment.words.length > 0 || segment.stdin.length > 0) reader.source.segments.push(segment)
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

/** Read a double-quoted run from `from`; returns the index of the closing quote. */
const readDoubleQuoted = (reader: CommandReader, from: number): number => {
  const text = reader.source.text
  let index = from
  while (index < text.length && text.charAt(index) !== '"') {
    const next = text.charAt(index + 1)
    if (text.charAt(index) === "\\" && next === "\n") {
      index += 2
    } else if (text.charAt(index) === "\\" && DOUBLE_QUOTE_ESCAPES.has(next)) {
      addChar(reader, index + 1)
      index += 2
    } else if (startsSubstitution(text, index)) {
      const end = readSubstitution(reader.source, index)
      addRange(reader, index, end)
      index = end
    } else {
      addChar(reader, index)
      index++
    }
  }
  return index
}

const readSingleQuoted = (reader: CommandReader, from: number): number => {
  let index = from
  while (index < reader.source.text.length && reader.source.text.charAt(index) !== "'") {
    addChar(reader, index)
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
    heredoc.segment.stdin.push(sourceWord(source, index, bodyEnd))
    if (heredoc.expands) readExpansions(source, index, bodyEnd)
    index = next
  }
  reader.heredocs.length = 0
  return index
}

/** A quoted run: `'…'`, `"…"`, and the ANSI-C and locale forms `$'…'` and `$"…"`. */
const readQuote = (reader: CommandReader, index: number): Option.Option<number> => {
  const text = reader.source.text
  let open = index
  if (text.charAt(index) === "$") open++
  const quote = text.charAt(open)
  if (quote !== "'" && quote !== '"') return Option.none()
  addQuote(reader, open)
  let close = open + 1
  if (quote === "'") close = readSingleQuoted(reader, close)
  else close = readDoubleQuoted(reader, close)
  addQuote(reader, close)
  return Option.some(close + 1)
}

/** A backslash escape, a line continuation, or a comment. */
const readEscape = (reader: CommandReader, index: number): Option.Option<number> => {
  const text = reader.source.text
  const char = text.charAt(index)
  if (char === "\\") {
    if (index + 1 < text.length && text.charAt(index + 1) !== "\n") addChar(reader, index + 1)
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
  addRange(reader, index, end)
  return Option.some(end)
}

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
  // `&>`, `&>>`, `>>`, `>|`, `>&`, `<&` and `<>` are one operator.
  if (op === "&>>") return start + 3
  if (/^(&>|>[>|&]|<[&>])/.test(op)) return start + 2
  return start + 1
}

/**
 * A redirection ends the word: `--hard>/dev/null` is `--hard`, and its target
 * is not an argument. A descriptor number (`2>`) belongs to the redirection.
 * `<(...)` and `>(...)` are process substitutions: their commands run.
 */
const readRedirection = (reader: CommandReader, index: number): Option.Option<number> => {
  const text = reader.source.text
  const char = text.charAt(index)
  const next = text.charAt(index + 1)
  if (char === "&" && next !== ">") return Option.none()
  if (char !== "<" && char !== ">" && char !== "&") return Option.none()
  if (next === "(" && char !== "&") {
    endWord(reader)
    return Option.some(readCommands(reader.source, index + 2, Option.some(")")))
  }
  if (reader.inWord && !reader.quoted && /^\d+$/.test(reader.wordText)) clearWord(reader)
  endWord(reader)
  return Option.some(readRedirectionOperator(reader, index))
}

/** Whitespace ends a word; any other character joins it. */
const readPlain = (reader: CommandReader, index: number): number => {
  if (/\s/.test(reader.source.text.charAt(index))) endWord(reader)
  else addChar(reader, index)
  return index + 1
}

const readStep = (reader: CommandReader, index: number): number =>
  readQuote(reader, index).pipe(
    Option.orElse(() => readEscape(reader, index)),
    Option.orElse(() => readSubstitutionWord(reader, index)),
    Option.orElse(() => readRedirection(reader, index)),
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
    wordEnd: 0,
    inWord: false,
    quoted: false,
    role: "argument",
    stripTabs: false,
    heredocs: [],
  }
  let index = from
  while (index < source.text.length) {
    const char = source.text.charAt(index)
    if (Option.exists(stop, (end) => end === char)) {
      endSegment(reader, false)
      return index + 1
    }
    index = readStep(reader, index)
  }
  endSegment(reader, false)
  return source.text.length
}

/**
 * Split `text` into command segments of shell words. `map` gives the source
 * offset of each character of `text`. Command substitutions, subshells and
 * process substitutions become segments of their own, because they run.
 */
const parseShell = (text: string, map: ReadonlyArray<number>): Array<ShellSegment> => {
  const source: ShellSource = { text, map, segments: [] }
  readCommands(source, 0, Option.none())
  return source.segments
}

const parseCommand = (command: string): Array<ShellSegment> =>
  parseShell(
    command,
    Array.from({ length: command.length }, (_, index) => index),
  )

const wordTexts = (segment: ShellSegment): Array<string> => segment.words.map((word) => word.text)

/** The words joined by single spaces: the command `eval` runs. */
const joinWords = (words: ReadonlyArray<ShellWord>): Option.Option<ShellWord> => {
  const last = Arr.last(words)
  if (Option.isNone(last)) return Option.none()
  const map: Array<number> = []
  for (const [index, word] of words.entries()) {
    if (index > 0) map.push(words[index - 1]?.end ?? word.end)
    map.push(...word.map)
  }
  return Option.some({ text: words.map((word) => word.text).join(" "), map, end: last.value.end })
}

const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh"])
/** Shell options whose value is the next word (`-o pipefail`). */
const SHELL_OPTIONS_WITH_VALUE = /^[-+][oO]$/
/** A short option cluster that holds `-c`: the script is the next argument. */
const SHELL_COMMAND_OPTION = /^-[a-zA-Z]*c[a-zA-Z]*$/

const commandName = (word: string): string => word.slice(word.lastIndexOf("/") + 1)

/**
 * The scripts a segment runs: the argument after a shell's `-c`, the words of
 * `eval`, and what a shell with no script argument reads on stdin (a
 * here-string, a heredoc body, the words piped into it). Quoted text anywhere
 * else, such as a commit message or `cat <<EOF` notes, is data. A pipe into a
 * shell runs whatever the command before it prints, so every word of that
 * command counts: `echo 'git push -f' | sh` asks.
 */
const segmentScripts = (segment: ShellSegment): ReadonlyArray<ShellWord> => {
  const words = segment.words
  for (let index = 0; index < words.length; index++) {
    const name = commandName(words[index]?.text ?? "")
    if (name === "eval") return Option.toArray(joinWords(words.slice(index + 1)))
    if (!SHELL_NAMES.has(name)) continue
    let cursor = index + 1
    let fromArgument = false
    while (cursor < words.length && /^[-+]/.test(words[cursor]?.text ?? "")) {
      const option = words[cursor]?.text ?? ""
      if (SHELL_COMMAND_OPTION.test(option)) fromArgument = true
      if (SHELL_OPTIONS_WITH_VALUE.test(option)) cursor++
      cursor++
    }
    if (fromArgument) return Option.toArray(Option.fromUndefinedOr(words[cursor]))
    // A script file: its content is not in the command.
    if (cursor < words.length) return []
    const piped = Option.match(segment.pipedFrom, {
      onNone: (): ReadonlyArray<ShellWord> => [],
      onSome: (from) => from.words,
    })
    return [...segment.stdin, ...piped]
  }
  return []
}

const MAX_NESTED_COMMAND_DEPTH = 4

/** Every segment of a command and of the scripts it runs, up to `maxDepth` levels deep. */
const commandSegments = (
  segments: ReadonlyArray<ShellSegment>,
  maxDepth: number,
): Array<ShellSegment> => {
  const all: Array<ShellSegment> = [...segments]
  if (maxDepth <= 0) return all
  for (const segment of segments) {
    for (const script of segmentScripts(segment)) {
      all.push(...commandSegments(parseShell(script.text, script.map), maxDepth - 1))
    }
  }
  return all
}

// ── git command classification ──

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

/** The index of the subcommand word of each git invocation. Any `git` word starts one. */
const gitSubcommandIndexes = (words: ReadonlyArray<string>): Array<number> => {
  const indexes: Array<number> = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? ""
    if (word !== "git" && !word.endsWith("/git")) continue
    let cursor = index + 1
    while (cursor < words.length && (words[cursor] ?? "").startsWith("-")) {
      if (GIT_OPTIONS_WITH_VALUE.has(words[cursor] ?? "")) cursor++
      cursor++
    }
    if (cursor < words.length) indexes.push(cursor)
  }
  return indexes
}

/** The options and operands of one git subcommand. */
interface GitArguments {
  /** Letters of every short option cluster (`-fd` holds `f` and `d`). */
  readonly shorts: ReadonlySet<string>
  /** Long option names as written, without `--` and `=value`. */
  readonly longs: ReadonlyArray<string>
  /** Operands before `--`. */
  readonly operands: ReadonlyArray<string>
  /** Operands after `--`. */
  readonly pathspecs: ReadonlyArray<string>
}

/** The options of a subcommand that take the next word (or the rest of a short cluster) as a value. */
interface GitValueOptions {
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
const readGitOption = (
  arg: string,
  valued: GitValueOptions,
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

const parseGitArguments = (
  args: ReadonlyArray<string>,
  valued: GitValueOptions = {},
): GitArguments => {
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
      if (readGitOption(arg, valued, shorts, longs)) index++
    } else {
      operands.push(arg)
    }
  }
  return { shorts, longs, operands, pathspecs }
}

const hasShort = (parsed: GitArguments, ...letters: ReadonlyArray<string>) =>
  letters.some((letter) => parsed.shorts.has(letter))

const hasLong = (parsed: GitArguments, ...names: ReadonlyArray<string>) =>
  parsed.longs.some((written) => names.some((name) => abbreviates(written, name)))

const destructive = (reason: string) => Option.some<BashRisk>({ level: "destructive", reason })

const destructiveWhen = (condition: boolean, reason: string): Option.Option<BashRisk> => {
  if (condition) return destructive(reason)
  return Option.none()
}

/** The risk of each git subcommand that can lose work or reach a remote. */
const GIT_SUBCOMMAND_RISKS = {
  push: (args: ReadonlyArray<string>): Option.Option<BashRisk> => {
    const parsed = parseGitArguments(args, {
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
    destructiveWhen(hasLong(parseGitArguments(args), "hard"), "git reset --hard"),
  clean: (args: ReadonlyArray<string>) => {
    const parsed = parseGitArguments(args, { short: "e", long: ["exclude"] })
    return destructiveWhen(!hasShort(parsed, "n") && !hasLong(parsed, "dry-run"), "git clean")
  },
  // A branch switch (`git checkout main`, `-b feat origin/main`) keeps work.
  // Paths do not: a tree-ish plus a path, `--ours`/`--theirs`, a merge
  // checkout, or a force. `-B` resets an existing branch. One bare word stays
  // safe: the classifier cannot tell a path from a branch without the file
  // system.
  checkout: (args: ReadonlyArray<string>) => {
    const parsed = parseGitArguments(args, {
      short: "bB",
      long: ["orphan", "conflict", "pathspec-from-file"],
    })
    return destructiveWhen(
      parsed.pathspecs.length > 0 ||
        parsed.operands.includes(".") ||
        args[0] === "-" ||
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
    const parsed = parseGitArguments(args, {
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
    const parsed = parseGitArguments(args, { short: "u", long: ["set-upstream-to"] })
    return destructiveWhen(
      hasShort(parsed, "D", "M", "C", "f") || hasLong(parsed, "force"),
      "git branch -D/-M/-C/--force (can drop or overwrite a branch)",
    )
  },
  stash: (args: ReadonlyArray<string>) => {
    const action = parseGitArguments(args, { short: "m", long: ["message"] }).operands[0] ?? ""
    return destructiveWhen(action === "drop" || action === "clear", `git stash ${action}`)
  },
  worktree: (args: ReadonlyArray<string>) => {
    const parsed = parseGitArguments(args)
    return destructiveWhen(
      parsed.operands[0] === "remove" && (hasShort(parsed, "f") || hasLong(parsed, "force")),
      "git worktree remove --force (discards the worktree's changes)",
    )
  },
  add: (args: ReadonlyArray<string>) => {
    const parsed = parseGitArguments(args)
    return destructiveWhen(
      hasShort(parsed, "A") ||
        hasLong(parsed, "all") ||
        [...parsed.operands, ...parsed.pathspecs].includes("."),
      "git add everything (stages files other agents may own)",
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

/**
 * The strongest git risk in a command and in every script it runs
 * (`bash -c '...'`, `eval "..."`, `$(...)`, a heredoc fed to a shell).
 */
function classifyGitCommands(command: string): Option.Option<BashRisk> {
  const risks: Array<BashRisk> = []
  for (const segment of commandSegments(parseCommand(command), MAX_NESTED_COMMAND_DEPTH)) {
    const words = wordTexts(segment)
    for (const index of gitSubcommandIndexes(words)) {
      const risk = gitSubcommandRisk(words[index] ?? "", words.slice(index + 1))
      if (Option.isSome(risk)) risks.push(risk.value)
    }
  }
  return Option.fromUndefinedOr(risks.find((risk) => risk.level === "destructive")).pipe(
    Option.orElse(() => Option.fromUndefinedOr(risks[0])),
  )
}

export function classifyBashCommand(command: string): BashRisk {
  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return { level: "destructive", reason }
  }
  const git = classifyGitCommands(command)
  if (Option.isSome(git)) return git.value
  for (const [pattern, reason] of EXTERNAL_PATTERNS) {
    if (pattern.test(command)) return { level: "external", reason }
  }
  if (!isReadOnlyCommand(command)) {
    for (const [pattern, reason] of SENSITIVE_PATTERNS) {
      if (pattern.test(command)) return { level: "sensitive", reason }
    }
  }
  return SAFE_RISK
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
})

/** Lines a stream printed; a trailing newline ends a line, it does not start one. */
const outputLineCount = (text: string): number => {
  if (text.length === 0) return 0
  return text.replace(/\n$/, "").split("\n").length
}

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
 * keeps it. A commit in a script a shell runs (`bash -c '...'`, `$(...)`)
 * gets the trailer too, when the id needs no quoting there.
 */
export function injectGitTrailers(cmd: string, sessionId: SessionId): string {
  let trailer = `--trailer=Session-Id:${sessionId}`
  let maxDepth = MAX_NESTED_COMMAND_DEPTH
  if (!SHELL_PLAIN_WORD.test(sessionId)) {
    trailer = `'--trailer=Session-Id: ${sessionId.replaceAll("'", `'\\''`)}'`
    maxDepth = 0
  }
  const offsets = new Set<number>()
  for (const segment of commandSegments(parseCommand(cmd), maxDepth)) {
    const words = wordTexts(segment)
    for (const index of gitSubcommandIndexes(words)) {
      if (words[index] !== "commit") continue
      if (words.slice(index + 1).some((arg) => arg.startsWith("--trailer"))) continue
      const word = Option.fromUndefinedOr(segment.words[index])
      if (Option.isSome(word)) offsets.add(word.value.end)
    }
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
  summary: (_input, output) =>
    `exit ${output.exitCode} · ${countOf(outputLineCount(output.stdout) + outputLineCount(output.stderr), "line")}`,
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
        return {
          stdout: `Command blocked: ${risk.reason}`,
          stderr: "",
          exitCode: 1,
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
