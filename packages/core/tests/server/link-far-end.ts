/**
 * A link's far end for the link tests, run as the link's command: it speaks
 * the frames `gent ctl link` relays (one JSON frame per line each way) with
 * no server behind it. argv: the contract its hello names, the mode, a log
 * file, and for `serve` the pool facts it streams (JSON). Each run logs
 * `start`, then each request's tag and `x-gent-link` header, and each
 * `accounts.notePeer` payload, one line each.
 *
 * Modes, after the hello:
 * - `serve`: streams the facts on `accounts.pool`, answers
 *   `accounts.notePeer` and each ping.
 * - `quiet`: answers nothing more (a machine asleep).
 * - `exit`: writes `far end gone` on stderr and exits 3.
 * - `garbage`: answers the hello with a line that is no frame, and stays up.
 * - `nohello`: answers the hello with a defect, as a build with no
 *   `link.hello` does.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Option, Runtime, Schema, Stdio, Stream } from "effect"

/** A request id: the client numbers its requests, and a reply names the same value. */
const RequestId = Schema.Union([Schema.String, Schema.Finite])

/** A request or a ping, as the link's client sends it. */
const Frame = Schema.Struct({
  _tag: Schema.String,
  id: Schema.optionalKey(RequestId),
  tag: Schema.optionalKey(Schema.String),
  payload: Schema.optionalKey(Schema.Unknown),
  headers: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
})
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Frame))

/** A frame this end answers with, as the server's JSON serialization writes it. */
const Success = Schema.TaggedStruct("Success", { value: Schema.Unknown })
const Die = Schema.TaggedStruct("Die", { defect: Schema.String })
const Failure = Schema.TaggedStruct("Failure", { cause: Schema.Array(Die) })
const ExitFrame = Schema.TaggedStruct("Exit", {
  requestId: RequestId,
  exit: Schema.Union([Success, Failure]),
})
const ChunkFrame = Schema.TaggedStruct("Chunk", {
  requestId: RequestId,
  values: Schema.Array(Schema.Unknown),
})
const Pong = Schema.TaggedStruct("Pong", {})
const Reply = Schema.Union([ExitFrame, ChunkFrame, Pong])
const encodeReply = Schema.encodeSync(Schema.fromJsonString(Reply))
const Json = Schema.fromJsonString(Schema.Unknown)

/** A void result as the wire carries it: JSON null. */
const wireVoid = Schema.decodeSync(Json)("null")

/** The run ends as a machine whose server went away does: exit 3. */
class FarEndGone extends Schema.TaggedError<FarEndGone, { readonly brand: unique symbol }>()(
  "FarEndGone",
  {},
) {
  override readonly [Runtime.errorExitCode] = 3
}

/** What a request line makes this end do: lines to print, then maybe exit. */
interface Answer {
  readonly lines: ReadonlyArray<string>
  readonly exit: boolean
}
const say = (...lines: ReadonlyArray<string>): Answer => ({ lines, exit: false })

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const stdio = yield* Stdio.Stdio
  const [contract = "", mode = "serve", log = "/dev/null", factsText = "{}"] = yield* stdio.args
  const facts = yield* Schema.decodeEffect(Json)(factsText)
  const note = (line: string) => fs.writeFileString(log, `${line}\n`, { flag: "a" })
  const exitOf = (
    requestId: typeof RequestId.Type,
    exit: typeof Success.Type | typeof Failure.Type,
  ) => encodeReply(ExitFrame.make({ requestId, exit }))
  let helloed = false

  const answer = (line: string) =>
    Effect.gen(function* () {
      const frame = decodeFrame(line)
      if (Option.isNone(frame)) return say()
      const { _tag, tag = "", headers = [] } = frame.value
      const id = frame.value.id ?? 0
      if (_tag === "Ping") {
        if (mode === "serve") return say(encodeReply(Pong.make({})))
        return say()
      }
      if (_tag !== "Request") return say()
      const origin = headers.find(([name]) => name === "x-gent-link")?.[1] ?? "none"
      yield* note(`request ${tag} origin=${origin}`)
      if (tag === "link.hello" && !helloed) {
        helloed = true
        if (mode === "nohello")
          return say(exitOf(id, Failure.make({ cause: [Die.make({ defect: "no link.hello" })] })))
        if (mode === "garbage") return say("not a frame")
        const hello = exitOf(id, Success.make({ value: { machine: "far", contract } }))
        return { lines: [hello], exit: mode === "exit" }
      }
      if (mode !== "serve") return say()
      if (tag === "accounts.pool")
        return say(encodeReply(ChunkFrame.make({ requestId: id, values: [facts] })))
      if (tag === "accounts.notePeer") {
        yield* note(`note ${yield* Schema.encodeEffect(Json)(frame.value.payload)}`)
        return say(exitOf(id, Success.make({ value: wireVoid })))
      }
      return say()
    })

  yield* note("start")
  yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.mapEffect(answer),
    Stream.flatMap((reply) => {
      const printed = Stream.fromIterable(reply.lines.map((line) => `${line}\n`))
      if (!reply.exit) return printed
      // The hello first, then the end: stderr's last words and exit 3.
      return Stream.concat(
        printed,
        Stream.fromEffect(
          Stream.make("far end gone\n").pipe(
            Stream.run(stdio.stderr()),
            Effect.andThen(Effect.fail(new FarEndGone())),
          ),
        ),
      )
    }),
    Stream.run(stdio.stdout()),
  )
})

BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)), {
  disableErrorReporting: true,
})
