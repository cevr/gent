/**
 * In-memory ACP peer at the stdio Stream/Sink boundary.
 *
 * `makeAcpConnection` takes only `{ stdin, stdout }`, so a pair of
 * queues substitutes for a subprocess and the *real* connection runs:
 * real NDJSON framing, the real pending-request map, the real reader and
 * writer fibers, the real `AcpClosedError` path. A stub at the
 * `AcpConnection` interface would skip every one of those.
 *
 * The peer records each line the client wrote and answers scripted
 * requests. Tests drive it with `waitForRequest` (no sleeps) and push
 * agent-side notifications with `notify`.
 */
import type { Cause } from "effect"
import { Effect, Predicate, Queue, Schema, Sink, Stream } from "effect"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const WireRecord = Schema.Record(Schema.String, Schema.Unknown)
type WireRecord = Schema.Schema.Type<typeof WireRecord>
const decodeWire = Schema.decodeUnknownSync(Schema.fromJsonString(WireRecord))
const encodeWire = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/**
 * A JSON-RPC payload as it exists on the wire: shape-checked only after
 * routing, exactly as `protocol.ts` types its own params and results.
 */
type WirePayload = Schema.Schema.Type<typeof Schema.Unknown>

/** One JSON-RPC message the client sent to the peer. */
export interface PeerRequest {
  readonly method: string
  readonly id: number
  readonly params: WirePayload
}

export interface FakeAcpPeer {
  /** The `{ stdin, stdout }` pair `makeAcpConnection` consumes. */
  readonly proc: {
    readonly stdin: Sink.Sink<void, Uint8Array, never, never>
    readonly stdout: Stream.Stream<Uint8Array, never>
  }
  /** Every framed line the client wrote, in order. */
  readonly written: Effect.Effect<ReadonlyArray<string>>
  /** Block until the client sends `method`; returns its id and params. */
  readonly waitForRequest: (method: string) => Effect.Effect<PeerRequest>
  /** Answer a client request with a JSON-RPC result. */
  readonly reply: (id: number, result: WirePayload) => Effect.Effect<void>
  /** Answer a client request with a JSON-RPC error. */
  readonly replyError: (id: number, code: number, message: string) => Effect.Effect<void>
  /** Push a `session/update` notification from the agent. */
  readonly notify: (sessionId: string, update: WirePayload) => Effect.Effect<void>
  /** Emit a raw line (framing tests: partial chunks, junk, blank lines). */
  readonly emitRaw: (chunk: string) => Effect.Effect<void>
  /** End the agent's stdout, as a dead subprocess would. */
  readonly endStdout: Effect.Effect<void>
}

export const makeFakeAcpPeer: Effect.Effect<FakeAcpPeer> = Effect.gen(function* () {
  const toAgent = yield* Queue.unbounded<string>()
  const toClient = yield* Queue.unbounded<Uint8Array, Cause.Done>()

  const seen: Array<string> = []

  const stdin: Sink.Sink<void, Uint8Array, never, never> = Sink.forEach((bytes: Uint8Array) =>
    Effect.gen(function* () {
      // The connection writes one framed line per RPC; split anyway so
      // a batched write cannot hide a framing bug. Record every line
      // here, not in `waitForRequest` — the client also writes
      // *responses* to agent-initiated requests, which no waiter takes.
      for (const line of decoder.decode(bytes).split("\n")) {
        if (line.length === 0) continue
        seen.push(line)
        yield* Queue.offer(toAgent, line)
      }
    }),
  )

  const emitRaw = (chunk: string) =>
    Queue.offer(toClient, encoder.encode(chunk)).pipe(Effect.asVoid)

  const send = (message: WirePayload) => emitRaw(`${encodeWire(message)}\n`)

  const waitForRequest = (method: string): Effect.Effect<PeerRequest> =>
    Effect.gen(function* () {
      for (;;) {
        const line = yield* Queue.take(toAgent)
        const parsed = decodeWire(line)
        const rawId = parsed["id"]
        if (parsed["method"] === method && Predicate.isNumber(rawId)) {
          return { method, id: rawId, params: parsed["params"] }
        }
      }
    })

  return {
    proc: { stdin, stdout: Stream.fromQueue(toClient) },
    written: Effect.sync(() => [...seen]),
    waitForRequest,
    reply: (id, result) => send({ jsonrpc: "2.0", id, result }),
    replyError: (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } }),
    notify: (sessionId, update) =>
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }),
    emitRaw,
    endStdout: Queue.end(toClient).pipe(Effect.asVoid),
  }
})
