/**
 * Linked machines: this server's link to each other machine of
 * `link.machines`. A link runs the machine's command (an ssh to its
 * `gent ctl link`, the far end) and speaks this server's own RPC contract,
 * `GentRpcs`, over the command's stdio: one JSON frame per line, the
 * WebSocket's frames as `gent ctl link` relays them. No second wire format
 * exists.
 *
 * Its own file: the transport two concerns share (the pool's facts here,
 * session routing next).
 */
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  MutableRef,
  Option,
  Predicate,
  Pull,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect"
import type { Headers } from "effect/http"
import { ChildProcess } from "effect/process"
import { RpcClient, RpcSchema, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import type { LinkView } from "../domain/driver.js"
import { causeMessage } from "../domain/guards.js"
import { ConfigService, RuntimeEnvironment } from "../runtime/config.js"
import { GentPlatform, machineName } from "../runtime/gent-platform.js"
import { CredentialPlacement, type LaneScopeOf } from "../runtime/provider.js"
import { GentRpcs, makeNamespacedClient } from "./rpc.js"
import { LINK_ORIGIN_HEADER, workspaceHeadersForCwd } from "./workspace-rpc.js"

// ── contract ────────────────────────────────────────────────────────────────

/**
 * The hash of this build's RPC contract: each RPC's tag and the JSON schema
 * of its payload, success (a stream's element and error) and error, sorted
 * by tag. Two servers whose hashes match decode each other's frames. About
 * 340 KB of schema text, hashed in 15 to 55 ms on the laptop; `Links`
 * computes it once.
 */
const encodeContractEntry = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export const linkContract: Effect.Effect<string, never, GentPlatform> = Effect.gen(function* () {
  const platform = yield* GentPlatform
  const document = (schema: Schema.Top) => Schema.toJsonSchemaDocument(schema)
  const success = (schema: Schema.Top) => {
    if (RpcSchema.isStreamSchema(schema))
      return ["stream", document(schema.success), document(schema.error)]
    return ["once", document(schema)]
  }
  const entries = [...GentRpcs.requests.values()]
    .map((rpc) =>
      encodeContractEntry([
        rpc._tag,
        document(rpc.payloadSchema),
        success(rpc.successSchema),
        document(rpc.errorSchema),
      ]),
    )
    .sort()
  return platform.hash("sha256", entries.join("\n"))
})

// ── transport ───────────────────────────────────────────────────────────────

/** How long a stopped command has after SIGTERM before SIGKILL. */
const LINK_FORCE_KILL_AFTER = Duration.seconds(2)
/** How much of the command's stderr a failure keeps: its last characters. */
const LINK_STDERR_TAIL = 2_000
/** A ping this often keeps frames coming over a link with nothing else to say. */
const LINK_PING_INTERVAL = Duration.seconds(30)
/**
 * A run with no frame this long past a ping is stopped: a machine asleep, a
 * route gone, an ssh waiting on a socket with no reset. Checked at each ping,
 * so a quiet run stops within 90 s of its last frame.
 */
const LINK_PING_TIMEOUT = Duration.seconds(60)

const encoder = new TextEncoder()
/** A frame as the command's stdin takes it. */
const frameBytes = (chunk: Uint8Array | string) => {
  if (Predicate.isString(chunk)) return encoder.encode(chunk)
  return chunk
}

/**
 * `RpcSerialization.ndjson`, with `onFrame` at each read that decodes a whole
 * frame, as the RPC client's pinger counts one (`RpcClient.ts`
 * `processData`): a partial line, an empty line or a line the decode refuses
 * counts none. Synchronous, as the parser is.
 */
const ndjsonNotingFrames = (onFrame: () => void) =>
  RpcSerialization.RpcSerialization.of({
    contentType: RpcSerialization.ndjson.contentType,
    includesFraming: RpcSerialization.ndjson.includesFraming,
    codecFor: RpcSerialization.ndjson.codecFor,
    makeUnsafe: () => {
      const parser = RpcSerialization.ndjson.makeUnsafe()
      return {
        encode: parser.encode,
        decode: (data) => {
          const frames = parser.decode(data)
          if (frames.length > 0) onFrame()
          return frames
        },
      }
    },
  })

/**
 * One run of a link's command, as an RPC client of `GentRpcs`: the client's
 * frames go to its stdin, its stdout gives the server's (ndjson, the frames
 * `gent ctl link` relays), and each call carries `headers`. `onFrame` runs
 * at each read from its stdout that completes a frame (`ndjsonNotingFrames`).
 * Scoped: the command stops with the scope,
 * killed first when the scope does not close in success, since a command
 * that stopped reading holds a full pipe the stdin feed's stop would wait on
 * for good (Effect-TS/effect#10314). A transport failure (the stdout ends,
 * no frame past a ping) fails every call with an `RpcClientError`, and
 * every later one.
 */
const runLinkCommand = Effect.fn("Link.runCommand")(function* (
  command: readonly [string, ...Array<string>],
  headers: Headers.Input,
  onFrame: () => void,
) {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const handle = yield* ChildProcess.make(command[0], command.slice(1), {
    stdin: Stream.fromQueue(input),
    stdout: "pipe",
    stderr: "pipe",
    forceKillAfter: LINK_FORCE_KILL_AFTER,
  })
  yield* Effect.addFinalizer((exit) => {
    if (Exit.isSuccess(exit)) return Queue.end(input)
    return Effect.ignore(handle.kill({ forceKillAfter: LINK_FORCE_KILL_AFTER }))
  })
  const tail = yield* Ref.make("")
  yield* handle.stderr.pipe(
    Stream.decodeText,
    Stream.runForEach((text) => Ref.update(tail, (kept) => (kept + text).slice(-LINK_STDERR_TAIL))),
    Effect.forkScoped,
  )
  const closed = new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) })
  const socket = Socket.make({
    reader: Effect.map(Stream.toPull(handle.stdout), (pull) => ({
      pull: pull.pipe(
        Pull.catchDone(() => Effect.fail(closed)),
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) })),
        ),
      ),
      upgrade: Socket.SocketUpgradeError.unsupported,
    })),
    writer: Effect.succeed({
      write: (chunk) => {
        if (Socket.isCloseEvent(chunk)) return Queue.end(input)
        return Effect.asVoid(Queue.offer(input, frameBytes(chunk)))
      },
      writeAll: (chunks) => Effect.asVoid(Queue.offerAll(input, chunks.map(frameBytes))),
    }),
  })
  // One connection a run: the link's loop runs the command again, never the protocol.
  const protocol = yield* RpcClient.makeProtocolSocket({
    pingInterval: LINK_PING_INTERVAL,
    pingTimeout: LINK_PING_TIMEOUT,
    retryPolicy: Schedule.recurs(0),
  }).pipe(
    Effect.provideService(Socket.Socket, socket),
    Effect.provideService(RpcSerialization.RpcSerialization, ndjsonNotingFrames(onFrame)),
  )
  const flat = yield* RpcClient.make(GentRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  )
  return {
    client: makeNamespacedClient(flat, headers),
    stderr: Ref.get(tail),
    exitCode: handle.exitCode,
  }
})

// ── links ───────────────────────────────────────────────────────────────────

/** The wait after a run's first failure; each run that does not settle doubles it. */
const LINK_RETRY_FIRST = Duration.seconds(1)
/** The longest wait between two runs of a link's command. */
const LINK_RETRY_MAX = Duration.minutes(5)
/** A run that connected and lived this long starts the wait over. */
const LINK_STEADY_MS = 60_000
/** A link with no frame this long is `silent`: the pool's rule, three heartbeats. */
const LINK_SILENT_MS = 90_000
/** After a run's calls fail: how long the command's exit is awaited, for the log. */
const LINK_END_GRACE = Duration.seconds(1)

/** One run of a link ended: why, with the command's exit code and its stderr's end. */
class LinkRunEnded extends Schema.TaggedError<LinkRunEnded, { readonly brand: unique symbol }>()(
  "LinkRunEnded",
  { message: Schema.String },
) {}

/** A link's facts, as its loop keeps them (`LinkView` reads them). */
interface LinkRecord {
  /** This server's clock at the last frame, or at the link's start before the first. */
  readonly lastFrame: number
  /** The current run's hello named this server's contract. */
  readonly connected: boolean
  /** The last hello named another contract (or none); a matching hello clears it. */
  readonly incompatible: boolean
}

const stateOf = (record: LinkRecord, now: number): LinkView["state"] => {
  if (record.incompatible) return "incompatible"
  if (now - record.lastFrame >= LINK_SILENT_MS) return "silent"
  if (record.connected) return "connected"
  return "connecting"
}

/**
 * This server's links (`link.machines` in the user file): one loop per
 * machine but this one (`machineName`), each running its command and
 * running it again when it ends. `contract` is this build's `linkContract`.
 * `view` is each link's state now, in the config's order.
 */
export class Links extends Context.Service<
  Links,
  {
    readonly contract: Effect.Effect<string>
    readonly view: Effect.Effect<ReadonlyArray<LinkView>>
  }
>()("@gent/core/src/server/link/Links") {
  /**
   * The links, each loop on its own fiber for the layer's life. `scopeOf`
   * names each provider's pool accounts, as `notePeer` reads them.
   */
  static Live = (scopeOf: LaneScopeOf) =>
    Layer.effect(
      Links,
      Effect.gen(function* () {
        const config = yield* ConfigService
        const placement = yield* CredentialPlacement
        const environment = yield* RuntimeEnvironment
        const own = yield* machineName
        const contract = yield* Effect.cached(
          linkContract.pipe(Effect.provideService(GentPlatform, yield* GentPlatform)),
        )
        const started = yield* Clock.currentTimeMillis
        const records = new Map<string, MutableRef.MutableRef<LinkRecord>>()
        for (const machine of Object.keys(yield* config.linkMachines)) {
          if (machine === own) continue
          records.set(
            machine,
            MutableRef.make<LinkRecord>({
              lastFrame: started,
              connected: false,
              incompatible: false,
            }),
          )
        }
        const headers = {
          ...workspaceHeadersForCwd(environment.cwd),
          [LINK_ORIGIN_HEADER]: own,
        }

        /**
         * One run: the hello, then the pool's facts both ways until a call
         * fails. It succeeds with why it stopped when the peer's contract
         * is not this one's; it fails with `LinkRunEnded` otherwise.
         */
        const runOnce = (
          machine: string,
          command: readonly [string, ...Array<string>],
          record: MutableRef.MutableRef<LinkRecord>,
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              const clock = yield* Clock.Clock
              const noteFrame = () =>
                MutableRef.update(record, (kept) => ({
                  ...kept,
                  lastFrame: clock.currentTimeMillisUnsafe(),
                }))
              const run = yield* runLinkCommand(command, headers, noteFrame)
              const ended = (reason: string) =>
                Effect.gen(function* () {
                  const code = yield* run.exitCode.pipe(Effect.timeoutOption(LINK_END_GRACE))
                  const exit = Option.match(code, {
                    onNone: () => "none (it still ran)",
                    onSome: String,
                  })
                  const stderr = (yield* run.stderr).trim()
                  return yield* new LinkRunEnded({
                    message: `${reason}; exit code ${exit}: ${stderr}`,
                  })
                })
              const hello = yield* Effect.exit(run.client.link.hello())
              if (Exit.isFailure(hello)) {
                const error = Cause.findErrorOption(hello.cause)
                if (Option.exists(error, (failure) => failure._tag === "RpcClientError"))
                  return yield* ended(Cause.pretty(hello.cause))
                // A peer with no `link.hello` (an older build) answers a defect.
                yield* Effect.sync(() =>
                  MutableRef.update(record, (kept) => ({ ...kept, incompatible: true })),
                )
                return `${machine} has no link.hello this server reads: ${causeMessage(Cause.squash(hello.cause))}`
              }
              if (hello.value.contract !== (yield* contract)) {
                yield* Effect.sync(() =>
                  MutableRef.update(record, (kept) => ({ ...kept, incompatible: true })),
                )
                return `${machine} runs another RPC contract (${hello.value.contract})`
              }
              yield* Effect.sync(() =>
                MutableRef.update(record, (kept) => ({
                  ...kept,
                  connected: true,
                  incompatible: false,
                })),
              )
              // The peer's facts count as this server's own link's; this
              // server's go to the peer as its link's.
              const pull = run.client.accounts
                .pool()
                .pipe(Stream.runForEach((facts) => placement.notePeer(facts, scopeOf, "own")))
              const push = placement.pool.pipe(
                Stream.runForEach((facts) => run.client.accounts.notePeer(facts)),
              )
              const facts = yield* Effect.exit(Effect.raceFirst(pull, push))
              if (Exit.isSuccess(facts)) return "this server's pool ended"
              return yield* ended(Cause.pretty(facts.cause))
            }),
          )

        /**
         * A link's loop: runs its command (`runOnce`) and runs it again after
         * each end, after a wait that starts at `LINK_RETRY_FIRST`, doubles
         * up to `LINK_RETRY_MAX`, and starts over once a run connected and
         * lived `LINK_STEADY_MS` (a run that dies at once, as at a peer that
         * refuses this server, keeps doubling). Each end is logged
         * (`link.ended`). The command is read from the config at each run;
         * with none, the loop stops. The lanes count this server's link to
         * the peer while the loop runs (`runsLink`).
         */
        const follow = (machine: string, record: MutableRef.MutableRef<LinkRecord>) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* placement.runsLink
              let wait = LINK_RETRY_FIRST
              while (true) {
                const command = Option.fromUndefinedOr((yield* config.linkMachines)[machine])
                if (Option.isNone(command)) return
                const startedRun = yield* Clock.currentTimeMillis
                const reason = yield* runOnce(machine, command.value, record).pipe(
                  Effect.catch((error) => Effect.succeed(error.message)),
                  Effect.catchDefect((defect) => Effect.succeed(causeMessage(defect))),
                )
                yield* Effect.logWarning("link.ended").pipe(
                  Effect.annotateLogs({ machine, command: command.value[0], error: reason }),
                )
                const ran = yield* Effect.sync(() =>
                  MutableRef.getAndUpdate(record, (kept) => ({ ...kept, connected: false })),
                )
                const lived = (yield* Clock.currentTimeMillis) - startedRun
                if (ran.connected && lived >= LINK_STEADY_MS) wait = LINK_RETRY_FIRST
                yield* Effect.sleep(wait)
                wait = Duration.min(Duration.times(wait, 2), LINK_RETRY_MAX)
              }
            }),
          )

        for (const [machine, record] of records) yield* Effect.forkScoped(follow(machine, record))

        return Links.of({
          contract,
          view: Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const views: Array<LinkView> = []
            for (const [machine, record] of records)
              views.push({ machine, state: stateOf(MutableRef.get(record), now) })
            return views
          }),
        })
      }),
    )
}
