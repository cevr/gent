/**
 * A server stand-in for the account-lane crash test: the test root over the
 * SQLite file `<LH_DIR>/gent.db` and gent's data dir `LH_DIR` (the placement
 * ledger, `credential-usage.json`, is there), with the starter's model on the
 * `anthropic` sign-in `work`. The test ends it with SIGKILL, so no finalizer
 * runs and no ledger write follows, then starts it again over the same files.
 *
 * - `LH_START`: create a session and send it one message. Its turn's model
 *   call never ends in this process.
 * - Absent, the host makes no client call until `<LH_DIR>/open` exists; then
 *   it reads the session `<LH_DIR>/session.json` names, which reopens its
 *   loop, and the cut turn runs again. That call answers once
 *   `<LH_DIR>/go` exists.
 *
 * Each event the test waits on is one stdout line that starts with `LH `:
 * `ready`, `sent`, `opened`, and `load <n>` each time the lane load of
 * `anthropic` changes, first read before any session call.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { BuiltinExtensions } from "@gent/extensions"
import { CredentialSlot } from "@gent/core/extensions/api"
import { BranchId, SessionId } from "@gent/core/protocol"
import {
  ConfigService,
  createE2ELayer,
  createRpcClient,
  finishPart,
  LanguageModelLayers,
  TEST_MODEL_ID,
  textDeltaPart,
  UserConfig,
  waitFor,
} from "@gent/core/test-utils"

const Started = Schema.fromJsonString(Schema.Struct({ sessionId: SessionId, branchId: BranchId }))

/** A line the test waits on. */
const event = (line: string) => Console.log(`LH ${line}`)

const program = Effect.gen(function* () {
  const dir = yield* Config.String("LH_DIR")
  const start = Option.isSome(yield* Config.option(Config.String("LH_START")))
  const fs = yield* FileSystem.FileSystem
  const exists = (file: string) =>
    fs.exists(`${dir}/${file}`).pipe(Effect.orElseSucceed(() => false))
  // The first host's turn never answers; the second's answers once the test lets it.
  const providerLayer = LanguageModelLayers.testStream(() => {
    if (start) return Effect.succeed(Stream.never)
    return waitFor(exists("go"), (go) => go, 60_000, "the test let the turn end").pipe(
      Effect.as(Stream.fromIterable([textDeltaPart("done"), finishPart({ finishReason: "stop" })])),
      Effect.orDie,
    )
  })
  const { client } = yield* createRpcClient(
    createE2ELayer({
      agents: [],
      extensionInputs: BuiltinExtensions.filter(
        (extension) => extension.manifest.id !== "@gent/cell",
      ),
      providerLayer,
      configServiceLayer: ConfigService.Test(
        new UserConfig({
          model: TEST_MODEL_ID,
          providers: { anthropic: { authOrder: [CredentialSlot.make("work")] } },
        }),
      ),
      storagePath: `${dir}/gent.db`,
      cwd: dir,
      home: dir,
    }),
  )
  yield* event("ready")
  // The load of `anthropic`, each change of it one line, the first before any session call.
  const seen = yield* Ref.make(Option.none<number>())
  const report = Effect.gen(function* () {
    const { providers } = yield* client.accounts.lanes()
    const load = providers.find((lanes) => lanes.provider === "anthropic")?.load ?? -1
    const before = yield* Ref.getAndSet(seen, Option.some(load))
    if (Option.contains(before, load)) return
    yield* event(`load ${load}`)
  })
  yield* report
  yield* Effect.forkScoped(report.pipe(Effect.repeat(Schedule.spaced("50 millis"))))
  if (start) {
    const created = yield* client.session.create({ cwd: dir })
    const named = yield* Schema.encodeEffect(Started)({
      sessionId: created.sessionId,
      branchId: created.branchId,
    })
    yield* fs.writeFileString(`${dir}/session.json`, named)
    yield* client.message.send({ ...created, content: "work on it" })
    yield* event("sent")
  } else {
    yield* waitFor(exists("open"), (open) => open, 60_000, "the test let the session open")
    const session = yield* Schema.decodeEffect(Started)(
      yield* fs.readFileString(`${dir}/session.json`),
    )
    yield* client.session.getSnapshot(session)
    yield* event("opened")
  }
  return yield* Effect.never
})

// The layer runs the host as it is built; only a signal ends it.
BunRuntime.runMain(
  Effect.scoped(Layer.build(Layer.effectDiscard(program).pipe(Layer.provide(BunServices.layer)))),
)
