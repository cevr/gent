/**
 * `gent ctl` at its seam: the command a shell runs, parsed by effect/cli,
 * against a real sqlite server on the scripted model in a scratch home. A
 * call finds that server through the data directory's lock, as a shell does.
 */
import { describe, expect, it, test } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { BuiltinExtensions } from "@gent/extensions"
import { AgentEvent, BranchId, EventEnvelope, MessageId, SessionId } from "@gent/core/protocol"
import {
  BunGentPlatformLive,
  EventId,
  makeTempDirectoryScoped,
  serveModelCatalogFixture,
  TEST_MODEL_ID,
} from "@gent/core/test-utils"
import { Gent } from "@gent/sdk"
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Ref,
  Runtime,
  Schema,
  Sink,
  Stdio,
} from "effect"
import { Command } from "effect/cli"
import { CTL_EXIT, compactEvents, ctl, CtlResult } from "../src/ctl"

// ── harness ─────────────────────────────────────────────────────────────────

interface CtlRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run `gent ctl <args>` with `HOME` set to `home`; collect its exit code and streams. */
const runCtl = (home: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out = yield* Ref.make("")
    const err = yield* Ref.make("")
    const capture = (into: Ref.Ref<string>) =>
      Sink.forEach((chunk: string | Uint8Array) => Ref.update(into, (text) => text + String(chunk)))
    const exit = yield* Command.runWith(ctl, { version: "test" })(args).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          BunGentPlatformLive,
          Stdio.layerTest({ stdout: () => capture(out), stderr: () => capture(err) }),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
        ),
      ),
      Effect.exit,
    )
    const code = Exit.match(exit, {
      onSuccess: () => CTL_EXIT.ok,
      // A defect has no exit code of its own: the runtime exits 1.
      onFailure: (cause) =>
        Option.match(Cause.findErrorOption(cause), {
          onNone: () => CTL_EXIT.failed,
          onSome: (error) => Runtime.getErrorExitCode(error),
        }),
    })
    return { code, stdout: yield* Ref.get(out), stderr: yield* Ref.get(err) } satisfies CtlRun
  })

const decodeResult = Schema.decodeEffect(Schema.fromJsonString(CtlResult))

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

/** The one tagged JSON error line a failed call printed on stderr. */
const errorOf = (run: CtlRun) =>
  Effect.gen(function* () {
    expect(run.stdout).toBe("")
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
    return yield* Schema.decodeEffect(Schema.fromJsonString(ErrorLine))(run.stderr)
  })

/** A sqlite server on the scripted model, owning the scratch home's data directory. */
const serveScratchHome = Effect.gen(function* () {
  const home = yield* makeTempDirectoryScoped("gent-ctl-")
  const catalogOrigin = yield* serveModelCatalogFixture
  yield* Gent.server({
    cwd: home,
    state: Gent.state.sqlite({ home }),
    provider: Gent.provider.mock(),
    extensions: BuiltinExtensions,
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { HOME: home, GENT_MODEL_CATALOG_URL: catalogOrigin } }),
      ),
    ),
  )
  return home
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
          const home = yield* serveScratchHome
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
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a send retried under one request id admits one message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* serveScratchHome
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
    "request sends an extension request on the session and prints its reply",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* serveScratchHome
          const gent = ctlIn(home)
          yield* gent.as("TurnEnded", ["send", "--new", "--model", TEST_MODEL_ID, "--wait", "hi"])
          const reply = yield* gent.as("Reply", [
            "request",
            "--extension",
            "@gent/skills",
            "--id",
            "skills-list",
          ])
          expect(Array.isArray(reply.reply)).toBe(true)
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
          )(listing.reply)
          expect(rows.rows.length).toBeGreaterThan(0)
          // The server checks the input against the request's schema.
          const refused = yield* gent.run([
            "request",
            "--extension",
            "@gent/machines",
            "--id",
            "run-status",
            "--input",
            '{"run":"not-a-run"}',
          ])
          expect(refused.code).toBe(CTL_EXIT.failed)
          expect((yield* errorOf(refused))._tag).toBe("CtlFailed")
        }).pipe(Effect.timeout("25 seconds")),
      ),
    30_000,
  )

  it.live(
    "a wait that sees nothing exits 124 and names the last event it read",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* serveScratchHome
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
})

// ── compact records ─────────────────────────────────────────────────────────

describe("compact event records", () => {
  const sessionId = SessionId.make("s-1")
  const branchId = BranchId.make("b-1")
  const envelope = (id: number, event: AgentEvent) =>
    EventEnvelope.make({ id: EventId.make(id), event, createdAt: 0 })

  test("a run of stream chunks folds into one record whose id is the last chunk's", () => {
    const chunk = (chunk: string) =>
      AgentEvent.cases.StreamChunk.make({ sessionId, branchId, chunk })
    const records = compactEvents([
      envelope(1, AgentEvent.cases.StreamStarted.make({ sessionId, branchId })),
      envelope(2, chunk("Hel")),
      envelope(3, chunk("lo, ")),
      envelope(4, chunk("world")),
      envelope(
        5,
        AgentEvent.cases.TurnCompleted.make({
          sessionId,
          branchId,
          messageId: MessageId.make("m-1"),
          durationMs: 12,
          interrupted: true,
        }),
      ),
    ])
    expect(records).toEqual([
      { id: 1, tag: "StreamStarted" },
      { id: 4, tag: "StreamChunk", n: 3, text: "Hello, world" },
      { id: 5, tag: "TurnCompleted", message: "m-1", ms: 12, flags: ["interrupted"] },
    ])
  })
})
