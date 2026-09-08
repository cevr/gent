/* oxlint-disable effect/noGlobals, effect/noNodeBuiltinImport -- Bun compilation and realm evaluation belong to this worker-only adapter. */
import { Context, Effect, Predicate, Schema, Semaphore } from "effect"
import { createRequire } from "node:module"
import { inspect } from "node:util"

import {
  catalogPageSize,
  type CellCatalogEntry,
  CellEvaluation,
  CellEvaluationError,
  maximumCellBindings,
  maximumCellDisplayHeadLength,
  maximumCellDisplayLength,
  maximumCellSourceLength,
} from "./cell-protocol.js"
import { encodeSnapshot, type SnapshotBinding, snapshotReviverSource } from "./cell-snapshot.js"

/** Facts about the worker process, supplied by its entry. */
export class CellWorkerEnvironment extends Context.Service<
  CellWorkerEnvironment,
  {
    /** Base for `require` resolution; the host launched the worker here. */
    readonly workingDirectory: string
  }
>()("@gent/core/src/runtime/code-cell/bun-evaluator-boundary/CellWorkerEnvironment") {}

/** The worker transport supplies this proxy. It never supplies Gent host services. */
export class CellHost extends Context.Service<
  CellHost,
  {
    readonly call: (
      name: string,
      input: Schema.Json,
    ) => Effect.Effect<Schema.Json, CellEvaluationError>
  }
>()("@gent/core/src/runtime/code-cell/bun-evaluator-boundary/CellHost") {}

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
  const tailLength = maximumCellDisplayLength - maximumCellDisplayHeadLength
  let head = ""
  let tail = ""
  let omitted = 0
  let truncated = false
  const append = (text: string) => {
    let separator = ""
    if (head.length > 0 || tail.length > 0) separator = "\n"
    const next = separator + text
    const headRoom = maximumCellDisplayHeadLength - head.length
    if (headRoom >= next.length) {
      head += next
      return
    }
    head += next.slice(0, headRoom)
    const rest = next.slice(headRoom)
    truncated = true
    tail += rest
    if (tail.length > tailLength) {
      omitted += tail.length - tailLength
      tail = tail.slice(tail.length - tailLength)
    }
  }
  const rendered = () => {
    if (!truncated) return head
    return `${head}\n... [${omitted} characters omitted] ...\n${tail}`
  }
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
  const failure = (phase: CellEvaluationError["phase"], cause: unknown) =>
    new CellEvaluationError({
      phase,
      message: display(cause).slice(0, maximumCellDisplayLength),
      output: rendered(),
    })
  // The catalog is data the host already validated. Search and describe never leave the worker.
  let catalog: ReadonlyArray<CellCatalogEntry> = []
  const search = (query: string = "", offset: number = 0) => {
    const needle = String(query).toLowerCase()
    const matches = catalog.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        entry.description.toLowerCase().includes(needle),
    )
    const start = Math.max(0, Math.trunc(Number(offset)) || 0)
    const page = matches.slice(start, start + catalogPageSize)
    return {
      tools: page.map((entry) => ({ name: entry.name, description: entry.description })),
      total: matches.length,
      nextOffset: start + page.length,
    }
  }
  const describe = (name: string) => {
    const entry = catalog.find((candidate) => candidate.name === String(name))
    if (Predicate.isUndefined(entry)) {
      // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- This runs inside model code in the VM realm; a thrown Error is the cell's failure contract, like any host call rejection.
      throw new Error(`Tool ${String(name)} is not selected for this turn`)
    }
    return { ...entry, guidelines: [...entry.guidelines] }
  }
  const proxy = {
    search,
    describe,
    call: (name: string, input: Schema.Json) =>
      runPromise(
        Effect.all([
          Schema.decodeEffect(Schema.String)(name),
          Schema.decodeEffect(Schema.Json)(input),
        ]).pipe(
          Effect.mapError((cause) => failure("execute", cause)),
          Effect.flatMap(([name, input]) => host.call(name, input)),
        ),
      ),
  }
  const reserved = new Set(["tools", "console", "require"])
  Object.defineProperty(globalThis, "tools", { value: proxy, writable: true, configurable: true })
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
    head = ""
    tail = ""
    omitted = 0
    truncated = false
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
    if (Predicate.hasProperty(result, "value")) {
      yield* Effect.try({
        try: () => append(display(result.value)),
        catch: (cause) => failure("execute", cause),
      })
    }
    return CellEvaluation.make({ display: rendered(), bindings: bindingNames(), truncated })
  })

  /** Replace the catalog that search and describe read. It is not part of the namespace. */
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
