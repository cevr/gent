import { test } from "bun:test"
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Ref } from "effect"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { BunSqlite } from "@gent/core/host-bun"
import {
  BranchId,
  ExtensionContext,
  omitUndefined,
  SessionId,
  ToolCallId,
  WakeNext,
} from "@gent/core/extensions/api"
import {
  makeTempDirectoryScoped,
  runToolWithCtx,
  testLeafContext,
  testToolContext,
} from "@gent/core/test-utils"
import {
  adoptGates,
  type Check,
  gateDue,
  type GateRecord,
  GateState,
  Integration,
  IntegrationPushTool,
  IntegrationStore,
  verdictOf,
} from "../src/integration.js"
import {
  ACTIONS_APP,
  BASE,
  CANDIDATE,
  fakeGitHub,
  FIX,
  KEY,
  OUTSIDE,
  type Remote,
  type Required,
  type Run,
} from "./helpers/fake-github"

// ── harness ─────────────────────────────────────────────────────────────────

/** The Bun platform the server gives the extension: files, paths and `Crypto`. */
const Platform = Layer.merge(BunServices.layer, BunCrypto.layer)

interface PushParams {
  readonly ref: string
  readonly sha?: string
  readonly remote?: string
  readonly repairOf?: number
  readonly requestId?: string
}

const HOST = { sessionId: SessionId.make("host-session"), branchId: BranchId.make("host-branch") }

interface Sent {
  readonly sessionId?: string
  readonly content: string
  readonly customType: unknown
}

/** One server's gate over a scratch database, with a branch facade that records wakes and sends. */
const harness = (initial: Partial<Remote> = {}) =>
  Effect.gen(function* () {
    const dir = yield* makeTempDirectoryScoped("gent-integration-")
    const github = yield* fakeGitHub(initial)
    const wakes = yield* Ref.make<ReadonlyArray<{ sourceId: string; at?: number }>>([])
    const cancels = yield* Ref.make<ReadonlyArray<string>>([])
    const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
    const stub = testToolContext().Session
    const ctx = testToolContext({
      ...HOST,
      cwd: dir,
      home: dir,
      Session: {
        ...stub,
        send: (params) =>
          Ref.update(sent, (all) => [
            ...all,
            {
              content: params.content,
              customType: params.metadata?.customType,
              ...omitUndefined({ sessionId: params.sessionId }),
            },
          ]),
      },
      Wakes: () => ({
        wakeAt: (input) =>
          Ref.update(wakes, (all) => [
            ...all,
            { sourceId: input.sourceId, ...omitUndefined({ at: input.at }) },
          ]),
        cancelWake: (input) =>
          Ref.update(cancels, (all) => [...all, input.sourceId]).pipe(Effect.as(true)),
      }),
    })
    const services = yield* Layer.build(
      Layer.mergeAll(
        Integration.Live.pipe(Layer.provide(BunSqlite.file(`${dir}/gent.db`))),
        github.layer,
      ),
    )
    const leaf = testLeafContext(ctx)
    /** Runs a hook or service call as this branch's leaf. */
    const asLeaf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(ExtensionContext, leaf), Effect.provideContext(services))
    const push = (params: PushParams, id = "call-1") =>
      runToolWithCtx(IntegrationPushTool, params, { ...ctx, toolCallId: ToolCallId.make(id) }).pipe(
        Effect.provideContext(services),
      )
    const record = asLeaf(Effect.flatMap(Integration, (integration) => integration.read(KEY)))
    const fire = Effect.gen(function* () {
      const [wake] = (yield* Ref.get(wakes)).slice(-1)
      if (Predicate.isUndefined(wake)) return yield* Effect.die("no wake armed")
      return yield* asLeaf(gateDue({ sourceId: wake.sourceId, at: Option.none(), cause: "due" }))
    })
    return { ...github, ctx, asLeaf, push, record, fire, wakes, cancels, sent }
  })

const stateOf = (record: Option.Option<{ readonly state: GateState }>) =>
  Option.map(record, (found) => found.state)

const green = (name: string, sha: string): Run => ({
  name,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
})

const tagOf = (record: Option.Option<{ readonly state: GateState }>) =>
  Option.map(record, (found) => found.state._tag)

/** A write to the gate's row that no admission saw: the row's version moves on. */
const moveRecord = (
  gate: Effect.Success<ReturnType<typeof harness>>,
  change: (record: GateRecord) => GateRecord,
) =>
  gate
    .asLeaf(
      Effect.gen(function* () {
        const store = yield* IntegrationStore
        const stored = Option.getOrThrow(yield* store.read(KEY))
        expect(yield* store.write(Option.some(stored.version), change(stored.record))).toBe(true)
      }),
    )
    .pipe(Effect.orDie)

// ── the gate ────────────────────────────────────────────────────────────────

describe("integration.push", () => {
  it.live("pushes, waits on CI for the pushed commit, and tells its host once at green", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      const pushed = yield* gate.push({ ref: "main" })
      expect(pushed).toMatchObject({ generation: 1, sha: CANDIDATE, state: "AwaitingCi" })
      expect(gate.remote.pushes).toEqual([CANDIDATE])
      expect(yield* Ref.get(gate.wakes)).toHaveLength(1)
      gate.addRun(green("test", CANDIDATE))
      expect((yield* gate.fire)._tag).toBe("Done")
      expect(stateOf(yield* gate.record)).toEqual(
        Option.some(GateState.cases.Clear.make({ sha: CANDIDATE })),
      )
      yield* gate.fire
      const sent = yield* Ref.get(gate.sent)
      expect(sent.map((message) => message.customType)).toEqual(["integration"])
      expect(sent[0]?.sessionId).toBe(HOST.sessionId)
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a stale green for an older commit does not clear the pushed one", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      gate.addRun(green("test", BASE))
      yield* gate.push({ ref: "main" })
      const next = yield* gate.fire
      expect(next._tag).toBe("At")
      expect(stateOf(yield* gate.record).pipe(Option.map((state) => state._tag))).toEqual(
        Option.some("AwaitingCi"),
      )
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a failing check that is not required does not keep the gate from green", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      yield* gate.push({ ref: "main" })
      // deploy-site runs only on some paths; it is not required.
      gate.addRun(green("test", CANDIDATE))
      gate.addRun({
        name: "deploy-site",
        head_sha: CANDIDATE,
        status: "completed",
        conclusion: "failure",
      })
      yield* gate.fire
      expect(stateOf(yield* gate.record).pipe(Option.map((state) => state._tag))).toEqual(
        Option.some("Clear"),
      )
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a skipped required check keeps the gate awaiting CI", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      yield* gate.push({ ref: "main" })
      gate.addRun({ name: "test", head_sha: CANDIDATE, status: "completed", conclusion: "skipped" })
      expect((yield* gate.fire)._tag).toBe("At")
      expect(stateOf(yield* gate.record).pipe(Option.map((state) => state._tag))).toEqual(
        Option.some("AwaitingCi"),
      )
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live(
    "with no readable protection, all reported runs green clears; none seen stays awaiting",
    () =>
      Effect.gen(function* () {
        const gate = yield* harness({ required: Option.none() })
        yield* gate.push({ ref: "main" })
        expect((yield* gate.fire)._tag).toBe("At")
        expect(stateOf(yield* gate.record).pipe(Option.map((state) => state._tag))).toEqual(
          Option.some("AwaitingCi"),
        )
        gate.addRun(green("lint", CANDIDATE))
        gate.addRun(green("test", CANDIDATE))
        yield* gate.fire
        expect(stateOf(yield* gate.record).pipe(Option.map((state) => state._tag))).toEqual(
          Option.some("Clear"),
        )
      }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("red blocks a second push and admits the recorded repair", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      yield* gate.push({ ref: "main" })
      gate.addRun({ name: "test", head_sha: CANDIDATE, status: "completed", conclusion: "failure" })
      yield* gate.fire
      const red = stateOf(yield* gate.record)
      expect(red.pipe(Option.map((state) => state._tag))).toEqual(Option.some("Red"))
      const blocked = yield* gate.push({ ref: "main", sha: FIX }, "call-2").pipe(Effect.exit)
      expect(Exit.isFailure(blocked) && String(blocked.cause)).toContain("IntegrationBlocked")
      const wrong = yield* gate
        .push({ ref: "main", sha: FIX, repairOf: 7 }, "call-3")
        .pipe(Effect.exit)
      expect(Exit.isFailure(wrong) && String(wrong.cause)).toContain("IntegrationBlocked")
      expect(gate.remote.pushes).toEqual([CANDIDATE])
      const repaired = yield* gate.push({ ref: "main", sha: FIX, repairOf: 1 }, "call-4")
      expect(repaired).toMatchObject({ generation: 2, sha: FIX, state: "AwaitingCi" })
      expect(gate.remote.pushes).toEqual([CANDIDATE, FIX])
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  for (const gh of ["missing", "signed-out"] as const) {
    it.live(`gh ${gh} refuses the claim with no record written and no push`, () =>
      Effect.gen(function* () {
        const gate = yield* harness({ gh })
        const refused = yield* gate.push({ ref: "main" }).pipe(Effect.exit)
        expect(Exit.isFailure(refused) && String(refused.cause)).toContain("GhUnavailable")
        expect(yield* gate.record).toEqual(Option.none())
        expect(gate.remote.pushes).toEqual([])
        expect(yield* Ref.get(gate.wakes)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(Platform)),
    )
  }

  it.live("a server error on the protection read refuses the claim, not the fallback", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      gate.remote.protectionFails = true
      const refused = yield* gate.push({ ref: "main" }).pipe(Effect.exit)
      expect(Exit.isFailure(refused) && String(refused.cause)).toContain("503")
      const record = Option.getOrThrow(yield* gate.record)
      expect([record.state._tag, record.generation]).toEqual(["Clear", 0])
      expect(gate.remote.pushes).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a gh error while awaiting CI keeps the gate, records it, and backs off", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      yield* gate.push({ ref: "main" })
      gate.remote.apiFails = true
      const first = yield* gate.fire
      const afterFirst = Option.getOrThrow(yield* gate.record)
      expect(afterFirst.state._tag).toBe("AwaitingCi")
      expect(afterFirst.lastCheck?.error).toContain("502")
      const firstAt = afterFirst.lastCheck?.at ?? 0
      expect((afterFirst.nextPollAt ?? 0) - firstAt).toBe(30_000)
      expect(first).toEqual(WakeNext.cases.At.make({ at: afterFirst.nextPollAt ?? 0 }))
      yield* gate.fire
      const afterSecond = Option.getOrThrow(yield* gate.record)
      expect(afterSecond.lastCheck?.failures).toBe(2)
      expect((afterSecond.nextPollAt ?? 0) - (afterSecond.lastCheck?.at ?? 0)).toBe(60_000)
      gate.remote.apiFails = false
      gate.addRun(green("test", CANDIDATE))
      yield* gate.fire
      expect(stateOf(yield* gate.record).pipe(Option.map((state) => state._tag))).toEqual(
        Option.some("Clear"),
      )
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("the same request id twice pushes once", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      const first = yield* gate.push({ ref: "main", requestId: "unit-3" }, "call-1")
      const again = yield* gate.push({ ref: "main", requestId: "unit-3" }, "call-2")
      expect(first.replayed).toBe(false)
      expect(again).toMatchObject({ generation: 1, sha: CANDIDATE, replayed: true })
      expect(gate.remote.pushes).toEqual([CANDIDATE])
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a push by someone else becomes the gate's subject", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      yield* gate.push({ ref: "main" })
      gate.addRun(green("test", CANDIDATE))
      gate.remote.head = OUTSIDE
      yield* gate.fire
      expect(stateOf(yield* gate.record)).toEqual(
        Option.some(
          GateState.cases.AwaitingCi.make({ generation: 2, sha: OUTSIDE, adopted: true }),
        ),
      )
      gate.addRun(green("test", OUTSIDE))
      yield* gate.fire
      expect(stateOf(yield* gate.record)).toEqual(
        Option.some(GateState.cases.Clear.make({ sha: OUTSIDE })),
      )
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("concurrent pushes on one ref serialize: the second meets the first's CI", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const gate = yield* harness({
        pushGate: Option.some(held),
        pushStarted: Option.some(started),
      })
      const first = yield* gate.push({ ref: "main" }, "call-1").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const second = yield* gate
        .push({ ref: "main", sha: FIX }, "call-2")
        .pipe(Effect.exit, Effect.forkChild)
      // oxlint-disable-next-line effect/noFixedWaitInTests -- an absence has no event: the second push must not reach the remote while the first is held
      yield* Effect.sleep("100 millis")
      expect(gate.remote.pushes).toEqual([])
      yield* Deferred.succeed(held, void 0)
      expect((yield* Fiber.join(first)).sha).toBe(CANDIDATE)
      const refused = yield* Fiber.join(second)
      expect(Exit.isFailure(refused) && String(refused.cause)).toContain("IntegrationBlocked")
      expect(gate.remote.pushes).toEqual([CANDIDATE])
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a commit that does not fast-forward the head is refused with nothing written", () =>
    Effect.gen(function* () {
      const gate = yield* harness({ diverged: new Set([CANDIDATE]) })
      const refused = yield* gate.push({ ref: "main" }).pipe(Effect.exit)
      expect(Exit.isFailure(refused) && String(refused.cause)).toContain("PushRefused")
      expect(gate.remote.pushes).toEqual([])
      expect(stateOf(yield* gate.record)).toEqual(Option.some(GateState.cases.Clear.make({})))
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live(
    "a record that moves after admission read it loses the claim, and nothing is pushed",
    () =>
      Effect.gen(function* () {
        const gate = yield* harness()
        // Between the admission read and the claim, another writer turns the gate red.
        gate.remote.onAncestry = Option.some(
          Effect.suspend(() => {
            gate.remote.onAncestry = Option.none()
            return moveRecord(gate, (record) => ({
              ...record,
              generation: 1,
              state: GateState.cases.Red.make({ generation: 1, sha: BASE, failing: [] }),
            }))
          }),
        )
        const blocked = yield* gate.push({ ref: "main" }).pipe(Effect.exit)
        expect(Exit.isFailure(blocked) && String(blocked.cause)).toContain("is red")
        expect(gate.remote.pushes).toEqual([])
        expect(tagOf(yield* gate.record)).toEqual(Option.some("Red"))
      }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a record that moves under every claim is blocked after three tries, with no push", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      gate.remote.onAncestry = Option.some(
        Effect.suspend(() => moveRecord(gate, (record) => record)),
      )
      const blocked = yield* gate.push({ ref: "main" }).pipe(Effect.exit)
      expect(Exit.isFailure(blocked) && String(blocked.cause)).toContain(
        "changed under 3 claims in a row",
      )
      expect(gate.remote.pushes).toEqual([])
      expect(stateOf(yield* gate.record)).toEqual(Option.some(GateState.cases.Clear.make({})))
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a fire while a push is in flight leaves the claim to the push", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const gate = yield* harness({
        pushGate: Option.some(held),
        pushStarted: Option.some(started),
      })
      const pushing = yield* gate.push({ ref: "main" }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      // The remote is still at the base: a reconcile now would call the push crashed.
      const fire = yield* gate.fire.pipe(Effect.forkChild)
      // oxlint-disable-next-line effect/noFixedWaitInTests -- an absence has no event: the fire must not move the claim while the push holds it
      yield* Effect.sleep("200 millis")
      expect(tagOf(yield* gate.record)).toEqual(Option.some("Integrating"))
      yield* Deferred.succeed(held, void 0)
      expect(yield* Fiber.join(pushing)).toMatchObject({ generation: 1, state: "AwaitingCi" })
      yield* Fiber.join(fire)
      const after = Option.getOrThrow(yield* gate.record)
      expect(after.state).toEqual(
        GateState.cases.AwaitingCi.make({ generation: 1, sha: CANDIDATE, adopted: false }),
      )
      expect(after.lastPush?.outcome).toBeUndefined()
      expect(gate.remote.pushes).toEqual([CANDIDATE])
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a required context reported only on a later page decides the gate", () =>
    Effect.gen(function* () {
      const gate = yield* harness({ pageSize: 2 })
      yield* gate.push({ ref: "main" })
      gate.addRun(green("lint", CANDIDATE))
      gate.addRun(green("build", CANDIDATE))
      gate.addRun({ name: "test", head_sha: CANDIDATE, status: "in_progress" })
      yield* gate.fire
      expect(tagOf(yield* gate.record)).toEqual(Option.some("AwaitingCi"))
      gate.remote.runs[2] = { ...green("test", CANDIDATE), id: 3 }
      yield* gate.fire
      expect(tagOf(yield* gate.record)).toEqual(Option.some("Clear"))
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("with no readable protection, a failure on a later page is not green", () =>
    Effect.gen(function* () {
      const gate = yield* harness({ required: Option.none(), pageSize: 2 })
      yield* gate.push({ ref: "main" })
      gate.addRun(green("lint", CANDIDATE))
      gate.addRun(green("test", CANDIDATE))
      gate.addRun({ name: "e2e", head_sha: CANDIDATE, status: "completed", conclusion: "failure" })
      yield* gate.fire
      expect(tagOf(yield* gate.record)).toEqual(Option.some("Red"))
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a passing check run does not hide a failing status of the same name", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      yield* gate.push({ ref: "main" })
      gate.addRun(green("test", CANDIDATE))
      gate.addStatus({ context: "test", sha: CANDIDATE, state: "failure" })
      yield* gate.fire
      const red = Option.getOrThrow(yield* gate.record).state
      expect(red._tag).toBe("Red")
      expect(red._tag === "Red" && red.failing).toEqual([
        { context: "test", source: "status", conclusion: "failure" },
      ])
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a requirement pinned to an app is not met by another app's run", () =>
    Effect.gen(function* () {
      const pinned: ReadonlyArray<Required> = [{ context: "test", appId: ACTIONS_APP }]
      const gate = yield* harness({ required: Option.some(pinned) })
      yield* gate.push({ ref: "main" })
      gate.addRun({ ...green("test", CANDIDATE), appId: 99 })
      gate.addStatus({ context: "test", sha: CANDIDATE, state: "success" })
      yield* gate.fire
      expect(tagOf(yield* gate.record)).toEqual(Option.some("AwaitingCi"))
      gate.addRun(green("test", CANDIDATE))
      yield* gate.fire
      expect(tagOf(yield* gate.record)).toEqual(Option.some("Clear"))
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  for (const conclusion of ["skipped", "neutral"] as const) {
    it.live(`with no readable protection, a ${conclusion} run keeps the gate awaiting CI`, () =>
      Effect.gen(function* () {
        const gate = yield* harness({ required: Option.none() })
        yield* gate.push({ ref: "main" })
        gate.addRun(green("lint", CANDIDATE))
        gate.addRun({ name: "test", head_sha: CANDIDATE, status: "completed", conclusion })
        yield* gate.fire
        expect(tagOf(yield* gate.record)).toEqual(Option.some("AwaitingCi"))
      }).pipe(Effect.scoped, Effect.provide(Platform)),
    )
  }
})

describe("integration recovery", () => {
  const plantIntegrating = (gate: Effect.Success<ReturnType<typeof harness>>) =>
    gate.asLeaf(
      Effect.gen(function* () {
        const store = yield* IntegrationStore
        yield* store.write(Option.none(), {
          ...KEY,
          generation: 1,
          state: GateState.cases.Integrating.make({
            generation: 1,
            candidate: CANDIDATE,
            expectedBase: BASE,
            requestId: "call-1",
            prior: GateState.cases.Clear.make({}),
          }),
          host: { ...HOST, poller: "integration", notify: true },
          required: [{ context: "test" }],
        })
      }),
    )

  it.live(
    "a crash after the push reconciles to awaiting CI from the remote head, with no push",
    () =>
      Effect.gen(function* () {
        const gate = yield* harness({ head: CANDIDATE })
        yield* plantIntegrating(gate)
        yield* gate.asLeaf(adoptGates())
        yield* gate.fire
        expect(stateOf(yield* gate.record)).toEqual(
          Option.some(
            GateState.cases.AwaitingCi.make({ generation: 1, sha: CANDIDATE, adopted: false }),
          ),
        )
        expect(gate.remote.pushes).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a verdict whose tell a crash lost is told on the next fire, once", () =>
    Effect.gen(function* () {
      const gate = yield* harness({ head: CANDIDATE })
      yield* gate.asLeaf(
        Effect.gen(function* () {
          const store = yield* IntegrationStore
          yield* store.write(Option.none(), {
            ...KEY,
            generation: 1,
            state: GateState.cases.Clear.make({ sha: CANDIDATE }),
            host: { ...HOST, poller: "integration", notify: true },
            toldGeneration: 0,
          })
        }),
      )
      yield* gate.asLeaf(adoptGates())
      expect(yield* Ref.get(gate.wakes)).toHaveLength(1)
      expect((yield* gate.fire)._tag).toBe("Done")
      expect((yield* gate.fire)._tag).toBe("Done")
      const sent = yield* Ref.get(gate.sent)
      expect(sent.map((message) => message.customType)).toEqual(["integration"])
      expect(gate.remote.pushes).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a crash before the push goes back to the state before it, with no push", () =>
    Effect.gen(function* () {
      const gate = yield* harness({ head: BASE })
      yield* plantIntegrating(gate)
      yield* gate.asLeaf(adoptGates())
      expect((yield* gate.fire)._tag).toBe("Done")
      expect(stateOf(yield* gate.record)).toEqual(Option.some(GateState.cases.Clear.make({})))
      expect(gate.remote.pushes).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a push that never landed is not pushed again under its request id", () =>
    Effect.gen(function* () {
      const gate = yield* harness({ head: BASE })
      yield* plantIntegrating(gate)
      const again = yield* gate.push({ ref: "main", requestId: "call-1" }).pipe(Effect.exit)
      expect(Exit.isFailure(again) && String(again.cause)).toContain("PushInterrupted")
      expect(gate.remote.pushes).toEqual([])
      expect(Option.getOrThrow(yield* gate.record).lastPush).toEqual({
        requestId: "call-1",
        generation: 1,
        sha: CANDIDATE,
        outcome: "Interrupted",
      })
      // A new request pushes on purpose.
      const fresh = yield* gate.push({ ref: "main", requestId: "call-2" })
      expect(fresh).toMatchObject({ generation: 2, sha: CANDIDATE, replayed: false })
      expect(gate.remote.pushes).toEqual([CANDIDATE])
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )

  it.live("a loop open adopts a gate no branch waits for and arms its fire", () =>
    Effect.gen(function* () {
      const gate = yield* harness({ head: CANDIDATE })
      yield* gate.asLeaf(
        Effect.gen(function* () {
          const store = yield* IntegrationStore
          yield* store.write(Option.none(), {
            ...KEY,
            generation: 1,
            state: GateState.cases.AwaitingCi.make({
              generation: 1,
              sha: CANDIDATE,
              adopted: false,
            }),
          })
        }),
      )
      yield* gate.asLeaf(adoptGates())
      expect(Option.getOrThrow(yield* gate.record).host).toEqual({
        ...HOST,
        poller: "integration",
        notify: false,
      })
      expect(yield* Ref.get(gate.wakes)).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )
})

describe("integration.clear", () => {
  it.live("a clear needs a reason, and the record keeps who, when and why", () =>
    Effect.gen(function* () {
      const gate = yield* harness()
      yield* gate.push({ ref: "main" })
      const clear = (reason: string) =>
        gate.asLeaf(
          Effect.flatMap(Integration, (integration) => integration.clear({ ...KEY, reason })),
        )
      const blank = yield* clear("   ").pipe(Effect.exit)
      expect(Exit.isFailure(blank)).toBe(true)
      expect(stateOf(yield* gate.record).pipe(Option.map((state) => state._tag))).toEqual(
        Option.some("AwaitingCi"),
      )
      const cleared = yield* clear("CI never reports on this repo")
      expect(cleared.state).toEqual(GateState.cases.Clear.make({ sha: CANDIDATE }))
      expect(cleared.cleared).toMatchObject({ reason: "CI never reports on this repo", ...HOST })
      expect(yield* Ref.get(gate.cancels)).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(Platform)),
  )
})

describe("verdictOf", () => {
  const check = (context: string, conclusion: Check["conclusion"]): Check => ({
    context,
    source: "check-run",
    appId: ACTIONS_APP,
    conclusion,
  })
  const required = (...contexts: ReadonlyArray<string>) =>
    Option.some(contexts.map((context) => ({ context })))
  test("a neutral required context is not green", () => {
    expect(verdictOf(required("test"), [check("test", "neutral")])._tag).toBe("Pending")
  })
  test("a missing required context is not green", () => {
    expect(verdictOf(required("test", "e2e"), [check("test", "success")])._tag).toBe("Pending")
  })
  test("a status satisfies an unpinned requirement but never a pinned one", () => {
    const status: Check = { context: "test", source: "status", conclusion: "success" }
    expect(verdictOf(required("test"), [status])._tag).toBe("Green")
    const pinned = Option.some([{ context: "test", appId: ACTIONS_APP }])
    expect(verdictOf(pinned, [status])._tag).toBe("Pending")
  })
})
