/** Ordered, bounded Herdr socket reports, owned by the TUI extension scope. */
import { BunSocket } from "@effect/platform-bun"
import { Clock, Config, Deferred, Effect, Exit, Fiber, Option, Queue, Schema } from "effect"
import type { ClientActivitySnapshot } from "../client-activity"

const SOURCE = "herdr:gent"
const AGENT = "gent"
let sequence = 0

export const herdrEnvironment = Config.all({
  enabled: Config.string("HERDR_ENV").pipe(Config.withDefault("")),
  socketPath: Config.string("HERDR_SOCKET_PATH").pipe(Config.withDefault("")),
  paneId: Config.string("HERDR_PANE_ID").pipe(Config.withDefault("")),
}).pipe(
  Config.map((env) => {
    if (env.enabled !== "1" || env.socketPath.length === 0 || env.paneId.length === 0)
      return Option.none()
    return Option.some({ socketPath: env.socketPath, paneId: env.paneId })
  }),
)

export interface HerdrTarget {
  readonly socketPath: string
  readonly paneId: string
}

class HerdrReportError extends Schema.TaggedError<HerdrReportError>()("HerdrReportError", {
  message: Schema.String,
}) {}

const Request = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  params: Schema.Struct({
    pane_id: Schema.String,
    source: Schema.String,
    agent: Schema.String,
    seq: Schema.Finite,
    state: Schema.optional(Schema.String),
    agent_session_id: Schema.optional(Schema.String),
  }),
})
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Request))

const Reply = Schema.Struct({
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})

const sendRequest = Effect.fn("Herdr.sendRequest")(
  function* (target: HerdrTarget, request: typeof Request.Type) {
    const socket = yield* BunSocket.makeNet({ path: target.socketPath })
    const write = yield* socket.writer
    const reply = yield* Deferred.make<void, HerdrReportError>()
    let buffer = ""
    const read = socket
      .runString(
        (chunk) => {
          buffer += chunk
          if (buffer.length > 65_536)
            return Deferred.fail(
              reply,
              new HerdrReportError({ message: "Herdr reply exceeded the limit" }),
            )
          const end = buffer.indexOf("\n")
          if (end < 0) return Effect.void
          const decoded = Schema.decodeOption(Schema.fromJsonString(Reply))(buffer.slice(0, end))
          if (
            Option.isNone(decoded) ||
            decoded.value.id !== request.id ||
            Option.isSome(Option.fromUndefinedOr(decoded.value.error)) ||
            Option.isNone(Option.fromUndefinedOr(decoded.value.result))
          ) {
            return Deferred.fail(
              reply,
              new HerdrReportError({ message: "Herdr rejected the report" }),
            )
          }
          return Deferred.done(reply, Exit.void)
        },
        {
          onOpen: write(`${encodeRequest(request)}\n`).pipe(
            Effect.catchEager(() =>
              Deferred.fail(reply, new HerdrReportError({ message: "Herdr write failed" })),
            ),
            Effect.asVoid,
          ),
        },
      )
      .pipe(
        Effect.andThen(
          Effect.fail(new HerdrReportError({ message: "Herdr closed before replying" })),
        ),
      )
    yield* Effect.raceFirst(read, Deferred.await(reply))
  },
  Effect.scoped,
  Effect.timeout("500 millis"),
)

export const makeHerdrReporter = Effect.fn("Herdr.makeReporter")(function* (target: HerdrTarget) {
  const reports = yield* Queue.sliding<ClientActivitySnapshot>(1)
  let closed = false
  let previous = ""

  const send = Effect.fn("Herdr.report")(function* (
    method: string,
    snapshot?: ClientActivitySnapshot,
  ) {
    const now = yield* Clock.currentTimeMillis
    sequence = Math.max(sequence + 1, now * 1000)
    const seq = sequence
    const params = {
      pane_id: target.paneId,
      source: SOURCE,
      agent: AGENT,
      seq,
      state: snapshot?.state,
      agent_session_id: snapshot?.sessionId,
    }
    yield* sendRequest(target, { id: `${SOURCE}:${seq}`, method, params }).pipe(
      Effect.retry({ times: 1 }),
      Effect.catchEager((error) =>
        Effect.logDebug("Herdr report failed").pipe(Effect.annotateLogs({ error: String(error) })),
      ),
    )
  })

  const worker = yield* Effect.forever(
    Effect.gen(function* () {
      const snapshot = yield* Queue.take(reports)
      yield* send("pane.report_agent", snapshot)
    }),
  ).pipe(Effect.forkScoped)

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true
      yield* Fiber.interrupt(worker)
      yield* Queue.shutdown(reports)
      yield* send("pane.release_agent")
    }),
  )

  return {
    report: (snapshot: ClientActivitySnapshot): void => {
      if (closed) return
      const key = `${snapshot.sessionId ?? ""}:${snapshot.state}`
      if (key === previous) return
      previous = key
      Queue.offerUnsafe(reports, snapshot)
    },
  }
})
