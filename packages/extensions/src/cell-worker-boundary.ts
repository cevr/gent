import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Result,
  Runtime,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { AsyncLocalStorage } from "node:async_hooks"
import { createRequire } from "node:module"
import { inspect, types } from "node:util"
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
  inheritsFrom,
  isOrdinaryArray,
  makeBoundedOutput,
  makeCellFrameReader,
  maximumCallsPerCell,
  maximumCellBindings,
  maximumCellDisplayHeadLength,
  maximumCellDisplayLength,
  maximumCellSourceLength,
  maximumPendingCellCalls,
  readDataProperty,
  readProperty,
  type SnapshotBinding,
  snapshotReviverSource,
} from "./cell-protocol.js"

/** Uncaught errors kept for the next cell; later ones between two cells are dropped. */
const maximumStrayErrors = 20

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
    /**
     * Errors cell code raised outside any awaited path: a timer's throw, a
     * rejection nobody awaits, a host call nobody awaits that fails. The entry
     * feeds them from the process's uncaught handlers, so they reach the cell
     * output instead of ending the worker.
     */
    readonly uncaught: Stream.Stream<UncaughtError>
  }
>()("@gent/extensions/src/cell-worker-boundary/CellWorkerEnvironment") {}

/**
 * The cell whose code is running. Each evaluation runs under its own number,
 * and timers and promise continuations the cell starts keep it. Bun runs the
 * `unhandledRejection` handler, and the handler for a throw in a microtask,
 * without it: those errors have no known origin.
 */
const cellOrigin = new AsyncLocalStorage<number>()

/** An error cell code raised outside any awaited path, with the cell that raised it when known. */
interface UncaughtError {
  readonly cause: unknown
  readonly origin: Option.Option<number>
}

/** Read in the process's uncaught handler, while the throwing callback's context is still current. */
const uncaughtError = (cause: unknown): UncaughtError => ({
  cause,
  origin: Option.fromUndefinedOr(cellOrigin.getStore()),
})

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

/** Inner errors an `AggregateError` lists before it counts the rest. */
const AGGREGATE_DETAIL_LIMIT = 3
/** The stderr a `ShellError` shows, from its end. */
const SHELL_STDERR_LIMIT = 2000

/** What a thrown value shows when it cannot be read without running cell code: a Proxy, for one. */
const UNREADABLE_ERROR_TEXT = "A thrown value that cannot be read"
/** What stands for a cause that cannot be read without running cell code. */
const UNREADABLE_CAUSE_LINE = "caused by (a value that cannot be read)"

/** Taken when the worker loads: a cell may replace the globals later. */
const errorPrototype: object = Error.prototype
const aggregateErrorPrototype: object = AggregateError.prototype
const evaluationErrorPrototype: object = CellEvaluationError.prototype
const isUint8Array = types.isUint8Array

/**
 * Whether a value is an `Error` by its prototype chain, as `instanceof`
 * asks, with no trap run; unreadable when a Proxy sits on the chain.
 */
// oxlint-disable-next-line effect/noUnknownParameters -- a thrown value has any JavaScript shape
const errorValue = (value: unknown) => inheritsFrom(value, errorPrototype)

/**
 * A property of a thrown value, read through the value reader, so a getter
 * the cell wrote and a Proxy trap never run; none when absent or unreadable.
 * A host getter runs: Bun keeps a `BuildMessage`'s message and position
 * behind one. A host getter can still throw; `errorText` catches that.
 */
// oxlint-disable-next-line effect/noObjectParameters -- a thrown value has any JavaScript shape; descriptors read it without running its getters
const errorProperty = (target: object, key: string): Option.Option<unknown> =>
  Result.getOrElse(readProperty(target, key), () => Option.none())

/** `name: message`, each read only when its value is a string. */
// oxlint-disable-next-line effect/noObjectParameters -- a thrown value has any JavaScript shape
const errorLine = (error: object) => {
  const name = Option.getOrElse(
    Option.filter(errorProperty(error, "name"), Predicate.isString),
    () => "Error",
  )
  return Option.match(Option.filter(errorProperty(error, "message"), Predicate.isString), {
    onNone: () => name,
    onSome: (message) => `${name}: ${message}`,
  })
}

/** Where a Bun `BuildMessage` (a cell syntax error) points. */
const BuildPosition = Schema.Struct({
  line: Schema.Finite,
  column: Schema.Finite,
  lineText: Schema.optional(Schema.String),
})

/** The fields a Node or Bun system error carries beside its message, in the order shown. */
const SYSTEM_ERROR_FIELDS = ["code", "errno", "syscall", "path", "dest", "address", "port"]
/** The longest value one system error field shows. */
const SYSTEM_ERROR_FIELD_LIMIT = 200

/**
 * One line of the system error fields an error holds as scalar data; none
 * gives no line. Only data counts: a `DOMException` keeps a legacy numeric
 * `code` behind a host getter, and that says nothing a model can use.
 */
// oxlint-disable-next-line effect/noObjectParameters -- a thrown value has any JavaScript shape
const systemErrorFields = (error: object): ReadonlyArray<string> => {
  const fields = SYSTEM_ERROR_FIELDS.flatMap((key) =>
    Option.match(
      Option.filter(
        Result.getOrElse(readDataProperty(error, key), () => Option.none()),
        Predicate.or(Predicate.isString, Predicate.isNumber),
      ),
      {
        onNone: () => [],
        onSome: (value) => [`${key}: ${String(value).slice(0, SYSTEM_ERROR_FIELD_LIMIT)}`],
      },
    ),
  )
  if (fields.length === 0) return []
  return [`  ${fields.join(", ")}`]
}

/**
 * An `AggregateError`'s first inner errors, one line each with its position
 * below it when it has one, and a count of the rest. Bun splits one syntax
 * error into several `BuildMessage`s, and each one points somewhere.
 */
const aggregateDetail = (inner: ReadonlyArray<unknown>): ReadonlyArray<string> => {
  const listed = Array.from({ length: Math.min(inner.length, AGGREGATE_DETAIL_LIMIT) }, (_, i) =>
    Option.match(errorProperty(inner, String(i)), {
      onNone: () => "  (an inner value that cannot be read)",
      onSome: (each) => {
        if (!Predicate.isObjectKeyword(each)) return `  ${String(each)}`
        return Result.match(errorValue(each), {
          onFailure: () => "  (an inner value that cannot be read)",
          onSuccess: (isError) => {
            if (!isError) return "  (an inner value that is not an error)"
            return Option.match(positionDetail(each), {
              onNone: () => `  ${errorLine(each)}`,
              onSome: (position) => `  ${errorLine(each)}\n  ${position}`,
            })
          },
        })
      },
    }),
  )
  const rest = inner.length - listed.length
  if (rest > 0) return [...listed, `  … ${rest} more`]
  return listed
}

/** A `BuildMessage`'s position as one line; none for any other error. */
// oxlint-disable-next-line effect/noObjectParameters -- a thrown value has any JavaScript shape
const positionDetail = (error: object): Option.Option<string> =>
  Option.filter(errorProperty(error, "position"), Predicate.isObjectKeyword).pipe(
    Option.flatMap((where) =>
      Schema.decodeUnknownOption(BuildPosition)({
        line: Option.getOrUndefined(errorProperty(where, "line")),
        column: Option.getOrUndefined(errorProperty(where, "column")),
        lineText: Option.getOrUndefined(errorProperty(where, "lineText")),
      }),
    ),
    Option.map(({ line, column, lineText }) => {
      const at = `  at line ${line}, column ${column}`
      if (Predicate.isUndefined(lineText)) return at
      return `${at}: ${lineText.trim()}`
    }),
  )

/**
 * The detail an error keeps outside its message, one line each and with no
 * stack: an `AggregateError`'s inner errors, a `BuildMessage`'s position, a
 * `ShellError`'s stderr, or a system error's code, path and syscall.
 */
// oxlint-disable-next-line effect/noObjectParameters -- a thrown value has any JavaScript shape
const errorDetail = (error: object): ReadonlyArray<string> => {
  const inner = Option.filter(errorProperty(error, "errors"), isOrdinaryArray)
  const aggregate = Result.getOrElse(inheritsFrom(error, aggregateErrorPrototype), () => false)
  if (aggregate && Option.isSome(inner)) return aggregateDetail(inner.value)
  const position = positionDetail(error)
  if (Option.isSome(position)) return [position.value]
  const stderr = Option.filter(errorProperty(error, "stderr"), isUint8Array)
  if (Option.isSome(stderr)) {
    const text = new TextDecoder().decode(stderr.value).trim()
    if (text.length === 0) return []
    return [`stderr: ${text.slice(-SHELL_STDERR_LIMIT)}`]
  }
  return systemErrorFields(error)
}

/** The namespaces `tools` and `context` read: the latest evaluator's. */
const hostNamespaces = new Map<string, unknown>()
/**
 * Install a host namespace once per realm, as an accessor that is not
 * configurable and whose setter throws. A cell that declares or assigns
 * `tools` or `context` fails with this message; one that deletes or
 * redefines it fails, or is refused. So no cell can make either namespace
 * unrecoverable, and no reset needs to put one back.
 */
// oxlint-disable-next-line effect/noUnknownParameters -- a namespace is whatever the evaluator built
const installHostNamespace = (name: "tools" | "context", value: unknown) => {
  hostNamespaces.set(name, value)
  const installed = Option.exists(
    Option.fromUndefinedOr(Object.getOwnPropertyDescriptor(globalThis, name)),
    (descriptor) => descriptor.configurable === false,
  )
  if (installed) return
  Object.defineProperty(globalThis, name, {
    get: () => hostNamespaces.get(name),
    set: () => {
      // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- a JavaScript setter refuses an assignment only by throwing
      throw new TypeError(`${name} is the host ${name} namespace; choose another name`)
    },
    enumerable: false,
    configurable: false,
  })
}

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
  // `inspect` shows no getter, but it reads `Symbol.toStringTag` with a plain
  // get and walks the prototype chain, so a getter or trap the cell wrote there
  // can run. The value reader covers error fields and the snapshot, not this.
  // oxlint-disable-next-line effect/noUnknownParameters -- VM values can have any JavaScript shape; inspect produces bounded display text.
  const display = (value: unknown): string => {
    if (Predicate.isString(value)) return value
    // A caught error the cell logs or returns reads as it does uncaught: no worker stack.
    if (Result.getOrElse(errorValue(value), () => false)) return errorText(value)
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
  // A value whose prototype chain holds a Proxy cannot be read: its traps are
  // cell code. Each part of an error reads on its own, so a part that throws
  // (a host getter, or `inspect` running a cell's `Symbol.toStringTag` getter)
  // leaves its fallback in its place and the other parts stand.
  const part = (
    render: () => ReadonlyArray<string>,
    fallback: ReadonlyArray<string>,
  ): ReadonlyArray<string> => Option.getOrElse(Option.liftThrowable(render)(), () => fallback)
  // oxlint-disable-next-line effect/noUnknownParameters -- a cause has any JavaScript shape
  const causeLine = (inner: unknown): string =>
    Result.match(errorValue(inner), {
      onFailure: () => UNREADABLE_CAUSE_LINE,
      onSuccess: (isError) => {
        // An Error cause stops at its own line: never recurse, so a looped or deep chain cannot overflow.
        if (isError && Predicate.isObjectKeyword(inner)) return `caused by ${errorLine(inner)}`
        return `caused by ${display(inner)}`
      },
    })
  const renderError = (cause: unknown): string =>
    Result.match(errorValue(cause), {
      onFailure: () => UNREADABLE_ERROR_TEXT,
      onSuccess: (isError) => {
        if (!isError || !Predicate.isObjectKeyword(cause)) return display(cause)
        return [
          ...part(() => [errorLine(cause)], [UNREADABLE_ERROR_TEXT]),
          ...part(() => errorDetail(cause), []),
          ...part(
            () =>
              Option.toArray(
                Option.map(
                  Option.filter(errorProperty(cause, "cause"), Predicate.isNotUndefined),
                  causeLine,
                ),
              ),
            [UNREADABLE_CAUSE_LINE],
          ),
        ].join("\n")
      },
    })
  /**
   * The one guard every error text goes through: a host getter that throws
   * gives `UNREADABLE_ERROR_TEXT`, never a worker death.
   */
  const total =
    (render: (cause: unknown) => string) =>
    (cause: unknown): string =>
      Option.getOrElse(Option.liftThrowable(render)(cause), () => UNREADABLE_ERROR_TEXT)
  const errorText = total(renderError)
  // A cell can catch a host failure and change it before it throws it again,
  // so its message is read like any other.
  const failureText = total((cause) => {
    const hostFailure = Result.getOrElse(inheritsFrom(cause, evaluationErrorPrototype), () => false)
    if (!hostFailure || !Predicate.isObjectKeyword(cause)) return renderError(cause)
    return Option.getOrElse(
      Option.filter(errorProperty(cause, "message"), Predicate.isString),
      () => renderError(cause),
    )
  })
  const failure = (phase: CellEvaluationError["phase"], cause: unknown) =>
    new CellEvaluationError({
      phase,
      message: failureText(cause).slice(0, maximumCellDisplayLength),
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
  installHostNamespace("tools", toolsNamespace)
  installHostNamespace("context", context)
  if (!Predicate.isFunction(Reflect.get(globalThis, "require"))) {
    Object.defineProperty(globalThis, "require", {
      value: createRequire(`${environment.workingDirectory}/`),
      writable: true,
      configurable: true,
    })
  }
  /**
   * Every global as this evaluator found it, by descriptor. A binding is a
   * global a cell added, or one whose value, accessor or flags it changed: a
   * cell that declares `prompt` or `performance` binds it like any new name.
   */
  const baseline = new Map<string, PropertyDescriptor>(
    Object.getOwnPropertyNames(globalThis).flatMap((key) =>
      Option.toArray(
        Option.map(
          Option.fromUndefinedOr(Object.getOwnPropertyDescriptor(globalThis, key)),
          (descriptor): readonly [string, PropertyDescriptor] => [key, descriptor],
        ),
      ),
    ),
  )
  /**
   * Globals the host rewrites while it runs: Effect keeps the running fiber
   * in one. They are never a binding and a reset never touches them.
   */
  const hostGlobals = new Set(["~effect/Fiber/currentFiber"])
  const descriptorFields = ["value", "get", "set", "writable", "enumerable", "configurable"]
  const sameDescriptor = (left: PropertyDescriptor, right: PropertyDescriptor) =>
    descriptorFields.every((field) =>
      Object.is(Reflect.get(left, field), Reflect.get(right, field)),
    )
  /**
   * Whether a cell added, rebound, redefined or deleted this global since the
   * evaluator started. A changed flag counts: a global made read-only is not
   * the global the evaluator found.
   */
  const changed = (key: string) =>
    !hostGlobals.has(key) &&
    Option.match(Option.fromUndefinedOr(baseline.get(key)), {
      onNone: () => true,
      onSome: (found) =>
        !Option.exists(
          Option.fromUndefinedOr(Object.getOwnPropertyDescriptor(globalThis, key)),
          (current) => sameDescriptor(found, current),
        ),
    })
  const bindingKeys = () => Object.getOwnPropertyNames(globalThis).filter(changed)
  /**
   * Put one global back as the evaluator found it, or remove it when the
   * evaluator found none; false when the realm refuses. Eval-declared vars
   * are configurable, but a cell can define a global that is not, and
   * `Reflect` refuses rather than throws.
   */
  const restoreGlobal = (key: string): boolean =>
    Option.match(Option.fromUndefinedOr(baseline.get(key)), {
      onNone: () => Reflect.deleteProperty(globalThis, key),
      onSome: (descriptor) => Reflect.defineProperty(globalThis, key, descriptor),
    })
  /**
   * Each binding's value, read from its descriptor: an accessor gives its
   * getter, which the snapshot names as a function, so reading the namespace
   * never runs cell code.
   */
  const namespace = () => {
    const bindings = new Map<string, unknown>()
    for (const key of bindingKeys()) {
      const descriptor = Option.fromUndefinedOr(Object.getOwnPropertyDescriptor(globalThis, key))
      if (Option.isNone(descriptor)) continue
      if ("value" in descriptor.value) bindings.set(key, descriptor.value.value)
      else bindings.set(key, Reflect.get(descriptor.value, "get"))
    }
    return bindings
  }
  /**
   * The value each binding held when a result last reported the namespace. A
   * result names only the bindings its cell added or bound to another value,
   * with the count of all: every result stays in the history, so a full list
   * on each would grow with cells times bindings. A value changed in place
   * keeps its binding and is not named.
   */
  let reported = new Map<string, unknown>()
  const reportBindings = () => {
    const current = namespace()
    const named = [...current.entries()]
      .filter(([name, value]) => !reported.has(name) || !Object.is(reported.get(name), value))
      .map(([name]) => name)
      .sort()
      .slice(0, maximumCellBindings)
    reported = current
    return { bindings: named, bindingCount: current.size }
  }
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

  // An uncaught error is shown only where its origin is known. One from the
  // running cell goes to that cell's output. One from an earlier cell, or
  // with no known origin, waits for the next cell with its label: it is never
  // the running cell's error. The wait is bounded, like the output.
  // Before the first cell no cell code exists in this worker, so an error
  // with no known origin is the worker's own: it fails, and the worker ends.
  // After a cell ran, its timers and promises outlive it and a reset, so such
  // an error may be cell code and waits for the next cell.
  let cellNumber = 0
  let running = Option.none<number>()
  let strays: Array<string> = []
  const reportUncaught = (error: UncaughtError) =>
    Effect.gen(function* () {
      const text = errorText(error.cause)
      if (Option.isNone(error.origin) && cellNumber === 0) {
        return yield* new CellProtocolError({
          message: `Worker fault before any cell ran: ${text}`,
        })
      }
      if (Option.isSome(error.origin) && Option.contains(running, error.origin.value)) {
        return append(`Uncaught: ${text}`)
      }
      if (strays.length >= maximumStrayErrors) return
      if (Option.isSome(error.origin)) {
        strays.push(`Uncaught (from cell ${error.origin.value}): ${text}`)
        return
      }
      strays.push(`Uncaught (origin unknown: an unawaited promise or microtask): ${text}`)
    })

  const evaluate = Effect.fn("BunCellEvaluator.evaluate")(function* (source: string) {
    output.reset()
    for (const text of strays) append(text)
    strays = []
    if (source.length > maximumCellSourceLength) {
      return yield* failure("source", "Cell source exceeds the length limit")
    }
    const compiled = yield* Effect.try({
      try: () => transpiler.transformSync(source),
      catch: (cause) => failure("compile", cause),
    })
    const origin = ++cellNumber
    running = Option.some(origin)
    const result = yield* Effect.gen(function* () {
      const started = yield* Effect.try({
        // Timers and continuations the cell starts keep its number.
        try: (): unknown => cellOrigin.run(origin, () => evaluateInRealm(compiled)),
        catch: (cause) => failure("execute", cause),
      })
      if (!Predicate.isPromiseLike(started)) return started
      return yield* Effect.tryPromise({
        try: () => started,
        catch: (cause) => failure("execute", cause),
      })
    }).pipe(
      captureConsole,
      Effect.ensuring(
        Effect.sync(() => {
          running = Option.none()
        }),
      ),
    )
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
      ...reportBindings(),
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
          if (hostGlobals.has(binding.name)) continue
          // A binding may rebind a worker global; one that is not configurable stays as it is.
          const defined = Reflect.defineProperty(globalThis, binding.name, {
            value: revive(encodeJsonText(binding.value)),
            writable: true,
            enumerable: true,
            configurable: true,
          })
          if (defined) names.push(binding.name)
        }
        // The restore report names these; the next result names only what its cell binds.
        reported = namespace()
        return names
      },
      catch: (cause) => failure("execute", cause),
    })

  return {
    evaluate: (source: string) => Semaphore.withPermit(permit, evaluate(source)),
    /** Never waits for the permit: the error may come from the running cell. */
    reportUncaught,
    setCatalog: (tools: ReadonlyArray<CellCatalogEntry>) =>
      Semaphore.withPermit(permit, setCatalog(tools)),
    snapshot: Semaphore.withPermit(permit, snapshot),
    restore: (bindings: ReadonlyArray<SnapshotBinding>) =>
      Semaphore.withPermit(permit, restore(bindings)),
    reset: Semaphore.withPermit(
      permit,
      Effect.sync((): ReadonlyArray<string> => {
        // Every global back as the evaluator found it: added names go, rebound or deleted ones return.
        // A global the realm will not put back is named: the host replaces this worker.
        const names = new Set([...Object.getOwnPropertyNames(globalThis), ...baseline.keys()])
        const unrestored = [...names].filter((name) => changed(name) && !restoreGlobal(name))
        reported = new Map()
        return unrestored
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
    const environment = yield* CellWorkerEnvironment
    // A worker's own fault ends the worker; the kernel starts a new one.
    yield* Stream.runForEach(environment.uncaught, kernel.reportUncaught).pipe(
      Effect.catchCause((cause) => Deferred.failCause(fatal, cause)),
      Effect.forkScoped,
    )

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
        const unrestored = yield* kernel.reset
        yield* transport.send(
          CellResponse.cases.Reset.make({ requestId: request.requestId, unrestored }),
        )
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
        // Cell code runs in this process, so an error it raises outside its
        // awaited code would end the worker. It goes to the cell output instead;
        // one with no known origin before any cell ran still ends the worker.
        const uncaught = yield* Queue.unbounded<UncaughtError>()
        // The origin is read here, inside the handler, where the throwing
        // callback's context is still current.
        const report = (cause: unknown) => {
          Queue.offerUnsafe(uncaught, uncaughtError(cause))
        }
        process.on("uncaughtException", report)
        process.on("unhandledRejection", report)
        const services = yield* Layer.build(
          Layer.merge(
            DescriptorTransport,
            Layer.succeed(
              CellWorkerEnvironment,
              CellWorkerEnvironment.of({
                // oxlint-disable-next-line gent/no-bun-outside-adapter -- the worker process entry reads its own working directory once
                workingDirectory: process.cwd(),
                uncaught: Stream.fromQueue(uncaught),
              }),
            ),
          ),
        )
        yield* Effect.provideContext(runCellWorker, services)
      }),
    ),
  )
}
