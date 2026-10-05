/**
 * Prototype P0 of the durable-actor spike: a gent root on Durable-Object-shaped
 * storage.
 *
 * A fake `DurableObjectStorage` (`durable-object-storage-boundary.ts`) keeps the
 * rules a SQLite-backed Durable Object keeps. `@effect/sql-sqlite-do` turns it
 * into the `SqlClient` the root's storage runs on.
 *
 * The root takes that client as its state (`StateLocation.Hosted`), as a host
 * passes its own. Each rule a statement breaks is recorded with the statement,
 * so one run lists every wall the root meets.
 */
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { SqliteClient as DoSqliteClient } from "@effect/sql-sqlite-do"
import { describe, expect, it } from "effect-bun-test"
import {
  Clock,
  Config,
  Context,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect"
import { Sharding } from "effect/cluster"
import type { SqlClient } from "effect/sql"
import type * as LanguageModel from "effect/ai/LanguageModel"
import { ExtensionContext, tool } from "../../src/extensions/api"
import { type LoadedExtension, LoadedArtifactIdentity } from "../../src/domain/extension"
import { ApprovalService } from "../../src/runtime/extension-host"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { makeInProcessClient, RpcHandlersLive } from "../../src/server/server"
import { workspaceHeadersForCwd } from "../../src/server/workspace-rpc"
import { BranchId, ExtensionId, InteractionRequestId, SessionId } from "../../src/domain/ids"
import { Branch, dateFromMillis, Session } from "../../src/domain/message"
import {
  BranchStorage,
  RelationshipStorage,
  SessionStorage,
  SqliteStorage,
} from "../../src/storage/storage"
import { StorageInitLive } from "../../src/storage/schema"
import { createE2ELayer, createRpcClient, testAgent } from "../../src/test-utils/harness"
import {
  LanguageModelLayers,
  makeTempDirectoryScoped,
  waitFor,
} from "../../src/test-utils/language-model"
import { finishPart, textDeltaPart, textStep, toolCallStep } from "../../src/runtime/provider"
import {
  asDurableObjectStorage,
  type DurableObjectDisk,
  type FakeDurableObjectStorage,
  inTransaction,
  makeDurableObjectDisk,
} from "./durable-object-storage-boundary"

// ── hosted root ─────────────────────────────────────────────────────────────

/** The `SqlClient` a Durable Object host builds over its storage. */
const hostedSqlOf = (storage: FakeDurableObjectStorage): Layer.Layer<SqlClient.SqlClient> =>
  DoSqliteClient.layer({ storage: asDurableObjectStorage(storage) })

/**
 * Tools that count their runs, loaded with an artifact identity as a shipped
 * or user extension is, so a parked call's binding replays in a new
 * activation (Rule 6).
 */
const echoExtension = (runs: Ref.Ref<number>): LoadedExtension => ({
  manifest: { id: ExtensionId.make("@test/hosted-echo") },
  scope: "builtin",
  sourcePath: "test",
  artifactIdentity: LoadedArtifactIdentity.make("@test/hosted-echo@artifact-1"),
  contributions: {
    tools: [
      tool({
        id: "echo",
        description: "Echo the text back",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: ({ text }) => Ref.update(runs, (count) => count + 1).pipe(Effect.as(text)),
      }),
      tool({
        id: "asked_echo",
        description: "Ask, then echo the text back",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: ({ text }) =>
          Effect.gen(function* () {
            const answer = yield* (yield* ExtensionContext).Interaction.approve({
              text: `Echo ${text}?`,
            })
            yield* Ref.update(runs, (count) => count + 1)
            if (!answer.approved) return "declined"
            return text
          }),
      }),
    ],
  },
})

interface HostedRootInput {
  readonly sql: Layer.Layer<SqlClient.SqlClient>
  readonly cwd: string
  readonly home: string
  readonly runs: Ref.Ref<number>
  readonly providerLayer: Layer.Layer<LanguageModel.LanguageModel>
}

const hostedRootInput = (input: HostedRootInput) => ({
  agents: [testAgent],
  extensions: [echoExtension(input.runs)],
  providerLayer: input.providerLayer,
  hostedSql: input.sql,
  cwd: input.cwd,
  home: input.home,
})

/** The root, with the test approval service that answers each ask itself. */
const hostedRoot = (input: HostedRootInput) => createE2ELayer(hostedRootInput(input))

/** The root, with the live approval service: an ask waits on a human. */
const hostedAskingRoot = (input: HostedRootInput) =>
  createE2ELayer({ ...hostedRootInput(input), approvalLayer: ApprovalService.Live })

/** A text step that streams `count` deltas, as a model streams a reply. */
const streamedTextStep = (count: number) => ({
  parts: [
    ...Array.from({ length: count }, (_, index) => textDeltaPart(`w${index} `)),
    finishPart({ finishReason: "stop", usage: { inputTokens: 10, outputTokens: count } }),
  ],
})

// ── measurements ────────────────────────────────────────────────────────────

const HEARTBEAT_MS = 30_000

const WakeRow = Schema.Struct({ pending: Schema.Finite, earliest: Schema.NullOr(Schema.Finite) })
const TagRow = Schema.Struct({ tag: Schema.NullOr(Schema.String) })
const CountRow = Schema.Struct({ n: Schema.Finite })
const TagCountRow = Schema.Struct({ tag: Schema.String, n: Schema.Finite })
const IdRow = Schema.Struct({ id: Schema.String, processed: Schema.Finite })
const ReplyRow = Schema.Struct({ request_id: Schema.String })
const RequestRow = Schema.Struct({ requestId: Schema.String })
const TextRow = Schema.Struct({ v: Schema.String })

/** The first row's count, or 0 for no row. */
const countOf = (rows: ReadonlyArray<typeof CountRow.Type>) =>
  Option.getOrElse(
    Option.map(Option.fromUndefinedOr(rows[0]), (row) => row.n),
    () => 0,
  )

/**
 * The H3 query, prototyped over the cluster's message table: the earliest
 * unprocessed `deliver_at`, else now plus a heartbeat while any unprocessed
 * message exists, else none.
 */
const nextClusterWake = (disk: DurableObjectDisk) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const row = Option.fromUndefinedOr(
      disk.rowsOf(
        WakeRow,
        "SELECT COUNT(*) AS pending, MIN(deliver_at) AS earliest FROM cluster_messages WHERE processed = 0",
      )[0],
    )
    if (Option.isNone(row) || row.value.pending === 0) return Option.none<number>()
    const heartbeat = now + HEARTBEAT_MS
    return Option.some(
      Option.match(Option.fromNullishOr(row.value.earliest), {
        onNone: () => heartbeat,
        onSome: (earliest) => Math.min(earliest, heartbeat),
      }),
    )
  })

const unprocessedTags = (disk: DurableObjectDisk) =>
  disk
    .rowsOf(TagRow, "SELECT tag FROM cluster_messages WHERE processed = 0 ORDER BY id")
    .map((row) => Option.getOrElse(Option.fromNullishOr(row.tag), () => "(envelope)"))

const eventCount = (disk: DurableObjectDisk, tag: string) =>
  Effect.sync(() =>
    countOf(disk.rowsOf(CountRow, "SELECT COUNT(*) AS n FROM events WHERE event_tag = ?", tag)),
  )

const eventTags = (disk: DurableObjectDisk) =>
  Object.fromEntries(
    disk
      .rowsOf(
        TagCountRow,
        "SELECT event_tag AS tag, COUNT(*) AS n FROM events GROUP BY event_tag ORDER BY n DESC",
      )
      .map((row) => [row.tag, row.n]),
  )

const ledgerReport = (disk: DurableObjectDisk) =>
  Object.fromEntries(
    [...disk.ledgers].map(([phase, entry]) => [
      phase,
      {
        statements: entry.statements,
        rowsReturned: entry.rowsReturned,
        rowsWritten: Object.fromEntries(entry.rowsWritten),
        rowsWrittenTotal: [...entry.rowsWritten.values()].reduce((sum, n) => sum + n, 0),
        refusedAfterEviction: entry.refusedAfterEviction,
      },
    ]),
  )

const wallsOf = (disk: DurableObjectDisk) => [
  ...new Set(disk.violations.map((violation) => `${violation.rule}: ${violation.detail}`)),
]

const ReportJson = Schema.fromJsonString(Schema.Unknown)

/** Writes the measurements to `GENT_HOSTED_STORAGE_REPORT` when a run names one. */
const writeReport = (name: string, report: Schema.JsonObject) =>
  Effect.gen(function* () {
    const target = yield* Config.option(Config.String("GENT_HOSTED_STORAGE_REPORT"))
    if (Option.isNone(target)) return
    const json = yield* Schema.encodeEffect(ReportJson)(report).pipe(Effect.orDie)
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${target.value}.${name}.json`, json).pipe(Effect.orDie)
  }).pipe(Effect.provide(BunServices.layer))

const elapsedSince = (start: number) => Effect.map(Clock.currentTimeMillis, (now) => now - start)

const KEEP_ALIVE = "Cluster/Entity/keepAlive"

/** The keep-alive messages and their replies, ids read as exact text. */
const keepAliveRows = (disk: DurableObjectDisk) => ({
  messages: disk.rowsOf(
    IdRow,
    "SELECT CAST(request_id AS TEXT) AS id, processed FROM cluster_messages WHERE tag = ? ORDER BY id",
    KEEP_ALIVE,
  ),
  replies: disk.rowsOf(
    ReplyRow,
    "SELECT CAST(request_id AS TEXT) AS request_id FROM cluster_replies ORDER BY id",
  ),
})

/**
 * One activation of the object: a fresh storage handle, a root built on its
 * client in a scope of its own, and the eviction that kills the handle, then
 * closes the scope. Writes the old activation tries after the eviction are
 * refused.
 */
const activate = <A, E>(
  disk: DurableObjectDisk,
  phase: string,
  build: (sql: Layer.Layer<SqlClient.SqlClient>, scope: Scope.Scope) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const handle = disk.activate("record")
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    disk.setPhase(phase)
    const start = yield* Clock.currentTimeMillis
    const built = yield* build(hostedSqlOf(handle.storage), scope)
    const buildMs = yield* elapsedSince(start)
    let evictedAt = 0
    const evict = Effect.gen(function* () {
      evictedAt = yield* Clock.currentTimeMillis
      handle.evict()
      yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("10 seconds"))
      return yield* elapsedSince(evictedAt)
    })
    return { built, buildMs, evict, evictedAt: () => evictedAt, storage: handle.storage }
  })

/** Builds the root with the RPC handlers and a client in the activation's scope. */
const clientOver = (root: ReturnType<typeof hostedRoot>, cwd: string, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(Layer.provideMerge(RpcHandlersLive, root), scope)
    const client = yield* makeInProcessClient(context, workspaceHeadersForCwd(cwd)).pipe(
      Effect.provideService(Scope.Scope, scope),
    )
    return { context, client }
  })

// ── tests ───────────────────────────────────────────────────────────────────

describe("Durable-Object-shaped storage", () => {
  it.scopedLive("the fake refuses what a Durable Object refuses and nests by savepoint", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-do-rules-")
      const disk = yield* makeDurableObjectDisk(`${dir}/object.db`)
      const { storage } = disk.activate("enforce")
      storage.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
      for (const refused of ["BEGIN", "COMMIT", "SAVEPOINT a", "PRAGMA journal_mode = WAL"]) {
        expect(() => storage.sql.exec(refused)).toThrow("not authorized")
      }
      const many = Array.from({ length: 101 }, (_, index) => index)
      expect(() =>
        storage.sql.exec(`SELECT 1 WHERE 1 IN (${many.map(() => "?").join(",")})`, ...many),
      ).toThrow("bound-parameters")
      expect([...storage.sql.exec("PRAGMA table_info(t)").raw()].length).toBe(2)

      // A nested transaction is a savepoint: its rollback keeps the outer write.
      yield* inTransaction(storage, () =>
        Effect.gen(function* () {
          storage.sql.exec("INSERT INTO t (v) VALUES ('kept')")
          yield* inTransaction(storage, (inner) =>
            Effect.sync(() => {
              storage.sql.exec("INSERT INTO t (v) VALUES ('dropped')")
              inner.rollback()
            }),
          )
        }),
      )
      expect(disk.rowsOf(TextRow, "SELECT v FROM t").map((row) => row.v)).toEqual(["kept"])
      expect(disk.transactions).toEqual({ opened: 2, nested: 1, maxDepth: 2 })
    }),
  )

  it.scopedLive("gent's storage init runs on DO storage under its rules", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-do-init-")
      const disk = yield* makeDurableObjectDisk(`${dir}/object.db`)
      const { storage } = disk.activate("enforce")
      // Init is portable DDL and the generic migrator: no PRAGMA of the
      // connection's, which the host owns.
      yield* Layer.build(StorageInitLive.pipe(Layer.provide(hostedSqlOf(storage))))
      expect(wallsOf(disk)).toEqual([])
      yield* writeReport("init", {
        walls: disk.violations,
        transactions: disk.transactions,
        ledger: ledgerReport(disk),
      })
    }),
  )

  it.scopedLive(
    "a turn evicted after its tool result resumes from the alarm entry alone, with no client",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectoryScoped("gent-do-evict-")
        const cwd = yield* makeTempDirectoryScoped("gent-do-evict-cwd-")
        const home = yield* makeTempDirectoryScoped("gent-do-evict-home-")
        const disk = yield* makeDurableObjectDisk(`${dir}/object.db`)
        const runs = yield* Ref.make(0)
        const root = (
          sql: Layer.Layer<SqlClient.SqlClient>,
          providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
        ) => hostedRoot({ sql, cwd, home, runs, providerLayer })

        // Activation 1: the turn runs its tool, and the object is evicted
        // while step 2 waits on the model.
        const first = yield* LanguageModelLayers.sequence([
          toolCallStep("echo", { text: "hello" }),
          { ...textStep("never emitted"), gated: true },
        ])
        const activation1 = yield* activate(disk, "boot-1", (sql, scope) =>
          createRpcClient(root(sql, first.layer)).pipe(Effect.provideService(Scope.Scope, scope)),
        )
        const { client } = activation1.built
        disk.setPhase("session")
        const { sessionId, branchId } = yield* client.session.create({ cwd })
        disk.setPhase("admission")
        yield* client.message.send({ sessionId, branchId, content: "echo hello" })
        yield* first.controls.waitForCall(0)
        disk.setPhase("step-1")
        yield* first.controls.waitForCall(1)
        const toolResults = countOf(
          disk.rowsOf(
            CountRow,
            "SELECT COUNT(*) AS n FROM content_chunks WHERE part_json LIKE '%\"tool-result\"%'",
          ),
        )
        const heldAtEviction = unprocessedTags(disk)
        const wakeAtEviction = yield* nextClusterWake(disk)
        disk.setPhase("eviction")
        const closeMs = yield* activation1.evict

        // Activation 2, the alarm: build the root and poll the cluster's
        // storage. Nothing is sent.
        const second = yield* LanguageModelLayers.sequence([streamedTextStep(20)])
        const activation2 = yield* activate(disk, "boot-2", (sql, scope) =>
          Layer.buildWithScope(root(sql, second.layer), scope),
        )
        disk.setPhase("resume")
        const resumeStart = yield* Clock.currentTimeMillis
        yield* Context.get(activation2.built, Sharding.Sharding).pollStorage
        yield* waitFor(eventCount(disk, "TurnCompleted"), (n) => n >= 1, 15_000, "TurnCompleted")
        const resumeMs = yield* elapsedSince(resumeStart)

        // The keep-alive replies are written, but their messages stay
        // unprocessed: the reply names a request id read back as a double.
        disk.setPhase("settle")
        yield* waitFor(
          Effect.sync(() => keepAliveRows(disk)),
          (rows) => rows.replies.length >= rows.messages.length,
          5_000,
          "a reply for each keep-alive",
        )
        const keepAlives = keepAliveRows(disk)
        const wakeAfterTurn = yield* nextClusterWake(disk)
        disk.setPhase("eviction-2")
        yield* activation2.evict

        // Activation 3, an alarm with nothing to do: the stale keep-alives
        // come back and wake the loop.
        const third = yield* LanguageModelLayers.sequence([])
        const activation3 = yield* activate(disk, "boot-3", (sql, scope) =>
          Layer.buildWithScope(root(sql, third.layer), scope),
        )
        disk.setPhase("idle-wake")
        const sharding = Context.get(activation3.built, Sharding.Sharding)
        yield* sharding.pollStorage
        const wokenEntities = yield* waitFor(
          sharding.activeEntityCount,
          (count) => count > 0,
          3_000,
          "a woken entity",
        ).pipe(Effect.orElseSucceed(() => 0))
        const wakeWhenIdle = yield* nextClusterWake(disk)

        yield* writeReport("eviction", {
          walls: disk.violations,
          transactions: disk.transactions,
          heldAtEviction,
          wakeAtEvictionInMs: Option.getOrNull(
            Option.map(wakeAtEviction, (at) => at - activation1.evictedAt()),
          ),
          keepAlives,
          wakeAfterTurn: Option.isSome(wakeAfterTurn),
          wokenEntities,
          wakeWhenIdle: Option.isSome(wakeWhenIdle),
          unprocessedWhenIdle: unprocessedTags(disk),
          ms: {
            boot1: activation1.buildMs,
            close1: closeMs,
            rebuild: activation2.buildMs,
            resumeToTurnCompleted: resumeMs,
            rebuildIdle: activation3.buildMs,
          },
          events: eventTags(disk),
          ledger: ledgerReport(disk),
          databaseBytes: activation3.storage.sql.databaseSize,
        })

        // The turn: one completion, the tool once, each model step once.
        expect(toolResults).toBe(1)
        expect(yield* eventCount(disk, "TurnCompleted")).toBe(1)
        expect(yield* Ref.get(runs)).toBe(1)
        expect(yield* first.controls.callCount).toBe(2)
        expect(yield* second.controls.callCount).toBe(1)
        expect(yield* third.controls.callCount).toBe(0)
        expect(heldAtEviction).toEqual([KEEP_ALIVE])
        // No statement breaks a Durable Object rule.
        expect(wallsOf(disk)).toEqual([])
        // A boot writes no runner or shard-lock row: one runner owns the
        // storage, so its shard locks live in memory.
        for (const boot of ["boot-1", "boot-2", "boot-3"]) {
          const written = [...(disk.ledgers.get(boot)?.rowsWritten.keys() ?? [])]
          expect(written).not.toContain("cluster_locks")
          expect(written).not.toContain("cluster_runners")
        }
        // What stays: a 64-bit request id read back as a double. The driver
        // has no safe-integer read, so each reply names its request by the
        // id's nearest double, and a keep-alive is marked processed only when
        // that double prints as the id itself; every other one stays
        // unprocessed, wakes the next activation's loop, and keeps the alarm
        // set.
        expect(keepAlives.messages.length).toBe(2)
        expect(keepAlives.replies.map((row) => row.request_id).toSorted()).toEqual(
          keepAlives.messages.map((row) => String(Number(row.id))).toSorted(),
        )
        const survivesDouble = (id: string) => String(Number(id)) === id
        expect(keepAlives.messages.map((row) => row.processed === 1)).toEqual(
          keepAlives.messages.map((row) => survivesDouble(row.id)),
        )
        const stale = keepAlives.messages.some((row) => !survivesDouble(row.id))
        expect(Option.isSome(wakeAfterTurn)).toBe(stale)
        expect(Option.isSome(wakeWhenIdle)).toBe(stale)
        expect(wokenEntities > 0).toBe(stale)
      }).pipe(Effect.timeout("45 seconds")),
    60_000,
  )

  it.scopedLive(
    "a turn parked on an ask keeps its loop resident and the alarm set, across an eviction",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectoryScoped("gent-do-ask-")
        const cwd = yield* makeTempDirectoryScoped("gent-do-ask-cwd-")
        const home = yield* makeTempDirectoryScoped("gent-do-ask-home-")
        const disk = yield* makeDurableObjectDisk(`${dir}/object.db`)
        const runs = yield* Ref.make(0)
        const root = (
          sql: Layer.Layer<SqlClient.SqlClient>,
          providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
        ) => hostedAskingRoot({ sql, cwd, home, runs, providerLayer })

        // Activation 1: the tool asks, and the turn parks on the ask.
        const first = yield* LanguageModelLayers.sequence([
          toolCallStep("asked_echo", { text: "hello" }),
          { ...textStep("never reached"), gated: true },
        ])
        const activation1 = yield* activate(disk, "boot-1", (sql, scope) =>
          clientOver(root(sql, first.layer), cwd, scope),
        )
        const { client } = activation1.built
        const { sessionId, branchId } = yield* client.session.create({ cwd })
        disk.setPhase("ask")
        yield* client.message.send({ sessionId, branchId, content: "ask, then echo hello" })
        yield* waitFor(eventCount(disk, "InteractionPresented"), (n) => n >= 1, 5_000, "the ask")
        // The park mark is a write of its own after the ask is stored; an
        // eviction between the two leaves a presented ask whose call reads
        // `Interrupted` on resume. This test evicts after the mark.
        yield* waitFor(
          Effect.sync(() =>
            countOf(
              disk.rowsOf(
                CountRow,
                `SELECT COUNT(*) AS n FROM turn_records WHERE pending_tool_calls_json LIKE '%"parked":true%'`,
              ),
            ),
          ),
          (n) => n >= 1,
          5_000,
          "the park mark",
        )
        disk.setPhase("parked")
        const heldWhileParked = unprocessedTags(disk)
        const wakeWhileParked = yield* nextClusterWake(disk)
        const entitiesWhileParked = yield* Context.get(activation1.built.context, Sharding.Sharding)
          .activeEntityCount
        disk.setPhase("eviction")
        yield* activation1.evict

        // Activation 2, the alarm, while the ask still waits on its human.
        const second = yield* LanguageModelLayers.sequence([textStep("done")])
        const activation2 = yield* activate(disk, "boot-2", (sql, scope) =>
          clientOver(root(sql, second.layer), cwd, scope),
        )
        disk.setPhase("parked-after-alarm")
        const sharding = Context.get(activation2.built.context, Sharding.Sharding)
        yield* sharding.pollStorage
        const entitiesAfterAlarm = yield* waitFor(
          sharding.activeEntityCount,
          (count) => count > 0,
          3_000,
          "a woken entity",
        ).pipe(Effect.orElseSucceed(() => 0))
        const wakeAfterAlarm = yield* nextClusterWake(disk)
        const callsBeforeAnswer = yield* second.controls.callCount
        const runsBeforeAnswer = yield* Ref.get(runs)

        // The human answers through the new activation; the turn finishes.
        disk.setPhase("answer")
        const asked = disk.rowsOf(
          RequestRow,
          "SELECT json_extract(event_json, '$.requestId') AS requestId FROM events WHERE event_tag = 'InteractionPresented' ORDER BY id DESC LIMIT 1",
        )
        expect(asked.length).toBe(1)
        const answer = yield* activation2.built.client.interaction
          .respondInteraction({
            sessionId,
            branchId,
            requestId: InteractionRequestId.make(asked.map((row) => row.requestId).join("")),
            approved: true,
          })
          .pipe(Effect.forkScoped)
        yield* waitFor(eventCount(disk, "TurnCompleted"), (n) => n >= 1, 10_000, "TurnCompleted")
        // The reply, when it comes, is written with the turn's last rows: wait
        // a short time after the turn, not from the send.
        const answered = yield* Fiber.join(answer).pipe(Effect.timeout("3 seconds"), Effect.exit)
        const respondRows = disk.rowsOf(
          IdRow,
          "SELECT CAST(id AS TEXT) AS id, processed FROM cluster_messages WHERE tag = 'RespondInteraction'",
        )

        yield* writeReport("ask", {
          walls: disk.violations,
          heldWhileParked,
          wakeWhileParkedInMs: Option.getOrNull(
            Option.map(wakeWhileParked, (at) => at - activation1.evictedAt()),
          ),
          entitiesWhileParked,
          entitiesAfterAlarm,
          wakeAfterAlarm: Option.isSome(wakeAfterAlarm),
          callsBeforeAnswer,
          runsBeforeAnswer,
          presented: yield* eventCount(disk, "InteractionPresented"),
          answerReturned: Exit.isSuccess(answered),
          sequence: disk
            .rowsOf(
              TagRow,
              "SELECT event_tag AS tag FROM events WHERE event_tag <> 'StreamChunk' ORDER BY id",
            )
            .map((row) => row.tag),
          respondRows,
          ms: { boot1: activation1.buildMs, rebuild: activation2.buildMs },
          events: eventTags(disk),
          ledger: ledgerReport(disk),
        })

        // Risk 6: a parked ask holds residency. Its keep-alive stays
        // unprocessed, so the host would keep a heartbeat alarm while the turn
        // waits on a human, and the alarm wakes the loop to wait again.
        expect(heldWhileParked).toEqual([KEEP_ALIVE])
        expect(Option.isSome(wakeWhileParked)).toBe(true)
        expect(entitiesWhileParked).toBe(1)
        expect(entitiesAfterAlarm).toBe(1)
        expect(Option.isSome(wakeAfterAlarm)).toBe(true)
        expect(callsBeforeAnswer).toBe(0)
        expect(runsBeforeAnswer).toBe(0)
        expect(yield* eventCount(disk, "TurnCompleted")).toBe(1)
        expect(yield* Ref.get(runs)).toBe(1)
        expect(yield* first.controls.callCount).toBe(1)
        expect(yield* second.controls.callCount).toBe(1)
        expect(wallsOf(disk)).toEqual([])
        // The answer reaches the loop, which finishes the turn. The RPC that
        // sent it can return only when its 64-bit request id survives the
        // double the reply is read through; a reply that names another request
        // leaves the caller waiting and the message unprocessed. A surviving
        // id is not enough: the reply's own id and the caller's read of the
        // reply list pass through doubles too, so only the one direction is
        // certain.
        expect(respondRows.length).toBe(1)
        for (const row of respondRows) {
          if (String(Number(row.id)) !== row.id) {
            expect(Exit.isSuccess(answered)).toBe(false)
            expect(row.processed).toBe(0)
          }
        }
      }).pipe(Effect.timeout("30 seconds")),
    45_000,
  )

  it.scopedLive("a session tree and a branch list of over 100 pass the bound-parameter cap", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-do-tree-")
      const disk = yield* makeDurableObjectDisk(`${dir}/object.db`)
      // Enforce: a statement over 100 bound parameters fails as on a Durable Object.
      const storage = SqliteStorage.HostedWithSql(
        hostedSqlOf(disk.activate("enforce").storage),
      ).pipe(Layer.provide(Layer.mergeAll(GentPlatform.Test(), BunCrypto.layer)))
      const at = dateFromMillis(1_767_225_600_000)
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const relationships = yield* RelationshipStorage
        const session = (id: string, parent: Option.Option<string>) =>
          sessions.createSession(
            new Session({
              id: SessionId.make(id),
              name: id,
              ...Option.match(parent, {
                onNone: () => ({}),
                onSome: (parentId) => ({ parentSessionId: SessionId.make(parentId) }),
              }),
              createdAt: at,
              updatedAt: at,
            }),
          )
        yield* session("tree-root", Option.none())
        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => `tree-child-${index}`),
          (id) => session(id, Option.some("tree-root")),
        )
        const branchIds = Array.from({ length: 101 }, (_, index) =>
          BranchId.make(`tree-branch-${index}`),
        )
        yield* Effect.forEach(branchIds, (id) =>
          branches.createBranch(
            new Branch({ id, sessionId: SessionId.make("tree-root"), createdAt: at }),
          ),
        )

        const counts = yield* branches.countMessagesByBranches(branchIds)
        expect(counts.size).toBe(0)
        const detail = yield* relationships.getSessionDetail(SessionId.make("tree-root"))
        expect(detail.branches.length).toBe(101)
        const deleted = yield* sessions.deleteSession(SessionId.make("tree-root"))
        expect(deleted.length).toBe(101)
        expect(deleted.flatMap((entry) => entry.branchIds).length).toBe(101)
      }).pipe(Effect.provide(storage))
      expect(wallsOf(disk)).toEqual([])
      // The branches went with their sessions, by the foreign keys the host enforces.
      expect(countOf(disk.rowsOf(CountRow, "SELECT COUNT(*) AS n FROM branches"))).toBe(0)
    }),
  )
})
