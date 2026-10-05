import { describe, expect, it } from "effect-bun-test"
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect"
import { GentPlatform, MessageStorage } from "@gent/core/host"
import {
  type LoadedExtension,
  captureTurnTools,
  createE2ELayer,
  provideToolDispatch,
  recordInteractionDecision,
  staticToolBinding,
  storedEvents,
  createRpcHarness,
  ensureStorageParents,
  testToolContext,
  LanguageModelLayers,
  multiToolCallStep,
  textStep,
  toolCallStep,
  waitFor,
  ApprovalService,
  SqliteStorage,
  CurrentWorkspaceId,
  WorkspaceId,
  createRpcClient,
} from "@gent/core/test-utils"
import { BunServices } from "@effect/platform-bun"
import * as Prompt from "effect/ai/Prompt"
import {
  BranchId,
  MessageId,
  SessionId,
  ToolCallId,
  Message,
  AgentDefinition,
  DEFAULT_AGENT_NAME,
  messagePartsText,
} from "@gent/core/protocol"
import {
  ExtensionId,
  RequestId,
  InteractionPendingError,
  ExtensionContext,
  tool,
  type ToolCapability,
  LoadedArtifactIdentity,
  ToolResultFailure,
} from "@gent/core/extensions/api"
import {
  InteractionRequestId,
  CurrentInteractionOwner,
  InteractionRequestRecord,
  InteractionStorage,
  type ResolvedToolCapability,
  ToolRunner,
  ModelContextLedger,
  StorageError,
  EventStore,
} from "@gent/core/extensions/branch-tools"
import {
  CellKernelResource,
  CellStorage,
  CellStorageResource,
  cellInteractionOwner,
  CellTool,
  cellToolResultValue,
  executeBoundCellTool,
  makeCellToolHost,
  recoverCellExecution,
  resumeCellToolOperation,
} from "../src/cell.js"
import { CellResponse } from "../src/cell-protocol.js"
import { SqlClient } from "effect/sql"
import { Database } from "bun:sqlite"
import {
  now,
  askThenLoseWorker,
  cellResultsAfterTurn,
  cellTestStorage,
  platform,
  withCellStorage,
} from "./helpers/cell-kernel.js"

// Cell receipts: approvals, receipts, host-operation dispatch and recovery,
// and the durable claims and admission behind them.

// ── cell approvals ──────────────────────────────────────────────────────────

/**
 * A cell whose `guarded` call asks the user, beside `mark` (records a mark) and
 * `slow` (holds until the test releases it). A declined `guarded` fails.
 */
const approvalCell = Effect.gen(function* () {
  const marks = yield* Ref.make<ReadonlyArray<string>>([])
  const asked = yield* Ref.make(0)
  const allowed = yield* Ref.make(0)
  const slowStarted = yield* Deferred.make<void>()
  const slowRelease = yield* Deferred.make<void>()
  const slowDone = yield* Deferred.make<void>()
  const nativeGate = yield* Deferred.make<void>()
  const nativeAsking = yield* Deferred.make<void>()
  const extensions: ReadonlyArray<LoadedExtension> = [
    {
      manifest: { id: ExtensionId.make("cell-approval") },
      scope: "builtin",
      sourcePath: "cell-approval",
      artifactIdentity: LoadedArtifactIdentity.make("cell-approval-source"),
      contributions: {
        resources: [CellStorageResource, CellKernelResource],
        tools: [
          CellTool,
          tool({
            id: "mark",
            description: "Record a source effect",
            params: Schema.String,
            output: Schema.Boolean,
            execute: (mark) =>
              Ref.update(marks, (values) => [...values, mark]).pipe(Effect.as(true)),
            summary: (mark) => `marked ${mark}`,
          }),
          tool({
            id: "slow",
            description: "Work until released",
            params: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Deferred.completeWith(slowStarted, Effect.void).pipe(
                Effect.andThen(Deferred.await(slowRelease)),
                Effect.andThen(Deferred.completeWith(slowDone, Effect.void)),
                Effect.as("slow done"),
              ),
          }),
          tool({
            id: "native",
            description: "Ask as a call beside the cell, once released",
            params: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Effect.gen(function* () {
                yield* Deferred.await(nativeGate)
                yield* Deferred.completeWith(nativeAsking, Effect.void)
                const answer = yield* (yield* ExtensionContext).Interaction.approve({
                  text: "Native call?",
                })
                return String(answer.approved)
              }),
          }),
          tool({
            id: "guarded",
            description: "Ask before acting",
            params: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Effect.gen(function* () {
                yield* Ref.update(asked, (count) => count + 1)
                const answer = yield* (yield* ExtensionContext).Interaction.approve({
                  text: "Continue cell operation?",
                })
                if (!answer.approved)
                  return yield* new ToolResultFailure({
                    message: "declined by the user",
                    result: "declined",
                  })
                yield* Ref.update(allowed, (count) => count + 1)
                return "allowed"
              }),
          }),
        ],
      },
    },
  ]
  return {
    extensions,
    marks,
    asked,
    allowed,
    slowStarted,
    slowRelease,
    slowDone,
    nativeGate,
    nativeAsking,
  }
})

/** Start one cell turn and return once its one dialog shows. */
const startApprovalCell = (code: string) =>
  Effect.gen(function* () {
    const cell = yield* approvalCell
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
      toolCallStep("cell", { code }),
      textStep("Cell finished"),
    ])
    const { client, sessionId, branchId } = yield* createRpcHarness({
      extensions: cell.extensions,
      providerLayer,
      approvalLayer: ApprovalService.Live,
      agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
    })
    yield* client.message.send({ sessionId, branchId, content: "Run a cell with approval" })
    const presented = yield* client.session.events({ sessionId, branchId }).pipe(
      Stream.map((envelope) => envelope.event),
      Stream.filter((event) => event._tag === "InteractionPresented"),
      Stream.take(1),
      Stream.runCollect,
    )
    const request = Array.from(presented)[0]
    if (Predicate.isUndefined(request)) return yield* Effect.die("Missing approval")
    return { cell, client, sessionId, branchId, request }
  })

/** Run one cell turn, answer its one dialog with `approved`, and return the cell result. */
const runApprovalCell = (params: {
  readonly code: string
  readonly approved: boolean
  readonly beforeAnswer?: (cell: Effect.Success<typeof approvalCell>) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const started = yield* startApprovalCell(params.code)
    const { cell, client, sessionId, branchId, request } = started
    if (Predicate.isNotUndefined(params.beforeAnswer)) yield* params.beforeAnswer(cell)
    yield* client.interaction.respondInteraction({
      sessionId,
      branchId,
      requestId: request.requestId,
      approved: params.approved,
    })
    const results = yield* cellResultsAfterTurn(started)
    expect(results).toHaveLength(1)
    return { result: results[0], cell }
  })

describe("cell approvals", () => {
  it.scopedLive(
    "an answered approval continues the cell, and a decline reaches the cell code",
    () =>
      Effect.gen(function* () {
        for (const approved of [true, false]) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { result, cell } = yield* runApprovalCell({
                code: [
                  "await tools.mark('before')",
                  "let outcome",
                  "try { outcome = await tools.guarded({}) } catch (error) { outcome = 'caught ' + error.message }",
                  "await tools.mark('after')",
                  "outcome",
                ].join("\n"),
                approved,
                beforeAnswer: ({ marks }) =>
                  Ref.get(marks).pipe(Effect.map((values) => expect(values).toEqual(["before"]))),
              })
              let outcome = "caught"
              let guarded = "failed"
              if (approved) {
                outcome = "allowed"
                guarded = "succeeded"
              }
              expect(result).toMatchObject({
                isFailure: false,
                result: {
                  display: expect.stringContaining(outcome),
                  operations: [
                    { tool: "mark", outcome: "succeeded", summary: "marked before" },
                    { tool: "guarded", outcome: guarded },
                    { tool: "mark", outcome: "succeeded", summary: "marked after" },
                  ],
                },
              })
              expect(result).not.toMatchObject({ result: { stateLost: true } })
              // Code after the call ran, and the call asked once: nothing ran twice.
              expect(yield* Ref.get(cell.marks)).toEqual(["before", "after"])
              expect(yield* Ref.get(cell.asked)).toBe(1)
            }),
          )
        }
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    18000,
  )

  it.scopedLive(
    "a cancel while a call waits in place closes the dialog, ends the cell, and returns",
    () =>
      Effect.gen(function* () {
        const started = yield* startApprovalCell(
          [
            "await tools.mark('before')",
            "await tools.guarded({})",
            "await tools.mark('after')",
          ].join("\n"),
        )
        const { cell, client, sessionId, branchId, request } = started
        yield* client.steer
          .command({
            command: {
              _tag: "Cancel",
              sessionId,
              branchId,
              requestId: RequestId.make("cancel-waiting-cell"),
            },
          })
          .pipe(Effect.timeout("3 seconds"))
        const dismissed = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.map((envelope) => envelope.event),
          Stream.filter((event) => event._tag === "InteractionResolved"),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("3 seconds"),
        )
        expect(Array.from(dismissed)).toMatchObject([
          { requestId: request.requestId, approved: false, dismissed: true },
        ])
        const results = yield* cellResultsAfterTurn(started).pipe(Effect.timeout("5 seconds"))
        expect(results).toHaveLength(1)
        // The text follows the records: `mark` has its result, the asking call never got an answer.
        expect(results[0]?.result).toMatchObject({
          message: expect.stringContaining(
            "1 operation stopped at an approval that was not answered",
          ),
        })
        expect(results[0]?.result).toMatchObject({
          message: expect.not.stringContaining("may have occurred"),
        })
        // The cell ended at the call; nothing after it ran, and nothing acted.
        expect(yield* Ref.get(cell.marks)).toEqual(["before"])
        expect(yield* Ref.get(cell.allowed)).toBe(0)
        // The dialog is closed: an answer that comes late has nothing to answer.
        const late = yield* Effect.flip(
          client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: request.requestId,
            approved: true,
          }),
        )
        expect(late._tag).toBe("InteractionRequestMismatchError")
        expect(yield* Ref.get(cell.allowed)).toBe(0)
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    18000,
  )

  it.scopedLive(
    "a restart while a call waits in place: the request comes back, and an approval acts once",
    () =>
      Effect.gen(function* () {
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const storagePath = (yield* Path.Path).join(directory, "gent.db")
        const cell = yield* approvalCell
        const server = (steps: Parameters<typeof LanguageModelLayers.sequence>[0]) =>
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence(steps)
            return yield* createRpcClient(
              createE2ELayer({
                extensions: cell.extensions,
                providerLayer,
                approvalLayer: ApprovalService.Live,
                agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
                storagePath,
              }),
            )
          })
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* server([
              toolCallStep("cell", {
                code: [
                  "await tools.mark('before')",
                  "await tools.guarded({})",
                  "await tools.mark('after')",
                ].join("\n"),
              }),
            ])
            const { sessionId, branchId } = yield* client.session.create({})
            yield* client.message.send({ sessionId, branchId, content: "Run a cell" })
            const presented = Array.from(
              yield* client.session.events({ sessionId, branchId }).pipe(
                Stream.map((envelope) => envelope.event),
                Stream.filter((event) => event._tag === "InteractionPresented"),
                Stream.take(1),
                Stream.runCollect,
              ),
            )[0]
            if (Predicate.isUndefined(presented)) return yield* Effect.die("Missing approval")
            const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
            return {
              sessionId,
              branchId,
              requestId: presented.requestId,
              lastEventId: snapshot.lastEventId ?? 0,
            }
          }),
        )
        // The server stops while the call waits in place, as a crash would stop it.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* server([textStep("Recovered")])
            const { sessionId, branchId } = first
            const rehydrated = Array.from(
              yield* client.session.events({ sessionId, branchId, after: first.lastEventId }).pipe(
                Stream.map((envelope) => envelope.event),
                Stream.filter((event) => event._tag === "InteractionPresented"),
                Stream.take(1),
                Stream.runCollect,
                Effect.timeout("5 seconds"),
              ),
            )
            expect(rehydrated.map((event) => event.requestId)).toEqual([first.requestId])
            yield* client.interaction.respondInteraction({
              sessionId,
              branchId,
              requestId: first.requestId,
              approved: true,
            })
            yield* client.session.events({ sessionId, branchId, after: first.lastEventId }).pipe(
              Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
              Stream.take(1),
              Stream.runDrain,
              Effect.timeout("5 seconds"),
            )
            const results = (yield* client.message.list({ branchId }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool-result")
              .filter((part) => part.name === "cell")
            expect(results).toHaveLength(1)
            // The approved call acted once. The cell source cannot run again, so
            // the code after the call did not run and the cell says its state
            // was lost.
            expect(yield* Ref.get(cell.allowed)).toBe(1)
            expect(yield* Ref.get(cell.marks)).toEqual(["before"])
            expect(results[0]).toMatchObject({ result: { stateLost: true } })
          }),
        )
      }).pipe(Effect.timeout("20 seconds"), Effect.provide(platform)),
    25000,
  )

  it.scopedLive(
    "a sibling call in the same cell runs to its end while another call waits for its answer",
    () =>
      Effect.gen(function* () {
        const { result, cell } = yield* runApprovalCell({
          code: [
            "const [slow, guarded] = await Promise.all([tools.slow({}), tools.guarded({})])",
            "await tools.mark('after')",
            "slow + '/' + guarded",
          ].join("\n"),
          approved: true,
          // The dialog is open. The sibling still runs, and it finishes
          // before anyone answers.
          beforeAnswer: ({ slowStarted, slowRelease, slowDone }) =>
            Deferred.await(slowStarted).pipe(
              Effect.andThen(Deferred.completeWith(slowRelease, Effect.void)),
              Effect.andThen(Deferred.await(slowDone)),
              Effect.timeout("5 seconds"),
              Effect.orDie,
            ),
        })
        expect(result).toMatchObject({
          isFailure: false,
          result: {
            display: expect.stringContaining("slow done/allowed"),
            operations: [
              { tool: "slow", outcome: "succeeded" },
              { tool: "guarded", outcome: "succeeded" },
              { tool: "mark", outcome: "succeeded", summary: "marked after" },
            ],
          },
        })
        expect(yield* Ref.get(cell.asked)).toBe(1)
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    18000,
  )

  it.scopedLive(
    "a call beside the cell that asks while the cell's question is open asks once the cell took its answer",
    () =>
      Effect.gen(function* () {
        const cell = yield* approvalCell
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          multiToolCallStep(
            { toolName: "cell", input: { code: "await tools.guarded({})" } },
            { toolName: "native", input: {} },
          ),
          textStep("Both answered"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          extensions: cell.extensions,
          providerLayer,
          approvalLayer: ApprovalService.Live,
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
        })
        const dialogs = yield* Queue.unbounded<{
          readonly requestId: InteractionRequestId
          readonly text: string
        }>()
        yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.map((envelope) => envelope.event),
          Stream.runForEach((event) => {
            if (event._tag !== "InteractionPresented") return Effect.void
            return Queue.offer(dialogs, { requestId: event.requestId, text: event.text })
          }),
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "Ask in and beside a cell" })
        const inCell = yield* Queue.take(dialogs)
        expect(inCell.text).toBe("Continue cell operation?")
        // The native call asks while the cell's question is open. It waits
        // for the slot: the cell's call still runs and takes its own answer.
        yield* Deferred.completeWith(cell.nativeGate, Effect.void)
        yield* Deferred.await(cell.nativeAsking)
        yield* client.interaction.respondInteraction({
          sessionId,
          branchId,
          requestId: inCell.requestId,
          approved: true,
        })
        const beside = yield* Queue.take(dialogs)
        expect(beside.text).toBe("Native call?")
        yield* client.interaction.respondInteraction({
          sessionId,
          branchId,
          requestId: beside.requestId,
          approved: true,
        })
        const snapshot = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) =>
            current.runtime._tag === "Idle" &&
            current.messages.some(
              (message) =>
                message.role === "assistant" && messagePartsText(message.parts) === "Both answered",
            ),
          5_000,
          "the turn finished",
        )
        const results = snapshot.messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result")
        expect(results.find((part) => part.name === "native")).toMatchObject({
          isFailure: false,
          result: "true",
        })
        expect(results.find((part) => part.name === "cell")).toMatchObject({ isFailure: false })
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    18000,
  )
})

// ── cell tables ─────────────────────────────────────────────────────────────

/**
 * The cell tables as migrations 012-014 of core's chain created them, before
 * the cell ran its own migrations. An existing database holds these, with
 * the three ids recorded in `gent_storage_migrations`.
 */
const recordedCellTables = [
  `CREATE TABLE cell_executions (
      assistant_message_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      result_json TEXT,
      completed_at INTEGER,
      PRIMARY KEY (assistant_message_id, tool_call_id),
      CHECK ((result_json IS NULL) = (completed_at IS NULL)),
      FOREIGN KEY (assistant_message_id) REFERENCES messages(id) ON DELETE CASCADE
    )`,
  `CREATE TABLE cell_tool_operations (
      assistant_message_id TEXT NOT NULL,
      cell_tool_call_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      request_id TEXT UNIQUE,
      PRIMARY KEY (assistant_message_id, cell_tool_call_id, operation_id),
      FOREIGN KEY (assistant_message_id, cell_tool_call_id)
        REFERENCES cell_executions(assistant_message_id, tool_call_id) ON DELETE CASCADE
    )`,
  `CREATE TABLE cell_namespaces (
      session_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, branch_id),
      FOREIGN KEY (branch_id, session_id) REFERENCES branches(id, session_id) ON DELETE CASCADE
    )`,
]

/** One read of the database file between two servers, or beside one. */
const readDatabase = <A>(storagePath: string, read: (db: Database) => A) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Database(storagePath)),
    (db) => Effect.sync(() => read(db)),
    (db) => Effect.sync(() => db.close()),
  )

const cellTableNames = (db: Database) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cell_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name)

const migrationIds = (db: Database, table: string) =>
  db
    .query<{ migration_id: number }, []>(`SELECT migration_id FROM ${table} ORDER BY migration_id`)
    .all()
    .map((row) => row.migration_id)

const rowCount = (db: Database, table: string) =>
  db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0

const squashed = (sql: string) => sql.replaceAll(/\s+/g, " ").trim()

/** A server on one database file: without the cell, or with the approval cell. */
const cellServer = (params: {
  readonly storagePath: string
  readonly cell: Option.Option<Effect.Success<typeof approvalCell>>
  readonly steps: Parameters<typeof LanguageModelLayers.sequence>[0]
}) =>
  Effect.gen(function* () {
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence(params.steps)
    const agents = [new AgentDefinition({ name: DEFAULT_AGENT_NAME })]
    if (Option.isNone(params.cell))
      return yield* createRpcClient(
        createE2ELayer({ extensions: [], providerLayer, agents, storagePath: params.storagePath }),
      )
    return yield* createRpcClient(
      createE2ELayer({
        extensions: params.cell.value.extensions,
        providerLayer,
        approvalLayer: ApprovalService.Live,
        agents,
        storagePath: params.storagePath,
      }),
    )
  })

/** Run one turn on a new session of `client` and wait for its end. */
const runTurn = (
  client: Effect.Success<ReturnType<typeof cellServer>>["client"],
  target: { readonly sessionId: SessionId; readonly branchId: BranchId },
  content: string,
) =>
  Effect.gen(function* () {
    // Only a turn completed after this send counts, not one the branch already had.
    const after = (yield* client.session.getSnapshot(target)).lastEventId ?? 0
    const completed = yield* client.session.events({ ...target, after }).pipe(
      Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    )
    yield* client.message.send({ ...target, content })
    yield* Fiber.join(completed).pipe(Effect.timeout("8 seconds"))
  })

/** The `cell` results on a branch, oldest first. */
const cellResults = (
  client: Effect.Success<ReturnType<typeof cellServer>>["client"],
  branchId: BranchId,
) =>
  client.message.list({ branchId }).pipe(
    Effect.map((messages) =>
      messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool-result")
        .filter((part) => part.name === "cell"),
    ),
  )

describe("cell tables", () => {
  it.scopedLive(
    "a database first opened without the cell gets the cell tables when the cell loads, and a session delete removes its rows",
    () =>
      Effect.gen(function* () {
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const storagePath = (yield* Path.Path).join(directory, "gent.db")
        // First server: no cell. Core's own migrations create no cell table.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* cellServer({
              storagePath,
              cell: Option.none(),
              steps: [textStep("no cell")],
            })
            const target = yield* client.session.create({})
            yield* runTurn(client, target, "hello")
          }),
        )
        expect(yield* readDatabase(storagePath, cellTableNames)).toEqual([])
        // Second server: the cell loads and creates its tables; the first cell runs.
        const cell = yield* approvalCell
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* cellServer({
              storagePath,
              cell: Option.some(cell),
              steps: [toolCallStep("cell", { code: "var kept = 41\nkept + 1" }), textStep("ran")],
            })
            const target = yield* client.session.create({})
            yield* runTurn(client, target, "run a cell")
            expect(yield* cellResults(client, target.branchId)).toMatchObject([
              { isFailure: false, result: { display: "42" } },
            ])
            const before = yield* readDatabase(storagePath, (db) => ({
              executions: rowCount(db, "cell_executions"),
              namespaces: rowCount(db, "cell_namespaces"),
            }))
            expect(before).toEqual({ executions: 1, namespaces: 1 })
            yield* client.session.delete({ sessionId: target.sessionId })
          }),
        )
        const after = yield* readDatabase(storagePath, (db) => ({
          tables: cellTableNames(db),
          cellMigrations: migrationIds(db, "cell_migrations"),
          coreMigrations: migrationIds(db, "gent_storage_migrations"),
          executions: rowCount(db, "cell_executions"),
          namespaces: rowCount(db, "cell_namespaces"),
        }))
        expect(after.tables).toEqual([
          "cell_executions",
          "cell_migrations",
          "cell_namespaces",
          "cell_tool_operations",
        ])
        expect(after.cellMigrations).toEqual([1])
        expect(after.coreMigrations).not.toContain(12)
        expect(after).toMatchObject({ executions: 0, namespaces: 0 })
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(platform)),
    30000,
  )

  it.scopedLive(
    "an existing database keeps its cell rows: a waiting operation resumes and a saved binding comes back",
    () =>
      Effect.gen(function* () {
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const storagePath = (yield* Path.Path).join(directory, "gent.db")
        // A database as an earlier build left it: core's tables, and the cell
        // tables that core's chain created as migrations 012-014.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* cellServer({
              storagePath,
              cell: Option.none(),
              steps: [textStep("no cell")],
            })
            const target = yield* client.session.create({})
            yield* runTurn(client, target, "hello")
          }),
        )
        yield* readDatabase(storagePath, (db) => {
          for (const statement of recordedCellTables) db.exec(statement)
          db.exec(
            "INSERT INTO gent_storage_migrations (migration_id, name) VALUES (12, 'cell_executions'), (13, 'cell_tool_operations'), (14, 'cell_namespaces')",
          )
        })
        const cell = yield* approvalCell
        // A server keeps a binding, and stops while a cell waits on an approval.
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* cellServer({
              storagePath,
              cell: Option.some(cell),
              steps: [
                toolCallStep("cell", { code: "var kept = 41" }),
                textStep("kept"),
                toolCallStep("cell", {
                  code: [
                    "await tools.mark('before')",
                    "await tools.guarded({})",
                    "await tools.mark('after')",
                  ].join("\n"),
                }),
              ],
            })
            const target = yield* client.session.create({})
            yield* runTurn(client, target, "keep a value")
            const presented = yield* client.session.events(target).pipe(
              Stream.map((envelope) => envelope.event),
              Stream.filter((event) => event._tag === "InteractionPresented"),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )
            yield* client.message.send({ ...target, content: "Run a cell" })
            const request = Array.from(yield* Fiber.join(presented))[0]
            if (Predicate.isUndefined(request)) return yield* Effect.die("Missing approval")
            const snapshot = yield* client.session.getSnapshot(target)
            return {
              ...target,
              requestId: request.requestId,
              lastEventId: snapshot.lastEventId ?? 0,
            }
          }),
        )
        // The next server reads every row the first one left.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* cellServer({
              storagePath,
              cell: Option.some(cell),
              steps: [
                textStep("Recovered"),
                toolCallStep("cell", { code: "kept + 1" }),
                textStep("read"),
              ],
            })
            const target = { sessionId: first.sessionId, branchId: first.branchId }
            const recovered = yield* client.session
              .events({ ...target, after: first.lastEventId })
              .pipe(
                Stream.filter((envelope) => envelope.event._tag === "TurnCompleted"),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              )
            yield* client.session.events({ ...target, after: first.lastEventId }).pipe(
              Stream.map((envelope) => envelope.event),
              Stream.filter((event) => event._tag === "InteractionPresented"),
              Stream.take(1),
              Stream.runDrain,
              Effect.timeout("5 seconds"),
            )
            yield* client.interaction.respondInteraction({
              ...target,
              requestId: first.requestId,
              approved: true,
            })
            yield* Fiber.join(recovered).pipe(Effect.timeout("8 seconds"))
            expect(yield* Ref.get(cell.allowed)).toBe(1)
            yield* runTurn(client, target, "read the value")
            const results = yield* cellResults(client, target.branchId)
            expect(results).toHaveLength(3)
            expect(results[1]).toMatchObject({ result: { stateLost: true } })
            expect(results[2]).toMatchObject({ isFailure: false, result: { display: "42" } })
          }),
        )
        const after = yield* readDatabase(storagePath, (db) => ({
          tables: db
            .query<{ sql: string }, []>(
              "SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('cell_executions', 'cell_tool_operations', 'cell_namespaces') ORDER BY name",
            )
            .all()
            .map((row) => squashed(row.sql)),
          cellMigrations: migrationIds(db, "cell_migrations"),
          coreMigrations: migrationIds(db, "gent_storage_migrations"),
        }))
        // The tables are the ones the earlier build created, and the
        // recorded ids stay.
        expect(after.tables).toEqual(
          [recordedCellTables[0], recordedCellTables[2], recordedCellTables[1]].map((sql) =>
            squashed(sql ?? ""),
          ),
        )
        expect(after.cellMigrations).toEqual([1])
        expect(after.coreMigrations).toEqual(expect.arrayContaining([12, 13, 14]))
      }).pipe(Effect.timeout("30 seconds"), Effect.provide(platform)),
    35000,
  )
})

describe("cell receipts", () => {
  it.scopedLive(
    "a completed cell's continuation cannot acquire the next cell's effects or receipts",
    () =>
      Effect.gen(function* () {
        const cell = yield* approvalCell
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", {
            code: `var releaseMark; var staleResult;
var pendingMark = new Promise(resolve => { releaseMark = resolve }).then(() => tools.mark("stale"))
  .then(() => { staleResult = "accepted" }, error => { staleResult = error.message });
var markCurrent = () => tools.mark("current"); "armed"`,
          }),
          toolCallStep("cell", {
            code: "releaseMark(); await pendingMark; await markCurrent(); staleResult",
          }),
          textStep("Continuation checked"),
        ])
        const harness = yield* createRpcHarness({
          extensions: cell.extensions,
          providerLayer,
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
        })
        const { client, sessionId, branchId } = harness
        yield* client.message.send({ sessionId, branchId, content: "Check cell operation origins" })
        const results = yield* cellResultsAfterTurn(harness)
        expect(results).toHaveLength(2)
        expect(results.map((result) => result.isFailure)).toEqual([false, false])
        const receipts = yield* Effect.forEach(results, (result) =>
          Schema.decodeUnknownEffect(
            Schema.Struct({
              display: Schema.String,
              operations: Schema.optional(Schema.Array(Schema.Struct({ summary: Schema.String }))),
            }),
          )(result.result),
        )
        expect(receipts[0]?.operations).toBeUndefined()
        expect(receipts[1]?.operations?.map((op) => op.summary)).toEqual(["marked current"])
        expect(yield* Ref.get(cell.marks)).toEqual(["current"])
        expect(receipts[1]?.display).toContain("completed cell")
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    18000,
  )

  it.scopedLive(
    "a cell with ten or more host calls lists its receipts in call order",
    () =>
      Effect.gen(function* () {
        const extensions: ReadonlyArray<LoadedExtension> = [
          {
            manifest: { id: ExtensionId.make("cell-receipt-order") },
            scope: "builtin",
            sourcePath: "cell-receipt-order",
            artifactIdentity: LoadedArtifactIdentity.make("cell-receipt-order-source"),
            contributions: {
              resources: [CellStorageResource, CellKernelResource],
              tools: [
                CellTool,
                tool({
                  id: "mark",
                  description: "Record a mark",
                  params: Schema.String,
                  output: Schema.Boolean,
                  execute: () => Effect.succeed(true),
                  summary: (mark) => `marked ${mark}`,
                }),
              ],
            },
          },
        ]
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", {
            code: "for (let i = 1; i <= 12; i++) await tools.mark(String(i)); 'marked'",
          }),
          textStep("Marks recorded"),
        ])
        const harness = yield* createRpcHarness({
          extensions,
          providerLayer,
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
        })
        const { client, sessionId, branchId } = harness
        yield* client.message.send({ sessionId, branchId, content: "Mark twelve times" })
        const [result] = yield* cellResultsAfterTurn(harness)
        if (Predicate.isUndefined(result)) return yield* Effect.die("Missing cell result")
        const receipts = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ operations: Schema.Array(Schema.Struct({ summary: Schema.String })) }),
        )(result.result)
        expect(receipts.operations.map((receipt) => receipt.summary)).toEqual(
          Array.from({ length: 12 }, (_, index) => `marked ${index + 1}`),
        )
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    18000,
  )
})

// ── bound cell tool calls ───────────────────────────────────────────────────

const extensionId = ExtensionId.make("cell-test")
const runCellToolCall = (params: Parameters<typeof executeBoundCellTool>[0]) =>
  executeBoundCellTool(params).pipe(Effect.flatMap(cellToolResultValue))
const sessionIdToolCall = SessionId.make("cell-session")
const branchIdToolCall = BranchId.make("cell-branch")
const toolCallId = ToolCallId.make("cell-inner-operation")
const requestToolCall = CellResponse.cases.HostCall.make({
  cellId: "1",
  operationId: "1",
  name: "echo",
  input: { text: "hello" },
})
const host = testToolContext({
  sessionId: sessionIdToolCall,
  branchId: branchIdToolCall,
  toolCallId,
})
const base = Layer.provideMerge(
  Layer.mergeAll(ToolRunner.Live, EventStore.Memory),
  BunServices.layer,
)

/** The message of the `StorageError` a refused storage call fails with. */
const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.flatMap((error) => {
      if (Schema.is(StorageError)(error)) return Effect.succeed(error.message)
      return Effect.die(error)
    }),
  )

describe("a bound host call", () => {
  it.scopedLive("uses the exact selected capability and still enforces the input schema", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const selected = tool({
        id: "echo",
        description: "Selected echo",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: ({ text }) =>
          Ref.update(calls, (count) => count + 1).pipe(Effect.as(`selected:${text}`)),
      })
      const replacement = tool({
        id: "echo",
        description: "Replacement echo",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: () => Effect.die("Must not resolve the replacement by name"),
      })
      const dispatch = provideToolDispatch({
        extensions: [
          {
            manifest: { id: extensionId },
            scope: "builtin",
            sourcePath: "cell-test",
            contributions: { tools: [replacement] },
          },
        ],
        host,
      })
      const binding: Option.Option<ResolvedToolCapability> = Option.some({
        extensionId,
        capability: selected,
      })
      yield* Effect.gen(function* () {
        expect(yield* runCellToolCall({ request: requestToolCall, toolCallId, binding })).toBe(
          "selected:hello",
        )
        const invalid = yield* runCellToolCall({
          request: CellResponse.cases.HostCall.make({ ...requestToolCall, input: { text: 1 } }),
          toolCallId,
          binding,
        }).pipe(Effect.flip)
        expect(invalid._tag).toBe("CellEvaluationError")
        const mismatch = yield* runCellToolCall({
          request: CellResponse.cases.HostCall.make({ ...requestToolCall, name: "other" }),
          toolCallId,
          binding,
        }).pipe(Effect.flip)
        expect(mismatch._tag).toBe("CellEvaluationError")
        const missing = yield* runCellToolCall({
          request: requestToolCall,
          toolCallId,
          binding: Option.none(),
        }).pipe(Effect.flip)
        expect(missing._tag).toBe("CellEvaluationError")
        if (missing._tag === "CellEvaluationError")
          expect(missing.message).toContain("Unknown tool")
        expect(yield* Ref.get(calls)).toBe(1)
      }).pipe(dispatch, Effect.provideContext(yield* Layer.build(base)))
    }),
  )

  it.scopedLive("a call that parks instead of waiting for its answer fails closed", () =>
    Effect.gen(function* () {
      const selected = tool({
        id: "echo",
        description: "Parks on an interaction",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: () =>
          Effect.fail(
            new InteractionPendingError({
              requestId: InteractionRequestId.make("cell-approval"),
              sessionId: sessionIdToolCall,
              branchId: branchIdToolCall,
            }),
          ),
      })
      const dispatch = provideToolDispatch({
        extensions: [
          {
            manifest: { id: extensionId },
            scope: "builtin",
            sourcePath: "cell-test",
            contributions: { tools: [selected] },
          },
        ],
        host,
      })
      const result = yield* runCellToolCall({
        request: requestToolCall,
        toolCallId,
        binding: Option.some({ extensionId, capability: selected }),
      }).pipe(dispatch, Effect.provideContext(yield* Layer.build(base)), Effect.flip)
      expect(result._tag).toBe("CellEvaluationError")
      expect(result.message).toContain("cannot resume")
    }),
  )

  it.effect(
    "drops undefined optional fields from a tool result before it crosses the cell pipe",
    () =>
      Effect.gen(function* () {
        // Schema-encoded results keep `undefined` for optional fields such as the
        // delegate metadata session id of a private child. That is not JSON.
        const Metadata = Schema.Struct({
          sessionId: Schema.optional(Schema.String),
          agentName: Schema.String,
        })
        const metadata = yield* Schema.encodeEffect(Metadata)({ agentName: "main" })
        const result = Prompt.toolResultPart({
          id: toolCallId,
          name: "delegate.start",
          isFailure: false,
          providerExecuted: false,
          result: { output: "pong", metadata },
        })
        const value = yield* cellToolResultValue(result)
        expect(value).toEqual({ output: "pong", metadata: { agentName: "main" } })
      }),
  )

  it.effect("a failed tool throws its error text, and any other failure value as JSON", () =>
    Effect.gen(function* () {
      const failure = (result: Schema.Json) =>
        cellToolResultValue(
          Prompt.toolResultPart({
            id: toolCallId,
            name: "delegate.start",
            isFailure: true,
            providerExecuted: false,
            result,
          }),
        ).pipe(Effect.flip)
      const plain = yield* failure({ error: "Tool 'delegate.start' failed: no such agent" })
      expect(plain.message).toBe("Tool 'delegate.start' failed: no such agent")
      const detailed = yield* failure({ error: "boom", code: 3 })
      expect(detailed.message).toBe('{"error":"boom","code":3}')
    }),
  )
})

// ── planted cell calls ──────────────────────────────────────────────────────

interface CellAddress {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly assistantMessageId: MessageId
  readonly toolCallId: ToolCallId
}

/** Plants the session, branch and assistant message that hold a `cell` call to `code` at `address`. */
const plantCellCall = Effect.fn("test.plantCellCall")(function* (
  address: CellAddress,
  code: string,
) {
  yield* ensureStorageParents(address)
  yield* (yield* MessageStorage).createMessage(
    Message.cases.regular.make({
      id: address.assistantMessageId,
      sessionId: address.sessionId,
      branchId: address.branchId,
      role: "assistant",
      createdAt: now,
      parts: [
        Prompt.toolCallPart({
          id: address.toolCallId,
          name: "cell",
          params: { code },
          providerExecuted: false,
        }),
      ],
    }),
  )
  return address
})

// ── cell tool host ──────────────────────────────────────────────────────────

const cellToolHost = {
  sessionId: SessionId.make("recorded-host-session"),
  branchId: BranchId.make("recorded-host-branch"),
  assistantMessageId: MessageId.make("recorded-host-message"),
  toolCallId: ToolCallId.make("recorded-host-call"),
}
const requestToolHost = (operationId: string, name: string) =>
  CellResponse.cases.HostCall.make({
    cellId: "1",
    operationId,
    name,
    input: { valid: true },
  })

const prepareCell = Effect.gen(function* () {
  yield* plantCellCall(cellToolHost, "1")
  yield* (yield* CellStorage).executions.claim(cellToolHost)
})

const currentHostParams = Effect.gen(function* () {
  const turn = yield* captureTurnTools(cellToolHost)
  return {
    cell: cellToolHost,
    profile: turn.profile,
    toolBindings: turn.toolBindings,
    ledger: yield* ModelContextLedger.make,
  }
})

/**
 * Run `body` against the recorded host of an admitted cell on a fresh
 * in-memory server, with `tools` as the host tools the cell may call.
 */
const onRecordedHost = <A, E, R>(
  tools: ReadonlyArray<ToolCapability>,
  body: (recorded: {
    readonly hostParams: Effect.Success<typeof currentHostParams>
    readonly host: Effect.Success<ReturnType<typeof makeCellToolHost>>
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      createE2ELayer({
        agents: [],
        extensions: [
          {
            manifest: { id: ExtensionId.make("recorded-host") },
            scope: "builtin",
            sourcePath: "recorded-host",
            artifactIdentity: LoadedArtifactIdentity.make("recorded-host-source"),
            contributions: { tools },
          },
        ],
        providerLayer: LanguageModelLayers.debug(),
        approvalLayer: ApprovalService.Live,
      }).pipe(withCellStorage),
    )
    return yield* Effect.gen(function* () {
      yield* prepareCell
      const hostParams = yield* currentHostParams
      const host = yield* makeCellToolHost(hostParams)
      return yield* body({ hostParams, host })
    }).pipe(Effect.provideContext(context))
  })

/** A host tool that counts its runs in `calls` and answers the new count. */
const countTool = (calls: Ref.Ref<number>) =>
  tool({
    id: "count",
    description: "Count execution",
    params: Schema.Struct({ valid: Schema.Boolean }),
    output: Schema.Finite,
    execute: () => Ref.updateAndGet(calls, (count) => count + 1),
  })

/** A host tool that counts its runs in `calls` and asks the user once per run. */
const approveTool = (calls: Ref.Ref<number>) =>
  tool({
    id: "approve",
    description: "Request approval",
    params: Schema.Struct({}),
    output: Schema.Boolean,
    execute: () =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (count) => count + 1)
        const ctx = yield* ExtensionContext
        return (yield* ctx.Interaction.approve({ text: "Allow?" })).approved
      }),
  })

describe("recorded host operations", () => {
  it.scopedLive(
    "recovery refuses a cell owned by another branch",
    () =>
      onRecordedHost([], ({ hostParams }) =>
        Effect.gen(function* () {
          const refused = yield* recoverCellExecution({
            ...hostParams,
            cell: { ...cellToolHost, branchId: BranchId.make("other") },
          }).pipe(Effect.flip)
          expect(refused).toMatchObject({
            _tag: "CellEvaluationError",
            message: "Cell host belongs to another branch",
          })
        }),
      ).pipe(Effect.timeout("10 seconds")),
    12000,
  )

  it.scopedLive(
    "a host call runs once, and a repeat returns its recorded result",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        yield* onRecordedHost([countTool(calls)], ({ host }) =>
          Effect.gen(function* () {
            expect(yield* host.call(requestToolHost("1", "count"))).toBe(1)
            expect(yield* host.call(requestToolHost("1", "count"))).toBe(1)
            expect(yield* Ref.get(calls)).toBe(1)
          }),
        )
      }).pipe(Effect.timeout("10 seconds")),
    12000,
  )

  it.scopedLive(
    "a host call with invalid input is recorded as a failure and never runs the tool",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        yield* onRecordedHost([countTool(calls)], ({ host }) =>
          Effect.gen(function* () {
            const invalid = CellResponse.cases.HostCall.make({
              ...requestToolHost("invalid", "count"),
              input: [],
            })
            expect((yield* host.call(invalid).pipe(Effect.flip))._tag).toBe("CellEvaluationError")
            expect((yield* host.call(invalid).pipe(Effect.flip))._tag).toBe("CellEvaluationError")
            const failed = yield* (yield* CellStorage).operations.get({
              cell: cellToolHost,
              operationId: "invalid",
            })
            expect(failed.state._tag).toBe("Completed")
            if (failed.state._tag === "Completed") expect(failed.state.result.isFailure).toBe(true)
            expect(yield* Ref.get(calls)).toBe(0)
          }),
        )
      }).pipe(Effect.timeout("10 seconds")),
    12000,
  )

  it.scopedLive(
    "an approval a lost worker left waiting parks recovery, and its answer resumes the call once",
    () =>
      Effect.gen(function* () {
        const approvalCalls = yield* Ref.make(0)
        yield* onRecordedHost([approveTool(approvalCalls)], ({ host, hostParams }) =>
          Effect.gen(function* () {
            // The approval waits for its answer in place. The worker is lost
            // while it waits, so recovery finds the operation still waiting.
            const pending = yield* askThenLoseWorker(
              host,
              requestToolHost("2", "approve"),
              cellToolHost,
            )
            expect(yield* (yield* InteractionStorage).listOpen(cellToolHost)).toHaveLength(1)
            const undecided = yield* recoverCellExecution(hostParams).pipe(Effect.flip)
            expect(undecided._tag).toBe("InteractionPendingError")
            if (undecided._tag === "InteractionPendingError")
              expect(undecided.requestId).toBe(pending.requestId)
            expect(yield* Ref.get(approvalCalls)).toBe(1)
            const resumeParams = {
              ...hostParams,
              operationId: "2",
              requestId: pending.requestId,
            }
            expect(
              yield* refusal(
                resumeCellToolOperation({
                  ...resumeParams,
                  requestId: InteractionRequestId.make("wrong"),
                }),
              ),
            ).toBe("Cell operation is not waiting for this request")
            expect(yield* Ref.get(approvalCalls)).toBe(1)
            const approval = yield* ApprovalService
            yield* approval.storeResolution(cellToolHost, pending.requestId, { approved: false })
            const attempts = yield* Effect.all(
              [
                resumeCellToolOperation(resumeParams).pipe(Effect.exit),
                resumeCellToolOperation(resumeParams).pipe(Effect.exit),
              ],
              { concurrency: 2 },
            )
            expect(attempts.filter(Exit.isSuccess)).toHaveLength(1)
            const success = attempts.find(Exit.isSuccess)
            if (Predicate.isUndefined(success)) return yield* Effect.die("No successful resume")
            const resumed = success.value
            expect(resumed.result).toBe(false)
            expect(resumed.isFailure).toBe(false)
            expect(resumed.id).toBe(pending.toolCallId)
            const operations = (yield* CellStorage).operations
            expect(
              (yield* operations.get({ cell: cellToolHost, operationId: "2" })).state._tag,
            ).toBe("Completed")
            expect(yield* refusal(resumeCellToolOperation(resumeParams))).toBe(
              "Cell operation is not waiting for this request",
            )
            expect(yield* Ref.get(approvalCalls)).toBe(2)
            expect((yield* (yield* CellStorage).executions.claim(cellToolHost))._tag).toBe(
              "Incomplete",
            )
          }),
        )
      }).pipe(Effect.timeout("10 seconds")),
    12000,
  )

  it.scopedLive(
    "a call cut short is not run again, and recovery reports it as incomplete",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const started = yield* Deferred.make<boolean>()
        const finalized = yield* Deferred.make<boolean>()
        const interrupt = tool({
          id: "interrupt",
          description: "Wait after effect",
          params: Schema.Struct({}),
          output: Schema.Boolean,
          execute: () =>
            Ref.update(calls, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(started, true)),
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, true)),
            ),
        })
        yield* onRecordedHost([interrupt], ({ host, hostParams }) =>
          Effect.gen(function* () {
            const running = yield* host
              .call(requestToolHost("3", "interrupt"))
              .pipe(Effect.forkScoped)
            yield* Deferred.await(started)
            yield* Fiber.interrupt(running)
            yield* Deferred.await(finalized)
            const unknown = yield* host.call(requestToolHost("3", "interrupt")).pipe(Effect.flip)
            expect(unknown._tag).toBe("CellEvaluationError")
            if (unknown._tag === "CellEvaluationError")
              expect(unknown.message).toContain("not executed again")
            expect(yield* Ref.get(calls)).toBe(1)
            const operations = (yield* CellStorage).operations
            const recovered = yield* recoverCellExecution(hostParams)
            expect(recovered.isFailure).toBe(true)
            expect(recovered.result).toMatchObject({
              stateLost: true,
              error: expect.stringContaining(
                "1 operation ran with no recorded result; its effects may have occurred.",
              ),
              // An operation with no recorded outcome is an incomplete receipt.
              operations: [
                {
                  toolCallId: (yield* operations.get({ cell: cellToolHost, operationId: "3" }))
                    .toolCallId,
                  tool: "interrupt",
                  outcome: "incomplete",
                  summary: "",
                },
              ],
            })
            expect(yield* recoverCellExecution(hostParams)).toEqual(recovered)
            expect(yield* Ref.get(calls)).toBe(1)
          }),
        )
      }).pipe(Effect.timeout("10 seconds")),
    12000,
  )

  it.scopedLive(
    "a lost cell whose operations all have results says no effect is unrecorded",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        yield* onRecordedHost([countTool(calls)], ({ host, hostParams }) =>
          Effect.gen(function* () {
            expect(yield* host.call(requestToolHost("1", "count"))).toBe(1)
            // The worker is lost after its one operation completed.
            const recovered = yield* recoverCellExecution(hostParams)
            expect(recovered.isFailure).toBe(true)
            expect(recovered.result).toMatchObject({
              stateLost: true,
              error:
                "The cell worker state was lost. Its source was not replayed. Every host operation it made has its result in operations.",
              operations: [expect.objectContaining({ tool: "count", outcome: "succeeded" })],
            })
          }),
        )
      }).pipe(Effect.timeout("10 seconds")),
    12000,
  )

  it.scopedLive(
    "a cell completed before a crash comes back with its operation receipts",
    () =>
      onRecordedHost(
        [
          tool({
            id: "count",
            description: "Count execution",
            params: Schema.Struct({ valid: Schema.Boolean }),
            output: Schema.Finite,
            execute: () => Effect.succeed(1),
            summary: (input, output) => `counted ${output} (valid ${input.valid})`,
          }),
        ],
        ({ host, hostParams }) =>
          Effect.gen(function* () {
            expect(yield* host.call(requestToolHost("1", "count"))).toBe(1)
            // The process stored the cell result and died before the receipts were attached.
            yield* (yield* CellStorage).executions.complete(
              cellToolHost,
              Prompt.toolResultPart({
                id: cellToolHost.toolCallId,
                name: "cell",
                isFailure: false,
                providerExecuted: false,
                result: { value: 1 },
              }),
            )
            const recovered = yield* recoverCellExecution(hostParams)
            expect(recovered.result).toEqual({
              value: 1,
              operations: [
                {
                  toolCallId: expect.any(String),
                  tool: "count",
                  outcome: "succeeded",
                  // Recovery resolves the recorded binding, so the author's summary holds.
                  summary: "counted 1 (valid true)",
                },
              ],
            })
          }),
      ).pipe(Effect.timeout("10 seconds")),
    12000,
  )

  it.scopedLive(
    "resumes an approved operation after reopen and rejects changed source before admission",
    () =>
      Effect.gen(function* () {
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const storagePath = (yield* Path.Path).join(directory, "gent.db")
        const calls = yield* Ref.make(0)
        const extension = (revision: string): LoadedExtension => ({
          manifest: { id: ExtensionId.make("restart-host") },
          scope: "builtin",
          sourcePath: "restart-host",
          artifactIdentity: LoadedArtifactIdentity.make(revision),
          contributions: {
            tools: [
              tool({
                id: "approve",
                description: "Approve saved input",
                params: Schema.Struct({ valid: Schema.Boolean }),
                output: Schema.Boolean,
                execute: ({ valid }) =>
                  Effect.gen(function* () {
                    yield* Ref.update(calls, (count) => count + 1)
                    const ctx = yield* ExtensionContext
                    return (
                      (yield* ctx.Interaction.approve({ text: "Allow saved input?" })).approved &&
                      valid
                    )
                  }),
              }),
            ],
          },
        })
        const layer = (revision: string) =>
          createE2ELayer({
            agents: [],
            extensions: [extension(revision)],
            providerLayer: LanguageModelLayers.debug(),
            approvalLayer: ApprovalService.Live,
            storagePath,
          }).pipe(withCellStorage)
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer("original"))
            return yield* Effect.gen(function* () {
              yield* prepareCell
              const host = yield* makeCellToolHost(yield* currentHostParams)
              const pending = yield* askThenLoseWorker(
                host,
                requestToolHost("1", "approve"),
                cellToolHost,
              )
              yield* (yield* ApprovalService).storeResolution(cellToolHost, pending.requestId, {
                approved: true,
              })
              return pending
            }).pipe(Effect.provideContext(context))
          }),
        )
        const next = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer("original"))
            return yield* Effect.gen(function* () {
              const hostParams = yield* currentHostParams
              const result = yield* resumeCellToolOperation({
                ...hostParams,
                operationId: "1",
                requestId: first.requestId,
              })
              expect(result.result).toBe(true)
              expect(result.id).toBe(first.toolCallId)
              expect(yield* Ref.get(calls)).toBe(2)
              expect((yield* (yield* CellStorage).executions.claim(cellToolHost))._tag).toBe(
                "Incomplete",
              )
              const pending = yield* askThenLoseWorker(
                yield* makeCellToolHost(hostParams),
                requestToolHost("2", "approve"),
                cellToolHost,
              )
              yield* (yield* ApprovalService).storeResolution(cellToolHost, pending.requestId, {
                approved: true,
              })
              return pending
            }).pipe(Effect.provideContext(context))
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer("changed"))
            yield* Effect.gen(function* () {
              const mismatch = yield* resumeCellToolOperation({
                ...(yield* currentHostParams),
                operationId: "2",
                requestId: next.requestId,
              }).pipe(Effect.flip)
              expect(mismatch._tag).toBe("ToolBindingReplayError")
              if (mismatch._tag === "ToolBindingReplayError")
                expect(mismatch.reason).toBe("SourceMismatch")
              expect(
                (yield* (yield* CellStorage).operations.get({
                  cell: cellToolHost,
                  operationId: "2",
                })).state._tag,
              ).toBe("Waiting")
              expect(yield* Ref.get(calls)).toBe(3)
            }).pipe(Effect.provideContext(context))
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer("original"))
            yield* Effect.gen(function* () {
              const hostParams = yield* currentHostParams
              const recovered = yield* recoverCellExecution(hostParams)
              expect(recovered.isFailure).toBe(true)
              expect(recovered.result).toMatchObject({ stateLost: true })
              expect(yield* Ref.get(calls)).toBe(4)
              expect(
                (yield* (yield* CellStorage).operations.listForToolCall(cellToolHost)).map(
                  ({ operation }) => operation.state._tag,
                ),
              ).toEqual(["Completed", "Completed"])
              expect(yield* recoverCellExecution(hostParams)).toEqual(recovered)
              expect(yield* Ref.get(calls)).toBe(4)
            }).pipe(Effect.provideContext(context))
          }),
        )
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
    25000,
  )
})

// ── cell execution storage ──────────────────────────────────────────────────

const code = "await tools.write({ path: 'result.txt', content: 'once' })"
const makeFixture = (suffix: string) =>
  plantCellCall(
    {
      sessionId: SessionId.make(`cell-session-${suffix}`),
      branchId: BranchId.make(`cell-branch-${suffix}`),
      assistantMessageId: MessageId.make(`cell-message-${suffix}`),
      toolCallId: ToolCallId.make(`cell-call-${suffix}`),
    },
    code,
  )

describe("cell execution storage", () => {
  it.live("admits a cell once under concurrent claims and retains its first result", () =>
    Effect.gen(function* () {
      const address = yield* makeFixture("concurrent")
      const storage = (yield* CellStorage).executions
      expect(yield* storage.get(address)).toEqual(Option.none())
      const claims = yield* Effect.all(
        Array.from({ length: 8 }, () => storage.claim(address)),
        { concurrency: 8 },
      )
      expect(claims.filter((claim) => claim._tag === "Claimed")).toEqual([
        { _tag: "Claimed", code },
      ])
      expect(claims.filter((claim) => claim._tag === "Incomplete")).toHaveLength(7)
      expect(yield* storage.get(address)).toEqual(Option.some({ _tag: "Incomplete" }))
      const result = Prompt.toolResultPart({
        id: address.toolCallId,
        name: "cell",
        result: { display: "done" },
        isFailure: false,
        providerExecuted: false,
      })
      yield* storage.complete(address, result)
      expect(yield* storage.get(address)).toEqual(Option.some({ _tag: "Completed", result }))
      yield* storage.complete(address, result)
      expect(yield* storage.claim(address)).toEqual({ _tag: "Completed", result })
      const conflict = yield* storage
        .complete(address, Prompt.toolResultPart({ ...result, result: "different" }))
        .pipe(Effect.flip)
      expect(conflict.message).toBe("Cell result is immutable")
      expect(yield* storage.claim(address)).toEqual({ _tag: "Completed", result })
    }).pipe(Effect.provide(cellTestStorage)),
  )

  it.live("denies cross-workspace and cross-branch claims and completions", () =>
    Effect.gen(function* () {
      const address = yield* makeFixture("ownership")
      const storage = (yield* CellStorage).executions
      const result = Prompt.toolResultPart({
        id: address.toolCallId,
        name: "cell",
        result: "done",
        isFailure: false,
        providerExecuted: false,
      })
      const otherWorkspace = WorkspaceId.make("a".repeat(64))
      const notOwned = "Cell call is not owned by this workspace and branch"
      const inOtherWorkspace = Effect.provideService(CurrentWorkspaceId, otherWorkspace)
      expect(yield* refusal(storage.get(address).pipe(inOtherWorkspace))).toBe(notOwned)
      expect(yield* refusal(storage.claim(address).pipe(inOtherWorkspace))).toBe(notOwned)
      expect((yield* storage.claim(address))._tag).toBe("Claimed")
      expect(yield* refusal(storage.complete(address, result).pipe(inOtherWorkspace))).toBe(
        notOwned,
      )
      for (const wrongAddress of [
        { ...address, branchId: BranchId.make("other-branch") },
        { ...address, sessionId: SessionId.make("other-session") },
        { ...address, toolCallId: ToolCallId.make("missing-call") },
      ]) {
        expect(yield* refusal(storage.get(wrongAddress))).toBe(notOwned)
        expect(yield* refusal(storage.claim(wrongAddress))).toBe(notOwned)
        expect(yield* refusal(storage.complete(wrongAddress, result))).toBe(notOwned)
      }
      expect((yield* storage.claim(address))._tag).toBe("Incomplete")
    }).pipe(Effect.provide(cellTestStorage)),
  )

  it.live("rejects unclaimed and mismatched results and removes receipts with the message", () =>
    Effect.gen(function* () {
      const address = yield* makeFixture("integrity")
      const storage = (yield* CellStorage).executions
      const sql = yield* SqlClient.SqlClient
      const result = Prompt.toolResultPart({
        id: address.toolCallId,
        name: "cell",
        result: "failure",
        isFailure: true,
        providerExecuted: false,
      })
      expect(yield* refusal(storage.complete(address, result))).toBe("Cell has not been admitted")
      yield* storage.claim(address)
      expect(
        yield* refusal(
          storage.complete(address, Prompt.toolResultPart({ ...result, name: "other" })),
        ),
      ).toBe("Cell result does not match its call")
      yield* storage.complete(address, result)
      expect(yield* storage.claim(address)).toEqual({ _tag: "Completed", result })
      yield* sql`UPDATE cell_executions SET result_json = ${"not-json"} WHERE assistant_message_id = ${address.assistantMessageId}`
      expect(yield* refusal(storage.claim(address))).toBe("Failed to record cell execution")
      yield* sql`DELETE FROM messages WHERE id = ${address.assistantMessageId}`
      const rows = yield* sql<{
        readonly count: number
      }>`SELECT COUNT(*) AS count FROM cell_executions`
      expect(rows[0]?.count).toBe(0)
    }).pipe(Effect.provide(cellTestStorage)),
  )

  it.live("rejects admission inside a caller transaction before granting execution", () =>
    Effect.gen(function* () {
      const address = yield* makeFixture("transaction")
      const storage = (yield* CellStorage).executions
      const sql = yield* SqlClient.SqlClient
      expect(yield* refusal(storage.claim(address).pipe(sql.withTransaction))).toBe(
        "Cell admission requires a committed claim outside any caller transaction",
      )
      expect(yield* storage.claim(address)).toEqual({ _tag: "Claimed", code })
    }).pipe(Effect.provide(cellTestStorage)),
  )

  it.scopedLive(
    "keeps incomplete claims and saved failures after closing and reopening the database",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* fs.makeTempDirectoryScoped()
        const storageLayer = Layer.provideMerge(
          CellStorage.Live,
          SqliteStorage.LiveWithSql(path.join(dir, "gent.db"), Layer.empty, {}),
        ).pipe(Layer.provide(GentPlatform.Test()))
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(storageLayer)
            return yield* Effect.gen(function* () {
              const storage = (yield* CellStorage).executions
              const interrupted = yield* makeFixture("interrupted")
              const completed = yield* makeFixture("completed")
              yield* storage.claim(interrupted)
              yield* storage.claim(completed)
              const result = Prompt.toolResultPart({
                id: completed.toolCallId,
                name: "cell",
                result: "execution failed",
                isFailure: true,
                providerExecuted: false,
              })
              yield* storage.complete(completed, result)
              return { interrupted, completed, result }
            }).pipe(Effect.provideContext(context))
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(storageLayer)
            return yield* Effect.gen(function* () {
              const storage = (yield* CellStorage).executions
              expect(yield* storage.claim(first.interrupted)).toEqual({ _tag: "Incomplete" })
              expect(yield* storage.claim(first.completed)).toEqual({
                _tag: "Completed",
                result: first.result,
              })
            }).pipe(Effect.provideContext(context))
          }),
        )
      }).pipe(Effect.provide(BunServices.layer)),
  )
})

// ── cell tool operation storage ─────────────────────────────────────────────

const cellOperationStorage = {
  sessionId: SessionId.make("cell-operation-session"),
  branchId: BranchId.make("cell-operation-branch"),
  assistantMessageId: MessageId.make("cell-operation-message"),
  toolCallId: ToolCallId.make("cell-outer-call"),
}
const key = { cell: cellOperationStorage, operationId: "1" }
const bindingFields = {
  toolId: "write",
  extensionId: "files",
  sourceRevision: "source-1",
  schemaRevision: "schema-1",
}
const binding = staticToolBinding(bindingFields)
const params = { ...key, binding, input: { path: "file.txt", content: "once" } }
const requestId = InteractionRequestId.make("cell-request")
const fixture = plantCellCall(cellOperationStorage, "await tools.write({})")
const requestOperationStorage = InteractionRequestRecord.make({
  requestId,
  sessionId: cellOperationStorage.sessionId,
  branchId: cellOperationStorage.branchId,
  paramsJson: '{"text":"Allow write?"}',
  status: "pending",
  createdAt: 1_767_225_600_000,
})

describe("cell tool operation storage", () => {
  it.live("admits an operation once and preserves its original input, binding, and result", () =>
    Effect.gen(function* () {
      yield* fixture
      const outer = (yield* CellStorage).executions
      const storage = (yield* CellStorage).operations
      expect(yield* refusal(storage.admit(params))).toBe(
        "Cell operation requires an admitted outer cell",
      )
      yield* outer.claim(cellOperationStorage)
      const claims = yield* Effect.all(
        Array.from({ length: 8 }, () => storage.admit(params)),
        { concurrency: 8 },
      )
      expect(claims.filter((claim) => claim.admitted)).toHaveLength(1)
      const operation = yield* storage.get(key)
      expect(operation.input).toEqual(params.input)
      expect(operation.binding).toEqual(binding)
      expect(operation.state._tag).toBe("Started")
      expect(
        (yield* storage.admit({ ...params, input: { content: "once", path: "file.txt" } }))
          .admitted,
      ).toBe(false)
      const immutable = "Cell operation input and binding are immutable"
      expect(yield* refusal(storage.admit({ ...params, input: { content: "different" } }))).toBe(
        immutable,
      )
      expect(
        yield* refusal(
          storage.admit({
            ...params,
            binding: staticToolBinding({ ...bindingFields, schemaRevision: "schema-2" }),
          }),
        ),
      ).toBe(immutable)
      const result = Prompt.toolResultPart({
        id: operation.toolCallId,
        name: "write",
        result: "written",
        isFailure: false,
        providerExecuted: false,
      })
      expect(
        yield* refusal(storage.complete(key, Prompt.toolResultPart({ ...result, name: "other" }))),
      ).toBe("Cell operation result does not match its bound call")
      yield* storage.complete(key, result)
      yield* storage.complete(key, result)
      expect((yield* storage.get(key)).state).toEqual({ _tag: "Completed", result })
      expect((yield* storage.admit(params)).admitted).toBe(false)
      expect(
        yield* refusal(
          storage.complete(key, Prompt.toolResultPart({ ...result, result: "changed" })),
        ),
      ).toBe("Cell operation result is immutable")
    }).pipe(Effect.provide(cellTestStorage)),
  )

  it.scopedLive(
    "publishes cell approval only after durable ownership and takes its exact decision in place",
    () =>
      Effect.gen(function* () {
        yield* fixture
        yield* (yield* CellStorage).executions.claim(cellOperationStorage)
        const storage = (yield* CellStorage).operations
        const approval = yield* ApprovalService
        const sql = yield* SqlClient.SqlClient
        yield* storage.admit(params)
        const peer = { ...key, operationId: "2" }
        yield* storage.admit({ ...params, ...peer })
        yield* sql`CREATE TEMP TRIGGER require_cell_approval_owner BEFORE INSERT ON events WHEN NEW.event_tag = 'InteractionPresented' BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM cell_tool_operations o JOIN interaction_requests r ON r.request_id = o.request_id WHERE r.request_id = json_extract(NEW.event_json, '$.requestId')) THEN RAISE(ABORT, 'approval has no operation owner') END; END`
        const askAs = (owner: typeof key, text: string) =>
          approval
            .present({ text }, cellOperationStorage)
            .pipe(
              Effect.provideService(CurrentInteractionOwner, cellInteractionOwner(owner, storage)),
            )
        /** The request an operation waits on, once it waits. */
        const waitingOn = (owner: typeof key) =>
          waitFor(
            storage.get(owner),
            (operation) => operation.state._tag === "Waiting",
            5_000,
            `operation ${owner.operationId} waits`,
          ).pipe(
            Effect.flatMap((operation) => {
              if (operation.state._tag === "Waiting")
                return Effect.succeed(operation.state.requestId)
              return Effect.die("The operation is not waiting")
            }),
          )
        const first = yield* askAs(key, "First?").pipe(Effect.forkChild)
        const firstId = yield* waitingOn(key)
        // No running call owns the open request, so the peer is refused rather
        // than left waiting for a slot nothing would free.
        const blocked = yield* askAs(peer, "Second?").pipe(Effect.flip)
        expect(blocked._tag).toBe("InteractionSlotBusyError")
        expect(blocked.message).toContain("Another call in this step is waiting for an approval")
        expect((yield* storage.get(peer)).state._tag).toBe("Started")
        expect(
          (yield* storedEvents(cellOperationStorage)).filter(
            (event) => event.event._tag === "InteractionPresented",
          ),
        ).toHaveLength(1)
        yield* approval.storeResolution(cellOperationStorage, firstId, {
          approved: false,
          notes: "First denied",
        })
        expect(yield* Fiber.join(first)).toEqual({ approved: false, notes: "First denied" })
        // The call took its answer and runs on: its receipt waits for nothing,
        // and the answer cannot be resumed a second time.
        expect((yield* storage.get(key)).state._tag).toBe("Started")
        expect(yield* refusal(storage.resume(key, firstId))).toBe(
          "Cell operation is not waiting for this request",
        )
        const second = yield* askAs(peer, "Second?").pipe(Effect.forkChild)
        const secondId = yield* waitingOn(peer)
        expect(secondId).not.toBe(firstId)
        yield* approval.storeResolution(cellOperationStorage, secondId, { approved: true })
        expect(yield* Fiber.join(second)).toEqual({ approved: true })
        expect(yield* (yield* InteractionStorage).listOpen(cellOperationStorage)).toEqual([])
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.provide(
          createE2ELayer({
            agents: [],
            extensionInputs: [],
            providerLayer: LanguageModelLayers.debug(),
            approvalLayer: ApprovalService.Live,
          }).pipe(withCellStorage),
        ),
      ),
  )

  it.live("never leaves an approval behind when its operation link fails", () =>
    Effect.gen(function* () {
      yield* fixture
      yield* (yield* CellStorage).executions.claim(cellOperationStorage)
      const storage = (yield* CellStorage).operations
      const interactions = yield* InteractionStorage
      const sql = yield* SqlClient.SqlClient
      yield* storage.admit(params)
      yield* sql`CREATE TEMP TRIGGER reject_cell_link BEFORE UPDATE OF request_id ON cell_tool_operations BEGIN SELECT RAISE(ABORT, 'link failure'); END`
      expect(yield* refusal(storage.suspend(key, requestOperationStorage))).toBe(
        "Cell tool operation storage failed",
      )
      expect(yield* interactions.listOpen(cellOperationStorage)).toEqual([])
      expect((yield* storage.get(key)).state._tag).toBe("Started")
      yield* sql`DROP TRIGGER reject_cell_link`
      expect(
        yield* refusal(storage.suspend(key, requestOperationStorage).pipe(sql.withTransaction)),
      ).toBe("Cell operation admission must commit outside a caller transaction")
      expect(yield* interactions.listOpen(cellOperationStorage)).toEqual([])
      yield* storage.suspend(key, requestOperationStorage)
      expect(yield* interactions.listOpen(cellOperationStorage)).toEqual([requestOperationStorage])
      expect((yield* storage.get(key)).state).toEqual({ _tag: "Waiting", requestId })
    }).pipe(Effect.provide(cellTestStorage)),
  )

  it.live(
    "recovers cell operations only in their workspace and branch without granting execution",
    () =>
      Effect.gen(function* () {
        yield* fixture
        yield* (yield* CellStorage).executions.claim(cellOperationStorage)
        const storage = (yield* CellStorage).operations
        expect(yield* storage.listForToolCall(cellOperationStorage)).toEqual([])
        yield* storage.admit(params)
        yield* storage.suspend(key, requestOperationStorage)
        const found = yield* storage.listForToolCall(cellOperationStorage)
        expect(found).toHaveLength(1)
        expect(found[0]?.key).toEqual(key)
        expect(found[0]?.operation.state).toEqual({ _tag: "Waiting", requestId })
        expect(
          yield* refusal(
            storage.listForToolCall({ ...cellOperationStorage, branchId: BranchId.make("other") }),
          ),
        ).toBe("Cell operation is outside the current workspace and branch")
        expect(
          yield* refusal(
            storage
              .listForToolCall(cellOperationStorage)
              .pipe(Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("b".repeat(64)))),
          ),
        ).toBe("Cell operation is outside the current workspace and branch")
        yield* recordInteractionDecision(cellOperationStorage, requestId, { approved: true })
        const resumed = yield* storage.resume(key, requestId)
        yield* storage.complete(
          key,
          Prompt.toolResultPart({
            id: resumed.toolCallId,
            name: binding.toolId,
            result: "done",
            isFailure: false,
            providerExecuted: false,
          }),
        )
        yield* storage.admit({ ...params, operationId: "2" })
        const completed = yield* storage.listForToolCall(cellOperationStorage)
        expect(completed.map(({ operation }) => operation.state._tag)).toEqual([
          "Completed",
          "Started",
        ])
        expect((yield* storage.admit(params)).admitted).toBe(false)
      }).pipe(Effect.provide(cellTestStorage)),
  )

  it.live("binds a decision to one waiting operation and grants one resume attempt", () =>
    Effect.gen(function* () {
      yield* fixture
      yield* (yield* CellStorage).executions.claim(cellOperationStorage)
      const storage = (yield* CellStorage).operations
      const first = yield* storage.admit(params)
      const peer = { ...params, operationId: "2" }
      yield* storage.admit(peer)
      yield* storage.suspend(key, requestOperationStorage)
      expect(yield* refusal(storage.suspend(key, requestOperationStorage))).toBe(
        "Cell operation cannot wait from its current state",
      )
      // The request is already stored for the first operation, so the peer cannot store it again.
      expect(yield* refusal(storage.suspend(peer, requestOperationStorage))).toBe(
        "Failed to persist interaction request",
      )
      expect((yield* storage.get(peer)).state._tag).toBe("Started")
      expect(yield* refusal(storage.resume(key, requestId))).toBe(
        "Cell operation has no saved interaction decision",
      )
      const decision = { approved: false, notes: "Do not write" }
      yield* recordInteractionDecision(cellOperationStorage, requestId, decision)
      const resumed = yield* storage.resume(key, requestId)
      expect(resumed.state).toEqual({ _tag: "Resuming", requestId, decision })
      expect(resumed.toolCallId).toBe(first.operation.toolCallId)
      expect(yield* refusal(storage.resume(key, requestId))).toBe(
        "Cell operation is not waiting for this request",
      )
      expect((yield* storage.admit(params)).admitted).toBe(false)
      expect((yield* storage.get(key)).state._tag).toBe("Resuming")
    }).pipe(Effect.provide(cellTestStorage)),
  )

  it.live("a stored decision that does not decode grants no resume", () =>
    Effect.gen(function* () {
      yield* fixture
      yield* (yield* CellStorage).executions.claim(cellOperationStorage)
      const storage = (yield* CellStorage).operations
      yield* storage.admit(params)
      yield* storage.suspend(key, requestOperationStorage)
      // The first answer is the one the request keeps, so a corrupt one stays.
      yield* (yield* InteractionStorage).decide(cellOperationStorage, requestId, "not-json")
      expect(yield* refusal(storage.resume(key, requestId))).toBe(
        "Cell tool operation storage failed",
      )
      expect((yield* storage.get(key)).state._tag).toBe("Waiting")
    }).pipe(Effect.provide(cellTestStorage)),
  )

  it.live(
    "rejects cross-workspace and cross-branch access and clears records with the outer cell",
    () =>
      Effect.gen(function* () {
        yield* fixture
        yield* (yield* CellStorage).executions.claim(cellOperationStorage)
        const storage = (yield* CellStorage).operations
        const sql = yield* SqlClient.SqlClient
        yield* storage.admit(params)
        const outside = "Cell operation is outside the current workspace and branch"
        expect(
          yield* refusal(
            storage
              .get(key)
              .pipe(Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("a".repeat(64)))),
          ),
        ).toBe(outside)
        const wrong = {
          ...key,
          cell: { ...cellOperationStorage, branchId: BranchId.make("other-branch") },
        }
        expect(yield* refusal(storage.get(wrong))).toBe(outside)
        expect(yield* refusal(storage.admit({ ...params, ...wrong }))).toBe(outside)
        yield* sql`DELETE FROM messages WHERE id = ${cellOperationStorage.assistantMessageId}`
        const rows = yield* sql<{
          readonly count: number
        }>`SELECT COUNT(*) AS count FROM cell_tool_operations`
        expect(rows[0]?.count).toBe(0)
      }).pipe(Effect.provide(cellTestStorage)),
  )

  it.live("does not admit external work inside a caller transaction or after cell completion", () =>
    Effect.gen(function* () {
      yield* fixture
      const outer = (yield* CellStorage).executions
      yield* outer.claim(cellOperationStorage)
      const storage = (yield* CellStorage).operations
      const sql = yield* SqlClient.SqlClient
      const insideTransaction = "Cell operation admission must commit outside a caller transaction"
      expect(yield* refusal(storage.admit(params).pipe(sql.withTransaction))).toBe(
        insideTransaction,
      )
      expect((yield* storage.admit(params)).admitted).toBe(true)
      yield* storage.suspend(key, requestOperationStorage)
      yield* recordInteractionDecision(cellOperationStorage, requestId, { approved: true })
      expect(yield* refusal(storage.resume(key, requestId).pipe(sql.withTransaction))).toBe(
        insideTransaction,
      )
      expect((yield* storage.get(key)).state._tag).toBe("Waiting")
      yield* outer.complete(
        cellOperationStorage,
        Prompt.toolResultPart({
          id: cellOperationStorage.toolCallId,
          name: "cell",
          result: "cancelled",
          isFailure: true,
          providerExecuted: false,
        }),
      )
      const completedCell = "Completed cell cannot admit more host effects"
      expect(yield* refusal(storage.resume(key, requestId))).toBe(completedCell)
      expect(yield* refusal(storage.admit({ ...params, operationId: "2" }))).toBe(
        "Completed cell cannot admit more host effects",
      )
    }).pipe(Effect.provide(cellTestStorage)),
  )

  it.scopedLive(
    "retains approval ownership and prevents a second resume after database reopen",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const layer = Layer.provideMerge(
          CellStorage.Live,
          SqliteStorage.LiveWithSql(path.join(directory, "gent.db"), Layer.empty, {}),
        ).pipe(Layer.provide(GentPlatform.Test()))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer)
            yield* Effect.gen(function* () {
              yield* fixture
              yield* (yield* CellStorage).executions.claim(cellOperationStorage)
              const storage = (yield* CellStorage).operations
              yield* storage.admit(params)
              yield* storage.suspend(key, requestOperationStorage)
              yield* recordInteractionDecision(cellOperationStorage, requestId, { approved: true })
            }).pipe(Effect.provideContext(context))
          }),
        )
        const resumedId = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer)
            return yield* Effect.gen(function* () {
              const storage = (yield* CellStorage).operations
              expect((yield* storage.get(key)).state).toEqual({ _tag: "Waiting", requestId })
              expect(
                (yield* storage.listForToolCall(cellOperationStorage)).map(
                  ({ operation }) => operation.state,
                ),
              ).toEqual([{ _tag: "Waiting", requestId }])
              const resumed = yield* storage.resume(key, requestId)
              expect(resumed.state).toEqual({
                _tag: "Resuming",
                requestId,
                decision: { approved: true },
              })
              return resumed.toolCallId
            }).pipe(Effect.provideContext(context))
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer)
            yield* Effect.gen(function* () {
              const storage = (yield* CellStorage).operations
              const existing = yield* storage.admit(params)
              expect(existing.admitted).toBe(false)
              expect(existing.operation.toolCallId).toBe(resumedId)
              expect(existing.operation.state._tag).toBe("Resuming")
              expect(
                (yield* storage.listForToolCall(cellOperationStorage)).map(
                  ({ operation }) => operation.state._tag,
                ),
              ).toEqual(["Resuming"])
              expect(yield* refusal(storage.resume(key, requestId))).toBe(
                "Cell operation is not waiting for this request",
              )
            }).pipe(Effect.provideContext(context))
          }),
        )
      }).pipe(Effect.provide(BunServices.layer)),
  )
})
