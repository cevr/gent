import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Fiber, Queue, Ref, type Schema, Stream } from "effect"
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

// ── cell/cell-worker.test ───────────────────────────────────────────────────

/** A catalog that selects the named host tools, hashed by their names. */
const catalogOf = (...names: ReadonlyArray<string>) => ({
  hash: names.join(","),
  tools: names.map((name) => ({ name, description: name, guidelines: [], parameters: {} })),
})

const makeHarness = Effect.gen(function* () {
  const requests = yield* Queue.make<CellRequest>({ capacity: 64 })
  const responses = yield* Queue.make<CellResponse>({ capacity: 64 })
  const fiber = yield* runCellWorker.pipe(
    Effect.provideService(CellWorkerTransport, {
      requests: Stream.fromQueue(requests),
      send: (response) => Queue.offer(responses, response).pipe(Effect.asVoid),
      endCellOutput: () => Effect.void,
    }),
    Effect.provideService(CellWorkerEnvironment, { workingDirectory: process.cwd() }),
    Effect.forkScoped,
  )
  expect((yield* Queue.take(responses))._tag).toBe("Ready")
  return {
    send: (request: CellRequest) => Queue.offer(requests, request),
    next: Queue.take(responses),
    fiber,
  }
})

describe("cell worker", () => {
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
})

// ── cell/bun-cell-evaluator.test ────────────────────────────────────────────

/** Cells share the test process realm, so each test clears its bindings at scope exit. */
const makeKernel = (host: typeof CellHost.Service, ...tools: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const kernel = yield* makeBunCellEvaluator.pipe(
      Effect.provideService(CellHost, host),
      Effect.provideService(CellWorkerEnvironment, { workingDirectory: process.cwd() }),
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
      expect(result.bindings).toEqual(["values"])
      yield* kernel.reset
      expect((yield* kernel.evaluate("typeof values")).display).toBe("undefined")
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
