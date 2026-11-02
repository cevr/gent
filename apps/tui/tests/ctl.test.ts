/**
 * `gent ctl` at its seam: the command a shell runs, parsed by effect/cli,
 * against a real sqlite server on the scripted model in a scratch home. A
 * call finds that server through the data directory's lock, as a shell does.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { BuiltinExtensions } from "@gent/extensions"
import { ReviewRound } from "@gent/extensions/client"
import {
  defineExtension,
  ExtensionHost,
  type GentExtension,
  request,
} from "@gent/core/extensions/api"
import {
  CredentialSlot,
  decodeRequestReply,
  PoolFacts,
  RequestReply,
  ReviewMessage,
  ReviewSession,
} from "@gent/core/protocol"
import {
  BunGentPlatformLive,
  makeTempDirectoryScoped,
  serveModelCatalogFixture,
  TEST_MODEL_ID,
} from "@gent/core/test-utils"
import { Gent } from "@gent/sdk"
import {
  Cause,
  Clock,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Order,
  Ref,
  Runtime,
  Schedule,
  Schema,
  Scope,
  Sink,
  Stdio,
  Stream,
  Tracer,
} from "effect"
import { CTL_EXIT, CtlResult, runCtlCli } from "../src/ctl"

// ── harness ─────────────────────────────────────────────────────────────────

interface CtlRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run `gent ctl <args>` through its process boundary with `HOME` set to
 * `home`; collect its exit code and streams. `brokenStdout` makes a write to
 * stdout die, as a closed pipe can. `stdout` lets a test read stdout while
 * the call still runs. `stdin` is what the call reads on its stdin, which
 * then closes; none by default. `clock` is the call's own clock, not the
 * server's; the wall clock by default. `tracer` takes the call's spans, one
 * per RPC it sends. `env` adds variables to the call's environment.
 */
const runCtl = (
  home: string,
  args: ReadonlyArray<string>,
  options: {
    readonly brokenStdout?: boolean
    readonly stdout?: Ref.Ref<string>
    readonly stdin?: string
    readonly clock?: Clock.Clock
    readonly tracer?: Tracer.Tracer
    readonly env?: Readonly<Record<string, string>>
  } = {},
) =>
  Effect.gen(function* () {
    const out = options.stdout ?? (yield* Ref.make(""))
    const err = yield* Ref.make("")
    const capture = (into: Ref.Ref<string>) =>
      Sink.forEach((chunk: string | Uint8Array) => Ref.update(into, (text) => text + String(chunk)))
    const clocked = Option.match(Option.fromUndefinedOr(options.clock), {
      onNone: () => runCtlCli(args, "test"),
      onSome: (clock) => runCtlCli(args, "test").pipe(Effect.provideService(Clock.Clock, clock)),
    })
    const cli = Option.match(Option.fromUndefinedOr(options.tracer), {
      onNone: () => clocked,
      onSome: (tracer) => clocked.pipe(Effect.withTracer(tracer)),
    })
    const exit = yield* cli.pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          BunGentPlatformLive,
          Stdio.layerTest({
            stdout: () => {
              if (options.brokenStdout === true) return Sink.die("stdout closed")
              return capture(out)
            },
            stderr: () => capture(err),
            stdin: Stream.make(new TextEncoder().encode(options.stdin ?? "")),
          }),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...options.env, HOME: home } })),
        ),
      ),
      Effect.exit,
    )
    const code = Exit.match(exit, {
      onSuccess: () => CTL_EXIT.ok,
      // The boundary turns a defect into `CtlFailed`; one that slips past exits 1 as the runtime does.
      onFailure: (cause) =>
        Option.match(Cause.findErrorOption(cause), {
          onNone: () => CTL_EXIT.failed,
          onSome: (error) => Runtime.getErrorExitCode(error),
        }),
    })
    return { code, stdout: yield* Ref.get(out), stderr: yield* Ref.get(err) } satisfies CtlRun
  })

/** The wall clock `skewMs` ahead (a negative skew: behind): a ctl on another machine. */
const skewedClock = (skewMs: number): Clock.Clock => {
  const wall = Clock.Clock.defaultValue()
  const millis = () => wall.currentTimeMillisUnsafe() + skewMs
  const nanos = () => wall.currentTimeNanosUnsafe() + BigInt(skewMs) * 1_000_000n
  return {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => wall.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: wall.monotonicTimeNanos,
    sleep: (duration) => wall.sleep(duration),
  }
}

/** A ctl whose clock reads two minutes off the server's, either way. */
const SKEWS = [
  ["two minutes ahead of", 120_000],
  ["two minutes behind", -120_000],
] as const

const decodeResult = Schema.decodeEffect(Schema.fromJsonString(CtlResult))
const decodePoolLine = Schema.decodeEffect(Schema.fromJsonString(PoolFacts))
const encodePoolLine = Schema.encodeEffect(Schema.fromJsonString(PoolFacts))

/** The one JSON value a successful call printed, decoded as the result `tag` names. */
const resultAs =
  <Tag extends CtlResult["_tag"]>(tag: Tag) =>
  (run: CtlRun) =>
    Effect.gen(function* () {
      expect({ code: run.code, stderr: run.stderr }).toEqual({ code: CTL_EXIT.ok, stderr: "" })
      const result = yield* decodeResult(run.stdout)
      const isTag = (value: CtlResult): value is Extract<CtlResult, { readonly _tag: Tag }> =>
        value._tag === tag
      if (!isTag(result)) return yield* Effect.die(`expected ${tag}, printed ${result._tag}`)
      return result
    })

const ErrorLine = Schema.Struct({ _tag: Schema.String, message: Schema.optionalKey(Schema.String) })

/** The message of the one error line, which every refusal below carries. */
const messageOf = (run: CtlRun) => Effect.map(errorOf(run), (error) => error.message ?? "")

/** The one tagged JSON error line a failed call printed on stderr. */
const errorOf = (run: CtlRun) =>
  Effect.gen(function* () {
    expect(run.stdout).toBe("")
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
    return yield* Schema.decodeEffect(Schema.fromJsonString(ErrorLine))(run.stderr)
  })

/**
 * A sqlite server on the scripted model, owning the scratch home's data
 * directory. `ledger` is the account ledger (`credential-usage.json`) the
 * server reads as it starts; `config` is the home's `.gent/config.json`;
 * `extensions` replaces the shipped ones.
 */
const serveScratchHomeWith = Effect.fn("serveScratchHome")(function* (
  options: {
    readonly ledger?: Schema.Json
    readonly config?: Schema.Json
    readonly extensions?: ReadonlyArray<GentExtension>
  } = {},
) {
  const home = yield* makeTempDirectoryScoped("gent-ctl-")
  const seed = (name: string, json: Option.Option<Schema.Json>) =>
    Effect.gen(function* () {
      if (Option.isNone(json)) return
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${home}/.gent`, { recursive: true })
      yield* fs.writeFileString(
        `${home}/.gent/${name}`,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(json.value),
      )
    }).pipe(Effect.provide(BunServices.layer))
  yield* seed("credential-usage.json", Option.fromUndefinedOr(options.ledger))
  yield* seed("config.json", Option.fromUndefinedOr(options.config))
  const catalogOrigin = yield* serveModelCatalogFixture
  const server = yield* Gent.server({
    cwd: home,
    state: Gent.state.sqlite({ home }),
    provider: Gent.provider.mock(),
    extensions: options.extensions ?? BuiltinExtensions,
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { HOME: home, GENT_MODEL_CATALOG_URL: catalogOrigin } }),
      ),
    ),
  )
  return { home, server }
})

const serveScratchHome = serveScratchHomeWith()

/**
 * The miner's line types, field for field: `Message` and `Session` in
 * `~/.claude/skills/retro/scripts/mine-sessions.ts`, the reader a `gent ctl
 * review` export feeds; its `number` is `Schema.Finite`, as JSON holds no
 * other. A field the miner does not name is gent's own, and the decode keeps
 * no check on it.
 */
const MinerMessage = Schema.Struct({
  src: Schema.String,
  project: Schema.String,
  session: Schema.String,
  ts: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["msg", "slash", "interrupt", "limit", "peer"]),
  text: Schema.String,
})
const MinerSession = Schema.Struct({
  src: Schema.String,
  project: Schema.String,
  session: Schema.String,
  sub: Schema.Boolean,
  bytes: Schema.Finite,
  first: Schema.optionalKey(Schema.String),
  last: Schema.optionalKey(Schema.String),
  human: Schema.Finite,
  peer: Schema.Finite,
  interrupts: Schema.Finite,
  compactions: Schema.Finite,
  limits: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  output: Schema.Finite,
  skills: Schema.Record(Schema.String, Schema.Finite),
  slash: Schema.Record(Schema.String, Schema.Finite),
  agents: Schema.Finite,
  rereads: Schema.Record(Schema.String, Schema.Finite),
  skipped: Schema.optionalKey(Schema.Literal(true)),
})

/** Each line of an export's two miner files, decoded as the miner's type: none fails. */
const minerLines = (out: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const lines = (name: string) =>
      Effect.map(fs.readFileString(`${out}/${name}`), (text) =>
        text.split("\n").filter((line) => line.length > 0),
      )
    const messages = yield* Effect.forEach(yield* lines("messages.jsonl"), (line) =>
      Schema.decodeEffect(Schema.fromJsonString(MinerMessage))(line),
    )
    const sessions = yield* Effect.forEach(yield* lines("sessions.jsonl"), (line) =>
      Schema.decodeEffect(Schema.fromJsonString(MinerSession))(line),
    )
    expect(sessions.length).toBeGreaterThan(0)
    return { messages, sessions }
  })

/** A call in `home`'s workspace, and the one result it printed as `tag`. */
const ctlIn = (home: string) => ({
  run: (args: ReadonlyArray<string>) => runCtl(home, [...args, "--cwd", home]),
  as: <Tag extends CtlResult["_tag"]>(tag: Tag, args: ReadonlyArray<string>) =>
    runCtl(home, [...args, "--cwd", home]).pipe(Effect.flatMap(resultAs(tag))),
})

// ── a turn, end to end ──────────────────────────────────────────────────────

describe("gent ctl against a running server", () => {
  it.live(
    "send --new --wait runs a turn; events, wait, snapshot and status read it back",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home } = yield* serveScratchHome
          const gent = ctlIn(home)

          const ended = yield* gent.as("TurnEnded", [
            "send",
            "--new",
            "--model",
            TEST_MODEL_ID,
            "--wait",
            "hello there",
          ])
          expect(ended.ok).toBe(true)
          expect(ended.flags).toEqual([])
          expect(ended.replyChars).toBeGreaterThan(0)
          expect(Option.isSome(ended.from)).toBe(true)

          // The newest conversation in --cwd is the one send started.
          const tail = yield* gent.run(["events", "--limit", "3"])
          const page = yield* resultAs("Events")(tail)
          expect(page.sessionId).toBe(ended.sessionId)
          expect(page.events).toHaveLength(3)
          // The session's name may land after the turn; the cursor is the last record's id.
          expect(page.events.map((event) => event.tag)).toContain("TurnCompleted")
          expect(page.cursor).toEqual(Option.fromUndefinedOr(page.events.at(-1)?.id))
          // One record per line: the header, three records, the closing line.
          expect(tail.stdout.trimEnd().split("\n")).toHaveLength(5)

          // A cursor pages forward from the first event; a tag filter keeps only its tags.
          const first = yield* gent.as("Events", ["events", "--since", "0", "--limit", "1"])
          expect(first.more).toBe(true)
          const after = yield* gent.as("Events", [
            "events",
            "--since",
            String(Option.getOrThrow(first.cursor)),
            "--tags",
            "MessageReceived,TurnCompleted",
          ])
          const tags = after.events.map((event) => event.tag)
          expect(new Set(tags)).toEqual(new Set(["MessageReceived", "TurnCompleted"]))
          expect(tags.at(-1)).toBe("TurnCompleted")
          expect(after.events.every((event) => event.id > Option.getOrThrow(first.cursor))).toBe(
            true,
          )
          expect(after.events.find((event) => event.role === "user")?.text).toBe("hello there")

          // A wait for a turn that already ended answers from the stored events.
          const again = yield* gent.as("TurnEnded", [
            "wait",
            "--message",
            Option.getOrThrow(Option.fromUndefinedOr(ended.messageId)),
          ])
          expect(again.cursor).toBe(ended.cursor)

          const snapshot = yield* gent.as("Snapshot", ["snapshot"])
          expect(snapshot.runtime).toBe("Idle")
          expect(snapshot.model).toBe(TEST_MODEL_ID)
          expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"])
          expect(snapshot.messages[0]?.text).toBe("hello there")

          const status = yield* gent.as("Status", ["status"])
          expect(status.runtime).toBe("Idle")
          expect(status.server).toContain("/rpc")

          // A defect crosses the boundary as one CtlFailed line, never a stack trace.
          const broken = yield* runCtl(home, ["status", "--cwd", home], { brokenStdout: true })
          expect(broken.code).toBe(CTL_EXIT.failed)
          expect((yield* errorOf(broken))._tag).toBe("CtlFailed")
          expect(yield* messageOf(broken)).toContain("stdout closed")
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  // The runtime's start is the server's time: a ctl whose clock is off reads
  // how long the turn has run on the server's clock, from the snapshot's now.
  for (const [where, skewMs] of SKEWS) {
    it.live(
      `status on a ctl ${where} the server reads how long the turn has run`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { home, server } = yield* serveScratchHome
            const { client } = yield* Gent.client(server, { cwd: home })
            const before = yield* Clock.currentTimeMillis
            // The scripted turn runs `sleep 20`: it is running for a while.
            yield* client.session.create({
              cwd: home,
              modelId: TEST_MODEL_ID,
              initialPrompt: "debug ask",
            })
            const statusRun = runCtl(home, ["status", "--cwd", home], {
              clock: skewedClock(skewMs),
            }).pipe(Effect.flatMap(resultAs("Status")))
            const status = yield* statusRun.pipe(
              Effect.repeat({
                until: (read) => (read.runningMs ?? 0) >= 1_000,
                schedule: Schedule.spaced("50 millis"),
              }),
              Effect.timeout("10 seconds"),
            )
            const after = yield* Clock.currentTimeMillis
            expect(status.runtime).not.toBe("Idle")
            expect(status.runningMs).toBeLessThanOrEqual(after - before)
          }).pipe(Effect.timeout("25 seconds")),
        ),
      30_000,
    )
  }

  // status reads the runtime's first state and the lanes reply's server
  // time, never the snapshot: the snapshot folds every event of the branch.
  it.live(
    "status reads the runtime and the lanes reply, never the snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home, server } = yield* serveScratchHome
          const { client } = yield* Gent.client(server, { cwd: home })
          yield* client.session.create({
            cwd: home,
            modelId: TEST_MODEL_ID,
            initialPrompt: "debug ask",
          })
          const rpcs: Array<string> = []
          const tracer = Tracer.make({
            span(options) {
              rpcs.push(options.name)
              return new Tracer.NativeSpan(options)
            },
          })
          const run = yield* runCtl(home, ["status", "--cwd", home], { tracer })
          yield* resultAs("Status")(run)
          expect(rpcs.some((name) => name.endsWith("session.watchRuntime"))).toBe(true)
          expect(rpcs.some((name) => name.endsWith("accounts.lanes"))).toBe(true)
          expect(rpcs.filter((name) => name.endsWith("session.getSnapshot"))).toEqual([])
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  // `send` returns at admission; only `--wait` waits for the turn. The
  // scripted `debug ask` turn runs `sleep 20`, past the call's time limit.
  it.live(
    "send without --wait returns while its turn still runs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home, server } = yield* serveScratchHome
          const gent = ctlIn(home)
          const sent = yield* gent
            .as("Sent", ["send", "--new", "--model", TEST_MODEL_ID, "debug ask"])
            .pipe(Effect.timeout("10 seconds"))
          const { client } = yield* Gent.client(server, { cwd: home })
          const runtime = yield* client.session
            .watchRuntime({ sessionId: sent.sessionId, branchId: sent.branchId })
            .pipe(Stream.runHead)
          expect(Option.map(runtime, (state) => state._tag)).not.toEqual(Option.some("Idle"))
          // `--timeout` bounds the whole wait, the send's turn included.
          const waited = yield* gent
            .run([
              "send",
              "--new",
              "--model",
              TEST_MODEL_ID,
              "--wait",
              "--timeout",
              "1",
              "debug ask",
            ])
            .pipe(Effect.timeout("10 seconds"))
          expect(waited.code).toBe(CTL_EXIT.timedOut)
          expect((yield* errorOf(waited))._tag).toBe("CtlWaitTimedOut")
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a send retried under one request id admits one message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home } = yield* serveScratchHome
          const gent = ctlIn(home)
          const started = yield* gent.as("TurnEnded", [
            "send",
            "--new",
            "--model",
            TEST_MODEL_ID,
            "--wait",
            "first",
          ])
          const session = ["--session", started.sessionId]
          const sendOnce = gent.as("Sent", ["send", ...session, "--request-id", "retry-1", "again"])
          const one = yield* sendOnce
          const two = yield* sendOnce
          expect(two.messageId).toBe(one.messageId)
          yield* gent.as("TurnEnded", ["wait", ...session, "--message", one.messageId])
          const snapshot = yield* gent.as("Snapshot", ["snapshot", ...session])
          expect(
            snapshot.messages.filter((message) => message.role === "user").map((m) => m.text),
          ).toEqual(["first", "again"])
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "send --new retried under one request id starts one session with one message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home, server } = yield* serveScratchHome
          const gent = ctlIn(home)
          const sendNew = gent.as("Sent", [
            "send",
            "--new",
            "--model",
            TEST_MODEL_ID,
            "--request-id",
            "new-1",
            "start here",
          ])
          const one = yield* sendNew
          const two = yield* sendNew
          expect(two.sessionId).toBe(one.sessionId)
          expect(two.messageId).toBe(one.messageId)
          const { client } = yield* Gent.client(server, { cwd: home })
          const sessions = yield* client.session.list()
          expect(sessions.map((session) => session.id)).toEqual([one.sessionId])
          yield* gent.as("TurnEnded", ["wait", "--message", one.messageId])
          const snapshot = yield* gent.as("Snapshot", ["snapshot"])
          expect(
            snapshot.messages.filter((message) => message.role === "user").map((m) => m.text),
          ).toEqual(["start here"])
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "request sends an extension request on the session and prints its reply",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home } = yield* serveScratchHome
          const gent = ctlIn(home)
          yield* gent.as("TurnEnded", ["send", "--new", "--model", TEST_MODEL_ID, "--wait", "hi"])
          const reply = yield* gent.as("Reply", [
            "request",
            "--extension",
            "@gent/skills",
            "--id",
            "skills-list",
          ])
          const skills = yield* decodeRequestReply(Schema.Array(Schema.Unknown))(reply.reply)
          expect(Array.isArray(skills)).toBe(true)
          // A reply whose rows leave optional fields unset still crosses the
          // wire: the sessions pane reads this listing.
          const listing = yield* gent.as("Reply", [
            "request",
            "--extension",
            "@gent/agents-view",
            "--id",
            "list-agents",
            "--input",
            '{"query":""}',
          ])
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ rows: Schema.Array(Schema.Struct({ sessionId: Schema.String })) }),
          )(yield* decodeRequestReply(Schema.Unknown)(listing.reply))
          expect(rows.rows.length).toBeGreaterThan(0)
          // A void reply crosses the wire as `Void`: `/goal status` presents and returns nothing.
          const goal = yield* gent.as("Reply", [
            "request",
            "--extension",
            "@gent/goal",
            "--id",
            "goal-command",
            "--input",
            '"status"',
          ])
          expect(goal.reply).toEqual(RequestReply.cases.Void.make({}))
          // The server checks the input against the request's schema: a run id
          // that is not one is refused before the handler runs ...
          const statusRequest = (input: string) =>
            gent.run([
              "request",
              "--extension",
              "@gent/machines",
              "--id",
              "run-status",
              "--input",
              input,
            ])
          const refused = yield* statusRequest('{"run":"not-a-run"}')
          expect(refused.code).toBe(CTL_EXIT.failed)
          expect((yield* errorOf(refused))._tag).toBe("CtlFailed")
          expect(yield* messageOf(refused)).toContain("input decode failed")
          // ... and a well-formed one reaches the handler, which finds no such run.
          const absentRun = "run-0123456789abcdef"
          const control = yield* statusRequest(`{"run":"${absentRun}"}`)
          expect(control.code).toBe(CTL_EXIT.failed)
          expect(yield* messageOf(control)).toContain(`No run ${absentRun}`)
          expect(yield* messageOf(control)).not.toContain("input decode failed")
          // `status --run` is the machines extension's view of the same request.
          const view = yield* gent.run(["status", "--run", absentRun])
          expect(view.code).toBe(CTL_EXIT.failed)
          expect(yield* messageOf(view)).toContain(`No run ${absentRun}`)
          const badView = yield* gent.run(["status", "--run", "not-a-run"])
          expect(yield* messageOf(badView)).toContain("input decode failed")
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a wait that sees nothing exits 124 and names the last event it read",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home } = yield* serveScratchHome
          const gent = ctlIn(home)
          const ended = yield* gent.as("TurnEnded", [
            "send",
            "--new",
            "--model",
            TEST_MODEL_ID,
            "--wait",
            "hi",
          ])
          const timedOut = yield* gent.run([
            "wait",
            "--until",
            "TurnCompleted",
            "--after",
            String(ended.cursor),
            "--timeout",
            "1",
          ])
          expect(timedOut.code).toBe(CTL_EXIT.timedOut)
          const error = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({ _tag: Schema.String, until: Schema.String, cursor: Schema.Finite }),
            ),
          )(timedOut.stderr)
          expect(error._tag).toBe("CtlWaitTimedOut")
          expect(error.until).toBe("TurnCompleted")
          // The cursor is the last event the wait read: the turn's end, or a later name update.
          const latest = yield* gent.as("Events", ["events", "--limit", "1"])
          expect(error.cursor).toBeGreaterThanOrEqual(ended.cursor)
          expect(error.cursor).toBeLessThanOrEqual(Option.getOrThrow(latest.cursor))

          // An --until the parser accepts but no event names is a usage error.
          const unknown = yield* gent.run(["wait", "--until", "Nothing"])
          expect(unknown.code).toBe(CTL_EXIT.usage)
          expect((yield* errorOf(unknown))._tag).toBe("CtlUsage")

          const missing = yield* gent.run(["snapshot", "--session", "no-such-session"])
          expect(missing.code).toBe(CTL_EXIT.notFound)
          expect((yield* errorOf(missing))._tag).toBe("CtlNotFound")
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "lanes needs no session: one Lanes value, or with --line the band's rows, and exit 0",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // A server that read no quota window: no provider, and the row says so.
          const bare = yield* serveScratchHome
          const empty = yield* resultAs("Lanes")(yield* runCtl(bare.home, ["lanes"]))
          expect(empty.providers).toEqual([])
          expect(empty.server).toBe(bare.server.url)
          const unknown = yield* runCtl(bare.home, ["lanes", "--line"])
          expect(unknown).toEqual({ code: CTL_EXIT.ok, stdout: "lanes unknown\n", stderr: "" })

          // A ledger with a reading, two fitted segments and banked resets: the server
          // sizes the lanes. default holds two resets with no expiry and one lapsed a
          // minute ago; work holds only a lapsed one.
          const now = yield* Clock.currentTimeMillis
          const reading = {
            provider: "anthropic",
            slot: "default",
            window: "5h",
            utilization: 0.3,
            resetAt: now + 2 * 3_600_000,
            readAt: now - 60_000,
            rejected: false,
          }
          const segment = (openedAt: number, endedAt: number) => ({
            provider: "anthropic",
            slot: "default",
            window: "5h",
            openedAt,
            endedAt,
            fuel: 240_000,
            deltaPct: 2,
            tokens: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 0 },
          })
          const defaultGrants: ReadonlyArray<Schema.JsonObject> = [
            { count: 2 },
            { count: 1, expiresAt: now - 60_000 },
          ]
          const seeded = yield* serveScratchHomeWith({
            ledger: {
              buckets: [],
              readings: [reading],
              // 2 and 8 minutes long: the fuel runs apart from time, and the
              // fit tells the two.
              segments: [
                segment(now - 720_000, now - 600_000),
                segment(now - 600_000, now - 120_000),
              ],
              resets: [
                {
                  provider: "anthropic",
                  slot: "default",
                  readAt: now - 60_000,
                  grants: defaultGrants,
                },
                {
                  provider: "anthropic",
                  slot: "work",
                  readAt: now - 60_000,
                  grants: [{ count: 1, expiresAt: now - 1 }],
                },
              ],
            },
          })
          const printed = yield* runCtl(seeded.home, ["lanes"])
          // One JSON value, its providers one record per line.
          expect(printed.stdout.split("\n").filter((row) => row.length > 0)).toHaveLength(3)
          const lanes = yield* resultAs("Lanes")(printed)
          const [anthropic] = lanes.providers
          expect({
            provider: anthropic?.provider,
            capacity: anthropic?.capacity,
            load: anthropic?.load,
            fuelPerPct: anthropic?.accounts[0]?.windows[0]?.fuelPerPct,
            samples: anthropic?.accounts[0]?.windows[0]?.samples,
            resets: anthropic?.accounts.map((account) => ({
              slot: String(account.slot),
              resets: account.resets,
            })),
          }).toEqual({
            provider: "anthropic",
            capacity: 1,
            load: 0,
            fuelPerPct: 120_000,
            samples: 2,
            // A lapsed grant counts none: default keeps its live two, work none at all.
            resets: [{ slot: "default", resets: [{ count: 2 }] }],
          })
          // 60 points left to the 90% stop at 120k a point over 2 h, at 3.4 M an hour: one run.
          // The band is the rate's standard error: √(1/6 / (2² + 2²)), 14%.
          const line = yield* runCtl(seeded.home, ["lanes", "--line"])
          expect(line).toEqual({
            code: CTL_EXIT.ok,
            stdout:
              "lanes anthropic 1/1 free · 5h 120k/% ±14% · out 0%\nresets anthropic default 2\n",
            stderr: "",
          })
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a stored lone segment sets no rate: the band reads the provider unknown, not 0 free",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // A ledger an older gent wrote on an account Claude Code shares: one
          // 12k-token turn of 20,000 fuel spanned a 1-point move of both windows.
          // A lone segment judges no outside spend, so it names no rate on load.
          const now = yield* Clock.currentTimeMillis
          const windows = [
            { window: "5h", utilization: 0.3, resetAt: now + 3 * 3_600_000 },
            { window: "7d", utilization: 0.89, resetAt: now + 50 * 3_600_000 },
          ]
          const seeded = yield* serveScratchHomeWith({
            ledger: {
              buckets: [],
              readings: windows.map((window) => ({
                provider: "anthropic",
                slot: "default",
                ...window,
                readAt: now - 60_000,
                rejected: false,
              })),
              segments: windows.map(({ window }) => ({
                provider: "anthropic",
                slot: "default",
                window,
                endedAt: now - 60_000,
                fuel: 20_000,
                deltaPct: 1,
                tokens: { input: 12_000, output: 0, cacheRead: 0, cacheWrite: 0 },
              })),
            },
          })
          const lanes = yield* Effect.flatMap(runCtl(seeded.home, ["lanes"]), resultAs("Lanes"))
          const [anthropic] = lanes.providers
          expect(anthropic?.capacity).toBeUndefined()
          const fitted = anthropic?.accounts[0]?.windows ?? []
          expect(fitted.map(({ window, samples }) => ({ window, samples }))).toEqual([
            { window: "5h", samples: 0 },
            { window: "7d", samples: 0 },
          ])
          for (const window of fitted) expect(window.fuelPerPct).toBeUndefined()
          const line = yield* runCtl(seeded.home, ["lanes", "--line"])
          expect(line).toEqual({
            code: CTL_EXIT.ok,
            stdout: "lanes anthropic unknown\n",
            stderr: "",
          })
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "pool needs no session: one Pool value and exit 0, or with --follow bare PoolFacts lines until the server stops",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // A ledger with the account's weekly reading: its reset is the account's `week`.
          const now = yield* Clock.currentTimeMillis
          const weekEnd = now + 100 * 3_600_000
          const serverScope = yield* Scope.make()
          const seeded = yield* serveScratchHomeWith({
            ledger: {
              buckets: [],
              readings: [
                {
                  provider: "anthropic",
                  slot: "default",
                  window: "7d",
                  utilization: 0.3,
                  resetAt: weekEnd,
                  readAt: now - 60_000,
                  rejected: false,
                },
              ],
            },
          }).pipe(Scope.provide(serverScope))
          const printed = yield* runCtl(seeded.home, ["pool"])
          // One JSON value, its providers one record per line.
          expect(printed.stdout.split("\n").filter((row) => row.length > 0)).toHaveLength(3)
          const facts = yield* resultAs("Pool")(printed)
          expect(facts.server).toBe(seeded.server.url)
          expect(facts.boot).toMatch(/^[0-9a-f]{16}$/)
          // The host's name up to its first dot: the peer's band names this server by it.
          expect(facts.host).toMatch(/^[^.]+$/)
          expect(facts.providers).toEqual([
            {
              provider: "anthropic",
              runs: [],
              accounts: [
                { slot: CredentialSlot.make("default"), live: [], spend: [], week: weekEnd },
              ],
            },
          ])

          // --follow: the same facts as one bare PoolFacts line, and the call runs on.
          const out = yield* Ref.make("")
          const follow = yield* runCtl(seeded.home, ["pool", "--follow"], { stdout: out }).pipe(
            Effect.forkScoped,
          )
          const first = yield* Ref.get(out).pipe(
            Effect.repeat({
              until: (text) => text.includes("\n"),
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("5 seconds"),
          )
          const line = first.slice(0, first.indexOf("\n"))
          const decoded = yield* decodePoolLine(line)
          expect(decoded).toEqual({
            boot: facts.boot,
            host: facts.host,
            seq: facts.seq,
            providers: facts.providers,
          })
          // No `_tag`, no server, no spaces: the line is the facts' own compact JSON.
          expect(yield* encodePoolLine(decoded)).toBe(line)
          expect(follow.pollUnsafe()).toBeUndefined()

          // A reader that hung up: the write fails, and the call ends in one error line and exit 1.
          const hungUp = yield* runCtl(seeded.home, ["pool", "--follow"], { brokenStdout: true })
          expect(hungUp.code).toBe(CTL_EXIT.failed)
          expect((yield* errorOf(hungUp))._tag).toBe("CtlFailed")

          // The server stops: it ends the stream before its listener drains, so
          // neither waits on the other, and the call ends in one error line and exit 1.
          yield* Scope.close(serverScope, Exit.void).pipe(Effect.timeout("5 seconds"))
          const ended = yield* Fiber.join(follow).pipe(Effect.timeout("5 seconds"))
          expect(ended.stdout).toBe(first)
          expect(ended.code).toBe(CTL_EXIT.failed)
          expect(ended.stderr.trimEnd().split("\n")).toHaveLength(1)
          const stopped = yield* Schema.decodeEffect(Schema.fromJsonString(ErrorLine))(ended.stderr)
          expect(stopped._tag).toBe("CtlFailed")
          expect(stopped.message).toBe("the server stopped")
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "pool --follow sends each PoolFacts line of its stdin to the server, and a line it cannot read fails it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const seeded = yield* serveScratchHomeWith({
            ledger: {
              buckets: [],
              readings: [
                {
                  provider: "anthropic",
                  slot: "default",
                  window: "7d",
                  utilization: 0.3,
                  resetAt: now + 100 * 3_600_000,
                  readAt: now - 60_000,
                  rejected: false,
                },
              ],
            },
          })
          // The peer's line, as its server's link writes it: two runs on default.
          const peerLine = yield* encodePoolLine({
            boot: "peer",
            host: "peer-host",
            seq: 1,
            providers: [
              {
                provider: "anthropic",
                runs: [{ accounts: [CredentialSlot.make("default")], count: 2 }],
                accounts: [],
              },
            ],
          })
          const out = yield* Ref.make("")
          const follow = yield* runCtl(seeded.home, ["pool", "--follow"], {
            stdout: out,
            stdin: `${peerLine}\n`,
          }).pipe(Effect.forkScoped)
          const loadOf = Effect.map(
            Effect.flatMap(runCtl(seeded.home, ["lanes"]), resultAs("Lanes")),
            (lanes) => lanes.providers.find((lanes) => lanes.provider === "anthropic")?.load,
          )
          const load = yield* loadOf.pipe(
            Effect.repeat({
              until: (found) => found === 2,
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("5 seconds"),
          )
          expect(load).toBe(2)
          // The lanes name the peer: its record in the JSON, its row last in --line.
          const lanes = yield* Effect.flatMap(runCtl(seeded.home, ["lanes"]), resultAs("Lanes"))
          expect(lanes.peer).toMatchObject({
            heard: { host: "peer-host" },
            runs: 2,
            silent: false,
            counted: true,
            down: [],
          })
          const line = yield* runCtl(seeded.home, ["lanes", "--line"])
          expect(line.stdout.trimEnd().split("\n").at(-1)).toMatch(/^peer peer-host 2 runs · \d+s$/)
          // Its stdin closed: the forwarding ended, and the stream still prints.
          yield* Ref.get(out).pipe(
            Effect.repeat({
              until: (text) => text.includes("\n"),
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("5 seconds"),
          )
          expect(follow.pollUnsafe()).toBeUndefined()

          // A line that is no PoolFacts: one CtlFailed line and exit 1, so the link restarts.
          const unread = yield* runCtl(seeded.home, ["pool", "--follow"], {
            stdin: "not facts\n",
          }).pipe(Effect.timeout("5 seconds"))
          expect(unread.code).toBe(CTL_EXIT.failed)
          expect(unread.stderr.trimEnd().split("\n")).toHaveLength(1)
          const failed = yield* Schema.decodeEffect(Schema.fromJsonString(ErrorLine))(unread.stderr)
          expect(failed._tag).toBe("CtlFailed")
          expect(failed.message).toMatch(/^input decode: /)
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  // The peer's last line is dated on the server's clock: `lanes --line`
  // reads its age against the server's now the report carries.
  for (const [where, skewMs] of SKEWS) {
    it.live(
      `lanes --line on a ctl ${where} the server reads the peer's age on the server's clock`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { home } = yield* serveScratchHome
            const peerLine = yield* encodePoolLine({
              boot: "peer",
              host: "peer-host",
              seq: 1,
              providers: [],
            })
            yield* runCtl(home, ["pool", "--follow"], { stdin: `${peerLine}\n` }).pipe(
              Effect.forkScoped,
            )
            // Seconds since the line, read until a whole second has passed: a
            // client behind the server would read 0s, one ahead of it 2m.
            const aged = /^peer peer-host 0 runs · [1-9]\d?s$/
            const peerRow = runCtl(home, ["lanes", "--line"], { clock: skewedClock(skewMs) }).pipe(
              Effect.map((run) => run.stdout.trimEnd().split("\n").at(-1) ?? ""),
            )
            const row = yield* peerRow.pipe(
              Effect.repeat({
                until: (line) => aged.test(line),
                schedule: Schedule.spaced("50 millis"),
              }),
              Effect.timeout("10 seconds"),
            )
            expect(row).toMatch(aged)
          }).pipe(Effect.timeout("25 seconds")),
        ),
      30_000,
    )
  }

  it.live("a flag or argument the parser refuses is one CtlUsage line and exit 2", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("gent-ctl-parse-")
        const unknownFlag = yield* runCtl(home, ["status", "--bogus"])
        expect(unknownFlag.code).toBe(CTL_EXIT.usage)
        expect((yield* errorOf(unknownFlag))._tag).toBe("CtlUsage")
        expect(yield* messageOf(unknownFlag)).toContain("bogus")
        const missingText = yield* runCtl(home, ["send", "--cwd", home])
        expect(missingText.code).toBe(CTL_EXIT.usage)
        expect((yield* errorOf(missingText))._tag).toBe("CtlUsage")
        const notAnInt = yield* runCtl(home, ["events", "--limit", "many"])
        expect(notAnInt.code).toBe(CTL_EXIT.usage)
        expect((yield* errorOf(notAnInt))._tag).toBe("CtlUsage")
        // A help request is no failure.
        const help = yield* runCtl(home, ["status", "--help"])
        expect({ code: help.code, stderr: help.stderr }).toEqual({ code: CTL_EXIT.ok, stderr: "" })
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    ),
  )

  it.live("with no server for the data directory a call exits 3 and starts none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("gent-ctl-empty-")
        const run = yield* runCtl(home, ["status", "--cwd", home])
        expect(run.code).toBe(CTL_EXIT.noServer)
        const error = yield* errorOf(run)
        expect(error._tag).toBe("CtlNoServer")
        // The call started no server: the data directory holds no lock entry.
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.exists(`${home}/.gent/server.lock`)).toBe(false)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    ),
  )

  it.live(
    "review writes the window's owner messages, sessions and digest into --out and nowhere else",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home } = yield* serveScratchHome
          const fs = yield* FileSystem.FileSystem
          const ended = yield* ctlIn(home).as("TurnEnded", [
            "send",
            "--new",
            "--model",
            TEST_MODEL_ID,
            "--wait",
            "review the build output, my token=abc123secret",
          ])
          const before = (yield* fs.readDirectory(home)).toSorted()
          const out = `${home}/review`

          const week = yield* Effect.flatMap(
            runCtl(home, ["review", "--since", "7d", "--out", out]),
            resultAs("Review"),
          )
          expect(week.sessions).toBe(1)
          expect(week.messages).toBe(1)
          expect(week.files).toEqual([
            `${out}/messages.jsonl`,
            `${out}/sessions.jsonl`,
            `${out}/rounds.jsonl`,
            `${out}/roles.jsonl`,
            `${out}/digest.md`,
          ])
          // Nothing outside --out: the home holds what it held, and the directory.
          expect((yield* fs.readDirectory(home)).toSorted()).toEqual(
            [...before, "review"].toSorted(),
          )
          expect((yield* fs.readDirectory(out)).toSorted()).toEqual(
            [
              "digest.md",
              "messages.jsonl",
              "roles.jsonl",
              "rounds.jsonl",
              "sessions.jsonl",
            ].toSorted(),
          )
          const lines = (name: string) =>
            Effect.map(fs.readFileString(`${out}/${name}`), (text) => text.trimEnd().split("\n"))
          const [message] = yield* lines("messages.jsonl")
          expect(
            yield* Schema.decodeEffect(Schema.fromJsonString(ReviewMessage))(message ?? ""),
          ).toEqual({
            src: "gent",
            project: home,
            session: ended.sessionId,
            ts: expect.any(String),
            kind: "msg",
            text: "review the build output, my [REDACTED]",
          })
          const [session] = yield* lines("sessions.jsonl")
          const line = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewSession))(
            session ?? "",
          )
          expect(line).toMatchObject({ session: ended.sessionId, turns: 1, human: 1, peer: 0 })
          // Every line is a line of the miner's own types.
          yield* minerLines(out)
          expect(line.models.map((usage) => usage.model)).toEqual([TEST_MODEL_ID])
          const digest = yield* fs.readFileString(`${out}/digest.md`)
          expect(digest).toStartWith("# Gent session digest")
          expect(digest).toContain(`| ${TEST_MODEL_ID} | 1 |`)
          // The machines extension's file: no machine ran, so no round, and its empty table.
          expect(yield* fs.readFileString(`${out}/rounds.jsonl`)).toBe("")
          expect(digest).toContain("## Machine rounds per role and model")
          // No run moved: no role line, and the roles table's header alone.
          expect(yield* fs.readFileString(`${out}/roles.jsonl`)).toBe("")
          expect(digest).toContain("## Machine roles per model")

          // An ISO date reads the same window; a run again overwrites the files.
          const dated = yield* Effect.flatMap(
            runCtl(home, ["review", "--since", "2020-01-01", "--out", out]),
            resultAs("Review"),
          )
          expect({ sessions: dated.sessions, messages: dated.messages }).toEqual({
            sessions: 1,
            messages: 1,
          })
          expect(yield* lines("messages.jsonl")).toHaveLength(1)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "review of a server without @gent/machines writes the core files and notes the skipped rounds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home } = yield* serveScratchHomeWith({
            config: { disabledExtensions: ["@gent/machines"] },
          })
          const fs = yield* FileSystem.FileSystem
          yield* ctlIn(home).as("TurnEnded", [
            "send",
            "--new",
            "--model",
            TEST_MODEL_ID,
            "--wait",
            "review a server that runs no machines",
          ])
          const out = `${home}/review`
          const review = yield* Effect.flatMap(
            runCtl(home, ["review", "--since", "7d", "--out", out]),
            resultAs("Review"),
          )
          expect(review.files).toEqual([
            `${out}/messages.jsonl`,
            `${out}/sessions.jsonl`,
            `${out}/digest.md`,
          ])
          expect((yield* fs.readDirectory(out)).toSorted()).toEqual(
            ["digest.md", "messages.jsonl", "sessions.jsonl"].toSorted(),
          )
          const digest = yield* fs.readFileString(`${out}/digest.md`)
          expect(digest).toContain("rounds: @gent/machines not loaded")
          expect(digest).not.toContain("## Machine rounds per role and model")
          expect(digest).toContain("roles: @gent/machines not loaded")
          expect(digest).not.toContain("## Machine roles per model")
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "review that fails while it overwrites an export leaves the old export whole and no staging",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // A `@gent/machines` whose rounds page no client decodes: the
          // rounds read fails after the core files were written.
          const brokenMachines = defineExtension({
            id: "@gent/machines",
            setup: Effect.gen(function* () {
              const host = yield* ExtensionHost
              yield* host.register(
                "request",
                request({
                  scope: "server",
                  id: "review-rounds",
                  input: Schema.Struct({}),
                  output: Schema.Literal("broken"),
                  execute: () => Effect.succeed("broken" as const),
                }),
              )
            }),
          })
          const { home } = yield* serveScratchHomeWith({
            extensions: [
              ...BuiltinExtensions.filter(
                (extension) => extension.manifest.id !== "@gent/machines",
              ),
              brokenMachines,
            ],
          })
          const fs = yield* FileSystem.FileSystem
          const out = `${home}/review`
          const old = {
            "messages.jsonl": "old messages\n",
            "sessions.jsonl": "old sessions\n",
            "rounds.jsonl": "old rounds\n",
            "digest.md": "old digest\n",
          }
          yield* fs.makeDirectory(out)
          for (const [name, text] of Object.entries(old)) {
            yield* fs.writeFileString(`${out}/${name}`, text)
          }
          yield* ctlIn(home).as("TurnEnded", [
            "send",
            "--new",
            "--model",
            TEST_MODEL_ID,
            "--wait",
            "a message the failed review read",
          ])
          const before = (yield* fs.readDirectory(home)).toSorted()

          const run = yield* runCtl(home, ["review", "--since", "7d", "--out", out])
          expect(run.code).toBe(CTL_EXIT.failed)
          const error = yield* errorOf(run)
          expect(error._tag).toBe("CtlFailed")
          expect(error.message).toContain("@gent/machines review-rounds")
          // The old export, file for file; the home holds no staging directory.
          expect((yield* fs.readDirectory(out)).toSorted()).toEqual(Object.keys(old).toSorted())
          for (const [name, text] of Object.entries(old)) {
            expect(yield* fs.readFileString(`${out}/${name}`)).toBe(text)
          }
          expect((yield* fs.readDirectory(home)).toSorted()).toEqual(before)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "review under a gent tool or machine command fails plainly and keeps no file",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home } = yield* serveScratchHome
          const fs = yield* FileSystem.FileSystem
          const out = `${home}/review`
          const run = yield* runCtl(home, ["review", "--since", "7d", "--out", out], {
            env: { GENT_COMMAND_TOKEN: "token-of-a-tool" },
          })
          expect(run.code).toBe(CTL_EXIT.failed)
          const error = yield* errorOf(run)
          expect(error._tag).toBe("CtlFailed")
          expect(error.message).toContain("GENT_COMMAND_TOKEN is set")
          expect(yield* fs.exists(out)).toBe(false)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "review writes a machine run's two rounds with role, effort, tokens and outcome",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home } = yield* serveScratchHome
          const fs = yield* FileSystem.FileSystem
          yield* ctlIn(home).as("TurnEnded", [
            "send",
            "--new",
            "--model",
            TEST_MODEL_ID,
            "--wait",
            "debug rounds",
          ])
          const out = `${home}/review`
          const roundLines = Effect.map(fs.readFileString(`${out}/rounds.jsonl`), (text) =>
            text.split("\n").filter((line) => line.length > 0),
          )
          // The rounds run apart from the turn: read the window until both ended.
          const reviewed = Effect.flatMap(
            runCtl(home, ["review", "--since", "7d", "--out", out]),
            resultAs("Review"),
          ).pipe(Effect.andThen(roundLines))
          const lines = yield* reviewed.pipe(
            Effect.repeat({
              until: (found) => found.length >= 2,
              schedule: Schedule.spaced("200 millis"),
            }),
          )
          const rounds = yield* Effect.forEach(lines, (line) =>
            Schema.decodeEffect(Schema.fromJsonString(ReviewRound))(line),
          )
          expect(
            rounds
              .map((round) => ({
                machine: String(round.machine),
                state: String(round.state),
                role: String(round.role ?? "-"),
                model: String(round.model ?? "-"),
                effort: round.effort ?? "-",
                outcome: round.outcome,
              }))
              .toSorted((left, right) => Order.String(left.state, right.state)),
          ).toEqual([
            {
              machine: "rounds",
              state: "draft",
              role: "writer",
              model: TEST_MODEL_ID,
              effort: "low",
              outcome: "verdict",
            },
            {
              machine: "rounds",
              state: "review",
              role: "reviewer",
              model: TEST_MODEL_ID,
              effort: "-",
              outcome: "verdict",
            },
          ])
          for (const round of rounds) {
            expect(round.tokens?.output ?? 0).toBeGreaterThan(0)
          }
          const digest = yield* fs.readFileString(`${out}/digest.md`)
          expect(digest).toContain(`| writer | ${TEST_MODEL_ID}@low | 1 | 0 | verdict 1 |`)
          expect(digest).toContain(`| reviewer | ${TEST_MODEL_ID} | 1 | 0 | verdict 1 |`)
          // A machine of its own, not an orchestrate machine: its `reviewer` thread is no role.
          expect(yield* fs.readFileString(`${out}/roles.jsonl`)).toBe("")
          expect(digest).toContain("## Machine roles per model")
          expect(digest).not.toContain(`| reviewer | ${TEST_MODEL_ID} | - |`)
          yield* minerLines(out)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("40 seconds")),
      ),
    45_000,
  )

  it.live("review refuses a junk --since and a file --out with exit 2, and writes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("gent-ctl-review-")
        const fs = yield* FileSystem.FileSystem
        const out = `${home}/out`
        for (const since of ["junk", "7", "2020-13"]) {
          const run = yield* runCtl(home, ["review", "--since", since, "--out", out])
          expect(run.code).toBe(CTL_EXIT.usage)
          expect((yield* errorOf(run))._tag).toBe("CtlUsage")
          expect(yield* messageOf(run)).toBe(`--since: expected <days>d or a date, got ${since}`)
        }
        expect(yield* fs.exists(out)).toBe(false)
        yield* fs.writeFileString(out, "kept")
        const onFile = yield* runCtl(home, ["review", "--since", "7d", "--out", out])
        expect(onFile.code).toBe(CTL_EXIT.usage)
        expect(yield* messageOf(onFile)).toBe(`--out: ${out} is not a directory`)
        expect(yield* fs.readFileString(out)).toBe("kept")
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    ),
  )
})

// ── compact records ─────────────────────────────────────────────────────────
