import { Effect, Option, Schema } from "effect"

// ── namespace snapshot ──────────────────────────────────────────────────────

/**
 * Namespace snapshots move cell bindings between a worker and the host as
 * tagged JSON. The worker encodes in its own realm (`encodeSnapshot` in
 * `cell-value.ts`). The reviver runs inside the realm that restores, so
 * restored dates, maps, sets, and errors carry its intrinsics.
 */
const SnapshotOmission = Schema.Struct({
  name: Schema.String,
  reason: Schema.Literals(["function", "unsupported", "cyclic", "too-deep", "too-large"]),
})
export type SnapshotOmission = typeof SnapshotOmission.Type

export const SnapshotBinding = Schema.Struct({ name: Schema.String, value: Schema.Json })
export type SnapshotBinding = typeof SnapshotBinding.Type

export const CellSnapshot = Schema.Struct({
  bindings: Schema.Array(SnapshotBinding),
  omitted: Schema.Array(SnapshotOmission),
})
export type CellSnapshot = typeof CellSnapshot.Type

/** The key that marks a tagged value in snapshot JSON. */
export const snapshotTag = "$gent"

// oxlint-disable-next-line effect/noGlobals -- the reviver source embeds the tag as a JavaScript literal
const TAG_LITERAL = JSON.stringify(snapshotTag)

/**
 * Source for a reviver that runs inside the realm that evaluates it. It returns a function
 * from encoded JSON text to a value built from that realm's own intrinsics.
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
/** The bytes a host reply's value or failure message may take; the rest of its frame is the envelope. */
export const maximumCellReplyBytes = maximumCellFrameBytes - 4 * 1024
export const maximumCellDisplayHeadLength = 48 * 1024
export const maximumPendingCellCalls = 32
export const maximumCallsPerCell = 4096
/**
 * The tool images one cell result carries to the model: the newest it shows.
 * A request takes at most 5 images on Chat Completions and leaves out its
 * oldest 5 at a time (`Model.imageLimit`, `toolImagesToDrop`), so one cell
 * result never passes a request's bound alone and never makes a request drop
 * images it just sent.
 */
export const maximumCellImages = 5

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
 * Root keys of `tools` that are discovery functions, not tool paths:
 * `tools.search(query)`. An id whose first segment is one of them is reached
 * through `tools(id)`; deeper segments stay paths.
 */
export const toolDiscoveryKeys: ReadonlySet<string> = new Set(["search"])

/**
 * The host call name of an operation of a host-served namespace (`context`,
 * `models`). Namespace calls share the host call channel with tool calls,
 * whose name is the tool id. A tool id never holds `:` (`isWireToolId`), so a
 * namespace call cannot collide with a tool such as `models.compare`.
 */
export const namespaceCallName = (namespace: "context" | "models", operation: string): string =>
  `${namespace}:${operation}`

/**
 * The one order for tool ids: by UTF-16 code unit. It is total and does not
 * read the process locale, so a listing sorted by it is byte-stable.
 */
export const compareIds = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * The source a model writes to reach `id`: `tools.delegate.start`,
 * `tools["must-not-run"]`, or `tools("read.then")` when a segment is reserved
 * or the first segment is a discovery key.
 */
export const toolPath = (id: string): string => {
  const segments = id.split(".")
  if (
    toolDiscoveryKeys.has(segments[0] ?? "") ||
    segments.some((segment) => reservedToolSegments.has(segment))
  ) {
    return `tools(${encodeSegment(id)})`
  }
  return segments
    .map((segment) => {
      if (identifierSegment.test(segment)) return `.${segment}`
      return `[${encodeSegment(segment)}]`
    })
    .reduce((path, segment) => `${path}${segment}`, "tools")
}

/**
 * One selected host tool as the host describes it. The worker holds only its
 * listing; `await tools(id)` fetches the rest with a `Describe`. Descriptions
 * never grant execution.
 */
export const CellCatalogEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  guidelines: Schema.Array(Schema.String),
  parameters: Schema.Json,
  /** The typed call line the host renders, which `tools(id).signature` holds. */
  signature: Schema.String,
  /** The description's first line, which `tools.search(query)` returns. */
  summary: Schema.String,
})
export type CellCatalogEntry = typeof CellCatalogEntry.Type

/** The host's catalog for one evaluation, hashed so an unchanged one is not sent again. */
export const CellCatalog = Schema.Struct({
  hash: Schema.String,
  tools: Schema.Array(CellCatalogEntry),
})
export type CellCatalog = typeof CellCatalog.Type

/**
 * What the worker holds of each tool: its id, typed call line and summary,
 * so the `Evaluate` frame stays small with hundreds of tools. The schema,
 * guidelines and description stay on the host.
 */
export const CellCatalogListing = Schema.Struct({
  name: Schema.String,
  signature: Schema.String,
  summary: Schema.String,
})
export type CellCatalogListing = typeof CellCatalogListing.Type

/** The listing of a host catalog; the worker keeps the last one it received. */
const CellListing = Schema.Struct({
  hash: Schema.String,
  tools: Schema.Array(CellCatalogListing),
})
type CellListing = typeof CellListing.Type

/** The worker's listing of `catalog`. */
export const listingOf = (catalog: CellCatalog): CellListing => ({
  hash: catalog.hash,
  tools: catalog.tools.map(({ name, signature, summary }) => ({ name, signature, summary })),
})

/** What `await tools(id)` resolves to: the tool's full description, served by the host. */
const CellToolDetails = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  guidelines: Schema.Array(Schema.String),
  parameters: Schema.Json,
  signature: Schema.String,
})
type CellToolDetails = typeof CellToolDetails.Type

/** The details `await tools(id)` reads for `entry`. */
export const toolDetailsOf = (entry: CellCatalogEntry): CellToolDetails => ({
  id: entry.name,
  description: entry.description,
  guidelines: entry.guidelines,
  parameters: entry.parameters,
  signature: entry.signature,
})

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
  /**
   * The bindings the cell added or bound to another value. A result stored
   * before `bindingCount` existed lists every binding.
   */
  bindings: Schema.Array(Schema.String),
  /** How many bindings the namespace holds after the cell; absent on older results. */
  bindingCount: Schema.optional(Schema.Natural),
  truncated: Schema.Boolean,
  /** Present on the first evaluation after a worker was restored from a snapshot. */
  restored: Schema.optional(CellRestoreReport),
  /**
   * The tool images the cell showed (returned or logged), oldest first, at
   * most `maximumCellImages`. The worker sends each as the data fields of an
   * object tagged `ToolImage`; the host keeps those that decode as a
   * `ToolImage`, and the model receives each as an image after the result.
   * Absent when the cell showed none, and on older results.
   */
  images: Schema.optional(Schema.Array(Schema.JsonObject)),
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
    catalog: Schema.optional(CellListing),
  },
  Reset: { requestId: CorrelationId },
  Snapshot: { requestId: CorrelationId },
  Restore: { requestId: CorrelationId, bindings: Schema.Array(SnapshotBinding) },
  HostSucceeded: { cellId: CorrelationId, operationId: CorrelationId, value: Schema.Json },
  HostFailed: { cellId: CorrelationId, operationId: CorrelationId, message: Schema.String },
})
export type CellRequest = typeof CellRequest.Type

/**
 * Globals or built-ins the worker could not put back; the host replaces a
 * worker that names any.
 */
const Unrestored = Schema.optional(Schema.Array(Schema.String))

export const CellResponse = Schema.TaggedUnion({
  Ready: { version: Schema.Literal(1) },
  Evaluated: { cellId: CorrelationId, result: CellEvaluation, unrestored: Unrestored },
  Failed: { cellId: CorrelationId, error: CellEvaluationError, unrestored: Unrestored },
  Reset: { requestId: CorrelationId, unrestored: Unrestored },
  Snapshot: { requestId: CorrelationId, snapshot: CellSnapshot, unrestored: Unrestored },
  Restored: { requestId: CorrelationId, bindings: Schema.Array(Schema.String) },
  HostCall: {
    cellId: CorrelationId,
    operationId: CorrelationId,
    name: Schema.String,
    input: Schema.Json,
  },
  /**
   * `await tools(id)`: the host answers with a `HostSucceeded` carrying the
   * tool's `CellToolDetails`, or a `HostFailed`. Not a host call: it runs no
   * tool and leaves no receipt.
   */
  Describe: { cellId: CorrelationId, operationId: CorrelationId, id: Schema.String },
})
export type CellResponse = typeof CellResponse.Type

/** Why a frame was refused, when a caller branches on it: past `maximumCellFrameBytes`. */
export const CellFrameRefusal = Schema.Literal("frame-too-large")

export class CellProtocolError extends Schema.TaggedError<CellProtocolError>()(
  "CellProtocolError",
  { message: Schema.String, reason: Schema.optional(CellFrameRefusal) },
) {}

const frameTooLarge = () =>
  new CellProtocolError({ message: "Cell frame exceeds the byte limit", reason: "frame-too-large" })

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
    return Effect.fail(frameTooLarge())
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
              return yield* frameTooLarge()
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

// ── code-point cuts ─────────────────────────────────────────────────────────

// Core's `headChars` and `tailChars` rule for the worker side: a cut never
// leaves half of a surrogate pair, which a provider refuses. The worker
// bundle loads no core module (the core entry would grow it from 0.36 MB to
// over 1 MB), so the worker keeps this copy; host code uses core's.

const splitsPairAt = (text: string, index: number): boolean => {
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/** The head of `text`, at most `maxChars` UTF-16 units, cut between code points. */
export const cutHead = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text
  const end = Math.max(0, maxChars)
  return text.slice(0, end - Number(splitsPairAt(text, end)))
}

/** The tail of `text`, at most `maxChars` UTF-16 units, cut between code points. */
export const cutTail = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text
  const start = text.length - Math.max(0, maxChars)
  return text.slice(start + Number(splitsPairAt(text, start)))
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
      // The head takes text only while nothing has passed it.
      let added = ""
      if (tail.length === 0 && omitted === 0) added = cutHead(next, options.headLimit - head.length)
      head += added
      if (added.length === next.length) return
      tail += next.slice(added.length)
      if (tail.length > tailLimit) {
        const kept = cutTail(tail, tailLimit)
        omitted += tail.length - kept.length
        tail = kept
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
