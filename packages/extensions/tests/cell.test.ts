import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect"
import { ChildProcess } from "effect/unstable/process"
import { GentPlatform, BranchStorage, MessageStorage, SessionStorage } from "@gent/core/host"
import {
  type LoadedExtension,
  captureTurnTools,
  collectTestContributions,
  createE2ELayer,
  plantInFlightTurn,
  plantToolCallBinding,
  provideToolDispatch,
  recordInteractionDecision,
  runtimeHostContext,
  staticToolBinding,
  storedEvents,
  createRpcHarness,
  ensureStorageParents,
  runToolWithCtx,
  testToolContext,
  testLeafContext,
  finishPart,
  LanguageModelLayers,
  multiToolCallStep,
  type SequenceStep,
  textDeltaPart,
  textStep,
  toolCallPart,
  toolCallStep,
  waitFor,
  ApprovalService,
  RuntimeEnvironment,
  BunGentPlatformLive,
  SqliteStorage,
  CurrentWorkspaceId,
  WorkspaceId,
  createRpcClient,
  toolResultMessageIdForTurn,
  testSqliteStorage,
} from "@gent/core/test-utils"
import { BunServices } from "@effect/platform-bun"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  BranchId,
  MessageId,
  SessionId,
  ToolCallId,
  assistantMessageIdForTurn,
  Branch,
  dateFromMillis,
  Message,
  Session,
  SteerCommand,
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  CONTEXT_WINDOW_MESSAGE_TYPE,
  messagePartsText,
  windowDetails,
} from "@gent/core/protocol"
import {
  ExtensionId,
  RequestId,
  InteractionPendingError,
  defineExtension,
  ExtensionContext,
  type ExtensionContextService,
  ExtensionServiceError,
  ExtensionHost,
  tool,
  type ToolCapability,
  LoadedArtifactIdentity,
  ToolResultFailure,
} from "@gent/core/extensions/api"
import {
  InteractionRequestId,
  CurrentInteractionOwner,
  InteractionRequestRecord,
  InteractionStorage,
  CurrentToolCall,
  type ResolvedToolCapability,
  ToolRunner,
  ModelContextLedger,
  StorageError,
  EventStore,
  getToolMetadata,
} from "@gent/core/extensions/branch-tools"
import {
  CellBranchTools,
  CellExecution,
  CellStorage,
  CellExtension,
  cellInteractionOwner,
  CellOperationHost,
  CellTool,
  CellWorker,
  cellWorkerLaunch,
  cellToolResultValue,
  dispatchCell,
  executeBoundCellTool,
  handleContextCall,
  makeCellToolHost,
  openCellKernel,
  openCellProcess,
  pageText,
  recoverCellExecution,
  renderToolSignature,
  resumeCellToolOperation,
} from "../src/cell.js"
import { BashTool } from "../src/exec-tools.js"
import { BuiltinExtensions } from "../src/index.js"
import { EditTool, GrepTool, ReadTool, WriteTool } from "../src/fs-tools.js"
import { GoalTool } from "../src/goal.js"
import { AskUserTool, HandoffTool, PromptTool } from "../src/interaction-tools.js"
import { WebSearchTool } from "../src/network-tools.js"
import { ReadSessionTool } from "../src/session-tools.js"
import { CancelTool, MonitorTool, WakeTool } from "../src/wake.js"
import {
  CellEvaluationError,
  CellProtocolError,
  CellRequest,
  CellResponse,
  decodeCellResponse,
  encodeCellRequest,
  makeCellFrameReader,
} from "../src/cell-protocol.js"
import { shippedPreset } from "./helpers/test-preset.js"
import {
  ChildAgentHandle,
  CancelChild,
  DelegateEntry,
  DelegateExtension,
  ListChildren,
  StartChild,
} from "../src/delegate.js"
import { SqlClient } from "effect/unstable/sql"
import { CompactionExtension } from "../src/compaction.js"

// ── cell worker build ───────────────────────────────────────────────────────

/** Where the direct kernel tests run their workers: this package. */
const packageDirectory = new URL("..", import.meta.url).pathname

export const buildCellWorker = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* GentPlatform
  const binaryPath = yield* platform.execPath
  const directory = yield* fs.makeTempDirectoryScoped()
  const workerPath = path.join(directory, "worker.js")
  const sourcePath = new URL("../src/cell-worker-boundary.ts", import.meta.url).pathname
  const build = yield* ChildProcess.make(
    binaryPath,
    ["build", sourcePath, "--target=bun", "--outfile", workerPath],
    { stdout: "ignore", stderr: "inherit" },
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
  const sourcePath = new URL("../src/cell-worker-boundary.ts", import.meta.url).pathname
  const build = yield* ChildProcess.make(
    bunPath,
    [
      "build",
      sourcePath,
      "--compile",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "--outfile",
      binaryPath,
    ],
    { stdout: "ignore", stderr: "inherit" },
  )
  expect(Number(yield* build.exitCode)).toBe(0)
  return CellWorker.cases.Compiled.make({ binaryPath })
})

// ── recorded cell execution ─────────────────────────────────────────────────

const platform = Layer.merge(BunServices.layer, BunGentPlatformLive)
const sessionId = SessionId.make("cell-execution-session")
const branchId = BranchId.make("cell-execution-branch")
const now = dateFromMillis(1_767_225_600_000)
/**
 * The test session's extension context, reading sessions and branches from
 * the test's own storage. `getSession` can be replaced to fail a lookup.
 */
const storedSessionContext = Effect.fn("test.storedSessionContext")(function* (
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
const testLayer = Layer.provideMerge(
  Layer.effect(ExtensionContext, storedSessionContext()),
  SqliteStorage.MemoryWithSql(CellBranchTools.storage, CellBranchTools.migrations),
).pipe(Layer.provideMerge(platform))

/** A worker the test never launches: the cell settles before it needs one. */
const unusedWorker = CellWorker.cases.Script.make({
  runtimePath: "/nonexistent/bun",
  scriptPath: "/nonexistent/worker.js",
})

/** A catalog that selects the named host tools, hashed by their names. */
const hostCatalog = (...names: ReadonlyArray<string>) => ({
  hash: names.join(","),
  tools: names.map((name) => ({ name, description: name, guidelines: [], parameters: {} })),
})

/** The session a handoff continues: the test session joins its thread. */
const predecessor = {
  sessionId: SessionId.make("cell-predecessor-session"),
  branchId: BranchId.make("cell-predecessor-branch"),
}

const setupCalls = Effect.fn("test.setupCells")(function* (
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

/** Save a namespace holding `notes` for the predecessor's branch. */
const saveForPredecessor = (notes: ReadonlyArray<string>) =>
  Effect.flatMap(Effect.service(CellStorage), (storage) =>
    storage.namespaces.set(predecessor, {
      bindings: [{ name: "notes", value: notes }],
      omitted: [],
    }),
  )

/** A cell owner for one branch of the test session; a new owner stands in for a restart. */
const openCellOwner = (
  worker: Parameters<typeof CellExecution.Live>[0]["worker"],
  branch: BranchId = branchId,
) =>
  Effect.map(
    Layer.build(CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId: branch })),
    (context) => Context.get(context, CellExecution),
  )

/** Run a recorded cell with a host that selects no tools. */
const runCell = (
  owner: typeof CellExecution.Service,
  call: Parameters<typeof CellExecution.Service.run>[0],
) =>
  owner
    .run(call)
    .pipe(
      Effect.provideService(
        CellOperationHost,
        CellOperationHost.of({ catalog: hostCatalog(), call: () => Effect.never }),
      ),
    )

/** One recorded `cell` call on a branch of the test session. */
const recordCellCall = Effect.fn("test.recordCellCall")(function* (cell: {
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

describe("recorded cell execution", () => {
  it.scopedLive(
    "records reset once and does not clear newer state on repeat",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [first, reset, next, read] = yield* setupCalls(
          ["let kept = 21; kept", "typeof kept", "let kept = 42; kept", "kept"],
          [1],
        )
        if (!first || !reset || !next || !read) return yield* Effect.die("Missing cells")
        const execution = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const run = (call: Parameters<typeof execution.run>[0]) =>
          execution.run(call).pipe(Effect.provideService(CellOperationHost, host))
        expect((yield* run(first)).result).toMatchObject({ display: "21" })
        const cleared = yield* run(reset)
        expect(cleared).toMatchObject({ isFailure: false, result: { display: "undefined" } })
        expect((yield* run(next)).result).toMatchObject({ display: "42" })
        expect(yield* run(reset)).toEqual(cleared)
        expect((yield* run(read)).result).toMatchObject({ display: "42" })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "cancels active and queued cells without replay and replaces the lost worker",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [first, second, third, fourth] = yield* setupCalls(
          ["await tools.wait({})", "await tools['must-not-run']({})", "1", "6 * 7"],
          [3],
        )
        if (!first || !second || !third || !fourth) return yield* Effect.die("Missing test cells")
        const started = yield* Deferred.make<boolean>()
        const stopped = yield* Deferred.make<boolean>()
        const calls = yield* Ref.make(0)
        const host = CellOperationHost.of({
          catalog: hostCatalog("wait", "must-not-run"),
          call: () =>
            Ref.update(calls, (n) => n + 1).pipe(
              Effect.andThen(Deferred.succeed(started, true)),
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, true)),
            ),
        })
        const context = yield* Layer.build(
          CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
        )
        const cells = Context.get(context, CellExecution)
        const running = yield* cells
          .run(first)
          .pipe(
            Effect.provideService(CellOperationHost, host),
            Effect.forkScoped({ startImmediately: true }),
          )
        yield* Deferred.await(started)
        const queued = yield* cells
          .run(second)
          .pipe(
            Effect.provideService(CellOperationHost, host),
            Effect.forkScoped({ startImmediately: true }),
          )
        yield* cells.cancel
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        const cancelled = yield* Fiber.join(running)
        expect(cancelled).toMatchObject({
          isFailure: true,
          result: {
            reason: "cancelled",
            stateLost: true,
            // The host recorded no operation, so no effect is claimed.
            message: "Cell cancelled. Its source was not replayed. It made no host operation.",
          },
        })
        expect(yield* Fiber.join(queued)).toMatchObject({
          isFailure: true,
          result: { message: "Cell did not start because execution was cancelled." },
        })
        expect(
          yield* cells.run(first).pipe(Effect.provideService(CellOperationHost, host)),
        ).toEqual(cancelled)
        // The host replaces the lost worker itself; no namespace was saved yet, so nothing is restored.
        expect(
          yield* cells.run(third).pipe(Effect.provideService(CellOperationHost, host)),
        ).toMatchObject({ isFailure: false, result: { display: "1" } })
        expect(
          yield* cells.run(fourth).pipe(Effect.provideService(CellOperationHost, host)),
        ).toMatchObject({ isFailure: false, result: { display: "42" } })
        expect(yield* Ref.get(calls)).toBe(1)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "a cell that reaches the executor after its loop stopped does not start",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [late] = yield* setupCalls(["await tools.mark({})"])
        if (!late) return yield* Effect.die("Missing test cell")
        const calls = yield* Ref.make(0)
        const host = CellOperationHost.of({
          catalog: hostCatalog("mark"),
          call: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as(true)),
        })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        yield* cells.stop
        const exit = yield* cells
          .run(late)
          .pipe(Effect.provideService(CellOperationHost, host), Effect.exit)
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(yield* Ref.get(calls)).toBe(0)
        // Never admitted: a restart re-issues the call instead of settling it.
        expect(
          Option.isNone(
            yield* (yield* CellStorage).executions.get({ ...late, sessionId, branchId }),
          ),
        ).toBe(true)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "a cell stopped between its claim and its start records that it did not start",
    () =>
      Effect.gen(function* () {
        const [late] = yield* setupCalls(["await tools.mark({})"])
        if (!late) return yield* Effect.die("Missing test cell")
        const claimed = yield* Deferred.make<boolean>()
        const proceed = yield* Deferred.make<boolean>()
        const real = yield* CellStorage
        // The claim commits, then the loop stops before evaluation starts.
        const gated = CellStorage.of({
          ...real,
          executions: {
            ...real.executions,
            claim: (address) =>
              real.executions.claim(address).pipe(
                Effect.tap(() => Deferred.succeed(claimed, true)),
                Effect.tap(() => Deferred.await(proceed)),
              ),
          },
        })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({
              worker: unusedWorker,
              cwd: packageDirectory,
              sessionId,
              branchId,
            }).pipe(Layer.provide(Layer.succeed(CellStorage, gated))),
          ),
          CellExecution,
        )
        const host = CellOperationHost.of({
          catalog: hostCatalog("mark"),
          call: () => Effect.die("A cell that never started made a host call"),
        })
        const running = yield* cells
          .run(late)
          .pipe(Effect.provideService(CellOperationHost, host), Effect.forkScoped)
        yield* Deferred.await(claimed)
        const stopping = yield* cells.stop.pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.succeed(proceed, true)
        yield* Fiber.join(stopping)
        expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true)
        // Recovery reads this record: the cell did not start, not a lost worker.
        expect(
          yield* (yield* CellStorage).executions.get({ ...late, sessionId, branchId }),
        ).toMatchObject(
          Option.some({
            _tag: "Completed",
            result: {
              isFailure: true,
              result: { message: "Cell did not start because execution was cancelled." },
            },
          }),
        )
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "a cell admitted again with no result says what its recorded operations did",
    () =>
      Effect.gen(function* () {
        const [cell] = yield* setupCalls(["await tools.write({})"])
        if (!cell) return yield* Effect.die("Missing test cell")
        const address = { ...cell, sessionId, branchId }
        const storage = yield* CellStorage
        yield* storage.executions.claim(address)
        // Two operations started and recorded no result before the run was lost.
        yield* Effect.forEach(["1", "2"], (operationId) =>
          storage.operations.admit({
            cell: address,
            operationId,
            binding: staticToolBinding({
              toolId: "write",
              extensionId: "files",
              sourceRevision: "source-1",
              schemaRevision: "schema-1",
            }),
            input: { operationId },
          }),
        )
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({
              worker: unusedWorker,
              cwd: packageDirectory,
              sessionId,
              branchId,
            }),
          ),
          CellExecution,
        )
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const incomplete = yield* cells
          .run(cell)
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(incomplete).toMatchObject({
          _tag: "CellExecutionIncomplete",
          message:
            "The cell has no recorded result. 2 operations ran with no recorded result; their effects may have occurred. Its source was not replayed.",
        })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "a cancelled cell whose operation list cannot be read still records its cancel",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [cell] = yield* setupCalls(["await tools.wait({})"])
        if (!cell) return yield* Effect.die("Missing test cell")
        const started = yield* Deferred.make<boolean>()
        const real = yield* CellStorage
        const broken = CellStorage.of({
          ...real,
          operations: {
            ...real.operations,
            listForToolCall: () =>
              Effect.fail(new StorageError({ message: "operation list unavailable" })),
          },
        })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }).pipe(
              Layer.provide(Layer.succeed(CellStorage, broken)),
            ),
          ),
          CellExecution,
        )
        const host = CellOperationHost.of({
          catalog: hostCatalog("wait"),
          call: () => Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)),
        })
        const running = yield* cells
          .run(cell)
          .pipe(Effect.provideService(CellOperationHost, host), Effect.forkScoped)
        yield* Deferred.await(started)
        yield* cells.cancel
        const cancelled = yield* Fiber.join(running)
        expect(cancelled).toMatchObject({
          isFailure: true,
          result: { reason: "cancelled", message: "Cell cancelled. Its source was not replayed." },
        })
        expect(
          yield* (yield* CellStorage).executions.get({ ...cell, sessionId, branchId }),
        ).toMatchObject(Option.some({ _tag: "Completed", result: cancelled }))
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "a host operation's failure reaches the model as its message, without the worker's stack",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [uncaught] = yield* setupCalls(["console.log('before'); await tools.start({})"])
        if (!uncaught) return yield* Effect.die("Missing test cell")
        const refusal = "Parent branch already has 8 unfinished children"
        const host = CellOperationHost.of({
          catalog: hostCatalog("start"),
          call: () =>
            Effect.fail(
              new CellEvaluationError({ phase: "execute", message: refusal, output: "" }),
            ),
        })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const failed = yield* cells
          .run(uncaught)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(failed).toMatchObject({
          isFailure: true,
          result: { _tag: "CellEvaluationError", message: refusal, output: "before" },
        })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "a thrown error reaches the model as its name and message, without a stack",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [unknownTool, typeError, withCause] = yield* setupCalls([
          "await tools.nope({})",
          "const o = null; o.x",
          "throw new Error('outer', { cause: new RangeError('inner') })",
        ])
        if (!unknownTool || !typeError || !withCause) return yield* Effect.die("Missing test cells")
        const host = CellOperationHost.of({
          catalog: hostCatalog("start"),
          call: () => Effect.succeed({}),
        })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const message = (call: typeof unknownTool) =>
          cells.run(call).pipe(
            Effect.provideService(CellOperationHost, host),
            Effect.map(
              (reply) =>
                Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(reply.result)
                  .message,
            ),
          )
        expect(yield* message(unknownTool)).toBe(
          "Error: tools.nope is not a host tool selected for this turn. Close ids: start",
        )
        const typeErrorMessage = yield* message(typeError)
        expect(typeErrorMessage.startsWith("TypeError: ")).toBe(true)
        expect(typeErrorMessage).not.toContain("\n")
        expect(yield* message(withCause)).toBe("Error: outer\ncaused by RangeError: inner")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "an error keeps the detail it holds outside its message, and a caught one shows no stack",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [aggregate, syntax, shell, caught] = yield* setupCalls([
          "await Promise.any([Promise.reject(new Error('first')), Promise.reject(new RangeError('second'))])",
          "const a = 1\nlet x = ;",
          "await Bun.$`sh -c 'echo shell-detail >&2; exit 3'`",
          "try { await tools.nope({}) } catch (e) { console.log(e) }",
        ])
        if (!aggregate || !syntax || !shell || !caught)
          return yield* Effect.die("Missing test cells")
        const host = CellOperationHost.of({
          catalog: hostCatalog("start"),
          call: () => Effect.succeed({}),
        })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        // A failure carries its text as `message`; a finished cell as `display`.
        const ReplyText = Schema.Union([
          Schema.Struct({ message: Schema.String }),
          Schema.Struct({ display: Schema.String }),
        ])
        const reply = (call: typeof aggregate) =>
          cells.run(call).pipe(
            Effect.provideService(CellOperationHost, host),
            Effect.map((result) => {
              const text = Schema.decodeUnknownSync(ReplyText)(result.result)
              if ("message" in text) return text.message
              return text.display
            }),
          )
        const aggregateText = yield* reply(aggregate)
        expect(aggregateText).toContain("AggregateError")
        expect(aggregateText).toContain("Error: first")
        expect(aggregateText).toContain("RangeError: second")
        expect(yield* reply(syntax)).toMatch(/line \d+, column \d+: let x = ;/)
        expect(yield* reply(shell)).toContain("shell-detail")
        const caughtText = yield* reply(caught)
        expect(caughtText).toContain("tools.nope is not a host tool")
        expect(caughtText).not.toMatch(/\bat [^ ]+ \(/)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  // A bound function prints as native code, so only identity marks a host
  // getter. A cell's getter that never returns must not hang its worker. The
  // error is thrown, not bound, so only the error reader sees it.
  it.scopedLive(
    "a cell's own bound getter on a thrown error never runs",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [define, looping, after] = yield* setupCalls([
          "let kept = 7",
          "throw Object.defineProperty(new Error('x'), 'message', { get: function () { for (;;) {} }.bind(null) })",
          "kept",
        ])
        if (!define || !looping || !after) return yield* Effect.die("Missing test cells")
        const host = CellOperationHost.of({
          catalog: hostCatalog("start"),
          call: () => Effect.succeed({}),
        })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const ReplyText = Schema.Union([
          Schema.Struct({ message: Schema.String }),
          Schema.Struct({ display: Schema.String }),
        ])
        const reply = (call: typeof looping) =>
          cells.run(call).pipe(
            Effect.provideService(CellOperationHost, host),
            Effect.map((result) => {
              const text = Schema.decodeUnknownSync(ReplyText)(result.result)
              if ("message" in text) return text.message
              return text.display
            }),
          )
        expect(yield* reply(define)).toBe("7")
        expect(yield* reply(looping)).toBe("Error")
        expect(yield* reply(after)).toBe("7")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  // The namespace snapshot after each good cell reads every binding. A read
  // that ran a looping getter, trap or coercion held the worker until the
  // compute deadline replaced it, and the namespace was lost.
  const snapshotHazards: ReadonlyArray<{
    readonly name: string
    readonly source: string
    readonly probe: string
    readonly display: string
    readonly restored: ReadonlyArray<string>
    readonly omitted: ReadonlyArray<{ readonly name: string; readonly reason: string }>
  }> = [
    {
      name: "an error with a looping message getter",
      source:
        "var hazard = Object.defineProperty(new Error('x'), 'message', { get() { for (;;) {} } }); 1",
      probe: "kept",
      display: "7",
      restored: ["kept"],
      omitted: [{ name: "hazard", reason: "unsupported" }],
    },
    {
      name: "a plain object with a looping getter",
      source: "var hazard = { data: 1, get looping() { for (;;) {} } }; 1",
      probe: "kept",
      display: "7",
      restored: ["kept"],
      omitted: [{ name: "hazard", reason: "unsupported" }],
    },
    {
      name: "a plain object with a looping Symbol.toStringTag getter, saved without its symbol keys",
      source: "var hazard = { data: 1, get [Symbol.toStringTag]() { for (;;) {} } }; 1",
      probe: "[kept, JSON.stringify(hazard)].join(',')",
      display: '7,{"data":1}',
      restored: ["kept", "hazard"],
      omitted: [],
    },
    {
      name: "a Proxy with looping traps",
      source:
        "var hazard = new Proxy({}, { get() { for (;;) {} }, ownKeys() { for (;;) {} }, getPrototypeOf() { for (;;) {} }, getOwnPropertyDescriptor() { for (;;) {} } }); 1",
      probe: "kept",
      display: "7",
      restored: ["kept"],
      omitted: [{ name: "hazard", reason: "unsupported" }],
    },
    {
      name: "a plain object over a Proxy prototype",
      source: "var hazard = Object.create(new Proxy({}, { getPrototypeOf() { for (;;) {} } })); 1",
      probe: "kept",
      display: "7",
      restored: ["kept"],
      omitted: [{ name: "hazard", reason: "unsupported" }],
    },
    {
      name: "an error message with a looping toString and Symbol.toPrimitive",
      source:
        "var hazard = new Error('x'); hazard.message = { toString() { for (;;) {} }, [Symbol.toPrimitive]() { for (;;) {} } }; 1",
      probe: "kept",
      display: "7",
      restored: ["kept"],
      omitted: [{ name: "hazard", reason: "unsupported" }],
    },
    {
      name: "a RegExp subclass that overrides source, flags and global",
      source:
        "class Looping extends RegExp { get source() { for (;;) {} } get flags() { for (;;) {} } get global() { for (;;) {} } }; var hazard = new Looping('a+', 'gi'); 1",
      probe: "[kept, hazard instanceof RegExp, hazard.source, hazard.flags].join(',')",
      display: "7,true,a+,gi",
      restored: ["kept", "hazard"],
      omitted: [{ name: "Looping", reason: "function" }],
    },
  ]
  for (const hazard of snapshotHazards) {
    it.scopedLive(
      `the snapshot never runs cell code: ${hazard.name}`,
      () =>
        Effect.gen(function* () {
          const worker = yield* buildCellWorker
          const [define, bind, after, probe] = yield* setupCalls([
            "let kept = 7; kept",
            hazard.source,
            "kept",
            hazard.probe,
          ])
          if (!define || !bind || !after || !probe) return yield* Effect.die("Missing test cells")
          const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
          const open = Effect.gen(function* () {
            const context = yield* Layer.build(
              CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
            )
            return Context.get(context, CellExecution)
          })
          const cells = yield* open
          const run = (owner: typeof cells, call: typeof define) =>
            owner.run(call).pipe(Effect.provideService(CellOperationHost, host))
          expect((yield* run(cells, define)).result).toMatchObject({ display: "7" })
          expect((yield* run(cells, bind)).result).toMatchObject({ display: "1" })
          // The next cell answers from the same worker: no restore report.
          const next = (yield* run(cells, after)).result
          expect(next).toMatchObject({ display: "7" })
          expect(next).not.toHaveProperty("restored")
          // A second owner stands in for a restart: the saved namespace keeps the earlier binding.
          const restarted = yield* open
          expect((yield* run(restarted, probe)).result).toMatchObject({
            display: hazard.display,
            restored: { restored: hazard.restored, omitted: hazard.omitted },
          })
        }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
      10000,
    )
  }

  // The error reader walks a thrown value's prototype chain. A Proxy in that
  // chain once ran its trap there, and a looping trap held the worker.
  it.scopedLive(
    "a thrown value over a looping Proxy prototype fails its cell; the worker lives",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [define, thrown, after] = yield* setupCalls([
          "let kept = 7",
          "throw Object.create(new Proxy({}, { getPrototypeOf() { for (;;) {} }, get() { for (;;) {} } }))",
          "kept",
        ])
        if (!define || !thrown || !after) return yield* Effect.die("Missing test cells")
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const run = (call: typeof define) =>
          cells.run(call).pipe(Effect.provideService(CellOperationHost, host))
        expect((yield* run(define)).result).toMatchObject({ display: "7" })
        expect((yield* run(thrown)).result).toMatchObject({
          message: "A thrown value that cannot be read",
        })
        expect((yield* run(after)).result).toMatchObject({ display: "7" })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  // A cell can replace a shared built-in. The worker puts every built-in back
  // after the cell, before the display and the snapshot, and names it. The
  // snapshot once called the replacement and saved what it said.
  const replacedIntrinsics: ReadonlyArray<{
    readonly name: string
    readonly source: string
    readonly shown: string
    readonly probe: string
    readonly display: string
  }> = [
    {
      name: "BigInt.prototype.toString",
      source:
        "BigInt.prototype.toString = function () { globalThis.readerRan = true; return '1' }; var saved = 5n; 1",
      shown: "1\nPut back built-ins the cell changed: BigInt.prototype.toString",
      probe: "String(saved === 5n)",
      display: "true",
    },
    {
      name: "the array iterator",
      source:
        "const original = Array.prototype[Symbol.iterator]; const holds = Array.prototype.includes; Array.prototype[Symbol.iterator] = function () { if (holds.call(this, 'probe-key') || holds.call(this, 'saved')) globalThis.readerRan = true; return original.call(this) }; var saved = new Map([['probe-key', 5]]); 1",
      shown: "1\nPut back built-ins the cell changed: Array.prototype[Symbol(Symbol.iterator)]",
      probe: "String(saved.get('probe-key'))",
      display: "5",
    },
    {
      name: "Map.prototype.set",
      source:
        "const set = Map.prototype.set; Map.prototype.set = function (key, value) { if (key === 'saved') globalThis.readerRan = true; return set.call(this, key, key === 'saved' ? 999 : value) }; var saved = 5; 1",
      shown: "1\nPut back built-ins the cell changed: Map.prototype.set",
      probe: "String(saved)",
      display: "5",
    },
    {
      name: "Object.prototype.toJSON",
      source:
        "Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value: function () { if (this && this.b === 'probe') { globalThis.readerRan = true; return { a: 2, b: 'probe' } } return this } }); var saved = { a: 1, b: 'probe' }; 1",
      shown: "1\nPut back built-ins the cell changed: Object.prototype.toJSON",
      probe: "String(saved.a)",
      display: "1",
    },
    {
      name: "global Reflect",
      source:
        "const R = Reflect; globalThis.Reflect = new Proxy(R, { get(target, key) { const found = R.get(target, key); if (typeof found !== 'function') return found; return (...args) => { globalThis.readerRan = true; return R.apply(found, target, args) } } }); var saved = { a: 1 }; 1",
      shown: "1\nPut back built-ins the cell changed: globalThis.Reflect",
      probe: "String(saved.a)",
      display: "1",
    },
    {
      name: "global Symbol",
      source:
        "const S = Symbol; globalThis.Symbol = new Proxy(S, { get(target, key) { if (key === 'toStringTag') globalThis.readerRan = true; return Reflect.get(target, key) } }); var saved = 1; ({ a: 1 })",
      shown: "{ a: 1 }\nPut back built-ins the cell changed: globalThis.Symbol",
      probe: "String(saved)",
      display: "1",
    },
  ]
  for (const replaced of replacedIntrinsics) {
    it.scopedLive(
      `the display and the snapshot never call a replaced ${replaced.name}`,
      () =>
        Effect.gen(function* () {
          const worker = yield* buildCellWorker
          const [bind, ran, probe] = yield* setupCalls([
            replaced.source,
            "String(globalThis.readerRan === true)",
            replaced.probe,
          ])
          if (!bind || !ran || !probe) return yield* Effect.die("Missing test cells")
          const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
          const open = Effect.gen(function* () {
            const context = yield* Layer.build(
              CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
            )
            return Context.get(context, CellExecution)
          })
          const cells = yield* open
          const run = (owner: typeof cells, call: typeof bind) =>
            owner.run(call).pipe(Effect.provideService(CellOperationHost, host))
          expect((yield* run(cells, bind)).result).toMatchObject({ display: replaced.shown })
          expect((yield* run(cells, ran)).result).toMatchObject({ display: "false" })
          // A restarted owner restores the value the cell bound, not what the replacement said.
          const restarted = yield* open
          expect((yield* run(restarted, probe)).result).toMatchObject({
            display: replaced.display,
          })
        }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
      10000,
    )
  }

  // A built-in the worker cannot put back retires the worker. The snapshot
  // after a good cell then fails, and the next cell once failed with "reset
  // before evaluating" instead of restoring the namespace saved before it.
  const stuckBuiltins: ReadonlyArray<{
    readonly name: string
    readonly source: string
    readonly reply: string
  }> = [
    {
      name: "a good cell",
      source: "Object.defineProperty(Map.prototype, 'stuck', { value: 1 }); var lost = 1; 2",
      reply: "display",
    },
    {
      name: "a failed cell",
      source:
        "Object.defineProperty(Map.prototype, 'stuck', { value: 1 }); throw new Error('boom')",
      reply: "output",
    },
  ]
  for (const stuck of stuckBuiltins) {
    it.scopedLive(
      `a built-in the worker cannot put back after ${stuck.name} replaces the worker, and the next cell restores`,
      () =>
        Effect.gen(function* () {
          const worker = yield* buildCellWorker
          const [define, change, after, probe] = yield* setupCalls([
            "var kept = 7",
            stuck.source,
            "kept",
            "[typeof lost, typeof Map.prototype.stuck].join(',')",
          ])
          if (!define || !change || !after || !probe) return yield* Effect.die("Missing test cells")
          const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
          const cells = Context.get(
            yield* Layer.build(
              CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
            ),
            CellExecution,
          )
          const run = (call: typeof define) =>
            cells.run(call).pipe(Effect.provideService(CellOperationHost, host))
          yield* run(define)
          const changed = (yield* run(change)).result
          expect(changed).toHaveProperty(
            stuck.reply,
            expect.stringContaining(
              "Built-ins the cell changed that cannot be put back: Map.prototype.stuck. The host replaces this worker",
            ),
          )
          expect((yield* run(after)).result).toMatchObject({
            display: "7",
            restored: { restored: ["kept"], omitted: [] },
          })
          expect((yield* run(probe)).result).toMatchObject({ display: "undefined,undefined" })
        }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
      10000,
    )
  }

  // The worker's own runtime calls some built-ins between the cell's return
  // and the put-back: a promise's `then`, and Array `push` and `pop`. The
  // put-back once ran after that code, so a cell that replaced one of them
  // held the worker to the deadline or lost its result.
  const runtimeBuiltins: ReadonlyArray<{
    readonly name: string
    readonly source: string
    /** The result field: `display` for a good cell, `output` for a failed one. */
    readonly reply: "display" | "output"
    readonly shown: string
  }> = [
    {
      name: "Promise.prototype.then before an await",
      source: "Promise.prototype.then = function () {}; await null; 2",
      reply: "display",
      shown: "2\nPut back built-ins the cell changed: Promise.prototype.then",
    },
    {
      name: "Array.prototype.pop",
      source: "Array.prototype.pop = function () { return undefined }; 2",
      reply: "display",
      shown: "2\nPut back built-ins the cell changed: Array.prototype.pop",
    },
    {
      name: "Array.prototype.push",
      source: "Array.prototype.push = function () { return 0 }; 2",
      reply: "display",
      shown: "2\nPut back built-ins the cell changed: Array.prototype.push",
    },
    {
      name: "Array.prototype.push after an await",
      source: "await null; Array.prototype.push = function () { throw new Error('push') }; 2",
      reply: "display",
      shown: "2\nPut back built-ins the cell changed: Array.prototype.push",
    },
    {
      name: "Array.prototype.pop and then throws",
      source: "Array.prototype.pop = function () { return undefined }; throw new Error('boom')",
      reply: "output",
      shown: "Put back built-ins the cell changed: Array.prototype.pop",
    },
    {
      name: "Array.prototype.pop after an await and then throws",
      source:
        "await null; Array.prototype.pop = function () { return undefined }; throw new Error('boom')",
      reply: "output",
      shown: "Put back built-ins the cell changed: Array.prototype.pop",
    },
  ]
  for (const builtin of runtimeBuiltins) {
    it.scopedLive(
      `a cell that replaces ${builtin.name} shows its result; the worker lives`,
      () =>
        Effect.gen(function* () {
          const worker = yield* buildCellWorker
          const [define, change, after] = yield* setupCalls([
            "var kept = 7",
            builtin.source,
            "kept",
          ])
          if (!define || !change || !after) return yield* Effect.die("Missing test cells")
          const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
          const cells = Context.get(
            yield* Layer.build(
              CellExecution.Live({
                worker,
                cwd: packageDirectory,
                sessionId,
                branchId,
                evaluationTimeoutMs: 3000,
              }),
            ),
            CellExecution,
          )
          const run = (call: typeof define) =>
            cells.run(call).pipe(Effect.provideService(CellOperationHost, host))
          yield* run(define)
          expect((yield* run(change)).result).toHaveProperty(
            builtin.reply,
            expect.stringContaining(builtin.shown),
          )
          const next = (yield* run(after)).result
          expect(next).toMatchObject({ display: "7" })
          expect(next).not.toHaveProperty("restored")
        }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
      10000,
    )
  }

  // A `then` the realm refuses to put back is still in place when the worker
  // waits for the cell's promise; the worker waits through the `then` it
  // saved when it loaded, and the host then replaces it.
  it.scopedLive(
    "a cell that makes Promise.prototype.then stuck shows its result; the next cell restores",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [define, change, after] = yield* setupCalls([
          "var kept = 7",
          "Object.defineProperty(Promise.prototype, 'then', { value: function () {}, writable: false, configurable: false }); await null; 2",
          "[kept, typeof Promise.prototype.then].join(',')",
        ])
        if (!define || !change || !after) return yield* Effect.die("Missing test cells")
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({
              worker,
              cwd: packageDirectory,
              sessionId,
              branchId,
              evaluationTimeoutMs: 3000,
            }),
          ),
          CellExecution,
        )
        const run = (call: typeof define) =>
          cells.run(call).pipe(Effect.provideService(CellOperationHost, host))
        yield* run(define)
        const changed = (yield* run(change)).result
        expect(changed).toHaveProperty(
          "display",
          expect.stringContaining(
            "2\nBuilt-ins the cell changed that cannot be put back: Promise.prototype.then",
          ),
        )
        expect((yield* run(after)).result).toMatchObject({
          display: "7,function",
          restored: { restored: ["kept"], omitted: [] },
        })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  // A timer's error is rendered after the put-back: the text of a stray error
  // once called the built-ins the timer had just replaced.
  it.scopedLive(
    "a timer's uncaught error is shown without the built-ins the timer replaced",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [start, wait, after] = yield* setupCalls([
          "setTimeout(() => { const join = Array.prototype.join; const push = Array.prototype.push; Array.prototype.join = function (...parts) { globalThis.ran = true; return join.apply(this, parts) }; Array.prototype.push = function (...items) { globalThis.ran = true; return push.apply(this, items) }; throw new Error('late') }, 5); 1",
          "await Bun.sleep(100); String(globalThis.ran)",
          "String(globalThis.ran)",
        ])
        if (!start || !wait || !after) return yield* Effect.die("Missing test cells")
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const DisplayText = Schema.Struct({ display: Schema.String })
        const display = (call: typeof start) =>
          cells.run(call).pipe(
            Effect.provideService(CellOperationHost, host),
            Effect.map((result) => Schema.decodeUnknownSync(DisplayText)(result.result).display),
          )
        yield* display(start)
        const waited = yield* display(wait)
        const shown = `${waited}\n${yield* display(after)}`
        expect(waited.endsWith("undefined")).toBe(true)
        expect(shown.endsWith("undefined")).toBe(true)
        expect(shown).toContain("Uncaught (from cell 1): Error: late")
        expect(shown).toContain("Array.prototype.join")
        expect(shown).toContain("Array.prototype.push")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  // A change the snapshot finds, made after the cell's own check, retires the
  // worker. Its note once went only to a worker the host then discarded.
  it.scopedLive(
    "a built-in stuck after the cell's check is named in that cell's result",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [define, change, after] = yield* setupCalls([
          "var kept = 7",
          "setTimeout(() => Object.defineProperty(Map.prototype, 'late', { value: 1 }), 0); var lost = 1; 2",
          "[kept, typeof lost, typeof Map.prototype.late].join(',')",
        ])
        if (!define || !change || !after) return yield* Effect.die("Missing test cells")
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const cells = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const run = (call: typeof define) =>
          cells.run(call).pipe(Effect.provideService(CellOperationHost, host))
        yield* run(define)
        const changed = (yield* run(change)).result
        expect(changed).toHaveProperty("display", expect.stringContaining("Map.prototype.late"))
        expect((yield* run(after)).result).toMatchObject({
          display: "7,undefined,undefined",
          restored: { restored: ["kept"], omitted: [] },
        })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  // Display once went through `inspect`, which reads `Symbol.toStringTag` with
  // a plain get and walks the prototype chain: a looping getter or trap held
  // the worker until the deadline, for a logged, returned, thrown or uncaught value.
  const displayHazards: ReadonlyArray<{
    readonly name: string
    readonly source: string
    readonly shown: string
  }> = [
    {
      name: "a logged value",
      source: "console.log({ get [Symbol.toStringTag]() { for (;;) {} } }); 1",
      shown: "{ Symbol(Symbol.toStringTag): [Getter] }\n1",
    },
    {
      name: "a returned value",
      source: "({ get [Symbol.toStringTag]() { for (;;) {} } })",
      shown: "{ Symbol(Symbol.toStringTag): [Getter] }",
    },
    {
      name: "a logged value over a looping Proxy prototype",
      source:
        "console.log(Object.create(new Proxy({}, { get() { for (;;) {} }, getOwnPropertyDescriptor() { for (;;) {} }, getPrototypeOf() { for (;;) {} } }))); 1",
      shown: "[Object: unreadable prototype] {}\n1",
    },
    {
      name: "a thrown error's cause",
      source:
        "throw new Error('outer', { cause: { data: 1, get [Symbol.toStringTag]() { for (;;) {} } } })",
      shown: "Error: outer\ncaused by { data: 1, Symbol(Symbol.toStringTag): [Getter] }",
    },
  ]
  for (const hazard of displayHazards) {
    it.scopedLive(
      `display never runs cell code: ${hazard.name}`,
      () =>
        Effect.gen(function* () {
          const worker = yield* buildCellWorker
          const [define, shown, after] = yield* setupCalls(["let kept = 7", hazard.source, "kept"])
          if (!define || !shown || !after) return yield* Effect.die("Missing test cells")
          const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
          const cells = Context.get(
            yield* Layer.build(
              CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
            ),
            CellExecution,
          )
          const ReplyText = Schema.Union([
            Schema.Struct({ message: Schema.String }),
            Schema.Struct({ display: Schema.String }),
          ])
          const reply = (call: typeof define) =>
            cells.run(call).pipe(
              Effect.provideService(CellOperationHost, host),
              Effect.map((result) => {
                const text = Schema.decodeUnknownSync(ReplyText)(result.result)
                if ("message" in text) return text.message
                return text.display
              }),
            )
          expect(yield* reply(define)).toBe("7")
          expect(yield* reply(shown)).toBe(hazard.shown)
          const next = (yield* cells
            .run(after)
            .pipe(Effect.provideService(CellOperationHost, host))).result
          expect(next).toMatchObject({ display: "7" })
          expect(next).not.toHaveProperty("restored")
        }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
      10000,
    )
  }

  it.scopedLive(
    "restores the saved namespace into a replaced worker and into a new branch owner",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [define, hang, useAgain, later, wipe, gone] = yield* setupCalls(
          [
            "let n = 41; const seen = new Map([['k', new Date(0)]]); const fn = () => 1; n",
            "await tools.wait({})",
            "n + 1",
            "[n, seen.get('k') instanceof Date, typeof fn].join(',')",
            "typeof n",
            "typeof n",
          ],
          [4],
        )
        if (!define || !hang || !useAgain || !later || !wipe || !gone)
          return yield* Effect.die("Missing test cells")
        const started = yield* Deferred.make<boolean>()
        const host = CellOperationHost.of({
          catalog: hostCatalog("wait"),
          call: () => Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)),
        })
        const open = Effect.gen(function* () {
          const context = yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          )
          return Context.get(context, CellExecution)
        })
        const cells = yield* open
        const run = (owner: typeof cells, call: Parameters<typeof cells.run>[0]) =>
          owner.run(call).pipe(Effect.provideService(CellOperationHost, host))
        expect((yield* run(cells, define)).result).toMatchObject({ display: "41" })
        // Cancellation loses the worker. The host replaces it and restores the last good namespace.
        const running = yield* run(cells, hang).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* cells.cancel
        expect(yield* Fiber.join(running)).toMatchObject({ isFailure: true })
        expect((yield* run(cells, useAgain)).result).toMatchObject({
          display: "42",
          restored: { restored: ["n", "seen"], omitted: [{ name: "fn", reason: "function" }] },
        })
        // A second owner over the same storage stands in for a process restart.
        const restarted = yield* open
        const revived = yield* run(restarted, later)
        expect(revived.result).toMatchObject({ display: "41,true,undefined" })
        // The report is attached once, to the first cell after a restore.
        expect((yield* run(restarted, later)).result).toEqual(revived.result)
        // An explicit reset clears the saved namespace for every later owner.
        expect((yield* run(restarted, wipe)).result).toMatchObject({ display: "undefined" })
        const fresh = yield* open
        const cleared = yield* run(fresh, gone)
        expect(cleared.result).toMatchObject({ display: "undefined" })
        expect(cleared.result).not.toHaveProperty("restored")
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(testLayer)),
    15000,
  )

  it.scopedLive(
    "a handoff copies its predecessor's namespace on first start, and a reset does not inherit it again",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [unsaved, copied, wipe, gone] = yield* setupCalls(
          [
            "notes.push('beta'); throw new Error('unsaved')",
            "notes.join(',')",
            "throw new Error('fresh start')",
            "typeof notes",
          ],
          [2],
          true,
        )
        if (!unsaved || !copied || !wipe || !gone) return yield* Effect.die("Missing test cells")
        yield* saveForPredecessor(["alpha"])
        const open = openCellOwner(worker)
        // The first start inherits; the failed cell saves nothing of its own.
        expect(yield* runCell(yield* open, unsaved)).toMatchObject({ isFailure: true })
        // The predecessor moves on. A restart restores the copy taken at the
        // first start, not the predecessor's newer namespace.
        yield* saveForPredecessor(["changed"])
        const restarted = yield* runCell(yield* open, copied)
        expect(restarted.result).toMatchObject({
          display: "alpha",
          restored: { restored: ["notes"], omitted: [] },
        })
        expect(restarted.result).not.toHaveProperty("restored.previousSession")
        // A reset whose cell fails still leaves an empty namespace: a restart
        // neither restores the old values nor inherits the predecessor's.
        const reopened = yield* open
        expect(yield* runCell(reopened, wipe)).toMatchObject({ isFailure: true })
        const fresh = yield* runCell(yield* open, gone)
        expect(fresh.result).toMatchObject({ display: "undefined" })
        expect(fresh.result).not.toHaveProperty("restored")
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(testLayer)),
    15000,
  )

  it.scopedLive(
    "a handoff whose predecessor saved nothing keeps its empty start after a restart",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [failed, later] = yield* setupCalls(
          ["throw new Error('before any save')", "typeof notes"],
          [],
          true,
        )
        if (!failed || !later) return yield* Effect.die("Missing test cells")
        expect(yield* runCell(yield* openCellOwner(worker), failed)).toMatchObject({
          isFailure: true,
        })
        // The predecessor saves only after the handoff's first start.
        yield* saveForPredecessor(["late"])
        const restarted = yield* runCell(yield* openCellOwner(worker), later)
        expect(restarted.result).toMatchObject({ display: "undefined" })
        expect(restarted.result).not.toHaveProperty("restored")
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(testLayer)),
    15000,
  )

  it.scopedLive(
    "only the handoff session's first branch inherits; a new or forked branch starts empty",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        yield* setupCalls([], [], true)
        yield* saveForPredecessor(["alpha"])
        const branches = yield* BranchStorage
        const created = BranchId.make("cell-execution-created")
        const forked = BranchId.make("cell-execution-forked")
        yield* branches.createBranch(
          new Branch({ id: created, sessionId, createdAt: dateFromMillis(now.getTime() + 1_000) }),
        )
        yield* branches.createBranch(
          new Branch({
            id: forked,
            sessionId,
            parentBranchId: branchId,
            createdAt: dateFromMillis(now.getTime() + 2_000),
          }),
        )
        for (const branch of [created, forked]) {
          const call = yield* recordCellCall({ branch, key: branch, code: "typeof notes" })
          const result = yield* runCell(yield* openCellOwner(worker, branch), call)
          expect(result.result).toMatchObject({ display: "undefined" })
          expect(result.result).not.toHaveProperty("restored")
        }
        const first = yield* recordCellCall({
          branch: branchId,
          key: "first",
          code: "notes.join(',')",
        })
        expect((yield* runCell(yield* openCellOwner(worker), first)).result).toMatchObject({
          display: "alpha",
          restored: { previousSession: predecessor.sessionId },
        })
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(testLayer)),
    15000,
  )

  it.scopedLive(
    "a failed session lookup at first start leaves no worker behind, and the next cell restores",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [failed, retried] = yield* setupCalls(
          ["notes.join(',')", "notes.join(',')"],
          [],
          true,
        )
        if (!failed || !retried) return yield* Effect.die("Missing test cells")
        yield* saveForPredecessor(["alpha"])
        const sessions = yield* SessionStorage
        const lookups = yield* Ref.make(0)
        // The first lookup fails; every later one reads storage.
        const flaky = yield* storedSessionContext((id) =>
          Effect.gen(function* () {
            if ((yield* Ref.getAndUpdate(lookups, (count) => count + 1)) === 0) {
              return yield* new ExtensionServiceError({
                service: "Session",
                operation: "getSession",
                message: "lookup unavailable",
              })
            }
            return yield* sessions.getSession(id ?? sessionId).pipe(Effect.orDie)
          }),
        )
        const owner = yield* openCellOwner(worker)
        const lost = yield* runCell(owner, failed).pipe(
          Effect.provideService(ExtensionContext, flaky),
          Effect.flip,
        )
        expect(lost).toMatchObject({ _tag: "StorageError" })
        const next = yield* runCell(owner, retried).pipe(
          Effect.provideService(ExtensionContext, flaky),
        )
        expect(next.result).toMatchObject({
          display: "alpha",
          restored: { restored: ["notes"], previousSession: predecessor.sessionId },
        })
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(testLayer)),
    15000,
  )

  it.scopedLive(
    "reuses completed cells without host effects or launching another worker",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const output = path.join(directory, "effects.txt")
        yield* fs.writeFileString(output, "")
        const calls = yield* setupCalls([
          "let n = await tools.append({}); n",
          "n++; throw new Error('cell failed')",
          "n",
        ])
        const [first, failed, next] = calls
        if (!first || !failed || !next) return yield* Effect.die("Missing test cell")
        const host = CellOperationHost.of({
          catalog: hostCatalog("append"),
          call: () =>
            Effect.gen(function* () {
              const before = yield* fs.readFileString(output)
              yield* fs.writeFileString(output, `${before}x`)
              return 1
            }).pipe(
              Effect.mapError(
                (error) =>
                  new CellEvaluationError({ phase: "execute", message: String(error), output: "" }),
              ),
            ),
        })
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const execution = Context.get(
              yield* Layer.build(
                CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
              ),
              CellExecution,
            )
            const saved = yield* execution.run(first)
            expect(saved.isFailure).toBe(false)
            expect(yield* execution.run(first)).toEqual(saved)
            const error = yield* execution.run(failed)
            expect(error.isFailure).toBe(true)
            expect(error.result).toMatchObject({
              _tag: "CellEvaluationError",
              message: expect.stringContaining("cell failed"),
            })
            expect(yield* execution.run(failed)).toEqual(error)
            expect((yield* execution.run(next)).result).toMatchObject({ display: "2" })
            expect(yield* fs.readFileString(output)).toBe("x")
            return saved
          }).pipe(Effect.provideService(CellOperationHost, host)),
        )
        const replay = Context.get(
          yield* Layer.build(
            CellExecution.Live({
              worker: CellWorker.cases.Script.make({
                ...worker,
                scriptPath: path.join(directory, "missing-worker.js"),
              }),
              cwd: packageDirectory,
              sessionId,
              branchId,
            }),
          ),
          CellExecution,
        )
        expect(
          yield* replay.run(first).pipe(Effect.provideService(CellOperationHost, host)),
        ).toEqual(result)
        expect(yield* fs.readFileString(output)).toBe("x")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "does not repeat an interrupted cell after resetting the worker",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const output = path.join(directory, "effects.txt")
        yield* fs.writeFileString(output, "")
        const [first, next] = yield* setupCalls(["await tools['append-and-wait']({})", "21 * 2"])
        if (!first || !next) return yield* Effect.die("Missing test cell")
        const started = yield* Deferred.make<boolean>()
        const stopped = yield* Deferred.make<boolean>()
        const host = CellOperationHost.of({
          catalog: hostCatalog("append-and-wait"),
          call: () =>
            Effect.gen(function* () {
              const before = yield* fs.readFileString(output)
              yield* fs.writeFileString(output, `${before}x`)
              yield* Deferred.succeed(started, true)
              return yield* Effect.never
            }).pipe(
              Effect.mapError(
                (error) =>
                  new CellEvaluationError({ phase: "execute", message: String(error), output: "" }),
              ),
              Effect.ensuring(Deferred.succeed(stopped, true)),
            ),
        })
        const execution = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const running = yield* execution
          .run(first)
          .pipe(Effect.provideService(CellOperationHost, host), Effect.forkScoped)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(running)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        // The loop closed under the cell; the next loop opens its own execution.
        const reopened = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const unknown = yield* reopened
          .run(first)
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(unknown._tag).toBe("CellExecutionIncomplete")
        expect(yield* fs.readFileString(output)).toBe("x")
        const fresh = yield* reopened.run(next).pipe(Effect.provideService(CellOperationHost, host))
        expect(fresh.result).toMatchObject({ display: "42" })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "a failed lazy startup counts toward the failed-launch limit",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const fs = yield* FileSystem.FileSystem
        const savedWorker = `${worker.scriptPath}.saved`
        yield* fs.rename(worker.scriptPath, savedWorker)
        const [first, next] = yield* setupCalls(["41", "42"])
        if (!first || !next) return yield* Effect.die("Missing test cell")
        const execution = Context.get(
          yield* Layer.build(
            CellExecution.Live({
              worker,
              cwd: packageDirectory,
              sessionId,
              branchId,
              maximumFailedLaunches: 1,
            }),
          ),
          CellExecution,
        )
        const host = CellOperationHost.of({ call: () => Effect.die("Unexpected host operation") })
        const failed = yield* execution
          .run(first)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(failed.isFailure).toBe(true)
        expect(failed.result).toMatchObject({ _tag: "CellProcessError", phase: "launch" })
        // The worker is back, but one failed launch already reached the limit of one.
        yield* fs.rename(savedWorker, worker.scriptPath)
        const refused = yield* execution
          .run(next)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(refused.result).toMatchObject({
          _tag: "CellProcessError",
          phase: "launch",
          message: expect.stringContaining("failed to launch 1 times in a row"),
        })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )
})

// ── cell worker process ─────────────────────────────────────────────────────

const platformLayer = Layer.merge(BunServices.layer, BunGentPlatformLive)

describe("cell worker process", () => {
  it.scopedLive(
    "runs a compiled worker with retained values, the Bun runtime, and the host environment",
    () =>
      Effect.gen(function* () {
        const artifact = yield* buildCellExecutable
        const kernel = yield* openCellKernel({ worker: artifact, cwd: packageDirectory })
        const host = CellOperationHost.of({
          catalog: hostCatalog("value"),
          call: () => Effect.succeed(21),
        })
        expect(
          (yield* kernel
            .evaluate("let saved = await tools.value({}); saved")
            .pipe(Effect.provideService(CellOperationHost, host))).display,
        ).toBe("21")
        expect(
          (yield* kernel.evaluate("saved * 2").pipe(Effect.provideService(CellOperationHost, host)))
            .display,
        ).toBe("42")
        const executable = yield* kernel
          .evaluate("process.execPath")
          .pipe(Effect.provideService(CellOperationHost, host))
        const fs = yield* FileSystem.FileSystem
        expect(executable.display).toBe(yield* fs.realPath(artifact.binaryPath))
        expect(
          (yield* kernel
            .evaluate("Object.keys(process.env).length > 0 && process.cwd() === process.cwd()")
            .pipe(Effect.provideService(CellOperationHost, host))).display,
        ).toBe("true")
        const runtime = yield* kernel
          .evaluate(
            "const hosts = await Bun.file('/etc/hosts').text(); const fsm = await import('node:fs/promises'); [hosts.length > 0, typeof fsm.readdir, typeof require('node:path').join, (await Bun.$`printf ok`.text())]",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(runtime.display).toBe("[ true, 'function', 'function', 'ok' ]")
        // Process output written during the cell returns ahead of its display, Prime style.
        const streamed = yield* kernel
          .evaluate(
            "process.stdout.write('via stdout\\n'); process.stderr.write('via stderr\\n'); Bun.spawnSync(['echo', 'from child'], { stdout: 'inherit' }); 'value'",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(streamed.display).toBe("via stdout\nvia stderr\nfrom child\nvalue")
        // A large write right before the result still lands in full: the worker marks the
        // end of the cell on its one output pipe, and the host waits for that mark.
        const large = yield* kernel
          .evaluate("process.stdout.write('y'.repeat(40000)); 'tail'")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(large.display).toBe(`${"y".repeat(40000)}\ntail`)
        // Interleaved writes return in write order. Two pipes cannot do this: a stderr
        // write spanning several chunks, then stdout, then more stderr arrives inverted,
        // because a merge of two pipes preserves order only within each one. The filler
        // stays under maximumCellDisplayLength so the marks are not truncated away.
        const interleaved = yield* kernel
          .evaluate(
            "process.stderr.write('E'.repeat(16000) + '\\n'); process.stdout.write('LAST-OUT\\n'); process.stderr.write('TRAILING-ERR\\n'); 'done'",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        const marks = interleaved.display
          .split("\n")
          .filter((line) => line === "LAST-OUT" || line === "TRAILING-ERR")
        expect(marks).toEqual(["LAST-OUT", "TRAILING-ERR"])
        // A process the cell spawns writes to the same pipe, so its stderr is kept too.
        const spawned = yield* kernel
          .evaluate(
            "Bun.spawnSync(['sh', '-c', 'echo child-err 1>&2'], { stderr: 'inherit' }); 'after'",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(spawned.display).toBe("child-err\nafter")
        const quiet = yield* kernel
          .evaluate("'nothing streamed'")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(quiet.display).toBe("nothing streamed")
        yield* kernel.reset
        expect(
          (yield* kernel
            .evaluate("typeof saved")
            .pipe(Effect.provideService(CellOperationHost, host))).display,
        ).toBe("undefined")
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platformLayer)),
    12000,
  )

  it.scopedLive(
    "a source run launches the worker source of this checkout under the running Bun",
    () =>
      Effect.gen(function* () {
        const launch = yield* cellWorkerLaunch
        const platform = yield* GentPlatform
        expect(launch).toEqual(
          CellWorker.cases.Script.make({
            runtimePath: yield* platform.execPath,
            scriptPath: new URL("../src/cell-worker-boundary.ts", import.meta.url).pathname,
          }),
        )
        // The launch runs: the namespace in this checkout answers a host call.
        const kernel = yield* openCellKernel({ worker: launch, cwd: packageDirectory })
        const host = CellOperationHost.of({
          catalog: hostCatalog("read.file"),
          call: (request) => Effect.succeed(request.name),
        })
        const evaluation = yield* kernel
          .evaluate("await tools.read.file({})")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(evaluation.display).toBe("read.file")
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platformLayer)),
    12000,
  )

  // Bindings were the global names the worker lacked at start, so a cell that
  // rebound a Bun global (`prompt`, `performance`) or a host namespace bound
  // nothing: no report, no snapshot, and a reset kept its value.
  it.scopedLive(
    "a declaration that rebinds a worker global is a binding; the host namespaces come back each cell",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* cellWorkerLaunch,
          cwd: packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const evaluate = (code: string) =>
          kernel.evaluate(code).pipe(Effect.provideService(CellOperationHost, host))
        const bound = yield* evaluate("const prompt = 'draft'; var performance = 5; 1")
        expect(bound.bindings).toEqual(["performance", "prompt"])
        expect(bound.bindingCount).toBe(2)
        // The host namespaces cannot be rebound: a declaration fails its cell and they stay.
        const shadowed = yield* Effect.flip(evaluate("const tools = 7; typeof tools"))
        expect(shadowed.message).toContain("tools")
        const redefined = yield* Effect.flip(
          evaluate(
            "Object.defineProperty(globalThis, 'context', { value: null, configurable: false }); 1",
          ),
        )
        expect(redefined.message).toContain("unconfigurable")
        const after = yield* evaluate("[typeof tools, typeof context.status].join(',')")
        expect(after.display).toBe("function,function")
        expect(after.bindingCount).toBe(2)
        const snapshot = yield* kernel.snapshot
        expect(snapshot.bindings.map((binding) => binding.name).sort()).toEqual([
          "performance",
          "prompt",
        ])
        // A reset puts every rebound global back as the worker found it.
        yield* kernel.reset
        expect((yield* evaluate("[typeof prompt, typeof performance.now].join(',')")).display).toBe(
          "function,function",
        )
        expect([...(yield* kernel.restore(snapshot.bindings))].sort()).toEqual([
          "performance",
          "prompt",
        ])
        expect((yield* evaluate("[prompt, performance].join(',')")).display).toBe("draft,5")
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platformLayer)),
    12000,
  )

  // Reset once deleted new names and ignored a refusal, and compared globals
  // by value only, so a non-configurable global or a changed flag survived it.
  it.scopedLive(
    "a reset that cannot put a global back replaces the worker; a changed flag is put back",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* cellWorkerLaunch,
          cwd: packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const evaluate = (code: string) =>
          kernel.evaluate(code).pipe(Effect.provideService(CellOperationHost, host))
        const flagged = yield* evaluate(
          "Object.defineProperty(globalThis, 'prompt', { writable: false }); 1",
        )
        expect(flagged.bindings).toEqual(["prompt"])
        yield* kernel.reset
        expect(
          (yield* evaluate(
            "String(Object.getOwnPropertyDescriptor(globalThis, 'prompt').writable)",
          )).display,
        ).toBe("true")
        yield* evaluate(
          "Object.defineProperty(globalThis, 'stuck', { value: 1, configurable: false }); var pid = process.pid; 1",
        )
        const before = (yield* evaluate("pid")).display
        yield* kernel.reset
        expect((yield* evaluate("typeof stuck")).display).toBe("undefined")
        expect((yield* evaluate("String(process.pid)")).display).not.toBe(before)
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platformLayer)),
    12000,
  )

  // An uncaught value is shown to the next cell; `inspect` once ran its getter.
  it.scopedLive(
    "an uncaught value with a looping getter reaches the next cell as text",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* cellWorkerLaunch,
          cwd: packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const evaluate = (code: string) =>
          kernel.evaluate(code).pipe(Effect.provideService(CellOperationHost, host))
        yield* evaluate(
          "let kept = 7; setTimeout(() => { throw { get [Symbol.toStringTag]() { for (;;) {} } } }, 0); 1",
        )
        const shown = yield* evaluate("kept").pipe(
          Effect.repeat({ until: (result) => result.display.includes("Uncaught"), times: 20 }),
        )
        expect(shown.display).toBe(
          "Uncaught (from cell 1): { Symbol(Symbol.toStringTag): [Getter] }\n7",
        )
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platformLayer)),
    12000,
  )

  it.scopedLive(
    "a source-run worker ignores the project bunfig preload and .env files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const project = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "gent-cell-project-" }),
        )
        const marker = path.join(project, "preload-ran")
        yield* fs.writeFileString(path.join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
        yield* fs.writeFileString(
          path.join(project, "preload.ts"),
          `await Bun.write('${marker}', 'ran')\n`,
        )
        yield* fs.writeFileString(path.join(project, ".env"), "GENT_CELL_PROJECT_ENV=loaded\n")
        const kernel = yield* openCellKernel({ worker: yield* cellWorkerLaunch, cwd: project })
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const evaluate = (code: string) =>
          kernel.evaluate(code).pipe(Effect.provideService(CellOperationHost, host))
        expect((yield* evaluate("process.cwd()")).display).toBe(project)
        expect(yield* fs.exists(marker)).toBe(false)
        expect((yield* evaluate("process.env.GENT_CELL_PROJECT_ENV ?? 'absent'")).display).toBe(
          "absent",
        )
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platformLayer)),
    12000,
  )

  it.scopedLive(
    "a late throw or an unawaited rejection reaches the cell output and the worker lives",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
        })
        const host = CellOperationHost.of({
          catalog: hostCatalog("broken"),
          call: () =>
            Effect.fail(
              new CellEvaluationError({ phase: "execute", message: "service down", output: "" }),
            ),
        })
        const run = (source: string) =>
          kernel.evaluate(source).pipe(Effect.provideService(CellOperationHost, host))
        const settle = "await new Promise((resolve) => setTimeout(resolve, 150))"
        // A timer throws while its own cell runs: that cell's output carries it.
        const own = yield* run(
          `var kept = 5; setTimeout(() => { throw new Error('own timer') }, 20); ${settle}; 1`,
        )
        expect(own.display).toContain("own timer")
        // A timer from cell A throws while cell B runs: B does not claim it,
        // and the next cell names A as its origin.
        yield* run("setTimeout(() => { throw new Error('late timer') }, 40); 1")
        const whileLate = yield* run(`${settle}; kept`)
        expect(whileLate.display).not.toContain("late timer")
        expect(whileLate.display).toContain("5")
        const afterTimer = yield* run("2")
        expect(afterTimer.display).toMatch(/Uncaught \(from cell \d+\): .*late timer/)
        // A rejection nobody awaits has no known origin: it is never the
        // running cell's error, and the next cell reports it as unknown.
        const dropped = yield* run(`Promise.reject(new Error('dropped promise')); ${settle}; 2`)
        expect(dropped.display).not.toContain("dropped promise")
        const afterDropped = yield* run("kept")
        expect(afterDropped.display).toContain(
          "Uncaught (origin unknown: an unawaited promise or microtask): ",
        )
        expect(afterDropped.display).toContain("dropped promise")
        // A host call the cell never awaits fails while the cell still runs:
        // an unhandled rejection, so it too waits for the next cell, unattributed.
        const orphan = yield* run(`tools.broken({}); ${settle}; 3`)
        expect(orphan.display).toBe("3")
        const afterOrphan = yield* run("4")
        expect(afterOrphan.display).toContain("Uncaught (origin unknown")
        expect(afterOrphan.display).toContain("service down")
        yield* kernel.close
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "process output past the display limit keeps its tail, so a trailing error survives",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.succeed(0) })
        // The filler alone exceeds maximumCellDisplayLength, so the buffer must drop
        // something. A head-only policy drops the end, taking the trailing marker with it.
        const evaluation = yield* kernel
          .evaluate(
            "process.stdout.write('f'.repeat(90000) + '\\n'); process.stderr.write('TRAILING-FAILURE\\n'); 'done'",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(evaluation.display.startsWith("fff")).toBe(true)
        expect(evaluation.display).toContain("characters omitted")
        expect(evaluation.display).toContain("TRAILING-FAILURE")
        yield* kernel.close
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "close waits for active host cleanup and prevents recovery",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
        })
        const started = yield* Deferred.make<number>()
        const stopped = yield* Deferred.make<boolean>()
        const host = CellOperationHost.of({
          catalog: hostCatalog("wait"),
          call: (request) =>
            Deferred.succeed(started, Number(request.input)).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, true)),
            ),
        })
        const evaluation = yield* kernel
          .evaluate("await tools.wait(process.pid)")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.forkScoped)
        const pid = yield* Deferred.await(started)
        yield* kernel.close
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        const error = yield* Fiber.join(evaluation).pipe(Effect.flip)
        if (error._tag !== "CellKernelError") return yield* error
        expect(error.reason).toBe("closed")
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("closed")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "cancels a waiting host call and discards its worker before interruption returns",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
        })
        const started = yield* Deferred.make<number>()
        const stopped = yield* Deferred.make<boolean>()
        const host = CellOperationHost.of({
          catalog: hostCatalog("wait"),
          call: (request) =>
            Deferred.succeed(started, Number(request.input)).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, true)),
            ),
        })
        const evaluation = yield* kernel
          .evaluate("await tools.wait(process.pid)")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.forkScoped)
        const pid = yield* Deferred.await(started)
        yield* Fiber.interrupt(evaluation)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        const error = yield* kernel
          .evaluate("1")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        if (error._tag !== "CellKernelError") return yield* error
        expect(error.reason).toBe("recovery-required")
        expect(error.stateLost).toBe(true)
        yield* kernel.reset
        const fresh = yield* kernel
          .evaluate("21 * 2")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(fresh.display).toBe("42")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "retains values after cell errors, uses the current host, and resets explicitly",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
        })
        const firstHost = CellOperationHost.of({
          catalog: hostCatalog("value"),
          call: () => Effect.succeed(20),
        })
        const nextHost = CellOperationHost.of({
          catalog: hostCatalog("value"),
          call: () => Effect.succeed(22),
        })
        const first = yield* kernel
          .evaluate("let n = await tools.value({}); n")
          .pipe(Effect.provideService(CellOperationHost, firstHost))
        expect(first.display).toBe("20")
        const error = yield* kernel
          .evaluate("n++; throw new Error('cell failed')")
          .pipe(Effect.provideService(CellOperationHost, firstHost), Effect.flip)
        expect(error._tag).toBe("CellEvaluationError")
        const next = yield* kernel
          .evaluate("n + await tools.value({})")
          .pipe(Effect.provideService(CellOperationHost, nextHost))
        expect(next.display).toBe("43")
        yield* kernel.reset
        const cleared = yield* kernel
          .evaluate("typeof n")
          .pipe(Effect.provideService(CellOperationHost, nextHost))
        expect(cleared.display).toBe("undefined")
        yield* kernel.close
        const closed = yield* kernel
          .evaluate("1")
          .pipe(Effect.provideService(CellOperationHost, nextHost), Effect.flip)
        expect(closed._tag).toBe("CellKernelError")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "kills a CPU-bound cell at its deadline without repeating its host operation",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
          evaluationTimeoutMs: 1000,
          maximumFailedLaunches: 1,
        })
        let calls = 0
        let pid = 0
        const host = CellOperationHost.of({
          catalog: hostCatalog("started"),
          call: (request) =>
            Effect.sync(() => {
              calls++
              pid = Number(request.input)
              return true
            }),
        })
        const error = yield* kernel
          .evaluate("let retained = 41; await tools.started(process.pid); while (true) {}")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(error._tag).toBe("CellKernelError")
        if (error._tag !== "CellKernelError") return yield* error
        expect(error.reason).toBe("timeout")
        expect(error.stateLost).toBe(true)
        expect(calls).toBe(1)
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        const later = yield* kernel
          .evaluate("await tools.started(0)")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(later._tag).toBe("CellKernelError")
        expect(calls).toBe(1)
        yield* kernel.reset
        const fresh = yield* kernel
          .evaluate("typeof retained")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(fresh.display).toBe("undefined")
        expect(calls).toBe(1)
        const crash = yield* kernel
          .evaluate("process.exit(7)")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        if (crash._tag !== "CellKernelError") return yield* crash
        expect(crash.reason).toBe("process")
        // Both workers launched, so neither loss counts toward the failed-launch limit.
        yield* kernel.reset
        yield* kernel.close
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("closed")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "pauses the deadline while a host operation is pending",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
          evaluationTimeoutMs: 400,
          maximumFailedLaunches: 1,
        })
        // Host operations own their bounds: a slow one outlives the compute deadline.
        const host = CellOperationHost.of({
          catalog: hostCatalog("slow"),
          // gent/no-sleep: allow real-clock host operation that outlives the kernel deadline
          call: () => Effect.sleep("900 millis").pipe(Effect.as(5)),
        })
        const slow = yield* kernel
          .evaluate("const v = await tools.slow(0); v + 1")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(slow.display).toBe("6")
        // Compute after the host operation returns is bounded again.
        const spun = yield* kernel
          .evaluate("await tools.slow(0); while (true) {}")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(spun._tag).toBe("CellKernelError")
        if (spun._tag !== "CellKernelError") return yield* spun
        expect(spun.reason).toBe("timeout")
        expect(spun.stateLost).toBe(true)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "ships the catalog once per hash and again to a replacement worker",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
          evaluationTimeoutMs: 1000,
          maximumFailedLaunches: 1,
        })
        const catalog = {
          hash: "read-v1",
          tools: [{ name: "read", description: "Read a file", guidelines: [], parameters: {} }],
        }
        const host = CellOperationHost.of({ catalog, call: () => Effect.succeed(true) })
        const describe = "tools('read').description"
        const first = yield* kernel
          .evaluate(describe)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(first.display).toBe("Read a file")
        // Same hash: the worker keeps its copy and the second cell still reads it.
        const again = yield* kernel
          .evaluate(describe)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(again.display).toBe("Read a file")
        // A host without a catalog leaves the worker's catalog unchanged.
        const bare = CellOperationHost.of({ call: () => Effect.succeed(true) })
        const kept = yield* kernel
          .evaluate(describe)
          .pipe(Effect.provideService(CellOperationHost, bare))
        expect(kept.display).toBe("Read a file")
        const lost = yield* kernel
          .evaluate("while (true) {}")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(lost._tag).toBe("CellKernelError")
        yield* kernel.reset
        // The replacement worker started empty and received the full catalog again.
        const restored = yield* kernel
          .evaluate(describe)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(restored.display).toBe("Read a file")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "a lost worker is replaced as often as cells need once each worker completed a cell",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.succeed(true) })
        const run = (source: string) =>
          kernel.evaluate(source).pipe(Effect.provideService(CellOperationHost, host))
        // More losses than the failed-launch limit: each worker completed a cell first.
        for (let lost = 0; lost < 5; lost++) {
          expect((yield* run("1 + 1")).display).toBe("2")
          const crash = yield* run("process.exit(7)").pipe(Effect.flip)
          expect(crash._tag).toBe("CellKernelError")
          yield* kernel.reset
        }
        expect((yield* run("21 * 2")).display).toBe("42")
        yield* kernel.close
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "workers that launch and die in their first cell trip the failed-launch limit",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.succeed(true) })
        const crash = Effect.gen(function* () {
          const error = yield* kernel
            .evaluate("process.exit(7)")
            .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
          if (error._tag !== "CellKernelError") return yield* Effect.die(error)
          return error.reason
        })
        // Each worker reaches Ready, then dies before it completes a cell.
        for (let launch = 0; launch < 2; launch++) {
          expect(yield* crash).toBe("process")
          yield* kernel.reset
        }
        expect(yield* crash).toBe("process")
        const refused = yield* kernel.reset.pipe(Effect.flip)
        expect(refused.reason).toBe("replacement-limit")
        expect(refused.message).toContain("3 times in a row")
        yield* kernel.close
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "counts failed replacement starts and does not reopen a closed kernel",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const launch = yield* buildCellWorker
        const kernel = yield* openCellKernel({
          worker: launch,
          cwd: packageDirectory,
          maximumFailedLaunches: 1,
        })
        const host = CellOperationHost.of({ call: () => Effect.succeed(true) })
        // The first worker completes a cell, so its later death is not a failed launch.
        const completed = yield* kernel
          .evaluate("1")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(completed.display).toBe("1")
        const crash = yield* kernel
          .evaluate("process.exit(7)")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(crash._tag).toBe("CellKernelError")
        yield* fs.writeFileString(launch.scriptPath, "process.exit(2)")
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("process")
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("replacement-limit")
        yield* kernel.close
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("closed")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "exchanges real frames beside cell writes to stdout and stops at scope exit",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const launch = yield* buildCellWorker
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* openCellProcess({ worker: launch, cwd: packageDirectory })
            const responses = yield* Queue.make<CellResponse>({ capacity: 8 })
            yield* child.responses.pipe(
              Stream.runForEach((response) => Queue.offer(responses, response)),
              Effect.catchTag("CellProcessError", () => Effect.void),
              Effect.forkScoped,
            )
            expect((yield* Queue.take(responses))._tag).toBe("Ready")
            yield* child.send(
              CellRequest.cases.Evaluate.make({
                cellId: "one",
                outputToken: "one-token",
                source: "const n = await tools.count({}); n + 1",
                catalog: hostCatalog("count"),
              }),
            )
            const call = yield* Queue.take(responses)
            if (call._tag !== "HostCall")
              return yield* new CellProtocolError({ message: "Expected host call" })
            yield* child.send(
              CellRequest.cases.HostSucceeded.make({
                cellId: call.cellId,
                operationId: call.operationId,
                value: 41,
              }),
            )
            const result = yield* Queue.take(responses)
            if (result._tag !== "Evaluated")
              return yield* new CellProtocolError({ message: "Expected evaluation" })
            expect(result.result.display).toBe("42")
            // Frames travel on dedicated descriptors, so stdout writes from the cell never reach the reader.
            yield* child.send(
              CellRequest.cases.Evaluate.make({
                cellId: "two",
                outputToken: "two-token",
                source:
                  "process.stdout.write('not a frame\\n'); console.log('captured'); await Bun.write(Bun.stdout, 'also not a frame\\n'); n + 2",
              }),
            )
            const noisy = yield* Queue.take(responses)
            if (noisy._tag !== "Evaluated")
              return yield* new CellProtocolError({ message: "Expected evaluation" })
            expect(noisy.result.display).toBe("captured\n43")
            expect(yield* child.takeOutput("two-token")).toBe("not a frame\nalso not a frame\n")
            expect(yield* child.diagnostics).toContain("not a frame")
            expect(yield* child.diagnostics).not.toContain("gent-cell-end")
            expect(yield* child.isRunning).toBe(true)
            yield* platform.signal(child.pid, 0)
            return child.pid
          }),
        )
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "stops the process and rejects later sends",
    () =>
      Effect.gen(function* () {
        const launch = yield* buildCellWorker
        const child = yield* openCellProcess({ worker: launch, cwd: packageDirectory })
        yield* child.stop
        expect(yield* child.isRunning).toBe(false)
        const error = yield* child
          .send(CellRequest.cases.Reset.make({ requestId: "too-late" }))
          .pipe(Effect.flip)
        expect(error.phase).toBe("exit")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "a cell cannot close its own output with a forged boundary",
    () =>
      Effect.gen(function* () {
        const launch = yield* buildCellWorker
        const child = yield* openCellProcess({ worker: launch, cwd: packageDirectory })
        const next = child.responses.pipe(Stream.take(1), Stream.runCollect)
        expect((yield* next).map((response) => response._tag)).toEqual(["Ready"])
        const forged = "\\u001egent-cell-end forged\\u001e"
        yield* child.send(
          CellRequest.cases.Evaluate.make({
            cellId: "one",
            outputToken: "one-token",
            source: `process.stdout.write('${forged}'); process.stderr.write('${forged}'); process.stdout.write('after\\n'); 1`,
          }),
        )
        expect((yield* next).map((response) => response._tag)).toEqual(["Evaluated"])
        const output = yield* child.takeOutput("one-token")
        expect(output).toContain("after")
        expect(output).toContain("gent-cell-end forged")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "a worker that dies before its boundary fails the waiting output take",
    () =>
      Effect.gen(function* () {
        const launch = yield* buildCellWorker
        const child = yield* openCellProcess({ worker: launch, cwd: packageDirectory })
        const next = child.responses.pipe(Stream.take(1), Stream.runCollect)
        expect((yield* next).map((response) => response._tag)).toEqual(["Ready"])
        const waiting = yield* child.takeOutput("one-token").pipe(Effect.exit, Effect.forkScoped)
        yield* child.send(
          CellRequest.cases.Evaluate.make({
            cellId: "one",
            outputToken: "one-token",
            source: "process.stdout.write('partial'); process.exit(3)",
          }),
        )
        const exit = yield* Fiber.join(waiting)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Cell worker")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "keeps the pipe open between successive reply reads",
    () =>
      Effect.gen(function* () {
        const launch = yield* buildCellWorker
        const child = yield* openCellProcess({ worker: launch, cwd: packageDirectory })
        const next = child.responses.pipe(Stream.take(1), Stream.runCollect)
        expect((yield* next).map((response) => response._tag)).toEqual(["Ready"])
        yield* child.send(
          CellRequest.cases.Evaluate.make({
            cellId: "one",
            outputToken: "one-token",
            source: "let n = 41; n",
          }),
        )
        expect((yield* next).map((response) => response._tag)).toEqual(["Evaluated"])
        yield* child.send(
          CellRequest.cases.Evaluate.make({
            cellId: "two",
            outputToken: "two-token",
            source: "n + 1",
          }),
        )
        const replies = yield* next
        expect(replies.length).toBe(1)
        for (const response of replies) {
          if (response._tag !== "Evaluated")
            return yield* new CellProtocolError({ message: "Expected evaluation" })
          expect(response.result.display).toBe("42")
        }
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "reports a launch phase when the binary cannot execute, and pipes one output stream",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const binaryPath = path.join(directory, "not-executable")
        yield* fs.writeFileString(binaryPath, "certainly not a program\n")
        // The worker runs under a shell, so a bad binary fails at the shell's exec
        // rather than at spawn. A death before Ready is still a launch failure.
        const error = yield* openCellProcess({
          worker: CellWorker.cases.Compiled.make({ binaryPath }),
          cwd: packageDirectory,
          readinessTimeoutMs: 2000,
        }).pipe(Effect.flip)
        expect(error.phase).toBe("launch")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "gives the worker one output pipe and no separate stderr stream",
    () =>
      Effect.gen(function* () {
        // Deterministic half of the ordering guarantee: with stderr folded into
        // stdout there is only one stream to read, so no merge can reorder it.
        const artifact = yield* buildCellExecutable
        const kernel = yield* openCellKernel({ worker: artifact, cwd: packageDirectory })
        const host = CellOperationHost.of({ call: () => Effect.succeed(0) })
        const fds = yield* kernel
          .evaluate(
            "const fs = require('node:fs'); const a = fs.fstatSync(1); const b = fs.fstatSync(2); [a.dev === b.dev, a.ino === b.ino]",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        // One file description behind both descriptors: nothing can reorder it.
        expect(fds.display).toBe("[ true, true ]")
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platformLayer)),
    12000,
  )

  it.scopedLive(
    "kills a worker that never becomes ready before returning the timeout",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const platform = yield* GentPlatform
        const binaryPath = yield* platform.execPath
        const directory = yield* fs.makeTempDirectoryScoped()
        const workerPath = path.join(directory, "stalled.js")
        yield* fs.writeFileString(
          workerPath,
          "process.stderr.write(String(process.pid)); while (true) {}",
        )
        const error = yield* openCellProcess({
          worker: CellWorker.cases.Script.make({ runtimePath: binaryPath, scriptPath: workerPath }),
          cwd: packageDirectory,
          readinessTimeoutMs: 1000,
        }).pipe(Effect.flip)
        expect(error.phase).toBe("launch")
        expect(error.message).toContain("readiness timed out")
        const pid = Number(error.diagnostics.trim())
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "a worker whose cell holds the thread exits when its host process dies",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const platform = yield* GentPlatform
        const worker = yield* buildCellWorker
        const directory = yield* fs.makeTempDirectoryScoped()
        const marker = path.join(directory, "worker.pid")
        const hostEntry = new URL("./helpers/cell-host-process.ts", import.meta.url).pathname
        const host = yield* ChildProcess.make(yield* platform.execPath, [hostEntry], {
          cwd: packageDirectory,
          env: {
            CELL_WORKER_SCRIPT: worker.scriptPath,
            CELL_SOURCE:
              'require("node:fs").writeFileSync(process.env.CELL_PID_MARKER, String(process.pid)); while (true) {}',
            CELL_PID_MARKER: marker,
          },
          extendEnv: true,
          stdout: "ignore",
          stderr: "inherit",
        })
        // The cell writes its pid right before the loop, so the loop runs once the file exists.
        const text = yield* waitFor(
          fs.readFileString(marker),
          (value) => value !== "",
          5000,
          "worker pid",
        )
        const pid = Number(text)
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        // A red run must not leave a spinning orphan behind.
        yield* Effect.addFinalizer(() => Effect.ignore(platform.signal(pid, "SIGKILL")))
        yield* host.kill({ killSignal: "SIGKILL" })
        yield* waitFor(
          platform.signal(pid, 0).pipe(Effect.exit),
          Exit.isFailure,
          3000,
          "orphaned worker exit",
        )
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(platformLayer)),
    15000,
  )

  it.scopedLive(
    "SIGTERM ends a worker whose cell holds the thread",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
          evaluationTimeoutMs: 20_000,
        })
        // The signal arrives before the loop starts, so a JavaScript handler never gets to run.
        const error = yield* kernel
          .evaluate('process.kill(process.pid, "SIGTERM"); while (true) {}')
          .pipe(
            Effect.provideService(CellOperationHost, { call: () => Effect.succeed(true) }),
            Effect.flip,
            Effect.timeout("4 seconds"),
          )
        expect(error._tag).toBe("CellKernelError")
        if (error._tag !== "CellKernelError") return yield* error
        expect(error.reason).toBe("process")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "a worker exits when its request pipe closes, even with a cell timer open",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const worker = yield* buildCellWorker
        const handle = yield* ChildProcess.make(yield* platform.execPath, [worker.scriptPath], {
          cwd: packageDirectory,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          additionalFds: { fd3: { type: "output" }, fd4: { type: "input" } },
        })
        const frame = yield* encodeCellRequest(
          CellRequest.cases.Evaluate.make({
            cellId: "timer-cell",
            outputToken: "timer-output",
            source: "setInterval(() => {}, 1000); 1",
          }),
        )
        const requests = yield* Queue.unbounded<Uint8Array, Cause.Done>()
        yield* Stream.fromQueue(requests).pipe(Stream.run(handle.getInputFd(4)), Effect.forkScoped)
        yield* Queue.offer(requests, frame)
        // The cell has run and its timer is open once its result frame arrives.
        const reader = makeCellFrameReader()
        const evaluated = yield* handle.getOutputFd(3).pipe(
          Stream.mapEffect(reader.push),
          Stream.flatMap(Stream.fromIterable),
          Stream.mapEffect(decodeCellResponse),
          Stream.filter((response) => response._tag === "Evaluated"),
          Stream.runHead,
        )
        expect(Option.isSome(evaluated)).toBe(true)
        // The host closes the request pipe and stays alive.
        yield* Queue.end(requests)
        expect(Number(yield* handle.exitCode.pipe(Effect.timeout("3 seconds")))).toBe(0)
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platformLayer)),
    12000,
  )
})

// ── cell approvals ──────────────────────────────────────────────────────────

/**
 * A cell whose `guarded` call asks the user, beside `mark` (records a mark) and
 * `slow` (holds until the test releases it). A declined `guarded` fails.
 */
const approvalCell = Effect.gen(function* () {
  const marks = yield* Ref.make<ReadonlyArray<string>>([])
  const asked = yield* Ref.make(0)
  const allowed = yield* Ref.make(0)
  const slowStarted = yield* Deferred.make<void>()
  const slowRelease = yield* Deferred.make<void>()
  const slowDone = yield* Deferred.make<void>()
  const nativeGate = yield* Deferred.make<void>()
  const nativeAsking = yield* Deferred.make<void>()
  const extensions: ReadonlyArray<LoadedExtension> = [
    {
      manifest: { id: ExtensionId.make("cell-approval") },
      scope: "builtin",
      sourcePath: "cell-approval",
      artifactIdentity: LoadedArtifactIdentity.make("cell-approval-source"),
      contributions: {
        tools: [
          CellTool,
          tool({
            id: "mark",
            description: "Record a source effect",
            params: Schema.String,
            output: Schema.Boolean,
            execute: (mark) =>
              Ref.update(marks, (values) => [...values, mark]).pipe(Effect.as(true)),
            summary: (mark) => `marked ${mark}`,
          }),
          tool({
            id: "slow",
            description: "Work until released",
            params: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Deferred.completeWith(slowStarted, Effect.void).pipe(
                Effect.andThen(Deferred.await(slowRelease)),
                Effect.andThen(Deferred.completeWith(slowDone, Effect.void)),
                Effect.as("slow done"),
              ),
          }),
          tool({
            id: "native",
            description: "Ask as a call beside the cell, once released",
            params: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Effect.gen(function* () {
                yield* Deferred.await(nativeGate)
                yield* Deferred.completeWith(nativeAsking, Effect.void)
                const answer = yield* (yield* ExtensionContext).Interaction.approve({
                  text: "Native call?",
                })
                return String(answer.approved)
              }),
          }),
          tool({
            id: "guarded",
            description: "Ask before acting",
            params: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Effect.gen(function* () {
                yield* Ref.update(asked, (count) => count + 1)
                const answer = yield* (yield* ExtensionContext).Interaction.approve({
                  text: "Continue cell operation?",
                })
                if (!answer.approved)
                  return yield* new ToolResultFailure({
                    message: "declined by the user",
                    result: "declined",
                  })
                yield* Ref.update(allowed, (count) => count + 1)
                return "allowed"
              }),
          }),
        ],
      },
    },
  ]
  return {
    extensions,
    marks,
    asked,
    allowed,
    slowStarted,
    slowRelease,
    slowDone,
    nativeGate,
    nativeAsking,
  }
})

/** Start one cell turn and return once its one dialog shows. */
const startApprovalCell = (code: string) =>
  Effect.gen(function* () {
    const cell = yield* approvalCell
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
      toolCallStep("cell", { code }),
      textStep("Cell finished"),
    ])
    const { client, sessionId, branchId } = yield* createRpcHarness({
      extensions: cell.extensions,
      providerLayer,
      extensionInputs: [],
      branchTools: CellBranchTools,
      durableApproval: true,
      agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
    })
    yield* client.message.send({ sessionId, branchId, content: "Run a cell with approval" })
    const presented = yield* client.session.events({ sessionId, branchId }).pipe(
      Stream.map((envelope) => envelope.event),
      Stream.filter((event) => event._tag === "InteractionPresented"),
      Stream.take(1),
      Stream.runCollect,
    )
    const request = Array.from(presented)[0]
    if (Predicate.isUndefined(request)) return yield* Effect.die("Missing approval")
    return { cell, client, sessionId, branchId, request }
  })

/** The `cell` tool results on a branch once its turn completed. */
const cellResultsAfterTurn = (started: Effect.Success<ReturnType<typeof startApprovalCell>>) =>
  Effect.gen(function* () {
    const { client, sessionId, branchId } = started
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

/** Run one cell turn, answer its one dialog with `approved`, and return the cell result. */
const runApprovalCell = (params: {
  readonly code: string
  readonly approved: boolean
  readonly beforeAnswer?: (cell: Effect.Success<typeof approvalCell>) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const started = yield* startApprovalCell(params.code)
    const { cell, client, sessionId, branchId, request } = started
    if (Predicate.isNotUndefined(params.beforeAnswer)) yield* params.beforeAnswer(cell)
    yield* client.interaction.respondInteraction({
      sessionId,
      branchId,
      requestId: request.requestId,
      approved: params.approved,
    })
    const results = yield* cellResultsAfterTurn(started)
    expect(results).toHaveLength(1)
    return { result: results[0], cell }
  })

describe("cell approvals", () => {
  it.scopedLive(
    "an answered approval continues the cell, and a decline reaches the cell code",
    () =>
      Effect.gen(function* () {
        for (const approved of [true, false]) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { result, cell } = yield* runApprovalCell({
                code: [
                  "await tools.mark('before')",
                  "let outcome",
                  "try { outcome = await tools.guarded({}) } catch (error) { outcome = 'caught ' + error.message }",
                  "await tools.mark('after')",
                  "outcome",
                ].join("\n"),
                approved,
                beforeAnswer: ({ marks }) =>
                  Ref.get(marks).pipe(Effect.map((values) => expect(values).toEqual(["before"]))),
              })
              let outcome = "caught"
              let guarded = "failed"
              if (approved) {
                outcome = "allowed"
                guarded = "succeeded"
              }
              expect(result).toMatchObject({
                isFailure: false,
                result: {
                  display: expect.stringContaining(outcome),
                  operations: [
                    { tool: "mark", outcome: "succeeded", summary: "marked before" },
                    { tool: "guarded", outcome: guarded },
                    { tool: "mark", outcome: "succeeded", summary: "marked after" },
                  ],
                },
              })
              expect(result).not.toMatchObject({ result: { stateLost: true } })
              // Code after the call ran, and the call asked once: nothing ran twice.
              expect(yield* Ref.get(cell.marks)).toEqual(["before", "after"])
              expect(yield* Ref.get(cell.asked)).toBe(1)
            }),
          )
        }
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.provide(Layer.merge(BunServices.layer, BunGentPlatformLive)),
      ),
    18000,
  )

  it.scopedLive(
    "a cancel while a call waits in place closes the dialog, ends the cell, and returns",
    () =>
      Effect.gen(function* () {
        const started = yield* startApprovalCell(
          [
            "await tools.mark('before')",
            "await tools.guarded({})",
            "await tools.mark('after')",
          ].join("\n"),
        )
        const { cell, client, sessionId, branchId, request } = started
        yield* client.steer
          .command({
            command: {
              _tag: "Cancel",
              sessionId,
              branchId,
              requestId: RequestId.make("cancel-waiting-cell"),
            },
          })
          .pipe(Effect.timeout("3 seconds"))
        const dismissed = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.map((envelope) => envelope.event),
          Stream.filter((event) => event._tag === "InteractionResolved"),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("3 seconds"),
        )
        expect(Array.from(dismissed)).toMatchObject([
          { requestId: request.requestId, approved: false, dismissed: true },
        ])
        const results = yield* cellResultsAfterTurn(started).pipe(Effect.timeout("5 seconds"))
        expect(results).toHaveLength(1)
        // The text follows the records: `mark` has its result, the asking call never got an answer.
        expect(results[0]?.result).toMatchObject({
          message: expect.stringContaining(
            "1 operation stopped at an approval that was not answered",
          ),
        })
        expect(results[0]?.result).toMatchObject({
          message: expect.not.stringContaining("may have occurred"),
        })
        // The cell ended at the call; nothing after it ran, and nothing acted.
        expect(yield* Ref.get(cell.marks)).toEqual(["before"])
        expect(yield* Ref.get(cell.allowed)).toBe(0)
        // The dialog is closed: an answer that comes late has nothing to answer.
        const late = yield* Effect.flip(
          client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: request.requestId,
            approved: true,
          }),
        )
        expect(late._tag).toBe("InteractionRequestMismatchError")
        expect(yield* Ref.get(cell.allowed)).toBe(0)
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.provide(Layer.merge(BunServices.layer, BunGentPlatformLive)),
      ),
    18000,
  )

  it.scopedLive(
    "a restart while a call waits in place: the request comes back, and an approval acts once",
    () =>
      Effect.gen(function* () {
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const storagePath = (yield* Path.Path).join(directory, "gent.db")
        const cell = yield* approvalCell
        const server = (steps: Parameters<typeof LanguageModelLayers.sequence>[0]) =>
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence(steps)
            return yield* createRpcClient(
              createE2ELayer({
                extensions: cell.extensions,
                providerLayer,
                extensionInputs: [],
                branchTools: CellBranchTools,
                durableApproval: true,
                agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
                storagePath,
              }),
            )
          })
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* server([
              toolCallStep("cell", {
                code: [
                  "await tools.mark('before')",
                  "await tools.guarded({})",
                  "await tools.mark('after')",
                ].join("\n"),
              }),
            ])
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            yield* client.message.send({ sessionId, branchId, content: "Run a cell" })
            const presented = Array.from(
              yield* client.session.events({ sessionId, branchId }).pipe(
                Stream.map((envelope) => envelope.event),
                Stream.filter((event) => event._tag === "InteractionPresented"),
                Stream.take(1),
                Stream.runCollect,
              ),
            )[0]
            if (Predicate.isUndefined(presented)) return yield* Effect.die("Missing approval")
            const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
            return {
              sessionId,
              branchId,
              requestId: presented.requestId,
              lastEventId: snapshot.lastEventId ?? 0,
            }
          }),
        )
        // The server stops while the call waits in place, as a crash would stop it.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* server([textStep("Recovered")])
            const { sessionId, branchId } = first
            const rehydrated = Array.from(
              yield* client.session.events({ sessionId, branchId, after: first.lastEventId }).pipe(
                Stream.map((envelope) => envelope.event),
                Stream.filter((event) => event._tag === "InteractionPresented"),
                Stream.take(1),
                Stream.runCollect,
                Effect.timeout("5 seconds"),
              ),
            )
            expect(rehydrated.map((event) => event.requestId)).toEqual([first.requestId])
            yield* client.interaction.respondInteraction({
              sessionId,
              branchId,
              requestId: first.requestId,
              approved: true,
            })
            yield* client.session.events({ sessionId, branchId, after: first.lastEventId }).pipe(
              Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
              Stream.take(1),
              Stream.runDrain,
              Effect.timeout("5 seconds"),
            )
            const results = (yield* client.message.list({ branchId }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool-result")
              .filter((part) => part.name === "cell")
            expect(results).toHaveLength(1)
            // The approved call acted once. The cell source cannot run again, so
            // the code after the call did not run and the cell says its state
            // was lost.
            expect(yield* Ref.get(cell.allowed)).toBe(1)
            expect(yield* Ref.get(cell.marks)).toEqual(["before"])
            expect(results[0]).toMatchObject({ result: { stateLost: true } })
          }),
        )
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.provide(Layer.merge(BunServices.layer, BunGentPlatformLive)),
      ),
    25000,
  )

  it.scopedLive(
    "a sibling call in the same cell runs to its end while another call waits for its answer",
    () =>
      Effect.gen(function* () {
        const { result, cell } = yield* runApprovalCell({
          code: [
            "const [slow, guarded] = await Promise.all([tools.slow({}), tools.guarded({})])",
            "await tools.mark('after')",
            "slow + '/' + guarded",
          ].join("\n"),
          approved: true,
          // The dialog is open. The sibling still runs, and it finishes
          // before anyone answers.
          beforeAnswer: ({ slowStarted, slowRelease, slowDone }) =>
            Deferred.await(slowStarted).pipe(
              Effect.andThen(Deferred.completeWith(slowRelease, Effect.void)),
              Effect.andThen(Deferred.await(slowDone)),
              Effect.timeout("5 seconds"),
              Effect.orDie,
            ),
        })
        expect(result).toMatchObject({
          isFailure: false,
          result: {
            display: expect.stringContaining("slow done/allowed"),
            operations: [
              { tool: "slow", outcome: "succeeded" },
              { tool: "guarded", outcome: "succeeded" },
              { tool: "mark", outcome: "succeeded", summary: "marked after" },
            ],
          },
        })
        expect(yield* Ref.get(cell.asked)).toBe(1)
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.provide(Layer.merge(BunServices.layer, BunGentPlatformLive)),
      ),
    18000,
  )

  it.scopedLive(
    "a call beside the cell that asks while the cell's question is open asks once the cell took its answer",
    () =>
      Effect.gen(function* () {
        const cell = yield* approvalCell
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          multiToolCallStep(
            { toolName: "cell", input: { code: "await tools.guarded({})" } },
            { toolName: "native", input: {} },
          ),
          textStep("Both answered"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          extensions: cell.extensions,
          providerLayer,
          extensionInputs: [],
          branchTools: CellBranchTools,
          durableApproval: true,
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
        })
        const dialogs = yield* Queue.unbounded<{
          readonly requestId: InteractionRequestId
          readonly text: string
        }>()
        yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.map((envelope) => envelope.event),
          Stream.runForEach((event) => {
            if (event._tag !== "InteractionPresented") return Effect.void
            return Queue.offer(dialogs, { requestId: event.requestId, text: event.text })
          }),
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "Ask in and beside a cell" })
        const inCell = yield* Queue.take(dialogs)
        expect(inCell.text).toBe("Continue cell operation?")
        // The native call asks while the cell's question is open. It waits
        // for the slot: the cell's call still runs and takes its own answer.
        yield* Deferred.completeWith(cell.nativeGate, Effect.void)
        yield* Deferred.await(cell.nativeAsking)
        yield* client.interaction.respondInteraction({
          sessionId,
          branchId,
          requestId: inCell.requestId,
          approved: true,
        })
        const beside = yield* Queue.take(dialogs)
        expect(beside.text).toBe("Native call?")
        yield* client.interaction.respondInteraction({
          sessionId,
          branchId,
          requestId: beside.requestId,
          approved: true,
        })
        const snapshot = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) =>
            current.runtime._tag === "Idle" &&
            current.messages.some(
              (message) =>
                message.role === "assistant" && messagePartsText(message.parts) === "Both answered",
            ),
          5_000,
          "the turn finished",
        )
        const results = snapshot.messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result")
        expect(results.find((part) => part.name === "native")).toMatchObject({
          isFailure: false,
          result: "true",
        })
        expect(results.find((part) => part.name === "cell")).toMatchObject({ isFailure: false })
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.provide(Layer.merge(BunServices.layer, BunGentPlatformLive)),
      ),
    18000,
  )
})

describe("cell receipts", () => {
  it.scopedLive(
    "a cell with ten or more host calls lists its receipts in call order",
    () =>
      Effect.gen(function* () {
        const extensions: ReadonlyArray<LoadedExtension> = [
          {
            manifest: { id: ExtensionId.make("cell-receipt-order") },
            scope: "builtin",
            sourcePath: "cell-receipt-order",
            artifactIdentity: LoadedArtifactIdentity.make("cell-receipt-order-source"),
            contributions: {
              tools: [
                CellTool,
                tool({
                  id: "mark",
                  description: "Record a mark",
                  params: Schema.String,
                  output: Schema.Boolean,
                  execute: () => Effect.succeed(true),
                  summary: (mark) => `marked ${mark}`,
                }),
              ],
            },
          },
        ]
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", {
            code: "for (let i = 1; i <= 12; i++) await tools.mark(String(i)); 'marked'",
          }),
          textStep("Marks recorded"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          extensions,
          providerLayer,
          extensionInputs: [],
          branchTools: CellBranchTools,
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
        })
        yield* client.message.send({ sessionId, branchId, content: "Mark twelve times" })
        yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runDrain,
        )
        const result = (yield* client.message.list({ branchId }))
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool-result" && part.name === "cell")
        if (Predicate.isUndefined(result) || result.type !== "tool-result")
          return yield* Effect.die("Missing cell result")
        const receipts = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ operations: Schema.Array(Schema.Struct({ summary: Schema.String })) }),
        )(result.result)
        expect(receipts.operations.map((receipt) => receipt.summary)).toEqual(
          Array.from({ length: 12 }, (_, index) => `marked ${index + 1}`),
        )
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.provide(Layer.merge(BunServices.layer, BunGentPlatformLive)),
      ),
    18000,
  )
})

// ── bound cell tool calls ───────────────────────────────────────────────────

const extensionId = ExtensionId.make("cell-test")
const runCellToolCall = (params: Parameters<typeof executeBoundCellTool>[0]) =>
  executeBoundCellTool(params).pipe(Effect.flatMap(cellToolResultValue))
const sessionIdToolCall = SessionId.make("cell-session")
const branchIdToolCall = BranchId.make("cell-branch")
const toolCallId = ToolCallId.make("cell-inner-operation")
const requestToolCall = CellResponse.cases.HostCall.make({
  cellId: "1",
  operationId: "1",
  name: "echo",
  input: { text: "hello" },
})
const host = testToolContext({
  sessionId: sessionIdToolCall,
  branchId: branchIdToolCall,
  toolCallId,
})
const base = Layer.mergeAll(BunServices.layer, ToolRunner.Live, EventStore.Memory)

it.scopedLive("uses the exact selected capability and still enforces the input schema", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const selected = tool({
      id: "echo",
      description: "Selected echo",
      params: Schema.Struct({ text: Schema.String }),
      output: Schema.String,
      execute: ({ text }) =>
        Ref.update(calls, (count) => count + 1).pipe(Effect.as(`selected:${text}`)),
    })
    const replacement = tool({
      id: "echo",
      description: "Replacement echo",
      params: Schema.Struct({ text: Schema.String }),
      output: Schema.String,
      execute: () => Effect.die("Must not resolve the replacement by name"),
    })
    const dispatch = provideToolDispatch({
      extensions: [
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "cell-test",
          contributions: { tools: [replacement] },
        },
      ],
      host,
    })
    const binding: Option.Option<ResolvedToolCapability> = Option.some({
      extensionId,
      capability: selected,
    })
    yield* Effect.gen(function* () {
      expect(yield* runCellToolCall({ request: requestToolCall, toolCallId, binding })).toBe(
        "selected:hello",
      )
      const invalid = yield* runCellToolCall({
        request: CellResponse.cases.HostCall.make({ ...requestToolCall, input: { text: 1 } }),
        toolCallId,
        binding,
      }).pipe(Effect.flip)
      expect(invalid._tag).toBe("CellEvaluationError")
      const mismatch = yield* runCellToolCall({
        request: CellResponse.cases.HostCall.make({ ...requestToolCall, name: "other" }),
        toolCallId,
        binding,
      }).pipe(Effect.flip)
      expect(mismatch._tag).toBe("CellEvaluationError")
      const missing = yield* runCellToolCall({
        request: requestToolCall,
        toolCallId,
        binding: Option.none(),
      }).pipe(Effect.flip)
      expect(missing._tag).toBe("CellEvaluationError")
      if (missing._tag === "CellEvaluationError") expect(missing.message).toContain("Unknown tool")
      expect(yield* Ref.get(calls)).toBe(1)
    }).pipe(dispatch, Effect.provideContext(yield* Layer.build(base)))
  }),
)

it.scopedLive("a call that parks instead of waiting for its answer fails closed", () =>
  Effect.gen(function* () {
    const selected = tool({
      id: "echo",
      description: "Parks on an interaction",
      params: Schema.Struct({ text: Schema.String }),
      output: Schema.String,
      execute: () =>
        Effect.fail(
          new InteractionPendingError({
            requestId: InteractionRequestId.make("cell-approval"),
            sessionId: sessionIdToolCall,
            branchId: branchIdToolCall,
          }),
        ),
    })
    const dispatch = provideToolDispatch({
      extensions: [
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "cell-test",
          contributions: { tools: [selected] },
        },
      ],
      host,
    })
    const result = yield* runCellToolCall({
      request: requestToolCall,
      toolCallId,
      binding: Option.some({ extensionId, capability: selected }),
    }).pipe(dispatch, Effect.provideContext(yield* Layer.build(base)), Effect.flip)
    expect(result._tag).toBe("CellEvaluationError")
    expect(result.message).toContain("cannot resume")
  }),
)

it.effect(
  "drops undefined optional fields from a tool result before it crosses the cell pipe",
  () =>
    Effect.gen(function* () {
      // Schema-encoded results keep `undefined` for optional fields such as the
      // delegate metadata session id of a private child. That is not JSON.
      const Metadata = Schema.Struct({
        sessionId: Schema.optional(Schema.String),
        agentName: Schema.String,
      })
      const metadata = yield* Schema.encodeEffect(Metadata)({
        sessionId: Option.getOrUndefined(Option.none<string>()),
        agentName: "main",
      })
      const result = Prompt.toolResultPart({
        id: toolCallId,
        name: "delegate.start",
        isFailure: false,
        providerExecuted: false,
        result: { output: "pong", metadata },
      })
      const value = yield* cellToolResultValue(result)
      expect(value).toEqual({ output: "pong", metadata: { agentName: "main" } })
    }),
)

it.effect("a failed tool throws its error text, and any other failure value as JSON", () =>
  Effect.gen(function* () {
    const failure = (result: Schema.Json) =>
      cellToolResultValue(
        Prompt.toolResultPart({
          id: toolCallId,
          name: "delegate.start",
          isFailure: true,
          providerExecuted: false,
          result,
        }),
      ).pipe(Effect.flip)
    const plain = yield* failure({ error: "Tool 'delegate.start' failed: no such agent" })
    expect(plain.message).toBe("Tool 'delegate.start' failed: no such agent")
    const detailed = yield* failure({ error: "boom", code: 3 })
    expect(detailed.message).toBe('{"error":"boom","code":3}')
  }),
)

// ── cell tool host ──────────────────────────────────────────────────────────

const cellToolHost = {
  sessionId: SessionId.make("recorded-host-session"),
  branchId: BranchId.make("recorded-host-branch"),
  assistantMessageId: MessageId.make("recorded-host-message"),
  toolCallId: ToolCallId.make("recorded-host-call"),
}
const requestToolHost = (operationId: string, name: string) =>
  CellResponse.cases.HostCall.make({
    cellId: "1",
    operationId,
    name,
    input: { valid: true },
  })

const prepareCell = Effect.gen(function* () {
  yield* ensureStorageParents(cellToolHost)
  yield* (yield* MessageStorage).createMessage(
    Message.cases.regular.make({
      id: cellToolHost.assistantMessageId,
      sessionId: cellToolHost.sessionId,
      branchId: cellToolHost.branchId,
      role: "assistant",
      createdAt: dateFromMillis(0),
      parts: [
        Prompt.toolCallPart({
          id: cellToolHost.toolCallId,
          name: "cell",
          params: { code: "1" },
          providerExecuted: false,
        }),
      ],
    }),
  )
  yield* (yield* CellStorage).executions.claim(cellToolHost)
})

/**
 * Start an inner call that asks, and lose the worker while the call waits for
 * its answer in place, as a crash would. The operation is left waiting.
 */
const askThenLoseWorker = (
  host: typeof CellOperationHost.Service,
  request: Extract<CellResponse, { _tag: "HostCall" }>,
  cell: typeof cellToolHost = cellToolHost,
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

const currentHostParams = Effect.gen(function* () {
  const turn = yield* captureTurnTools(cellToolHost)
  return {
    cell: cellToolHost,
    profile: turn.profile,
    toolBindings: turn.toolBindings,
    ledger: yield* ModelContextLedger.make,
  }
})

it.scopedLive(
  "records real host results once and preserves approval and interrupted outcomes",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const approvalCalls = yield* Ref.make(0)
      const started = yield* Deferred.make<boolean>()
      const finalized = yield* Deferred.make<boolean>()
      const extensions: ReadonlyArray<LoadedExtension> = [
        {
          manifest: { id: ExtensionId.make("recorded-host") },
          scope: "builtin",
          sourcePath: "recorded-host",
          artifactIdentity: LoadedArtifactIdentity.make("recorded-host-source"),
          contributions: {
            tools: [
              tool({
                id: "count",
                description: "Count execution",
                params: Schema.Struct({ valid: Schema.Boolean }),
                output: Schema.Finite,
                execute: () => Ref.updateAndGet(calls, (count) => count + 1),
              }),
              tool({
                id: "approve",
                description: "Request approval",
                params: Schema.Struct({}),
                output: Schema.Boolean,
                execute: () =>
                  Effect.gen(function* () {
                    yield* Ref.update(approvalCalls, (count) => count + 1)
                    const ctx = yield* ExtensionContext
                    return (yield* ctx.Interaction.approve({ text: "Allow?" })).approved
                  }),
              }),
              tool({
                id: "interrupt",
                description: "Wait after effect",
                params: Schema.Struct({}),
                output: Schema.Boolean,
                execute: () =>
                  Ref.update(calls, (count) => count + 1).pipe(
                    Effect.andThen(Deferred.succeed(started, true)),
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(finalized, true)),
                  ),
              }),
            ],
          },
        },
      ]
      const context = yield* Layer.build(
        createE2ELayer({
          agents: [],
          extensionInputs: [],
          branchTools: CellBranchTools,
          extensions,
          providerLayer: LanguageModelLayers.debug(),
          durableApproval: true,
        }),
      )
      yield* Effect.gen(function* () {
        yield* prepareCell
        const hostParams = yield* currentHostParams
        const host = yield* makeCellToolHost(hostParams)
        expect(
          (yield* recoverCellExecution({
            ...hostParams,
            cell: { ...cellToolHost, branchId: BranchId.make("other") },
          }).pipe(Effect.flip))._tag,
        ).toBe("CellEvaluationError")
        expect(yield* host.call(requestToolHost("1", "count"))).toBe(1)
        expect(yield* host.call(requestToolHost("1", "count"))).toBe(1)
        expect(yield* Ref.get(calls)).toBe(1)
        const invalid = CellResponse.cases.HostCall.make({
          ...requestToolHost("invalid", "count"),
          input: [],
        })
        expect((yield* host.call(invalid).pipe(Effect.flip))._tag).toBe("CellEvaluationError")
        expect((yield* host.call(invalid).pipe(Effect.flip))._tag).toBe("CellEvaluationError")
        const operations = (yield* CellStorage).operations
        const failed = yield* operations.get({ cell: cellToolHost, operationId: "invalid" })
        expect(failed.state._tag).toBe("Completed")
        if (failed.state._tag === "Completed") expect(failed.state.result.isFailure).toBe(true)
        expect(yield* Ref.get(calls)).toBe(1)
        // The approval waits for its answer in place. The worker is lost
        // while it waits, so recovery finds the operation still waiting.
        const pending = yield* askThenLoseWorker(host, requestToolHost("2", "approve"))
        expect(yield* (yield* InteractionStorage).listOpen(cellToolHost)).toHaveLength(1)
        const undecided = yield* recoverCellExecution(hostParams).pipe(Effect.flip)
        expect(undecided._tag).toBe("InteractionPendingError")
        if (undecided._tag === "InteractionPendingError")
          expect(undecided.requestId).toBe(pending.requestId)
        expect(yield* Ref.get(approvalCalls)).toBe(1)
        const resumeParams = {
          ...hostParams,
          operationId: "2",
          requestId: pending.requestId,
        }
        expect(
          (yield* resumeCellToolOperation({
            ...resumeParams,
            requestId: InteractionRequestId.make("wrong"),
          }).pipe(Effect.flip))._tag,
        ).toBe("StorageError")
        expect(yield* Ref.get(approvalCalls)).toBe(1)
        const approval = yield* ApprovalService
        yield* approval.storeResolution(cellToolHost, pending.requestId, { approved: false })
        const attempts = yield* Effect.all(
          [
            resumeCellToolOperation(resumeParams).pipe(Effect.exit),
            resumeCellToolOperation(resumeParams).pipe(Effect.exit),
          ],
          { concurrency: 2 },
        )
        expect(attempts.filter(Exit.isSuccess)).toHaveLength(1)
        const success = attempts.find(Exit.isSuccess)
        if (Predicate.isUndefined(success)) return yield* Effect.die("No successful resume")
        const resumed = success.value
        expect(resumed.result).toBe(false)
        expect(resumed.isFailure).toBe(false)
        expect(resumed.id).toBe(pending.toolCallId)
        expect((yield* operations.get({ cell: cellToolHost, operationId: "2" })).state._tag).toBe(
          "Completed",
        )
        expect((yield* resumeCellToolOperation(resumeParams).pipe(Effect.flip))._tag).toBe(
          "StorageError",
        )
        expect(yield* Ref.get(approvalCalls)).toBe(2)
        expect((yield* (yield* CellStorage).executions.claim(cellToolHost))._tag).toBe("Incomplete")
        const running = yield* host.call(requestToolHost("3", "interrupt")).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(running)
        yield* Deferred.await(finalized)
        const unknown = yield* host.call(requestToolHost("3", "interrupt")).pipe(Effect.flip)
        expect(unknown._tag).toBe("CellEvaluationError")
        if (unknown._tag === "CellEvaluationError")
          expect(unknown.message).toContain("not executed again")
        expect(yield* Ref.get(calls)).toBe(2)
        const recovered = yield* recoverCellExecution(hostParams)
        expect(recovered.isFailure).toBe(true)
        expect(recovered.result).toMatchObject({
          stateLost: true,
          error: expect.stringContaining(
            "1 operation ran with no recorded result; its effects may have occurred.",
          ),
          // An operation with no recorded outcome is an incomplete receipt.
          operations: expect.arrayContaining([
            {
              toolCallId: (yield* operations.get({ cell: cellToolHost, operationId: "3" }))
                .toolCallId,
              tool: "interrupt",
              outcome: "incomplete",
              summary: "",
            },
          ]),
        })
        expect(yield* recoverCellExecution(hostParams)).toEqual(recovered)
        expect(yield* Ref.get(calls)).toBe(2)
      }).pipe(Effect.provideContext(context))
    }).pipe(Effect.timeout("15 seconds")),
  20000,
)

it.scopedLive(
  "a lost cell whose operations all have results says no effect is unrecorded",
  () =>
    Effect.gen(function* () {
      const extensions: ReadonlyArray<LoadedExtension> = [
        {
          manifest: { id: ExtensionId.make("recorded-host") },
          scope: "builtin",
          sourcePath: "recorded-host",
          artifactIdentity: LoadedArtifactIdentity.make("recorded-host-source"),
          contributions: {
            tools: [
              tool({
                id: "count",
                description: "Count execution",
                params: Schema.Struct({ valid: Schema.Boolean }),
                output: Schema.Finite,
                execute: () => Effect.succeed(1),
              }),
            ],
          },
        },
      ]
      const context = yield* Layer.build(
        createE2ELayer({
          agents: [],
          extensionInputs: [],
          branchTools: CellBranchTools,
          extensions,
          providerLayer: LanguageModelLayers.debug(),
        }),
      )
      yield* Effect.gen(function* () {
        yield* prepareCell
        const hostParams = yield* currentHostParams
        const host = yield* makeCellToolHost(hostParams)
        expect(yield* host.call(requestToolHost("1", "count"))).toBe(1)
        // The worker is lost after its one operation completed.
        const recovered = yield* recoverCellExecution(hostParams)
        expect(recovered.isFailure).toBe(true)
        expect(recovered.result).toMatchObject({
          stateLost: true,
          error:
            "The cell worker state was lost. Its source was not replayed. Every host operation it made has its result in operations.",
          operations: [expect.objectContaining({ tool: "count", outcome: "succeeded" })],
        })
      }).pipe(Effect.provideContext(context))
    }).pipe(Effect.timeout("10 seconds")),
  12000,
)

it.scopedLive(
  "a cell completed before a crash comes back with its operation receipts",
  () =>
    Effect.gen(function* () {
      const extensions: ReadonlyArray<LoadedExtension> = [
        {
          manifest: { id: ExtensionId.make("recorded-host") },
          scope: "builtin",
          sourcePath: "recorded-host",
          artifactIdentity: LoadedArtifactIdentity.make("recorded-host-source"),
          contributions: {
            tools: [
              tool({
                id: "count",
                description: "Count execution",
                params: Schema.Struct({ valid: Schema.Boolean }),
                output: Schema.Finite,
                execute: () => Effect.succeed(1),
                summary: (input, output) => `counted ${output} (valid ${input.valid})`,
              }),
            ],
          },
        },
      ]
      const context = yield* Layer.build(
        createE2ELayer({
          agents: [],
          extensionInputs: [],
          branchTools: CellBranchTools,
          extensions,
          providerLayer: LanguageModelLayers.debug(),
        }),
      )
      yield* Effect.gen(function* () {
        yield* prepareCell
        const hostParams = yield* currentHostParams
        const host = yield* makeCellToolHost(hostParams)
        expect(yield* host.call(requestToolHost("1", "count"))).toBe(1)
        // The process stored the cell result and died before the receipts were attached.
        yield* (yield* CellStorage).executions.complete(
          cellToolHost,
          Prompt.toolResultPart({
            id: cellToolHost.toolCallId,
            name: "cell",
            isFailure: false,
            providerExecuted: false,
            result: { value: 1 },
          }),
        )
        const recovered = yield* recoverCellExecution(hostParams)
        expect(recovered.result).toEqual({
          value: 1,
          operations: [
            {
              toolCallId: expect.any(String),
              tool: "count",
              outcome: "succeeded",
              // Recovery resolves the recorded binding, so the author's summary holds.
              summary: "counted 1 (valid true)",
            },
          ],
        })
      }).pipe(Effect.provideContext(context))
    }).pipe(Effect.timeout("10 seconds")),
  12000,
)

it.scopedLive(
  "resumes an approved operation after reopen and rejects changed source before admission",
  () =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const storagePath = (yield* Path.Path).join(directory, "gent.db")
      const calls = yield* Ref.make(0)
      const extension = (revision: string): LoadedExtension => ({
        manifest: { id: ExtensionId.make("restart-host") },
        scope: "builtin",
        sourcePath: "restart-host",
        artifactIdentity: LoadedArtifactIdentity.make(revision),
        contributions: {
          tools: [
            tool({
              id: "approve",
              description: "Approve saved input",
              params: Schema.Struct({ valid: Schema.Boolean }),
              output: Schema.Boolean,
              execute: ({ valid }) =>
                Effect.gen(function* () {
                  yield* Ref.update(calls, (count) => count + 1)
                  const ctx = yield* ExtensionContext
                  return (
                    (yield* ctx.Interaction.approve({ text: "Allow saved input?" })).approved &&
                    valid
                  )
                }),
            }),
          ],
        },
      })
      const layer = (revision: string) =>
        createE2ELayer({
          agents: [],
          extensionInputs: [],
          branchTools: CellBranchTools,
          extensions: [extension(revision)],
          providerLayer: LanguageModelLayers.debug(),
          durableApproval: true,
          storagePath,
        })
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer("original"))
          return yield* Effect.gen(function* () {
            yield* prepareCell
            const host = yield* makeCellToolHost(yield* currentHostParams)
            const pending = yield* askThenLoseWorker(host, requestToolHost("1", "approve"))
            yield* (yield* ApprovalService).storeResolution(cellToolHost, pending.requestId, {
              approved: true,
            })
            return pending
          }).pipe(Effect.provideContext(context))
        }),
      )
      const next = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer("original"))
          return yield* Effect.gen(function* () {
            const hostParams = yield* currentHostParams
            const result = yield* resumeCellToolOperation({
              ...hostParams,
              operationId: "1",
              requestId: first.requestId,
            })
            expect(result.result).toBe(true)
            expect(result.id).toBe(first.toolCallId)
            expect(yield* Ref.get(calls)).toBe(2)
            expect((yield* (yield* CellStorage).executions.claim(cellToolHost))._tag).toBe(
              "Incomplete",
            )
            const pending = yield* askThenLoseWorker(
              yield* makeCellToolHost(hostParams),
              requestToolHost("2", "approve"),
            )
            yield* (yield* ApprovalService).storeResolution(cellToolHost, pending.requestId, {
              approved: true,
            })
            return pending
          }).pipe(Effect.provideContext(context))
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer("changed"))
          yield* Effect.gen(function* () {
            const mismatch = yield* resumeCellToolOperation({
              ...(yield* currentHostParams),
              operationId: "2",
              requestId: next.requestId,
            }).pipe(Effect.flip)
            expect(mismatch._tag).toBe("ToolBindingReplayError")
            if (mismatch._tag === "ToolBindingReplayError")
              expect(mismatch.reason).toBe("SourceMismatch")
            expect(
              (yield* (yield* CellStorage).operations.get({
                cell: cellToolHost,
                operationId: "2",
              })).state._tag,
            ).toBe("Waiting")
            expect(yield* Ref.get(calls)).toBe(3)
          }).pipe(Effect.provideContext(context))
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer("original"))
          yield* Effect.gen(function* () {
            const hostParams = yield* currentHostParams
            const recovered = yield* recoverCellExecution(hostParams)
            expect(recovered.isFailure).toBe(true)
            expect(recovered.result).toMatchObject({ stateLost: true })
            expect(yield* Ref.get(calls)).toBe(4)
            expect(
              (yield* (yield* CellStorage).operations.listForToolCall(cellToolHost)).map(
                ({ operation }) => operation.state._tag,
              ),
            ).toEqual(["Completed", "Completed"])
            expect(yield* recoverCellExecution(hostParams)).toEqual(recovered)
            expect(yield* Ref.get(calls)).toBe(4)
          }).pipe(Effect.provideContext(context))
        }),
      )
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  25000,
)

// ── cell context host ───────────────────────────────────────────────────────

const sessionIdContextHost = SessionId.make("context-host-session")
const branchIdContextHost = BranchId.make("context-host-branch")
const decodeReply = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.optional(Schema.String),
    kind: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    totalChars: Schema.optional(Schema.Finite),
    nextOffset: Schema.optional(Schema.Finite),
    done: Schema.optional(Schema.Boolean),
    projected: Schema.optional(Schema.Boolean),
    percent: Schema.optional(Schema.Finite),
    scheduled: Schema.optional(Schema.String),
    total: Schema.optional(Schema.Finite),
    entries: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          role: Schema.String,
          chars: Schema.Finite,
          preview: Schema.String,
          kind: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
)

const layer = Layer.mergeAll(
  testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations),
  GentPlatform.Test(),
  ModelContextLedger.Branch,
)

const seedTranscript = Effect.gen(function* () {
  yield* ensureStorageParents({ sessionId: sessionIdContextHost, branchId: branchIdContextHost })
  const storage = yield* MessageStorage
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n")
  yield* storage.createMessage(
    Message.cases.regular.make({
      id: MessageId.make("m-long"),
      sessionId: sessionIdContextHost,
      branchId: branchIdContextHost,
      role: "assistant",
      parts: [Prompt.textPart({ text: lines })],
      createdAt: dateFromMillis(1_000),
    }),
  )
  yield* storage.createMessage(
    Message.cases.regular.make({
      id: MessageId.make("m-tool"),
      sessionId: sessionIdContextHost,
      branchId: branchIdContextHost,
      role: "tool",
      parts: [
        Prompt.toolResultPart({
          id: ToolCallId.make("call-1"),
          name: "read",
          result: { content: "full file body" },
          isFailure: false,
          providerExecuted: false,
        }),
      ],
      createdAt: dateFromMillis(2_000),
    }),
  )
})

describe("cell context host", () => {
  it.live("status reports the last projection or that none exists yet", () =>
    Effect.gen(function* () {
      const before = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context.status",
          input: {},
        }),
      )
      expect(before.projected).toBe(false)
      const ledger = yield* ModelContextLedger
      yield* ledger.recordProjection({
        estimatedTokens: 42,
        availableInputTokens: 84,
        contextLimitTokens: 100,
        omittedMessages: 3,
      })
      const after = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context.status",
          input: {},
        }),
      )
      expect(after.projected).toBe(true)
      // The share of the input the messages may take, not of the window.
      expect(after.percent).toBe(50)
    }).pipe(Effect.provide(layer)),
  )

  it.live("history lists the branch in order with previews and pages by offset", () =>
    Effect.gen(function* () {
      yield* seedTranscript
      const first = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context.history",
          input: { limit: 1 },
        }),
      )
      expect(first.total).toBe(2)
      expect(first.nextOffset).toBe(1)
      expect(first.done).toBe(false)
      expect(first.entries?.map((entry) => entry.id)).toEqual(["m-long"])
      expect(first.entries?.[0]?.role).toBe("assistant")
      expect(first.entries?.[0]?.preview.startsWith("line 1 line 2")).toBe(true)
      expect(first.entries?.[0]?.chars).toBeGreaterThan(200)
      const rest = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context.history",
          input: { offset: 1 },
        }),
      )
      expect(rest.entries?.map((entry) => entry.id)).toEqual(["m-tool"])
      expect(rest.done).toBe(true)
    }).pipe(Effect.provide(layer)),
  )

  it.live("read pages a durable message by id and finds a tool result by call id", () =>
    Effect.gen(function* () {
      yield* seedTranscript
      const page = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context.read",
          input: { id: "m-long", offset: 7, limit: 13 },
        }),
      )
      expect(page.kind).toBe("message")
      expect(page.text).toBe("line 2\nline 3")
      expect(page.totalChars).toBeGreaterThan(200)
      expect(page.nextOffset).toBe(20)
      expect(page.done).toBe(false)
      const result = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context.read",
          input: { id: "call-1" },
        }),
      )
      expect(result.kind).toBe("tool-result")
      expect(result.text).toContain("full file body")
      const missing = yield* handleContextCall({
        branchId: branchIdContextHost,
        name: "context.read",
        input: { id: "nope" },
      }).pipe(Effect.flip)
      expect(missing.message).toContain("No stored message or result has id nope")
    }).pipe(Effect.provide(layer)),
  )

  it.live("compact and newWindow schedule directives the next projection takes", () =>
    Effect.gen(function* () {
      const ledger = yield* ModelContextLedger
      const compact = decodeReply(
        yield* handleContextCall({
          branchId: branchIdContextHost,
          name: "context.compact",
          input: { instructions: "keep file paths" },
        }),
      )
      expect(compact.scheduled).toBe("compact")
      const directive = Option.getOrThrow(yield* ledger.pendingDirective)
      expect(directive._tag).toBe("Compact")
      if (directive._tag === "Compact") expect(directive.instructions).toBe("keep file paths")
      yield* handleContextCall({
        branchId: branchIdContextHost,
        name: "context.newWindow",
        input: {},
      })
      expect(Option.map(yield* ledger.pendingDirective, (d) => d._tag)).toEqual(
        Option.some("NewWindow"),
      )
      const unknown = yield* handleContextCall({
        branchId: branchIdContextHost,
        name: "context.reset",
        input: {},
      }).pipe(Effect.flip)
      expect(unknown.message).toContain("Unknown context operation")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a page clamps its window to the text and reports completion", () =>
    Effect.sync(() => {
      const page = pageText("abcdef", 2, 10)
      expect(page).toEqual({ text: "cdef", totalChars: 6, offset: 2, nextOffset: 6, done: true })
      expect(pageText("ab", 5, 1).text).toBe("")
    }),
  )

  it.effect("a large single-line result is read in full by continuing from nextOffset", () =>
    Effect.sync(() => {
      const text = "x".repeat(250_000)
      let offset = 0
      const pages: Array<string> = []
      for (let guard = 0; guard < 10; guard += 1) {
        const page = pageText(text, offset, 100_000)
        pages.push(page.text)
        offset = page.nextOffset
        if (page.done) break
      }
      expect(pages.map((page) => page.length)).toEqual([100_000, 100_000, 50_000])
      expect(pages.join("")).toBe(text)
    }),
  )
})

// ── shipped model surface ───────────────────────────────────────────────────

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const isToolLifecycleEvent = Predicate.or(
  Predicate.isTagged("ToolCallStarted"),
  Predicate.isTagged("ToolCallSucceeded"),
)

const cellOnly = (step: SequenceStep): SequenceStep => ({
  ...step,
  assertOptions: (options) => {
    expect(options.tools.map((tool) => tool.name)).toEqual(["cell"])
    const system = options.prompt.content
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n")
    expect(system).toContain("## Host Tools")
    expect(system).toContain("- tools.read(input: { path: string")
    expect(system).toContain("`tools(id)` returns the tool with its full input schema")
    expect(system).not.toContain("tools.cell(")
  },
})

describe("shipped model surface", () => {
  it.scopedLive(
    "a cell starts in its session's working directory, not the host's",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const sessionCwd = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "gent-cell-session-" }),
        )
        // The host process runs elsewhere, so an inherited working directory shows.
        expect(yield* fs.realPath(path.resolve("."))).not.toBe(sessionCwd)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: "process.cwd()" }),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
          cwd: sessionCwd,
        })
        yield* client.message.send({ sessionId, branchId, content: "where does the cell run" })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (all) =>
            all.some(
              (message) =>
                message.role === "assistant" && messagePartsText(message.parts) === "done",
            ),
          10_000,
          "assistant reply done",
        )
        const results = messages
          .flatMap((message) => message.parts)
          .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
        expect(results).toMatchObject([
          { name: "cell", isFailure: false, result: { display: sessionCwd } },
        ])
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    20000,
  )

  it.scopedLive(
    "advertises only cell and serves builtin host tools inside it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const file = path.join(directory, "note.txt")
        yield* fs.writeFileString(file, "shipped surface")
        const readNote = `const note = (await tools.read({path: ${encodeJson(file)}})).content; note`
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          cellOnly(toolCallStep("cell", { code: readNote })),
          textStep("first"),
          cellOnly(toolCallStep("cell", { code: "note.includes('shipped surface')" })),
          textStep("second"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
        })
        const runTurn = Effect.fn("Test.runTurn")(function* (content: string, reply: string) {
          yield* client.message.send({ sessionId, branchId, content })
          const completed = yield* waitFor(
            client.message.list({ branchId }),
            (messages) =>
              messages.some(
                (message) =>
                  message.role === "assistant" && messagePartsText(message.parts) === reply,
              ),
            10_000,
            `assistant reply ${reply}`,
          )
          return completed
            .flatMap((message) => message.parts)
            .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
            .filter((part) => part.name === "cell")
        })

        const first = yield* runTurn("read through the cell", "first")
        expect(first).toHaveLength(1)
        expect(first[0]).toMatchObject({
          isFailure: false,
          result: {
            display: expect.stringContaining("shipped surface"),
            // The saved result carries inner-operation receipts for the transcript,
            // summarized by the read tool itself.
            operations: [{ tool: "read", outcome: "succeeded", summary: `${file} · 1 line` }],
          },
        })
        const cellToolCallId = first[0]?.id
        // The inner call is published as an event nested under its cell.
        const innerEvents = yield* client.session.events({ sessionId, branchId, after: 0 }).pipe(
          Stream.filter(
            (envelope) =>
              isToolLifecycleEvent(envelope.event) && envelope.event.toolName === "read",
          ),
          Stream.take(2),
          Stream.runCollect,
        )
        const cellAssistant = (yield* client.message.list({ branchId })).find(
          (message) =>
            message.role === "assistant" &&
            message.parts.some((part) => part.type === "tool-call" && part.id === cellToolCallId),
        )
        expect(cellAssistant).toBeDefined()
        expect(innerEvents.map((envelope) => envelope.event)).toMatchObject([
          {
            _tag: "ToolCallStarted",
            parentToolCallId: cellToolCallId,
            assistantMessageId: cellAssistant?.id,
          },
          {
            _tag: "ToolCallSucceeded",
            parentToolCallId: cellToolCallId,
            assistantMessageId: cellAssistant?.id,
          },
        ])
        // A reload reads the inner call back from those events: the row's input, the
        // tool's own summary, and the bounded output its collapsed row draws.
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        const cellInteraction = snapshot.messages
          .flatMap((message) => message.toolInteractions)
          .find((interaction) => interaction.id === cellToolCallId)
        expect(cellInteraction?.operations).toMatchObject([
          {
            toolName: "read",
            status: "completed",
            input: { path: file },
            summary: `${file} · 1 line`,
          },
        ])
        const readOutput = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ content: Schema.String, lineCount: Schema.Finite }),
          ),
        )(cellInteraction?.operations?.[0]?.output)
        expect(readOutput).toMatchObject({ content: "1\tshipped surface", lineCount: 1 })

        // Working data from the first cell is still bound in the next turn.
        const second = yield* runTurn("use the note", "second")
        expect(second).toHaveLength(2)
        expect(second[1]).toMatchObject({ isFailure: false, result: { display: "true" } })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    18000,
  )

  it.scopedLive(
    "composes concurrent host calls inside one cell",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const left = path.join(directory, "left.txt")
        const right = path.join(directory, "right.txt")
        yield* fs.writeFileString(left, "left half")
        yield* fs.writeFileString(right, "right half")
        // Parallel delegation is a cell recipe, not a tool mode.
        const code = [
          `const [a, b] = await Promise.all([`,
          `  tools.read({path: ${encodeJson(left)}}),`,
          `  tools.read({path: ${encodeJson(right)}}),`,
          `]); a.content + ' | ' + b.content`,
        ].join("\n")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          cellOnly(toolCallStep("cell", { code })),
          textStep("joined"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "read both" })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (list) =>
            list.some(
              (message) =>
                message.role === "assistant" && messagePartsText(message.parts) === "joined",
            ),
          10_000,
          "assistant reply joined",
        )
        const results = messages
          .flatMap((message) => message.parts)
          .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
          isFailure: false,
          result: {
            display: "1\tleft half | 1\tright half",
            operations: [
              { tool: "read", outcome: "succeeded" },
              { tool: "read", outcome: "succeeded" },
            ],
          },
        })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    18000,
  )

  it.scopedLive(
    "allowedTools scopes host tools inside the cell instead of replacing the surface",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const file = path.join(directory, "note.txt")
        yield* fs.writeFileString(file, "scoped surface")
        // The agent allows `read` only and never names `cell`: the cell stays the model
        // surface and `grep` is unreachable from inside it.
        const scopedAgent = defineExtension({
          id: "@test/scoped-agent",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "agent",
              AgentDefinition.make({
                name: AgentName.make("scoped"),
                description: "reads only",
                allowedTools: ["read"],
              }),
            )
          }),
        })
        const code = [
          `let grep = 'reachable'`,
          `try { await tools.grep({pattern: 'scoped', path: ${encodeJson(directory)}}) } catch { grep = 'unreachable' }`,
          `(await tools.read({path: ${encodeJson(file)}})).content + ' | grep ' + grep`,
        ].join("\n")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          cellOnly(toolCallStep("cell", { code })),
          textStep("scoped"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...shippedPreset,
          extensionInputs: [...shippedPreset.extensionInputs, scopedAgent],
          branchTools: CellBranchTools,
          providerLayer,
          admission: { agent: AgentName.make("scoped") },
        })
        yield* client.message.send({ sessionId, branchId, content: "read the note" })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (list) =>
            list.some(
              (message) =>
                message.role === "assistant" && messagePartsText(message.parts) === "scoped",
            ),
          10_000,
          "assistant reply scoped",
        )
        const results = messages
          .flatMap((message) => message.parts)
          .filter((part): part is Prompt.ToolResultPart => part.type === "tool-result")
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
          isFailure: false,
          result: { display: "1\tscoped surface | grep unreachable" },
        })
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    18000,
  )
})

// ── child cell ──────────────────────────────────────────────────────────────

describe("child cell", () => {
  it.scopedLive(
    "a child delegated from a cell runs its own cell instead of refusing as a nested outer cell",
    () =>
      Effect.gen(function* () {
        // The parent starts the child from a cell and ends its turn; the
        // child runs its own cell. Each branch is told apart by its first
        // user text, so the two turns never race for one script.
        const childTask = "compute"
        const firstText = (prompt: Prompt.Prompt) =>
          prompt.content.flatMap((message) => {
            if (message.role !== "user") return []
            return message.content.flatMap((part) => {
              if (part.type !== "text") return []
              return [part.text]
            })
          })[0]
        const step = <A>(parts: ReadonlyArray<A>) => Effect.succeed(Stream.fromIterable(parts))
        let parentCalls = 0
        let childCalls = 0
        const providerLayer = LanguageModelLayers.testStream((options) => {
          if (firstText(options.prompt)?.endsWith(childTask) === true) {
            childCalls += 1
            if (childCalls === 1) {
              return step([
                toolCallPart("cell", { code: "1 + 1" }),
                finishPart({ finishReason: "tool-calls" }),
              ])
            }
            return step([textDeltaPart("child says 2"), finishPart({ finishReason: "stop" })])
          }
          parentCalls += 1
          if (parentCalls === 1) {
            return step([
              toolCallPart("cell", {
                code: "const h = await tools.delegate.start({ todo: 'compute' }); typeof h.requestId === 'string'",
              }),
              finishPart({ finishReason: "tool-calls" }),
            ])
          }
          // The turn that started the child ends here; "done" is the turn
          // the child's completion wakes.
          if (parentCalls === 2) {
            return step([textDeltaPart("started"), finishPart({ finishReason: "stop" })])
          }
          return step([textDeltaPart("done"), finishPart({ finishReason: "stop" })])
        })
        const fixture = defineExtension({
          id: "cell-child-foreground-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("tool", CellTool)
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("cell-child-foreground-source"),
            },
            {
              ...DelegateExtension,
              artifactIdentity: LoadedArtifactIdentity.make("delegate-source"),
            },
          ],
          branchTools: CellBranchTools,
        })
        const content = "delegate from a cell"
        yield* client.message.send({ sessionId, branchId, content })
        // The child's completion wakes the parent; the parent's reply to it
        // is the last thing to land.
        const parentMessages = yield* waitFor(
          client.message.list({ branchId }),
          (items) =>
            items.some(
              (item) => item.role === "assistant" && messagePartsText(item.parts) === "done",
            ),
          12_000,
          "the parent read the child's completion",
        )
        const startResults = parentMessages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result" && part.name === "cell")
        expect(startResults).toHaveLength(1)
        expect(startResults[0]).toMatchObject({ isFailure: false, result: { display: "true" } })
        const completion = parentMessages.find(
          (item) => item.metadata?.customType === "child-completion",
        )
        expect(completion).toBeDefined()
        expect(messagePartsText(completion?.parts ?? [])).toContain("child says 2")

        const sessions = yield* client.session.list()
        const child = sessions.find((session) => session.parentSessionId === sessionId)
        if (Predicate.isUndefined(child?.activeBranchId)) {
          return yield* Effect.die("Missing child session")
        }
        const childResults = (yield* client.message.list({ branchId: child.activeBranchId }))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result" && part.name === "cell")
        expect(childResults).toHaveLength(1)
        expect(childResults[0]).toMatchObject({ isFailure: false, result: { display: "2" } })
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    20000,
  )
})

// ── thread namespace ────────────────────────────────────────────────────────

describe("thread namespace", () => {
  it.scopedLive(
    "a handoff session starts with its predecessor's namespace; a delegate child starts empty",
    () =>
      Effect.gen(function* () {
        // Each branch runs its own script, chosen by its first user text: the
        // woken parent turn and the child turn never race for one script.
        const firstText = (prompt: Prompt.Prompt) =>
          prompt.content.flatMap((message) => {
            if (message.role !== "user") return []
            return message.content.flatMap((part) => {
              if (part.type !== "text") return []
              return [part.text]
            })
          })[0] ?? ""
        const step = <A>(parts: ReadonlyArray<A>) => Effect.succeed(Stream.fromIterable(parts))
        const cell = (code: string) =>
          step([toolCallPart("cell", { code }), finishPart({ finishReason: "tool-calls" })])
        const reply = (text: string) =>
          step([textDeltaPart(text), finishPart({ finishReason: "stop" })])
        const scripts: ReadonlyArray<
          readonly [string, ReadonlyArray<() => ReturnType<typeof reply>>]
        > = [
          [
            "scratch A",
            [
              () => cell("const notes = ['alpha']; notes.length"),
              () =>
                cell(
                  "const h = await tools.delegate.start({ todo: 'child-probe' }); typeof h.requestId",
                ),
              () => reply("A started"),
              () => reply("A woke"),
            ],
          ],
          ["child-probe", [() => cell("typeof notes"), () => reply("child done")]],
          ["scratch B", [() => cell("notes.push('beta'); notes.join(',')"), () => reply("B done")]],
          ["scratch C", [() => cell("notes.join(',')"), () => reply("C done")]],
        ]
        const calls = new Map<string, number>()
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const text = firstText(options.prompt)
          const script = scripts.find(([key]) => text.endsWith(key))
          if (Predicate.isUndefined(script)) return reply(`no script for ${text}`)
          const index = calls.get(script[0]) ?? 0
          calls.set(script[0], index + 1)
          const next = script[1][index] ?? (() => reply(`${script[0]} extra`))
          return next()
        })
        const fixture = defineExtension({
          id: "cell-thread-namespace-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("tool", CellTool)
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("cell-thread-namespace-source"),
            },
            {
              ...DelegateExtension,
              artifactIdentity: LoadedArtifactIdentity.make("delegate-source"),
            },
          ],
          branchTools: CellBranchTools,
        })
        const cellResults = (branch: BranchId) =>
          client.message
            .list({ branchId: branch })
            .pipe(
              Effect.map((messages) =>
                messages
                  .flatMap((message) => message.parts)
                  .filter(
                    (part): part is Prompt.ToolResultPart =>
                      part.type === "tool-result" && part.name === "cell",
                  ),
              ),
            )
        const replied = (branch: BranchId, text: string) =>
          waitFor(
            client.message.list({ branchId: branch }),
            (items) =>
              items.some(
                (item) => item.role === "assistant" && messagePartsText(item.parts) === text,
              ),
            12_000,
            `reply ${text}`,
          )

        yield* client.message.send({ sessionId, branchId, content: "scratch A" })
        yield* replied(branchId, "A woke")
        // A delegate child is side work: it does not join the thread, so its
        // cell starts empty.
        const child = (yield* client.session.list()).find(
          (session) => session.parentSessionId === sessionId,
        )
        if (Predicate.isUndefined(child?.activeBranchId)) {
          return yield* Effect.die("Missing child session")
        }
        const childResults = yield* cellResults(child.activeBranchId)
        expect(childResults).toMatchObject([{ isFailure: false, result: { display: "undefined" } }])
        expect(childResults[0]?.result).not.toHaveProperty("restored")

        // A handoff continues the thread: its first cell reads A's notes, and
        // the report names A as the session they came from.
        const handoff = { parentSessionId: sessionId, parentBranchId: branchId }
        const b = yield* client.session.create({ ...handoff, continueThread: true })
        yield* client.message.send({
          sessionId: b.sessionId,
          branchId: b.branchId,
          content: "scratch B",
        })
        yield* replied(b.branchId, "B done")
        const [bResult] = yield* cellResults(b.branchId)
        expect(bResult).toMatchObject({
          isFailure: false,
          result: { display: "alpha,beta", restored: { previousSession: sessionId } },
        })
        expect(bResult?.result).toHaveProperty(
          "restored.restored",
          expect.arrayContaining(["notes"]),
        )

        // B's write went to its own namespace: a second handoff from A still
        // reads A's saved notes.
        const c = yield* client.session.create({ ...handoff, continueThread: true })
        yield* client.message.send({
          sessionId: c.sessionId,
          branchId: c.branchId,
          content: "scratch C",
        })
        yield* replied(c.branchId, "C done")
        expect(yield* cellResults(c.branchId)).toMatchObject([
          { isFailure: false, result: { display: "alpha" } },
        ])
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(platformLayer)),
    30000,
  )
})

// ── branch cell lifetime ────────────────────────────────────────────────────

it.scopedLive("rejects cell dispatch without a branch owner", () =>
  Effect.gen(function* () {
    const error = yield* dispatchCell().pipe(Effect.flip)
    expect(error).toMatchObject({
      _tag: "AgentLoopError",
      message: "Cell execution requires a branch-owned runtime",
    })
  }).pipe(
    Effect.provide(
      createE2ELayer({
        agents: [],
        extensionInputs: [],
        branchTools: CellBranchTools,
        extensions: [],
        providerLayer: LanguageModelLayers.debug(),
      }),
    ),
  ),
)

describe("branch cell lifetime", () => {
  it.scopedLive(
    "controls children across kernel reset and reads a completed child reply",
    () =>
      Effect.gen(function* () {
        const handle = yield* Ref.make(Option.none<typeof ChildAgentHandle.Type>())
        // A turn is either sent by the test or started by a child-completion message.
        const turns: ReadonlyArray<{
          readonly send: boolean
          readonly code: string
          readonly reset?: boolean
        }> = [
          {
            send: true,
            code: "const child = await tools.delegate.start({todo: 'Wait for cancellation'}); await tools['child-handle']({_tag: 'save', handle: child}); await tools['model-started']({call: 1}); true",
          },
          {
            send: true,
            code: "(await tools.delegate.list({})).find((kid) => kid.requestId === child.requestId).completed === false",
          },
          {
            send: true,
            reset: true,
            code: "const saved = await tools['child-handle']({_tag: 'get'}); typeof child === 'undefined' && (await tools.delegate.list({})).find((kid) => kid.requestId === saved.requestId).completed === false",
          },
          {
            send: true,
            code: "const id = (await tools['child-handle']({_tag: 'get'})).requestId; await tools.delegate.cancel({requestId: id}); true",
          },
          // The cancelled child's completion arrives as a message; no cell ever waited for it.
          {
            send: false,
            code: "const cancelled = await tools['child-handle']({_tag: 'get'}); (await tools.delegate.list({})).find((kid) => kid.requestId === cancelled.requestId).interrupted === true",
          },
          {
            send: true,
            code: "const finished = await tools.delegate.start({todo: 'Return the result', overrides: {modelId: 'custom/model', reasoningEffort: 'high', allowedTools: ['read_session'], deniedTools: ['delegate.start'], systemPromptAddendum: 'Report the verified result'}}); await tools['child-handle']({_tag: 'save', handle: finished}); await tools['model-started']({call: 12}); true",
          },
          {
            send: false,
            code: "const h = await tools['child-handle']({_tag: 'get'}); const reply = await tools.read_session({sessionId: h.sessionId, branchId: h.branchId}); const kids = await tools.delegate.list({}); kids.length === 2 && kids.every((kid) => kid.completed) && reply.messageCount > 0 && reply.content.includes('verified child result')",
          },
        ]
        const steps = turns.flatMap<SequenceStep>((turn, index) => [
          {
            ...toolCallStep("cell", { code: turn.code, reset: turn.reset === true }),
            assertOptions: (options) => {
              expect(options.tools.map((tool) => tool.name)).toEqual(["cell"])
            },
          },
          textStep(`done-${index}`),
        ])
        steps.splice(1, 0, { ...textStep("child reply"), gated: true })
        steps.splice(12, 0, {
          ...textStep("verified child result"),
          assertRequest: (request) => {
            expect(request.model).toBe("custom/model")
            expect(request.reasoning).toBe("high")
          },
          assertOptions: (options) => {
            // The allow list scopes the host tools inside the child's cell; the cell
            // stays the surface and the denied tool leaves the catalog.
            expect(options.tools.map((tool) => tool.name)).toEqual(["cell"])
            const system = options.prompt.content
              .filter((message) => message.role === "system")
              .map((message) => message.content)
              .join("\n")
            expect(system).toContain("Report the verified result")
            expect(system).toContain("- tools.read_session(input: { sessionId: string")
            expect(system).not.toContain("- tools.delegate.start(")
          },
        })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence(steps)
        const fixture = defineExtension({
          id: "cell-child-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "agent",
              new AgentDefinition({ name: DEFAULT_AGENT_NAME }),
              new AgentDefinition({ name: AgentName.make("child") }),
            )
            yield* host.register(
              "tool",
              ReadSessionTool,
              tool({
                id: "model-started",
                description: "Wait for the model boundary",
                params: Schema.Struct({ call: Schema.Int }),
                output: Schema.Boolean,
                execute: (input) => controls.waitForCall(input.call).pipe(Effect.as(true)),
              }),
              tool({
                id: "child-handle",
                description: "Save or read the test child handle outside the kernel",
                params: Schema.TaggedUnion({ save: { handle: ChildAgentHandle }, get: {} }),
                output: ChildAgentHandle,
                execute: Effect.fn("test.childHandle")(function* (input) {
                  if (input._tag === "save") yield* Ref.set(handle, Option.some(input.handle))
                  return yield* Effect.fromOption(yield* Ref.get(handle))
                }),
              }),
            )
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            { ...CellExtension, artifactIdentity: LoadedArtifactIdentity.make("cell-source") },
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("cell-child-fixture-source"),
            },
            {
              ...DelegateExtension,
              artifactIdentity: LoadedArtifactIdentity.make("delegate-source"),
            },
          ],
          branchTools: CellBranchTools,
        })
        let completions = 0
        for (const [index, turn] of turns.entries()) {
          const content = `cell-child-${index}`
          const isCompletion = (item: { metadata?: { customType?: string } }) =>
            item.metadata?.customType === "child-completion"
          if (turn.send) yield* client.message.send({ sessionId, branchId, content })
          else completions += 1
          const messages = yield* waitFor(client.message.list({ branchId }), (items) => {
            if (turn.send)
              return items.some(
                (item) => item.role === "user" && messagePartsText(item.parts) === content,
              )
            return items.filter(isCompletion).length >= completions
          })
          let user = messages.find(
            (item) => item.role === "user" && messagePartsText(item.parts) === content,
          )
          if (!turn.send) user = messages.filter(isCompletion).at(completions - 1)
          if (Predicate.isUndefined(user)) return yield* Effect.die("Missing parent message")
          yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              (envelope) =>
                envelope.event._tag === "TurnCompleted" && envelope.event.messageId === user.id,
            ),
            Stream.take(1),
            Stream.runDrain,
          )
          const completed = yield* client.message.list({ branchId })
          const results = completed
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool-result" && part.name === "cell")
          expect(results.at(-1)).toMatchObject({ isFailure: false, result: { display: "true" } })
        }
        const parentMessages = yield* client.message.list({ branchId })
        const notices = parentMessages.filter(
          (item) => item.metadata?.customType === "child-completion",
        )
        expect(notices).toHaveLength(2)
        expect(messagePartsText(notices[0]?.parts ?? [])).toContain("interrupted")
        expect(messagePartsText(notices[1]?.parts ?? [])).toContain("verified child result")
        const saved = yield* Effect.fromOption(yield* Ref.get(handle))
        const childMessages = yield* client.message.list({ branchId: saved.branchId })
        expect(childMessages.filter((message) => message.role === "user")).toHaveLength(1)
        expect(yield* controls.callCount).toBe(16)
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    20000,
  )

  it.scopedLive(
    "retains cells across RPC turns, isolates branches, and closes their workers",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const pids = yield* Ref.make<ReadonlyArray<number>>([])
        const hiddenCalls = yield* Ref.make(0)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sources = [
              "const names = Object.keys(tools); if (names.includes('hidden') || names.includes('cell') || !names.includes('worker')) throw new Error('Wrong catalog'); const spec = tools('worker'); if (spec.parameters.type !== 'number' || !spec.guidelines.includes('Supply the current worker PID')) throw new Error('Wrong tool description'); let kept = 21; await tools.worker(process.pid); kept",
              "if (tools('worker').parameters.type !== 'number') throw new Error('Catalog was not retained'); kept += 1",
              "await tools.worker(process.pid); typeof kept",
              "let rejected = false; try { await tools.cell({code: 'kept = 0'}) } catch (error) { rejected = error.message.includes('tools.cell is not a host tool selected for this turn') }; let hiddenRejected = false; try { await tools.hidden({}) } catch { hiddenRejected = true }; rejected && hiddenRejected && kept === 23",
              "typeof kept",
              "await tools.worker(process.pid); while (true) {}",
            ]
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence(
              sources.flatMap((code, index) => {
                let call = toolCallStep("cell", { code, reset: index === 4 })
                if (index === 1)
                  call = multiToolCallStep(
                    { toolName: "cell", input: { code } },
                    { toolName: "cell", input: { code } },
                  )
                const steps = [call]
                if (index !== 5) steps.push(textStep(`done-${index}`))
                return steps
              }),
            )
            const extensions: ReadonlyArray<LoadedExtension> = [
              {
                manifest: { id: ExtensionId.make("cell-lifetime") },
                scope: "builtin",
                sourcePath: "cell-lifetime",
                artifactIdentity: LoadedArtifactIdentity.make("cell-lifetime-source"),
                contributions: {
                  tools: [
                    tool({
                      id: "hidden",
                      description: "Registered but denied by agent policy",
                      params: Schema.Struct({}),
                      output: Schema.Finite,
                      execute: () => Ref.updateAndGet(hiddenCalls, (count) => count + 1),
                    }),
                    tool({
                      id: "worker",
                      description: "Record worker identity",
                      promptGuidelines: ["Supply the current worker PID"],
                      params: Schema.Finite,
                      output: Schema.Boolean,
                      execute: (pid) =>
                        Ref.update(pids, (values) => [...values, pid]).pipe(Effect.as(true)),
                    }),
                    CellTool,
                  ],
                },
              },
            ]
            const { client, sessionId, branchId } = yield* createRpcHarness({
              extensions,
              providerLayer,
              extensionInputs: [],
              branchTools: CellBranchTools,
              agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME, deniedTools: ["hidden"] })],
            })
            expect(yield* Ref.get(pids)).toEqual([])
            const second = yield* client.branch.create({ sessionId })
            const branches = [branchId, branchId, second.branchId, branchId, branchId, branchId]
            const expected = ["21", "23", "undefined", "true", "undefined"]
            for (const [index, targetBranch] of branches.entries()) {
              const content = `run-${index}`
              yield* client.message.send({ sessionId, branchId: targetBranch, content })
              const messages = yield* waitFor(
                client.message.list({ branchId: targetBranch }),
                (messages) =>
                  messages.some(
                    (message) =>
                      message.role === "user" && messagePartsText(message.parts) === content,
                  ),
              )
              const user = messages.find(
                (message) => message.role === "user" && messagePartsText(message.parts) === content,
              )
              if (Predicate.isUndefined(user)) return yield* Effect.die("Missing submitted message")
              if (index === 5) {
                const workers = yield* waitFor(Ref.get(pids), (values) => values.length === 3)
                const pid = workers[2]
                if (Predicate.isUndefined(pid)) return yield* Effect.die("Missing active worker")
                yield* client.steer.command({
                  command: SteerCommand.make({
                    _tag: "Cancel",
                    sessionId,
                    branchId: targetBranch,
                    requestId: RequestId.make(yield* platform.randomId),
                  }),
                })
                const stopped = yield* waitFor(
                  platform.signal(pid, 0).pipe(Effect.exit),
                  Exit.isFailure,
                  2000,
                  "cancelled worker exit",
                )
                expect(Exit.isFailure(stopped)).toBe(true)
              }
              yield* client.session.events({ sessionId, branchId: targetBranch }).pipe(
                Stream.filter(
                  (envelope) =>
                    envelope.event._tag === "TurnCompleted" && envelope.event.messageId === user.id,
                ),
                Stream.take(1),
                Stream.runDrain,
              )
              const completed = yield* client.message.list({ branchId: targetBranch })
              const results = completed
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool-result")
                .filter((part) => part.name === "cell")
              if (index === 1) {
                const repeated = results.slice(-2)
                expect(new Set(repeated.map((part) => part.id)).size).toBe(2)
                expect(repeated).toMatchObject([
                  { isFailure: false, result: { display: "22" } },
                  { isFailure: false, result: { display: "23" } },
                ])
              }
              if (index === 5)
                expect(results.at(-1)).toMatchObject({
                  isFailure: true,
                  result: { _tag: "CellKernelError", reason: "cancelled", stateLost: true },
                })
              else
                expect(results.at(-1)).toMatchObject({
                  isFailure: false,
                  result: { display: expected[index] },
                })
            }
            expect(new Set(yield* Ref.get(pids)).size).toBe(2)
            expect(yield* Ref.get(hiddenCalls)).toBe(0)
          }),
        )
        for (const pid of yield* Ref.get(pids)) {
          expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        }
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    18000,
  )
})

// ── cell recovery ───────────────────────────────────────────────────────────

/**
 * The delegate registry is one JSON array per parent branch under
 * `<home>/.gent/delegates`. Seeding it is how a test admits a durable child
 * the way a crashed process would have left one behind.
 */
const encodeRegistry = Schema.encodeSync(Schema.fromJsonString(Schema.Array(DelegateEntry)))

const seedDelegateRegistry = Effect.fn("test.seedDelegateRegistry")(function* (
  branchId: BranchId,
  entries: ReadonlyArray<DelegateEntry>,
) {
  const fs = yield* FileSystem.FileSystem
  const directory = `${(yield* RuntimeEnvironment).home}/.gent/delegates`
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* fs.writeFileString(`${directory}/${branchId}.json`, encodeRegistry(entries))
})

/**
 * The leaf view `delegate.cancel` sees when the parent branch runs it. The real
 * host context carries the session facade the tool steers through, so the
 * cancellation reaches the child's loop exactly as it does in production.
 */
const delegateToolContext = Effect.fn("test.delegateToolContext")(function* (parent: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}) {
  // Outside a loop the facade has no session control, so the cancellation the
  // tool steers would die. The runtime is the same door the loop opens.
  return {
    ...(yield* runtimeHostContext({ ...parent, sessionCwd: "/tmp" })),
    extensionId: ExtensionId.make("cell-recovery"),
    toolCallId: ToolCallId.make("delegate-cancel-call"),
  }
})

/**
 * Starts the recovered child and cancels it once it holds a request at the
 * model. The first `delegate.list` is what starts it: its reconcile re-sends
 * the start the lost worker never sent, and admission returns before the
 * child's turn reaches the model. A cancel sent at once can stop that turn
 * first, and the parent's next turn then takes the model reply scripted for
 * the child. `childAtModel` ends that race.
 */
const cancelRecoveredChild = Effect.fn("test.cancelRecoveredChild")(function* (
  outer: Option.Option<Message["parts"][number]>,
  parent: { readonly sessionId: SessionId; readonly branchId: BranchId },
  childAtModel: Effect.Effect<void>,
) {
  if (Option.isNone(outer) || outer.value.type !== "tool-result")
    return yield* Effect.die("Missing recovered cell result")
  const recovered = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      operations: Schema.Array(
        Schema.Struct({
          tool: Schema.Literal("delegate.start"),
          outcome: Schema.Literal("incomplete"),
          toolCallId: ToolCallId,
        }),
      ),
    }),
  )(outer.value.result)
  const operation = recovered.operations[0]
  if (Predicate.isUndefined(operation)) return yield* Effect.die("Missing unknown child operation")
  const requestId = RequestId.make(operation.toolCallId)
  const ctx = yield* delegateToolContext(parent)
  const observe = runToolWithCtx(ListChildren, {}, ctx).pipe(
    Effect.map((children) => children.find((child) => child.requestId === requestId)),
  )
  expect((yield* observe)?.completed).toBe(false)
  yield* childAtModel
  yield* runToolWithCtx(CancelChild, { requestId }, ctx)
  const cancelled = yield* waitFor(
    observe,
    (observed) => observed?.completed === true,
    2000,
    "cancelled child completion",
  )
  expect(cancelled?.interrupted).toBe(true)
})

it.scopedLive(
  "recovers saved cells through RPC, and reports a call cut short as interrupted instead of running it again",
  () =>
    Effect.gen(function* () {
      for (const state of [
        "unadmitted",
        "revoked",
        "incomplete",
        "completed",
        "waiting",
        "unknown-child",
      ]) {
        const deniedTools: string[] = []
        if (state === "revoked") deniedTools.push("cell")
        const nativeCalls = yield* Ref.make(0)
        const cellCalls = yield* Ref.make(0)
        const approvalCalls = yield* Ref.make(0)
        const selectedNames = yield* Ref.make<ReadonlyArray<string>>([])
        const extensions: ReadonlyArray<LoadedExtension> = [
          {
            manifest: { id: ExtensionId.make("cell-recovery") },
            scope: "builtin",
            sourcePath: "cell-recovery",
            artifactIdentity: LoadedArtifactIdentity.make("cell-recovery-source"),
            contributions: {
              tools: [
                StartChild,
                CancelChild,
                tool({
                  id: "approve",
                  description: "Approve inner operation",
                  params: Schema.Struct({}),
                  output: Schema.Boolean,
                  execute: () =>
                    Effect.gen(function* () {
                      yield* Ref.update(approvalCalls, (n) => n + 1)
                      return (yield* (yield* ExtensionContext).Interaction.approve({
                        text: "Continue inner operation?",
                      })).approved
                    }),
                }),
                tool({
                  id: "cell",
                  description: "Must not replay",
                  // Stands in for the real cell, so it must declare the same
                  // property the loop keys recovery off.
                  dispatches: true,
                  params: Schema.Struct({ code: Schema.String }),
                  output: Schema.Finite,
                  execute: () =>
                    Effect.gen(function* () {
                      const call = yield* CurrentToolCall
                      yield* Ref.set(selectedNames, [...call.toolBindings.keys()].sort())
                      return yield* Ref.updateAndGet(cellCalls, (n) => n + 1)
                    }),
                }),
                tool({
                  id: "sibling",
                  description: "Native sibling",
                  params: Schema.Struct({}),
                  output: Schema.Finite,
                  execute: () => Ref.updateAndGet(nativeCalls, (n) => n + 1),
                }),
              ],
            },
          },
        ]
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("Recovered"),
          // The orphaned child's own turn, once `delegate.list` restarts it
          // after the recovery turn. It is gated and never released, so the
          // child is still at the model when the parent cancels it.
          { ...textStep("child"), gated: true },
          // The parent reads the cancelled child's completion message.
          textStep("Child cancelled"),
        ])
        // Keep the real server context to seed the crash gap before actor startup.
        const context = yield* Layer.build(
          createE2ELayer({
            extensions,
            providerLayer,
            agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME, deniedTools })],
            extensionInputs: [],
            branchTools: CellBranchTools,
            durableApproval: true,
          }),
        )
        const { client } = yield* createRpcClient(Layer.succeedContext(context))
        const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
        const workspaceId = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{
            readonly workspace_id: string
          }>`SELECT workspace_id FROM sessions WHERE id = ${sessionId}`
          return yield* Schema.decodeUnknownEffect(WorkspaceId)(rows[0]?.workspace_id)
        }).pipe(Effect.provideContext(context))
        const messageId = MessageId.make("cell-recovery-user")
        const assistantMessageId = assistantMessageIdForTurn(messageId, 1)
        const cell = {
          sessionId,
          branchId,
          assistantMessageId,
          toolCallId: ToolCallId.make("outer-cell"),
        }
        const savedResult = Prompt.toolResultPart({
          id: cell.toolCallId,
          name: "cell",
          result: { display: "Saved" },
          isFailure: false,
          providerExecuted: false,
        })
        yield* Effect.gen(function* () {
          const messages = yield* MessageStorage
          const user = Message.cases.regular.make({
            id: messageId,
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: "Continue" })],
            createdAt: dateFromMillis(0),
          })
          yield* messages.createMessage(user)
          yield* messages.createMessage(
            Message.cases.regular.make({
              id: assistantMessageId,
              sessionId,
              branchId,
              role: "assistant",
              createdAt: dateFromMillis(1),
              parts: [
                Prompt.toolCallPart({
                  id: cell.toolCallId,
                  name: "cell",
                  params: { code: "sideEffect()" },
                  providerExecuted: false,
                }),
                Prompt.toolCallPart({
                  id: "native-sibling",
                  name: "sibling",
                  params: {},
                  providerExecuted: false,
                }),
              ],
            }),
          )
          const cells = (yield* CellStorage).executions
          if (state !== "unadmitted" && state !== "revoked") yield* cells.claim(cell)
          if (state === "completed") yield* cells.complete(cell, savedResult)
          const turn = yield* captureTurnTools(cell)
          const bindingOf = (name: string) => Option.fromUndefinedOr(turn.toolBindings.get(name))
          if (state === "unknown-child") {
            const selected = bindingOf("delegate.start")
            const identity = Option.flatMap(selected, (entry) =>
              Option.fromUndefinedOr(entry.binding),
            )
            if (Option.isNone(identity)) return yield* Effect.die("Missing child start binding")
            const prompt = "Admitted before the worker was lost"
            const admitted = yield* (yield* CellStorage).operations.admit({
              cell,
              operationId: "unknown-child-start",
              binding: identity.value,
              input: { agent: DEFAULT_AGENT_NAME, prompt },
            })
            const toolCallId = admitted.operation.toolCallId
            const child = yield* client.session.create({
              cwd: "/tmp",
              parentSessionId: sessionId,
              parentBranchId: branchId,
            })
            yield* seedDelegateRegistry(branchId, [
              {
                requestId: RequestId.make(toolCallId),
                sessionId: child.sessionId,
                branchId: child.branchId,
                agentName: DEFAULT_AGENT_NAME,
                prompt,
                toolCallId,
                private: false,
                submitted: false,
                delivered: false,
              },
            ])
          }
          if (state === "unadmitted" || state === "revoked") {
            const captured = bindingOf("cell")
            const identity = Option.flatMap(captured, (entry) =>
              Option.fromUndefinedOr(entry.binding),
            )
            if (Option.isNone(identity)) return yield* Effect.die("Missing outer cell binding")
            yield* plantToolCallBinding({ ...cell, binding: identity.value })
          }
          if (state === "waiting") {
            const selected = bindingOf("approve")
            if (Option.isNone(selected)) return yield* Effect.die("Missing approval binding")
            const suspendedHost = yield* makeCellToolHost({
              cell,
              ledger: yield* ModelContextLedger.make,
              toolBindings: new Map([["approve", selected.value]]),
              profile: turn.profile,
            })
            yield* askThenLoseWorker(
              suspendedHost,
              CellResponse.cases.HostCall.make({
                cellId: "1",
                operationId: "1",
                name: "approve",
                input: {},
              }),
              cell,
            )
          }
          const binding = bindingOf("sibling")
          const identity = Option.flatMap(binding, (entry) => Option.fromUndefinedOr(entry.binding))
          if (Option.isNone(identity)) return yield* Effect.die("Missing sibling binding")
          yield* plantToolCallBinding({
            sessionId,
            branchId,
            assistantMessageId,
            toolCallId: ToolCallId.make("native-sibling"),
            binding: identity.value,
          })
          yield* plantInFlightTurn({ sessionId, branchId, message: user })
        }).pipe(
          Effect.provideContext(context),
          Effect.provideService(CurrentWorkspaceId, workspaceId),
        )
        const finished = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.session.getSnapshot({ sessionId, branchId })
        if (state === "waiting") {
          yield* client.session.watchRuntime({ sessionId, branchId }).pipe(
            Stream.filter((runtime) => runtime._tag === "WaitingForInteraction"),
            Stream.take(1),
            Stream.runDrain,
          )
          expect(yield* Ref.get(approvalCalls)).toBe(1)
          expect(yield* Ref.get(nativeCalls)).toBe(0)
          const pending = yield* Effect.gen(function* () {
            return yield* (yield* InteractionStorage).listOpen({ sessionId, branchId })
          }).pipe(
            Effect.provideContext(context),
            Effect.provideService(CurrentWorkspaceId, workspaceId),
          )
          const request = pending[0]
          if (Predicate.isUndefined(request)) return yield* Effect.die("Missing approval")
          yield* client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: request.requestId,
            approved: true,
          })
        }
        yield* Fiber.join(finished)
        const messages = yield* client.message.list({ branchId })
        expect(
          messages.some(
            (message) =>
              message.role === "assistant" && messagePartsText(message.parts) === "Recovered",
          ),
        ).toBe(true)
        const results = messages.find(
          (message) => message.id === toolResultMessageIdForTurn(messageId, 1),
        )?.parts
        expect(results).toHaveLength(2)
        const outer = results?.find(
          (part) => part.type === "tool-result" && part.id === cell.toolCallId,
        )
        if (state === "unknown-child") {
          yield* cancelRecoveredChild(
            Option.fromUndefinedOr(outer),
            { sessionId, branchId },
            controls.waitForCall(1),
          ).pipe(
            Effect.provideContext(context),
            Effect.provideService(CurrentWorkspaceId, workspaceId),
          )
          // The cancelled child reports back, so the parent reads it in one
          // more turn. Three model calls in all: the recovery turn, the
          // child's gated turn, and the parent reading the completion. The
          // recovered cell itself never replayed — that is the two results
          // asserted above, not a fourth call.
          const settled = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some(
                (message) => message.metadata?.customType === "child-completion",
              ),
            5000,
            "the cancelled child reported to the parent",
          )
          expect(
            settled.messages.filter(
              (message) => message.metadata?.customType === "child-completion",
            ),
          ).toHaveLength(1)
          expect(yield* controls.callCount).toBe(3)
        }
        // A cell with no receipt was in flight too: it is not run again.
        if (state === "completed") expect(outer).toEqual(savedResult)
        else if (state === "unadmitted" || state === "revoked")
          expect(outer).toMatchObject({ isFailure: true, result: { reason: "Interrupted" } })
        else
          expect(outer).toMatchObject({
            isFailure: true,
            result: { stateLost: true },
          })
        if (state === "waiting") {
          expect(yield* Ref.get(approvalCalls)).toBe(2)
          expect(outer).toMatchObject({
            result: {
              operations: [{ tool: "approve", outcome: "succeeded", summary: "true" }],
            },
          })
        }
        // The native sibling was in flight when the process died: the model
        // reads that it was interrupted, and it does not run again.
        expect(
          results?.find((part) => part.type === "tool-result" && part.id === "native-sibling"),
        ).toMatchObject({ isFailure: true, result: { reason: "Interrupted" } })
        expect(yield* Ref.get(cellCalls)).toBe(0)
        expect(yield* Ref.get(nativeCalls)).toBe(0)
      }
    }).pipe(Effect.timeout("12 seconds")),
  15000,
)

// ── cell execution storage ──────────────────────────────────────────────────

const code = "await tools.write({ path: 'result.txt', content: 'once' })"
const makeFixture = Effect.fn("test.makeCellCall")(function* (suffix: string) {
  const sessions = yield* SessionStorage
  const branches = yield* BranchStorage
  const messages = yield* MessageStorage
  const address = {
    sessionId: SessionId.make(`cell-session-${suffix}`),
    branchId: BranchId.make(`cell-branch-${suffix}`),
    assistantMessageId: MessageId.make(`cell-message-${suffix}`),
    toolCallId: ToolCallId.make(`cell-call-${suffix}`),
  }
  yield* sessions.createSession(
    new Session({ id: address.sessionId, createdAt: now, updatedAt: now }),
  )
  yield* branches.createBranch(
    new Branch({ id: address.branchId, sessionId: address.sessionId, createdAt: now }),
  )
  yield* messages.createMessage(
    Message.cases.regular.make({
      id: address.assistantMessageId,
      sessionId: address.sessionId,
      branchId: address.branchId,
      role: "assistant",
      parts: [
        Prompt.toolCallPart({
          id: address.toolCallId,
          name: "cell",
          params: { code },
          providerExecuted: false,
        }),
      ],
      createdAt: now,
    }),
  )
  return address
})

it.live("admits a cell once under concurrent claims and retains its first result", () =>
  Effect.gen(function* () {
    const address = yield* makeFixture("concurrent")
    const storage = (yield* CellStorage).executions
    expect(yield* storage.get(address)).toEqual(Option.none())
    const claims = yield* Effect.all(
      Array.from({ length: 8 }, () => storage.claim(address)),
      { concurrency: 8 },
    )
    expect(claims.filter((claim) => claim._tag === "Claimed")).toEqual([{ _tag: "Claimed", code }])
    expect(claims.filter((claim) => claim._tag === "Incomplete")).toHaveLength(7)
    expect(yield* storage.get(address)).toEqual(Option.some({ _tag: "Incomplete" }))
    const result = Prompt.toolResultPart({
      id: address.toolCallId,
      name: "cell",
      result: { display: "done" },
      isFailure: false,
      providerExecuted: false,
    })
    yield* storage.complete(address, result)
    expect(yield* storage.get(address)).toEqual(Option.some({ _tag: "Completed", result }))
    yield* storage.complete(address, result)
    expect(yield* storage.claim(address)).toEqual({ _tag: "Completed", result })
    const conflict = yield* storage
      .complete(address, Prompt.toolResultPart({ ...result, result: "different" }))
      .pipe(Effect.flip)
    expect(conflict.message).toBe("Cell result is immutable")
    expect(yield* storage.claim(address)).toEqual({ _tag: "Completed", result })
  }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.live("denies cross-workspace and cross-branch claims and completions", () =>
  Effect.gen(function* () {
    const address = yield* makeFixture("ownership")
    const storage = (yield* CellStorage).executions
    const result = Prompt.toolResultPart({
      id: address.toolCallId,
      name: "cell",
      result: "done",
      isFailure: false,
      providerExecuted: false,
    })
    const otherWorkspace = WorkspaceId.make("a".repeat(64))
    expect(
      Schema.is(StorageError)(
        yield* storage
          .get(address)
          .pipe(Effect.provideService(CurrentWorkspaceId, otherWorkspace), Effect.flip),
      ),
    ).toBe(true)
    const hiddenClaim = yield* storage
      .claim(address)
      .pipe(Effect.provideService(CurrentWorkspaceId, otherWorkspace), Effect.flip)
    expect(Schema.is(StorageError)(hiddenClaim)).toBe(true)
    expect((yield* storage.claim(address))._tag).toBe("Claimed")
    const hiddenComplete = yield* storage
      .complete(address, result)
      .pipe(Effect.provideService(CurrentWorkspaceId, otherWorkspace), Effect.flip)
    expect(Schema.is(StorageError)(hiddenComplete)).toBe(true)
    for (const wrongAddress of [
      { ...address, branchId: BranchId.make("other-branch") },
      { ...address, sessionId: SessionId.make("other-session") },
      { ...address, toolCallId: ToolCallId.make("missing-call") },
    ]) {
      expect(Schema.is(StorageError)(yield* storage.get(wrongAddress).pipe(Effect.flip))).toBe(true)
      expect(Schema.is(StorageError)(yield* storage.claim(wrongAddress).pipe(Effect.flip))).toBe(
        true,
      )
      expect(
        Schema.is(StorageError)(yield* storage.complete(wrongAddress, result).pipe(Effect.flip)),
      ).toBe(true)
    }
    expect((yield* storage.claim(address))._tag).toBe("Incomplete")
  }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.live("rejects unclaimed and mismatched results and removes receipts with the message", () =>
  Effect.gen(function* () {
    const address = yield* makeFixture("integrity")
    const storage = (yield* CellStorage).executions
    const sql = yield* SqlClient.SqlClient
    const result = Prompt.toolResultPart({
      id: address.toolCallId,
      name: "cell",
      result: "failure",
      isFailure: true,
      providerExecuted: false,
    })
    expect(
      Schema.is(StorageError)(yield* storage.complete(address, result).pipe(Effect.flip)),
    ).toBe(true)
    yield* storage.claim(address)
    expect(
      Schema.is(StorageError)(
        yield* storage
          .complete(address, Prompt.toolResultPart({ ...result, name: "other" }))
          .pipe(Effect.flip),
      ),
    ).toBe(true)
    yield* storage.complete(address, result)
    expect(yield* storage.claim(address)).toEqual({ _tag: "Completed", result })
    yield* sql`UPDATE cell_executions SET result_json = ${"not-json"} WHERE assistant_message_id = ${address.assistantMessageId}`
    expect(Schema.is(StorageError)(yield* storage.claim(address).pipe(Effect.flip))).toBe(true)
    yield* sql`DELETE FROM messages WHERE id = ${address.assistantMessageId}`
    const rows = yield* sql<{
      readonly count: number
    }>`SELECT COUNT(*) AS count FROM cell_executions`
    expect(rows[0]?.count).toBe(0)
  }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.live("rejects admission inside a caller transaction before granting execution", () =>
  Effect.gen(function* () {
    const address = yield* makeFixture("transaction")
    const storage = (yield* CellStorage).executions
    const sql = yield* SqlClient.SqlClient
    const rejected = yield* storage.claim(address).pipe(sql.withTransaction, Effect.flip)
    expect(Schema.is(StorageError)(rejected)).toBe(true)
    expect(yield* storage.claim(address)).toEqual({ _tag: "Claimed", code })
  }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.scopedLive(
  "keeps incomplete claims and saved failures after closing and reopening the database",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const storageLayer = SqliteStorage.LiveWithSql(
        path.join(dir, "gent.db"),
        CellBranchTools.storage,
        CellBranchTools.migrations,
      ).pipe(Layer.provide(GentPlatform.Test()))
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(storageLayer)
          return yield* Effect.gen(function* () {
            const storage = (yield* CellStorage).executions
            const interrupted = yield* makeFixture("interrupted")
            const completed = yield* makeFixture("completed")
            yield* storage.claim(interrupted)
            yield* storage.claim(completed)
            const result = Prompt.toolResultPart({
              id: completed.toolCallId,
              name: "cell",
              result: "execution failed",
              isFailure: true,
              providerExecuted: false,
            })
            yield* storage.complete(completed, result)
            return { interrupted, completed, result }
          }).pipe(Effect.provideContext(context))
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(storageLayer)
          return yield* Effect.gen(function* () {
            const storage = (yield* CellStorage).executions
            expect(yield* storage.claim(first.interrupted)).toEqual({ _tag: "Incomplete" })
            expect(yield* storage.claim(first.completed)).toEqual({
              _tag: "Completed",
              result: first.result,
            })
          }).pipe(Effect.provideContext(context))
        }),
      )
    }).pipe(Effect.provide(BunServices.layer)),
)

// ── cell tool operation storage ─────────────────────────────────────────────

const cellOperationStorage = {
  sessionId: SessionId.make("cell-operation-session"),
  branchId: BranchId.make("cell-operation-branch"),
  assistantMessageId: MessageId.make("cell-operation-message"),
  toolCallId: ToolCallId.make("cell-outer-call"),
}
const key = { cell: cellOperationStorage, operationId: "1" }
const bindingFields = {
  toolId: "write",
  extensionId: "files",
  sourceRevision: "source-1",
  schemaRevision: "schema-1",
}
const binding = staticToolBinding(bindingFields)
const params = { ...key, binding, input: { path: "file.txt", content: "once" } }
const requestId = InteractionRequestId.make("cell-request")
const fixture = Effect.gen(function* () {
  yield* ensureStorageParents(cellOperationStorage)
  const messages = yield* MessageStorage
  yield* messages.createMessage(
    Message.cases.regular.make({
      id: cellOperationStorage.assistantMessageId,
      sessionId: cellOperationStorage.sessionId,
      branchId: cellOperationStorage.branchId,
      role: "assistant",
      createdAt: dateFromMillis(1_767_225_600_000),
      parts: [
        Prompt.toolCallPart({
          id: cellOperationStorage.toolCallId,
          name: "cell",
          params: { code: "await tools.write({})" },
          providerExecuted: false,
        }),
      ],
    }),
  )
})
const requestOperationStorage = InteractionRequestRecord.make({
  requestId,
  sessionId: cellOperationStorage.sessionId,
  branchId: cellOperationStorage.branchId,
  paramsJson: '{"text":"Allow write?"}',
  status: "pending",
  createdAt: 1_767_225_600_000,
})

it.live("admits an operation once and preserves its original input, binding, and result", () =>
  Effect.gen(function* () {
    yield* fixture
    const outer = (yield* CellStorage).executions
    const storage = (yield* CellStorage).operations
    expect(Schema.is(StorageError)(yield* storage.admit(params).pipe(Effect.flip))).toBe(true)
    yield* outer.claim(cellOperationStorage)
    const claims = yield* Effect.all(
      Array.from({ length: 8 }, () => storage.admit(params)),
      { concurrency: 8 },
    )
    expect(claims.filter((claim) => claim.admitted)).toHaveLength(1)
    const operation = yield* storage.get(key)
    expect(operation.input).toEqual(params.input)
    expect(operation.binding).toEqual(binding)
    expect(operation.state._tag).toBe("Started")
    expect(
      (yield* storage.admit({ ...params, input: { content: "once", path: "file.txt" } })).admitted,
    ).toBe(false)
    expect(
      Schema.is(StorageError)(
        yield* storage.admit({ ...params, input: { content: "different" } }).pipe(Effect.flip),
      ),
    ).toBe(true)
    expect(
      Schema.is(StorageError)(
        yield* storage
          .admit({
            ...params,
            binding: staticToolBinding({ ...bindingFields, schemaRevision: "schema-2" }),
          })
          .pipe(Effect.flip),
      ),
    ).toBe(true)
    const result = Prompt.toolResultPart({
      id: operation.toolCallId,
      name: "write",
      result: "written",
      isFailure: false,
      providerExecuted: false,
    })
    expect(
      Schema.is(StorageError)(
        yield* storage
          .complete(key, Prompt.toolResultPart({ ...result, name: "other" }))
          .pipe(Effect.flip),
      ),
    ).toBe(true)
    yield* storage.complete(key, result)
    yield* storage.complete(key, result)
    expect((yield* storage.get(key)).state).toEqual({ _tag: "Completed", result })
    expect((yield* storage.admit(params)).admitted).toBe(false)
    expect(
      Schema.is(StorageError)(
        yield* storage
          .complete(key, Prompt.toolResultPart({ ...result, result: "changed" }))
          .pipe(Effect.flip),
      ),
    ).toBe(true)
  }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.scopedLive(
  "publishes cell approval only after durable ownership and takes its exact decision in place",
  () =>
    Effect.gen(function* () {
      yield* fixture
      yield* (yield* CellStorage).executions.claim(cellOperationStorage)
      const storage = (yield* CellStorage).operations
      const approval = yield* ApprovalService
      const sql = yield* SqlClient.SqlClient
      yield* storage.admit(params)
      const peer = { ...key, operationId: "2" }
      yield* storage.admit({ ...params, ...peer })
      yield* sql`CREATE TEMP TRIGGER require_cell_approval_owner BEFORE INSERT ON events WHEN NEW.event_tag = 'InteractionPresented' BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM cell_tool_operations o JOIN interaction_requests r ON r.request_id = o.request_id WHERE r.request_id = json_extract(NEW.event_json, '$.requestId')) THEN RAISE(ABORT, 'approval has no operation owner') END; END`
      const askAs = (owner: typeof key, text: string) =>
        approval
          .present({ text }, cellOperationStorage)
          .pipe(
            Effect.provideService(CurrentInteractionOwner, cellInteractionOwner(owner, storage)),
          )
      /** The request an operation waits on, once it waits. */
      const waitingOn = (owner: typeof key) =>
        waitFor(
          storage.get(owner),
          (operation) => operation.state._tag === "Waiting",
          5_000,
          `operation ${owner.operationId} waits`,
        ).pipe(
          Effect.flatMap((operation) => {
            if (operation.state._tag === "Waiting") return Effect.succeed(operation.state.requestId)
            return Effect.die("The operation is not waiting")
          }),
        )
      const first = yield* askAs(key, "First?").pipe(Effect.forkChild)
      const firstId = yield* waitingOn(key)
      // No running call owns the open request, so the peer is refused rather
      // than left waiting for a slot nothing would free.
      const blocked = yield* askAs(peer, "Second?").pipe(Effect.flip)
      expect(blocked._tag).toBe("InteractionSlotBusyError")
      expect(blocked.message).toContain("Another call in this step is waiting for an approval")
      expect((yield* storage.get(peer)).state._tag).toBe("Started")
      expect(
        (yield* storedEvents(cellOperationStorage)).filter(
          (event) => event.event._tag === "InteractionPresented",
        ),
      ).toHaveLength(1)
      yield* approval.storeResolution(cellOperationStorage, firstId, {
        approved: false,
        notes: "First denied",
      })
      expect(yield* Fiber.join(first)).toEqual({ approved: false, notes: "First denied" })
      // The call took its answer and runs on: its receipt waits for nothing,
      // and the answer cannot be resumed a second time.
      expect((yield* storage.get(key)).state._tag).toBe("Started")
      expect(Schema.is(StorageError)(yield* storage.resume(key, firstId).pipe(Effect.flip))).toBe(
        true,
      )
      const second = yield* askAs(peer, "Second?").pipe(Effect.forkChild)
      const secondId = yield* waitingOn(peer)
      expect(secondId).not.toBe(firstId)
      yield* approval.storeResolution(cellOperationStorage, secondId, { approved: true })
      expect(yield* Fiber.join(second)).toEqual({ approved: true })
      expect(yield* (yield* InteractionStorage).listOpen(cellOperationStorage)).toEqual([])
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.provide(
        createE2ELayer({
          agents: [],
          extensionInputs: [],
          branchTools: CellBranchTools,
          providerLayer: LanguageModelLayers.debug(),
          durableApproval: true,
        }),
      ),
    ),
)

it.live("never leaves an approval behind when its operation link fails", () =>
  Effect.gen(function* () {
    yield* fixture
    yield* (yield* CellStorage).executions.claim(cellOperationStorage)
    const storage = (yield* CellStorage).operations
    const interactions = yield* InteractionStorage
    const sql = yield* SqlClient.SqlClient
    yield* storage.admit(params)
    yield* sql`CREATE TEMP TRIGGER reject_cell_link BEFORE UPDATE OF request_id ON cell_tool_operations BEGIN SELECT RAISE(ABORT, 'link failure'); END`
    expect(
      Schema.is(StorageError)(
        yield* storage.suspend(key, requestOperationStorage).pipe(Effect.flip),
      ),
    ).toBe(true)
    expect(yield* interactions.listOpen(cellOperationStorage)).toEqual([])
    expect((yield* storage.get(key)).state._tag).toBe("Started")
    yield* sql`DROP TRIGGER reject_cell_link`
    expect(
      Schema.is(StorageError)(
        yield* storage.suspend(key, requestOperationStorage).pipe(sql.withTransaction, Effect.flip),
      ),
    ).toBe(true)
    expect(yield* interactions.listOpen(cellOperationStorage)).toEqual([])
    yield* storage.suspend(key, requestOperationStorage)
    expect(yield* interactions.listOpen(cellOperationStorage)).toEqual([requestOperationStorage])
    expect((yield* storage.get(key)).state).toEqual({ _tag: "Waiting", requestId })
  }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.live(
  "recovers cell operations only in their workspace and branch without granting execution",
  () =>
    Effect.gen(function* () {
      yield* fixture
      yield* (yield* CellStorage).executions.claim(cellOperationStorage)
      const storage = (yield* CellStorage).operations
      expect(yield* storage.listForToolCall(cellOperationStorage)).toEqual([])
      yield* storage.admit(params)
      yield* storage.suspend(key, requestOperationStorage)
      const found = yield* storage.listForToolCall(cellOperationStorage)
      expect(found).toHaveLength(1)
      expect(found[0]?.key).toEqual(key)
      expect(found[0]?.operation.state).toEqual({ _tag: "Waiting", requestId })
      expect(
        Schema.is(StorageError)(
          yield* storage
            .listForToolCall({ ...cellOperationStorage, branchId: BranchId.make("other") })
            .pipe(Effect.flip),
        ),
      ).toBe(true)
      expect(
        Schema.is(StorageError)(
          yield* storage
            .listForToolCall(cellOperationStorage)
            .pipe(
              Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("b".repeat(64))),
              Effect.flip,
            ),
        ),
      ).toBe(true)
      yield* recordInteractionDecision(cellOperationStorage, requestId, { approved: true })
      const resumed = yield* storage.resume(key, requestId)
      yield* storage.complete(
        key,
        Prompt.toolResultPart({
          id: resumed.toolCallId,
          name: binding.toolId,
          result: "done",
          isFailure: false,
          providerExecuted: false,
        }),
      )
      yield* storage.admit({ ...params, operationId: "2" })
      const completed = yield* storage.listForToolCall(cellOperationStorage)
      expect(completed.map(({ operation }) => operation.state._tag)).toEqual([
        "Completed",
        "Started",
      ])
      expect((yield* storage.admit(params)).admitted).toBe(false)
    }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.live("binds a decision to one waiting operation and grants one resume attempt", () =>
  Effect.gen(function* () {
    yield* fixture
    yield* (yield* CellStorage).executions.claim(cellOperationStorage)
    const storage = (yield* CellStorage).operations
    const first = yield* storage.admit(params)
    const peer = { ...params, operationId: "2" }
    yield* storage.admit(peer)
    yield* storage.suspend(key, requestOperationStorage)
    expect(
      Schema.is(StorageError)(
        yield* storage.suspend(key, requestOperationStorage).pipe(Effect.flip),
      ),
    ).toBe(true)
    expect(
      Schema.is(StorageError)(
        yield* storage.suspend(peer, requestOperationStorage).pipe(Effect.flip),
      ),
    ).toBe(true)
    expect((yield* storage.get(peer)).state._tag).toBe("Started")
    expect(Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip))).toBe(
      true,
    )
    const decision = { approved: false, notes: "Do not write" }
    yield* recordInteractionDecision(cellOperationStorage, requestId, decision)
    const resumed = yield* storage.resume(key, requestId)
    expect(resumed.state).toEqual({ _tag: "Resuming", requestId, decision })
    expect(resumed.toolCallId).toBe(first.operation.toolCallId)
    expect(Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip))).toBe(
      true,
    )
    expect((yield* storage.admit(params)).admitted).toBe(false)
    expect((yield* storage.get(key)).state._tag).toBe("Resuming")
  }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.live("a stored decision that does not decode grants no resume", () =>
  Effect.gen(function* () {
    yield* fixture
    yield* (yield* CellStorage).executions.claim(cellOperationStorage)
    const storage = (yield* CellStorage).operations
    yield* storage.admit(params)
    yield* storage.suspend(key, requestOperationStorage)
    // The first answer is the one the request keeps, so a corrupt one stays.
    yield* (yield* InteractionStorage).decide(cellOperationStorage, requestId, "not-json")
    expect(Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip))).toBe(
      true,
    )
    expect((yield* storage.get(key)).state._tag).toBe("Waiting")
  }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.live(
  "rejects cross-workspace and cross-branch access and clears records with the outer cell",
  () =>
    Effect.gen(function* () {
      yield* fixture
      yield* (yield* CellStorage).executions.claim(cellOperationStorage)
      const storage = (yield* CellStorage).operations
      const sql = yield* SqlClient.SqlClient
      yield* storage.admit(params)
      const hidden = yield* storage
        .get(key)
        .pipe(
          Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("a".repeat(64))),
          Effect.flip,
        )
      expect(Schema.is(StorageError)(hidden)).toBe(true)
      const wrong = {
        ...key,
        cell: { ...cellOperationStorage, branchId: BranchId.make("other-branch") },
      }
      expect(Schema.is(StorageError)(yield* storage.get(wrong).pipe(Effect.flip))).toBe(true)
      expect(
        Schema.is(StorageError)(yield* storage.admit({ ...params, ...wrong }).pipe(Effect.flip)),
      ).toBe(true)
      yield* sql`DELETE FROM messages WHERE id = ${cellOperationStorage.assistantMessageId}`
      const rows = yield* sql<{
        readonly count: number
      }>`SELECT COUNT(*) AS count FROM cell_tool_operations`
      expect(rows[0]?.count).toBe(0)
    }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.live("does not admit external work inside a caller transaction or after cell completion", () =>
  Effect.gen(function* () {
    yield* fixture
    const outer = (yield* CellStorage).executions
    yield* outer.claim(cellOperationStorage)
    const storage = (yield* CellStorage).operations
    const sql = yield* SqlClient.SqlClient
    expect(
      Schema.is(StorageError)(yield* storage.admit(params).pipe(sql.withTransaction, Effect.flip)),
    ).toBe(true)
    expect((yield* storage.admit(params)).admitted).toBe(true)
    yield* storage.suspend(key, requestOperationStorage)
    yield* recordInteractionDecision(cellOperationStorage, requestId, { approved: true })
    expect(
      Schema.is(StorageError)(
        yield* storage.resume(key, requestId).pipe(sql.withTransaction, Effect.flip),
      ),
    ).toBe(true)
    expect((yield* storage.get(key)).state._tag).toBe("Waiting")
    yield* outer.complete(
      cellOperationStorage,
      Prompt.toolResultPart({
        id: cellOperationStorage.toolCallId,
        name: "cell",
        result: "cancelled",
        isFailure: true,
        providerExecuted: false,
      }),
    )
    expect(Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip))).toBe(
      true,
    )
    expect(
      Schema.is(StorageError)(
        yield* storage.admit({ ...params, operationId: "2" }).pipe(Effect.flip),
      ),
    ).toBe(true)
  }).pipe(Effect.provide(testSqliteStorage(CellBranchTools.storage, CellBranchTools.migrations))),
)

it.scopedLive("retains approval ownership and prevents a second resume after database reopen", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped()
    const layer = SqliteStorage.LiveWithSql(
      path.join(directory, "gent.db"),
      CellBranchTools.storage,
      CellBranchTools.migrations,
    ).pipe(Layer.provide(GentPlatform.Test()))
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        yield* Effect.gen(function* () {
          yield* fixture
          yield* (yield* CellStorage).executions.claim(cellOperationStorage)
          const storage = (yield* CellStorage).operations
          yield* storage.admit(params)
          yield* storage.suspend(key, requestOperationStorage)
          yield* recordInteractionDecision(cellOperationStorage, requestId, { approved: true })
        }).pipe(Effect.provideContext(context))
      }),
    )
    const resumedId = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        return yield* Effect.gen(function* () {
          const storage = (yield* CellStorage).operations
          expect((yield* storage.get(key)).state).toEqual({ _tag: "Waiting", requestId })
          expect(
            (yield* storage.listForToolCall(cellOperationStorage)).map(
              ({ operation }) => operation.state,
            ),
          ).toEqual([{ _tag: "Waiting", requestId }])
          const resumed = yield* storage.resume(key, requestId)
          expect(resumed.state).toEqual({
            _tag: "Resuming",
            requestId,
            decision: { approved: true },
          })
          return resumed.toolCallId
        }).pipe(Effect.provideContext(context))
      }),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        yield* Effect.gen(function* () {
          const storage = (yield* CellStorage).operations
          const existing = yield* storage.admit(params)
          expect(existing.admitted).toBe(false)
          expect(existing.operation.toolCallId).toBe(resumedId)
          expect(existing.operation.state._tag).toBe("Resuming")
          expect(
            (yield* storage.listForToolCall(cellOperationStorage)).map(
              ({ operation }) => operation.state._tag,
            ),
          ).toEqual(["Resuming"])
          expect(
            Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip)),
          ).toBe(true)
        }).pipe(Effect.provideContext(context))
      }),
    )
  }).pipe(Effect.provide(BunServices.layer)),
)

// ── model context directives ────────────────────────────────────────────────

const hasReply = (text: string) => (items: ReadonlyArray<Message>) =>
  items.some((item) => item.parts.some((part) => part.type === "text" && part.text === text))

const windowMarkers = (items: ReadonlyArray<Message>) =>
  items.filter((message) => message.metadata?.customType === CONTEXT_WINDOW_MESSAGE_TYPE)

describe("model context directives from a cell", () => {
  it.scopedLive(
    "a handoff leads the window until a bare context window replaces it",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("history reply"),
          toolCallStep("cell", { code: "await context.compact()" }),
          textStep("summary of older history"),
          textStep("after compaction"),
          textStep("summary reused"),
          toolCallStep("cell", { code: "await context.newWindow(); 'windowed'" }),
          textStep("after window"),
          textStep("second turn"),
        ])
        const fixture = defineExtension({
          id: "model-context-directive-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("tool", CellTool)
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            CompactionExtension,
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("model-context-directive-source"),
            },
          ],
          branchTools: CellBranchTools,
        })
        yield* client.message.send({ sessionId, branchId, content: "older history" })
        yield* waitFor(client.message.list({ branchId }), hasReply("history reply"))
        yield* client.message.send({ sessionId, branchId, content: "compact older history" })
        const compacted = yield* waitFor(
          client.message.list({ branchId }),
          hasReply("after compaction"),
        )
        const handoff = Option.getOrThrow(
          Option.fromUndefinedOr(
            windowMarkers(compacted).find((m) => Option.isSome(windowDetails(m))),
          ),
        )
        const details = Option.getOrThrow(windowDetails(handoff))
        expect(details.summarized?.count).toBeGreaterThan(0)
        const afterCompaction = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(afterCompaction.metrics.context).toMatchObject({
          handoffMessageId: handoff.id,
          compactions: 1,
        })
        yield* client.message.send({ sessionId, branchId, content: "reuse the summary" })
        yield* waitFor(client.message.list({ branchId }), hasReply("summary reused"))
        const reused = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(reused.metrics.context).toMatchObject({
          handoffMessageId: handoff.id,
          compactions: 1,
        })
        yield* client.message.send({ sessionId, branchId, content: "open a new window" })
        const afterFirst = yield* waitFor(
          client.message.list({ branchId }),
          hasReply("after window"),
        )
        // The handoff marker and the bare window marker are both durable.
        const markers = windowMarkers(afterFirst)
        expect(markers).toHaveLength(2)
        // The new marker anchors on the user message that started this turn.
        const anchor = afterFirst.find(
          (message) => message.role === "user" && hasReply("open a new window")([message]),
        )
        expect(markers[1]?.metadata?.details).toMatchObject({ keepFromMessageId: anchor?.id })

        yield* client.message.send({ sessionId, branchId, content: "and again" })
        const afterSecond = yield* waitFor(
          client.message.list({ branchId }),
          hasReply("second turn"),
        )
        expect(windowMarkers(afterSecond)).toHaveLength(2)
        const windowed = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(windowed.metrics.context?.handoffMessageId).toBeUndefined()
        expect(windowed.metrics.context?.compactions).toBe(1)
        expect(afterSecond.some((message) => message.id === handoff.id)).toBe(true)
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    20000,
  )

  it.scopedLive(
    "a handoff summary names the cell bindings the kept turn still uses",
    () =>
      Effect.gen(function* () {
        // A failed summary call degrades to no handoff, so an assertion thrown
        // inside the model would be swallowed; the request is kept and read after.
        const summaryPrompts: Array<string> = []
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: "const rows = [1, 2, 3]; 'bound'" }),
          textStep("rows bound"),
          toolCallStep("cell", { code: "await context.compact(); rows.length" }),
          {
            ...textStep("summary of older history"),
            assertOptions: (options) => {
              summaryPrompts.push(
                Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(options.prompt),
              )
            },
          },
          textStep("after compaction"),
        ])
        const fixture = defineExtension({
          id: "retained-bindings-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("tool", CellTool)
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            CompactionExtension,
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("retained-bindings-source"),
            },
          ],
          branchTools: CellBranchTools,
        })
        yield* client.message.send({ sessionId, branchId, content: "bind the rows" })
        yield* waitFor(client.message.list({ branchId }), hasReply("rows bound"))
        yield* client.message.send({ sessionId, branchId, content: "compact, then count rows" })
        yield* waitFor(client.message.list({ branchId }), hasReply("after compaction"))
        yield* controls.assertDone
        expect(summaryPrompts).toHaveLength(1)
        expect(summaryPrompts[0]).toContain("Names retained on this branch: rows")
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
    20000,
  )

  for (const directive of ["newWindow", "compact"]) {
    it.scopedLive(
      `an interrupted cell does not apply context.${directive}() to the next turn`,
      () =>
        Effect.gen(function* () {
          const scheduled = yield* Deferred.make<void>()
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            textStep("history reply"),
            toolCallStep("cell", {
              code: `await context.${directive}(); await tools.hold({})`,
            }),
            {
              ...textStep("after interrupt"),
              assertOptions: (options) => {
                const prompt = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(
                  options.prompt,
                )
                expect(prompt).toContain("keep older context")
                expect(prompt).not.toContain("New context window")
              },
            },
          ])
          const fixture = defineExtension({
            id: "interrupted-context-directive-fixture",
            setup: Effect.gen(function* () {
              const host = yield* ExtensionHost
              yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
              yield* host.register(
                "tool",
                CellTool,
                tool({
                  id: "hold",
                  description: "Hold the cell after it schedules a context directive",
                  params: Schema.Struct({}),
                  output: Schema.String,
                  execute: () =>
                    Deferred.succeed(scheduled, void 0).pipe(Effect.andThen(Effect.never)),
                }),
              )
            }),
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            providerLayer,
            agents: [],
            extensionInputs: [
              CompactionExtension,
              {
                ...fixture,
                artifactIdentity: LoadedArtifactIdentity.make(
                  "interrupted-context-directive-source",
                ),
              },
            ],
            branchTools: CellBranchTools,
          })
          yield* client.message.send({ sessionId, branchId, content: "keep older context" })
          yield* waitFor(client.message.list({ branchId }), hasReply("history reply"))
          yield* client.message.send({ sessionId, branchId, content: "schedule then wait" })
          yield* Deferred.await(scheduled)
          yield* client.steer.command({
            command: SteerCommand.make({
              _tag: "Cancel",
              sessionId,
              branchId,
              requestId: RequestId.make("interrupt-context-directive"),
            }),
          })
          yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              ({ event }) => event._tag === "TurnCompleted" && event.interrupted === true,
            ),
            Stream.take(1),
            Stream.runDrain,
          )
          expect(windowMarkers(yield* client.message.list({ branchId }))).toHaveLength(0)
          yield* client.message.send({
            sessionId,
            branchId,
            content: "continue without that directive",
          })
          const messages = yield* waitFor(
            client.message.list({ branchId }),
            hasReply("after interrupt"),
          )
          expect(windowMarkers(messages)).toHaveLength(0)
          expect(
            messages.filter((message) => message.metadata?.customType === "context-window"),
          ).toHaveLength(0)
          expect(yield* controls.callCount).toBe(3)
          yield* controls.assertDone
        }).pipe(Effect.timeout("15 seconds"), Effect.provide(platformLayer)),
      20000,
    )
  }
})

// ── cell prompt guidelines ──────────────────────────────────────────────────

describe("cell prompt guidelines", () => {
  it.effect("tells the model what the cell runtime exposes so it does not guess at imports", () =>
    Effect.sync(() => {
      const guidelines = (getToolMetadata(CellTool).promptGuidelines ?? []).join("\n")
      expect(guidelines).toContain(
        "The cell is a full Bun process in the working directory with your user's privileges; nothing is sandboxed. Bun (Bun.file, Bun.write, Bun.$, Bun.spawn), bun:sqlite, fetch, process (cwd, env), node builtins through await import('node:fs/promises') or require('node:path'), and packages resolved from the working directory are all available.",
      )
      expect(guidelines).toContain(
        "Shell that changes state (git, installs, deletes, network writes) goes through tools.bash({ command })",
      )
      expect(guidelines).toContain("Return a summary, not the data.")
      expect(guidelines).toContain(
        "console output, process.stdout and process.stderr writes, and inherited output of spawned processes return with the cell result",
      )
    }),
  )

  it.effect(
    "names the compute deadline and sends builds and tests to bash, which stops that clock",
    () =>
      Effect.sync(() => {
        const guidelines = (getToolMetadata(CellTool).promptGuidelines ?? []).join("\n")
        expect(guidelines).toContain("A cell gets 30 seconds of its own compute")
        expect(guidelines).toContain(
          "run builds, test suites, and other long commands through tools.bash({ command, timeout })",
        )
        expect(guidelines).not.toContain("Bun.$ and Bun.spawn are for reading: builds, tests")
      }),
  )
})

// ── tool signatures ─────────────────────────────────────────────────────────

const bracketed = tool({
  id: "must-not-run",
  description: "First line.\nSecond line.",
  params: Schema.Struct({
    items: Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
    node: Schema.optional(Schema.Struct({ id: Schema.String })),
  }),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const shippedSignatures: ReadonlyArray<readonly [ToolCapability, string]> = [
  [
    StartChild,
    '- tools.delegate.start(input: { todo: string; context?: "fresh" | "fork"; overrides?: object }): Promise<{ requestId: string; sessionId: string; branchId: string }> // Start a child agent on a task',
  ],
  [
    CancelChild,
    '- tools.delegate.cancel(input: { requestId: string }): Promise<{ _tag: "Pending"; requestId: string; sessionId: string; branchId: string } | { _tag: "Completed"; requestId: string; sessionId: string; branchId: string; interrupted?: boolean; streamFailed?: boolean; unanswered?: boolean }> // Cancel a running child on this branch. Its turn ends as interrupted; a finished child is left as it is.',
  ],
  [
    ListChildren,
    "- tools.delegate.list(input?: { completed?: boolean }): Promise<{ requestId: string; sessionId: string; branchId: string; agentName: string; completed: boolean; interrupted?: boolean; streamFailed?: boolean; unanswered?: boolean }[]> // List every child this branch owns, from the registry. The registry survives restarts; completed is a turn receipt, no...",
  ],
  [
    BashTool,
    '- tools.bash(input: { command: string; timeout?: number; cwd?: string; run_in_background?: boolean }): Promise<{ stdout: string; stderr: string; exitCode: number; status?: "background" }> // Execute shell commands',
  ],
  [
    ReadTool,
    "- tools.read(input: { path: string; offset?: number; limit?: number }): Promise<{ content: string; path: string; lineCount: number; truncated: boolean; nextOffset?: number; lossy?: true }> // Read file contents with line numbers",
  ],
  [
    WriteTool,
    "- tools.write(input: { atomic?: boolean; path: string; content: string }): Promise<{ path: string; bytesWritten: number }> // Create or overwrite files",
  ],
  [
    EditTool,
    "- tools.edit(input: { path: string; oldString: string; newString: string; replaceAll?: boolean }): Promise<{ path: string; replacements: number }> // Apply targeted edits to existing files",
  ],
  [
    GrepTool,
    "- tools.grep(input: { pattern: string; path?: string; glob?: string; caseSensitive?: boolean; context?: number; limit?: number }): Promise<{ matches: { file: string; line: number; content: string; context?: object }[]; truncated: boolean; unreadable?: number; oversized?: number; undecided?: number }> // Search file contents with regex",
  ],
  [
    GoalTool,
    '- tools.goal(input: { action: "get" | "create" | "complete"; objective?: string; tokenBudget?: number }): Promise<{ goal?: object; remainingTokens?: number; report?: string }> // Persistent goal state',
  ],
  [
    AskUserTool,
    "- tools.ask_user(input: { questions: object[] }): Promise<{ answers: string[][]; cancelled?: boolean }> // Ask the user questions with optional predefined options",
  ],
  [
    PromptTool,
    '- tools.prompt(input: { mode: "present" | "confirm" | "review"; content: string; title?: string }): Promise<{ mode: "present"; status: "shown" } | { mode: "confirm"; decision: "yes" | "no" } | { mode: "review"; decision: "yes" | "no" | "edit"; path: string; content?: string }> // Present content to the user for review, confirmation, or informational display. Use mode=present for informational co...',
  ],
  [
    HandoffTool,
    "- tools.handoff(input: { context: string; reason?: string }): Promise<{ handoff: boolean; reason?: string; summary?: string; parentSessionId?: string }> // Transfer context to a new session",
  ],
  [
    WebSearchTool,
    '- tools.websearch(input: { query: string; numResults?: number; type?: "auto" | "fast" }): Promise<{ output: string; query: string }> // Search the web for information',
  ],
  [
    ReadSessionTool,
    "- tools.read_session(input: { sessionId: string; branchId?: string }): Promise<{ sessionId: string; content: string; messageCount?: number; branchCount?: number }> // Read a past session's conversation as markdown. A long transcript keeps its head and tail.",
  ],
  [
    WakeTool,
    '- tools.wake(input: { afterSeconds?: number; at?: string; everySeconds?: number; mode?: "wake" | "notify"; note: string }): Promise<{ wakeId: string; dueAt: string; everySeconds?: number; mode: "wake" | "notify"; note: string }> // Schedule a wake-up alarm',
  ],
  [
    MonitorTool,
    '- tools.monitor(input: { command: string; cwd?: string; everySeconds?: number; until?: string; timeoutSeconds?: number; mode?: "wake" | "notify"; note: string }): Promise<{ wakeId: string; everySeconds: number; deadline: string; mode: "wake" | "notify"; note: string }> // Poll a command until it succeeds, then wake',
  ],
  [
    CancelTool,
    "- tools.wake.cancel(input?: { wakeId?: string }): Promise<{ cancelled: string[] }> // Cancel a pending alarm or monitor",
  ],
  [
    bracketed,
    '- tools["must-not-run"](input: { items: (string | number)[]; node?: { id: string } }): Promise<boolean> // First line.',
  ],
]

const numberInput = tool({
  id: "worker",
  description: "Supply the current worker PID.",
  params: Schema.Finite,
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const eitherInput = tool({
  id: "either",
  description: "Takes one of two shapes.",
  params: Schema.Union([
    Schema.Struct({ left: Schema.String }),
    Schema.Struct({ right: Schema.String }),
  ]),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const emptyInput = tool({
  id: "ping",
  description: "Takes nothing.",
  params: Schema.Struct({}),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const hugeEnum = tool({
  id: "huge",
  description: "Picks one of many kinds.",
  params: Schema.Struct({
    kind: Schema.Literals(Array.from({ length: 10_000 }, (_, index) => `kind-${index}`)),
  }),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const wideInput = tool({
  id: "wide",
  description: "Takes many fields.",
  params: Schema.Struct(
    Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, Schema.String])),
  ),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const collidingId = tool({
  id: "read.then",
  description: "A segment JavaScript probes.",
  params: Schema.Struct({ path: Schema.String }),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

class ClassResult extends Schema.Class<ClassResult>("ClassResult")({
  ok: Schema.Boolean,
  items: Schema.Array(Schema.String),
}) {}

interface TreeNode {
  readonly name: string
  readonly children: ReadonlyArray<TreeNode>
}
const TreeNode: Schema.Codec<TreeNode> = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend(() => TreeNode)),
}).annotate({ identifier: "TreeNode" })

const classResult = tool({
  id: "class-result",
  description: "Returns a class.",
  params: Schema.Struct({ nested: Schema.optional(ClassResult) }),
  output: ClassResult,
  execute: () => Effect.succeed(new ClassResult({ ok: true, items: [] })),
})

const nullableMiddle = tool({
  id: "nullable-middle",
  description: "Takes an optional field with a nested nullable union.",
  params: Schema.Struct({
    box: Schema.optional(
      Schema.NullOr(
        Schema.Struct({ a: Schema.Union([Schema.String, Schema.Null, Schema.Finite]) }),
      ),
    ),
  }),
  output: Schema.Boolean,
  execute: () => Effect.succeed(true),
})

const treeResult = tool({
  id: "tree",
  description: "Returns a tree.",
  params: Schema.Struct({}),
  output: TreeNode,
  execute: () => Effect.succeed({ name: "root", children: [] }),
})

const longLiterals = Array.from({ length: 8 }, (_, index) => `${"long-literal-".repeat(4)}${index}`)

const longLiteralResult = tool({
  id: "long-literal",
  description: "Returns one of a few long names.",
  params: Schema.Struct({}),
  output: Schema.Literals(longLiterals),
  execute: () => Effect.succeed(longLiterals[0] ?? ""),
})

const wideOrList = tool({
  id: "wide-or-list",
  description: "Returns a wide object or a list.",
  params: Schema.Struct({}),
  output: Schema.Union([
    Schema.Struct(
      Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`field${index}`, Schema.String]),
      ),
    ),
    Schema.Array(Schema.String),
  ]),
  execute: () => Effect.succeed([]),
})

const recordResult = tool({
  id: "record",
  description: "Returns a map.",
  params: Schema.Struct({}),
  output: Schema.Record(Schema.String, Schema.Boolean),
  execute: () => Effect.succeed({}),
})

const edgeSignatures: ReadonlyArray<readonly [ToolCapability, string]> = [
  [
    numberInput,
    "- tools.worker(input: number): Promise<boolean> // Supply the current worker PID.",
  ],
  [
    eitherInput,
    "- tools.either(input: { left: string } | { right: string }): Promise<boolean> // Takes one of two shapes.",
  ],
  [emptyInput, "- tools.ping(input?: {} | unknown[]): Promise<boolean> // Takes nothing."],
  [hugeEnum, "- tools.huge(input: { kind: string }): Promise<boolean> // Picks one of many kinds."],
  [wideInput, "- tools.wide(input: object): Promise<boolean> // Takes many fields."],
  [
    collidingId,
    '- tools("read.then")(input: { path: string }): Promise<boolean> // A segment JavaScript probes.',
  ],
  [
    classResult,
    '- tools["class-result"](input?: { nested?: { ok: boolean; items: string[] } }): Promise<{ ok: boolean; items: string[] }> // Returns a class.',
  ],
  [
    nullableMiddle,
    '- tools["nullable-middle"](input?: { box?: { a: string | null | number } }): Promise<boolean> // Takes an optional field with a nested nullable union.',
  ],
  [
    treeResult,
    "- tools.tree(input?: {} | unknown[]): Promise<{ name: string; children: object[] }> // Returns a tree.",
  ],
  [
    longLiteralResult,
    '- tools["long-literal"](input?: {} | unknown[]): Promise<string> // Returns one of a few long names.',
  ],
  [
    wideOrList,
    '- tools["wide-or-list"](input?: {} | unknown[]): Promise<object | string[]> // Returns a wide object or a list.',
  ],
  [
    recordResult,
    "- tools.record(input?: {} | unknown[]): Promise<Record<string, boolean>> // Returns a map.",
  ],
]

// Each level names a union of the one below and a list of it, so a renderer
// that expands a shared definition at every reach doubles per level.
const sharedUnion = Array.from({ length: 22 }).reduce<Schema.Codec<unknown>>(
  (below, _, index) =>
    Schema.Union([below, Schema.Array(below)]).annotate({ identifier: `Level${index + 1}` }),
  Schema.Union([Schema.Boolean, Schema.Null]).annotate({ identifier: "Level0" }),
)
// Anonymous unions nested with no definition to share.
const nestedUnion = Array.from({ length: 14 }).reduce<Schema.Codec<unknown>>(
  (below) => Schema.Union([Schema.Boolean, Schema.Null, Schema.Array(below)]),
  Schema.Union([Schema.Boolean, Schema.Null]),
)
const deepUnionTools = [
  tool({
    id: "shared-union",
    description: "Returns a shared union.",
    params: Schema.Struct({ value: sharedUnion }),
    output: sharedUnion,
    execute: () => Effect.succeed(true),
  }),
  tool({
    id: "nested-union",
    description: "Returns a nested union.",
    params: Schema.Struct({ value: nestedUnion }),
    output: nestedUnion,
    execute: () => Effect.succeed(true),
  }),
]

describe("tool signature bound", () => {
  for (const capability of deepUnionTools) {
    it.live(
      `${String(capability.id)} renders within the type limit, in one pass over its definitions`,
      () =>
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis
          const line = yield* renderToolSignature(capability)
          const elapsed = (yield* Clock.currentTimeMillis) - started
          const [, input = "", result = ""] =
            /^- tools\["[^"]+"\]\(input: (.*)\): Promise<(.*)> \/\/ /.exec(line) ?? []
          expect(input).toBe("object")
          expect(result).toBe("boolean | null | unknown[]")
          // Expanding a shared definition at every reach doubles the work per level.
          expect(elapsed).toBeLessThan(1000)
        }),
    )
  }
})

describe("tool signature edges", () => {
  for (const [capability, expected] of edgeSignatures) {
    it.effect(`${String(capability.id)} keeps its argument contract and a bounded line`, () =>
      Effect.gen(function* () {
        expect(yield* renderToolSignature(capability)).toBe(expected)
      }),
    )
  }
})

describe("tool signatures", () => {
  // The cell code reads a result by its type, so no shipped tool's result
  // collapses to its outer shape.
  it.effect("every shipped tool's result renders whole, never as a bare object", () =>
    Effect.gen(function* () {
      const tools = yield* Effect.forEach(BuiltinExtensions, (extension) =>
        collectTestContributions(extension.setup).pipe(
          Effect.map((contributions) => contributions.tools ?? []),
        ),
      )
      const signatures = yield* Effect.forEach(tools.flat(), renderToolSignature)
      expect(signatures.length).toBeGreaterThan(shippedSignatures.length)
      expect(signatures.filter((line) => /: Promise<object(\[\])?>/.test(line))).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  for (const [capability, expected] of shippedSignatures) {
    it.effect(`${String(capability.id)} renders its callable path and types`, () =>
      Effect.gen(function* () {
        expect(yield* renderToolSignature(capability)).toBe(expected)
      }),
    )
  }
})
