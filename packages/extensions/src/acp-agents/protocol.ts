/**
 * Native Effect ACP client over newline-delimited JSON-RPC 2.0 on stdio.
 *
 * No npm dependency — uses effect/unstable/process ChildProcess for the
 * subprocess and Effect primitives (Queue, Deferred, HashMap, PubSub,
 * Stream, Sink) for multiplexing.
 *
 * @module
 */
import {
  Deferred,
  Effect,
  Fiber,
  HashMap,
  Option,
  PubSub,
  Queue,
  Ref,
  Schema,
  type Sink,
  Stream,
} from "effect"
import type { PlatformError } from "effect/PlatformError"
import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
} from "./schema.js"
import * as S from "./schema.js"

// ── Error ──

export class AcpError extends Schema.TaggedErrorClass<AcpError>()("AcpError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Raised on every pending RPC `Deferred` when `AcpConnection.close`
 * runs. Without it, mid-turn invalidation (driver swap, manager
 * `tearDown`) would leak the executor's `Stream.interruptWhen(promptDone)`
 * forever — `promptDone` only resolves from the `prompt` RPC, and the
 * RPC's pending Deferred would never be signalled. Callers identify a
 * driver-invalidation hang vs. a transport error via this tag.
 */
export class AcpClosedError extends Schema.TaggedErrorClass<AcpClosedError>()("AcpClosedError", {
  reason: Schema.String,
}) {}

// ── Connection Interface ──

export interface AcpConnection {
  readonly initialize: (
    params: InitializeRequest,
  ) => Effect.Effect<InitializeResponse, AcpError | AcpClosedError>
  readonly newSession: (
    params: NewSessionRequest,
  ) => Effect.Effect<NewSessionResponse, AcpError | AcpClosedError>
  readonly prompt: (
    params: PromptRequest,
  ) => Effect.Effect<PromptResponse, AcpError | AcpClosedError>
  readonly cancel: (sessionId: string) => Effect.Effect<void>
  readonly updates: Stream.Stream<SessionNotification, AcpError>
  readonly close: (reason?: string) => Effect.Effect<void>
}

// ── Internal types ──

type RequestId = number
type PendingRequest = {
  readonly resolve: Deferred.Deferred<unknown, AcpError | AcpClosedError>
}

/**
 * The closed-flag and the pending-RPC map MUST be one atomic cell. A
 * naive layout (separate `closedRef` + `pendingRef`) leaks Deferreds
 * through this interleaving:
 *   1. rpcRaw reads closedRef = false
 *   2. close flips closedRef = true and drains pendingRef
 *   3. rpcRaw inserts its Deferred into the now-empty pendingRef
 *   4. rpcRaw awaits forever — never failed, never replied to
 * Folding both into `ConnState` lets `Ref.modify` make
 * "check-open-and-register" a single transaction.
 */
type ConnState =
  | { readonly _tag: "open"; readonly pending: HashMap.HashMap<RequestId, PendingRequest> }
  | { readonly _tag: "closed" }

type IncomingRequestHandler = (method: string, params: unknown) => Effect.Effect<unknown, AcpError>

// ── JSON-RPC wire helpers ──

const encodeRequest = (id: RequestId, method: string, params: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"

const encodeNotification = (method: string, params: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"

const encodeResponse = (id: number | string | null, result: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"

const encodeErrorResponse = (id: number | string | null, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"

// Incoming JSON-RPC envelopes: the wire format is a flat object with
// `id`, `method`, `params`, `result`, or `error` keys. We decode to an
// open record and let `handleLine` dispatch on field presence — the
// per-method payload schemas live in `./schema.ts` and are applied
// after routing.
const IncomingJsonRpcEnvelope = Schema.Record(Schema.String, Schema.Unknown)
const decodeIncomingEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(IncomingJsonRpcEnvelope),
)

// ── Connection Factory ──

export const makeAcpConnection = (
  proc: {
    readonly stdin: Sink.Sink<void, Uint8Array, never, PlatformError>
    readonly stdout: Stream.Stream<Uint8Array, PlatformError>
  },
  incomingRequestHandler?: IncomingRequestHandler,
) =>
  Effect.gen(function* () {
    const nextIdRef = yield* Ref.make(1 as RequestId)
    const stateRef = yield* Ref.make<ConnState>({
      _tag: "open",
      pending: HashMap.empty<RequestId, PendingRequest>(),
    })
    const updatesPubSub = yield* PubSub.unbounded<SessionNotification>()
    const writeQueue = yield* Queue.unbounded<string>()
    const encoder = new TextEncoder()

    const write = (msg: string) => Queue.offer(writeQueue, msg).pipe(Effect.asVoid)

    /**
     * Atomically seal `stateRef` to `closed` and return the pending map
     * for the caller to fail. Only the first caller wins; subsequent
     * calls observe `closed` and get `undefined`. Used by the public
     * `close` and by the writer/reader stdio-error handlers — without
     * this, a stdio failure would leave pending RPC Deferreds parked
     * forever (they resolve only via `handleResponse`, which the dead
     * reader will never run).
     */
    const sealAndClaimPending = Ref.modify(
      stateRef,
      (s): [HashMap.HashMap<RequestId, PendingRequest> | undefined, ConnState] => {
        if (s._tag === "closed") return [undefined, s]
        return [s.pending, { _tag: "closed" }]
      },
    )

    const failPendingWith = (reason: string) =>
      Effect.gen(function* () {
        const claimed = yield* sealAndClaimPending
        if (claimed === undefined) return false
        for (const [, entry] of claimed) {
          yield* Deferred.fail(entry.resolve, new AcpClosedError({ reason }))
        }
        yield* PubSub.shutdown(updatesPubSub).pipe(Effect.ignore)
        return true
      })

    // Writer fiber — drains writeQueue to stdin sink. On stdio failure
    // we must seal `stateRef` and fail every pending Deferred; otherwise
    // an `rpc.prompt(...)` call already past the registration point
    // parks forever and the executor's `Stream.interruptWhen(promptDone)`
    // never fires.
    const writerFiber = yield* Stream.fromQueue(writeQueue).pipe(
      Stream.map((line) => encoder.encode(line)),
      Stream.run(proc.stdin),
      Effect.catchEager((err: PlatformError) =>
        Effect.gen(function* () {
          const sealed = yield* failPendingWith(`writer error: ${String(err)}`)
          if (sealed) {
            yield* Effect.logWarning("acp: writer error").pipe(
              Effect.annotateLogs({ error: String(err) }),
            )
          }
        }),
      ),
      Effect.forkScoped,
    )

    // Parse incoming lines
    // Handle a response to one of our pending requests. Atomic
    // claim-and-remove via Ref.modify so a concurrent `close` either
    // sees the entry (and fails it) or this handler sees it — never
    // both, never neither.
    const handleResponse = (parsed: Record<string, unknown>) =>
      Effect.gen(function* () {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
        const id = parsed["id"] as RequestId
        const claimed = yield* Ref.modify(
          stateRef,
          (s): [PendingRequest | undefined, ConnState] => {
            if (s._tag === "closed") return [undefined, s]
            const found = HashMap.get(s.pending, id)
            if (found._tag === "None") return [undefined, s]
            return [found.value, { _tag: "open", pending: HashMap.remove(s.pending, id) }]
          },
        )
        if (claimed === undefined) return

        if ("error" in parsed) {
          const err = parsed["error"]
          const message =
            typeof err === "object" && err !== null && "message" in err
              ? String((err as Record<string, unknown>)["message"])
              : "Unknown ACP error"
          yield* Deferred.fail(claimed.resolve, new AcpError({ message }))
        } else {
          yield* Deferred.succeed(claimed.resolve, parsed["result"])
        }
      })

    // Handle an incoming request from the agent (e.g. permission)
    const handleIncomingRequest = (
      method: string,
      reqId: number | string | null,
      params: unknown,
    ) =>
      Effect.gen(function* () {
        if (incomingRequestHandler !== undefined) {
          const result = yield* incomingRequestHandler(method, params).pipe(
            Effect.catchEager((err: AcpError) =>
              Effect.gen(function* () {
                yield* write(encodeErrorResponse(reqId, -32603, err.message))
                return undefined
              }),
            ),
          )
          if (result !== undefined) {
            yield* write(encodeResponse(reqId, result))
          }
          return
        }

        // Auto-approve permissions (bare mode agents shouldn't ask, but just in case)
        if (method === "session/request_permission") {
          try {
            const req = Schema.decodeUnknownSync(S.RequestPermissionRequest)(params)
            const allowOption = req.options.find((o) => o.kind === "allow_once")
            yield* write(
              encodeResponse(reqId, {
                outcome: allowOption
                  ? { outcome: "selected", optionId: allowOption.optionId }
                  : { outcome: "cancelled" },
              }),
            )
          } catch {
            yield* write(encodeErrorResponse(reqId, -32602, "Invalid permission request"))
          }
        } else {
          yield* write(encodeErrorResponse(reqId, -32601, `Method not supported: ${method}`))
        }
      })

    // Route a parsed JSON-RPC line
    const handleLine = (line: string) =>
      Effect.gen(function* () {
        if (line.trim() === "") return

        const decoded = decodeIncomingEnvelope(line)
        if (Option.isNone(decoded)) {
          yield* Effect.logWarning("acp: unparseable line").pipe(
            Effect.annotateLogs({ line: line.slice(0, 200) }),
          )
          return
        }
        const parsed = decoded.value

        // Response to one of our requests
        if ("id" in parsed && parsed["id"] !== null && !("method" in parsed)) {
          yield* handleResponse(parsed)
          return
        }

        // Notification from agent (no id, has method)
        if ("method" in parsed && !("id" in parsed)) {
          if (parsed["method"] === "session/update") {
            try {
              const notification = Schema.decodeUnknownSync(S.SessionNotification)(parsed["params"])
              yield* PubSub.publish(updatesPubSub, notification)
            } catch (decodeErr) {
              yield* Effect.logWarning("acp: failed to decode session/update").pipe(
                Effect.annotateLogs({ error: String(decodeErr) }),
              )
            }
          }
          return
        }

        // Incoming request from agent (has id + method)
        if ("method" in parsed && "id" in parsed) {
          const rawId = parsed["id"]
          const reqId = typeof rawId === "number" || typeof rawId === "string" ? rawId : null
          yield* handleIncomingRequest(String(parsed["method"]), reqId, parsed["params"])
        }
      })

    // Reader fiber — reads stdout line by line. Same hand-off as the
    // writer: a stdio-error must fail pending Deferreds, otherwise a
    // pending RPC parks forever.
    //
    // `Stream.runDrain` also completes naturally when stdout ends (e.g.
    // the agent process exits without an error). Treat that as a
    // closure too — without sealing here, the caller's pending RPC
    // would never see the broken pipe.
    const readerFiber = yield* proc.stdout.pipe(
      Stream.decodeText(),
      splitLines,
      Stream.tap((line) => handleLine(line)),
      Stream.runDrain,
      Effect.catchEager((err: PlatformError) =>
        Effect.gen(function* () {
          const sealed = yield* failPendingWith(`reader error: ${String(err)}`)
          if (sealed) {
            yield* Effect.logWarning("acp: reader error").pipe(
              Effect.annotateLogs({ error: String(err) }),
            )
          }
        }),
      ),
      Effect.tap(() => failPendingWith("stdout closed")),
      Effect.forkScoped,
    )

    // RPC helper — sends request, waits for response.
    //
    // The closed-check and the pending-Deferred registration are folded
    // into a single `Ref.modify` so a concurrent `close` cannot drain
    // the pending map *between* "is open?" and "register pending".
    // Without this fold, a late RPC could write its Deferred into the
    // post-drain map and park forever.
    const rpcRaw = (method: string, params: unknown) =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextIdRef, (n) => (n + 1) as RequestId)
        const deferred = yield* Deferred.make<unknown, AcpError | AcpClosedError>()
        const registered = yield* Ref.modify(stateRef, (s): [boolean, ConnState] => {
          if (s._tag === "closed") return [false, s]
          return [
            true,
            {
              _tag: "open",
              pending: HashMap.set(s.pending, id, { resolve: deferred } as PendingRequest),
            },
          ]
        })
        if (!registered) {
          return yield* Effect.fail(new AcpClosedError({ reason: "connection closed" }))
        }
        yield* write(encodeRequest(id, method, params))
        return yield* Deferred.await(deferred)
      })

    const connection: AcpConnection = {
      initialize: (params) =>
        rpcRaw("initialize", params).pipe(
          Effect.map((raw) => Schema.decodeUnknownSync(S.InitializeResponse)(raw)),
        ),
      newSession: (params) =>
        rpcRaw("session/new", params).pipe(
          Effect.map((raw) => Schema.decodeUnknownSync(S.NewSessionResponse)(raw)),
        ),
      prompt: (params) =>
        rpcRaw("session/prompt", params).pipe(
          Effect.map((raw) => Schema.decodeUnknownSync(S.PromptResponse)(raw)),
        ),
      cancel: (sessionId) => write(encodeNotification("session/cancel", { sessionId })),
      updates: Stream.fromPubSub(updatesPubSub),
      // Atomically seal the state and claim the pending map in one
      // Ref.modify so a concurrent rpcRaw cannot leak a Deferred into
      // the post-drain map. Then fail each claimed Deferred with the
      // typed error *before* fiber interrupts so invalidation surfaces
      // as a typed error in the executor, not an interrupt.
      close: (reason = "connection closed") =>
        Effect.gen(function* () {
          yield* failPendingWith(reason)
          yield* Fiber.interrupt(writerFiber)
          yield* Fiber.interrupt(readerFiber)
        }),
    }

    return connection
  })

// ── Stream helper: split text stream into lines ──

const splitLines = <E>(stream: Stream.Stream<string, E>): Stream.Stream<string, E> => {
  let buffer = ""
  return stream.pipe(
    Stream.flatMap((chunk) => {
      buffer += chunk
      const parts = buffer.split("\n")
      buffer = parts.pop() ?? ""
      return Stream.fromIterable(parts.filter((p) => p.length > 0))
    }),
  )
}
