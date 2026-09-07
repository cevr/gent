import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  BranchId,
  MessageId,
  SessionId,
  ToolCallId,
  InteractionRequestId,
} from "@gent/core-internal/domain/ids"
import { InteractionPendingError } from "@gent/core-internal/domain/interaction-request"
import { Branch, dateFromMillis, Message, Session } from "@gent/core-internal/domain/message"
import { CellExecution } from "@gent/core-internal/runtime/code-cell/cell-execution"
import {
  CellOperationHost,
  CellToolCallSuspended,
} from "@gent/core-internal/runtime/code-cell/cell-kernel"
import { CellEvaluationError } from "@gent/core-internal/runtime/code-cell/cell-protocol"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { buildCellWorker } from "./cell-worker-fixture.js"

const platform = Layer.merge(BunServices.layer, BunGentPlatformLive)
const testLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provideMerge(platform))
const sessionId = SessionId.make("cell-execution-session")
const branchId = BranchId.make("cell-execution-branch")
const now = dateFromMillis(1_767_225_600_000)

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

describe.skipIf(process.platform !== "darwin")("recorded cell execution", () => {
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
          yield* Layer.build(CellExecution.Live({ ...worker, sessionId, branchId })),
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
    "cancels active and queued cells without replay and requires explicit reset",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [first, second, third, fourth] = yield* setupCalls(
          ["await tools.call('wait', {})", "await tools.call('must-not-run', {})", "1", "6 * 7"],
          [3],
        )
        if (!first || !second || !third || !fourth) return yield* Effect.die("Missing test cells")
        const started = yield* Deferred.make<boolean>()
        const stopped = yield* Deferred.make<boolean>()
        const calls = yield* Ref.make(0)
        const host = CellOperationHost.of({
          call: () =>
            Ref.update(calls, (n) => n + 1).pipe(
              Effect.andThen(Deferred.succeed(started, true)),
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, true)),
            ),
        })
        const context = yield* Layer.build(CellExecution.Live({ ...worker, sessionId, branchId }))
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
        expect(
          yield* cells.run(third).pipe(Effect.provideService(CellOperationHost, host)),
        ).toMatchObject({ isFailure: true, result: { reason: "recovery-required" } })
        expect(
          yield* cells.run(fourth).pipe(Effect.provideService(CellOperationHost, host)),
        ).toMatchObject({ isFailure: false, result: { display: "42" } })
        expect(yield* Ref.get(calls)).toBe(1)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(testLayer)),
    10000,
  )

  it.scopedLive(
    "stops on host approval without exposing it to a cell catch block or replaying source",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [first, next] = yield* setupCalls([
          "try { await tools.call('approve', {}) } catch { await tools.call('must-not-run', {}) }",
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
          yield* Layer.build(CellExecution.Live({ ...worker, sessionId, branchId })),
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
          "let n = await tools.call('append', {}); n",
          "n++; throw new Error('cell failed')",
          "n",
        ])
        const [first, failed, next] = calls
        if (!first || !failed || !next) return yield* Effect.die("Missing test cell")
        const host = CellOperationHost.of({
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
              yield* Layer.build(CellExecution.Live({ ...worker, sessionId, branchId })),
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
              ...worker,
              workerPath: path.join(directory, "missing-worker.js"),
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
        const [first, next] = yield* setupCalls([
          "await tools.call('append-and-wait', {})",
          "21 * 2",
        ])
        if (!first || !next) return yield* Effect.die("Missing test cell")
        const started = yield* Deferred.make<boolean>()
        const stopped = yield* Deferred.make<boolean>()
        const host = CellOperationHost.of({
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
          yield* Layer.build(CellExecution.Live({ ...worker, sessionId, branchId })),
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
        const savedWorker = `${worker.workerPath}.saved`
        yield* fs.rename(worker.workerPath, savedWorker)
        const [first, next, crash] = yield* setupCalls([
          "41",
          "42",
          "tools.call.constructor('return process.exit(0)')()",
        ])
        if (!first || !next || !crash) return yield* Effect.die("Missing test cell")
        const execution = Context.get(
          yield* Layer.build(
            CellExecution.Live({ ...worker, sessionId, branchId, maximumReplacements: 1 }),
          ),
          CellExecution,
        )
        const host = CellOperationHost.of({ call: () => Effect.die("Unexpected host operation") })
        const failed = yield* execution
          .run(first)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(failed.isFailure).toBe(true)
        expect(failed.result).toMatchObject({ _tag: "CellProcessError", phase: "launch" })
        yield* fs.rename(savedWorker, worker.workerPath)
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
