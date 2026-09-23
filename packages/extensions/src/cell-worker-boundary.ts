import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Runtime,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { createRequire } from "node:module"
import { inspect } from "node:util"
import {
  type CellCatalogEntry,
  reservedToolSegments,
  toolPath,
  CellEvaluation,
  CellEvaluationError,
  cellOutputBoundary,
  CellProtocolError,
  type CellRequest,
  cellRequestFd,
  CellResponse,
  cellResponseFd,
  decodeCellRequest,
  encodeCellResponse,
  encodeSnapshot,
  makeBoundedOutput,
  makeCellFrameReader,
  maximumCallsPerCell,
  maximumCellBindings,
  maximumCellDisplayHeadLength,
  maximumCellDisplayLength,
  maximumCellSourceLength,
  maximumPendingCellCalls,
  type SnapshotBinding,
  snapshotReviverSource,
} from "./cell-protocol.js"

// ── tool namespace ──────────────────────────────────────────────────────────

const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row++) {
    const current = [row]
    for (let column = 1; column <= right.length; column++) {
      const substitution = Number(left[row - 1] !== right[column - 1])
      current.push(
        Math.min(
          (previous[column] ?? 0) + 1,
          (current[column - 1] ?? 0) + 1,
          (previous[column - 1] ?? 0) + substitution,
        ),
      )
    }
    previous = current
  }
  return previous[right.length] ?? 0
}

/** The three selected ids nearest to what the cell asked for, by whole id or by the same depth. */
const closeIds = (wanted: string, ids: ReadonlyArray<string>): string =>
  ids
    .map((id) => {
      const depth = id.split(".").slice(0, wanted.split(".").length).join(".")
      return { id, score: Math.min(editDistance(wanted, id), editDistance(wanted, depth)) }
    })
    .toSorted((left, right) => left.score - right.score || left.id.localeCompare(right.id))
    .slice(0, 3)
    .map((candidate) => candidate.id)
    .join(", ")

/** The id a child key names under `path`; the root has no prefix. */
const childPath = (path: string, key: string) => [path, key].filter((part) => part !== "").join(".")

/** Every node is callable and shows its id; the root shows `tools`. */
const nodeTarget = (path: string) =>
  Object.defineProperty(() => {}, "name", { value: path || "tools" })

/** A namespace node: a callable path named by its id. */
type ToolNode = ReturnType<typeof nodeTarget>

interface ToolCatalogView {
  readonly ids: () => ReadonlyArray<string>
  readonly describe: (id: string) => Option.Option<CellCatalogEntry>
  // oxlint-disable-next-line effect/noUnknownParameters -- model code passes any JavaScript value to the tool namespace
  readonly call: (id: string, input: unknown) => Promise<Schema.Json>
}

/** A call with no argument sends an empty input, as `tools.delegate.list()` reads; `null` stays `null`. */
// oxlint-disable-next-line effect/noUnknownParameters -- model code passes any JavaScript value to the tool namespace
const inputOrEmpty = (input: unknown) => {
  if (Predicate.isUndefined(input)) return {}
  return input
}

/** A reserved key keeps its JavaScript meaning; only the other string keys name tools. */
const isToolKey = (key: string | symbol): key is string =>
  Predicate.isString(key) && !reservedToolSegments.has(key)

/**
 * `tools` inside the cell: every selected host tool id is a callable path, so
 * `delegate.start` is `tools.delegate.start(input)`. Each node is a Proxy that
 * reads the current id set on access; a node can be a tool and a namespace at
 * once (`tools.wake(input)` and `tools.wake.cancel(input)`). A call sends the
 * id itself to the host, so operation records key on the tool id.
 *
 * A reserved key (`then`, `toJSON`, `constructor`, `call`, `name`, ...) is
 * never a tool, so `await`, `JSON.stringify`, and inspection never call one.
 * `tools(id)` is the one lookup by string: it returns the tool as a function
 * that carries its catalog entry (`id`, `description`, `guidelines`,
 * `parameters`), and reaches an id whose segment is reserved.
 */
const makeToolNamespace = (catalog: ToolCatalogView): ToolNode => {
  const nodes = new Map<string, ToolNode>()
  const isPrefix = (path: string) =>
    catalog.ids().some((id) => id === path || id.startsWith(`${path}.`))
  const children = (path: string) => {
    const names = catalog
      .ids()
      .filter((id) => path === "" || id.startsWith(`${path}.`))
      .map((id) => id.slice(path.length).replace(/^\./, "").split(".")[0] ?? "")
      .filter(isToolKey)
    return [...new Set(names)].toSorted()
  }
  const unknown = (path: string) =>
    // oxlint-disable-next-line effect/noNewError -- a thrown Error is the cell's failure contract inside model code
    new Error(
      `${toolPath(path)} is not a host tool selected for this turn. Close ids: ${closeIds(path, catalog.ids()) || "none"}`,
    )
  const lookup = (id: string) => {
    const entry = Option.getOrThrowWith(catalog.describe(id), () => unknown(id))
    // oxlint-disable-next-line effect/noUnknownParameters -- model code passes any JavaScript value to the tool namespace
    return Object.assign((input?: unknown) => catalog.call(entry.name, input), {
      id: entry.name,
      description: entry.description,
      guidelines: [...entry.guidelines],
      parameters: entry.parameters,
    })
  }
  const node = (path: string): ToolNode => {
    const existing = nodes.get(path)
    if (Predicate.isNotUndefined(existing)) return existing
    const handler: ProxyHandler<ToolNode> = {
      get: (target, key, receiver) => {
        if (!isToolKey(key)) return Reflect.get(target, key, receiver)
        if (isPrefix(childPath(path, key))) return node(childPath(path, key))
        // oxlint-disable-next-line effect/noThrowStatement -- a thrown Error is the cell's failure contract inside model code
        throw unknown(childPath(path, key))
      },
      has: (target, key) => {
        if (!isToolKey(key)) return Reflect.has(target, key)
        return isPrefix(childPath(path, key))
      },
      ownKeys: () => children(path),
      getOwnPropertyDescriptor: (target, key) => {
        if (isToolKey(key) && isPrefix(childPath(path, key))) {
          const value = node(childPath(path, key))
          return { value, enumerable: true, configurable: true, writable: false }
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      apply: (_target, _this, args: ReadonlyArray<unknown>) => {
        if (path === "") return lookup(String(args[0]))
        if (catalog.ids().includes(path)) return catalog.call(path, args[0])
        // oxlint-disable-next-line effect/noThrowStatement -- a thrown Error is the cell's failure contract inside model code
        if (!isPrefix(path)) throw unknown(path)
        const inside = catalog.ids().filter((id) => id.startsWith(`${path}.`))
        // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- a thrown Error is the cell's failure contract inside model code
        throw new Error(
          `${toolPath(path)} is a namespace, not a tool. Its tools: ${inside.join(", ")}`,
        )
      },
    }
    const created = new Proxy(nodeTarget(path), handler)
    nodes.set(path, created)
    return created
  }
  return node("")
}

// ── bun evaluator ───────────────────────────────────────────────────────────

/** Facts about the worker process, supplied by its entry. */
export class CellWorkerEnvironment extends Context.Service<
  CellWorkerEnvironment,
  {
    /** Base for `require` resolution; the host launched the worker here. */
    readonly workingDirectory: string
  }
>()("@gent/extensions/src/cell-worker-boundary/CellWorkerEnvironment") {}

/** The worker transport supplies this proxy. It never supplies Gent host services. */
export class CellHost extends Context.Service<
  CellHost,
  {
    readonly call: (
      name: string,
      input: Schema.Json,
    ) => Effect.Effect<Schema.Json, CellEvaluationError>
  }
>()("@gent/extensions/src/cell-worker-boundary/CellHost") {}

/** Only run model source inside a dedicated worker process. Cells evaluate in the
 * worker's own realm, so the full Bun runtime, `require`, and dynamic `import` are
 * available and the process is the isolation unit: one evaluator per process.
 * The process owner enforces wall time, memory, cancellation, and host authority.
 * On interruption it must discard the worker; this adapter cannot stop an await.
 */
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** Indirect eval runs the compiled cell at global scope; replMode declares bindings as global vars. */
// oxlint-disable-next-line no-eval -- Evaluating model source in the worker realm is this adapter's purpose.
const evaluateInRealm: (compiled: string) => unknown = globalThis.eval

export const makeBunCellEvaluator = Effect.gen(function* () {
  const host = yield* CellHost
  const environment = yield* CellWorkerEnvironment
  const runPromise = Effect.runPromiseWith(yield* Effect.context<CellHost>())
  const permit = yield* Semaphore.make(1)
  // The node target keeps `require(...)` calls intact; the bun target rewrites them to import.meta.
  // oxlint-disable-next-line gent/no-bun-outside-adapter -- This worker boundary owns the unmatched Bun transpiler API.
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "node", replMode: true })
  // Display keeps a head and a bounded tail so the end of output (usually the error) survives.
  const output = makeBoundedOutput({
    limit: maximumCellDisplayLength,
    headLimit: maximumCellDisplayHeadLength,
    separator: "\n",
  })
  const append = output.append
  const rendered = output.read
  // oxlint-disable-next-line effect/noUnknownParameters -- VM values can have any JavaScript shape; inspect produces bounded display text.
  const display = (value: unknown): string => {
    if (Predicate.isString(value)) return value
    return inspect(value, {
      depth: 4,
      maxArrayLength: 100,
      maxStringLength: 8192,
      customInspect: false,
      getters: false,
    })
  }
  const write = (...values: ReadonlyArray<unknown>) => {
    append(values.map(display).join(" "))
  }
  // The cell console keeps every host console method; output methods write to the display.
  const hostConsole = globalThis.console
  const console: typeof hostConsole = {
    ...hostConsole,
    log: write,
    info: write,
    warn: write,
    error: write,
    debug: write,
  }
  // A stack lists the worker's own frames (`/$bunfs/root/gent-cell` in the
  // compiled binary, effect internals for a tool lookup) and says nothing
  // about the cell's code, so an error goes back as its name and message, with
  // its cause one level deep. A failed host operation already carries the
  // host's message.
  const errorText = (cause: unknown): string => {
    if (!Predicate.isError(cause)) return display(cause)
    const head = `${cause.name}: ${cause.message}`
    if (Predicate.isUndefined(cause.cause)) return head
    let inner = display(cause.cause)
    if (Predicate.isError(cause.cause)) inner = `${cause.cause.name}: ${cause.cause.message}`
    return `${head}\ncaused by ${inner}`
  }
  const failure = (phase: CellEvaluationError["phase"], cause: unknown) =>
    new CellEvaluationError({
      phase,
      message: Option.liftPredicate(cause, Schema.is(CellEvaluationError))
        .pipe(
          Option.match({
            onNone: () => errorText(cause),
            onSome: (hostFailure) => hostFailure.message,
          }),
        )
        .slice(0, maximumCellDisplayLength),
      output: rendered(),
    })
  // The catalog is data the host already validated. The namespace reads it on every access,
  // so a changed catalog changes the callable paths without rebuilding anything.
  let catalog: ReadonlyArray<CellCatalogEntry> = []
  const toolsNamespace = makeToolNamespace({
    ids: () => catalog.map((entry) => entry.name),
    describe: (id) =>
      Option.map(
        Option.fromUndefinedOr(catalog.find((candidate) => candidate.name === id)),
        (entry) => ({ ...entry, guidelines: [...entry.guidelines] }),
      ),
    call: (id, input) =>
      runPromise(
        Schema.decodeUnknownEffect(Schema.Json)(inputOrEmpty(input)).pipe(
          Effect.mapError((cause) => failure("execute", cause)),
          Effect.flatMap((decoded) => host.call(id, decoded)),
        ),
      ),
  })
  // The context namespace is host-served: every method is one host call under `context.`.
  const contextCall = (operation: string, input: Schema.Json) =>
    runPromise(
      Schema.decodeEffect(Schema.Json)(input).pipe(
        Effect.mapError((cause) => failure("execute", cause)),
        Effect.flatMap((decoded) => host.call(`context.${operation}`, decoded)),
      ),
    )
  const context = {
    status: () => contextCall("status", {}),
    history: (options: { offset?: number; limit?: number } = {}) =>
      contextCall("history", { ...options }),
    read: (id: string, options: { offset?: number; limit?: number } = {}) =>
      contextCall("read", { id: String(id), ...options }),
    compact: (instructions?: string) => {
      if (Predicate.isUndefined(instructions)) return contextCall("compact", {})
      return contextCall("compact", { instructions: String(instructions) })
    },
    newWindow: () => contextCall("newWindow", {}),
  }
  const reserved = new Set(["tools", "context", "console", "require"])
  Object.defineProperty(globalThis, "tools", {
    value: toolsNamespace,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(globalThis, "context", {
    value: context,
    writable: true,
    configurable: true,
  })
  if (!Predicate.isFunction(Reflect.get(globalThis, "require"))) {
    Object.defineProperty(globalThis, "require", {
      value: createRequire(`${environment.workingDirectory}/`),
      writable: true,
      configurable: true,
    })
  }
  // Bindings are the globals a cell adds after this evaluator starts. Eval-declared vars are configurable, so reset can delete them.
  const baseline = new Set(Object.getOwnPropertyNames(globalThis))
  const namespace = () => {
    const bindings = new Map<string, unknown>()
    for (const key of Object.getOwnPropertyNames(globalThis)) {
      if (!baseline.has(key) && !reserved.has(key)) bindings.set(key, Reflect.get(globalThis, key))
    }
    return bindings
  }
  const bindingNames = () => [...namespace().keys()].sort().slice(0, maximumCellBindings)
  const installConsole = (value: typeof hostConsole) =>
    Effect.sync(() => {
      Object.defineProperty(globalThis, "console", { value, writable: true, configurable: true })
    })
  // Only console output taken during the cell returns with it. Later writes go to the process streams.
  const captureConsole = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      installConsole(console),
      () => effect,
      () => installConsole(hostConsole),
    )

  const evaluate = Effect.fn("BunCellEvaluator.evaluate")(function* (source: string) {
    output.reset()
    if (source.length > maximumCellSourceLength) {
      return yield* failure("source", "Cell source exceeds the length limit")
    }
    const compiled = yield* Effect.try({
      try: () => transpiler.transformSync(source),
      catch: (cause) => failure("compile", cause),
    })
    const result = yield* Effect.gen(function* () {
      const started = yield* Effect.try({
        try: (): unknown => evaluateInRealm(compiled),
        catch: (cause) => failure("execute", cause),
      })
      if (!Predicate.isPromiseLike(started)) return started
      return yield* Effect.tryPromise({
        try: () => started,
        catch: (cause) => failure("execute", cause),
      })
    }).pipe(captureConsole)
    // An undefined result shows nothing, as IPython shows nothing for None; the
    // console output the cell wrote is then the whole display.
    if (Predicate.hasProperty(result, "value") && Predicate.isNotUndefined(result.value)) {
      yield* Effect.try({
        try: () => append(display(result.value)),
        catch: (cause) => failure("execute", cause),
      })
    }
    return CellEvaluation.make({
      display: rendered(),
      bindings: bindingNames(),
      truncated: output.truncated(),
    })
  })

  /** Replace the catalog the tools namespace reads. It is not part of the bindings. */
  const setCatalog = (tools: ReadonlyArray<CellCatalogEntry>) =>
    Effect.sync(() => {
      catalog = tools
    })

  /** Encode the namespace in this realm; the codec names every value it cannot carry. */
  const snapshot = Effect.sync(() => encodeSnapshot(namespace()))

  /** Revive in the realm so restored values use its intrinsics. */
  const restore = (bindings: ReadonlyArray<SnapshotBinding>) =>
    Effect.try({
      try: () => {
        const revive = evaluateInRealm(snapshotReviverSource)
        if (!Predicate.isFunction(revive)) return []
        const names: string[] = []
        for (const binding of bindings) {
          if (reserved.has(binding.name) || baseline.has(binding.name)) continue
          Object.defineProperty(globalThis, binding.name, {
            value: revive(encodeJsonText(binding.value)),
            writable: true,
            enumerable: true,
            configurable: true,
          })
          names.push(binding.name)
        }
        return names
      },
      catch: (cause) => failure("execute", cause),
    })

  return {
    evaluate: (source: string) => Semaphore.withPermit(permit, evaluate(source)),
    setCatalog: (tools: ReadonlyArray<CellCatalogEntry>) =>
      Semaphore.withPermit(permit, setCatalog(tools)),
    snapshot: Semaphore.withPermit(permit, snapshot),
    restore: (bindings: ReadonlyArray<SnapshotBinding>) =>
      Semaphore.withPermit(permit, restore(bindings)),
    reset: Semaphore.withPermit(
      permit,
      Effect.sync(() => {
        for (const name of namespace().keys()) Reflect.deleteProperty(globalThis, name)
      }),
    ),
  }
})

// ── worker loop ─────────────────────────────────────────────────────────────

export class CellWorkerTransport extends Context.Service<
  CellWorkerTransport,
  {
    readonly requests: Stream.Stream<CellRequest, CellProtocolError>
    readonly send: (response: CellResponse) => Effect.Effect<void, CellProtocolError>
    /** Marks the end of a cell on the process output streams before its result frame. */
    readonly endCellOutput: (outputToken: string) => Effect.Effect<void, CellProtocolError>
  }
>()("@gent/extensions/src/cell-worker-boundary/CellWorkerTransport") {}

const isHostReply = Predicate.or(
  Predicate.isTagged("HostSucceeded"),
  Predicate.isTagged("HostFailed"),
)

/** Runs only inside the isolated child process. The parent owns process termination. */
export const runCellWorker = Effect.scoped(
  Effect.gen(function* () {
    const transport = yield* CellWorkerTransport
    const fatal = yield* Deferred.make<never, CellProtocolError>()
    const pending = new Map<string, Deferred.Deferred<Schema.Json, CellEvaluationError>>()
    let activeCell = Option.none<string>()
    let operationSequence = 0
    let cellCalls = 0
    const callError = (message: string) =>
      new CellEvaluationError({ phase: "execute", message, output: "" })

    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending.values(), Deferred.interrupt, { discard: true }),
    )

    const kernel = yield* makeBunCellEvaluator.pipe(
      Effect.provideService(CellHost, {
        call: Effect.fn("CellWorker.call")(function* (name, input) {
          if (Option.isNone(activeCell)) return yield* callError("No active cell")
          if (pending.size >= maximumPendingCellCalls || cellCalls >= maximumCallsPerCell) {
            return yield* callError("Cell host-call limit exceeded")
          }
          const cellId = activeCell.value
          const operationId = String(++operationSequence)
          cellCalls++
          const reply = yield* Deferred.make<Schema.Json, CellEvaluationError>()
          pending.set(operationId, reply)
          return yield* transport
            .send(CellResponse.cases.HostCall.make({ cellId, operationId, name, input }))
            .pipe(
              Effect.mapError((error) => callError(error.message)),
              Effect.andThen(Deferred.await(reply)),
              Effect.ensuring(Effect.sync(() => pending.delete(operationId))),
            )
        }),
      }),
    )

    // Leaving the realm clean matters when several workers share one test process.
    yield* Effect.addFinalizer(() => kernel.reset)

    const receive = Effect.fn("CellWorker.receive")(function* (request: CellRequest) {
      if (isHostReply(request)) {
        const reply = Option.fromUndefinedOr(pending.get(request.operationId))
        if (!Option.contains(activeCell, request.cellId) || Option.isNone(reply)) {
          return yield* new CellProtocolError({ message: "Stale or unknown cell host reply" })
        }
        pending.delete(request.operationId)
        if (request._tag === "HostSucceeded") {
          yield* Deferred.succeed(reply.value, request.value)
        } else {
          yield* Deferred.fail(reply.value, callError(request.message))
        }
        return
      }
      if (Option.isSome(activeCell)) {
        return yield* new CellProtocolError({ message: "A cell is already active" })
      }
      if (request._tag === "Reset") {
        yield* kernel.reset
        yield* transport.send(CellResponse.cases.Reset.make({ requestId: request.requestId }))
        return
      }
      if (request._tag === "Snapshot") {
        const snapshot = yield* kernel.snapshot
        yield* transport.send(
          CellResponse.cases.Snapshot.make({ requestId: request.requestId, snapshot }),
        )
        return
      }
      if (request._tag === "Restore") {
        const bindings = yield* kernel
          .restore(request.bindings)
          .pipe(Effect.mapError((error) => new CellProtocolError({ message: error.message })))
        yield* transport.send(
          CellResponse.cases.Restored.make({ requestId: request.requestId, bindings }),
        )
        return
      }
      if (Predicate.isNotUndefined(request.catalog)) yield* kernel.setCatalog(request.catalog.tools)
      activeCell = Option.some(request.cellId)
      cellCalls = 0
      yield* kernel.evaluate(request.source).pipe(
        Effect.match({
          onFailure: (error) => CellResponse.cases.Failed.make({ cellId: request.cellId, error }),
          onSuccess: (result) =>
            CellResponse.cases.Evaluated.make({ cellId: request.cellId, result }),
        }),
        Effect.tap(() => transport.endCellOutput(request.outputToken)),
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            // A script can end before its host calls settle: a rejected
            // Promise.all leaves the others in flight. The cell ends when the
            // last one does, so the host never sees an orphaned call.
            while (pending.size > 0) {
              yield* Effect.forEach(
                Array.from(pending.values()),
                (reply) => Effect.ignore(Deferred.await(reply)),
                { discard: true },
              )
            }
            activeCell = Option.none()
            yield* transport.send(response)
          }),
        ),
        Effect.catchCause((cause) => Deferred.failCause(fatal, cause)),
        Effect.forkScoped,
      )
    })

    yield* transport.send(CellResponse.cases.Ready.make({ version: 1 }))
    yield* transport.requests.pipe(
      Stream.runForEach(receive),
      Effect.raceFirst(Deferred.await(fatal)),
    )
  }),
)

// ── process entry ───────────────────────────────────────────────────────────

/** Frames use dedicated descriptors so cell code keeps stdout and stderr for itself.
 * The host points the worker's stderr at its stdout, so both reach one ordered pipe. */
const DescriptorTransport = Layer.effect(
  CellWorkerTransport,
  Effect.gen(function* () {
    const outputPermit = yield* Semaphore.make(1)
    const ioError = (cause: unknown) => new CellProtocolError({ message: String(cause) })
    const requestBytes = Stream.fromReadableStream({
      // oxlint-disable-next-line effect/noGlobals, gent/no-bun-outside-adapter -- The worker entry owns its process descriptors through Bun
      evaluate: () => Bun.file(cellRequestFd).stream(),
      onError: ioError,
    })
    // oxlint-disable-next-line effect/noGlobals, gent/no-bun-outside-adapter -- The worker entry owns its process descriptors through Bun
    const responses = Bun.file(cellResponseFd)
    // The callback fires once the stream handed the marker to the OS, so everything the
    // cell wrote to the same stream before it is already in the pipe.
    const writeMarker = (stream: NodeJS.WriteStream, marker: string) =>
      Effect.callback<void, CellProtocolError>((resume) => {
        stream.write(marker, (error) => {
          if (Predicate.isNotNullish(error)) resume(Effect.fail(ioError(error)))
          else resume(Effect.void)
        })
      })
    const writeAll = (bytes: Uint8Array) =>
      Effect.tryPromise({
        // oxlint-disable-next-line effect/noGlobals, gent/no-bun-outside-adapter -- The worker entry owns its process descriptors through Bun
        try: () => Bun.write(responses, bytes),
        catch: ioError,
      }).pipe(Effect.asVoid)
    return CellWorkerTransport.of({
      requests: Stream.suspend(() => {
        const reader = makeCellFrameReader()
        return requestBytes.pipe(
          Stream.mapEffect(reader.push),
          Stream.flatMap(Stream.fromIterable),
          Stream.mapEffect(decodeCellRequest),
          Stream.concat(Stream.fromEffect(reader.end).pipe(Stream.drain)),
        )
      }),
      // stderr is the same pipe as stdout, so one marker closes all cell output.
      endCellOutput: Effect.fn("CellWorkerTransport.endCellOutput")((outputToken) =>
        // oxlint-disable-next-line effect/noGlobals -- The worker entry owns its process descriptors through Bun
        writeMarker(process.stdout, cellOutputBoundary(outputToken)),
      ),
      send: Effect.fn("CellWorkerTransport.send")((response) =>
        Semaphore.withPermit(
          outputPermit,
          encodeCellResponse(response).pipe(Effect.flatMap(writeAll)),
        ),
      ),
    })
  }),
)

/**
 * macOS has no parent-death signal, and a cell in a synchronous loop never
 * yields to the event loop, so neither a transport read nor a signal handler
 * can notice that the host died. A separate thread can: it sees the kernel
 * reparent this process and kills it. The thread never keeps the worker alive.
 */
const watchParent = () => {
  const source = `const host = ${process.ppid}
setInterval(() => {
  if (process.ppid !== host) process.kill(process.pid, "SIGKILL")
}, 250)`
  // oxlint-disable-next-line effect/noGlobals -- the watchdog must be an OS thread that runs while a cell blocks the main thread; an Effect Worker runs on the blocked loop.
  return new Worker(URL.createObjectURL(new Blob([source])), { ref: false })
}

/**
 * Runs the worker loop with no signal handler: a JavaScript handler cannot run
 * while a cell holds the thread, so SIGTERM keeps its default action and ends
 * the process. The process exits when the loop ends, so a timer or socket a cell
 * left open never outlives the transport.
 */
const runWorkerMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  // oxlint-disable-next-line effect/noGlobals -- the worker entry is a process adapter; exit ends timers and sockets a cell left open.
  fiber.addObserver((exit) => teardown(exit, (code) => process.exit(code)))
})

// The parent launches this entry with the request and response descriptors attached.
// A test that imports the evaluator or the worker loop is not that parent, so the
// entry only runs when this file is the process's own entry point.
if (import.meta.main) {
  watchParent()
  runWorkerMain(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(
          Layer.merge(
            DescriptorTransport,
            Layer.succeed(
              CellWorkerEnvironment,
              // oxlint-disable-next-line gent/no-bun-outside-adapter -- the worker process entry reads its own working directory once
              CellWorkerEnvironment.of({ workingDirectory: process.cwd() }),
            ),
          ),
        )
        yield* Effect.provideContext(runCellWorker, services)
      }),
    ),
  )
}
