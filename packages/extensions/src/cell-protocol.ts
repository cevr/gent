import { Effect, Option, Predicate, Schema } from "effect"

// ── namespace snapshot codec ────────────────────────────────────────────────

/**
 * Namespace snapshots move cell bindings between a worker and the host as
 * tagged JSON. The worker encodes in its own realm with realm-agnostic checks;
 * the vm context decodes with a reviver that runs inside the context, so
 * restored dates, maps, sets, and errors carry the context's own intrinsics.
 */
export const maximumSnapshotBindingBytes = 256 * 1024
const maximumSnapshotBytes = 768 * 1024
const maximumSnapshotDepth = 64

const SnapshotOmission = Schema.Struct({
  name: Schema.String,
  reason: Schema.Literals(["function", "unsupported", "cyclic", "too-deep", "too-large"]),
})
type SnapshotOmission = typeof SnapshotOmission.Type
type OmissionReason = SnapshotOmission["reason"]

export const SnapshotBinding = Schema.Struct({ name: Schema.String, value: Schema.Json })
export type SnapshotBinding = typeof SnapshotBinding.Type

export const CellSnapshot = Schema.Struct({
  bindings: Schema.Array(SnapshotBinding),
  omitted: Schema.Array(SnapshotOmission),
})
export type CellSnapshot = typeof CellSnapshot.Type

const TAG = "$gent"

/** A value that cannot round-trip. It never enters the encoded JSON. */
class Omitted {
  constructor(readonly reason: OmissionReason) {}
}
type Encoded = Schema.Json | Omitted
const isOmitted = (value: Encoded): value is Omitted => value instanceof Omitted

const tagged = (kind: string, value: Schema.Json): Schema.Json => ({ [TAG]: kind, value })
/** Effect's isObject excludes arrays; snapshots treat both as references. */
// oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const isReference = (value: unknown): value is object =>
  Predicate.isObject(value) || Array.isArray(value)
// oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const tagOf = (value: unknown) => Object.prototype.toString.call(value).slice(8, -1)

/** Plain means its prototype is null or a root Object.prototype from any realm. */
// oxlint-disable-next-line effect/noObjectParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const isPlainObject = (value: object) => {
  const proto: unknown = Object.getPrototypeOf(value)
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  return proto === null || Object.getPrototypeOf(proto) === null
}

interface ElementView extends ArrayBufferView {
  readonly length: number
  readonly [index: number]: number | bigint
}
const isElementView = (view: ArrayBufferView): view is ElementView =>
  Predicate.hasProperty(view, "length") && Predicate.isNumber(view.length)

/** Typed arrays travel as element lists; bigint elements travel as strings. */
const elements = (view: ElementView): Schema.Json => {
  const values: Schema.Json[] = []
  for (let index = 0; index < view.length; index++) {
    const item = view[index]
    if (Predicate.isBigInt(item)) values.push(item.toString())
    else if (Predicate.isNumber(item)) values.push(item)
  }
  return values
}

const typedArrayKinds = new Set([
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "Uint8ClampedArray",
  "BigInt64Array",
  "BigUint64Array",
])

// oxlint-disable-next-line effect/noNullish, effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodePrimitive = (value: unknown): Encoded | undefined => {
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) return value
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  if (Predicate.isUndefined(value)) return tagged("undefined", null)
  if (Predicate.isNumber(value)) {
    if (Number.isFinite(value)) return value
    return tagged("number", String(value))
  }
  if (Predicate.isBigInt(value)) return tagged("bigint", value.toString())
  if (Predicate.isFunction(value)) return new Omitted("function")
  if (!isReference(value)) return new Omitted("unsupported")
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  return undefined
}

// oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodeList = (items: ReadonlyArray<unknown>, inner: (item: unknown) => Encoded): Encoded => {
  const out: Schema.Json[] = []
  for (const item of items) {
    const encoded = inner(item)
    if (isOmitted(encoded)) return encoded
    out.push(encoded)
  }
  return out
}

const ownProperty = (value: Schema.Json): PropertyDescriptor => ({
  value,
  writable: true,
  enumerable: true,
  configurable: true,
})

const encodeRecord = (
  entries: ReadonlyArray<readonly [string, unknown]>,
  // oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  inner: (item: unknown) => Encoded,
): Encoded => {
  const out: Record<string, Schema.Json> = {}
  for (const [key, item] of entries) {
    const encoded = inner(item)
    if (isOmitted(encoded)) return encoded
    // Assignment to an own `__proto__` key would set the prototype and drop the key.
    Object.defineProperty(out, key, ownProperty(encoded))
  }
  if (Predicate.hasProperty(out, TAG)) return tagged("object", out)
  return out
}

// oxlint-disable-next-line effect/noNullish, effect/noUnknownParameters, effect/noObjectParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodeBuiltin = (value: object, inner: (item: unknown) => Encoded): Encoded | undefined => {
  const kind = tagOf(value)
  if (kind === "Date") return tagged("date", Date.prototype.getTime.call(value))
  if (
    kind === "RegExp" &&
    Predicate.hasProperty(value, "source") &&
    Predicate.hasProperty(value, "flags")
  )
    return tagged("regexp", [String(value.source), String(value.flags)])
  if (kind === "Error" && Predicate.hasProperty(value, "message")) {
    let name = "Error"
    if (Predicate.hasProperty(value, "name")) name = String(value.name)
    let stack = ""
    if (Predicate.hasProperty(value, "stack")) stack = String(value.stack)
    return tagged("error", { name, message: String(value.message), stack })
  }
  if (kind === "Map") {
    const entries: Iterable<[unknown, unknown]> = Map.prototype.entries.call(value)
    const pairs = encodeList([...entries], (pair) => {
      if (!Array.isArray(pair)) return new Omitted("unsupported")
      return encodeList(pair, inner)
    })
    if (isOmitted(pairs)) return pairs
    return tagged("map", pairs)
  }
  if (kind === "Set") {
    const values: Iterable<unknown> = Set.prototype.values.call(value)
    const list = encodeList([...values], inner)
    if (isOmitted(list)) return list
    return tagged("set", list)
  }
  if (ArrayBuffer.isView(value)) {
    if (!typedArrayKinds.has(kind) || !isElementView(value)) return new Omitted("unsupported")
    return tagged(kind, elements(value))
  }
  // oxlint-disable-next-line effect/noNullish -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  return undefined
}

// oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const encodeValue = (value: unknown, depth: number, seen: Set<object>): Encoded => {
  if (depth > maximumSnapshotDepth) return new Omitted("too-deep")
  const primitive = encodePrimitive(value)
  if (!Predicate.isUndefined(primitive)) return primitive
  if (!isReference(value)) return new Omitted("unsupported")
  const object: object = value
  if (seen.has(object)) return new Omitted("cyclic")
  seen.add(object)
  // oxlint-disable-next-line effect/noUnknownParameters -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
  const inner = (child: unknown) => encodeValue(child, depth + 1, seen)
  let encoded: Encoded
  const builtin = encodeBuiltin(object, inner)
  if (!Predicate.isUndefined(builtin)) encoded = builtin
  else if (Array.isArray(object)) encoded = encodeList(object, inner)
  else if (isPlainObject(object)) encoded = encodeRecord(Object.entries(object), inner)
  else encoded = new Omitted("unsupported")
  seen.delete(object)
  return encoded
}

// oxlint-disable-next-line effect/noGlobals -- the realm-boundary codec inspects arbitrary JavaScript values and encodes JSON null and undefined
const jsonBytes = (value: Schema.Json) => new TextEncoder().encode(JSON.stringify(value)).byteLength

/** Encode every binding. Values that cannot round-trip are named with the reason, never silently dropped. */
export const encodeSnapshot = (namespace: ReadonlyMap<string, unknown>): CellSnapshot => {
  const bindings: SnapshotBinding[] = []
  const omitted: SnapshotOmission[] = []
  let total = 0
  for (const [name, value] of namespace) {
    const encoded = encodeValue(value, 0, new Set())
    if (isOmitted(encoded)) {
      omitted.push({ name, reason: encoded.reason })
      continue
    }
    const size = jsonBytes(encoded)
    if (size > maximumSnapshotBindingBytes || total + size > maximumSnapshotBytes) {
      omitted.push({ name, reason: "too-large" })
      continue
    }
    total += size
    bindings.push({ name, value: encoded })
  }
  return { bindings, omitted }
}

// oxlint-disable-next-line effect/noGlobals -- the reviver source embeds the tag as a JavaScript literal
const TAG_LITERAL = JSON.stringify(TAG)

/**
 * Source for a reviver that runs inside the vm context. It returns a function
 * from encoded JSON text to a value built from the context's own intrinsics.
 */
export const snapshotReviverSource = `(function () {
  var TAG = ${TAG_LITERAL};
  // defineProperty, not assignment: an own "__proto__" key stays a key.
  var put = function (target, key, value) {
    Object.defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
  };
  var revive = function (value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(revive);
    if (typeof value[TAG] !== "string") {
      var out = {};
      for (var key in value) put(out, key, revive(value[key]));
      return out;
    }
    var kind = value[TAG];
    var inner = value.value;
    switch (kind) {
      case "undefined": return undefined;
      case "number": return Number(inner);
      case "bigint": return BigInt(inner);
      case "date": return new Date(inner);
      case "regexp": return new RegExp(inner[0], inner[1]);
      case "error": { var error = new Error(inner.message); error.name = inner.name; error.stack = inner.stack; return error; }
      case "map": return new Map(inner.map(function (pair) { return [revive(pair[0]), revive(pair[1])]; }));
      case "set": return new Set(inner.map(revive));
      case "object": { var plain = {}; for (var name in inner) put(plain, name, revive(inner[name])); return plain; }
      default: {
        var Ctor = globalThis[kind];
        if (kind === "BigInt64Array" || kind === "BigUint64Array") return Ctor.from(inner.map(BigInt));
        return Ctor.from(inner);
      }
    }
  };
  return function (text) { return revive(JSON.parse(text)); };
})()`

// ── frames ──────────────────────────────────────────────────────────────────

export const maximumCellSourceLength = 256 * 1024
export const maximumCellDisplayLength = 64 * 1024
export const maximumCellBindings = 1024
export const maximumCellFrameBytes = 1024 * 1024
export const maximumCellDisplayHeadLength = 48 * 1024
export const maximumPendingCellCalls = 32
export const maximumCallsPerCell = 4096
const maximumCatalogEntries = 512

/** A tool id segment that needs no brackets in a property path. */
const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const encodeSegment = Schema.encodeSync(Schema.fromJsonString(Schema.String))

/**
 * Keys JavaScript reads on its own or already defines on a function: `await`
 * reads `then`, `JSON.stringify` reads `toJSON`, coercion reads `toString`.
 * On a `tools` node these keep their JavaScript meaning and never name a tool,
 * so an id with such a segment is reached through `tools(id)` instead.
 */
export const reservedToolSegments: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  ...Object.getOwnPropertyNames(Function.prototype),
  "prototype",
  "then",
  "toJSON",
  "inspect",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
])

/**
 * The source a model writes to reach `id`: `tools.delegate.start`,
 * `tools["must-not-run"]`, or `tools("read.then")` when a segment is reserved.
 */
export const toolPath = (id: string): string => {
  const segments = id.split(".")
  if (segments.some((segment) => reservedToolSegments.has(segment))) {
    return `tools(${encodeSegment(id)})`
  }
  return segments
    .map((segment) => {
      if (identifierSegment.test(segment)) return `.${segment}`
      return `[${encodeSegment(segment)}]`
    })
    .reduce((path, segment) => `${path}${segment}`, "tools")
}

/** One selected host tool as the kernel describes it. Descriptions never grant execution. */
export const CellCatalogEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  guidelines: Schema.Array(Schema.String),
  parameters: Schema.Json,
})
export type CellCatalogEntry = typeof CellCatalogEntry.Type

/** The kernel keeps the last catalog it received; the host resends only when the hash changes. */
export const CellCatalog = Schema.Struct({
  hash: Schema.String,
  tools: Schema.Array(CellCatalogEntry).check(Schema.isMaxLength(maximumCatalogEntries)),
})
export type CellCatalog = typeof CellCatalog.Type

export class CellEvaluationError extends Schema.TaggedError<CellEvaluationError>()(
  "CellEvaluationError",
  {
    phase: Schema.Literals(["source", "compile", "execute"]),
    message: Schema.String,
    output: Schema.String,
  },
) {}

/**
 * Restored names and named omissions from the last host-owned snapshot.
 * `previousSession` is present when the snapshot came from the previous
 * session of the thread, as after a handoff; absent, it is this branch's own.
 */
export const CellRestoreReport = Schema.Struct({
  restored: Schema.Array(Schema.String),
  omitted: Schema.Array(SnapshotOmission),
  previousSession: Schema.optional(Schema.String),
})
export type CellRestoreReport = typeof CellRestoreReport.Type

export const CellEvaluation = Schema.Struct({
  display: Schema.String,
  bindings: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
  /** Present on the first evaluation after a worker was restored from a snapshot. */
  restored: Schema.optional(CellRestoreReport),
})
export type CellEvaluation = typeof CellEvaluation.Type

const CorrelationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

export const CellRequest = Schema.TaggedUnion({
  Evaluate: {
    cellId: CorrelationId,
    /** Unpredictable per-evaluation token the worker echoes in its output boundary. */
    outputToken: CorrelationId,
    source: Schema.String.check(Schema.isMaxLength(maximumCellSourceLength)),
    /** Present only when the host catalog changed since the worker last received one. */
    catalog: Schema.optional(CellCatalog),
  },
  Reset: { requestId: CorrelationId },
  Snapshot: { requestId: CorrelationId },
  Restore: { requestId: CorrelationId, bindings: Schema.Array(SnapshotBinding) },
  HostSucceeded: { cellId: CorrelationId, operationId: CorrelationId, value: Schema.Json },
  HostFailed: { cellId: CorrelationId, operationId: CorrelationId, message: Schema.String },
})
export type CellRequest = typeof CellRequest.Type

export const CellResponse = Schema.TaggedUnion({
  Ready: { version: Schema.Literal(1) },
  Evaluated: { cellId: CorrelationId, result: CellEvaluation },
  Failed: { cellId: CorrelationId, error: CellEvaluationError },
  Reset: { requestId: CorrelationId },
  Snapshot: { requestId: CorrelationId, snapshot: CellSnapshot },
  Restored: { requestId: CorrelationId, bindings: Schema.Array(Schema.String) },
  HostCall: {
    cellId: CorrelationId,
    operationId: CorrelationId,
    name: Schema.String,
    input: Schema.Json,
  },
})
export type CellResponse = typeof CellResponse.Type

export class CellProtocolError extends Schema.TaggedError<CellProtocolError>()(
  "CellProtocolError",
  { message: Schema.String },
) {}

const protocolError = (cause: unknown) => new CellProtocolError({ message: String(cause) })
const requestCodec = Schema.fromJsonString(CellRequest)
const responseCodec = Schema.fromJsonString(CellResponse)

export const decodeCellRequest = (frame: string) =>
  Schema.decodeEffect(requestCodec)(frame).pipe(Effect.mapError(protocolError))
export const decodeCellResponse = (frame: string) =>
  Schema.decodeEffect(responseCodec)(frame).pipe(Effect.mapError(protocolError))

const frameBytes = (text: string): Effect.Effect<Uint8Array, CellProtocolError> => {
  const bytes = new TextEncoder().encode(text + "\n")
  if (bytes.byteLength - 1 > maximumCellFrameBytes) {
    return Effect.fail(new CellProtocolError({ message: "Cell frame exceeds the byte limit" }))
  }
  return Effect.succeed(bytes)
}

export const encodeCellRequest = (request: CellRequest) =>
  Schema.encodeEffect(requestCodec)(request).pipe(
    Effect.mapError(protocolError),
    Effect.flatMap(frameBytes),
  )
export const encodeCellResponse = (response: CellResponse) =>
  Schema.encodeEffect(responseCodec)(response).pipe(
    Effect.mapError(protocolError),
    Effect.flatMap(frameBytes),
  )

/** A separate reader belongs to each pipe. It bounds incomplete lines before JSON decoding. */
export const makeCellFrameReader = () => {
  const buffer = new Uint8Array(maximumCellFrameBytes)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let length = 0
  return {
    push: (chunk: Uint8Array): Effect.Effect<ReadonlyArray<string>, CellProtocolError> =>
      Effect.gen(function* () {
        const frames: string[] = []
        for (const byte of chunk) {
          if (byte === 10) {
            if (length > 0) {
              const frame = yield* Effect.try({
                try: () => decoder.decode(buffer.subarray(0, length)),
                catch: protocolError,
              })
              frames.push(frame)
            }
            length = 0
          } else {
            if (length === maximumCellFrameBytes) {
              return yield* new CellProtocolError({ message: "Cell frame exceeds the byte limit" })
            }
            buffer[length++] = byte
          }
        }
        return frames
      }),
    end: Effect.suspend(() => {
      if (length === 0) return Effect.void
      return Effect.fail(new CellProtocolError({ message: "Cell pipe closed during a frame" }))
    }),
  }
}

const boundaryDelimiter = "\u001e"
const boundaryPrefix = "gent-cell-end "
const maximumBoundaryTokenLength = 128
const maximumBoundaryLength =
  boundaryDelimiter.length * 2 + boundaryPrefix.length + maximumBoundaryTokenLength

/** The worker writes this to its output pipe after a cell, before its result frame. */
export const cellOutputBoundary = (token: string) =>
  `${boundaryDelimiter}${boundaryPrefix}${token}${boundaryDelimiter}`

/** Cell text in arrival order; a boundary closes the text that came before it. */
export interface CellOutputSegment {
  readonly text: string
  readonly boundary: Option.Option<string>
}

/**
 * Splits one output stream into text and boundaries, whatever the chunk splits are.
 * Only a well-formed boundary carrying the expected token counts; anything else,
 * including a boundary for another token, stays text.
 */
export const makeCellOutputScanner = (expected: () => Option.Option<string>) => {
  let pending = ""
  return {
    push: (chunk: string): ReadonlyArray<CellOutputSegment> => {
      let input = pending + chunk
      pending = ""
      const segments: CellOutputSegment[] = []
      let text = ""
      while (input.length > 0) {
        const start = input.indexOf(boundaryDelimiter)
        if (start === -1) {
          text += input
          break
        }
        text += input.slice(0, start)
        const end = input.indexOf(boundaryDelimiter, start + 1)
        if (end === -1) {
          if (input.length - start > maximumBoundaryLength) {
            text += boundaryDelimiter
            input = input.slice(start + 1)
            continue
          }
          pending = input.slice(start)
          break
        }
        const candidate = input.slice(start + 1, end)
        const token = candidate.slice(boundaryPrefix.length)
        const wellFormed =
          candidate.startsWith(boundaryPrefix) &&
          token.length > 0 &&
          token.length <= maximumBoundaryTokenLength
        if (wellFormed && Option.contains(expected(), token)) {
          segments.push({ text, boundary: Option.some(token) })
          text = ""
          input = input.slice(end + 1)
        } else {
          text += input.slice(start, end)
          input = input.slice(end)
        }
      }
      if (text.length > 0) segments.push({ text, boundary: Option.none() })
      return segments
    },
    /** Text held back as a possible boundary when the stream closes. */
    end: (): string => {
      const rest = pending
      pending = ""
      return rest
    },
  }
}

/** A bounded accumulator of output text: a head, an omitted count, and a bounded tail. */
interface BoundedOutput {
  /** Add text; anything past the head spills into the bounded tail. */
  readonly append: (text: string) => void
  /** The accumulated text, with an omission notice when anything was dropped. */
  readonly read: () => string
  /** `read()`, then reset to empty. */
  readonly take: () => string
  /** Whether any text has been dropped. */
  readonly truncated: () => boolean
  /** Reset to empty without reading. */
  readonly reset: () => void
}

/**
 * Keeps the first `headLimit` characters and the last `limit - headLimit`, so the
 * end of a long output — usually the error — survives alongside its beginning.
 * `separator` goes between appends once anything has been written.
 */
export const makeBoundedOutput = (options: {
  readonly limit: number
  readonly headLimit: number
  readonly separator?: string
}): BoundedOutput => {
  const separator = options.separator ?? ""
  const tailLimit = Math.max(0, options.limit - options.headLimit)
  let head = ""
  let tail = ""
  let omitted = 0
  // Text that spilled past the head but still fits is whole: no notice until
  // a character is really dropped.
  const read = (): string => {
    if (omitted === 0) return head + tail
    return `${head}\n... [${omitted} characters omitted] ...\n${tail}`
  }
  const reset = (): void => {
    head = ""
    tail = ""
    omitted = 0
  }
  return {
    append: (text: string): void => {
      let lead = ""
      if (head.length > 0 || tail.length > 0) lead = separator
      const next = lead + text
      const headRoom = Math.max(0, options.headLimit - head.length)
      if (headRoom >= next.length) {
        head += next
        return
      }
      head += next.slice(0, headRoom)
      tail += next.slice(headRoom)
      if (tail.length > tailLimit) {
        omitted += tail.length - tailLimit
        tail = tail.slice(tail.length - tailLimit)
      }
    },
    read,
    take: (): string => {
      const result = read()
      reset()
      return result
    },
    truncated: () => omitted > 0,
    reset,
  }
}

// ── descriptors ─────────────────────────────────────────────────────────────

/** Worker-to-host frames travel on this descriptor; the worker owns stdout for cell output. */
export const cellResponseFd = 3
/** Host-to-worker frames travel on this descriptor. */
export const cellRequestFd = 4
