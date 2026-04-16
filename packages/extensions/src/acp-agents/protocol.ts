/**
 * Native Effect ACP client over newline-delimited JSON-RPC 2.0 on stdio.
 *
 * No npm dependency — uses Bun.spawn for the subprocess and Effect
 * primitives (Queue, Deferred, HashMap, PubSub, Stream) for multiplexing.
 *
 * @module
 */
import { Deferred, Effect, Fiber, HashMap, PubSub, Queue, Ref, Schema, Stream } from "effect"
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

// ── Connection Interface ──

export interface AcpConnection {
  readonly initialize: (params: InitializeRequest) => Effect.Effect<InitializeResponse, AcpError>
  readonly newSession: (params: NewSessionRequest) => Effect.Effect<NewSessionResponse, AcpError>
  readonly prompt: (params: PromptRequest) => Effect.Effect<PromptResponse, AcpError>
  readonly cancel: (sessionId: string) => Effect.Effect<void>
  readonly updates: Stream.Stream<SessionNotification, AcpError>
  readonly close: Effect.Effect<void>
}

// ── Internal types ──

type RequestId = number
type PendingRequest = {
  readonly resolve: Deferred.Deferred<unknown, AcpError>
}

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

// ── Connection Factory ──

export const makeAcpConnection = (
  proc: { stdin: { write: (data: string) => void }; stdout: ReadableStream<Uint8Array> },
  incomingRequestHandler?: IncomingRequestHandler,
) =>
  Effect.gen(function* () {
    const nextIdRef = yield* Ref.make(1 as RequestId)
    const pendingRef = yield* Ref.make(HashMap.empty<RequestId, PendingRequest>())
    const updatesPubSub = yield* PubSub.unbounded<SessionNotification>()
    const writeQueue = yield* Queue.unbounded<string>()
    const closedRef = yield* Ref.make(false)

    const write = (msg: string) => Queue.offer(writeQueue, msg).pipe(Effect.asVoid)

    // Writer fiber — drains writeQueue to stdin
    const writerFiber = yield* Stream.fromQueue(writeQueue).pipe(
      Stream.tap((line) => Effect.sync(() => proc.stdin.write(line))),
      Stream.runDrain,
      Effect.forkScoped,
    )

    // Parse incoming lines
    // Handle a response to one of our pending requests
    const handleResponse = (parsed: Record<string, unknown>) =>
      Effect.gen(function* () {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const id = parsed["id"] as RequestId
        const pending = yield* Ref.get(pendingRef)
        const entry = HashMap.get(pending, id)
        if (entry._tag === "None") return

        yield* Ref.update(pendingRef, HashMap.remove(id))

        if ("error" in parsed) {
          const err = parsed["error"]
          const message =
            typeof err === "object" && err !== null && "message" in err
              ? String((err as Record<string, unknown>)["message"])
              : "Unknown ACP error"
          yield* Deferred.fail(entry.value.resolve, new AcpError({ message }))
        } else {
          yield* Deferred.succeed(entry.value.resolve, parsed["result"])
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

        let parsed: Record<string, unknown>
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          parsed = JSON.parse(line) as Record<string, unknown>
        } catch {
          yield* Effect.logWarning("acp: unparseable line").pipe(
            Effect.annotateLogs({ line: line.slice(0, 200) }),
          )
          return
        }

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

    // Reader fiber — reads stdout line by line
    const readerFiber = yield* Stream.fromReadableStream({
      evaluate: () => proc.stdout,
      onError: (e) => new AcpError({ message: `stdout read error: ${String(e)}` }),
    }).pipe(
      Stream.decodeText(),
      splitLines,
      Stream.tap((line) => handleLine(line)),
      Stream.runDrain,
      Effect.catchEager((err: AcpError) =>
        Effect.gen(function* () {
          const closed = yield* Ref.get(closedRef)
          if (!closed) {
            yield* Effect.logWarning("acp: reader error").pipe(
              Effect.annotateLogs({ error: String(err) }),
            )
          }
        }),
      ),
      Effect.forkScoped,
    )

    // RPC helper — sends request, waits for response
    const rpcRaw = (method: string, params: unknown) =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextIdRef, (n) => (n + 1) as RequestId)
        const deferred = yield* Deferred.make<unknown, AcpError>()
        yield* Ref.update(pendingRef, HashMap.set(id, { resolve: deferred } as PendingRequest))
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
      close: Effect.gen(function* () {
        yield* Ref.set(closedRef, true)
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
