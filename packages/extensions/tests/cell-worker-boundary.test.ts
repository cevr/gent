import { describe, expect, it } from "effect-bun-test"
import { Cause, Deferred, Effect, Fiber, Option, Queue, Ref, type Schema, Stream } from "effect"
import {
  CellHost,
  CellWorkerEnvironment,
  CellWorkerTransport,
  makeBunCellEvaluator,
  runCellWorker,
} from "../src/cell-worker-boundary.js"
import {
  CellProtocolError,
  CellRequest,
  type CellResponse,
  maximumCellDisplayLength,
  maximumCellSourceLength,
} from "../src/cell-protocol.js"

// ── cell worker ─────────────────────────────────────────────────────────────

/** A catalog that selects the named host tools, hashed by their names. */
const catalogOf = (...names: ReadonlyArray<string>) => ({
  hash: names.join(","),
  tools: names.map((name) => ({ name, description: name, guidelines: [], parameters: {} })),
})

/** A worker fed from queues; `uncaught` stands in for the process's uncaught handlers. */
const makeHarnessWith = (uncaught: (typeof CellWorkerEnvironment.Service)["uncaught"]) =>
  Effect.gen(function* () {
    const requests = yield* Queue.make<CellRequest>({ capacity: 64 })
    const responses = yield* Queue.make<CellResponse>({ capacity: 64 })
    const fiber = yield* runCellWorker.pipe(
      Effect.provideService(CellWorkerTransport, {
        requests: Stream.fromQueue(requests),
        send: (response) => Queue.offer(responses, response).pipe(Effect.asVoid),
        endCellOutput: () => Effect.void,
      }),
      Effect.provideService(CellWorkerEnvironment, {
        workingDirectory: process.cwd(),
        uncaught,
      }),
      Effect.forkScoped,
    )
    expect((yield* Queue.take(responses))._tag).toBe("Ready")
    return {
      send: (request: CellRequest) => Queue.offer(requests, request),
      next: Queue.take(responses),
      fiber,
    }
  })

const makeHarness = makeHarnessWith(Stream.empty)

describe("cell worker", () => {
  it.scopedLive("a fault of unknown origin before any cell ran ends the worker", () =>
    Effect.gen(function* () {
      const uncaught =
        yield* Queue.unbounded<Stream.Success<(typeof CellWorkerEnvironment.Service)["uncaught"]>>()
      const worker = yield* makeHarnessWith(Stream.fromQueue(uncaught))
      // No cell code exists in this worker yet: the fault is the worker's own.
      yield* Queue.offer(uncaught, { cause: "worker bug", origin: Option.none() })
      const ended = yield* Effect.exit(Fiber.join(worker.fiber))
      expect(ended._tag).toBe("Failure")
      if (ended._tag === "Failure")
        expect(String(Cause.squash(ended.cause))).toContain("worker bug")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("after a cell ran, a fault of unknown origin waits for the next cell", () =>
    Effect.gen(function* () {
      const uncaught =
        yield* Queue.unbounded<Stream.Success<(typeof CellWorkerEnvironment.Service)["uncaught"]>>()
      const worker = yield* makeHarnessWith(Stream.fromQueue(uncaught))
      let cells = 0
      const evaluate = (source: string) =>
        Effect.gen(function* () {
          cells += 1
          const cellId = `cell-${cells}`
          yield* worker.send(
            CellRequest.cases.Evaluate.make({ cellId, outputToken: `${cellId}-token`, source }),
          )
          const result = yield* worker.next
          if (result._tag !== "Evaluated")
            return yield* new CellProtocolError({ message: `Expected result, got ${result._tag}` })
          return result.result.display
        })
      expect(yield* evaluate("1")).toBe("1")
      // A timer or promise of that cell may raise it: it is not the worker's own.
      yield* Queue.offer(uncaught, { cause: "late rejection", origin: Option.none() })
      // The report runs on its own fiber; each cell gives it a turn.
      const display = yield* evaluate("2").pipe(
        Effect.repeat({ until: (text) => text.includes("late rejection"), times: 20 }),
      )
      expect(display).toContain("Uncaught (origin unknown")
      expect(display).toContain("late rejection")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("handles host replies during evaluation and retains values until reset", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "const count = await tools.count({}); count",
          catalog: catalogOf("count"),
        }),
      )
      const call = yield* worker.next
      if (call._tag !== "HostCall")
        return yield* new CellProtocolError({ message: "Expected host call" })
      expect(call.cellId).toBe("one")
      expect(call.name).toBe("count")
      yield* worker.send(
        CellRequest.cases.HostSucceeded.make({
          cellId: call.cellId,
          operationId: call.operationId,
          value: 42,
        }),
      )
      const completed = yield* worker.next
      if (completed._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(completed.result.display).toBe("42")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "two",
          outputToken: "two-token",
          source: "count + 1",
        }),
      )
      const next = yield* worker.next
      if (next._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(next.result.display).toBe("43")
      yield* worker.send(CellRequest.cases.Reset.make({ requestId: "reset" }))
      expect((yield* worker.next)._tag).toBe("Reset")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "three",
          outputToken: "three-token",
          source: "typeof count",
        }),
      )
      const cleared = yield* worker.next
      if (cleared._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(cleared.result.display).toBe("undefined")
    }).pipe(Effect.timeout("3 seconds")),
  )

  // The snapshot reads every binding after a cell. A read that throws once
  // ended the worker: the next cell failed and the restart lost the namespace.
  it.scopedLive("a binding that throws when read is named as not saved; the worker lives", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      const evaluate = (cellId: string, source: string) =>
        Effect.gen(function* () {
          yield* worker.send(
            CellRequest.cases.Evaluate.make({ cellId, outputToken: `${cellId}-token`, source }),
          )
          const result = yield* worker.next
          if (result._tag !== "Evaluated")
            return yield* new CellProtocolError({ message: `Expected result, got ${result._tag}` })
          return result.result
        })
      const defined = yield* evaluate(
        "define",
        [
          "const kept = [1]",
          "const getter = { get bad() { throw new Error('getter') } }",
          "const trap = () => { throw new Error('trap') }",
          "const trapped = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap })",
          "Object.defineProperty(globalThis, 'accessor', { get: trap, enumerable: true, configurable: true })",
        ].join("\n"),
      )
      expect(defined.bindings).toEqual(["accessor", "getter", "kept", "trap", "trapped"])
      yield* worker.send(CellRequest.cases.Snapshot.make({ requestId: "save" }))
      const saved = yield* worker.next
      if (saved._tag !== "Snapshot")
        return yield* new CellProtocolError({ message: `Expected snapshot, got ${saved._tag}` })
      expect(saved.snapshot.bindings.map((binding) => binding.name)).toEqual(["kept"])
      expect(saved.snapshot.omitted).toEqual([
        { name: "getter", reason: "unsupported" },
        { name: "trap", reason: "function" },
        { name: "trapped", reason: "unsupported" },
        // An accessor is saved as its getter, never called.
        { name: "accessor", reason: "function" },
      ])
      expect((yield* evaluate("after", "kept.length")).display).toBe("1")
      yield* worker.send(CellRequest.cases.Reset.make({ requestId: "reset" }))
      expect((yield* worker.next)._tag).toBe("Reset")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("keeps the shipped catalog for later cells that carry none", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "tools('read').description",
          catalog: {
            hash: "a",
            tools: [{ name: "read", description: "Read a file", guidelines: [], parameters: {} }],
          },
        }),
      )
      const first = yield* worker.next
      if (first._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(first.result.display).toBe("Read a file")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "two",
          outputToken: "two-token",
          source: "Object.keys(tools).join(',')",
        }),
      )
      const second = yield* worker.next
      if (second._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(second.result.display).toBe("read")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "three",
          outputToken: "three-token",
          source: "Object.keys(tools).join(',')",
          catalog: {
            hash: "b",
            tools: [{ name: "write", description: "Write a file", guidelines: [], parameters: {} }],
          },
        }),
      )
      const third = yield* worker.next
      if (third._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(third.result.display).toBe("write")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("rejects overlapping evaluations while waiting for a host reply", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "await tools.wait({})",
          catalog: catalogOf("wait"),
        }),
      )
      expect((yield* worker.next)._tag).toBe("HostCall")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({ cellId: "two", outputToken: "two-token", source: "42" }),
      )
      const error = yield* Fiber.join(worker.fiber).pipe(Effect.flip)
      expect(error.message).toContain("already active")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("rejects replies that do not belong to the active cell", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.HostSucceeded.make({ cellId: "old", operationId: "missing", value: 0 }),
      )
      const error = yield* Fiber.join(worker.fiber).pipe(Effect.flip)
      expect(error.message).toContain("Stale or unknown")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("returns host failures as cell failures without dispatching again", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "await tools.denied({})",
          catalog: catalogOf("denied"),
        }),
      )
      const call = yield* worker.next
      if (call._tag !== "HostCall")
        return yield* new CellProtocolError({ message: "Expected host call" })
      yield* worker.send(
        CellRequest.cases.HostFailed.make({
          cellId: call.cellId,
          operationId: call.operationId,
          message: "Permission denied",
        }),
      )
      const result = yield* worker.next
      if (result._tag !== "Failed")
        return yield* new CellProtocolError({ message: "Expected failure" })
      expect(result.error.message).toContain("Permission denied")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({ cellId: "two", outputToken: "two-token", source: "42" }),
      )
      expect((yield* worker.next)._tag).toBe("Evaluated")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("rejects reset during an active cell", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "await tools.wait({})",
          catalog: catalogOf("wait"),
        }),
      )
      expect((yield* worker.next)._tag).toBe("HostCall")
      yield* worker.send(CellRequest.cases.Reset.make({ requestId: "reset" }))
      expect((yield* Fiber.join(worker.fiber).pipe(Effect.flip)).message).toContain(
        "already active",
      )
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("a script that ends with host calls in flight reports once they settle", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      // The 33rd call fails at once and rejects the Promise.all; 32 stay in flight.
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "await Promise.all(Array.from({ length: 33 }, () => tools.wait({})))",
          catalog: catalogOf("wait"),
        }),
      )
      const calls: Array<Extract<CellResponse, { _tag: "HostCall" }>> = []
      while (calls.length < 32) {
        const frame = yield* worker.next
        if (frame._tag !== "HostCall")
          return yield* new CellProtocolError({ message: `Expected host call, got ${frame._tag}` })
        calls.push(frame)
      }
      for (const call of calls) {
        yield* worker.send(
          CellRequest.cases.HostSucceeded.make({
            cellId: call.cellId,
            operationId: call.operationId,
            value: 1,
          }),
        )
      }
      const result = yield* worker.next
      if (result._tag !== "Failed")
        return yield* new CellProtocolError({ message: "Expected failure" })
      expect(result.error.message).toContain("host-call limit")
      // The worker is intact and idle for the next cell.
      yield* worker.send(
        CellRequest.cases.Evaluate.make({ cellId: "two", outputToken: "two-token", source: "42" }),
      )
      expect((yield* worker.next)._tag).toBe("Evaluated")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("an error's cause reads one level deep, even in a loop or a long chain", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      const evaluate = (cellId: string, source: string) =>
        Effect.gen(function* () {
          yield* worker.send(
            CellRequest.cases.Evaluate.make({ cellId, outputToken: `${cellId}-token`, source }),
          )
          return yield* worker.next
        })
      const failed = (cellId: string, source: string) =>
        Effect.gen(function* () {
          const result = yield* evaluate(cellId, source)
          if (result._tag !== "Failed")
            return yield* new CellProtocolError({ message: `Expected failure, got ${result._tag}` })
          return result.error.message
        })
      expect(yield* failed("loop", "const e = new Error('a'); e.cause = e; throw e")).toBe(
        "Error: a\ncaused by Error: a",
      )
      const logged = yield* evaluate(
        "logged",
        "const f = new Error('b'); f.cause = f; console.log(f); 1",
      )
      expect(logged._tag).toBe("Evaluated")
      expect(
        yield* failed(
          "chain",
          "throw new Error('l1', { cause: new Error('l2', { cause: new Error('l3', { cause: new Error('l4') }) }) })",
        ),
      ).toBe("Error: l1\ncaused by Error: l2")
      // The worker is intact for the next cell.
      const next = yield* evaluate("after", "42")
      if (next._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(next.result.display).toBe("42")
    }).pipe(Effect.timeout("3 seconds")),
  )

  // Rendering a thrown value once ran its getters and traps outside any
  // catch: a throw there ended the worker, and the restart lost the bindings.
  it.scopedLive("a thrown value that cannot be read fails its cell; the worker lives", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      const evaluate = (cellId: string, source: string) =>
        Effect.gen(function* () {
          yield* worker.send(
            CellRequest.cases.Evaluate.make({ cellId, outputToken: `${cellId}-token`, source }),
          )
          return yield* worker.next
        })
      const failed = (cellId: string, source: string) =>
        Effect.gen(function* () {
          const result = yield* evaluate(cellId, source)
          if (result._tag !== "Failed")
            return yield* new CellProtocolError({ message: `Expected failure, got ${result._tag}` })
          return result.error.message
        })
      const kept = (cellId: string) =>
        Effect.gen(function* () {
          const result = yield* evaluate(cellId, "kept")
          if (result._tag !== "Evaluated")
            return yield* new CellProtocolError({ message: `Expected result, got ${result._tag}` })
          return result.result.display
        })
      expect((yield* evaluate("define", "let kept = 7"))._tag).toBe("Evaluated")
      const throwing = (key: string) =>
        `const e = new Error('x'); Object.defineProperty(e, '${key}', { get() { throw new Error('${key}') } }); throw e`
      // A getter the cell defined never runs: the error shows what its data holds.
      expect(yield* failed("message", throwing("message"))).toBe("Error")
      expect(yield* kept("after-message")).toBe("7")
      expect(yield* failed("cause", throwing("cause"))).toBe("Error: x")
      expect(yield* kept("after-cause")).toBe("7")
      expect(yield* failed("code", throwing("code"))).toBe("Error: x")
      expect(yield* kept("after-code")).toBe("7")
      // A trap that throws on any read leaves one fixed text.
      expect(
        yield* failed(
          "proxy",
          "const trap = () => { throw new Error('trap') }; throw new Proxy(new Error('x'), { getPrototypeOf: trap, get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, has: trap })",
        ),
      ).toBe("A thrown value that cannot be read")
      expect(yield* kept("after-proxy")).toBe("7")
      expect(
        (yield* evaluate(
          "primitive",
          "throw { [Symbol.toPrimitive]() { throw new Error('p') }, toString() { throw new Error('s') } }",
        ))._tag,
      ).toBe("Failed")
      expect(yield* kept("after-primitive")).toBe("7")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("an error shows every part that can be read, each in its place", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      const failed = (cellId: string, source: string) =>
        Effect.gen(function* () {
          yield* worker.send(
            CellRequest.cases.Evaluate.make({ cellId, outputToken: `${cellId}-token`, source }),
          )
          const result = yield* worker.next
          if (result._tag !== "Failed")
            return yield* new CellProtocolError({ message: `Expected failure, got ${result._tag}` })
          return result.error.message
        })
      // A DOMException keeps its name and message behind host getters on its prototype.
      expect(
        yield* failed("dom", "throw new DOMException('The operation timed out.', 'TimeoutError')"),
      ).toBe("TimeoutError: The operation timed out.")
      expect(
        yield* failed(
          "abort",
          "const signal = AbortSignal.timeout(1); await new Promise((resolve) => setTimeout(resolve, 20)); throw signal.reason",
        ),
      ).toBe("TimeoutError: The operation timed out.")
      expect(yield* failed("clone", "structuredClone(() => 1)")).toMatch(/^DataCloneError: \S/)
      // Bun splits one syntax error into several messages; each keeps its position.
      const split = yield* failed("split", "const = 1")
      expect(split).toMatch(/^AggregateError: /)
      expect(split).toMatch(/\n {2}BuildMessage: .+\n {4}at line 1, column \d+/)
      // A cause whose getter throws shows the getter unrun; one behind a Proxy cannot be read.
      expect(
        yield* failed(
          "tag",
          "throw new Error('outer', { cause: { get [Symbol.toStringTag]() { throw new Error('tag') } } })",
        ),
      ).toBe("Error: outer\ncaused by { Symbol(Symbol.toStringTag): [Getter] }")
      expect(
        yield* failed(
          "trapped",
          "throw new Error('outer', { cause: new Proxy({}, { getPrototypeOf() { throw 2 } }) })",
        ),
      ).toBe("Error: outer\ncaused by (a value that cannot be read)")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive(
    "an uncaught value that cannot be read reaches the next cell; the worker lives",
    () =>
      Effect.gen(function* () {
        const uncaught =
          yield* Queue.unbounded<
            Stream.Success<(typeof CellWorkerEnvironment.Service)["uncaught"]>
          >()
        const worker = yield* makeHarnessWith(Stream.fromQueue(uncaught))
        let cells = 0
        const evaluate = (source: string) =>
          Effect.gen(function* () {
            cells += 1
            const cellId = `cell-${cells}`
            yield* worker.send(
              CellRequest.cases.Evaluate.make({ cellId, outputToken: `${cellId}-token`, source }),
            )
            const result = yield* worker.next
            if (result._tag !== "Evaluated")
              return yield* new CellProtocolError({
                message: `Expected result, got ${result._tag}`,
              })
            return result.result.display
          })
        expect(yield* evaluate("let kept = 7; kept")).toBe("7")
        // oxlint-disable-next-line effect/noNewError -- the value under test is a thrown Error whose message getter throws
        const unreadable = new Error("x")
        Object.defineProperty(unreadable, "message", {
          get() {
            // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- the getter under test throws
            throw new Error("m")
          },
        })
        yield* Queue.offer(uncaught, { cause: unreadable, origin: Option.none() })
        // The report runs on its own fiber; each cell gives it a turn.
        const display = yield* evaluate("kept").pipe(
          Effect.repeat({ until: (text) => text.includes("Uncaught"), times: 20 }),
        )
        expect(display).toBe(
          "Uncaught (origin unknown: an unawaited promise or microtask): Error\n7",
        )
        const trap = () => {
          // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- the trap under test throws on every read
          throw new Error("trap")
        }
        const trapped = new Proxy(unreadable, {
          getPrototypeOf: trap,
          getOwnPropertyDescriptor: trap,
        })
        yield* Queue.offer(uncaught, { cause: trapped, origin: Option.none() })
        const trappedDisplay = yield* evaluate("kept").pipe(
          Effect.repeat({ until: (text) => text.includes("Uncaught"), times: 20 }),
        )
        expect(trappedDisplay).toBe(
          "Uncaught (origin unknown: an unawaited promise or microtask): A thrown value that cannot be read\n7",
        )
      }).pipe(Effect.timeout("3 seconds")),
  )
})

// ── bun cell evaluator ──────────────────────────────────────────────────────

/** Cells share the test process realm, so each test clears its bindings at scope exit. */
const makeKernel = (host: typeof CellHost.Service, ...tools: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const kernel = yield* makeBunCellEvaluator.pipe(
      Effect.provideService(CellHost, host),
      Effect.provideService(CellWorkerEnvironment, {
        workingDirectory: process.cwd(),
        uncaught: Stream.empty,
      }),
    )
    yield* kernel.setCatalog(catalogOf(...tools).tools)
    yield* Effect.addFinalizer(() => kernel.reset)
    return kernel
  })

describe("Bun cell evaluation", () => {
  it.scopedLive("accepts a host reply while a cell awaits it", () =>
    Effect.gen(function* () {
      const called = yield* Deferred.make<boolean>()
      const reply = yield* Deferred.make<number>()
      const kernel = yield* makeKernel(
        {
          call: () => Deferred.succeed(called, true).pipe(Effect.andThen(Deferred.await(reply))),
        },
        "read",
      )
      const cell = yield* kernel.evaluate("(await tools.read({})) + 1").pipe(Effect.forkScoped)
      yield* Deferred.await(called)
      yield* Deferred.succeed(reply, 41)
      expect((yield* Fiber.join(cell)).display).toBe("42")
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.scopedLive("describes the shipped catalog locally without a host call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const kernel = yield* makeKernel({
        call: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(0)),
      })
      yield* kernel.setCatalog([
        {
          name: "read",
          description: "Read a file",
          guidelines: ["Prefer read over bash"],
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
        { name: "write", description: "Write a file", guidelines: [], parameters: {} },
      ])
      const described = yield* kernel.evaluate(
        "const spec = tools('read'); `${spec.parameters.properties.path.type}:${spec.guidelines[0]}`",
      )
      expect(described.display).toBe("string:Prefer read over bash")
      const missing = yield* kernel.evaluate("tools('bash')").pipe(Effect.flip)
      expect(missing.message).toContain("tools.bash is not a host tool selected for this turn")
      // Catalog reads are worker-local and never become host operations.
      expect(yield* Ref.get(calls)).toBe(0)
      // A reset clears the bindings, not the catalog.
      yield* kernel.reset
      expect((yield* kernel.evaluate("Object.keys(tools).join(',')")).display).toBe("read,write")
    }),
  )

  it.scopedLive("every selected id is a callable path that sends the id and its input", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<
        ReadonlyArray<{ readonly id: string; readonly input: Schema.Json }>
      >([])
      const kernel = yield* makeKernel(
        {
          call: (name, input) =>
            Ref.update(sent, (seen) => [...seen, { id: name, input }]).pipe(
              Effect.as({ tool: name } satisfies Schema.Json),
            ),
        },
        "delegate.start",
        "delegate.list",
        "wake",
        "wake.cancel",
        "read",
        "must-not-run",
      )
      const result = yield* kernel.evaluate(
        "const started = await tools.delegate.start({ todo: 'x' }); started.tool",
      )
      expect(result.display).toBe("delegate.start")
      yield* kernel.evaluate(
        "await tools.delegate.list(); await tools.wake({ note: 'n' }); await tools.wake.cancel({ wakeId: 'w' }); await tools['must-not-run'](3)",
      )
      expect(yield* Ref.get(sent)).toEqual([
        { id: "delegate.start", input: { todo: "x" } },
        { id: "delegate.list", input: {} },
        { id: "wake", input: { note: "n" } },
        { id: "wake.cancel", input: { wakeId: "w" } },
        { id: "must-not-run", input: 3 },
      ])
      expect((yield* kernel.evaluate("Object.keys(tools).join(',')")).display).toBe(
        "delegate,must-not-run,read,wake",
      )
      expect((yield* kernel.evaluate("Object.keys(tools.delegate).join(',')")).display).toBe(
        "list,start",
      )
      expect((yield* kernel.evaluate("typeof (await tools.read({ path: 'a' }))")).display).toBe(
        "object",
      )
      // The namespace is not a binding and never reaches a snapshot.
      expect(result.bindings).toEqual(["started"])
    }),
  )

  it.scopedLive("an unknown path or a namespace call throws without a host call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const kernel = yield* makeKernel(
        { call: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(0)) },
        "delegate.start",
        "delegate.list",
        "read",
      )
      const typo = yield* kernel.evaluate("await tools.delegte.start({})").pipe(Effect.flip)
      expect(typo.message).toContain(
        "tools.delegte is not a host tool selected for this turn. Close ids: delegate.list, delegate.start",
      )
      const namespace = yield* kernel.evaluate("await tools.delegate({})").pipe(Effect.flip)
      expect(namespace.message).toContain(
        "tools.delegate is a namespace, not a tool. Its tools: delegate.start, delegate.list",
      )
      // `await` probes `then`; a node is not a thenable.
      expect((yield* kernel.evaluate("typeof tools.read.then")).display).toBe("undefined")
      expect(yield* Ref.get(calls)).toBe(0)
    }),
  )

  it.scopedLive("JavaScript probes never call a tool, and tools(id) reaches a colliding id", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<string>>([])
      const kernel = yield* makeKernel(
        {
          call: (name) => Ref.update(sent, (seen) => [...seen, name]).pipe(Effect.as(name)),
        },
        "read",
        "read.then",
        "toJSON",
        "constructor",
        "name",
      )
      const probed = yield* kernel.evaluate(
        "const same = (await Promise.resolve(tools.read)) === tools.read; [same, JSON.stringify(tools), typeof tools.read.constructor, typeof tools.name]",
      )
      expect(probed.display).toBe("[ true, undefined, 'function', 'string' ]")
      expect(yield* Ref.get(sent)).toEqual([])
      const called = yield* kernel.evaluate(
        "[await tools('read.then')({}), await tools('toJSON')({}), await tools('constructor')({}), await tools('name')({}), await tools.read({})].join(',')",
      )
      expect(called.display).toBe("read.then,toJSON,constructor,name,read")
      expect((yield* kernel.evaluate("Object.keys(tools).join(',')")).display).toBe("read")
    }),
  )

  it.scopedLive("a null input reaches the host as null", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<Schema.Json>>([])
      const kernel = yield* makeKernel(
        { call: (_name, input) => Ref.update(sent, (seen) => [...seen, input]).pipe(Effect.as(0)) },
        "read",
      )
      yield* kernel.evaluate("await tools.read(null); await tools.read()")
      // oxlint-disable-next-line effect/noNullish -- The contract under test is that a JavaScript null input stays null.
      expect(yield* Ref.get(sent)).toEqual([null, {}])
    }),
  )

  it.scopedLive(
    "tools named describe are ordinary paths; tools(id) returns the catalog entry",
    () =>
      Effect.gen(function* () {
        const sent = yield* Ref.make<ReadonlyArray<string>>([])
        const kernel = yield* makeKernel(
          { call: (name) => Ref.update(sent, (seen) => [...seen, name]).pipe(Effect.as(0)) },
          "describe",
          "describe.run",
        )
        yield* kernel.evaluate("await tools.describe({}); await tools.describe.run({})")
        expect(yield* Ref.get(sent)).toEqual(["describe", "describe.run"])
        const entry = yield* kernel.evaluate(
          "const spec = tools('describe.run'); [spec.id, spec.description, typeof spec.parameters]",
        )
        expect(entry.display).toBe("[ 'describe.run', 'describe.run', 'object' ]")
      }),
  )

  it.scopedLive("rejects non-data host arguments before dispatch", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const kernel = yield* makeKernel(
        { call: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(0)) },
        "read",
      )
      const error = yield* kernel
        .evaluate("await tools.read({ callback: () => 1 })")
        .pipe(Effect.flip)
      expect(error.phase).toBe("execute")
      expect(yield* Ref.get(calls)).toBe(0)
    }),
  )

  it.scopedLive("keeps working values across cells and clears them on reset", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(7) }, "count")
      yield* kernel.evaluate("const values: number[] = [1, 2, 3]")
      const result = yield* kernel.evaluate("values.push(await tools.count({})); values")
      expect(result.display).toBe("[ 1, 2, 3, 7 ]")
      expect(result.bindingCount).toBe(1)
      yield* kernel.reset
      expect((yield* kernel.evaluate("typeof values")).display).toBe("undefined")
    }),
  )

  // Every result stays in the history: a full list on each grows with cells
  // times bindings, so a result names only what its cell bound.
  it.scopedLive("a result names the bindings its cell added or rebound, and counts them all", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
      const first = yield* kernel.evaluate("let a = 1; const list = [1]; let b = 'x'")
      expect(first.bindings).toEqual(["a", "b", "list"])
      expect(first.bindingCount).toBe(3)
      // A value changed in place keeps its binding; the same primitive is no change.
      const inPlace = yield* kernel.evaluate("list.push(2); b = 'x'; list.length")
      expect(inPlace.bindings).toEqual([])
      expect(inPlace.bindingCount).toBe(3)
      const rebound = yield* kernel.evaluate("a = 2; const c = a + 1; c")
      expect(rebound.bindings).toEqual(["a", "c"])
      expect(rebound.bindingCount).toBe(4)
      // Restored bindings are named by the restore report, not by the next result.
      const snapshot = yield* kernel.snapshot
      yield* kernel.reset
      expect([...(yield* kernel.restore(snapshot.bindings))].sort()).toEqual([
        "a",
        "b",
        "c",
        "list",
      ])
      const afterRestore = yield* kernel.evaluate("const d = 4; d")
      expect(afterRestore.bindings).toEqual(["d"])
      expect(afterRestore.bindingCount).toBe(5)
      // A reset forgets them: the next binding is new again.
      yield* kernel.reset
      const afterReset = yield* kernel.evaluate("const a = 9; a")
      expect(afterReset.bindings).toEqual(["a"])
      expect(afterReset.bindingCount).toBe(1)
    }),
  )

  it.scopedLive("runs cells in the worker realm with Bun, require, and dynamic import", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
      const result = yield* kernel.evaluate(
        "const fsm = await import('node:fs/promises'); [typeof Bun.file, typeof fetch, typeof fsm.readdir, typeof require('node:path').join, process.cwd().length > 0]",
      )
      expect(result.display).toBe("[ 'function', 'function', 'function', 'function', true ]")
      expect(result.bindings).toEqual(["fsm"])
      yield* kernel.reset
      expect((yield* kernel.evaluate("typeof fsm")).display).toBe("undefined")
      expect(Object.hasOwn(globalThis, "fsm")).toBe(false)
    }),
  )

  it.scopedLive("an undefined result shows only what the cell logged", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
      expect((yield* kernel.evaluate("console.log('only this')")).display).toBe("only this")
      expect((yield* kernel.evaluate("undefined")).display).toBe("")
      expect((yield* kernel.evaluate("null")).display).toBe("null")
      expect((yield* kernel.evaluate("'undefined'")).display).toBe("undefined")
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.scopedLive("a logged system error keeps its code, path and syscall on one line", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
      const shown = yield* kernel.evaluate(
        "try { require('node:fs').readFileSync('/nonexistent/gent-probe-x') } catch (e) { console.log(e) }",
      )
      const [head, fields, ...rest] = shown.display.split("\n")
      expect(head).toContain("ENOENT")
      expect(fields).toBe(
        "  code: ENOENT, errno: -2, syscall: open, path: /nonexistent/gent-probe-x",
      )
      expect(rest).toEqual([])
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.scopedLive("limits captured output and rejects oversized source before execution", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
      const result = yield* kernel.evaluate(
        "console.log('x'.repeat(100000)); console.log('the end'); 'done'",
      )
      // Head and tail survive; the middle is replaced with an omission marker.
      expect(result.display.length).toBeLessThan(maximumCellDisplayLength + 64)
      expect(result.display.startsWith("x".repeat(1024))).toBe(true)
      expect(result.display).toContain("characters omitted")
      expect(result.display).toContain("the end")
      expect(result.truncated).toBe(true)
      const error = yield* kernel
        .evaluate(" ".repeat(maximumCellSourceLength + 1))
        .pipe(Effect.flip)
      expect(error.phase).toBe("source")
    }),
  )

  it.scopedLive("reports a cell failure without replaying or clearing earlier work", () =>
    Effect.gen(function* () {
      const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
      yield* kernel.evaluate("let count = 0")
      const error = yield* kernel
        .evaluate("count++; console.log('before failure'); throw new Error('failed')")
        .pipe(Effect.flip)
      expect(error.phase).toBe("execute")
      expect(error.output).toBe("before failure")
      expect((yield* kernel.evaluate("count")).display).toBe("1")
      const invalid = yield* kernel.evaluate("const = ;").pipe(Effect.flip)
      expect(invalid.phase).toBe("compile")
      expect((yield* kernel.evaluate("count")).display).toBe("1")
    }),
  )

  it.scopedLive("the context namespace is host-served and never becomes a binding", () =>
    Effect.gen(function* () {
      const names = yield* Ref.make<ReadonlyArray<string>>([])
      const kernel = yield* makeKernel({
        call: (name, input) =>
          Ref.update(names, (seen) => [...seen, name]).pipe(
            Effect.as({ echoed: input, name } satisfies Schema.Json),
          ),
      })
      const status = yield* kernel.evaluate("(await context.status()).name")
      expect(status.display).toBe("context.status")
      const read = yield* kernel.evaluate(
        "const page = await context.read('m1', { offset: 2, limit: 5 }); `${page.echoed.id}:${page.echoed.offset}:${page.echoed.limit}`",
      )
      expect(read.display).toBe("m1:2:5")
      const history = yield* kernel.evaluate("(await context.history({ limit: 3 })).echoed.limit")
      expect(history.display).toBe("3")
      const compact = yield* kernel.evaluate(
        "await context.compact('keep paths'); (await context.newWindow()).name",
      )
      expect(compact.display).toBe("context.newWindow")
      expect(yield* Ref.get(names)).toEqual([
        "context.status",
        "context.read",
        "context.history",
        "context.compact",
        "context.newWindow",
      ])
      expect(read.bindings).toEqual(["page"])
      expect(read.bindings).not.toContain("context")
    }),
  )
})
