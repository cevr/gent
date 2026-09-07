import { Effect, Schema } from "effect"

export const maximumCellSourceLength = 256 * 1024
export const maximumCellDisplayLength = 64 * 1024
export const maximumCellBindings = 1024
export const maximumCellFrameBytes = 1024 * 1024
export const maximumPendingCellCalls = 32
export const maximumCallsPerCell = 4096

export class CellEvaluationError extends Schema.TaggedError<CellEvaluationError>()(
  "CellEvaluationError",
  {
    phase: Schema.Literals(["source", "compile", "execute"]),
    message: Schema.String,
    output: Schema.String,
  },
) {}

export const CellEvaluation = Schema.Struct({
  display: Schema.String,
  bindings: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
})
export type CellEvaluation = typeof CellEvaluation.Type

const CorrelationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

export const CellRequest = Schema.TaggedUnion({
  Evaluate: {
    cellId: CorrelationId,
    source: Schema.String.check(Schema.isMaxLength(maximumCellSourceLength)),
  },
  Reset: { requestId: CorrelationId },
  HostSucceeded: { cellId: CorrelationId, operationId: CorrelationId, value: Schema.Json },
  HostFailed: { cellId: CorrelationId, operationId: CorrelationId, message: Schema.String },
})
export type CellRequest = typeof CellRequest.Type

export const CellResponse = Schema.TaggedUnion({
  Ready: { version: Schema.Literal(1) },
  Evaluated: { cellId: CorrelationId, result: CellEvaluation },
  Failed: { cellId: CorrelationId, error: CellEvaluationError },
  Reset: { requestId: CorrelationId },
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
