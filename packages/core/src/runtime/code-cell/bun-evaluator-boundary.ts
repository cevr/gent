/* oxlint-disable effect/noGlobals, effect/noNodeBuiltinImport -- Bun compilation and VM evaluation belong to this worker-only adapter. */
import { Context, Effect, Predicate, Schema, Semaphore } from "effect"
import { inspect } from "node:util"
import { createContext, runInContext } from "node:vm"

import {
  CellEvaluation,
  CellEvaluationError,
  maximumCellBindings,
  maximumCellDisplayHeadLength,
  maximumCellDisplayLength,
  maximumCellSourceLength,
} from "./cell-protocol.js"
import { encodeSnapshot, type SnapshotBinding, snapshotReviverSource } from "./cell-snapshot.js"

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

/** Only run model source inside an isolated worker. node:vm is not a sandbox.
 * The process owner enforces wall time, memory, cancellation, and host authority.
 * On interruption it must discard the worker; this adapter cannot stop an await.
 */
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

export const makeBunCellEvaluator = Effect.gen(function* () {
  const host = yield* CellHost
  const runPromise = Effect.runPromiseWith(yield* Effect.context<CellHost>())
  const permit = yield* Semaphore.make(1)
  // oxlint-disable-next-line gent/no-bun-outside-adapter -- This worker boundary owns the unmatched Bun transpiler API.
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun", replMode: true })
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
  const console = { log: write, info: write, warn: write, error: write, debug: write }
  const failure = (phase: CellEvaluationError["phase"], cause: unknown) =>
    new CellEvaluationError({
      phase,
      message: display(cause).slice(0, maximumCellDisplayLength),
      output: rendered(),
    })
  const proxy = {
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
  const freshContext = () => createContext({ tools: proxy, console })
  let context = freshContext()
  const reserved = new Set(["tools", "console"])
  const namespace = () => new Map(Object.entries(context).filter(([key]) => !reserved.has(key)))
  const bindingNames = () => [...namespace().keys()].sort().slice(0, maximumCellBindings)

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
    let result = yield* Effect.try({
      try: (): unknown => runInContext(compiled, context),
      catch: (cause) => failure("execute", cause),
    })
    if (Predicate.isPromiseLike(result)) {
      const pending = result
      result = yield* Effect.tryPromise({
        try: () => pending,
        catch: (cause) => failure("execute", cause),
      })
    }
    if (Predicate.hasProperty(result, "value")) {
      yield* Effect.try({
        try: () => append(display(result.value)),
        catch: (cause) => failure("execute", cause),
      })
    }
    return CellEvaluation.make({ display: rendered(), bindings: bindingNames(), truncated })
  })

  /** Encode the namespace in this realm; the codec names every value it cannot carry. */
  const snapshot = Effect.sync(() => encodeSnapshot(namespace()))

  /** Revive inside the context so restored values use the context's intrinsics. */
  const restore = (bindings: ReadonlyArray<SnapshotBinding>) =>
    Effect.try({
      try: () => {
        const revive: unknown = runInContext(snapshotReviverSource, context)
        if (!Predicate.isFunction(revive)) return []
        const names: string[] = []
        for (const binding of bindings) {
          if (reserved.has(binding.name)) continue
          Object.defineProperty(context, binding.name, {
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
    snapshot: Semaphore.withPermit(permit, snapshot),
    restore: (bindings: ReadonlyArray<SnapshotBinding>) =>
      Semaphore.withPermit(permit, restore(bindings)),
    reset: Semaphore.withPermit(
      permit,
      Effect.sync(() => {
        context = freshContext()
      }),
    ),
  }
})
