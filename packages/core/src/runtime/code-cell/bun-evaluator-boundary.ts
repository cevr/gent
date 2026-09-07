/* oxlint-disable effect/noGlobals, effect/noNodeBuiltinImport -- Bun compilation and VM evaluation belong to this worker-only adapter. */
import { Context, Effect, Predicate, Schema, Semaphore } from "effect"
import { inspect } from "node:util"
import { createContext, runInContext } from "node:vm"

import {
  CellEvaluation,
  CellEvaluationError,
  maximumCellBindings,
  maximumCellDisplayLength,
  maximumCellSourceLength,
} from "./cell-protocol.js"

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
export const makeBunCellEvaluator = Effect.gen(function* () {
  const host = yield* CellHost
  const runPromise = Effect.runPromiseWith(yield* Effect.context<CellHost>())
  const permit = yield* Semaphore.make(1)
  // oxlint-disable-next-line gent/no-bun-outside-adapter -- This worker boundary owns the unmatched Bun transpiler API.
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun", replMode: true })
  let output = ""
  let truncated = false
  const append = (text: string) => {
    let separator = ""
    if (output.length > 0) separator = "\n"
    const remaining = maximumCellDisplayLength - output.length
    const next = separator + text
    if (next.length > remaining) truncated = true
    output += next.slice(0, remaining)
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
    if (output.length >= maximumCellDisplayLength) {
      truncated = true
      return
    }
    append(values.map(display).join(" "))
  }
  const console = { log: write, info: write, warn: write, error: write, debug: write }
  const failure = (phase: CellEvaluationError["phase"], cause: unknown) =>
    new CellEvaluationError({
      phase,
      message: display(cause).slice(0, maximumCellDisplayLength),
      output,
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

  const evaluate = Effect.fn("BunCellEvaluator.evaluate")(function* (source: string) {
    output = ""
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
    return CellEvaluation.make({
      display: output,
      bindings: Object.keys(context)
        .filter((key) => key !== "tools" && key !== "console")
        .sort()
        .slice(0, maximumCellBindings),
      truncated,
    })
  })

  return {
    evaluate: (source: string) => Semaphore.withPermit(permit, evaluate(source)),
    reset: Semaphore.withPermit(
      permit,
      Effect.sync(() => {
        context = freshContext()
      }),
    ),
  }
})
