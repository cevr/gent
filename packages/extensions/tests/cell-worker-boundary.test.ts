import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Option,
  Predicate,
  Queue,
  Ref,
  type Schema,
  Stream,
} from "effect"
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

/** The listing of a catalog that selects the named host tools, hashed by their names. */
const catalogOf = (...names: ReadonlyArray<string>) => ({
  hash: names.join(","),
  tools: names.map((name) => ({ name, signature: "", summary: "" })),
})

/** An uncaught error with no known origin, raised when no built-in was changed. */
const strayError = (cause: unknown) => ({
  cause,
  origin: Option.none<number>(),
  repair: { restored: [], unrestored: [] },
})

/**
 * A worker fed from queues. `raise` stands in for the process's uncaught
 * handlers. `evaluate` sends one cell and returns its response; a cell with no
 * id is numbered in order.
 */
const makeHarness = Effect.gen(function* () {
  const requests = yield* Queue.make<CellRequest>({ capacity: 64 })
  const responses = yield* Queue.make<CellResponse>({ capacity: 64 })
  const uncaught =
    yield* Queue.unbounded<Stream.Success<(typeof CellWorkerEnvironment.Service)["uncaught"]>>()
  const fiber = yield* runCellWorker.pipe(
    Effect.provideService(CellWorkerTransport, {
      requests: Stream.fromQueue(requests),
      send: (response) => Queue.offer(responses, response).pipe(Effect.asVoid),
      endCellOutput: () => Effect.void,
    }),
    Effect.provideService(CellWorkerEnvironment, {
      workingDirectory: process.cwd(),
      uncaught: Stream.fromQueue(uncaught),
    }),
    Effect.forkScoped,
  )
  expect((yield* Queue.take(responses))._tag).toBe("Ready")
  const send = (request: CellRequest) => Queue.offer(requests, request)
  const next = Queue.take(responses)
  let cells = 0
  const evaluate = (source: string, cellId?: string) =>
    Effect.gen(function* () {
      cells += 1
      let id = `cell-${cells}`
      if (Predicate.isNotUndefined(cellId)) id = cellId
      yield* send(
        CellRequest.cases.Evaluate.make({ cellId: id, outputToken: `${id}-token`, source }),
      )
      return yield* next
    })
  return {
    send,
    next,
    fiber,
    raise: (error: Stream.Success<(typeof CellWorkerEnvironment.Service)["uncaught"]>) =>
      Queue.offer(uncaught, error),
    evaluate,
    /** The result of a cell that must evaluate. */
    evaluated: (source: string, cellId?: string) =>
      Effect.gen(function* () {
        const result = yield* evaluate(source, cellId)
        if (result._tag !== "Evaluated")
          return yield* new CellProtocolError({ message: `Expected result, got ${result._tag}` })
        return result.result
      }),
    /** The error message of a cell that must fail. */
    failed: (source: string, cellId?: string) =>
      Effect.gen(function* () {
        const result = yield* evaluate(source, cellId)
        if (result._tag !== "Failed")
          return yield* new CellProtocolError({ message: `Expected failure, got ${result._tag}` })
        return result.error.message
      }),
  }
})

/** The display of a cell that must evaluate. */
const displayOf = (result: { readonly display: string }) => result.display

describe("cell worker", () => {
  it.scopedLive("a fault of unknown origin before any cell ran ends the worker", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      // No cell code exists in this worker yet: the fault is the worker's own.
      yield* worker.raise(strayError("worker bug"))
      const ended = yield* Effect.exit(Fiber.join(worker.fiber))
      expect(ended._tag).toBe("Failure")
      if (ended._tag === "Failure")
        expect(String(Cause.squash(ended.cause))).toContain("worker bug")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("after a cell ran, a fault of unknown origin waits for the next cell", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      expect((yield* worker.evaluated("1")).display).toBe("1")
      // A timer or promise of that cell may raise it: it is not the worker's own.
      yield* worker.raise(strayError("late rejection"))
      // The report runs on its own fiber; each cell gives it a turn.
      const display = yield* worker
        .evaluated("2")
        .pipe(
          Effect.map(displayOf),
          Effect.repeat({ until: (text) => text.includes("late rejection"), times: 20 }),
        )
      expect(display).toContain("Uncaught (origin unknown")
      expect(display).toContain("late rejection")
    }).pipe(Effect.timeout("3 seconds")),
  )

  // The process handler puts the built-ins back before it queues the error.
  // A built-in changed after that, before the report renders the error, is
  // put back by the report itself, and named with the error.
  it.scopedLive("an uncaught error's report puts back the built-ins before its text", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      expect((yield* worker.evaluated("1")).display).toBe("1")
      // Stands in for a timer that adds a built-in property after the handler ran.
      // The report removes it; the release removes it too if the report never runs.
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          Reflect.defineProperty(Array.prototype, "probeAdded", { value: 1, configurable: true }),
        ),
        () => Effect.sync(() => Reflect.deleteProperty(Array.prototype, "probeAdded")),
      )
      yield* worker.raise(strayError("late rejection"))
      const display = yield* worker
        .evaluated("2")
        .pipe(
          Effect.map(displayOf),
          Effect.repeat({ until: (text) => text.includes("late rejection"), times: 20 }),
        )
      expect(display).toContain(
        "Put back built-ins changed before an uncaught error: Array.prototype.probeAdded",
      )
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

  // The snapshot reads every binding after a cell. A read that throws names
  // that binding as not saved, and the worker keeps its namespace.
  it.scopedLive("a binding that throws when read is named as not saved; the worker lives", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      const defined = yield* worker.evaluated(
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
      expect((yield* worker.evaluated("kept.length")).display).toBe("1")
      yield* worker.send(CellRequest.cases.Reset.make({ requestId: "reset" }))
      expect((yield* worker.next)._tag).toBe("Reset")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive(
    "keeps the shipped listing for later cells that carry none, and asks the host for a tool's details",
    () =>
      Effect.gen(function* () {
        const worker = yield* makeHarness
        yield* worker.send(
          CellRequest.cases.Evaluate.make({
            cellId: "one",
            outputToken: "one-token",
            source: "(await tools('read')).description",
            catalog: { hash: "a", tools: [{ name: "read", signature: "", summary: "" }] },
          }),
        )
        // The listing holds no description: the worker asks, and the host answers.
        const asked = yield* worker.next
        if (asked._tag !== "Describe")
          return yield* new CellProtocolError({ message: "Expected a Describe" })
        expect(asked.id).toBe("read")
        yield* worker.send(
          CellRequest.cases.HostSucceeded.make({
            cellId: "one",
            operationId: asked.operationId,
            value: {
              id: "read",
              description: "Read a file",
              guidelines: [],
              parameters: {},
              signature: "",
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
            catalog: { hash: "b", tools: [{ name: "write", signature: "", summary: "" }] },
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
      expect(yield* worker.failed("const e = new Error('a'); e.cause = e; throw e")).toBe(
        "Error: a\ncaused by Error: a",
      )
      yield* worker.evaluated("const f = new Error('b'); f.cause = f; console.log(f); 1")
      expect(
        yield* worker.failed(
          "throw new Error('l1', { cause: new Error('l2', { cause: new Error('l3', { cause: new Error('l4') }) }) })",
        ),
      ).toBe("Error: l1\ncaused by Error: l2")
      // The worker is intact for the next cell.
      expect((yield* worker.evaluated("42")).display).toBe("42")
    }).pipe(Effect.timeout("3 seconds")),
  )

  // Rendering a thrown value runs no getter or trap outside a catch, so a
  // throw there neither ends the worker nor loses the bindings.
  it.scopedLive("a thrown value that cannot be read fails its cell; the worker lives", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      const kept = worker.evaluated("kept").pipe(Effect.map(displayOf))
      yield* worker.evaluated("let kept = 7")
      const throwing = (key: string) =>
        `const e = new Error('x'); Object.defineProperty(e, '${key}', { get() { throw new Error('${key}') } }); throw e`
      // A getter the cell defined never runs: the error shows what its data holds.
      expect(yield* worker.failed(throwing("message"))).toBe("Error")
      expect(yield* kept).toBe("7")
      expect(yield* worker.failed(throwing("cause"))).toBe("Error: x")
      expect(yield* kept).toBe("7")
      expect(yield* worker.failed(throwing("code"))).toBe("Error: x")
      expect(yield* kept).toBe("7")
      // A trap that throws on any read leaves one fixed text.
      expect(
        yield* worker.failed(
          "const trap = () => { throw new Error('trap') }; throw new Proxy(new Error('x'), { getPrototypeOf: trap, get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, has: trap })",
        ),
      ).toBe("A thrown value that cannot be read")
      expect(yield* kept).toBe("7")
      yield* worker.failed(
        "throw { [Symbol.toPrimitive]() { throw new Error('p') }, toString() { throw new Error('s') } }",
      )
      expect(yield* kept).toBe("7")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("an error shows every part that can be read, each in its place", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      const failed = (cellId: string, source: string) => worker.failed(source, cellId)
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
        const worker = yield* makeHarness
        const evaluate = (source: string) => worker.evaluated(source).pipe(Effect.map(displayOf))
        expect(yield* evaluate("let kept = 7; kept")).toBe("7")
        // oxlint-disable-next-line effect/noNewError -- the value under test is a thrown Error whose message getter throws
        const unreadable = new Error("x")
        Object.defineProperty(unreadable, "message", {
          get() {
            // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- the getter under test throws
            throw new Error("m")
          },
        })
        yield* worker.raise(strayError(unreadable))
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
        yield* worker.raise(strayError(trapped))
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

/**
 * A test host: its tool calls, and optionally its details. Without them, a
 * listed tool's details name it and carry an empty schema.
 */
type TestHost = Pick<typeof CellHost.Service, "call"> &
  Partial<Pick<typeof CellHost.Service, "describe">>

/** Cells share the test process realm, so each test clears its bindings at scope exit. */
const makeKernel = (host: TestHost, ...tools: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const listedDetails = (id: string) =>
      Effect.succeed({ id, description: id, guidelines: [], parameters: {}, signature: "" })
    const kernel = yield* makeBunCellEvaluator.pipe(
      Effect.provideService(CellHost, {
        call: host.call,
        describe: Option.getOrElse(Option.fromUndefinedOr(host.describe), () => listedDetails),
      }),
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

  it.scopedLive(
    "search ranks a 100-tool catalog by segment and summary, filters by namespace, and pages",
    () =>
      Effect.gen(function* () {
        const kernel = yield* makeKernel({ call: () => Effect.succeed(0) })
        const entry = (name: string, summary: string) => ({
          name,
          signature: `tools.${name}(input?: {}): Promise<unknown> // ${summary}`,
          summary,
        })
        const filler = Array.from({ length: 88 }, (_, index) =>
          entry(`mcp.filler.tool_${String(index).padStart(3, "0")}`, `Filler operation ${index}.`),
        )
        const catalog = [
          entry("mcp.github.listIssues", "List issues in a repository."),
          entry("mcp.github.createIssue", "Create an issue."),
          entry("mcp.github.getPullRequest", "Read one pull request."),
          entry("mcp.github.listPullRequests", "List pull requests."),
          entry("mcp.github.searchCode", "Search code."),
          entry("mcp.linear.list_issues", "Linear tickets, listed."),
          entry("mcp.linear.create_issue", "Open a Linear ticket."),
          entry("mcp.slack.postMessage", "Post to a channel."),
          entry("mcp.slack.listChannels", "Every channel."),
          entry("mcp.docs.lookup", "Find open issues in the tracker."),
          entry("mcp.filler.a", "Filler operation a."),
          entry("mcp.filler.B", "Filler operation B."),
          ...filler,
        ]
        expect(catalog).toHaveLength(100)
        yield* kernel.setCatalog(catalog)
        const search = (source: string) =>
          kernel.evaluate(`JSON.stringify(${source})`).pipe(Effect.map((result) => result.display))
        const ids = (source: string) => search(`${source}.items.map((item) => item.id)`)
        // camelCase and `_` split: both words must match, so `listPullRequests` is out.
        expect(yield* ids("tools.search('list issues')")).toBe(
          '["mcp.github.listIssues","mcp.linear.list_issues"]',
        )
        // A word in the name outranks the same word in the description only.
        expect(yield* ids("tools.search('issue')")).toBe(
          '["mcp.github.createIssue","mcp.linear.create_issue","mcp.github.listIssues","mcp.linear.list_issues","mcp.docs.lookup"]',
        )
        // A word the query repeats counts once, so the repeat finds what the word finds.
        expect(yield* ids("tools.search('issue issue')")).toBe(yield* ids("tools.search('issue')"))
        // A one-character word is no prefix: `0` in "Filler operation 0." misses `042`.
        expect(yield* ids("tools.search('tool_042')")).toBe('["mcp.filler.tool_042"]')
        // The whole id ranks first.
        expect(yield* ids("tools.search('mcp.github.createIssue', { limit: 1 })")).toBe(
          '["mcp.github.createIssue"]',
        )
        // Three words need 60%: two of three pass, one of three does not.
        expect(yield* ids("tools.search('post message channel')")).toBe('["mcp.slack.postMessage"]')
        // The namespace keeps its own ids; an empty query lists them by id.
        expect(yield* ids("tools.search('issue', { namespace: 'mcp.linear' })")).toBe(
          '["mcp.linear.create_issue","mcp.linear.list_issues"]',
        )
        expect(yield* ids("tools.search('', { namespace: 'mcp.slack' })")).toBe(
          '["mcp.slack.listChannels","mcp.slack.postMessage"]',
        )
        // Equal scores sort by code unit, so `B` comes before `a`.
        expect(yield* search("tools.search('filler', { limit: 3 })")).toBe(
          [
            '{"items":[{"id":"mcp.filler.B","description":"Filler operation B."},',
            '{"id":"mcp.filler.a","description":"Filler operation a."},',
            '{"id":"mcp.filler.tool_000","description":"Filler operation 0."}],',
            '"total":90,"hasMore":true,"nextOffset":3}',
          ].join(""),
        )
        // Pages follow `nextOffset` to the end, each id once, in the one order.
        const pages = yield* search(
          [
            "(() => {",
            "  const seen = []; let offset = 0; let last",
            "  do { last = tools.search('filler', { limit: 40, offset }); seen.push(...last.items.map((item) => item.id)); offset = last.nextOffset } while (last.hasMore)",
            "  return { count: seen.length, unique: new Set(seen).size, sorted: seen.slice(2).every((id, index, all) => index === 0 || all[index - 1] < id), last: 'nextOffset' in last }",
            "})()",
          ].join("\n"),
        )
        expect(pages).toBe('{"count":90,"unique":90,"sorted":true,"last":false}')
        // The default page is 20.
        expect(yield* search("tools.search('').items.length")).toBe("20")
      }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive(
    "lists and signs the shipped catalog locally, and fetches one tool's schema from the host",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const described = yield* Ref.make<ReadonlyArray<string>>([])
        const read = {
          id: "read",
          description: "Read a file",
          guidelines: ["Prefer read over bash"],
          parameters: { type: "object", properties: { path: { type: "string" } } },
          signature: "tools.read(input: { path?: string }): Promise<unknown> // Read a file",
        }
        const kernel = yield* makeKernel({
          call: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(0)),
          describe: (id) => Ref.update(described, (ids) => [...ids, id]).pipe(Effect.as(read)),
        })
        yield* kernel.setCatalog([
          { name: "read", signature: read.signature, summary: "Read a file" },
          {
            name: "write",
            signature: "tools.write(input?: {}): Promise<unknown> // Write a file",
            summary: "Write a file",
          },
        ])
        const details = yield* kernel.evaluate(
          "const spec = await tools('read'); `${spec.parameters.properties.path.type}:${spec.guidelines[0]}`",
        )
        expect(details.display).toBe("string:Prefer read over bash")
        expect(yield* Ref.get(described)).toEqual(["read"])
        // The tool itself, not its details, until awaited.
        const tool = yield* kernel.evaluate(
          "const t = tools('read'); JSON.stringify([t.id, t.signature])",
        )
        expect(tool.display).toBe(
          '["read","tools.read(input: { path?: string }): Promise<unknown> // Read a file"]',
        )
        expect(yield* Ref.get(described)).toEqual(["read"])
        const missing = yield* kernel.evaluate("tools('bash')").pipe(Effect.flip)
        expect(missing.message).toContain("tools.bash is not a host tool selected for this turn")
        // A two-word query needs both words: `write` holds only "file".
        const found = yield* kernel.evaluate("JSON.stringify(tools.search('file read'))")
        expect(found.display).toBe(
          '{"items":[{"id":"read","description":"Read a file"}],"total":1,"hasMore":false}',
        )
        // Catalog reads never become tool calls.
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
    "tools named like a discovery key are reached by tools(id), which returns the catalog entry",
    () =>
      Effect.gen(function* () {
        const sent = yield* Ref.make<ReadonlyArray<string>>([])
        const kernel = yield* makeKernel(
          { call: (name) => Ref.update(sent, (seen) => [...seen, name]).pipe(Effect.as(0)) },
          "describe",
          "search",
          "search.run",
          "fs.search",
        )
        yield* kernel.evaluate(
          "await tools('search')({}); await tools('search.run')({}); await tools.fs.search({}); await tools.describe({})",
        )
        expect(yield* Ref.get(sent)).toEqual(["search", "search.run", "fs.search", "describe"])
        // The root key stays the discovery function and never calls the colliding tools;
        // `describe` is an ordinary path.
        const discovery = yield* kernel.evaluate(
          "[typeof tools.search, Object.keys(tools).join(',')]",
        )
        expect(discovery.display).toBe("[ 'function', 'describe,fs' ]")
        expect(yield* Ref.get(sent)).toHaveLength(4)
        const entry = yield* kernel.evaluate(
          "const spec = await tools('search.run'); [spec.id, spec.description, typeof spec.parameters]",
        )
        expect(entry.display).toBe("[ 'search.run', 'search.run', 'object' ]")
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
      expect(status.display).toBe("context:status")
      const read = yield* kernel.evaluate(
        "const page = await context.read('m1', { offset: 2, limit: 5 }); `${page.echoed.id}:${page.echoed.offset}:${page.echoed.limit}`",
      )
      expect(read.display).toBe("m1:2:5")
      const history = yield* kernel.evaluate("(await context.history({ limit: 3 })).echoed.limit")
      expect(history.display).toBe("3")
      const compact = yield* kernel.evaluate(
        "await context.compact('keep paths'); (await context.newWindow()).name",
      )
      expect(compact.display).toBe("context:newWindow")
      expect(yield* Ref.get(names)).toEqual([
        "context:status",
        "context:read",
        "context:history",
        "context:compact",
        "context:newWindow",
      ])
      expect(read.bindings).toEqual(["page"])
    }),
  )
})
