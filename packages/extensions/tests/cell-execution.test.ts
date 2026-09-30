import { describe, expect, it } from "effect-bun-test"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
} from "effect"
import { staticToolBinding } from "@gent/core/test-utils"
import { StorageError } from "@gent/core/extensions/branch-tools"
import { CellExecution, CellStorage, CellOperationHost, CellWorker } from "../src/cell.js"
import { CellEvaluationError } from "../src/cell-protocol.js"
import {
  packageDirectory,
  buildCellWorker,
  sessionId,
  branchId,
  testLayer,
  hostCatalog,
  setupCalls,
} from "./helpers/cell-kernel.js"

// Recorded cell execution: reset, cancel, errors and the built-in hazards
// a cell can leave, over one worker and in-memory storage.

/** A worker the test never launches: the cell settles before it needs one. */
const unusedWorker = CellWorker.cases.Script.make({
  runtimePath: "/nonexistent/bun",
  scriptPath: "/nonexistent/worker.js",
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

  /** A cell a hazard holds fails with the hazard's name instead of the test's timeout. */
  const heldBy =
    (row: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: "4 seconds",
          orElse: () => Effect.die(`a hazard held the worker: ${row}`),
        }),
      )

  // The namespace snapshot after each good cell reads every binding. A read
  // that ran a looping getter, trap or coercion held the worker until the
  // compute deadline replaced it, and the namespace was lost. Every row binds
  // its value in one worker; row i names its binding hazard<i>.
  const snapshotHazards: ReadonlyArray<{
    readonly name: string
    readonly source: string
    readonly probe: ReadonlyArray<readonly [expression: string, shown: string]>
    readonly restored: ReadonlyArray<string>
    readonly omitted: ReadonlyArray<{ readonly name: string; readonly reason: string }>
  }> = [
    {
      name: "an error with a looping message getter",
      source:
        "var hazard = Object.defineProperty(new Error('x'), 'message', { get() { for (;;) {} } }); 1",
      probe: [],
      restored: [],
      omitted: [{ name: "hazard", reason: "unsupported" }],
    },
    {
      name: "a plain object with a looping getter",
      source: "var hazard = { data: 1, get looping() { for (;;) {} } }; 1",
      probe: [],
      restored: [],
      omitted: [{ name: "hazard", reason: "unsupported" }],
    },
    {
      name: "a plain object with a looping Symbol.toStringTag getter, saved without its symbol keys",
      source: "var hazard = { data: 1, get [Symbol.toStringTag]() { for (;;) {} } }; 1",
      probe: [["JSON.stringify(hazard)", '{"data":1}']],
      restored: ["hazard"],
      omitted: [],
    },
    {
      name: "a Proxy with looping traps",
      source:
        "var hazard = new Proxy({}, { get() { for (;;) {} }, ownKeys() { for (;;) {} }, getPrototypeOf() { for (;;) {} }, getOwnPropertyDescriptor() { for (;;) {} } }); 1",
      probe: [],
      restored: [],
      omitted: [{ name: "hazard", reason: "unsupported" }],
    },
    {
      name: "a plain object over a Proxy prototype",
      source: "var hazard = Object.create(new Proxy({}, { getPrototypeOf() { for (;;) {} } })); 1",
      probe: [],
      restored: [],
      omitted: [{ name: "hazard", reason: "unsupported" }],
    },
    {
      name: "an error message with a looping toString and Symbol.toPrimitive",
      source:
        "var hazard = new Error('x'); hazard.message = { toString() { for (;;) {} }, [Symbol.toPrimitive]() { for (;;) {} } }; 1",
      probe: [],
      restored: [],
      omitted: [{ name: "hazard", reason: "unsupported" }],
    },
    {
      name: "a RegExp subclass that overrides source, flags and global",
      source:
        "class Looping extends RegExp { get source() { for (;;) {} } get flags() { for (;;) {} } get global() { for (;;) {} } }; var hazard = new Looping('a+', 'gi'); 1",
      probe: [
        ["hazard instanceof RegExp", "true"],
        ["hazard.source", "a+"],
        ["hazard.flags", "gi"],
      ],
      restored: ["hazard"],
      omitted: [{ name: "Looping", reason: "function" }],
    },
  ]
  it.scopedLive(
    "the snapshot never runs cell code, for any hazard a binding holds",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const named = (index: number) => (text: string) =>
          text.replaceAll(/\bhazard\b/g, `hazard${index}`)
        const rows = snapshotHazards.map((row, index) => {
          const name = named(index)
          return {
            name: row.name,
            source: name(row.source),
            probe: row.probe.map(([expression, shown]) => [name(expression), shown] as const),
            restored: row.restored.map(name),
            omitted: row.omitted.map((entry) => ({ ...entry, name: name(entry.name) })),
          }
        })
        const probeExpression = `[kept, ${rows.flatMap((row) => row.probe.map(([expression]) => expression)).join(", ")}].join(',')`
        const calls = yield* setupCalls([
          "let kept = 7; kept",
          ...rows.flatMap((row) => [row.source, "kept"]),
          probeExpression,
        ])
        const [define, probe] = [calls[0], calls.at(-1)]
        if (!define || !probe || calls.length !== rows.length * 2 + 2) {
          return yield* Effect.die("Missing test cells")
        }
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
        for (const [index, row] of rows.entries()) {
          const bind = calls[index * 2 + 1]
          const after = calls[index * 2 + 2]
          if (!bind || !after) return yield* Effect.die("Missing test cells")
          const bound = (yield* run(cells, bind).pipe(heldBy(row.name))).result
          // The next cell answers from the same worker: no restore report.
          const next = (yield* run(cells, after).pipe(heldBy(row.name))).result
          expect({ row: row.name, bound, next }).toMatchObject({
            row: row.name,
            bound: { display: "1" },
            next: { display: "7" },
          })
          expect({ row: row.name, next }).not.toHaveProperty("next.restored")
        }
        // A second owner stands in for a restart: the saved namespace keeps what it can save.
        const restarted = yield* open
        const reply = (yield* run(restarted, probe)).result
        expect(reply).toMatchObject({
          display: ["7", ...rows.flatMap((row) => row.probe.map(([, shown]) => shown))].join(","),
        })
        const Report = Schema.Struct({
          restored: Schema.Struct({
            restored: Schema.Array(Schema.String),
            omitted: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
          }),
        })
        const report = (yield* Schema.decodeUnknownEffect(Report)(reply)).restored
        expect(report.restored).toContain("kept")
        for (const [index, row] of rows.entries()) {
          const own = (name: string) =>
            name === `hazard${index}` || (index === rows.length - 1 && name === "Looping")
          expect({
            row: row.name,
            restored: report.restored.filter(own),
            omitted: report.omitted.filter((entry) => own(entry.name)),
          }).toEqual({ row: row.name, restored: row.restored, omitted: row.omitted })
        }
        expect(report.restored.length + report.omitted.length).toBe(
          1 + rows.reduce((count, row) => count + row.restored.length + row.omitted.length, 0),
        )
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(testLayer)),
    30_000,
  )

  // The error reader walks a thrown value's prototype chain. A Proxy in that
  // chain once ran its trap there, and a looping trap held the worker.

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

  // A built-in the worker cannot put back retires the worker. The cell's
  // result keeps the worker's one note, the host saves nothing after it, and
  // the next cell restores the namespace saved before it.
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
          // The worker's note is the one note: it shows once, and no second
          // note asks for a reset.
          expect(changed).toHaveProperty(
            stuck.reply,
            expect.not.stringMatching(/cannot be put back[\s\S]*cannot be put back/),
          )
          expect(changed).toHaveProperty(stuck.reply, expect.not.stringContaining("not saved"))
          expect(changed).toHaveProperty(stuck.reply, expect.not.stringContaining("reset"))
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
          // The microtask runs after the cell's check and before the host's snapshot request.
          "Promise.resolve().then(() => Object.defineProperty(Map.prototype, 'late', { value: 1 })); var lost = 1; 2",
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
        // A deadlock bound only: the worker it retires is replaced before `after` runs.
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(testLayer)),
    30_000,
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
    {
      name: "a thrown error's own bound message getter",
      source:
        "throw Object.defineProperty(new Error('x'), 'message', { get: function () { for (;;) {} }.bind(null) })",
      shown: "Error",
    },
    {
      name: "a thrown value over a looping Proxy prototype",
      source:
        "throw Object.create(new Proxy({}, { getPrototypeOf() { for (;;) {} }, get() { for (;;) {} } }))",
      shown: "A thrown value that cannot be read",
    },
  ]
  it.scopedLive(
    "display never runs cell code, for any hazard a shown value holds",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const calls = yield* setupCalls([
          "let kept = 7",
          ...displayHazards.flatMap((row) => [row.source, "kept"]),
        ])
        const define = calls[0]
        if (!define || calls.length !== displayHazards.length * 2 + 1) {
          return yield* Effect.die("Missing test cells")
        }
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
        for (const [index, row] of displayHazards.entries()) {
          const shown = calls[index * 2 + 1]
          const after = calls[index * 2 + 2]
          if (!shown || !after) return yield* Effect.die("Missing test cells")
          expect({ row: row.name, shown: yield* reply(shown).pipe(heldBy(row.name)) }).toEqual({
            row: row.name,
            shown: row.shown,
          })
          // The next cell answers from the same worker: no restore report.
          const next = (yield* cells
            .run(after)
            .pipe(Effect.provideService(CellOperationHost, host), heldBy(row.name))).result
          expect({ row: row.name, next }).toMatchObject({ row: row.name, next: { display: "7" } })
          expect({ row: row.name, next }).not.toHaveProperty("next.restored")
        }
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(testLayer)),
    30_000,
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
