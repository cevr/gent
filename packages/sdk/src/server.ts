// @effect-diagnostics nodeBuiltinImport:off — server primitive owns filesystem path resolution for gent's data directory
import {
  Clock,
  Config,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Schema,
  type Scope,
} from "effect"
import { join as pathJoin, resolve as pathResolve } from "node:path"
import type { ChildProcessSpawner } from "effect/unstable/process"
import {
  Branch,
  dateFromMillis,
  Message,
  Session,
  BranchId,
  MessageId,
  SessionId,
  ToolCallId,
  GentConnectionError,
} from "@gent/core/protocol"
import {
  GentPlatform,
  BranchStorage,
  MessageStorage,
  SessionStorage,
  type RpcHandlersLive,
  provideWorkspaceIdHeader,
  type WorkspaceHeaders,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
  buildServerRoot,
  ScriptedLanguageModel,
  ServerRootPlatformLayer,
  StateLocation,
} from "@gent/core/host"
import { runProcess, type GentExtension } from "@gent/core/extensions/api"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BunHttpServer } from "@effect/platform-bun"
import { FetchHttpClient, Headers, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { BuiltinExtensions, CellBranchTools } from "@gent/extensions"
import type { BranchToolFeature } from "@gent/core/extensions/branch-tools"
import type { LanguageModel } from "effect/unstable/ai"
import { GentObservability } from "./logger.js"

// ── data-paths ──────────────────────────────────────────────────────────────

/**
 * The one owner of where gent keeps its durable state on disk.
 *
 * `GENT_DATA_DIR` names the directory holding `data.db`; without it the
 * directory is `<home>/.gent`. Every reader — the server that writes the
 * database, and the `doctor` and `storage reset` commands that inspect and
 * archive it — resolves through here, so an operator who redirects the
 * database does not get tools that look somewhere else.
 */

/** A malformed value is no value: the fallback under `home` still applies. */
const optionalEnv = (name: string): Effect.Effect<Option.Option<string>> =>
  Config.option(Config.string(name)).pipe(Effect.orElseSucceed(() => Option.none<string>()))

const DB_FILE = "data.db"

/** The database file plus the sidecars SQLite writes beside it. */
interface DataPaths {
  readonly dataDir: string
  readonly dbPath: string
  /** `dbPath` and its `-shm`/`-wal` sidecars, in that order. */
  readonly files: ReadonlyArray<string>
  /** Where `storage reset` moves the files it clears. */
  readonly archiveDir: string
  /** The shared-server identity record. One server per database, so it sits beside it. */
  readonly serverLock: string
}

/**
 * Build the paths for an already-resolved data directory. Pure — callers that
 * hold an explicit directory (a test fixture) use this;
 * callers reading the environment use {@link dataPaths}.
 */
export const dataPathsIn = (dataDir: string): DataPaths => {
  const resolvedDir = pathResolve(dataDir)
  const dbPath = pathJoin(resolvedDir, DB_FILE)
  return {
    dataDir: resolvedDir,
    dbPath,
    files: [dbPath, `${dbPath}-shm`, `${dbPath}-wal`],
    archiveDir: pathJoin(resolvedDir, "storage-archive"),
    serverLock: pathJoin(resolvedDir, "server.lock"),
  }
}

/** The data directory `GENT_DATA_DIR` names, else `<home>/.gent`. */
const resolveDataDir = (home: string): Effect.Effect<string> =>
  Effect.map(optionalEnv("GENT_DATA_DIR"), (dataDir) =>
    pathResolve(Option.getOrElse(dataDir, () => pathJoin(home, ".gent"))),
  )

/**
 * Resolve the paths from the environment. `home` names the fallback root; a
 * caller without one passes `HOME`.
 */
export const dataPaths = (home: string): Effect.Effect<DataPaths> =>
  Effect.map(resolveDataDir(home), dataPathsIn)

// ── build-fingerprint ───────────────────────────────────────────────────────

/**
 * Build fingerprint — identifies gent executable/source version.
 * Used by server identity and SDK registry for version-aware restarts.
 */

/** True when execPath is a compiled gent binary, not a generic runtime like bun. */
const isCompiledBinary = (exe: string): boolean => !exe.endsWith("/bun") && !exe.includes("/.bun/")

/**
 * Compute a build fingerprint from local sources (no env).
 * Priority: compiled binary mtime → gent source git hash → "unknown"
 */
const computeLocalFingerprintUncached: Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | GentPlatform
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const exe = yield* platform.execPath

  // 1. Binary mtime (compiled mode only — skip if running via bun runtime)
  if (isCompiledBinary(exe)) {
    const info = yield* fs.stat(exe).pipe(Effect.option)
    if (info._tag === "Some") {
      const mtime = Option.getOrElse(info.value.mtime, () => dateFromMillis(0))
      return `bin-${mtime.getTime().toString(36)}`
    }
  }

  // 2. Git hash from gent source root (dev mode)
  const here = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(Effect.option)
  if (Option.isNone(here)) return "unknown"
  const gentRoot = path.resolve(here.value, "../../../..")
  const result = yield* runProcess("git", ["rev-parse", "--short", "HEAD"], {
    cwd: gentRoot,
    stdout: "pipe",
    stderr: "pipe",
  }).pipe(
    Effect.map((r) => {
      if (r.exitCode === 0) {
        return r.stdout.trim()
      }
      return ""
    }),
    Effect.catchTag("ProcessError", () => Effect.succeed("")),
  )
  if (result.length > 0) return `src-${result}`

  return "unknown"
})

/**
 * The one build fingerprint. The lock entry and the identity endpoint both
 * read it, so a probe that compares them compares one fact.
 */
interface BuildFingerprintApi {
  /** Cached computation. Identical across yields within the TTL. */
  readonly current: Effect.Effect<string>
}

export class BuildFingerprint extends Context.Service<BuildFingerprint, BuildFingerprintApi>()(
  "@gent/sdk/src/server/BuildFingerprint",
) {
  static Live: Layer.Layer<
    BuildFingerprint,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | GentPlatform
  > = Layer.effect(
    BuildFingerprint,
    Effect.gen(function* () {
      const ctx = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | GentPlatform
      >()
      const cached = yield* Effect.cachedWithTTL(computeLocalFingerprintUncached, "1 hour")
      // oxlint-disable-next-line effect/noInlineProvide -- Layer construction captures the services required by the cached computation.
      const current: Effect.Effect<string> = Effect.provide(cached, ctx)
      return BuildFingerprint.of({ current })
    }),
  )

  /** Deterministic test layer. */
  static Test = (fingerprint = "test-fingerprint"): Layer.Layer<BuildFingerprint> =>
    Layer.succeed(BuildFingerprint, BuildFingerprint.of({ current: Effect.succeed(fingerprint) }))
}

// ── server-lock ─────────────────────────────────────────────────────────────

/**
 * Single shared server discovery file.
 *
 * `~/.gent/server.lock` is a pidfile-style identity record for the one
 * shared gent server on this host. Clients attach only after the server's
 * identity endpoint confirms the full tuple, so PID reuse cannot signal an
 * unrelated process.
 */

export class ServerLockEntry extends Schema.Class<ServerLockEntry>("ServerLockEntry")({
  serverId: Schema.String,
  pid: Schema.Finite,
  hostname: Schema.String,
  rpcUrl: Schema.String,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
  startedAt: Schema.Finite,
}) {}

const ServerLockEntryJson = Schema.fromJsonString(ServerLockEntry)

/**
 * The lock sits in the data directory `data-paths.ts` resolves, beside the
 * database it guards. Under `~/.gent` it was shared by every `GENT_DATA_DIR`
 * run on the machine: a second run saw a foreign `dbPath`, signalled the
 * first run's server as stale, and that TUI lost its server.
 */
const serverLockPath = (home: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* dataPaths(home)
    yield* fs.makeDirectory(paths.dataDir, { recursive: true }).pipe(Effect.ignore)
    return paths.serverLock
  })

/** What the lock says about the server on this host. */
export const ServerLockStatus = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Alive", { entry: ServerLockEntry }),
  Schema.TaggedStruct("Stale", { entry: ServerLockEntry }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ServerLockStatus = Schema.Schema.Type<typeof ServerLockStatus>

/** What `serverLock.stop` did. */
const ServerStopResult = Schema.Union([
  Schema.TaggedStruct("None", {}),
  /** The pid is gone and the caller did not ask to remove its lock. */
  Schema.TaggedStruct("NotRunning", { entry: ServerLockEntry }),
  /** The pid is gone; its lock is removed. */
  Schema.TaggedStruct("Removed", { entry: ServerLockEntry }),
  /** The pid is alive but its identity endpoint does not confirm the lock, so no signal. */
  Schema.TaggedStruct("NotOwned", { entry: ServerLockEntry }),
  /** SIGTERM sent, the process exited, and its lock is removed. */
  Schema.TaggedStruct("Stopped", { entry: ServerLockEntry }),
  /** SIGTERM sent, but the process was still alive when the wait ended. */
  Schema.TaggedStruct("StillRunning", { entry: ServerLockEntry }),
]).pipe(Schema.toTaggedUnion("_tag"))
type ServerStopResult = Schema.Schema.Type<typeof ServerStopResult>

/** A lock written by another host is invisible here, so every entry read is local. */
const readLock = (
  home: string,
): Effect.Effect<Option.Option<ServerLockEntry>, never, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* serverLockPath(home)
    const osInfo = yield* (yield* GentPlatform).osInfo
    const content = yield* fs.readFileString(path).pipe(Effect.option)
    return Option.flatMap(content, Schema.decodeOption(ServerLockEntryJson)).pipe(
      Option.filter((entry) => entry.hostname === osInfo.hostname),
    )
  })

const writeLock = (
  home: string,
  entry: ServerLockEntry,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* serverLockPath(home)
    const json = yield* Schema.encodeEffect(ServerLockEntryJson)(entry).pipe(Effect.orDie)
    yield* fs.writeFileString(path, json).pipe(Effect.ignore)
  })

/** Removes the lock only while it still names `serverId`. */
const removeLock = (
  home: string,
  serverId: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const current = yield* readLock(home)
    if (Option.isNone(current) || current.value.serverId !== serverId) return false
    const path = yield* serverLockPath(home)
    return yield* fs.remove(path).pipe(
      Effect.as(true),
      Effect.catchEager(() => Effect.succeed(false)),
    )
  })

const pidAlive = (pid: number): Effect.Effect<boolean, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    return yield* platform.signal(pid, 0).pipe(
      Effect.as(true),
      Effect.catchEager(() => Effect.succeed(false)),
    )
  })

const lockStatus = (
  home: string,
): Effect.Effect<ServerLockStatus, never, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const entry = yield* readLock(home)
    if (Option.isNone(entry)) return ServerLockStatus.cases.None.make({})
    if (yield* pidAlive(entry.value.pid)) {
      return ServerLockStatus.cases.Alive.make({ entry: entry.value })
    }
    return ServerLockStatus.cases.Stale.make({ entry: entry.value })
  })

/** `stop` polls a signalled server this many times, 100 ms apart, before it gives up. */
const STOP_WAIT_ATTEMPTS = 20

const exitedWithin = (pid: number): Effect.Effect<boolean, never, GentPlatform> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < STOP_WAIT_ATTEMPTS; attempt++) {
      if (!(yield* pidAlive(pid))) return true
      yield* Effect.sleep("100 millis")
    }
    return !(yield* pidAlive(pid))
  })

/**
 * Stop the server the lock names. SIGTERM goes out only after the identity
 * endpoint confirms every field of the lock, so a reused pid is never signalled.
 */
const stopLocked = (
  home: string,
  options?: { readonly removeStale?: boolean },
): Effect.Effect<ServerStopResult, never, FileSystem.FileSystem | GentPlatform> =>
  Effect.gen(function* () {
    const status = yield* lockStatus(home)
    if (status._tag === "None") return ServerStopResult.cases.None.make({})
    const { entry } = status
    if (status._tag === "Stale") {
      if (options?.removeStale !== true) return ServerStopResult.cases.NotRunning.make({ entry })
      yield* removeLock(home, entry.serverId)
      return ServerStopResult.cases.Removed.make({ entry })
    }
    if (!(yield* probeServerLockEntryIdentity(entry))) {
      return ServerStopResult.cases.NotOwned.make({ entry })
    }
    const platform = yield* GentPlatform
    yield* platform.signal(entry.pid, "SIGTERM").pipe(Effect.ignore)
    if (!(yield* exitedWithin(entry.pid)))
      return ServerStopResult.cases.StillRunning.make({ entry })
    yield* removeLock(home, entry.serverId)
    return ServerStopResult.cases.Stopped.make({ entry })
  })

/** The shared server lock: read, write, remove, status, and stop. */
export const serverLock = {
  read: readLock,
  write: writeLock,
  remove: removeLock,
  status: lockStatus,
  stop: stopLocked,
}

// ── debug-session ───────────────────────────────────────────────────────────

/**
 * Debug session seeding — creates a pre-populated session with realistic
 * tool calls and message history for TUI development/testing.
 */

interface DebugSessionInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
}

type DebugValue = Schema.Schema.Type<typeof Schema.Unknown>

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

const seedDebugSession = Effect.fn("DebugSession.seed")(function* (cwd: string) {
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
  yield* sessions.updateSession(new Session({ ...session, activeBranchId: branchId }))

  const user1 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "user",
    parts: [makeText("Review the TUI renderer cleanup and inspect the current implementation.")],
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
        params: { path: `${cwd}/apps/tui/src/routes/session.tsx` },
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
          path: `${cwd}/apps/tui/src/components/message-list.tsx`,
          oldString: "<text>[ x ] tool_call</text>",
          newString: "<ToolFrame />",
        },
      }),
      makeToolCall({
        id: asToolCallId("dbg-write"),
        name: "write",
        params: {
          path: `${cwd}/packages/sdk/src/server.ts`,
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
        path: `${cwd}/apps/tui/src/routes/session.tsx`,
        lineCount: 18,
        truncated: false,
        content:
          "const [toolsExpanded, setToolsExpanded] = createSignal(false)\nconst [composerState, setComposerState] = createSignal(...)",
      }),
      makeJsonResult(asToolCallId("dbg-grep"), "grep", {
        matches: [
          {
            file: `${cwd}/apps/tui/src/components/tool-renderers/generic.tsx`,
            line: 3,
            content: 'import { ToolFrame } from "../tool-frame"',
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
        path: `${cwd}/apps/tui/src/components/message-list.tsx`,
        replacements: 1,
      }),
      makeJsonResult(asToolCallId("dbg-write"), "write", {
        path: `${cwd}/packages/sdk/src/server.ts`,
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
    createdAt: nowPlus(-38_000),
  })

  const assistant3 = Message.cases.regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "assistant",
    parts: [
      makeText(
        "Steer should cut ahead of queued regular work. Regular sends should merge by newline while a turn is active.",
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
        sessionId: "019debug1-explore",
        branchId: "019debug1-explore-branch",
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
  ]

  for (const message of seedMessages) {
    yield* messages.createMessage(message)
  }

  return {
    sessionId,
    branchId,
    name: Option.getOrElse(Option.fromUndefinedOr(session.name), () => "debug scenario"),
  } satisfies DebugSessionInfo
})

// ── server ──────────────────────────────────────────────────────────────────

/**
 * Gent server primitive — resolves or starts a server, always has a URL.
 *
 * Two server topologies:
 * - owned: in-process handler context + HTTP listener (primary client gets direct RPC)
 * - attached: existing server found via registry (client connects via WS)
 */

// ── Types ──

type BuiltRpcHandlers = Layer.Success<typeof RpcHandlersLive>

export const StateSpec = Schema.Union([
  Schema.TaggedStruct("Sqlite", {
    /** The fallback root for the data directory when `GENT_DATA_DIR` is unset. */
    home: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Memory", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type StateSpec = Schema.Schema.Type<typeof StateSpec>

export const ProviderSpec = Schema.Union([
  Schema.TaggedStruct("Live", {}),
  Schema.TaggedStruct("Mock", {
    /** Finish every step having produced nothing — drives the unanswered turn. */
    empty: Schema.optional(Schema.Boolean),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProviderSpec = Schema.Schema.Type<typeof ProviderSpec>

/**
 * Shut the owned server down once no client has been connected for
 * `idleMs`. A managed shared server uses this so short-lived workers stop
 * paying for an idle process; a standalone server omits it and runs forever.
 */
export interface IdleShutdownSpec {
  readonly idleMs: number
}

/**
 * Every launch value the standalone server reads from its environment.
 *
 * Each field stops the process at startup rather than letting a wrong value
 * run: `GENT_IDLE_TIMEOUT_MS=-1` would otherwise shut the server down on its
 * first poll, and a misspelled `GENT_PROVIDER_MODE` would quietly bill a live
 * provider for what the caller asked to run scripted. An unset variable takes
 * its default; a present but invalid one fails.
 *
 * This lives beside `GentServerOptions` because that is the surface it guards.
 * A launcher reads strings from its environment; this is where they become
 * values `Gent.server` accepts.
 */
export const LaunchConfig = Config.all({
  port: Config.port("GENT_PORT").pipe(Config.withDefault(3000)),
  serverMode: Config.literals(["standalone", "shared"], "GENT_SERVER_MODE").pipe(
    Config.withDefault("standalone"),
  ),
  persistenceMode: Config.literals(["sqlite", "memory"], "GENT_PERSISTENCE_MODE").pipe(
    Config.withDefault("sqlite"),
  ),
  providerMode: Config.literals(["live", "debug-scripted"], "GENT_PROVIDER_MODE").pipe(
    Config.withDefault("live"),
  ),
  // An idle window of no length stops the server at once, so zero fails too.
  idleTimeoutMs: Config.schema(
    Schema.Int.check(Schema.isGreaterThan(0)),
    "GENT_IDLE_TIMEOUT_MS",
  ).pipe(Config.withDefault(30_000)),
  // `GENT_DATA_DIR` and the home directory are not read here: `dataPaths` and
  // the platform own them, so the server and the doctor resolve one directory.
  authDirectory: Config.option(Config.string("GENT_AUTH_DIRECTORY")),
  shell: Config.option(Config.string("SHELL")),
})

export interface GentServerOptions {
  readonly cwd: string
  /** Extension declarations for this server. Defaults to the builtins. */
  readonly extensions?: ReadonlyArray<GentExtension>
  /**
   * The branch-tool feature these extensions run on -- storage plus the
   * per-branch kernel. A server naming its own `extensions` names this too;
   * a tool surface whose feature is missing fails on first use.
   */
  readonly branchTools?: BranchToolFeature<never>
  readonly state?: StateSpec
  readonly provider?: ProviderSpec
  readonly authDirectory?: string
  /** Seed storage with a debug session on startup. */
  readonly debug?: boolean
  /**
   * Bind this TCP port instead of an ephemeral one. A fixed port also opts
   * out of the shared-server registry: the caller already named the address
   * its clients use, so there is nothing to discover.
   */
  readonly port?: number
  /** Server identity to publish instead of a freshly minted one. */
  readonly serverId?: string
  /** Login shell for extension process launches. */
  readonly shell?: string
  /**
   * Stop the owned server after this much client-free time. Both kinds of
   * client count: a WebSocket connection, and an in-process `Gent.client`
   * for as long as its scope is open.
   */
  readonly idleShutdown?: IdleShutdownSpec
}

/** Public opaque server handle. */
export const GentServer = Schema.Union([
  Schema.TaggedStruct("Owned", {
    url: Schema.String,
    workspaceId: Schema.String,
  }),
  Schema.TaggedStruct("Attached", {
    url: Schema.String,
    workspaceId: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type GentServer = Schema.Schema.Type<typeof GentServer>

// ── Internal state for owned servers ──

interface OwnedServerInternal {
  readonly handlerContext: Context.Context<BuiltRpcHandlers>
  readonly port: number
  readonly serverId: string
  readonly headers: WorkspaceHeaders
  /**
   * Completes when this server decides to stop. An `idleShutdown` server
   * completes it after the idle window; every other server never completes,
   * so awaiting it keeps a launcher process alive.
   */
  readonly awaitShutdown: Effect.Effect<void>
  /**
   * Counts an in-process client for as long as its scope is open. Idle
   * shutdown watches the connection count, and an in-process client opens no
   * transport connection, so without this a server could stop itself while a
   * `Gent.client(server)` was still holding it.
   */
  readonly trackInProcessClient: Effect.Effect<void, never, Scope.Scope>
}

/** WeakMap keyed by GentServer object identity — keeps handler context private */
const ownedInternals = new WeakMap<GentServer, OwnedServerInternal>()

/** @internal — used by Gent.client to access owned server handler context */
export const getOwnedInternal = (server: GentServer): Option.Option<OwnedServerInternal> =>
  Option.fromNullishOr(ownedInternals.get(server))

/**
 * Block until this server decides to stop. An `idleShutdown` server returns
 * after its idle window; every other server blocks forever. A launcher
 * process awaits this as its last act.
 */
export const awaitServerShutdown = (server: GentServer): Effect.Effect<void> =>
  Option.match(getOwnedInternal(server), {
    onNone: () => Effect.never,
    onSome: (internal) => internal.awaitShutdown,
  })

// ── Factories ──

export const state = {
  sqlite: (options?: { readonly home?: string }): StateSpec =>
    StateSpec.cases.Sqlite.make(options ?? {}),
  memory: (): StateSpec => StateSpec.cases.Memory.make({}),
}

export const provider = {
  live: (): ProviderSpec => ProviderSpec.cases.Live.make({}),
  mock: (options?: { readonly empty?: boolean }): ProviderSpec =>
    ProviderSpec.cases.Mock.make(options ?? {}),
}

// ── Language model layer from spec ──

/** Build a self-contained language model layer from spec. For "live", returns undefined
 *  (let createDependencies build its own from auth deps). */
const resolveLanguageModelLayer = (
  spec: ProviderSpec,
): Option.Option<Layer.Layer<LanguageModel.LanguageModel, never, never>> =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Live: () => Option.none(),
      Mock: (mockSpec) => {
        if (mockSpec.empty === true) return Option.some(ScriptedLanguageModel.empty)
        return Option.some(ScriptedLanguageModel.debug())
      },
    }),
  )

// ── Platform layers ──

/** Built once per `resolveServer`; the owned server's root and listener share it. */
const LocalPlatformLayer = Layer.provideMerge(BuildFingerprint.Live, ServerRootPlatformLayer)
type LocalPlatform = Layer.Success<typeof LocalPlatformLayer>

// ── Helpers ──

const resolveHome = (stateSpec: StateSpec, homeDirectory: string): string =>
  Match.value(stateSpec).pipe(
    Match.tagsExhaustive({
      Memory: () => Option.none<string>(),
      Sqlite: (sqliteSpec) => Option.fromNullishOr(sqliteSpec.home),
    }),
    Option.getOrElse(() => homeDirectory),
  )

/**
 * The database always sits in the data directory `dataPaths` resolves, beside
 * the server lock. The server writes where `gent doctor` and
 * `gent storage reset` look, and a lock never guards a database it does not sit beside.
 */
const resolveDbPath = (home: string): Effect.Effect<string> =>
  Effect.map(dataPaths(home), (paths) => paths.dbPath)

/**
 * Poll the connection tracker and complete `shutdown` once the server has
 * been client-free for `idleMs`. Polls faster than the window so a
 * short-lived worker exits promptly, and re-checks the count immediately
 * before completing so a client that connects inside the last tick wins.
 */
const runIdleWatcher = (options: {
  readonly idleMs: number
  readonly connectionCount: Effect.Effect<number>
  readonly shutdown: Deferred.Deferred<void>
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const intervalMs = Math.max(50, Math.min(250, Math.floor(options.idleMs / 4)))
    let idleStartMs = Option.none<number>()

    const loop: Effect.Effect<void> = Effect.gen(function* () {
      // gent/no-sleep: idle shutdown observes live client connections on the real clock
      yield* Effect.sleep(`${intervalMs} millis`)
      const count = yield* options.connectionCount
      if (count > 0) {
        idleStartMs = Option.none()
        return yield* loop
      }
      const now = yield* Clock.currentTimeMillis
      const idleStart = Option.getOrElse(idleStartMs, () => now)
      idleStartMs = Option.some(idleStart)
      if (now - idleStart < options.idleMs) return yield* loop
      // A client can connect between the window closing and this check.
      const finalCount = yield* options.connectionCount
      if (finalCount > 0) {
        idleStartMs = Option.none()
        return yield* loop
      }
      yield* Effect.logInfo("idle-shutdown.triggered").pipe(
        Effect.annotateLogs({ idleMs: now - idleStart }),
      )
      yield* Deferred.succeed(options.shutdown, void 0)
    })

    return yield* loop
  })

// ── Build owned server (in-process + HTTP listener) ──

const buildOwnedServer = (
  options: GentServerOptions,
  stateSpec: StateSpec,
  providerSpec: ProviderSpec,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope | LocalPlatform> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const platform = yield* GentPlatform
    const osInfo = yield* platform.osInfo
    const pid = yield* platform.pid
    const homeDirectory = yield* platform.homeDirectory
    const requestedPort = Option.getOrElse(Option.fromNullishOr(options.port), () => 0)
    const httpServerCtx = yield* Layer.buildWithScope(
      BunHttpServer.layer({ port: requestedPort, idleTimeout: 0 }),
      scope,
    ).pipe(
      Effect.mapError(
        (error) => new GentConnectionError({ message: `server listener failed: ${String(error)}` }),
      ),
    )
    const httpServer = Context.get(httpServerCtx, HttpServer.HttpServer)
    const port = Match.value(httpServer.address).pipe(
      Match.tag("TcpAddress", (address) => address.port),
      Match.orElse(() => 0),
    )
    if (port === 0) {
      return yield* new GentConnectionError({
        message: "server listener did not bind a concrete TCP port",
      })
    }
    const url = `http://127.0.0.1:${port}/rpc`
    const workspaceHeaders = workspaceHeadersForCwd(options.cwd)
    const home = resolveHome(stateSpec, homeDirectory)
    const serverId = yield* Option.match(Option.fromNullishOr(options.serverId), {
      onNone: () => platform.randomId,
      onSome: Effect.succeed,
    })
    const buildFingerprint = yield* (yield* BuildFingerprint).current

    const languageModelLayer = resolveLanguageModelLayer(providerSpec)
    const dbPath = yield* Match.value(stateSpec).pipe(
      Match.tagsExhaustive({
        Memory: () => Effect.succeed(Option.none<string>()),
        Sqlite: () => Effect.asSome(resolveDbPath(home)),
      }),
    )
    const serverRoot = yield* buildServerRoot({
      observability: GentObservability(options.cwd),
      dependencies: {
        cwd: options.cwd,
        // One broken user extension is reported, not fatal: the rest of the profile runs.
        failOnExtensionFailure: false,
        home,
        platform: osInfo.platform,
        osVersion: osInfo.release,
        shell: options.shell,
        authDirectory: options.authDirectory,
        state: Option.match(dbPath, {
          onNone: () => StateLocation.cases.Memory.make({}),
          onSome: (path) => StateLocation.cases.Disk.make({ dbPath: path }),
        }),
        extensions: options.extensions ?? BuiltinExtensions,
        branchTools: options.branchTools ?? CellBranchTools,
        languageModelLayerOverride: Option.getOrUndefined(languageModelLayer),
      },
      identity: {
        serverId,
        pid,
        hostname: osInfo.hostname,
        dbPath: Option.getOrElse(dbPath, () => ":memory:"),
        buildFingerprint,
      },
    }).pipe(
      Effect.mapError(
        (error) => new GentConnectionError({ message: `server root failed: ${String(error)}` }),
      ),
    )

    const HttpServerLive = HttpRouter.serve(serverRoot.httpRoutes).pipe(
      Layer.provide(Layer.succeedContext(httpServerCtx)),
      Layer.provide(serverRoot.coreServicesLive),
    )

    yield* Layer.buildWithScope(HttpServerLive, scope).pipe(Effect.orDie)

    // Seed debug session if requested
    if (options.debug === true) {
      yield* seedDebugSession(options.cwd).pipe(
        provideWorkspaceIdHeader(Headers.fromInput(workspaceHeaders)),
        Effect.provideContext(serverRoot.coreServices),
        Effect.catchEager((error) =>
          Effect.logWarning("Debug session seeding failed").pipe(
            Effect.annotateLogs({ error: String(error) }),
          ),
        ),
      )
    }

    const idleSpec = Option.fromNullishOr(options.idleShutdown)
    let awaitShutdown: Effect.Effect<void> = Effect.never
    if (Option.isSome(idleSpec)) {
      const shutdown = yield* Deferred.make<void>()
      yield* Effect.forkScoped(
        runIdleWatcher({
          idleMs: idleSpec.value.idleMs,
          connectionCount: serverRoot.connectionTracker.count,
          shutdown,
        }),
      )
      awaitShutdown = Deferred.await(shutdown)
    }

    const server: GentServer = GentServer.cases.Owned.make({
      url,
      workspaceId: workspaceIdForCwd(options.cwd),
    })
    // An in-process client opens no socket, so it registers here instead.
    // The count drops again when the client's own scope closes.
    const tracker = serverRoot.connectionTracker
    const trackInProcessClient = Effect.acquireRelease(tracker.increment, () => tracker.decrement)

    ownedInternals.set(server, {
      handlerContext: serverRoot.rpcHandlersContext,
      port,
      serverId,
      headers: workspaceHeaders,
      awaitShutdown,
      trackInProcessClient,
    })

    return server
  })

// ── Probe an existing server via identity endpoint ──

/**
 * Ask the lock's `/_gent/identity` endpoint who it is, and confirm every field.
 * Server id, db and build prove the endpoint; pid and host prove signal
 * ownership, so a pid reused after a crash is never attached to or signalled.
 */
const probeServerLockEntryIdentity = (entry: ServerLockEntry): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const baseUrl = entry.rpcUrl.replace("/rpc", "")
    const response = yield* http.get(`${baseUrl}/_gent/identity`).pipe(Effect.timeout(3000))
    if (response.status >= 400) return false
    const identity = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        serverId: Schema.String,
        pid: Schema.Finite,
        hostname: Schema.String,
        dbPath: Schema.String,
        buildFingerprint: Schema.String,
      }),
    )(yield* response.json)
    return (
      identity.serverId === entry.serverId &&
      identity.pid === entry.pid &&
      identity.hostname === entry.hostname &&
      identity.dbPath === entry.dbPath &&
      identity.buildFingerprint === entry.buildFingerprint
    )
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off self-contained probe, no scope lifetime
    Effect.provide(FetchHttpClient.layer),
    Effect.catchEager(() => Effect.succeed(false)),
  )

// ── Main server resolver ──

export const resolveServer = (
  options: GentServerOptions,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope> =>
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(resolveServerInternal(options), LocalPlatformLayer)

const resolveServerInternal = (
  options: GentServerOptions,
): Effect.Effect<GentServer, GentConnectionError, Scope.Scope | LocalPlatform> =>
  Effect.gen(function* () {
    const stateSpec = options.state ?? state.sqlite()
    const providerSpec = options.provider ?? provider.live()

    // Memory state has nothing to share; a fixed port is already the address
    // the caller hands its clients. Both are owned outright, no registry.
    if (stateSpec._tag === "Memory" || Predicate.isNotNullish(options.port)) {
      return yield* buildOwnedServer(options, stateSpec, providerSpec)
    }

    // SQLite state: shared-server aware
    const platform = yield* GentPlatform
    const home = resolveHome(stateSpec, yield* platform.homeDirectory)
    const dbPath = yield* resolveDbPath(home)
    const fingerprint = yield* (yield* BuildFingerprint).current
    const osInfo = yield* platform.osInfo
    const pid = yield* platform.pid

    // Attach to a live server of this build, on this database, that proves the lock's identity.
    const status = yield* serverLock.status(home)
    if (
      status._tag === "Alive" &&
      status.entry.buildFingerprint === fingerprint &&
      status.entry.dbPath === dbPath
    ) {
      if (yield* probeServerLockEntryIdentity(status.entry)) {
        return GentServer.cases.Attached.make({
          url: status.entry.rpcUrl,
          workspaceId: workspaceIdForCwd(options.cwd),
        })
      }
    }
    // Anything else is replaced: stop what the lock names, then write our own.
    if (status._tag !== "None") yield* serverLock.stop(home, { removeStale: true })

    const server = yield* buildOwnedServer(options, stateSpec, providerSpec)
    const internalOption = getOwnedInternal(server)
    if (Option.isSome(internalOption)) {
      const internal = internalOption.value
      yield* serverLock.write(
        home,
        new ServerLockEntry({
          serverId: internal.serverId,
          pid,
          hostname: osInfo.hostname,
          rpcUrl: server.url,
          dbPath,
          buildFingerprint: fingerprint,
          startedAt: yield* Clock.currentTimeMillis,
        }),
      )
      // Clean up the shared server lock on scope close.
      yield* Effect.addFinalizer(() =>
        serverLock.remove(home, internal.serverId).pipe(Effect.ignore),
      )
    }
    return server
  })
