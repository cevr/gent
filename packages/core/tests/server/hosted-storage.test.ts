/**
 * A gent root on Durable-Object-shaped storage: storage init, a turn that
 * resumes after an eviction, and lists past the bound-parameter cap.
 *
 * A fake `DurableObjectStorage` (`durable-object-storage-boundary.ts`) keeps the
 * rules a SQLite-backed Durable Object keeps. `@effect/sql-sqlite-do` turns it
 * into the `SqlClient` the root's storage runs on.
 *
 * The root takes that client as its state (`createDependencies({ sql })`), as a host
 * passes its own. Each rule a statement breaks is recorded with the statement,
 * so one run lists every wall the root meets.
 */
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { SqliteClient as DoSqliteClient } from "@effect/sql-sqlite-do"
import { describe, expect, it } from "effect-bun-test"
import {
  Array as Arr,
  Clock,
  Config,
  Context,
  type Crypto,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Order,
  Ref,
  Schema,
  Scope,
} from "effect"
import { Sharding, SingleRunner, Snowflake } from "effect/cluster"
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
  withClusterIdSpace,
} from "../../src/storage/storage"
import { StorageInitLive } from "../../src/storage/schema"
import {
  createE2ELayer,
  createRpcClient,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  testAgent,
  waitFor,
} from "../../src/test-utils/harness"
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
 * The next-wake query over the cluster's message table: the earliest
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

const MAX_EXACT_ID = BigInt(Number.MAX_SAFE_INTEGER)
const ID_COLUMNS = {
  cluster_messages: ["id", "request_id", "reply_id", "last_reply_id"],
  cluster_replies: ["id", "request_id"],
} as const
const IdTextRow = Schema.Struct({ v: Schema.String })

/** Every id the cluster tables hold, read as exact text. */
const storedClusterIds = (disk: DurableObjectDisk) =>
  Object.entries(ID_COLUMNS).flatMap(([table, columns]) =>
    columns.flatMap((column) =>
      disk
        .rowsOf(
          IdTextRow,
          `SELECT CAST(${column} AS TEXT) AS v FROM ${table} WHERE ${column} IS NOT NULL`,
        )
        .map((row) => BigInt(row.v)),
    ),
  )

/** Each table's row ids, exact, in delivery (rowid) order. */
const rowIdsOf = (disk: DurableObjectDisk) =>
  Object.keys(ID_COLUMNS).flatMap((table) =>
    disk
      .rowsOf(IdTextRow, `SELECT CAST(id AS TEXT) AS v FROM ${table} ORDER BY rowid`)
      .map((row) => BigInt(row.v)),
  )

/** Whether a number holds the id exactly, as the driver reads it. */
const readsExactly = (id: bigint) => String(Number(id)) === String(id)

const LinkRow = Schema.Struct({
  table: Schema.String,
  kind: Schema.NullOr(Schema.Finite),
  tag: Schema.NullOr(Schema.String),
  id: Schema.String,
  request_id: Schema.String,
  reply_id: Schema.NullOr(Schema.String),
})

/**
 * The cluster rows in delivery order, each id replaced by its rank among the
 * ids: two stores with the same links hold the same rows in the same order,
 * linked the same way, whatever their id values.
 */
const linksOf = (disk: DurableObjectDisk) => {
  const rows = disk.rowsOf(
    LinkRow,
    `SELECT * FROM (
       SELECT 'message' AS "table", kind, tag, CAST(id AS TEXT) AS id, CAST(request_id AS TEXT) AS request_id, CAST(reply_id AS TEXT) AS reply_id FROM cluster_messages
       UNION ALL
       SELECT 'reply', kind, NULL, CAST(id AS TEXT), CAST(request_id AS TEXT), NULL FROM cluster_replies
     ) ORDER BY "table", CAST(id AS INTEGER)`,
  )
  const replyOf = (row: typeof LinkRow.Type) => Option.fromNullishOr(row.reply_id)
  const ids = new Set(
    rows.flatMap((row) => [row.id, row.request_id, ...Option.toArray(replyOf(row))]),
  )
  const ranks = new Map(
    Arr.sort([...ids], Order.mapInput(Order.BigInt, BigInt)).map((id, rank) => [id, rank]),
  )
  const rankOf = (id: string) => ranks.get(id) ?? -1
  return rows.map((row) => ({
    table: row.table,
    kind: row.kind,
    tag: row.tag,
    id: rankOf(row.id),
    request: rankOf(row.request_id),
    reply: Option.getOrElse(Option.map(replyOf(row), rankOf), () => -1),
  }))
}

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

/** A layer on the hosted client and crypto, built as the root builds its cluster. */
const clusterRootOver = <A, E>(
  disk: DurableObjectDisk,
  layer: Layer.Layer<A, E, SqlClient.SqlClient | Crypto.Crypto>,
) =>
  layer.pipe(
    Layer.provideMerge(Layer.merge(hostedSqlOf(disk.activate("enforce").storage), BunCrypto.layer)),
    withClusterIdSpace,
  )

const ClusterRowText = Schema.Struct({ row: Schema.String })

/** Each cluster row's ids and tag, exact, in delivery (rowid) order. */
const clusterRowsOf = (disk: DurableObjectDisk) => [
  ...disk
    .rowsOf(
      ClusterRowText,
      `SELECT tag || ' ' || id || ' ' || request_id || ' ' || IFNULL(reply_id, '-') || ' ' || IFNULL(last_reply_id, '-') AS row
       FROM cluster_messages ORDER BY rowid`,
    )
    .map((row) => row.row),
  ...disk
    .rowsOf(
      ClusterRowText,
      "SELECT 'reply ' || id || ' ' || request_id AS row FROM cluster_replies ORDER BY rowid",
    )
    .map((row) => row.row),
]

/**
 * A turn evicted while its second model step waits, its ids then moved past
 * 2^53 as an older build's default snowflakes are, resumed by the next
 * activation. With `exactTurnFirst`, a first turn completes before it, and
 * its ids stay under 2^53: the store holds both kinds.
 */
const staleIdsResume = (options: { readonly exactTurnFirst: boolean }) =>
  Effect.gen(function* () {
    const dir = yield* makeTempDirectoryScoped("gent-do-stale-")
    const cwd = yield* makeTempDirectoryScoped("gent-do-stale-cwd-")
    const home = yield* makeTempDirectoryScoped("gent-do-stale-home-")
    const disk = yield* makeDurableObjectDisk(`${dir}/object.db`)
    const runs = yield* Ref.make(0)
    const root = (
      sql: Layer.Layer<SqlClient.SqlClient>,
      providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
    ) => hostedRoot({ sql, cwd, home, runs, providerLayer })
    const exactTurn = Arr.filter([textStep("first")], () => options.exactTurnFirst)
    const turns = exactTurn.length + 1

    // Activation 1 runs the tool and is evicted while step 2 waits, with
    // the turn's request and its keep-alive unprocessed.
    const first = yield* LanguageModelLayers.sequence([
      ...exactTurn,
      toolCallStep("echo", { text: "hello" }),
      { ...textStep("never emitted"), gated: true },
    ])
    const activation1 = yield* activate(disk, "boot-1", (sql, scope) =>
      createRpcClient(root(sql, first.layer)).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const { client } = activation1.built
    const { sessionId, branchId } = yield* client.session.create({ cwd })
    if (options.exactTurnFirst) {
      yield* client.message.send({ sessionId, branchId, content: "first" })
      yield* waitFor(eventCount(disk, "TurnCompleted"), (n) => n >= 1, 15_000, "first turn")
      yield* waitFor(
        Effect.sync(() => unprocessedTags(disk)),
        (tags) => tags.length === 0,
        5_000,
        "first turn processed",
      )
    }
    const exactIds = Arr.sort(storedClusterIds(disk), Order.BigInt)
    const boundary = Option.getOrElse(Arr.last(exactIds), () => 0n)
    yield* client.message.send({ sessionId, branchId, content: "echo hello" })
    yield* first.controls.waitForCall(turns)
    yield* activation1.evict
    expect(unprocessedTags(disk)).toContain(KEEP_ALIVE)

    // An older build's ids: the rows past the boundary with their ids past
    // 2^53, as Effect's default snowflakes are, written exactly through the API.
    disk.setPhase("older-build")
    const shifted = (column: string) =>
      `${column} = CASE WHEN ${column} > ${boundary} THEN ${column} + ${2n ** 60n} ELSE ${column} END`
    const older = disk.activate("enforce").storage
    for (const [table, columns] of Object.entries(ID_COLUMNS))
      older.sql.exec(`UPDATE ${table} SET ${columns.map(shifted).join(", ")}`)
    const staleLinks = linksOf(disk)
    expect(storedClusterIds(disk).filter((id) => id > boundary && id <= MAX_EXACT_ID)).toEqual([])
    expect(boundary > 0n).toBe(options.exactTurnFirst)

    // Activation 2, the alarm: the root moves the ids under 2^53, and the
    // turn resumes from storage.
    const second = yield* LanguageModelLayers.sequence([textStep("done")])
    const activation2 = yield* activate(disk, "boot-2", (sql, scope) =>
      Layer.buildWithScope(root(sql, second.layer), scope),
    )
    disk.setPhase("resume")
    yield* Context.get(activation2.built, Sharding.Sharding).pollStorage
    yield* waitFor(eventCount(disk, "TurnCompleted"), (n) => n >= turns, 15_000, "TurnCompleted")
    yield* waitFor(
      Effect.sync(() => unprocessedTags(disk)),
      (tags) => tags.length === 0,
      5_000,
      "every message processed",
    )

    // Each row keeps its place and every link names the same row; the
    // rows the turn wrote since sort after them, and the exact ids keep
    // their values.
    const moved = linksOf(disk)
    const olderRows = ["message", "reply"].flatMap((table) =>
      moved
        .filter((row) => row.table === table)
        .slice(0, staleLinks.filter((row) => row.table === table).length),
    )
    expect(olderRows).toEqual(staleLinks)
    expect(
      Arr.sort(
        storedClusterIds(disk).filter((id) => id <= boundary),
        Order.BigInt,
      ),
    ).toEqual(exactIds)
    expect(storedClusterIds(disk).filter((id) => id > MAX_EXACT_ID)).toEqual([])
    expect(Option.isNone(yield* nextClusterWake(disk))).toBe(true)
    expect(yield* eventCount(disk, "TurnCompleted")).toBe(turns)
    expect(yield* Ref.get(runs)).toBe(1)
    expect(yield* second.controls.callCount).toBe(1)
    expect(wallsOf(disk)).toEqual([])
  }).pipe(Effect.timeout("45 seconds"))

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
      // Init is portable DDL: no PRAGMA of the
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
        const rowsAtEviction = new Set(rowIdsOf(disk))
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

        // The keep-alive replies are written, and each names its message.
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

        // Activation 3, an alarm with nothing to do: nothing is left to wake.
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
        // The driver reads an integer as a number, so every cluster id stays
        // under 2^53: each reply names its keep-alive, each keep-alive is
        // released, and nothing keeps the alarm set or wakes the loop.
        expect(keepAlives.messages.length).toBe(2)
        expect(keepAlives.replies.map((row) => row.request_id).toSorted()).toEqual(
          keepAlives.messages.map((row) => row.id).toSorted(),
        )
        expect(keepAlives.messages.map((row) => row.processed)).toEqual([1, 1])
        expect(Option.isNone(wakeAfterTurn)).toBe(true)
        expect(Option.isNone(wakeWhenIdle)).toBe(true)
        expect(wokenEntities).toBe(0)
        const ids = storedClusterIds(disk)
        expect(ids.filter((id) => id > MAX_EXACT_ID || !readsExactly(id))).toEqual([])
        // The next activation re-seeds above every stored id: each row it
        // writes sorts after the rows the first one left.
        const firstMax = Arr.reduce([...rowsAtEviction], 0n, Order.max(Order.BigInt))
        const written = rowIdsOf(disk).filter((id) => !rowsAtEviction.has(id))
        expect(written.length).toBeGreaterThan(0)
        expect(written.filter((id) => id <= firstMax)).toEqual([])
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
        // The turn's worker lets the parked turn go and releases its
        // keep-alive; wait for it, or the sample races the release.
        expect(keepAliveRows(disk).messages.length).toBe(1)
        yield* waitFor(
          Effect.sync(() => unprocessedTags(disk)),
          (tags) => !tags.includes(KEEP_ALIVE),
          5_000,
          "the worker's release",
        )
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

        // A parked ask holds nothing: the worker is done with the turn. With
        // its keep-alive released, the loop holds no alarm while the human
        // decides, and the answer wakes it from storage.
        expect(entitiesWhileParked).toBe(1)
        expect(heldWhileParked).toEqual([])
        expect(Option.isNone(wakeWhileParked)).toBe(true)
        expect(entitiesAfterAlarm).toBe(0)
        expect(Option.isNone(wakeAfterAlarm)).toBe(true)
        expect(callsBeforeAnswer).toBe(0)
        expect(runsBeforeAnswer).toBe(0)
        expect(yield* eventCount(disk, "TurnCompleted")).toBe(1)
        expect(yield* Ref.get(runs)).toBe(1)
        expect(yield* first.controls.callCount).toBe(1)
        expect(yield* second.controls.callCount).toBe(1)
        expect(wallsOf(disk)).toEqual([])
        // The answer reaches the loop, which finishes the turn, and its reply
        // names the persisted request: the RPC that sent it returns.
        expect(respondRows.map((row) => row.processed)).toEqual([1])
        expect(Exit.isSuccess(answered)).toBe(true)
        expect(storedClusterIds(disk).filter((id) => !readsExactly(id))).toEqual([])
      }).pipe(Effect.timeout("30 seconds")),
    45_000,
  )

  it.scopedLive(
    "a hosted root mints ids a number reads exactly, above every stored id, and the Bun root keeps Effect's",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectoryScoped("gent-do-ids-")
        const cwd = yield* makeTempDirectoryScoped("gent-do-ids-cwd-")
        const home = yield* makeTempDirectoryScoped("gent-do-ids-home-")
        const disk = yield* makeDurableObjectDisk(`${dir}/object.db`)
        const runs = yield* Ref.make(0)
        const model = yield* LanguageModelLayers.sequence([])
        const root = (sql: Layer.Layer<SqlClient.SqlClient>) =>
          hostedRoot({ sql, cwd, home, runs, providerLayer: model.layer })
        const snowflakes = (context: Context.Context<Sharding.Sharding>) =>
          Effect.forEach(
            Arr.range(1, 50),
            () => Context.get(context, Sharding.Sharding).getSnowflake,
          )

        // Activation 1 creates the tables; then an id the clock has not
        // reached is stored, as a clock that later steps back leaves one.
        const activation1 = yield* activate(disk, "boot-1", (sql, scope) =>
          Layer.buildWithScope(root(sql), scope),
        )
        const first = yield* snowflakes(activation1.built)
        yield* activation1.evict
        const ahead = 2n ** 52n
        disk
          .activate("enforce")
          .storage.sql.exec(
            "INSERT INTO cluster_replies (id, kind, request_id, payload, acked) VALUES (?, 0, ?, '{}', 1)",
            String(ahead),
            String(ahead - 1n),
          )

        // Activation 2 seeds from the stored ids.
        const activation2 = yield* activate(disk, "boot-2", (sql, scope) =>
          Layer.buildWithScope(root(sql), scope),
        )
        const second = yield* snowflakes(activation2.built)
        const minted = [...first, ...second]
        expect(minted.filter((id) => !readsExactly(id) || id > MAX_EXACT_ID)).toEqual([])
        expect(minted.slice(1).filter((id, index) => id <= (minted[index] ?? 0n))).toEqual([])
        expect(second.filter((id) => id <= ahead)).toEqual([])
        expect(wallsOf(disk)).toEqual([])

        // A Bun SQLite root reads 64-bit integers, so it keeps Effect's
        // generator: a timestamp shifted 22 bits, past 2^53.
        const bunRoot = yield* Layer.build(
          createE2ELayer({
            agents: [testAgent],
            extensions: [echoExtension(runs)],
            providerLayer: model.layer,
            cwd,
            home,
          }),
        )
        const bun = yield* snowflakes(bunRoot)
        expect(bun.filter((id) => id <= MAX_EXACT_ID)).toEqual([])
      }).pipe(Effect.timeout("30 seconds")),
    45_000,
  )

  it.scopedLive(
    "a lossy root fails when its cluster misses the exact generator, and builds when it gets it",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectoryScoped("gent-do-loud-")
        const disk = yield* makeDurableObjectDisk(`${dir}/object.db`)
        const cluster = SingleRunner.layer({ runnerStorage: "memory" })
        const lossyRoot = <A, E>(layer: Layer.Layer<A, E, SqlClient.SqlClient | Crypto.Crypto>) =>
          clusterRootOver(disk, layer)
        const failureOf = <A, E>(layer: Layer.Layer<A, E>) =>
          Layer.build(layer).pipe(Effect.flip, Effect.map(String))

        // A cluster built through a memo map of its own asks no build of
        // the root's for a generator: Effect's runs, and the root fails.
        expect(yield* failureOf(lossyRoot(Layer.fresh(cluster)))).toContain(
          "generator was not replaced",
        )

        // The exact generator runs for another layer, but the cluster still
        // mints Effect's ids: the root fails on the id it mints.
        expect(
          yield* failureOf(
            lossyRoot(
              Layer.merge(
                Layer.fresh(cluster),
                Layer.empty.pipe(Layer.provide(Snowflake.layerGenerator)),
              ),
            ),
          ),
        ).toContain("past what the client reads exactly")

        // The same cluster built through the root's memo map builds, and
        // mints exact ids.
        const context = yield* Layer.build(lossyRoot(cluster))
        const id = yield* Context.get(context, Sharding.Sharding).getSnowflake
        expect(id <= MAX_EXACT_ID && readsExactly(id)).toBe(true)
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )

  it.scopedLive(
    "ids past 2^53 are numbered in their order above the exact ones, and each link keeps its row",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectoryScoped("gent-do-order-")
        const disk = yield* makeDurableObjectDisk(`${dir}/object.db`)
        const cluster = SingleRunner.layer({ runnerStorage: "memory" })
        yield* Layer.build(clusterRootOver(disk, cluster)).pipe(Effect.scoped)

        // Processed rows an older build left: one exact, the rest past
        // 2^53, two messages of one request, each reply named by the
        // message it answers.
        const stale = (offset: number) => String(2n ** 60n + BigInt(offset))
        const older = disk.activate("enforce").storage
        // An empty reply id stores no reply.
        const message = (tag: string, id: string, request: string, reply: string, last: string) =>
          older.sql.exec(
            `INSERT INTO cluster_messages (id, shard_id, entity_type, entity_id, kind, tag, payload, processed, request_id, reply_id, last_reply_id)
             VALUES (?, 'default:1', 'Planted', 'e', 0, ?, '{}', 1, ?, NULLIF(?, ''), NULLIF(?, ''))`,
            id,
            tag,
            request,
            reply,
            last,
          )
        const reply = (id: string, request: string) =>
          older.sql.exec(
            "INSERT INTO cluster_replies (id, kind, request_id, payload, acked) VALUES (?, 0, ?, '{}', 1)",
            id,
            request,
          )
        message("exact", "1000", "1000", "", "")
        message("a", stale(10), stale(10), stale(30), stale(30))
        message("b", stale(20), stale(20), "", stale(40))
        message("a-again", stale(25), stale(10), "", "")
        reply(stale(30), stale(10))
        reply(stale(40), stale(20))

        yield* Layer.build(clusterRootOver(disk, cluster)).pipe(Effect.scoped)
        expect(clusterRowsOf(disk)).toEqual([
          "exact 1000 1000 - -",
          "a 1001 1001 1004 1004",
          "b 1002 1002 - 1005",
          "a-again 1003 1001 - -",
          "reply 1004 1001",
          "reply 1005 1002",
        ])
        expect(wallsOf(disk)).toEqual([])
      }).pipe(Effect.timeout("20 seconds")),
    30_000,
  )

  it.scopedLive(
    "ids an older build left past 2^53 move under it in their order, and its turn resumes and releases",
    () => staleIdsResume({ exactTurnFirst: false }),
    60_000,
  )

  it.scopedLive(
    "ids past 2^53 move above the exact ids a store already holds, which keep their values",
    () => staleIdsResume({ exactTurnFirst: true }),
    60_000,
  )

  it.scopedLive("a session tree and a branch list of over 100 pass the bound-parameter cap", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDirectoryScoped("gent-do-tree-")
      const disk = yield* makeDurableObjectDisk(`${dir}/object.db`)
      // Enforce: a statement over 100 bound parameters fails as on a Durable Object.
      const storage = SqliteStorage.WithSql(hostedSqlOf(disk.activate("enforce").storage)).pipe(
        Layer.provide(Layer.mergeAll(GentPlatform.Test(), BunCrypto.layer)),
      )
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
