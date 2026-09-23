import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
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
  EventPublisherLive,
  EventStore,
  CurrentWorkspaceId,
  WorkspaceId,
  createRpcClient,
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
  toolResultMessageIdForTurn,
  windowDetails,
} from "@gent/core/protocol"
import {
  ExtensionId,
  RequestId,
  InteractionPendingError,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  tool,
  type ToolCapability,
  LoadedArtifactIdentity,
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
  CellToolCallSuspended,
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

// ── cell/cell-worker-fixture ────────────────────────────────────────────────

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

// ── cell/cell-execution.test ────────────────────────────────────────────────

const platform = Layer.merge(BunServices.layer, BunGentPlatformLive)
const testLayer = SqliteStorage.MemoryWithSql(
  CellBranchTools.storage,
  CellBranchTools.migrations,
).pipe(Layer.provideMerge(platform))
const sessionId = SessionId.make("cell-execution-session")
const branchId = BranchId.make("cell-execution-branch")
const now = dateFromMillis(1_767_225_600_000)

/** A catalog that selects the named host tools, hashed by their names. */
const hostCatalog = (...names: ReadonlyArray<string>) => ({
  hash: names.join(","),
  tools: names.map((name) => ({ name, description: name, guidelines: [], parameters: {} })),
})

const setupCalls = Effect.fn("test.setupCells")(function* (
  sources: ReadonlyArray<string>,
  resetAt: ReadonlyArray<number> = [],
) {
  const sessions = yield* SessionStorage
  const branches = yield* BranchStorage
  const messages = yield* MessageStorage
  yield* sessions.createSession(new Session({ id: sessionId, createdAt: now, updatedAt: now }))
  yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
  return yield* Effect.forEach(sources, (code, index) =>
    Effect.gen(function* () {
      const call = {
        assistantMessageId: MessageId.make(`cell-message-${index}`),
        toolCallId: ToolCallId.make(`cell-call-${index}`),
      }
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: call.assistantMessageId,
          sessionId,
          branchId,
          role: "assistant",
          parts: [
            Prompt.toolCallPart({
              id: call.toolCallId,
              name: "cell",
              params: { code, reset: resetAt.includes(index) },
              providerExecuted: false,
            }),
          ],
          createdAt: now,
        }),
      )
      return call
    }),
  )
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
          result: { reason: "cancelled", stateLost: true },
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
    "restores the saved namespace in the cell after a suspended one without an explicit reset",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [keep, suspend, reuse] = yield* setupCalls([
          "const kept = 7; kept",
          "await tools.approve({})",
          "kept + 1",
        ])
        if (!keep || !suspend || !reuse) return yield* Effect.die("Missing test cell")
        const pending = new InteractionPendingError({
          requestId: InteractionRequestId.make("cell-pending-sibling"),
          sessionId,
          branchId,
        })
        const host = CellOperationHost.of({
          catalog: hostCatalog("approve"),
          call: (request) =>
            Effect.fail(
              new CellToolCallSuspended({
                operationId: request.operationId,
                toolCallId: ToolCallId.make("cell-inner-sibling"),
                pending,
              }),
            ),
        })
        const execution = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const kept = yield* execution.run(keep).pipe(Effect.provideService(CellOperationHost, host))
        expect(kept.result).toMatchObject({ display: "7" })
        const suspended = yield* execution
          .run(suspend)
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(suspended._tag).toBe("CellToolCallSuspended")
        // The suspended cell lost its worker; the next cell gets the last good namespace back.
        const reused = yield* execution
          .run(reuse)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(reused.isFailure).toBe(false)
        expect(reused.result).toMatchObject({
          display: "8",
          restored: { restored: ["kept"], omitted: [] },
        })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "stops on host approval without exposing it to a cell catch block or replaying source",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [first, next] = yield* setupCalls([
          "try { await tools.approve({}) } catch { await tools['must-not-run']({}) }",
          "42",
        ])
        if (!first || !next) return yield* Effect.die("Missing test cell")
        const calls = yield* Ref.make(0)
        const pending = new InteractionPendingError({
          requestId: InteractionRequestId.make("cell-pending"),
          sessionId,
          branchId,
        })
        const innerCallId = ToolCallId.make("cell-inner-call")
        const host = CellOperationHost.of({
          catalog: hostCatalog("approve", "must-not-run"),
          call: (request) =>
            Ref.update(calls, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.fail(
                  new CellToolCallSuspended({
                    operationId: request.operationId,
                    toolCallId: innerCallId,
                    pending,
                  }),
                ),
              ),
            ),
        })
        const execution = Context.get(
          yield* Layer.build(
            CellExecution.Live({ worker, cwd: packageDirectory, sessionId, branchId }),
          ),
          CellExecution,
        )
        const suspended = yield* execution
          .run(first)
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(suspended).toMatchObject({
          _tag: "CellToolCallSuspended",
          toolCallId: innerCallId,
          pending,
        })
        expect(yield* Ref.get(calls)).toBe(1)
        yield* execution.reset
        expect(
          (yield* execution
            .run(first)
            .pipe(Effect.provideService(CellOperationHost, host), Effect.flip))._tag,
        ).toBe("CellExecutionIncomplete")
        expect(
          (yield* execution.run(next).pipe(Effect.provideService(CellOperationHost, host))).result,
        ).toMatchObject({ display: "42" })
        expect(yield* Ref.get(calls)).toBe(1)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
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
        yield* replay.reset
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
        yield* execution.reset
        const unknown = yield* execution
          .run(first)
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(unknown._tag).toBe("CellExecutionIncomplete")
        expect(yield* fs.readFileString(output)).toBe("x")
        const fresh = yield* execution
          .run(next)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(fresh.result).toMatchObject({ display: "42" })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "counts failed lazy startup against the same worker replacement limit",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const fs = yield* FileSystem.FileSystem
        const savedWorker = `${worker.scriptPath}.saved`
        yield* fs.rename(worker.scriptPath, savedWorker)
        const [first, next, crash] = yield* setupCalls(["41", "42", "process.exit(0)"])
        if (!first || !next || !crash) return yield* Effect.die("Missing test cell")
        const execution = Context.get(
          yield* Layer.build(
            CellExecution.Live({
              worker,
              cwd: packageDirectory,
              sessionId,
              branchId,
              maximumReplacements: 1,
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
        yield* fs.rename(savedWorker, worker.scriptPath)
        expect(
          (yield* execution.run(next).pipe(Effect.provideService(CellOperationHost, host))).result,
        ).toMatchObject({ display: "42" })
        expect(
          (yield* execution.run(crash).pipe(Effect.provideService(CellOperationHost, host)))
            .isFailure,
        ).toBe(true)
        expect((yield* execution.reset.pipe(Effect.flip)).reason).toBe("replacement-limit")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )
})

// ── cell/cell-process.test ──────────────────────────────────────────────────

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
          maximumReplacements: 1,
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
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("replacement-limit")
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
          maximumReplacements: 1,
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
          maximumReplacements: 1,
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
    "counts failed replacement starts and does not reopen a closed kernel",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const launch = yield* buildCellWorker
        const kernel = yield* openCellKernel({
          worker: launch,
          cwd: packageDirectory,
          maximumReplacements: 1,
        })
        const host = CellOperationHost.of({ call: () => Effect.succeed(true) })
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

// ── cell/cell-approval.test ─────────────────────────────────────────────────

describe("cell approvals", () => {
  it.scopedLive(
    "resumes fresh cell approvals without replaying source for allow and deny",
    () =>
      Effect.gen(function* () {
        for (const approved of [true, false]) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const marks = yield* Ref.make<ReadonlyArray<string>>([])
              const decisions = yield* Ref.make<ReadonlyArray<boolean>>([])
              const attempts = yield* Ref.make(0)
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
                      }),
                      tool({
                        id: "approve",
                        description: "Ask before recording a decision",
                        params: Schema.Struct({}),
                        output: Schema.Boolean,
                        execute: () =>
                          Effect.gen(function* () {
                            yield* Ref.update(attempts, (count) => count + 1)
                            const answer = yield* (yield* ExtensionContext).Interaction.approve({
                              text: "Continue cell operation?",
                            })
                            yield* Ref.update(decisions, (values) => [...values, answer.approved])
                            return answer.approved
                          }),
                      }),
                    ],
                  },
                },
              ]
              const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
                toolCallStep("cell", {
                  code: "await tools.mark('before'); await tools.approve({}); await tools.mark('after')",
                }),
                textStep("Cell recovery reported"),
              ])
              const { client, sessionId, branchId } = yield* createRpcHarness({
                extensions,
                providerLayer,
                extensionInputs: [],
                branchTools: CellBranchTools,
                durableApproval: true,
                agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
              })
              yield* client.message.send({
                sessionId,
                branchId,
                content: "Run a cell with approval",
              })
              const presented = yield* client.session.events({ sessionId, branchId }).pipe(
                Stream.map((envelope) => envelope.event),
                Stream.filter((event) => event._tag === "InteractionPresented"),
                Stream.take(1),
                Stream.runCollect,
              )
              const request = Array.from(presented)[0]
              if (Predicate.isUndefined(request)) return yield* Effect.die("Missing approval")
              yield* client.session.watchRuntime({ sessionId, branchId }).pipe(
                Stream.filter((runtime) => runtime._tag === "WaitingForInteraction"),
                Stream.take(1),
                Stream.runDrain,
              )
              expect(yield* Ref.get(marks)).toEqual(["before"])
              expect(yield* Ref.get(decisions)).toEqual([])
              yield* client.interaction.respondInteraction({
                sessionId,
                branchId,
                requestId: request.requestId,
                approved,
              })
              yield* client.session.events({ sessionId, branchId }).pipe(
                Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
                Stream.take(1),
                Stream.runDrain,
              )
              const messages = yield* client.message.list({ branchId })
              expect(
                messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    messagePartsText(message.parts) === "Cell recovery reported",
                ),
              ).toBe(true)
              const results = messages
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool-result")
                .filter((part) => part.name === "cell")
              expect(results).toHaveLength(1)
              expect(results[0]).toMatchObject({
                isFailure: true,
                // Recovered operations use the receipt shape every client decodes.
                result: {
                  stateLost: true,
                  operations: [
                    { tool: "mark", outcome: "succeeded", toolCallId: expect.any(String) },
                    { tool: "approve", outcome: "succeeded", toolCallId: expect.any(String) },
                  ],
                },
              })
              expect(yield* Ref.get(marks)).toEqual(["before"])
              expect(yield* Ref.get(decisions)).toEqual([approved])
              // The host restarts at its approval boundary. Outer source does not restart.
              expect(yield* Ref.get(attempts)).toBe(2)
            }),
          )
        }
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.provide(Layer.merge(BunServices.layer, BunGentPlatformLive)),
      ),
    18000,
  )
})

// ── cell/cell-tool-call.test ────────────────────────────────────────────────

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
const base = Layer.mergeAll(
  BunServices.layer,
  ToolRunner.Live,
  EventPublisherLive.pipe(Layer.provide(EventStore.Memory)),
)

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

it.scopedLive("preserves the pending request and host operation identity", () =>
  Effect.gen(function* () {
    const pending = new InteractionPendingError({
      requestId: InteractionRequestId.make("cell-approval"),
      sessionId: sessionIdToolCall,
      branchId: branchIdToolCall,
    })
    const selected = tool({
      id: "echo",
      description: "Approval tool",
      params: Schema.Struct({ text: Schema.String }),
      output: Schema.String,
      execute: () => Effect.fail(pending),
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
    expect(result).toMatchObject({
      _tag: "CellToolCallSuspended",
      operationId: requestToolCall.operationId,
      toolCallId,
      pending,
    })
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

// ── cell/cell-tool-host.test ────────────────────────────────────────────────

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
        const pending = yield* host.call(requestToolHost("2", "approve")).pipe(Effect.flip)
        expect(pending._tag).toBe("CellToolCallSuspended")
        expect((yield* operations.get({ cell: cellToolHost, operationId: "2" })).state._tag).toBe(
          "Waiting",
        )
        expect(yield* (yield* InteractionStorage).listPending(cellToolHost)).toHaveLength(1)
        if (pending._tag !== "CellToolCallSuspended") return yield* Effect.die(pending)
        const undecided = yield* recoverCellExecution(hostParams).pipe(Effect.flip)
        expect(undecided._tag).toBe("CellToolCallSuspended")
        if (undecided._tag === "CellToolCallSuspended")
          expect(undecided.pending.requestId).toBe(pending.pending.requestId)
        expect(yield* Ref.get(approvalCalls)).toBe(1)
        const resumeParams = {
          ...hostParams,
          operationId: "2",
          requestId: pending.pending.requestId,
        }
        expect(
          (yield* resumeCellToolOperation({
            ...resumeParams,
            requestId: InteractionRequestId.make("wrong"),
          }).pipe(Effect.flip))._tag,
        ).toBe("StorageError")
        expect(yield* Ref.get(approvalCalls)).toBe(1)
        const approval = yield* ApprovalService
        yield* approval.storeResolution(pending.pending.requestId, { approved: false })
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
              summary: expect.any(String),
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
            const pending = yield* host.call(requestToolHost("1", "approve")).pipe(Effect.flip)
            if (pending._tag !== "CellToolCallSuspended") return yield* Effect.die(pending)
            yield* (yield* ApprovalService).storeResolution(pending.pending.requestId, {
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
              requestId: first.pending.requestId,
            })
            expect(result.result).toBe(true)
            expect(result.id).toBe(first.toolCallId)
            expect(yield* Ref.get(calls)).toBe(2)
            expect((yield* (yield* CellStorage).executions.claim(cellToolHost))._tag).toBe(
              "Incomplete",
            )
            const pending = yield* (yield* makeCellToolHost(hostParams))
              .call(requestToolHost("2", "approve"))
              .pipe(Effect.flip)
            if (pending._tag !== "CellToolCallSuspended") return yield* Effect.die(pending)
            yield* (yield* ApprovalService).storeResolution(pending.pending.requestId, {
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
              requestId: next.pending.requestId,
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

// ── cell/cell-context-host.test ─────────────────────────────────────────────

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
  SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations),
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
        availableInputTokens: 58,
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
      expect(after.percent).toBe(42)
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

// ── cell/cell-default-surface.test ──────────────────────────────────────────

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
        // A reload reads the inner call back from those events: the row's input and the
        // tool's own summary, never the full output.
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
        expect(cellInteraction?.operations?.[0]?.output).toBeUndefined()

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
        })
        yield* client.message.send({
          sessionId,
          branchId,
          content: "read the note",
          agentOverride: AgentName.make("scoped"),
        })
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

// ── cell/cell-child.test ────────────────────────────────────────────────────

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

// ── cell/cell-lifetime.test ─────────────────────────────────────────────────

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

// ── cell/cell-recovery.test ─────────────────────────────────────────────────

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

const cancelRecoveredChild = Effect.fn("test.cancelRecoveredChild")(function* (
  outer: Option.Option<Message["parts"][number]>,
  parent: { readonly sessionId: SessionId; readonly branchId: BranchId },
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
  "recovers saved cells through RPC without native replay and retains sibling results",
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
          // The orphaned child's own turn. It is gated and never released, so
          // the child is still at the model when the parent cancels it — the
          // state a lost worker leaves behind.
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
            const suspended = yield* suspendedHost
              .call(
                CellResponse.cases.HostCall.make({
                  cellId: "1",
                  operationId: "1",
                  name: "approve",
                  input: {},
                }),
              )
              .pipe(Effect.flip)
            expect(suspended._tag).toBe("CellToolCallSuspended")
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
            return yield* (yield* InteractionStorage).listPending({ sessionId, branchId })
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
          yield* cancelRecoveredChild(Option.fromUndefinedOr(outer), { sessionId, branchId }).pipe(
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
        if (state === "completed") expect(outer).toEqual(savedResult)
        else if (state === "unadmitted")
          expect(outer).toMatchObject({ isFailure: false, result: 1 })
        else if (state === "revoked")
          expect(outer).toMatchObject({ isFailure: true, result: { error: "Unknown tool: cell" } })
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
        expect(
          results?.find((part) => part.type === "tool-result" && part.id === "native-sibling"),
        ).toMatchObject({ isFailure: false, result: 1 })
        if (state === "unadmitted") {
          expect(yield* Ref.get(cellCalls)).toBe(1)
          expect(yield* Ref.get(selectedNames)).toEqual([
            "approve",
            "cell",
            "delegate.cancel",
            "delegate.start",
            "sibling",
          ])
        } else expect(yield* Ref.get(cellCalls)).toBe(0)
        expect(yield* Ref.get(nativeCalls)).toBe(1)
      }
    }).pipe(Effect.timeout("12 seconds")),
  15000,
)

// ── cell/code-cell-execution-storage.test ───────────────────────────────────

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
  }).pipe(
    Effect.provide(SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations)),
  ),
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
  }).pipe(
    Effect.provide(SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations)),
  ),
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
  }).pipe(
    Effect.provide(SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations)),
  ),
)

it.live("rejects admission inside a caller transaction before granting execution", () =>
  Effect.gen(function* () {
    const address = yield* makeFixture("transaction")
    const storage = (yield* CellStorage).executions
    const sql = yield* SqlClient.SqlClient
    const rejected = yield* storage.claim(address).pipe(sql.withTransaction, Effect.flip)
    expect(Schema.is(StorageError)(rejected)).toBe(true)
    expect(yield* storage.claim(address)).toEqual({ _tag: "Claimed", code })
  }).pipe(
    Effect.provide(SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations)),
  ),
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

// ── cell/code-cell-tool-operation-storage.test ──────────────────────────────

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
  }).pipe(
    Effect.provide(SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations)),
  ),
)

it.scopedLive(
  "publishes cell approval only after durable ownership and consumes its exact decision",
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
      const first = yield* approval
        .present({ text: "First?" }, cellOperationStorage)
        .pipe(
          Effect.provideService(CurrentInteractionOwner, cellInteractionOwner(key, storage)),
          Effect.flip,
        )
      if (!Schema.is(InteractionPendingError)(first)) return yield* Effect.die(first)
      yield* approval.storeResolution(first.requestId, { approved: false, notes: "First denied" })
      const blocked = yield* approval
        .present({ text: "Second?" }, cellOperationStorage)
        .pipe(
          Effect.provideService(CurrentInteractionOwner, cellInteractionOwner(peer, storage)),
          Effect.flip,
        )
      expect(blocked._tag).toBe("EventStoreError")
      expect((yield* storage.get(peer)).state._tag).toBe("Started")
      expect(
        (yield* storedEvents(cellOperationStorage)).filter(
          (event) => event.event._tag === "InteractionPresented",
        ),
      ).toHaveLength(1)
      yield* storage.resume(key, first.requestId)
      expect(
        yield* approval
          .present({ text: "First?" }, cellOperationStorage)
          .pipe(Effect.provideService(CurrentInteractionOwner, cellInteractionOwner(key, storage))),
      ).toEqual({ approved: false, notes: "First denied" })
      const second = yield* approval
        .present({ text: "Second?" }, cellOperationStorage)
        .pipe(
          Effect.provideService(CurrentInteractionOwner, cellInteractionOwner(peer, storage)),
          Effect.flip,
        )
      if (!Schema.is(InteractionPendingError)(second)) return yield* Effect.die(second)
      expect(second.requestId).not.toBe(first.requestId)
      yield* approval.storeResolution(second.requestId, { approved: true })
      yield* storage.resume(peer, second.requestId)
      expect(
        yield* approval
          .present({ text: "Second?" }, cellOperationStorage)
          .pipe(
            Effect.provideService(CurrentInteractionOwner, cellInteractionOwner(peer, storage)),
          ),
      ).toEqual({ approved: true })
      expect(
        (yield* approval
          .present({ text: "Again?" }, cellOperationStorage)
          .pipe(
            Effect.provideService(CurrentInteractionOwner, cellInteractionOwner(key, storage)),
            Effect.flip,
          ))._tag,
      ).toBe("EventStoreError")
    }).pipe(
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
    expect(yield* interactions.listPending(cellOperationStorage)).toEqual([])
    expect((yield* storage.get(key)).state._tag).toBe("Started")
    yield* sql`DROP TRIGGER reject_cell_link`
    expect(
      Schema.is(StorageError)(
        yield* storage.suspend(key, requestOperationStorage).pipe(sql.withTransaction, Effect.flip),
      ),
    ).toBe(true)
    expect(yield* interactions.listPending(cellOperationStorage)).toEqual([])
    yield* storage.suspend(key, requestOperationStorage)
    expect(yield* interactions.listPending(cellOperationStorage)).toEqual([requestOperationStorage])
    expect((yield* storage.get(key)).state).toEqual({ _tag: "Waiting", requestId })
  }).pipe(
    Effect.provide(SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations)),
  ),
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
      yield* recordInteractionDecision(requestId, { approved: true })
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
    }).pipe(
      Effect.provide(
        SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations),
      ),
    ),
)

it.live("binds a decision to one waiting operation and grants one resume attempt", () =>
  Effect.gen(function* () {
    yield* fixture
    yield* (yield* CellStorage).executions.claim(cellOperationStorage)
    const storage = (yield* CellStorage).operations
    const interactions = yield* InteractionStorage
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
    yield* interactions.decide(requestId, "not-json")
    expect(Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip))).toBe(
      true,
    )
    expect((yield* storage.get(key)).state._tag).toBe("Waiting")
    const decision = { approved: false, notes: "Do not write" }
    yield* recordInteractionDecision(requestId, decision)
    const resumed = yield* storage.resume(key, requestId)
    expect(resumed.state).toEqual({ _tag: "Resuming", requestId, decision })
    expect(resumed.toolCallId).toBe(first.operation.toolCallId)
    expect(Schema.is(StorageError)(yield* storage.resume(key, requestId).pipe(Effect.flip))).toBe(
      true,
    )
    expect((yield* storage.admit(params)).admitted).toBe(false)
    expect((yield* storage.get(key)).state._tag).toBe("Resuming")
  }).pipe(
    Effect.provide(SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations)),
  ),
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
    }).pipe(
      Effect.provide(
        SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations),
      ),
    ),
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
    yield* recordInteractionDecision(requestId, { approved: true })
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
  }).pipe(
    Effect.provide(SqliteStorage.TestWithSql(CellBranchTools.storage, CellBranchTools.migrations)),
  ),
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
          yield* recordInteractionDecision(requestId, { approved: true })
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

// ── cell/model-context-directives.test ──────────────────────────────────────

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

// ── cell/prompt-guidelines.test ─────────────────────────────────────────────

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

// ── cell/tool-signatures.test ───────────────────────────────────────────────

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
    "- tools.delegate.cancel(input: { requestId: string }): Promise<object> // Cancel a running child on this branch. Its turn ends as interrupted; a finished child is left as it is.",
  ],
  [
    ListChildren,
    "- tools.delegate.list(input?: { completed?: boolean }): Promise<object[]> // List every child this branch owns, from the registry. The registry survives restarts; completed is a turn receipt, no...",
  ],
  [
    BashTool,
    "- tools.bash(input: { command: string; timeout?: number; cwd?: string; run_in_background?: boolean }): Promise<{ stdout: string; stderr: string; exitCode: number }> // Execute shell commands",
  ],
  [
    ReadTool,
    "- tools.read(input: { path: string; offset?: number; limit?: number }): Promise<{ content: string; path: string; lineCount: number; truncated: boolean; nextOffset?: number }> // Read file contents with line numbers",
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
    "- tools.grep(input: { pattern: string; path?: string; glob?: string; caseSensitive?: boolean; context?: number; limit?: number }): Promise<{ matches: { file: string; line: number; content: string; context?: object }[]; truncated: boolean }> // Search file contents with regex",
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
    '- tools.prompt(input: { mode: "present" | "confirm" | "review"; content: string; title?: string }): Promise<object> // Present content to the user for review, confirmation, or informational display. Use mode=present for informational co...',
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
]

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
  for (const [capability, expected] of shippedSignatures) {
    it.effect(`${String(capability.id)} renders its callable path and types`, () =>
      Effect.gen(function* () {
        expect(yield* renderToolSignature(capability)).toBe(expected)
      }),
    )
  }
})
