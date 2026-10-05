import { expect } from "effect-bun-test"
import { Context, Effect, Fiber, FileSystem, Layer, Path, Predicate, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { GentPlatform, BranchStorage, MessageStorage, SessionStorage } from "@gent/core/host"
import {
  type createRpcHarness,
  testToolContext,
  testLeafContext,
  BunGentPlatformLive,
  SqliteStorage,
  testSqliteStorage,
  waitFor,
} from "@gent/core/test-utils"
import { BunServices } from "@effect/platform-bun"
import * as Prompt from "effect/ai/Prompt"
import {
  BranchId,
  MessageId,
  SessionId,
  ToolCallId,
  Branch,
  dateFromMillis,
  Message,
  Session,
} from "@gent/core/protocol"
import { ExtensionContext, type ExtensionContextService } from "@gent/core/extensions/api"
import type { CellOperationHost } from "../../src/cell.js"
import { CellExecution, CellStorage, CellWorker } from "../../src/cell.js"
import type { CellResponse } from "../../src/cell-protocol.js"
import type { OwnedToolCallAddress } from "@gent/core/extensions/branch-tools"

/**
 * Shared setup for the cell test files: the worker builds, the in-memory
 * storage and session the direct kernel tests run on, and recorded `cell`
 * calls on that session.
 */

// ── cell worker build ───────────────────────────────────────────────────────

/** Where the direct kernel tests run their workers: this package. */
export const packageDirectory = Effect.gen(function* () {
  const path = yield* Path.Path
  return path.resolve(yield* path.fromFileUrl(new URL("../..", import.meta.url)))
})

/** The cell worker entry the builds and the script launch run. */
export const cellWorkerSource = Effect.gen(function* () {
  const path = yield* Path.Path
  return yield* path.fromFileUrl(new URL("../../src/cell-worker-boundary.ts", import.meta.url))
})

export const buildCellWorker = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const binaryPath = yield* platform.execPath
  const directory = yield* fs.makeTempDirectoryScoped()
  const workerPath = path.join(directory, "worker.js")
  const sourcePath = yield* cellWorkerSource
  const build = yield* ChildProcess.make(
    binaryPath,
    ["build", sourcePath, "--target=bun", "--outfile", workerPath],
    { stdout: "ignore", stderr: "inherit", forceKillAfter: "5 seconds" },
  )
  expect(Number(yield* build.exitCode)).toBe(0)
  return CellWorker.cases.Script.make({ runtimePath: binaryPath, scriptPath: workerPath })
})

export const buildCellExecutable = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const bunPath = yield* platform.execPath
  const directory = yield* fs.makeTempDirectoryScoped()
  const binaryPath = path.join(directory, "gent-cell")
  const sourcePath = yield* cellWorkerSource
  const build = yield* ChildProcess.make(
    bunPath,
    [
      "build",
      sourcePath,
      "--compile",
      "--bytecode",
      "--format=esm",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "--outfile",
      binaryPath,
    ],
    { stdout: "ignore", stderr: "inherit", forceKillAfter: "5 seconds" },
  )
  expect(Number(yield* build.exitCode)).toBe(0)
  return CellWorker.cases.Compiled.make({ binaryPath })
})

// ── recorded cell execution ─────────────────────────────────────────────────

export const platform = Layer.merge(BunServices.layer, BunGentPlatformLive)
export const sessionId = SessionId.make("cell-execution-session")
export const branchId = BranchId.make("cell-execution-branch")
export const now = dateFromMillis(1_767_225_600_000)
/**
 * The test session's extension context, reading sessions and branches from
 * the test's own storage. `getSession` can be replaced to fail a lookup.
 */
export const storedSessionContext = Effect.fn("test.storedSessionContext")(function* (
  getSession?: ExtensionContextService["Session"]["getSession"],
) {
  const sessions = yield* SessionStorage
  const branches = yield* BranchStorage
  const ctx = testToolContext({ sessionId, branchId })
  return testLeafContext(
    testToolContext({
      sessionId,
      branchId,
      Session: {
        ...ctx.Session,
        getSession: getSession ?? ((id) => sessions.getSession(id ?? sessionId).pipe(Effect.orDie)),
        listBranches: branches.listBranches(sessionId).pipe(Effect.orDie),
      },
    }),
  )
})
/**
 * A test server's layer with the cell's storage over that server's database,
 * as the cell's process resource builds it, for a test that reads the
 * storage outside a cell.
 */
export const withCellStorage = <A, E, R>(server: Layer.Layer<A, E, R>) =>
  CellStorage.Live.pipe(Layer.provideMerge(server))

/** The cell's storage over an in-memory session database, for a focused storage test. */
export const cellTestStorage = Layer.provideMerge(
  CellStorage.Live,
  testSqliteStorage(Layer.empty, {}),
).pipe(Layer.provide(GentPlatform.Test()))

export const testLayer = Layer.provideMerge(
  Layer.effect(ExtensionContext, storedSessionContext()),
  Layer.provideMerge(CellStorage.Live, SqliteStorage.MemoryWithSql(Layer.empty, {})),
).pipe(Layer.provideMerge(platform))

/** A catalog that selects the named host tools, hashed by their names. */
export const hostCatalog = (...names: ReadonlyArray<string>) => ({
  hash: names.join(","),
  tools: names.map((name) => ({
    name,
    description: name,
    guidelines: [],
    parameters: {},
    signature: "",
    summary: "",
  })),
})

/** The session a handoff continues: the test session joins its thread. */
export const predecessor = {
  sessionId: SessionId.make("cell-predecessor-session"),
  branchId: BranchId.make("cell-predecessor-branch"),
}

export const setupCalls = Effect.fn("test.setupCells")(function* (
  sources: ReadonlyArray<string>,
  resetAt: ReadonlyArray<number> = [],
  handoff = false,
) {
  const sessions = yield* SessionStorage
  const branches = yield* BranchStorage
  const session = new Session({ id: sessionId, createdAt: now, updatedAt: now })
  if (handoff) {
    yield* sessions.createSession(
      new Session({ id: predecessor.sessionId, createdAt: now, updatedAt: now }),
    )
    yield* branches.createBranch(
      new Branch({ id: predecessor.branchId, sessionId: predecessor.sessionId, createdAt: now }),
    )
    yield* sessions.createSession(
      new Session({
        ...session,
        parentSessionId: predecessor.sessionId,
        parentBranchId: predecessor.branchId,
        threadId: predecessor.sessionId,
      }),
    )
  } else {
    yield* sessions.createSession(session)
  }
  yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
  return yield* Effect.forEach(sources, (code, index) =>
    recordCellCall({ branch: branchId, key: `${index}`, code, reset: resetAt.includes(index) }),
  )
})

/**
 * A cell owner for one branch of the test session; a new owner stands in for
 * a restart. `storage` replaces the cell storage the owner reads and writes.
 */
export const openCellOwner = (
  worker: Parameters<typeof CellExecution.Live>[0]["worker"],
  options: Partial<
    Omit<Parameters<typeof CellExecution.Live>[0], "worker" | "cwd" | "sessionId">
  > & { readonly storage?: typeof CellStorage.Service } = {},
) =>
  Effect.gen(function* () {
    const { storage, ...input } = options
    const live = CellExecution.Live({
      branchId,
      ...input,
      worker,
      cwd: yield* packageDirectory,
      sessionId,
    })
    if (Predicate.isUndefined(storage)) {
      return Context.get(yield* Layer.build(live), CellExecution)
    }
    const replaced = live.pipe(Layer.provide(Layer.succeed(CellStorage, storage)))
    return Context.get(yield* Layer.build(replaced), CellExecution)
  })

/** The `cell` tool results on a harness branch once its next turn completed. */
export const cellResultsAfterTurn = (
  harness: Pick<
    Effect.Success<ReturnType<typeof createRpcHarness>>,
    "client" | "sessionId" | "branchId"
  >,
) =>
  Effect.gen(function* () {
    const { client, sessionId, branchId } = harness
    yield* client.session.events({ sessionId, branchId }).pipe(
      Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
      Stream.take(1),
      Stream.runDrain,
    )
    return (yield* client.message.list({ branchId }))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result")
      .filter((part) => part.name === "cell")
  })

/** One recorded `cell` call on a branch of the test session. */
export const recordCellCall = Effect.fn("test.recordCellCall")(function* (cell: {
  readonly branch: BranchId
  readonly key: string
  readonly code: string
  readonly reset?: boolean
}) {
  const messages = yield* MessageStorage
  const call = {
    assistantMessageId: MessageId.make(`cell-message-${cell.key}`),
    toolCallId: ToolCallId.make(`cell-call-${cell.key}`),
  }
  yield* messages.createMessage(
    Message.cases.regular.make({
      id: call.assistantMessageId,
      sessionId,
      branchId: cell.branch,
      role: "assistant",
      parts: [
        Prompt.toolCallPart({
          id: call.toolCallId,
          name: "cell",
          params: { code: cell.code, reset: cell.reset === true },
          providerExecuted: false,
        }),
      ],
      createdAt: now,
    }),
  )
  return call
})

/**
 * Start an inner call that asks, and lose the worker while the call waits for
 * its answer in place, as a crash would. The operation is left waiting.
 */
export const askThenLoseWorker = (
  host: typeof CellOperationHost.Service,
  request: Extract<CellResponse, { _tag: "HostCall" }>,
  cell: OwnedToolCallAddress,
) =>
  Effect.gen(function* () {
    const asking = yield* host.call(request).pipe(Effect.forkChild)
    const waiting = yield* waitFor(
      (yield* CellStorage).operations.get({ cell, operationId: request.operationId }),
      (operation) => operation.state._tag === "Waiting",
      5_000,
      `operation ${request.operationId} waits for its answer`,
    )
    yield* Fiber.interrupt(asking)
    if (waiting.state._tag !== "Waiting") return yield* Effect.die("The operation is not waiting")
    return { toolCallId: waiting.toolCallId, requestId: waiting.state.requestId }
  })
