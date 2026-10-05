import {
  Branch,
  BranchId,
  dateFromMillis,
  type ExtensionHealthIssue,
  type ExtensionHealthSnapshot,
  Message,
  MessageId,
  Session,
  SessionId,
  ToolCallId,
} from "@gent/core/protocol"
import {
  Array as Arr,
  Cause,
  Clock,
  Config,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Match,
  Option,
  Path,
  type PlatformError,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect"
import {
  classifyLogFile,
  dataPaths,
  Gent,
  serverLock,
  type ServerLockEntry,
  type ServerLockStatus,
} from "@gent/sdk"
import { BranchStorage, GentPlatform, MessageStorage, SessionStorage } from "@gent/core/host"
import * as Prompt from "effect/ai/Prompt"
import { Argument, Command, Flag } from "effect/cli"
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  type HttpClientResponse,
} from "effect/http"
import { runProcess } from "@gent/core/extensions/api"
import { readonlySqlite, textWidth } from "./bun-adapter"
import { formatBytes, isConversation, padWidth } from "./utils"
import * as Terminal from "effect/Terminal"

// ── local health report ─────────────────────────────────────────────────────

const STORAGE_TABLES = [
  "sessions",
  "branches",
  "messages",
  "events",
] satisfies ReadonlyArray<string>

interface StorageHealth {
  readonly dbPath: string
  readonly exists: boolean
  readonly sizeBytes: number
  readonly migrationTable: "missing" | "present"
  readonly migrationCount: number
  readonly existingStorageTables: ReadonlyArray<string>
  readonly status: "missing" | "ok" | "incompatible" | "unreadable"
  readonly error?: string
}

interface ServerHealth {
  readonly status: "none" | "alive" | "dead"
  readonly summary: string
}

interface LogHealth {
  readonly dir: string
  readonly latestServer?: string
  readonly latestClient?: string
}

interface ExtensionDoctorHealth {
  readonly status: "unavailable" | "healthy" | "degraded" | "error"
  readonly summary: string
  readonly snapshot?: ExtensionHealthSnapshot
  readonly error?: string
}

interface DoctorReport {
  readonly home: string
  readonly storage: StorageHealth
  readonly server: ServerHealth
  readonly logs: LogHealth
  readonly extensions: ExtensionDoctorHealth
}

interface StorageResetResult {
  readonly archiveDir?: string
  readonly archived: ReadonlyArray<string>
}

type SqliteHealth = Omit<StorageHealth, "dbPath" | "exists" | "sizeBytes">

const decodeTableRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String })),
)
const decodeCountRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ count: Schema.Finite })),
)

const readSqliteHealth = (dbPath: string): Effect.Effect<SqliteHealth> =>
  Effect.gen(function* () {
    const rows = yield* readonlySqlite(dbPath)
    const tables = (yield* decodeTableRows(
      yield* rows("SELECT name FROM sqlite_master WHERE type = 'table'"),
    )).map((row) => row.name)
    let migrationTable: StorageHealth["migrationTable"] = "missing"
    if (tables.includes("gent_storage_migrations")) migrationTable = "present"
    let migrationCount = 0
    if (migrationTable === "present") {
      const counted = yield* decodeCountRows(
        yield* rows("SELECT COUNT(*) AS count FROM gent_storage_migrations"),
      )
      migrationCount = Option.getOrElse(
        Option.map(Option.fromNullishOr(counted[0]), (row) => row.count),
        () => 0,
      )
    }
    const existingStorageTables = STORAGE_TABLES.filter((table) => tables.includes(table))
    const incompatible = existingStorageTables.length > 0 && migrationCount === 0
    let status: StorageHealth["status"] = "ok"
    if (incompatible) status = "incompatible"
    return {
      migrationTable,
      migrationCount,
      existingStorageTables,
      status,
    } satisfies SqliteHealth
  }).pipe(
    Effect.scoped,
    Effect.catchEager((error) =>
      Effect.succeed({
        migrationTable: "missing",
        migrationCount: 0,
        existingStorageTables: [],
        status: "unreadable",
        error: String(error),
      } satisfies SqliteHealth),
    ),
  )

export const inspectStorage = (
  home: string,
): Effect.Effect<StorageHealth, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { dbPath } = yield* dataPaths(home)
    const exists = yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return {
        dbPath,
        exists: false,
        sizeBytes: 0,
        migrationTable: "missing",
        migrationCount: 0,
        existingStorageTables: [],
        status: "missing",
      }
    }

    const stat = yield* fs.stat(dbPath).pipe(Effect.orDie)
    return {
      dbPath,
      exists: true,
      sizeBytes: Number(stat.size),
      ...(yield* readSqliteHealth(dbPath)),
    }
  })

/**
 * Read a log directory. The doctor passes the one this environment writes to
 * (`dataPaths(home).logDir`); tests pass a directory they own, so they never read or
 * remove real logs.
 */
export const inspectLogs = (dir: string): Effect.Effect<LogHealth, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return { dir }

    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
    const entries = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const path = `${dir}/${name}`
        const stat = yield* fs.stat(path).pipe(Effect.option)
        let mtimeMs = 0
        if (stat._tag === "Some" && stat.value.mtime._tag === "Some") {
          mtimeMs = stat.value.mtime.value.getTime()
        }
        return { path, name, mtimeMs }
      }),
    )
    const sorted = entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    // The SDK writes these names, so it also says which side wrote one.
    const latest = (side: "server" | "client") =>
      Option.getOrUndefined(
        Option.map(
          Option.fromUndefinedOr(
            sorted.find((entry) => Option.contains(classifyLogFile(entry.name), side)),
          ),
          (entry) => entry.path,
        ),
      )

    return {
      dir,
      latestServer: latest("server"),
      latestClient: latest("client"),
    }
  })

/** The doctor's server line: the one server a data directory has, read from its kernel lock. */
export const inspectServer = (status: ServerLockStatus): ServerHealth => {
  if (status._tag === "None")
    return { status: "none", summary: "No server for this data directory." }
  if (status._tag === "Unnamed") {
    return {
      status: "alive",
      summary: "A process holds the server lock but has not named itself yet (still starting?)",
    }
  }
  const { pid, serverId, rpcUrl } = status.entry
  if (status._tag === "Alive") {
    return { status: "alive", summary: `Server alive: pid ${pid}, ${serverId}, ${rpcUrl}` }
  }
  return { status: "dead", summary: `Server lock is stale: pid ${pid}, ${serverId}` }
}

const extensionHealthUnavailable = (summary: string): ExtensionDoctorHealth => ({
  status: "unavailable",
  summary,
})

const extensionHealthError = (error: string): ExtensionDoctorHealth => ({
  status: "error",
  summary: "Extension health query failed.",
  error,
})

export const extensionHealthFromSnapshot = (
  snapshot: ExtensionHealthSnapshot,
): ExtensionDoctorHealth => {
  if (snapshot._tag === "Healthy") {
    let suffix = "s"
    if (snapshot.extensions.length === 1) suffix = ""
    return {
      status: "healthy",
      summary: `healthy (${snapshot.extensions.length} active extension${suffix})`,
      snapshot,
    }
  }

  return {
    status: "degraded",
    summary: `degraded (${snapshot.degradedExtensions.length} degraded, ${snapshot.healthyExtensions.length} healthy)`,
    snapshot,
  }
}

export const makeDoctorReport = (
  home: string,
  serverStatus: ServerLockStatus,
  extensions: ExtensionDoctorHealth,
): Effect.Effect<DoctorReport, never, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const storage = yield* inspectStorage(home)
    return {
      home,
      storage,
      server: inspectServer(serverStatus),
      logs: yield* inspectLogs((yield* dataPaths(home)).logDir),
      extensions,
    }
  })

const stamp = () =>
  DateTime.formatIso(DateTime.nowUnsafe())
    .replace(/[-:T.]/g, "")
    .slice(0, 14)

const basename = (path: string): string =>
  Option.getOrElse(Option.fromNullishOr(path.split("/").filter(Boolean).at(-1)), () => path)

/**
 * `storage reset` moves the database and its sidecars away. It owns the
 * database as a server start does, from the first look at the files to the
 * last move, so no server opens them in between; while a server holds the
 * database, it refuses.
 */
export const resetStorage = (
  home: string,
): Effect.Effect<StorageResetResult, CliStartupError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const owned = yield* serverLock
      .hold(home)
      .pipe(
        Effect.mapError((error) => new CliStartupError({ message: error.message, cause: error })),
      )
    if (!owned) {
      return yield* new CliStartupError({
        message:
          "a server is running for this data directory; stop it with `gent server stop` first",
      })
    }
    const fs = yield* FileSystem.FileSystem
    const paths = yield* dataPaths(home)
    const existing = []
    for (const file of paths.files) {
      if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        existing.push(file)
      }
    }
    if (existing.length === 0) return { archived: [] }

    const archiveDir = `${paths.archiveDir}/${stamp()}`
    yield* fs.makeDirectory(archiveDir, { recursive: true }).pipe(Effect.orDie)
    const archived: string[] = []
    for (const file of existing) {
      const target = `${archiveDir}/${basename(file)}`
      yield* fs.rename(file, target).pipe(Effect.orDie)
      archived.push(target)
    }
    return { archiveDir, archived }
  }).pipe(Effect.scoped)

const formatIssue = (issue: ExtensionHealthIssue): string =>
  Match.value(issue).pipe(
    Match.tagsExhaustive({
      ActivationFailed: (issue) =>
        `activation failed during ${issue.phase}: ${issue.error}${Option.match(
          Option.fromUndefinedOr(issue.runningVersion),
          { onNone: () => "", onSome: (version) => `; version ${version.slice(0, 12)} still runs` },
        )}`,
      ModelCatalogFailed: (issue) =>
        `model driver ${issue.driverId} could not list its models: ${issue.error}`,
    }),
  )

const formatExtensions = (extensions: ExtensionDoctorHealth): ReadonlyArray<string> => {
  const lines = [`  Status: ${extensions.summary}`]
  const error = Option.fromNullishOr(extensions.error)
  if (Option.isSome(error)) lines.push(`  Error: ${error.value}`)
  const snapshot = Option.fromNullishOr(extensions.snapshot)
  if (Option.isNone(snapshot)) return lines
  const disabled = snapshot.value.disabledExtensions ?? []
  if (disabled.length > 0) {
    lines.push(`  Disabled: ${disabled.map((extension) => extension.manifest.id).join(", ")}`)
  }
  if (snapshot.value._tag !== "Degraded") return lines

  for (const extension of snapshot.value.degradedExtensions) {
    lines.push(`  ${extension.manifest.id}:`)
    for (const issue of extension.issues) {
      lines.push(`    - ${formatIssue(issue)}`)
    }
  }

  return lines
}

export const formatDoctorReport = (report: DoctorReport): string => {
  const storage = report.storage
  let storageLine = `missing (${storage.dbPath})`
  if (storage.status !== "missing") {
    storageLine = `${storage.status} (${storage.dbPath}, ${formatBytes(storage.sizeBytes)}, migrations: ${storage.migrationCount})`
  }
  let tableLine = "none"
  if (storage.existingStorageTables.length > 0) {
    tableLine = storage.existingStorageTables.join(", ")
  }

  const lines = [
    "Gent doctor",
    "",
    `Home: ${report.home}`,
    "",
    "Storage:",
    `  DB: ${storageLine}`,
    `  Migration table: ${storage.migrationTable}`,
    `  Existing storage tables: ${tableLine}`,
  ]
  const error = Option.fromNullishOr(storage.error)
  if (Option.isSome(error)) lines.push(`  Error: ${error.value}`)
  lines.push(
    "",
    "Server:",
    `  ${report.server.summary}`,
    "",
    "Extensions:",
    ...formatExtensions(report.extensions),
    "",
    "Logs:",
    `  Directory: ${report.logs.dir}`,
    `  Latest server: ${Option.getOrElse(Option.fromNullishOr(report.logs.latestServer), () => "none")}`,
    `  Latest client: ${Option.getOrElse(Option.fromNullishOr(report.logs.latestClient), () => "none")}`,
  )
  return lines.join("\n")
}

// ── debug session ───────────────────────────────────────────────────────────

/**
 * `gent --debug` starts an in-memory server seeded with one sample session:
 * a transcript with the shipped tools' calls and results, the reader's
 * prompts and a steer, delegate rows, and a child's report and completion,
 * so the session view renders every surface without a live model.
 */

type DebugValue = Schema.Json

const makeText = (text: string) => Prompt.textPart({ text })

const asToolCallId = (value: string) => ToolCallId.make(value)

const makeJsonResult = (toolCallId: ToolCallId, toolName: string, value: DebugValue) =>
  Prompt.toolResultPart({
    id: toolCallId,
    name: toolName,
    isFailure: false,
    providerExecuted: false,
    result: value,
  })

const makeToolCall = (params: {
  readonly id: ToolCallId
  readonly name: string
  readonly params: DebugValue
}) => Prompt.toolCallPart({ ...params, providerExecuted: false })

const writeDebugSession = Effect.fn("DebugSession.seed")(function* (cwd: string) {
  const sessions = yield* SessionStorage
  const branches = yield* BranchStorage
  const messages = yield* MessageStorage
  const platform = yield* GentPlatform
  const sessionId = SessionId.make(yield* platform.randomId)
  const branchId = BranchId.make(yield* platform.randomId)
  const now = yield* Clock.currentTimeMillis
  const nowPlus = (offsetMs: number) => dateFromMillis(now + offsetMs)

  const session = new Session({
    id: sessionId,
    name: "debug scenario",
    cwd,
    createdAt: nowPlus(-60_000),
    updatedAt: nowPlus(-1_000),
  })
  const branch = new Branch({
    id: branchId,
    sessionId,
    createdAt: nowPlus(-60_000),
  })

  yield* sessions.createSession(session)
  yield* branches.createBranch(branch)
  yield* sessions.setActiveBranch(sessionId, branchId, session.updatedAt)

  const user1 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "user",
    parts: [makeText("Review the TUI renderer cleanup and inspect the current implementation.")],
    metadata: { fromClient: true },
    createdAt: nowPlus(-50_000),
  })

  const assistant1 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "assistant",
    parts: [
      Prompt.reasoningPart({
        text: "Need tool chrome parity, queue semantics, and child agent rows.",
      }),
      makeText("Inspected the relevant files and compared the renderer chrome paths."),
      makeToolCall({
        id: asToolCallId("dbg-read"),
        name: "read",
        params: { path: `${cwd}/apps/tui/src/session.tsx` },
      }),
      makeToolCall({
        id: asToolCallId("dbg-grep"),
        name: "grep",
        params: { pattern: "ToolFrame", path: `${cwd}/apps/tui/src` },
      }),
      makeToolCall({
        id: asToolCallId("dbg-bash"),
        name: "bash",
        params: { command: "bun run typecheck" },
      }),
      makeToolCall({
        id: asToolCallId("dbg-edit"),
        name: "edit",
        params: {
          path: `${cwd}/apps/tui/src/message-list.tsx`,
          oldString: "<text>[ x ] tool_call</text>",
          newString: "<ToolFrame />",
        },
      }),
      makeToolCall({
        id: asToolCallId("dbg-write"),
        name: "write",
        params: {
          path: `${cwd}/apps/tui/src/ops.ts`,
          content: "export const debugScenario = true\n",
        },
      }),
    ],
    createdAt: nowPlus(-47_000),
  })

  const toolResults1 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "tool",
    parts: [
      makeJsonResult(asToolCallId("dbg-read"), "read", {
        path: `${cwd}/apps/tui/src/session.tsx`,
        lineCount: 18,
        truncated: false,
        content:
          "const [toolsExpanded, setToolsExpanded] = createSignal(false)\nconst [composerState, setComposerState] = createSignal(...)",
      }),
      makeJsonResult(asToolCallId("dbg-grep"), "grep", {
        matches: [
          {
            file: `${cwd}/apps/tui/src/tool-renderers.tsx`,
            line: 6,
            content: 'import { GutterText, ToolCallIdentityProvider, ToolFrame } from "./ui"',
          },
        ],
        truncated: false,
      }),
      makeJsonResult(asToolCallId("dbg-bash"), "bash", {
        stdout: "$ turbo run typecheck\nTodos: 4 successful, 4 total",
        stderr: "",
        exitCode: 0,
      }),
      makeJsonResult(asToolCallId("dbg-edit"), "edit", {
        path: `${cwd}/apps/tui/src/message-list.tsx`,
        replacements: 1,
      }),
      makeJsonResult(asToolCallId("dbg-write"), "write", {
        path: `${cwd}/apps/tui/src/ops.ts`,
        bytesWritten: 7421,
      }),
    ],
    createdAt: nowPlus(-46_000),
  })

  const assistant2 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "assistant",
    parts: [makeText("The duplicate chrome came from rendering both tool summary surfaces.")],
    createdAt: nowPlus(-45_000),
  })

  const user2 = Message.cases.interjection.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "user",
    parts: [makeText("Actually check queue vs steer too.")],
    metadata: { fromClient: true },
    createdAt: nowPlus(-38_000),
  })

  const assistant3 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "assistant",
    parts: [
      makeText(
        "Steer should cut ahead of queued regular work. Regular sends queue in order while a turn is active.",
      ),
    ],
    createdAt: nowPlus(-36_000),
  })

  const user3 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "user",
    parts: [makeText("Read the related session and review the audit output.")],
    metadata: { fromClient: true },
    createdAt: nowPlus(-28_000),
  })

  const assistant4 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "assistant",
    parts: [
      makeText("Pulled adjacent context and kicked off review helpers."),
      makeToolCall({
        id: asToolCallId("dbg-explore"),
        name: "delegate.start",
        params: { todo: "Where is the double-border coming from?" },
      }),
      makeToolCall({
        id: asToolCallId("dbg-review"),
        name: "delegate.start",
        params: { todo: "Sanity-check the debug session bootstrap.", context: "fork" },
      }),
      makeToolCall({
        id: asToolCallId("dbg-read-session"),
        name: "read_session",
        params: { sessionId: "019debug1-session" },
      }),
    ],
    createdAt: nowPlus(-25_000),
  })

  const toolResults2 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "tool",
    parts: [
      makeJsonResult(asToolCallId("dbg-explore"), "delegate.start", {
        requestId: "dbg-explore",
        sessionId: "019debe1-0e493eaf",
        branchId: "019debe1-0e493eaf-branch",
      }),
      makeJsonResult(asToolCallId("dbg-review"), "delegate.start", {
        requestId: "dbg-review",
        sessionId: "019debug1-review",
        branchId: "019debug1-review-branch",
      }),
      makeJsonResult(asToolCallId("dbg-read-session"), "read_session", {
        sessionId: "019debug1-session",
        content: "Audit said queue semantics and renderer chrome should be tested together.",
        messageCount: 12,
        branchCount: 1,
      }),
    ],
    createdAt: nowPlus(-23_000),
  })

  const assistant5 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "assistant",
    parts: [
      makeText(
        "Audit lines up: keep one tool frame, make queue state structural, and test renderer behavior directly.",
      ),
    ],
    createdAt: nowPlus(-21_000),
  })

  // The explore child's report and its completion, as the session tools and
  // the delegate store them: the TUI host reads no extension module, so the
  // custom types and the header the model reads are written out here.
  const explore = {
    sessionId: "019debe1-0e493eaf",
    branchId: "019debe1-0e493eaf-branch",
    name: "explore",
    relation: "child",
  }
  const childReport = Message.cases.interjection.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "user",
    parts: [
      makeText(
        [
          `Message from your child "${explore.name}" (session ${explore.sessionId}):`,
          "A child's completion arrives as its own child-completion message; this message is not one.",
          "",
          "The double border comes from two surfaces drawing one tool summary.",
          "message-list.tsx draws the group header for the run,",
          "and the cell renderer drew its own frame header inside it.",
          "Checked apps/tui/src/tool-renderers.tsx: ToolFrameBody hides one header only.",
          "A frame nested in a body draws its header again, by design.",
          "So the second border is the nested frame, not a stray box.",
          "Removing the outer header would lose the run's counts.",
          "Removing the inner one loses the op's own subject line.",
          "The fix that keeps both: fold consecutive ops of one tool.",
          "That is FoldOperationsProvider, already on outside the transcript view.",
          "I am checking whether the debug seed bypasses it next.",
          "No edits made; this is a read-only report.",
        ].join("\n"),
      ),
    ],
    metadata: {
      customType: "session-message",
      extensionId: "@gent/session-tools",
      details: { from: explore },
    },
    createdAt: nowPlus(-18_000),
  })

  const childCompletion = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "user",
    parts: [
      makeText(
        [
          `Child agent "explore" completed. requestId dbg-explore; session ${explore.sessionId}; branch ${explore.branchId}.`,
          "Completion is a turn receipt, not task success. Read the output before relying on it.",
          "",
          "The double border is a nested ToolFrame inside the cell body.",
          "FoldOperationsProvider folds consecutive ops of one tool into one frame.",
          "The transcript view turns folding off on purpose: it is the raw view.",
          "No change needed; the inline view already folds.",
          "Evidence: apps/tui/src/tool-renderers.tsx and apps/tui/src/ui.tsx.",
          "Read 4 files, searched 2 patterns.",
        ].join("\n"),
      ),
    ],
    metadata: {
      customType: "child-completion",
      extensionId: "@gent/delegate",
      details: {
        requestId: "dbg-explore",
        sessionId: explore.sessionId,
        branchId: explore.branchId,
        agentName: "explore",
        outcome: {},
        usage: { input: 1200, output: 300, costUsd: 0.0123 },
        tools: [
          { name: "read", summary: "apps/tui/src/tool-renderers.tsx", status: "completed" },
          { name: "grep", summary: "ToolFrameBody 6 matches", status: "completed" },
          { name: "read", summary: "apps/tui/src/ui.tsx", status: "completed" },
          { name: "grep", summary: "FoldOperationsProvider 3 matches", status: "completed" },
          { name: "read", summary: "apps/tui/src/message-list.tsx", status: "completed" },
          { name: "read", summary: "apps/tui/src/ops.ts", status: "completed" },
        ],
        toolCount: 6,
      },
    },
    createdAt: nowPlus(-15_000),
  })

  const seedMessages = [
    user1,
    assistant1,
    toolResults1,
    assistant2,
    user2,
    assistant3,
    user3,
    assistant4,
    toolResults2,
    assistant5,
    childReport,
    childCompletion,
  ]

  for (const message of seedMessages) {
    yield* messages.createMessage(message)
  }
})

/** The `Gent.server` seed behind `--debug`. A failed seed is logged; the server still starts. */
export const seedDebugSession = (cwd: string) =>
  writeDebugSession(cwd).pipe(
    Effect.catchEager((error) =>
      Effect.logWarning("Debug session seeding failed").pipe(
        Effect.annotateLogs({ error: String(error) }),
      ),
    ),
  )

// ── admin subcommands ───────────────────────────────────────────────────────

/**
 * The admin subcommands: `sessions`, `server start`, `server status`,
 * `server stop`, `doctor` and `storage reset`.
 *
 * They share no state with the interactive TUI — each one opens what it needs,
 * prints, and returns — so they live beside the health readers they call rather
 * than in the entry point that renders the app.
 */

export class CliStartupError extends Schema.TaggedError<CliStartupError>()("CliStartupError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * A failure that ends the CLI (a startup error such as an unknown agent) is
 * reported on stderr, one line per error: `NotFoundError: Unknown agent: x`.
 * Stdout carries only the session's output, so a caller that pipes it reads
 * the reply and nothing else. A defect is a bug, so it keeps its stack.
 */
export const reportFailureOnStderr = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.tapCause(effect, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.void
    if (!Runtime.getErrorReported(Cause.squash(cause))) return Effect.void
    return Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio
      yield* Stream.make(`${failureText(cause)}\n`).pipe(Stream.run(stdio.stderr()))
    })
  })

const failureText = <E>(cause: Cause.Cause<E>): string => {
  if (Cause.hasDies(cause)) return Cause.pretty(cause)
  return Cause.prettyErrors(cause)
    .map((error) => `${error.name}: ${error.message}`)
    .join("\n")
}

/** Where the server lock and the storage live. `/tmp` when the shell has no HOME. */
export const readHome = Effect.map(
  Config.option(Config.String("HOME")),
  Option.getOrElse(() => "/tmp"),
)

/** What a command asks of the server it starts. */
interface ServerChoice {
  readonly cwd: string
  /** Keep state in memory instead of the shared SQLite file. */
  readonly inMemory: boolean
  readonly debug: boolean
  /** Serve scripted responses instead of a real provider; `empty` serves none. */
  readonly mock: Option.Option<{ readonly empty: boolean }>
  readonly authDirectory: Option.Option<string>
}

/** The `Gent.server` options for a command's choice: the one launcher every command shares. */
const serverOptions = (choice: ServerChoice): Parameters<typeof Gent.server>[0] => {
  let state = Gent.state.sqlite()
  if (choice.inMemory) state = Gent.state.memory()
  let provider = Gent.provider.live()
  if (Option.isSome(choice.mock)) provider = Gent.provider.mock(choice.mock.value)
  let options: Parameters<typeof Gent.server>[0] = { cwd: choice.cwd, state, provider }
  if (choice.debug) options = { ...options, seed: seedDebugSession(choice.cwd) }
  if (Option.isSome(choice.authDirectory))
    options = { ...options, authDirectory: choice.authDirectory.value }
  return options
}

/**
 * The one way a command reaches a running gent.
 *
 * `connect` attaches to a server someone else started. Otherwise this starts
 * one in-process, which is what every caller wants when no url is given: the
 * bundle owns its own server for the life of the call.
 *
 * `scriptedModel` says whether that server answers with a scripted model,
 * which needs no sign-in. Only a server this call starts takes the `mock`
 * choice: a connected server chose its own model.
 */
export const resolveClientBundle = (
  options: ServerChoice & { readonly connect: Option.Option<string> },
) => {
  if (Option.isSome(options.connect))
    return Effect.map(Gent.client(options.connect.value), (bundle) => ({
      ...bundle,
      scriptedModel: false,
    }))
  return Gent.server(serverOptions(options)).pipe(
    Effect.flatMap(Gent.client),
    Effect.map((bundle) => ({ ...bundle, scriptedModel: Option.isSome(options.mock) })),
  )
}

/**
 * Whether a session this run opens can be resumed later, read from the
 * storage the bundle above uses. A connected run uses the server's storage:
 * the local in-memory flags do not reach it, and a shared server keeps its
 * sessions. A local run keeps them unless its state is in memory.
 */
export const resumableSessions = (options: {
  readonly connect: Option.Option<string>
  readonly inMemory: boolean
}): boolean => Option.isSome(options.connect) || !options.inMemory

/** `--connect <url>`: every command that can attach to a running server. */
export const connectFlag = Flag.String("connect").pipe(
  Flag.withDescription(
    "Connect to an existing gent server; one on another machine only through a tunnel (ssh -L)",
  ),
  Flag.optional,
)

/** `--isolate`: every command that can start its own server. */
export const isolateFlag = Flag.Boolean("isolate").pipe(
  Flag.withDescription("Keep state in memory: no data-directory database or lock"),
  Flag.withDefault(false),
)

export const sessions = Command.make("sessions", { connect: connectFlag }, ({ connect }) =>
  Effect.gen(function* () {
    const bundle = yield* resolveClientBundle({
      cwd: process.cwd(),
      connect,
      inMemory: false,
      debug: false,
      mock: Option.none(),
      authDirectory: Option.none(),
    })
    yield* bundle.runtime.lifecycle.waitForReady
    yield* Console.log(formatSessionList(yield* bundle.client.session.list()))
  }),
)

/**
 * The `gent sessions` listing: what `gent resume` can pick. The conversations
 * (`isConversation`), newest first, each with the directory it runs in.
 */
export const formatSessionList = (sessions: ReadonlyArray<Session>): string => {
  const rows = sessions
    .filter(isConversation)
    .toSorted((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .map((s) => [
      s.id,
      Option.getOrElse(Option.fromNullishOr(s.name), () => "Unnamed"),
      Option.getOrElse(Option.fromNullishOr(s.cwd), () => "-"),
      DateTime.make(s.updatedAt).pipe(
        Option.match({ onNone: () => "unknown", onSome: DateTime.formatIso }),
      ),
    ])
  if (rows.length === 0) return "No sessions found."
  return formatTable(["ID", "NAME", "CWD", "UPDATED"], rows)
}

/**
 * Lay out a table: each column is as wide as its widest cell, one space apart,
 * so a long value (a scratch `GENT_DATA_DIR` database path) never pushes the
 * columns after it out from under their headers. The rule spans the table.
 */
const formatTable = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string => {
  const widths = headers.map((header, column) =>
    Math.max(textWidth(header), ...rows.map((row) => textWidth(row[column] ?? ""))),
  )
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, column) => padWidth(cell, widths[column] ?? 0))
      .join(" ")
      .trimEnd()
  const width = widths.reduce((sum, w) => sum + w, 0) + widths.length - 1
  return [line(headers), "─".repeat(width), ...rows.map(line)].join("\n")
}

/**
 * The `server status` report: a table (header, rule, the one server's row)
 * when it fits in `columns`, else one `Field: value` line per field, so a long
 * database path never wraps the table apart. Output with no terminal width
 * (a pipe) keeps the table.
 */
export const formatServerStatus = (
  label: string,
  entry: ServerLockEntry,
  columns: number,
): string => {
  const fields: ReadonlyArray<readonly [string, string, string]> = [
    ["PID", "PID", String(entry.pid)],
    ["STATUS", "Status", label],
    ["SERVER ID", "Server ID", entry.serverId],
    ["DB PATH", "DB path", entry.dbPath],
    ["URL", "URL", entry.rpcUrl],
  ]
  const table = formatTable(
    fields.map(([header]) => header),
    [fields.map(([, , value]) => value)],
  )
  const width = Math.max(...table.split("\n").map(textWidth))
  if (width <= columns) return table
  const labelWidth = Math.max(...fields.map(([, name]) => textWidth(name))) + 1
  return fields.map(([, name, value]) => `${padWidth(`${name}:`, labelWidth)} ${value}`).join("\n")
}

const serverStatus = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const status = yield* serverLock.status(yield* readHome)
    if (status._tag === "None") {
      yield* Console.log("No server for this data directory.")
      return
    }
    if (status._tag === "Unnamed") {
      yield* Console.log("A process holds the server lock but has not named itself yet.")
      return
    }

    yield* Console.log("Server for this data directory:\n")
    let label = "alive"
    if (status._tag === "Stale") label = "dead"
    // Off a terminal (a pipe) the width is 0: keep the table.
    let columns = yield* (yield* Terminal.Terminal).columns
    if (columns === 0) columns = Number.POSITIVE_INFINITY
    yield* Console.log(formatServerStatus(label, status.entry, columns))
  }),
)

const serverStop = Command.make(
  "stop",
  {
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Also remove the lock of a server that is no longer running"),
      Flag.withDefault(false),
    ),
  },
  ({ all }) =>
    Effect.gen(function* () {
      const result = yield* serverLock.stop(yield* readHome, { removeStale: all })
      const line = Match.value(result).pipe(
        Match.tagsExhaustive({
          None: () => "No server for this data directory.",
          Unnamed: () =>
            "A process holds the server lock but names no PID to signal; nothing was stopped.",
          NotRunning: () => "No live server for this data directory on this host.",
          Removed: ({ entry }) =>
            `Server ${entry.serverId} (PID ${entry.pid}) was not running; removed its lock entry.`,
          NotOwned: ({ entry }) =>
            `Skipped PID ${entry.pid} (${entry.serverId}): identity probe failed`,
          Stopped: ({ entry }) =>
            `Sent SIGTERM to PID ${entry.pid} (${entry.serverId})\n\nServer stopped and cleaned up.`,
          StillRunning: ({ entry }) =>
            `Sent SIGTERM to PID ${entry.pid} (${entry.serverId})\n\nServer is still running after SIGTERM.`,
        }),
      )
      yield* Console.log(line)
    }),
)

/**
 * Run a standalone server in the foreground until a signal stops it. A SQLite
 * server on a fixed port still takes the data directory's lock and writes its
 * entry, so a later `gent` finds and attaches to it.
 */
const serverStart = Command.make(
  "start",
  {
    port: Flag.Int("port").pipe(
      Flag.withDescription("Bind this TCP port on 127.0.0.1"),
      Flag.withDefault(3000),
    ),
    isolate: isolateFlag,
    mock: Flag.Boolean("mock").pipe(
      Flag.withDescription("Serve the scripted model instead of a real provider"),
      Flag.withDefault(false),
    ),
  },
  ({ port, isolate, mock }) =>
    Effect.scoped(
      Effect.gen(function* () {
        let scripted = Option.none<{ readonly empty: boolean }>()
        if (mock) scripted = Option.some({ empty: false })
        const options = serverOptions({
          cwd: process.cwd(),
          inMemory: isolate,
          debug: false,
          mock: scripted,
          authDirectory: yield* Config.option(Config.String("GENT_AUTH_DIRECTORY")),
        })
        const started = yield* Gent.server({ ...options, port })
        // Process fixtures parse this raw stdout line.
        yield* Console.log(`Gent server ready on ${started.url.replace("/rpc", "")}`)
        return yield* Effect.never
      }),
    ),
)

export const server = Command.make("server", {}, () =>
  Console.log("Usage: gent server <start|status|stop>"),
).pipe(Command.withSubcommands([serverStart, serverStatus, serverStop]))

/** How long the doctor waits for a confirmed server to report extension health. */
const DOCTOR_QUERY_TIMEOUT = "5 seconds"

/**
 * Ask the data directory's server for extension health. The doctor runs when something
 * is wrong, so it confirms the server's identity first and bounds the query:
 * a holder that does not answer is reported, not waited on.
 */
export const readDoctorExtensionHealth = (
  status: ServerLockStatus,
): Effect.Effect<ExtensionDoctorHealth> => {
  if (status._tag === "None")
    return Effect.succeed(extensionHealthUnavailable("No server for this data directory."))
  if (status._tag === "Unnamed") {
    return Effect.succeed(extensionHealthUnavailable("The server has not named itself yet."))
  }
  if (status._tag === "Stale") {
    return Effect.succeed(extensionHealthUnavailable("Server lock is stale."))
  }
  const { entry } = status
  return Effect.gen(function* () {
    if (!(yield* serverLock.probe(entry))) {
      return extensionHealthUnavailable(
        `PID ${entry.pid} holds the server lock but does not answer as a gent server at ${entry.rpcUrl}.`,
      )
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const bundle = yield* Gent.client(entry.rpcUrl, { cwd: process.cwd() })
        yield* bundle.runtime.lifecycle.waitForReady
        // The doctor has no session: it reads the profile the server started in.
        const snapshot = yield* bundle.client.extension.listStatus({
          scope: { _tag: "Launch" },
        })
        return extensionHealthFromSnapshot(snapshot)
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: DOCTOR_QUERY_TIMEOUT,
        orElse: () =>
          Effect.succeed(
            extensionHealthError(`no answer within ${DOCTOR_QUERY_TIMEOUT} from ${entry.rpcUrl}`),
          ),
      }),
      Effect.catch((error) => Effect.succeed(extensionHealthError(String(error)))),
    )
  })
}

export const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const home = yield* readHome
    const status = yield* serverLock.status(home)
    const extensions = yield* readDoctorExtensionHealth(status)
    const report = yield* makeDoctorReport(home, status, extensions)
    yield* Console.log(formatDoctorReport(report))
  }),
)

const storageReset = Command.make("reset", {}, () =>
  Effect.gen(function* () {
    const result = yield* resetStorage(yield* readHome)
    if (result.archived.length === 0) {
      yield* Console.log("No storage files found.")
      return
    }

    yield* Console.log(`Archived storage files to ${result.archiveDir}`)
    for (const file of result.archived) {
      yield* Console.log(`  ${file}`)
    }
  }),
)

export const storage = Command.make("storage", {}, () =>
  Console.log("Usage: gent storage <reset>"),
).pipe(Command.withSubcommands([storageReset]))

// ── install and upgrade ─────────────────────────────────────────────────────

/**
 * Where releases live: the GitHub releases page, or a mirror with the same
 * paths. `gent upgrade` hands it to the release's install.sh.
 */
const releasesUrl = Config.String("GENT_RELEASES_URL").pipe(
  Config.withDefault("https://github.com/cevr/gent/releases"),
)

const INSTALL_COMMAND = "curl -fsSL https://gent.cvr.im/install.sh | sh"

/** A release version as a tag names it without its `v`: `0.2.0`, `1.0.0-rc.1`. */
const RELEASE_VERSION = /^[0-9][0-9A-Za-z.+-]*$/

/**
 * The install root the gent at `executable` runs from: install.sh puts each
 * version at `<XDG_DATA_HOME>/gent/versions/<version>/gent`.
 */
const installRoot = (path: Path.Path, executable: string): Option.Option<string> => {
  const versionsDir = path.dirname(path.dirname(executable))
  const root = path.dirname(versionsDir)
  const installed =
    path.basename(executable) === "gent" &&
    path.basename(versionsDir) === "versions" &&
    path.basename(root) === "gent"
  if (!installed) return Option.none()
  return Option.some(root)
}

/**
 * Mark the installed version this gent runs from as in use for the life of
 * the scope: `<version>/.in-use/<pid>`. install.sh never prunes a version
 * with a live marker, so a gent that runs, and its server, keep their
 * gent-cell across updates. A source run or a gent outside an install marks
 * nothing. A gent whose marker cannot be written, or whose pair is gone once
 * the marker is in place, does not start: it would run without gent-cell.
 */
export const markVersionInUse = Effect.gen(function* () {
  const platform = yield* GentPlatform
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if ((yield* platform.build)._tag === "Source") return
  const executable = yield* platform.execPath
  if (Option.isNone(installRoot(path, executable))) return
  const versionDir = path.dirname(executable)
  const markers = path.join(versionDir, ".in-use")
  const marker = path.join(markers, String(yield* platform.pid))
  const removed = new CliStartupError({
    message: `this version of gent was removed during start (${versionDir}); run gent again`,
  })
  const unmarked = (error: PlatformError.PlatformError) => {
    if (error.reason._tag === "NotFound") return removed
    return new CliStartupError({
      message: `could not mark ${versionDir} in use: ${error.message}`,
      cause: error,
    })
  }
  // Not recursive: a version directory that prune removed stays removed.
  yield* fs.makeDirectory(markers).pipe(
    Effect.catchEager((error) => {
      if (error.reason._tag === "AlreadyExists") return Effect.void
      return Effect.fail(error)
    }),
    Effect.mapError(unmarked),
  )
  yield* Effect.acquireRelease(fs.writeFileString(marker, "").pipe(Effect.mapError(unmarked)), () =>
    fs.remove(marker).pipe(Effect.ignore),
  )
  // The other half of prune's handshake (install.sh moves a version aside,
  // then looks for markers again): with the marker written, a pair still in
  // place stays in place.
  const pair = yield* Effect.forEach([executable, path.join(versionDir, "gent-cell")], (file) =>
    fs.exists(file),
  ).pipe(Effect.mapError(unmarked))
  if (!pair.every(Boolean)) return yield* removed
})

class UpgradeError extends Schema.TaggedError<UpgradeError>()("UpgradeError", {
  message: Schema.String,
}) {}

const UpgradeOutcome = Schema.TaggedUnion({
  /** The release's install.sh switched the install to `to`; `report` is what it said. */
  Upgraded: { from: Schema.String, to: Schema.String, report: Schema.String },
  /** The running build is the version asked for. */
  Current: { version: Schema.String },
  /** A package manager owns this gent: it changes nothing. */
  PackageManager: { executable: Schema.String },
})
type UpgradeOutcome = typeof UpgradeOutcome.Type

const upgradeFailure = (message: string) => Effect.fail(new UpgradeError({ message }))

/** A download's body, or an `UpgradeError` that names the URL. */
const download = <A>(
  client: HttpClient.HttpClient,
  url: string,
  body: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<A, HttpClientError.HttpClientError>,
) =>
  client.get(url).pipe(
    Effect.flatMap(body),
    Effect.mapError(
      (error) => new UpgradeError({ message: `could not download ${url}: ${error.message}` }),
    ),
  )

/** The digest SHA256SUMS gives for `name`. */
const listedDigest = (sums: string, name: string): Option.Option<string> =>
  Arr.findFirst(sums.split("\n"), (line) => {
    const listed = line.trim().split(/\s+/)[1]
    return listed === name || listed === `*${name}`
  }).pipe(Option.map((line) => line.trim().split(/\s+/)[0] ?? ""))

/**
 * The install this gent runs from, read from its real path: an install.sh
 * root, or none for a package manager's tree. A source run or any other
 * path is refused.
 */
const findInstall = Effect.gen(function* () {
  const platform = yield* GentPlatform
  const path = yield* Path.Path
  const build = yield* platform.build
  if (build._tag === "Source") {
    return yield* upgradeFailure(
      `this gent runs from a source checkout; pull and rebuild it, or install a release: ${INSTALL_COMMAND}`,
    )
  }
  const executable = yield* platform.execPath
  if (executable.split(path.sep).includes("node_modules")) {
    return { build, root: Option.none<string>(), executable }
  }
  const root = installRoot(path, executable)
  if (Option.isNone(root)) {
    return yield* upgradeFailure(
      `gent upgrade updates a gent that install.sh installed (<root>/gent/versions/<version>/gent); this one runs from ${executable}. Install a release with: ${INSTALL_COMMAND}`,
    )
  }
  return { build, root, executable }
})

/** The version asked for, or the latest: its page redirects to `.../releases/tag/v<version>`. */
const resolveVersion = (
  client: HttpClient.HttpClient,
  releases: string,
  requested: Option.Option<string>,
) =>
  Effect.gen(function* () {
    let version = ""
    if (Option.isSome(requested)) version = requested.value.replace(/^v/, "")
    else {
      const tag = yield* download(client, `${releases}/latest`, (response) =>
        Effect.succeed(Arr.last(response.url.split("/")).pipe(Option.getOrElse(() => ""))),
      )
      if (!/^v[0-9]/.test(tag)) return yield* upgradeFailure(`${releases} has no published release`)
      version = tag.slice(1)
    }
    if (!RELEASE_VERSION.test(version)) {
      return yield* upgradeFailure(`"${version}" is not a version, such as 0.2.0`)
    }
    return version
  })

/** The release's install.sh, checked against the release's SHA256SUMS like any other asset. */
const downloadInstaller = (client: HttpClient.HttpClient, releases: string, version: string) =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const base = `${releases}/download/v${version}`
    const installer = yield* download(client, `${base}/install.sh`, (response) =>
      Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer)),
    )
    const sums = yield* download(client, `${base}/SHA256SUMS`, (response) => response.text)
    const expected = listedDigest(sums, "install.sh")
    if (Option.isNone(expected)) {
      return yield* upgradeFailure(`the SHA256SUMS of v${version} names no install.sh`)
    }
    const actual = platform.hash("sha256", installer)
    if (actual !== expected.value) {
      return yield* upgradeFailure(
        `install.sh does not match the SHA256SUMS of v${version} (expected ${expected.value}, got ${actual})`,
      )
    }
    return installer
  })

/**
 * Move the install this gent runs from to another release. install.sh is the
 * one owner of placing, switching and pruning: this resolves the version,
 * downloads that release's install.sh, checks it against the release's
 * SHA256SUMS, and runs it for the same root (`XDG_DATA_HOME` is the root's
 * parent) and the same release host. A gent inside `node_modules` belongs to
 * a package manager and is left alone.
 */
export const upgradeInstall = Effect.fn("upgradeInstall")(function* (
  requested: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const install = yield* findInstall
  if (Option.isNone(install.root)) {
    return UpgradeOutcome.cases.PackageManager.make({ executable: install.executable })
  }
  const releases = (yield* releasesUrl).replace(/\/+$/, "")
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const version = yield* resolveVersion(client, releases, requested)
  if (version === install.build.version) return UpgradeOutcome.cases.Current.make({ version })

  const installer = yield* downloadInstaller(client, releases, version)
  const work = yield* fs.makeTempDirectoryScoped({ prefix: "gent-upgrade-" })
  const script = path.join(work, "install.sh")
  yield* fs.writeFile(script, installer)
  const ran = yield* runProcess("sh", [script, "--version", version, "--no-modify-path"], {
    env: {
      HOME: yield* readHome,
      XDG_DATA_HOME: path.dirname(install.root.value),
      GENT_RELEASES_URL: releases,
    },
    extendEnv: true,
  }).pipe(
    Effect.mapError(
      (error) => new UpgradeError({ message: `could not run install.sh: ${error.message}` }),
    ),
  )
  const report = ran.stderr.trim()
  if (ran.exitCode !== 0) {
    return yield* upgradeFailure(`the install.sh of v${version} failed:\n${report}`)
  }
  return UpgradeOutcome.cases.Upgraded.make({ from: install.build.version, to: version, report })
})

export const formatUpgradeOutcome = (outcome: UpgradeOutcome): string =>
  Match.value(outcome).pipe(
    Match.tagsExhaustive({
      Upgraded: ({ from, to, report }) => `Upgraded gent v${from} to v${to}.\n${report}`,
      Current: ({ version }) => `Already at gent v${version}.`,
      PackageManager: ({ executable }) =>
        `A package manager installed this gent (${executable}); upgrade it with that package manager.`,
    }),
  )

export const upgrade = Command.make(
  "upgrade",
  {
    version: Argument.String("version").pipe(
      Argument.withDescription("The release to install, such as 0.2.0 (default: the latest)"),
      Argument.optional,
    ),
  },
  ({ version }) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.scoped(upgradeInstall(version))
      yield* Console.log(formatUpgradeOutcome(outcome))
    }),
).pipe(Command.provide(FetchHttpClient.layer))
