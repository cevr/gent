import { describe, expect, it } from "effect-bun-test"
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect"
import { BranchStorage, SessionStorage } from "@gent/core/host"
import {
  createRpcHarness,
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textDeltaPart,
  textStep,
  toolCallPart,
  toolCallStep,
  waitFor,
} from "@gent/core/test-utils"
import type * as Prompt from "effect/ai/Prompt"
import type { Message } from "@gent/core/protocol"
import {
  BranchId,
  Branch,
  dateFromMillis,
  SteerCommand,
  AgentDefinition,
  DEFAULT_AGENT_NAME,
  CONTEXT_WINDOW_MESSAGE_TYPE,
  messagePartsText,
  contextWindowOf,
} from "@gent/core/protocol"
import {
  RequestId,
  defineExtension,
  ExtensionContext,
  ExtensionServiceError,
  ExtensionHost,
  tool,
  LoadedArtifactIdentity,
} from "@gent/core/extensions/api"
import {
  CellKernelResource,
  CellStorageResource,
  type CellExecution,
  CellOperationHost,
  CellStorage,
  CellTool,
} from "../src/cell.js"
import { DelegateExtension } from "../src/delegate.js"
import { CompactionExtension } from "../src/compaction.js"
import {
  buildCellWorker,
  openCellOwner,
  platform,
  sessionId,
  branchId,
  now,
  storedSessionContext,
  testLayer,
  hostCatalog,
  predecessor,
  setupCalls,
  recordCellCall,
} from "./helpers/cell-kernel.js"

/** Save a namespace holding `notes` for the predecessor's branch. */
const saveForPredecessor = (notes: ReadonlyArray<string>) =>
  Effect.flatMap(Effect.service(CellStorage), (storage) =>
    storage.namespaces.set(predecessor, {
      bindings: [{ name: "notes", value: notes }],
      omitted: [],
    }),
  )

/** Run a recorded cell with a host that selects no tools. */
const runCell = (
  owner: typeof CellExecution.Service,
  call: Parameters<typeof CellExecution.Service.run>[0],
) =>
  owner
    .run(call)
    .pipe(
      Effect.provideService(
        CellOperationHost,
        CellOperationHost.of({ catalog: hostCatalog(), call: () => Effect.never }),
      ),
    )

// The cell namespace: its restore into a new worker or owner, its handoff
// to a continuing session, the thread namespace, and context directives.

describe("cell namespace restore and handoff", () => {
  it.scopedLive(
    "restores the saved namespace into a replaced worker and into a new branch owner",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [define, hang, useAgain, later, wipe, gone] = yield* setupCalls(
          [
            "let n = 41; const seen = new Map([['k', new Date(0)]]); const fn = () => 1; n",
            "await tools.wait({})",
            "n + 1",
            "[n, seen.get('k') instanceof Date, typeof fn].join(',')",
            "typeof n",
            "typeof n",
          ],
          [4],
        )
        if (!define || !hang || !useAgain || !later || !wipe || !gone)
          return yield* Effect.die("Missing test cells")
        const started = yield* Deferred.make<boolean>()
        const host = CellOperationHost.of({
          catalog: hostCatalog("wait"),
          call: () => Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)),
        })
        const open = openCellOwner(worker)
        const cells = yield* open
        const run = (owner: typeof cells, call: Parameters<typeof cells.run>[0]) =>
          owner.run(call).pipe(Effect.provideService(CellOperationHost, host))
        expect((yield* run(cells, define)).result).toMatchObject({ display: "41" })
        // Cancellation loses the worker. The host replaces it and restores the last good namespace.
        const running = yield* run(cells, hang).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* cells.cancel
        expect(yield* Fiber.join(running)).toMatchObject({ isFailure: true })
        expect((yield* run(cells, useAgain)).result).toMatchObject({
          display: "42",
          restored: { restored: ["n", "seen"], omitted: [{ name: "fn", reason: "function" }] },
        })
        // A second owner over the same storage stands in for a process restart.
        const restarted = yield* open
        const revived = yield* run(restarted, later)
        expect(revived.result).toMatchObject({ display: "41,true,undefined" })
        // The report is attached once, to the first cell after a restore.
        expect((yield* run(restarted, later)).result).toEqual(revived.result)
        // An explicit reset clears the saved namespace for every later owner.
        expect((yield* run(restarted, wipe)).result).toMatchObject({ display: "undefined" })
        const fresh = yield* open
        const cleared = yield* run(fresh, gone)
        expect(cleared.result).toMatchObject({ display: "undefined" })
        expect(cleared.result).not.toHaveProperty("restored")
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(testLayer)),
    15000,
  )

  it.scopedLive(
    "a handoff copies its predecessor's namespace on first start, and a reset does not inherit it again",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [unsaved, copied, wipe, gone] = yield* setupCalls(
          [
            "notes.push('beta'); throw new Error('unsaved')",
            "notes.join(',')",
            "throw new Error('fresh start')",
            "typeof notes",
          ],
          [2],
          true,
        )
        if (!unsaved || !copied || !wipe || !gone) return yield* Effect.die("Missing test cells")
        yield* saveForPredecessor(["alpha"])
        const open = openCellOwner(worker)
        // The first start inherits; the failed cell saves nothing of its own.
        expect(yield* runCell(yield* open, unsaved)).toMatchObject({ isFailure: true })
        // The predecessor moves on. A restart restores the copy taken at the
        // first start, not the predecessor's newer namespace.
        yield* saveForPredecessor(["changed"])
        const restarted = yield* runCell(yield* open, copied)
        expect(restarted.result).toMatchObject({
          display: "alpha",
          restored: { restored: ["notes"], omitted: [] },
        })
        expect(restarted.result).not.toHaveProperty("restored.previousSession")
        // A reset whose cell fails still leaves an empty namespace: a restart
        // neither restores the old values nor inherits the predecessor's.
        const reopened = yield* open
        expect(yield* runCell(reopened, wipe)).toMatchObject({ isFailure: true })
        const fresh = yield* runCell(yield* open, gone)
        expect(fresh.result).toMatchObject({ display: "undefined" })
        expect(fresh.result).not.toHaveProperty("restored")
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(testLayer)),
    15000,
  )

  it.scopedLive(
    "a handoff whose predecessor saved nothing keeps its empty start after a restart",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [failed, later] = yield* setupCalls(
          ["throw new Error('before any save')", "typeof notes"],
          [],
          true,
        )
        if (!failed || !later) return yield* Effect.die("Missing test cells")
        expect(yield* runCell(yield* openCellOwner(worker), failed)).toMatchObject({
          isFailure: true,
        })
        // The predecessor saves only after the handoff's first start.
        yield* saveForPredecessor(["late"])
        const restarted = yield* runCell(yield* openCellOwner(worker), later)
        expect(restarted.result).toMatchObject({ display: "undefined" })
        expect(restarted.result).not.toHaveProperty("restored")
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(testLayer)),
    15000,
  )

  it.scopedLive(
    "only the handoff session's first branch inherits; a new or forked branch starts empty",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        yield* setupCalls([], [], true)
        yield* saveForPredecessor(["alpha"])
        const branches = yield* BranchStorage
        const created = BranchId.make("cell-execution-created")
        const forked = BranchId.make("cell-execution-forked")
        yield* branches.createBranch(
          new Branch({ id: created, sessionId, createdAt: dateFromMillis(now.getTime() + 1_000) }),
        )
        yield* branches.createBranch(
          new Branch({
            id: forked,
            sessionId,
            parentBranchId: branchId,
            createdAt: dateFromMillis(now.getTime() + 2_000),
          }),
        )
        for (const branch of [created, forked]) {
          const call = yield* recordCellCall({ branch, key: branch, code: "typeof notes" })
          const result = yield* runCell(yield* openCellOwner(worker, { branchId: branch }), call)
          expect(result.result).toMatchObject({ display: "undefined" })
          expect(result.result).not.toHaveProperty("restored")
        }
        const first = yield* recordCellCall({
          branch: branchId,
          key: "first",
          code: "notes.join(',')",
        })
        expect((yield* runCell(yield* openCellOwner(worker), first)).result).toMatchObject({
          display: "alpha",
          restored: { previousSession: predecessor.sessionId },
        })
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(testLayer)),
    15000,
  )

  it.scopedLive(
    "a failed session lookup at first start leaves no worker behind, and the next cell restores",
    () =>
      Effect.gen(function* () {
        const worker = yield* buildCellWorker
        const [failed, retried] = yield* setupCalls(
          ["notes.join(',')", "notes.join(',')"],
          [],
          true,
        )
        if (!failed || !retried) return yield* Effect.die("Missing test cells")
        yield* saveForPredecessor(["alpha"])
        const sessions = yield* SessionStorage
        const lookups = yield* Ref.make(0)
        // The first lookup fails; every later one reads storage.
        const flaky = yield* storedSessionContext((id) =>
          Effect.gen(function* () {
            if ((yield* Ref.getAndUpdate(lookups, (count) => count + 1)) === 0) {
              return yield* new ExtensionServiceError({
                service: "Session",
                operation: "getSession",
                message: "lookup unavailable",
              })
            }
            return yield* sessions.getSession(id ?? sessionId).pipe(Effect.orDie)
          }),
        )
        const owner = yield* openCellOwner(worker)
        const lost = yield* runCell(owner, failed).pipe(
          Effect.provideService(ExtensionContext, flaky),
          Effect.flip,
        )
        expect(lost).toMatchObject({ _tag: "StorageError" })
        const next = yield* runCell(owner, retried).pipe(
          Effect.provideService(ExtensionContext, flaky),
        )
        expect(next.result).toMatchObject({
          display: "alpha",
          restored: { restored: ["notes"], previousSession: predecessor.sessionId },
        })
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(testLayer)),
    15000,
  )
})

// ── thread namespace ────────────────────────────────────────────────────────

describe("thread namespace", () => {
  it.scopedLive(
    "a handoff session starts with its predecessor's namespace; a delegate child starts empty",
    () =>
      Effect.gen(function* () {
        // Each branch runs its own script, chosen by its first user text: the
        // woken parent turn and the child turn never race for one script.
        const firstText = (prompt: Prompt.Prompt) =>
          prompt.content.flatMap((message) => {
            if (message.role !== "user") return []
            return message.content.flatMap((part) => {
              if (part.type !== "text") return []
              return [part.text]
            })
          })[0] ?? ""
        const step = <A>(parts: ReadonlyArray<A>) => Effect.succeed(Stream.fromIterable(parts))
        const cell = (code: string) =>
          step([toolCallPart("cell", { code }), finishPart({ finishReason: "tool-calls" })])
        const reply = (text: string) =>
          step([textDeltaPart(text), finishPart({ finishReason: "stop" })])
        const scripts: ReadonlyArray<
          readonly [string, ReadonlyArray<() => ReturnType<typeof reply>>]
        > = [
          [
            "scratch A",
            [
              () => cell("const notes = ['alpha']; notes.length"),
              () =>
                cell(
                  "const h = await tools.delegate.start({ todo: 'child-probe' }); typeof h.requestId",
                ),
              () => reply("A started"),
              () => reply("A woke"),
            ],
          ],
          ["child-probe", [() => cell("typeof notes"), () => reply("child done")]],
          ["scratch B", [() => cell("notes.push('beta'); notes.join(',')"), () => reply("B done")]],
          ["scratch C", [() => cell("notes.join(',')"), () => reply("C done")]],
        ]
        const calls = new Map<string, number>()
        const providerLayer = LanguageModelLayers.testStream((options) => {
          const text = firstText(options.prompt)
          const script = scripts.find(([key]) => text.endsWith(key))
          if (Predicate.isUndefined(script)) return reply(`no script for ${text}`)
          const index = calls.get(script[0]) ?? 0
          calls.set(script[0], index + 1)
          const next = script[1][index] ?? (() => reply(`${script[0]} extra`))
          return next()
        })
        const fixture = defineExtension({
          id: "cell-thread-namespace-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("resource", CellStorageResource, CellKernelResource)
            yield* host.register("tool", CellTool)
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("cell-thread-namespace-source"),
            },
            {
              ...DelegateExtension,
              artifactIdentity: LoadedArtifactIdentity.make("delegate-source"),
            },
          ],
        })
        const cellResults = (branch: BranchId) =>
          client.message
            .list({ branchId: branch })
            .pipe(
              Effect.map((messages) =>
                messages
                  .flatMap((message) => message.parts)
                  .filter(
                    (part): part is Prompt.ToolResultPart =>
                      part.type === "tool-result" && part.name === "cell",
                  ),
              ),
            )
        const replied = (branch: BranchId, text: string) =>
          waitFor(
            client.message.list({ branchId: branch }),
            (items) =>
              items.some(
                (item) => item.role === "assistant" && messagePartsText(item.parts) === text,
              ),
            12_000,
            `reply ${text}`,
          )

        yield* client.message.send({ sessionId, branchId, content: "scratch A" })
        yield* replied(branchId, "A woke")
        // A delegate child is side work: it does not join the thread, so its
        // cell starts empty.
        const child = (yield* client.session.list()).find(
          (session) => session.parentSessionId === sessionId,
        )
        if (Predicate.isUndefined(child?.activeBranchId)) {
          return yield* Effect.die("Missing child session")
        }
        const childResults = yield* cellResults(child.activeBranchId)
        expect(childResults).toMatchObject([{ isFailure: false, result: { display: "undefined" } }])
        expect(childResults[0]?.result).not.toHaveProperty("restored")

        // A handoff continues the thread: its first cell reads A's notes, and
        // the report names A as the session they came from.
        const handoff = { parentSessionId: sessionId, parentBranchId: branchId }
        const b = yield* client.session.create({ ...handoff, continueThread: true })
        yield* client.message.send({
          sessionId: b.sessionId,
          branchId: b.branchId,
          content: "scratch B",
        })
        yield* replied(b.branchId, "B done")
        const [bResult] = yield* cellResults(b.branchId)
        expect(bResult).toMatchObject({
          isFailure: false,
          result: { display: "alpha,beta", restored: { previousSession: sessionId } },
        })
        expect(bResult?.result).toHaveProperty(
          "restored.restored",
          expect.arrayContaining(["notes"]),
        )

        // B's write went to its own namespace: a second handoff from A still
        // reads A's saved notes.
        const c = yield* client.session.create({ ...handoff, continueThread: true })
        yield* client.message.send({
          sessionId: c.sessionId,
          branchId: c.branchId,
          content: "scratch C",
        })
        yield* replied(c.branchId, "C done")
        expect(yield* cellResults(c.branchId)).toMatchObject([
          { isFailure: false, result: { display: "alpha" } },
        ])
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(platform)),
    30000,
  )
})

// ── model context directives ────────────────────────────────────────────────

const hasReply = (text: string) => (items: ReadonlyArray<Message>) =>
  items.some((item) => item.parts.some((part) => part.type === "text" && part.text === text))

const windowMarkers = (items: ReadonlyArray<Message>) =>
  items.filter((message) => message.metadata?.customType === CONTEXT_WINDOW_MESSAGE_TYPE)

describe("model context directives from a cell", () => {
  it.scopedLive(
    "a handoff leads the window until a bare context window replaces it",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          textStep("history reply"),
          toolCallStep("cell", { code: "await context.compact()" }),
          textStep("summary of older history"),
          textStep("after compaction"),
          textStep("summary reused"),
          toolCallStep("cell", { code: "await context.newWindow(); 'windowed'" }),
          textStep("after window"),
          textStep("second turn"),
        ])
        const fixture = defineExtension({
          id: "model-context-directive-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("resource", CellStorageResource, CellKernelResource)
            yield* host.register("tool", CellTool)
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            CompactionExtension,
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("model-context-directive-source"),
            },
          ],
        })
        yield* client.message.send({ sessionId, branchId, content: "older history" })
        yield* waitFor(client.message.list({ branchId }), hasReply("history reply"))
        yield* client.message.send({ sessionId, branchId, content: "compact older history" })
        const compacted = yield* waitFor(
          client.message.list({ branchId }),
          hasReply("after compaction"),
        )
        const handoff = Option.getOrThrow(
          Option.fromUndefinedOr(
            windowMarkers(compacted).find((m) => Option.isSome(contextWindowOf(m))),
          ),
        )
        const details = Option.getOrThrow(contextWindowOf(handoff))
        expect(details.summarized?.count).toBeGreaterThan(0)
        const afterCompaction = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(afterCompaction.metrics.context).toMatchObject({
          handoffMessageId: handoff.id,
          compactions: 1,
        })
        yield* client.message.send({ sessionId, branchId, content: "reuse the summary" })
        yield* waitFor(client.message.list({ branchId }), hasReply("summary reused"))
        const reused = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(reused.metrics.context).toMatchObject({
          handoffMessageId: handoff.id,
          compactions: 1,
        })
        yield* client.message.send({ sessionId, branchId, content: "open a new window" })
        const afterFirst = yield* waitFor(
          client.message.list({ branchId }),
          hasReply("after window"),
        )
        // The handoff marker and the bare window marker are both durable.
        const markers = windowMarkers(afterFirst)
        expect(markers).toHaveLength(2)
        // The new marker anchors on the user message that started this turn.
        const anchor = afterFirst.find(
          (message) => message.role === "user" && hasReply("open a new window")([message]),
        )
        expect(markers[1]?.metadata?.details).toMatchObject({ keepFromMessageId: anchor?.id })

        yield* client.message.send({ sessionId, branchId, content: "and again" })
        const afterSecond = yield* waitFor(
          client.message.list({ branchId }),
          hasReply("second turn"),
        )
        expect(windowMarkers(afterSecond)).toHaveLength(2)
        const windowed = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(windowed.metrics.context?.handoffMessageId).toBeUndefined()
        expect(windowed.metrics.context?.compactions).toBe(1)
        expect(afterSecond.some((message) => message.id === handoff.id)).toBe(true)
        yield* controls.assertDone
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )

  it.scopedLive(
    "a handoff summary names the cell bindings the kept turn still uses",
    () =>
      Effect.gen(function* () {
        // A failed summary call degrades to no handoff, so an assertion thrown
        // inside the model would be swallowed; the request is kept and read after.
        const summaryPrompts: Array<string> = []
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: "const rows = [1, 2, 3]; 'bound'" }),
          textStep("rows bound"),
          toolCallStep("cell", { code: "await context.compact(); rows.length" }),
          {
            ...textStep("summary of older history"),
            assertOptions: (options) => {
              summaryPrompts.push(
                Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(options.prompt),
              )
            },
          },
          textStep("after compaction"),
        ])
        const fixture = defineExtension({
          id: "retained-bindings-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("resource", CellStorageResource, CellKernelResource)
            yield* host.register("tool", CellTool)
          }),
        })
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            CompactionExtension,
            {
              ...fixture,
              artifactIdentity: LoadedArtifactIdentity.make("retained-bindings-source"),
            },
          ],
        })
        yield* client.message.send({ sessionId, branchId, content: "bind the rows" })
        yield* waitFor(client.message.list({ branchId }), hasReply("rows bound"))
        yield* client.message.send({ sessionId, branchId, content: "compact, then count rows" })
        yield* waitFor(client.message.list({ branchId }), hasReply("after compaction"))
        yield* controls.assertDone
        expect(summaryPrompts).toHaveLength(1)
        expect(summaryPrompts[0]).toContain("Names retained on this branch: rows")
      }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
    20000,
  )

  for (const directive of ["newWindow", "compact"]) {
    it.scopedLive(
      `an interrupted cell does not apply context.${directive}() to the next turn`,
      () =>
        Effect.gen(function* () {
          const scheduled = yield* Deferred.make<void>()
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            textStep("history reply"),
            toolCallStep("cell", {
              code: `await context.${directive}(); await tools.hold({})`,
            }),
            {
              ...textStep("after interrupt"),
              assertOptions: (options) => {
                const prompt = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(
                  options.prompt,
                )
                expect(prompt).toContain("keep older context")
                expect(prompt).not.toContain("New context window")
              },
            },
          ])
          const fixture = defineExtension({
            id: "interrupted-context-directive-fixture",
            setup: Effect.gen(function* () {
              const host = yield* ExtensionHost
              yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
              yield* host.register("resource", CellStorageResource, CellKernelResource)
              yield* host.register(
                "tool",
                CellTool,
                tool({
                  id: "hold",
                  description: "Hold the cell after it schedules a context directive",
                  params: Schema.Struct({}),
                  output: Schema.String,
                  execute: () =>
                    Deferred.succeed(scheduled, void 0).pipe(Effect.andThen(Effect.never)),
                }),
              )
            }),
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            providerLayer,
            agents: [],
            extensionInputs: [
              CompactionExtension,
              {
                ...fixture,
                artifactIdentity: LoadedArtifactIdentity.make(
                  "interrupted-context-directive-source",
                ),
              },
            ],
          })
          yield* client.message.send({ sessionId, branchId, content: "keep older context" })
          yield* waitFor(client.message.list({ branchId }), hasReply("history reply"))
          yield* client.message.send({ sessionId, branchId, content: "schedule then wait" })
          yield* Deferred.await(scheduled)
          yield* client.steer.command({
            command: SteerCommand.make({
              _tag: "Cancel",
              sessionId,
              branchId,
              requestId: RequestId.make("interrupt-context-directive"),
            }),
          })
          yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(
              ({ event }) => event._tag === "TurnCompleted" && event.interrupted === true,
            ),
            Stream.take(1),
            Stream.runDrain,
          )
          expect(windowMarkers(yield* client.message.list({ branchId }))).toHaveLength(0)
          yield* client.message.send({
            sessionId,
            branchId,
            content: "continue without that directive",
          })
          const messages = yield* waitFor(
            client.message.list({ branchId }),
            hasReply("after interrupt"),
          )
          expect(windowMarkers(messages)).toHaveLength(0)
          expect(yield* controls.callCount).toBe(3)
          yield* controls.assertDone
        }).pipe(Effect.timeout("15 seconds"), Effect.provide(platform)),
      20000,
    )
  }
})

// ── kernel across an edit ───────────────────────────────────────────────────

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/**
 * A user extension the cell does not read: one process resource, which logs
 * its release with the extension's version.
 */
const unrelatedSource = (version: string, log: string) => `import { appendFileSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api";
class Unrelated extends Context.Service<Unrelated, { readonly version: string }>()("@test/unrelated/Unrelated") {}
const version = ${encodeJsonText(version)};
export default defineExtension({
  id: "@test/unrelated",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost;
    yield* host.register("resource", defineResource({
      id: "@test/unrelated/process",
      scope: "process",
      layer: Layer.effect(Unrelated, Effect.acquireRelease(
        Effect.sync(() => Unrelated.of({ version })),
        () => Effect.sync(() => appendFileSync(${encodeJsonText(log)}, "release:" + version + "\\n")),
      )),
    }));
  }),
});
`

describe("cell kernel across an edit", () => {
  it.scopedLive(
    "an edit to another extension with process resources keeps the worker: a function binding survives",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* makeTempDirectoryScoped("gent-cell-edit-home-")
        const cwd = yield* makeTempDirectoryScoped("gent-cell-edit-cwd-")
        const extensionsDir = path.join(home, ".gent", "extensions")
        yield* fs.makeDirectory(extensionsDir, { recursive: true })
        const log = path.join(home, "unrelated.log")
        yield* fs.writeFileString(log, "")
        const unrelatedFile = path.join(extensionsDir, "unrelated.ts")
        yield* fs.writeFileString(unrelatedFile, unrelatedSource("one", log))
        const fixture = defineExtension({
          id: "cell-edit-fixture",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", new AgentDefinition({ name: DEFAULT_AGENT_NAME }))
            yield* host.register("resource", CellStorageResource, CellKernelResource)
            yield* host.register("tool", CellTool)
          }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: "function seven() { return 7 }" }),
          textStep("defined"),
          toolCallStep("cell", { code: "seven()" }),
          textStep("called"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          providerLayer,
          agents: [],
          extensionInputs: [
            { ...fixture, artifactIdentity: LoadedArtifactIdentity.make("cell-edit-source") },
          ],
          home,
          cwd,
        })
        const replied = (text: string) =>
          waitFor(
            client.message.list({ branchId }),
            (items) =>
              items.some(
                (item) => item.role === "assistant" && messagePartsText(item.parts) === text,
              ),
            10_000,
            `reply ${text}`,
          )
        yield* client.message.send({ sessionId, branchId, content: "define a function" })
        yield* replied("defined")
        yield* fs.writeFileString(unrelatedFile, unrelatedSource("two", log))
        yield* client.message.send({ sessionId, branchId, content: "call it" })
        yield* replied("called")
        // The edit reached the session: the profile before it retired.
        yield* waitFor(
          fs.readFileString(log),
          (text) => text.includes("release:one"),
          5_000,
          "the first version released",
        )
        const results = (yield* client.message.list({ branchId }))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result")
          .filter((part) => part.name === "cell")
        expect(results).toHaveLength(2)
        expect(results[1]).toMatchObject({ isFailure: false, result: { display: "7" } })
        expect(results[1]?.result).not.toHaveProperty("restored")
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(platform)),
    30000,
  )
})
