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
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  MutableRef,
  Option,
  Predicate,
  Pull,
  Queue,
  Ref,
  Result,
  Schedule,
  Schema,
  type SchemaAST,
  Stream,
} from "effect"
import type { Headers } from "effect/http"
import { ChildProcess, type ChildProcessSpawner, CommandLine } from "effect/process"
import { Rpc, RpcClient, RpcSchema, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import type { LinkView } from "../domain/driver.js"
import { causeMessage } from "../domain/guards.js"
import { ConfigService, RuntimeEnvironment } from "../runtime/config.js"
import { GentPlatform, GentRelease, machineName, runProcess } from "../runtime/gent-platform.js"
import { CredentialPlacement, type LaneScopeOf } from "../runtime/provider.js"
import { GentRpcs, LinkHello, makeNamespacedClient } from "./rpc.js"
import { LINK_ORIGIN_HEADER, workspaceHeadersForCwd } from "./workspace-rpc.js"

// ── contract ────────────────────────────────────────────────────────────────

/**
 * A codec as data: a fact is a string or a list of facts. A node's facts
 * name each child node by the child's place in the walk.
 */
type CodecFact = string | ReadonlyArray<CodecFact>

/**
 * One walk over a codec's AST. Each node is described once, at its place; a
 * node met again, a recursive one among them, is named by that place.
 */
interface CodecWalk {
  readonly nodes: Array<CodecFact>
  readonly places: Map<SchemaAST.AST, number>
}

/**
 * A fact that is code, not data: a declaration's parser, a transformation, a
 * check Effect does not name, a value that is no JSON. Only the release that
 * holds the code names it (`linkContract`).
 */
const opaqueFact = (what: string): CodecFact => ["opaque", what]

/** A symbol is data only when registered: its key names it in every process. */
const symbolFact = (walk: CodecWalk, symbol: symbol): CodecFact =>
  Option.match(Option.fromUndefinedOr(Symbol.keyFor(symbol)), {
    onNone: () => opaqueFact("symbol"),
    onSome: (key) => ["symbol", key],
  })

/**
 * A value as data: a check's payload (JSON), a literal (a bigint too) or a
 * key (a symbol too). An object that is not a plain record is no JSON,
 * whatever its type says: it is opaque.
 */
type FactValue = Schema.Json | bigint | symbol

/** `Array.isArray` narrows to a mutable array only; JSON's arrays are readonly. */
const isJsonArray = (value: Schema.JsonArray | Schema.JsonObject): value is Schema.JsonArray =>
  Array.isArray(value)

const valueFact = (walk: CodecWalk, value: FactValue): CodecFact => {
  if (Predicate.isString(value)) return ["string", value]
  if (Predicate.isNumber(value)) {
    if (Object.is(value, -0)) return ["number", "-0"]
    return ["number", String(value)]
  }
  if (Predicate.isBoolean(value)) return ["boolean", String(value)]
  if (Predicate.isBigInt(value)) return ["bigint", String(value)]
  if (Predicate.isNull(value)) return ["null"]
  if (Predicate.isSymbol(value)) return symbolFact(walk, value)
  if (isJsonArray(value)) return ["array", ...value.map((item) => valueFact(walk, item))]
  const prototype: object = Object.getPrototypeOf(value) ?? Object.prototype
  if (prototype !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    return opaqueFact("value")
  }
  const record: Schema.JsonObject = value
  const keys = Object.keys(record).sort()
  return ["record", ...keys.map((key): CodecFact => [key, valueFact(walk, record[key] ?? "")])]
}

/**
 * A check, by what it runs. Effect's own checks name their run: the
 * representation `effect/schema/...` and its payload (a pattern's source and
 * flags, a bound) rebuild the same filter. Another check's representation is
 * a name its author chose, not its run, and a check with none is a function
 * only: both are opaque.
 */
const checkFact = (walk: CodecWalk, check: SchemaAST.Checks[number]): CodecFact => {
  const structural = String(check.annotations?.["~structural"] === true)
  if (check._tag === "FilterGroup") {
    return ["group", structural, ...check.checks.map((inner) => checkFact(walk, inner))]
  }
  const representation = Option.fromUndefinedOr(check.annotations?.representation).pipe(
    Option.filter(({ id }) => id.startsWith("effect/")),
  )
  if (Option.isNone(representation)) return opaqueFact("check")
  const schemas = representation.value.schemas ?? []
  return [
    "check",
    representation.value.id,
    valueFact(walk, representation.value.payload),
    structural,
    String(check.aborted),
    ...schemas.map((schema) => String(visit(walk, schema))),
  ]
}

const checksFact = (
  walk: CodecWalk,
  checks: ReadonlyArray<SchemaAST.Checks[number]>,
): CodecFact => ["checks", ...checks.map((check) => checkFact(walk, check))]

const placesFact = (walk: CodecWalk, asts: ReadonlyArray<SchemaAST.AST>): CodecFact =>
  asts.map((ast) => String(visit(walk, ast)))

/** What a node is, by its kind: the facts its parser reads besides checks, encoding and context. */
const kindFact = (walk: CodecWalk, ast: SchemaAST.AST): CodecFact => {
  switch (ast._tag) {
    case "Declaration":
      return [
        "Declaration",
        opaqueFact("declaration"),
        placesFact(walk, ast.typeParameters),
        checksFact(walk, ast.encodingChecks ?? []),
      ]
    case "Literal":
      return ["Literal", valueFact(walk, ast.literal)]
    case "UniqueSymbol":
      return ["UniqueSymbol", symbolFact(walk, ast.symbol)]
    case "Enum":
      return [
        "Enum",
        ...ast.enums.map(([name, value]): CodecFact => [name, valueFact(walk, value)]),
      ]
    case "TemplateLiteral":
      return ["TemplateLiteral", placesFact(walk, ast.parts)]
    case "Arrays":
      return [
        "Arrays",
        String(ast.isMutable),
        placesFact(walk, ast.elements),
        placesFact(walk, ast.rest),
        checksFact(walk, ast.encodingChecks ?? []),
      ]
    case "Objects":
      return [
        "Objects",
        ast.propertySignatures.map((property): CodecFact => [
          valueFact(walk, property.name),
          String(visit(walk, property.type)),
        ]),
        ast.indexSignatures.map((index): CodecFact => [
          String(visit(walk, index.parameter)),
          String(visit(walk, index.type)),
        ]),
        checksFact(walk, ast.encodingChecks ?? []),
      ]
    case "Union":
      return [
        "Union",
        ast.options?.mode ?? "anyOf",
        placesFact(walk, ast.types),
        checksFact(walk, ast.encodingChecks ?? []),
      ]
    case "Suspend":
      return ["Suspend", String(visit(walk, ast.thunk()))]
    default:
      return [ast._tag]
  }
}

/**
 * A node's place in the walk, described on first meeting: its shape, its
 * checks, each step of its encoding (the encoded node, and the
 * transformation as code), and whether it is an optional or mutable key.
 */
const visit = (walk: CodecWalk, ast: SchemaAST.AST): number => {
  const known = walk.places.get(ast)
  if (Predicate.isNumber(known)) return known
  const place = walk.nodes.length
  walk.places.set(ast, place)
  walk.nodes.push("")
  const encoding = ast.encoding ?? []
  walk.nodes[place] = [
    kindFact(walk, ast),
    checksFact(walk, ast.checks ?? []),
    encoding.map((link): CodecFact => [String(visit(walk, link.to)), opaqueFact("transformation")]),
    Option.match(Option.fromUndefinedOr(ast.context), {
      onNone: () => [],
      onSome: (context): CodecFact => [String(context.isOptional), String(context.isMutable)],
    }),
  ]
  return place
}

const encodeFacts = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** What the contract reads of an RPC: what `Rpc.exitSchema` and the serialization read. */
interface ContractRpc {
  readonly _tag: string
  readonly payloadSchema: Schema.Top
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly defectSchema: Schema.Top
  readonly annotations: Context.Context<never>
  readonly middlewares: ReadonlySet<{ readonly error: Schema.Top }>
}

/**
 * One RPC as the wire decodes it: its tag, its parse options, and the JSON
 * codecs of its payload, its success (or a stream's chunk and error), its
 * error, each middleware's error and its defect: the parts of its exit
 * (`Rpc.exitSchema`).
 */
const rpcFacts = (rpc: ContractRpc) => {
  const walk: CodecWalk = { nodes: [], places: new Map() }
  const codec = (schema: Schema.Top) => String(visit(walk, Schema.toCodecJson(schema).ast))
  let success: CodecFact = ["once", codec(rpc.successSchema)]
  if (RpcSchema.isStreamSchema(rpc.successSchema)) {
    success = ["stream", codec(rpc.successSchema.success), codec(rpc.successSchema.error)]
  }
  const roots: CodecFact = [
    rpc._tag,
    encodeFacts(Context.get(rpc.annotations, Rpc.ParseOptions)),
    codec(rpc.payloadSchema),
    success,
    codec(rpc.errorSchema),
    [...rpc.middlewares].map((middleware) => codec(middleware.error)),
    codec(rpc.defectSchema),
  ]
  return encodeFacts([roots, walk.nodes])
}

/** The contract's own version: another way to compute it names another. */
const CONTRACT_VERSION = "gent link 3"

/**
 * Only a clean commit names shared code. A dev build or no release names
 * this process alone, even if another process runs the same dirty checkout.
 */
const releaseFact = (release: GentRelease, process: string): string => {
  if (release._tag === "Released" && release.clean) return `release ${release.commit}`
  return `process ${process}`
}

/**
 * The contract of `rpcs`: the release this process runs and what each RPC's
 * codecs decode, sorted by tag, hashed. Two servers whose contracts match
 * run one release and decode each other's frames the same way.
 *
 * The release (`GentPlatform.source`) is the commit gent was built from
 * and whether its checkout was clean. Owner machines install from clean
 * commits with frozen dependencies (server.md, Machine Links).
 * A codec holds code no walk reads (an exit is a declaration, a
 * defect a transformation); the release names that code, and the codec
 * facts are a second factor. Data is described as data: every node's kind,
 * each literal, key, optional and mutable mark, union mode, element and
 * rest, and every check Effect names, with its payload (a pattern's source
 * and flags). With no release, the contract names an id drawn for this
 * process, and no other process matches it: the link stays incompatible.
 */
export const rpcContract = (
  rpcs: ReadonlyArray<ContractRpc>,
): Effect.Effect<string, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const release = releaseFact(yield* platform.source, yield* platform.processId)
    return platform.hash(
      "sha256",
      [CONTRACT_VERSION, release, ...rpcs.map(rpcFacts).sort()].join("\n"),
    )
  })

/** This server's contract: `GentRpcs`'s. `Links` computes it once. */
export const linkContract: Effect.Effect<string, never, GentPlatform> = rpcContract([
  ...GentRpcs.requests.values(),
])

// ── release mismatch ────────────────────────────────────────────────────────

/** The shell string runs on the named machine, with the checkout quoted once there. */
const updateShell = (checkout: string) =>
  `cd ${Result.getOrElse(CommandLine.quote(checkout), () => "'<gent checkout>'")} && git pull --ff-only && bun install --frozen-lockfile && bun run install:global`

/** A configured ssh argv stops at gent; its remaining argument is one remote shell string. */
const updateCommand = (hello: LinkHello, command: ReadonlyArray<string> = []) => {
  const shell = updateShell(hello.checkout ?? "<gent checkout>")
  if (command.length === 0) return shell
  const gent = command.findIndex((word) => word === "gent" || word.endsWith("/gent"))
  let prefix = command
  if (gent >= 0) prefix = command.slice(0, gent)
  if (prefix.length === 0) return shell
  return Result.getOrElse(CommandLine.join([...prefix, shell]), () => "<invalid link command>")
}

/**
 * Why two contracts cannot link, with the command that repairs each side.
 * Only local git decides ancestry. Missing commits, divergence or a failed
 * read name both commands; no remote command runs to form this message.
 */
export const linkMismatch = Effect.fn("Links.mismatch")(function* (
  local: LinkHello,
  far: LinkHello,
  command: ReadonlyArray<string>,
): Effect.fn.Return<string, never, ChildProcessSpawner.ChildProcessSpawner> {
  const localCommand = updateCommand(local)
  const farCommand = updateCommand(far, command)
  const there = far.checkout ?? "<gent checkout>"
  const here = local.checkout ?? "<gent checkout>"
  const one = local.release
  const other = far.release
  let commits = ""
  if (one._tag === "Released" && other._tag === "Released" && one.commit !== other.commit)
    commits = `; commits ${other.commit.slice(0, 8)} there, ${one.commit.slice(0, 8)} here`
  if (other._tag === "Released" && !other.clean)
    return `${far.machine} runs a dev build (uncommitted changes in ${there}${commits}); commit or stash there, then: ${farCommand}`
  if (one._tag === "Released" && !one.clean)
    return `This machine runs a dev build (uncommitted changes in ${here}${commits}); commit or stash here, then: ${localCommand}`
  if (other._tag === "Unreleased")
    return `${far.machine} runs a build with no release (no git checkout); update ${far.machine}: ${farCommand}`
  if (one._tag === "Unreleased")
    return `This machine runs a build with no release (no git checkout); update this machine: ${localCommand}`
  const shortFar = other.commit.slice(0, 8)
  const shortLocal = one.commit.slice(0, 8)
  if (one.commit === other.commit)
    return `${far.machine} runs ${shortFar} but decodes RPCs differently (another Bun?); reinstall both: ${localCommand}; ${farCommand}`
  const summary = `${far.machine} runs ${shortFar}; this machine runs ${shortLocal}.`
  if (Predicate.isString(local.checkout)) {
    const ancestor = (before: string, after: string) =>
      runProcess("git", ["merge-base", "--is-ancestor", before, after], {
        cwd: local.checkout,
        timeout: Duration.seconds(10),
      }).pipe(
        Effect.map(({ exitCode }) => exitCode),
        Effect.orElseSucceed(() => 128),
      )
    const localBehind = yield* ancestor(one.commit, other.commit)
    if (localBehind === 0) return `${summary} Update this machine: ${localCommand}`
    if (localBehind === 1 && (yield* ancestor(other.commit, one.commit)) === 0)
      return `${summary} Update ${far.machine}: ${farCommand}`
  }
  return `${summary} Update both (ancestry unavailable or diverged): ${localCommand}; ${farCommand}`
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
  /** The last hello named another contract or machine (or none); a matching hello clears it. */
  readonly reason: Option.Option<string>
}

const stateOf = (record: LinkRecord, now: number): LinkView["state"] => {
  if (Option.isSome(record.reason)) return "incompatible"
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
    readonly hello: Effect.Effect<LinkHello>
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
        // Idle servers never read their checkout. The first hello (outgoing
        // or incoming) starts one read; every hello and contract shares it.
        //
        // The read is the layer's. Its close interrupts the read, so no git
        // starts after it, and `runProcess` kills the git child it holds
        // (SIGTERM, then SIGKILL after the force-kill window). The close
        // signals the interrupt and does not wait for that kill: an awaited
        // kill yields the close to the event loop, and a turn the closing
        // server still runs records a step in that gap (the recovered-turn
        // tests in turn.test.ts). A fiber in the layer's scope
        // (`forkScoped`) would make the close await it.
        const needed = yield* Deferred.make<void>()
        const reading = yield* Effect.forkDetach(
          Effect.gen(function* () {
            yield* Deferred.await(needed)
            const platform = yield* GentPlatform
            const release = yield* platform.source
            const checkout = yield* platform.checkout
            return new LinkHello({
              machine: own,
              contract: yield* linkContract,
              release,
              ...Option.match(checkout, {
                onNone: () => ({}),
                onSome: (checkout) => ({ checkout }),
              }),
            })
          }).pipe(Effect.provideService(GentPlatform, yield* GentPlatform)),
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => reading.interruptUnsafe()))
        const hello = Deferred.succeed(needed, void 0).pipe(Effect.andThen(Fiber.join(reading)))
        const contract = Effect.map(hello, (value) => value.contract)
        const started = yield* Clock.currentTimeMillis
        const records = new Map<string, MutableRef.MutableRef<LinkRecord>>()
        for (const machine of Object.keys(yield* config.linkMachines)) {
          if (machine === own) continue
          records.set(
            machine,
            MutableRef.make<LinkRecord>({
              lastFrame: started,
              connected: false,
              reason: Option.none(),
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
                const reason = `${machine} has no link.hello this server reads; update ${machine}: ${updateCommand(new LinkHello({ machine, contract: "", release: GentRelease.cases.Unreleased.make({ process: "older-peer" }) }), command)}`
                yield* Effect.sync(() =>
                  MutableRef.update(record, (kept) => ({ ...kept, reason: Option.some(reason) })),
                )
                return reason
              }
              if (hello.value.contract !== (yield* contract)) {
                const reason = yield* linkMismatch(yield* Fiber.join(reading), hello.value, command)
                yield* Effect.sync(() =>
                  MutableRef.update(record, (kept) => ({ ...kept, reason: Option.some(reason) })),
                )
                return reason
              }
              // The machine is the peer's identity on both links: this
              // link's name, and the origin the peer's own link sends. A
              // command that reaches another machine, or this one, would
              // count one server under two names.
              if (hello.value.machine !== machine) {
                const reason = `${machine} answers as machine ${hello.value.machine}; fix its link.machines command`
                yield* Effect.sync(() =>
                  MutableRef.update(record, (kept) => ({ ...kept, reason: Option.some(reason) })),
                )
                return reason
              }
              yield* Effect.sync(() =>
                MutableRef.update(record, (kept) => ({
                  ...kept,
                  connected: true,
                  reason: Option.none(),
                })),
              )
              // The peer's facts count as this server's own link's; this
              // server's go to the peer as its link's.
              const pull = run.client.accounts
                .pool()
                .pipe(
                  Stream.runForEach((facts) => placement.notePeer(facts, scopeOf, machine, "own")),
                )
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
              yield* placement.runsLink(machine)
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
          hello,
          view: Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const views: Array<LinkView> = []
            for (const [machine, record] of records) {
              const kept = MutableRef.get(record)
              views.push({
                machine,
                state: stateOf(kept, now),
                ...Option.match(kept.reason, {
                  onNone: () => ({}),
                  onSome: (reason) => ({ reason }),
                }),
              })
            }
            return views
          }),
        })
      }),
    )
}
