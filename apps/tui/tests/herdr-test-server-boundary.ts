/** Local socket boundary for Herdr acceptance tests. */
import { Effect, FileSystem, Path, Queue, Schema } from "effect"

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
const decode = Schema.decodeOption(Schema.fromJsonString(Request))
const encodeReply = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, result: Schema.Struct({}) })),
)

export const makeHerdrTestServer = Effect.fn("Test.makeHerdrServer")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-herdr-" })
  const socketPath = path.join(directory, "s")
  const requests = yield* Queue.unbounded<typeof Request.Type>()
  let respond = true
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      // eslint-disable-next-line effect/noGlobals -- Real Unix socket peer at the test platform boundary.
      Bun.listen<{ buffer: string }>({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.data = { buffer: "" }
          },
          data(socket, chunk) {
            socket.data.buffer += chunk.toString()
            const end = socket.data.buffer.indexOf("\n")
            if (end < 0) return
            const request = decode(socket.data.buffer.slice(0, end))
            if (request._tag === "None") {
              socket.end()
              return
            }
            Queue.offerUnsafe(requests, request.value)
            if (respond) socket.end(`${encodeReply({ id: request.value.id, result: {} })}\n`)
          },
        },
      }),
    ),
    (listener) => Effect.sync(() => listener.stop(true)),
  )
  return {
    target: { socketPath, paneId: "test:p1" },
    next: Queue.take(requests),
    pauseReplies: () => {
      respond = false
    },
    resumeReplies: () => {
      respond = true
    },
    stop: () => server.stop(true),
  }
})
