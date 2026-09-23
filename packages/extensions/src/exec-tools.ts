import {
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

// ── git command classification ──
//
// Git commands are classified from shell words, not from the raw text, so
// global options (`git -c k=v push`), env prefixes, wrappers (`sudo`,
// `env`) and quoting (`"--force"`) cannot move a flag out of sight.

/**
 * Read a quoted run starting after the opening quote at `start`. Returns the
 * unquoted text and the index of the closing quote (or the end).
 */
const readQuoted = (command: string, start: number, quote: string) => {
  let text = ""
  let index = start
  for (; index < command.length; index++) {
    const char = command.charAt(index)
    if (char === quote) break
    if (quote === '"' && char === "\\" && index + 1 < command.length) {
      index++
      text += command.charAt(index)
    } else {
      text += char
    }
  }
  return { text, end: index }
}

/** Split a command into segments of shell words. Quotes are removed. */
function shellSegments(command: string): Array<Array<string>> {
  const segments: Array<Array<string>> = []
  let words: Array<string> = []
  let word = ""
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ""
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index)
    if (char === "$" && command.charAt(index + 1) === "'") {
      // ANSI-C quoting: `$'--hard'` is the word `--hard`.
      const quoted = readQuoted(command, index + 2, "'")
      word += quoted.text
      inWord = true
      index = quoted.end
    } else if (char === "'" || char === '"') {
      const quoted = readQuoted(command, index + 1, char)
      word += quoted.text
      inWord = true
      index = quoted.end
    } else if (char === "\\" && index + 1 < command.length) {
      index++
      word += command.charAt(index)
      inWord = true
    } else if (/[;&|\n()`]/.test(char)) {
      // Separators and subshell or substitution delimiters start a new
      // command: `$(git push -f)` and `(git push -f)` classify as commands.
      endSegment()
    } else if (/[\s<>]/.test(char)) {
      // A redirection ends the word: `--hard>/dev/null` is `--hard`.
      endWord()
    } else {
      word += char
      inWord = true
    }
  }
  endSegment()
  return segments
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

const FORCE_PUSH_TOKEN = /^(-[a-zA-Z]*f[a-zA-Z]*|--force.*|\+.+)$/
const DELETE_PUSH_TOKEN = /^(-[a-zA-Z]*d[a-zA-Z]*|--delete|--mirror|--prune|:.+)$/

/** A short option cluster (`-fb`) or long option that holds `short` or equals one of `long`. */
const hasOption = (args: ReadonlyArray<string>, short: string, ...long: ReadonlyArray<string>) =>
  args.some(
    (arg) => long.includes(arg) || (/^-[a-zA-Z]+$/.test(arg) && arg.slice(1).includes(short)),
  )

const destructive = (reason: string) => Option.some<BashRisk>({ level: "destructive", reason })

const destructiveWhen = (condition: boolean, reason: string): Option.Option<BashRisk> => {
  if (condition) return destructive(reason)
  return Option.none()
}

/** The risk of each git subcommand that can lose work or reach a remote. */
const GIT_SUBCOMMAND_RISKS = {
  push: (args: ReadonlyArray<string>): Option.Option<BashRisk> => {
    if (args.some((arg) => FORCE_PUSH_TOKEN.test(arg))) return destructive("git push --force")
    if (args.some((arg) => DELETE_PUSH_TOKEN.test(arg))) {
      return destructive("git push that can delete remote refs")
    }
    return Option.some({ level: "external", reason: "git push" })
  },
  reset: (args: ReadonlyArray<string>) =>
    destructiveWhen(args.includes("--hard"), "git reset --hard"),
  clean: () => destructive("git clean"),
  checkout: (args: ReadonlyArray<string>) =>
    destructiveWhen(
      args.includes("--") ||
        args.includes(".") ||
        args[0] === "-" ||
        hasOption(args, "f", "--force") ||
        hasOption(args, "p", "--patch"),
      "git checkout that discards working-tree changes",
    ),
  // `--staged` alone only unstages: the working-tree file keeps its edits.
  // Every other form (the default, `--worktree`) overwrites the working tree.
  restore: (args: ReadonlyArray<string>) =>
    destructiveWhen(
      !hasOption(args, "S", "--staged") || hasOption(args, "W", "--worktree"),
      "git restore (discards working-tree changes)",
    ),
  switch: (args: ReadonlyArray<string>) =>
    destructiveWhen(
      hasOption(args, "f", "--force", "--discard-changes"),
      "git switch --discard-changes",
    ),
  // `-D`, `-d --force` and `-f <branch> <commit>` all drop or move unmerged commits.
  branch: (args: ReadonlyArray<string>) =>
    destructiveWhen(
      hasOption(args, "D") || hasOption(args, "f", "--force"),
      "git branch -D/--force (can drop unmerged commits)",
    ),
  stash: (args: ReadonlyArray<string>) =>
    destructiveWhen(args[0] === "drop" || args[0] === "clear", `git stash ${args[0] ?? ""}`),
  add: (args: ReadonlyArray<string>) =>
    destructiveWhen(
      args.some((arg) => arg === "-A" || arg === "--all" || arg === "."),
      "git add everything (stages files other agents may own)",
    ),
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

/** Every git invocation in one segment: any `git` word starts one. */
const segmentGitRisks = (segment: ReadonlyArray<string>): Array<BashRisk> => {
  const risks: Array<BashRisk> = []
  for (let index = 0; index < segment.length; index++) {
    const word = segment[index] ?? ""
    if (word !== "git" && !word.endsWith("/git")) continue
    let cursor = index + 1
    while (cursor < segment.length && (segment[cursor] ?? "").startsWith("-")) {
      if (GIT_OPTIONS_WITH_VALUE.has(segment[cursor] ?? "")) cursor++
      cursor++
    }
    const subcommand = Option.fromUndefinedOr(segment[cursor])
    if (Option.isNone(subcommand)) continue
    const risk = gitSubcommandRisk(subcommand.value, segment.slice(cursor + 1))
    if (Option.isSome(risk)) risks.push(risk.value)
  }
  return risks
}

const MAX_NESTED_COMMAND_DEPTH = 4

/**
 * The strongest git risk in a command. A word that itself holds a command
 * (`bash -c '...'`, `eval "..."`, a quoted substitution) is classified too.
 */
function classifyGitCommands(command: string, depth = 0): Option.Option<BashRisk> {
  const risks: Array<BashRisk> = []
  for (const segment of shellSegments(command)) {
    risks.push(...segmentGitRisks(segment))
    if (depth >= MAX_NESTED_COMMAND_DEPTH) continue
    for (const word of segment) {
      if (!/[\s;&|()`]/.test(word)) continue
      const nested = classifyGitCommands(word, depth + 1)
      if (Option.isSome(nested)) risks.push(nested.value)
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

/**
 * Inject --trailer on git commit commands for session traceability.
 */
export function injectGitTrailers(cmd: string, sessionId: SessionId): string {
  // `git -C dir commit` and `git -c k=v commit` are commits too; every one gets the trailer.
  const gitCommit = /(\bgit(?:\s+-[cC]\s+\S+)*\s+commit)(?=\s|$)/g
  if (!gitCommit.test(cmd)) return cmd
  if (/--trailer/.test(cmd)) return cmd
  return cmd.replace(gitCommit, (commit) => `${commit} --trailer "Session-Id: ${sessionId}"`)
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
