import { Effect, Option, Schema } from "effect"
import { CellSnapshot, SnapshotBinding, SnapshotOmission } from "./cell-snapshot.js"

export const maximumCellSourceLength = 256 * 1024
export const maximumCellDisplayLength = 64 * 1024
export const maximumCellBindings = 1024
export const maximumCellFrameBytes = 1024 * 1024
export const maximumCellDisplayHeadLength = 48 * 1024
export const maximumPendingCellCalls = 32
export const maximumCallsPerCell = 4096
const maximumCatalogEntries = 512
export const catalogPageSize = 20

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

/** Restored names and named omissions from the last host-owned snapshot. */
export const CellRestoreReport = Schema.Struct({
  restored: Schema.Array(Schema.String),
  omitted: Schema.Array(SnapshotOmission),
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
