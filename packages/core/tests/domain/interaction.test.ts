import { describe, expect, it } from "effect-bun-test"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema } from "effect"
import { InteractionStorage, type InteractionStorageService } from "../../src/storage/storage"
import { ensureStorageParents, testSqliteStorage } from "../../src/test-utils/harness"
import { EventStoreError } from "../../src/domain/event"
import {
  CurrentInteractionOwner,
  InteractionPendingError,
  type InteractionRequestRecord,
  type InteractionService,
  type InteractionStorageConfig,
  makeInteractionService,
} from "../../src/domain/interaction"
import { BranchId, InteractionRequestId, SessionId, ToolCallId } from "../../src/domain/ids"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { CurrentWorkspaceId } from "../../src/server/workspace-rpc"

const persistInteraction = (is: InteractionStorageService, record: InteractionRequestRecord) =>
  is.persist(record).pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new EventStoreError({
          message: "Failed to persist interaction request",
          cause,
        }),
    ),
  )
const decideInteraction = (
  is: InteractionStorageService,
  branch: { readonly sessionId: SessionId; readonly branchId: BranchId },
  requestId: InteractionRequestId,
  decisionJson: string,
) =>
  is.decide(branch, requestId, decisionJson).pipe(
    Effect.mapError(
      (cause) =>
        new EventStoreError({
          message: "Failed to persist interaction decision",
          cause,
        }),
    ),
  )
/** Run `self` as one run of the call `id`, the only call of its step. */
const asCall =
  (
    service: InteractionService,
    branch: { readonly sessionId: SessionId; readonly branchId: BranchId },
    id = "call-1",
  ) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    service
      .beginStep(branch, [ToolCallId.make(id)])
      .pipe(Effect.andThen(service.ownCall(branch, ToolCallId.make(id))(self)))

/**
 * The request the branch shows now. A reply to an id nobody asked is refused
 * and names the shown request, so the lookup changes nothing.
 */
const shownRequest = (
  service: InteractionService,
  branch: { readonly sessionId: SessionId; readonly branchId: BranchId },
) =>
  service
    .storeResolution(branch, InteractionRequestId.make("no-such-request"), { approved: false })
    .pipe(
      Effect.flip,
      Effect.map((error) => {
        if (error._tag !== "InteractionRequestMismatchError") return Option.none()
        return Option.fromUndefinedOr(error.expectedRequestId)
      }),
    )

// ============================================================================
// Interaction Request — cold interaction mechanics
// ============================================================================
describe("Interaction Request", () => {
  const storageLive = Layer.mergeAll(
    testSqliteStorage(() => Layer.empty, {}),
    GentPlatform.Test(),
  )
  const callbacksFor = (is: InteractionStorage["Service"]): InteractionStorageConfig => ({
    persist: (record) => persistInteraction(is, record),
    decide: (branch, requestId, decisionJson) =>
      decideInteraction(is, branch, requestId, decisionJson),
    resolve: (requestId) => is.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
    take: (requestId) => is.take(requestId).pipe(Effect.catchEager(() => Effect.void)),
  })
  const workspaceA = "a".repeat(64)
  const workspaceB = "b".repeat(64)
  it.live("present persists request to storage and throws InteractionPendingError", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const storageCallbacks = callbacksFor(is)
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: storageCallbacks,
      })
      yield* ensureStorageParents({
        sessionId: SessionId.make("s1"),
        branchId: BranchId.make("b1"),
      })
      // present() should fail with InteractionPendingError
      const error = yield* Effect.flip(
        asCall(interaction, { sessionId: SessionId.make("s1"), branchId: BranchId.make("b1") })(
          interaction.present(
            { text: "Approve this?" },
            { sessionId: SessionId.make("s1"), branchId: BranchId.make("b1") },
          ),
        ),
      )
      expect(error._tag).toBe("InteractionPendingError")
      if (!Schema.is(InteractionPendingError)(error)) {
        return yield* Effect.die(new Error("expected pending"))
      }
      expect(error.requestId).toBeTruthy()
      expect(error.sessionId).toBe(SessionId.make("s1"))
      expect(error.branchId).toBe(BranchId.make("b1"))
      // Verify persisted to storage
      const pending = yield* is.listOpen()
      expect(pending.length).toBe(1)
      expect(pending[0]!.sessionId).toBe(SessionId.make("s1"))
      expect(pending[0]!.branchId).toBe(BranchId.make("b1"))
      expect(pending[0]!.status).toBe("pending")
    }).pipe(Effect.provide(storageLive)),
  )
  it.live("respond marks request as resolved in storage", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      // Manually insert a pending record
      const record: InteractionRequestRecord = {
        requestId: InteractionRequestId.make("req-manual-1"),
        sessionId: SessionId.make("s2"),
        branchId: BranchId.make("b2"),
        paramsJson: "{}",
        status: "pending",
        createdAt: yield* Clock.currentTimeMillis,
      } satisfies Parameters<typeof is.persist>[0]
      yield* ensureStorageParents({ sessionId: record.sessionId, branchId: record.branchId })
      yield* is.persist(record)
      // Verify it's pending
      const before = yield* is.listOpen()
      expect(before.some((r) => r.requestId === InteractionRequestId.make("req-manual-1"))).toBe(
        true,
      )
      // Resolve it
      yield* is.resolve(InteractionRequestId.make("req-manual-1"))
      // Verify it's no longer pending
      const after = yield* is.listOpen()
      expect(after.some((r) => r.requestId === InteractionRequestId.make("req-manual-1"))).toBe(
        false,
      )
    }).pipe(Effect.provide(storageLive)),
  )
  it.live("pending requests are scoped to the current workspace", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const first = {
        requestId: InteractionRequestId.make("req-workspace-a"),
        sessionId: SessionId.make("s-workspace-a"),
        branchId: BranchId.make("b-workspace-a"),
        paramsJson: "{}",
        status: "pending",
        createdAt: yield* Clock.currentTimeMillis,
      } satisfies Parameters<typeof is.persist>[0]
      const second = {
        requestId: InteractionRequestId.make("req-workspace-b"),
        sessionId: SessionId.make("s-workspace-b"),
        branchId: BranchId.make("b-workspace-b"),
        paramsJson: "{}",
        status: "pending",
        createdAt: first.createdAt + 1,
      } satisfies Parameters<typeof is.persist>[0]

      yield* ensureStorageParents({
        sessionId: first.sessionId,
        branchId: first.branchId,
      }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
      yield* is.persist(first).pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
      yield* ensureStorageParents({
        sessionId: second.sessionId,
        branchId: second.branchId,
      }).pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))
      yield* is.persist(second).pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))

      const pendingA = yield* is
        .listOpen()
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
      const pendingB = yield* is
        .listOpen()
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))

      expect(pendingA.map((record) => record.requestId)).toEqual([first.requestId])
      expect(pendingB.map((record) => record.requestId)).toEqual([second.requestId])

      yield* is
        .resolve(second.requestId)
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
      const stillPendingB = yield* is
        .listOpen()
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))
      expect(stillPendingB.map((record) => record.requestId)).toEqual([second.requestId])

      yield* is
        .resolve(second.requestId)
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))
      const resolvedB = yield* is
        .listOpen()
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))
      expect(resolvedB).toEqual([])
    }).pipe(Effect.provide(storageLive)),
  )
  it.live("pending requests are unique per session branch", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const sessionId = SessionId.make("s-singleton")
      const branchId = BranchId.make("b-singleton")
      yield* ensureStorageParents({ sessionId, branchId })
      yield* is.persist({
        requestId: InteractionRequestId.make("req-singleton-1"),
        sessionId,
        branchId,
        paramsJson: "{}",
        status: "pending",
        createdAt: 1,
      })
      const duplicate = yield* Effect.exit(
        is.persist({
          requestId: InteractionRequestId.make("req-singleton-2"),
          sessionId,
          branchId,
          paramsJson: "{}",
          status: "pending",
          createdAt: 2,
        }),
      )
      expect(duplicate._tag).toBe("Failure")
      const pending = yield* is.listOpen({ sessionId, branchId })
      expect(pending.map((record) => record.requestId)).toEqual([
        InteractionRequestId.make("req-singleton-1"),
      ])
    }).pipe(Effect.provide(storageLive)),
  )
  it.live("a stored owner loads back, and a row stored without one still loads", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const sessionId = SessionId.make("s-owner")
      const owned = { sessionId, branchId: BranchId.make("b-owned") }
      const legacy = { sessionId, branchId: BranchId.make("b-legacy") }
      yield* ensureStorageParents(owned)
      yield* ensureStorageParents(legacy)
      const owner = { toolCallId: ToolCallId.make("call-1"), occurrence: 2 }
      yield* is.persist({
        requestId: InteractionRequestId.make("req-owned"),
        ...owned,
        paramsJson: "{}",
        status: "pending",
        createdAt: 1,
        owner,
      })
      yield* is.persist({
        requestId: InteractionRequestId.make("req-legacy"),
        ...legacy,
        paramsJson: "{}",
        status: "pending",
        createdAt: 2,
      })
      const [ownedRow] = yield* is.listOpen(owned)
      const [legacyRow] = yield* is.listOpen(legacy)
      expect(ownedRow?.owner).toEqual(owner)
      expect(legacyRow?.requestId).toBe(InteractionRequestId.make("req-legacy"))
      expect(legacyRow?.owner).toBeUndefined()
    }).pipe(Effect.provide(storageLive)),
  )
  it.live("service fails closed when durable pending singleton rejects a second request", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const sessionId = SessionId.make("s-service-singleton")
      const branchId = BranchId.make("b-service-singleton")
      const storageCallbacks = callbacksFor(is)
      yield* ensureStorageParents({ sessionId, branchId })
      yield* is.persist({
        requestId: InteractionRequestId.make("req-existing-pending"),
        sessionId,
        branchId,
        paramsJson: "{}",
        status: "pending",
        createdAt: 1,
      })

      const presented: InteractionRequestId[] = []
      const interaction = yield* makeInteractionService({
        onPresent: (requestId) =>
          Effect.sync(() => {
            presented.push(requestId)
          }),
        onDismiss: () => Effect.void,
        storage: storageCallbacks,
      })
      const exit = yield* Effect.exit(
        asCall(interaction, { sessionId, branchId })(
          interaction.present({ text: "second" }, { sessionId, branchId }),
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(Cause.pretty(exit.cause)).toContain("Failed to persist interaction request")
      }
      expect(presented).toEqual([])
      expect(yield* shownRequest(interaction, { sessionId, branchId })).toEqual(Option.none())
      const pending = yield* is.listOpen({ sessionId, branchId })
      expect(pending.map((record) => record.requestId)).toEqual([
        InteractionRequestId.make("req-existing-pending"),
      ])
    }).pipe(Effect.provide(storageLive)),
  )
  it.live("storeResolution + subsequent present returns stored value without throwing", () =>
    Effect.gen(function* () {
      const storageCallbacks = callbacksFor(yield* InteractionStorage)
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: storageCallbacks,
      })
      const sessionId = SessionId.make("s-cold")
      const branchId = BranchId.make("b-cold")
      yield* ensureStorageParents({ sessionId, branchId })
      // First present — fails with InteractionPendingError
      const error = yield* Effect.flip(
        asCall(interaction, { sessionId, branchId })(
          interaction.present({ text: "Approve?" }, { sessionId, branchId }),
        ),
      )
      expect(error._tag).toBe("InteractionPendingError")
      if (!Schema.is(InteractionPendingError)(error)) {
        return yield* Effect.die(new Error("expected pending"))
      }
      // Store resolution keyed by requestId
      yield* interaction.storeResolution({ sessionId, branchId }, error.requestId, {
        approved: true,
      })
      // Second present — finds stored resolution, returns it
      const result = yield* asCall(interaction, { sessionId, branchId })(
        interaction.present({ text: "Approve?" }, { sessionId, branchId }),
      )
      expect(result.approved).toBe(true)
    }).pipe(Effect.provide(storageLive)),
  )
  it.live("rehydrate + storeResolution + present returns stored value (restart-resume)", () =>
    Effect.gen(function* () {
      // Simulate a fresh service after restart — no in-memory state
      const storageCallbacks = callbacksFor(yield* InteractionStorage)
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: storageCallbacks,
      })
      const sessionId = SessionId.make("s-restart")
      const branchId = BranchId.make("b-restart")
      const requestId = InteractionRequestId.make("req-restart-1")
      // Rehydrate rebuilds the pendingByContext reverse lookup
      yield* interaction.rehydrate({
        requestId,
        sessionId,
        branchId,
        paramsJson: `{"text":"Approve?"}`,
        status: "pending",
        createdAt: 0,
      })
      // Client responds — store the resolution
      yield* interaction.storeResolution({ sessionId, branchId }, requestId, {
        approved: true,
        notes: "yes",
      })
      // Tool re-calls present() — should find stored resolution via context lookup
      const result = yield* asCall(interaction, { sessionId, branchId })(
        interaction.present({ text: "Approve?" }, { sessionId, branchId }),
      )
      expect(result.approved).toBe(true)
      expect(result.notes).toBe("yes")
    }).pipe(Effect.provide(storageLive)),
  )
  it.live("cold-resume with InteractionStorage: persist → new service → rehydrate → resolve", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const storageCallbacks = callbacksFor(is)
      const sessionId = SessionId.make("s-cold-resume")
      const branchId = BranchId.make("b-cold-resume")
      yield* ensureStorageParents({ sessionId, branchId })
      // Phase 1: original service — present() persists and throws
      const service1 = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: storageCallbacks,
      })
      const error = yield* Effect.flip(
        asCall(service1, { sessionId, branchId })(
          service1.present({ text: "Approve deployment?" }, { sessionId, branchId }),
        ),
      )
      expect(error._tag).toBe("InteractionPendingError")
      if (!Schema.is(InteractionPendingError)(error)) {
        return yield* Effect.die(new Error("expected pending"))
      }
      const requestId = error.requestId
      // Verify persisted to SQL
      const pending = yield* is.listOpen()
      expect(pending.some((r) => r.requestId === requestId)).toBe(true)
      // Phase 2: simulate restart — create a fresh service instance (no in-memory state)
      const service2 = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: storageCallbacks,
      })
      // Load pending request from storage and rehydrate
      const persisted = pending.find((r) => r.requestId === requestId)!
      yield* service2.rehydrate(persisted)
      // Client responds
      yield* service2.storeResolution({ sessionId, branchId }, requestId, {
        approved: true,
        notes: "ship it",
      })
      // Tool re-calls present() — should find the stored resolution
      const result = yield* asCall(service2, { sessionId, branchId })(
        service2.present({ text: "Approve deployment?" }, { sessionId, branchId }),
      )
      expect(result.approved).toBe(true)
      expect(result.notes).toBe("ship it")
      // Verify resolved in storage
      const afterResolve = yield* is.listOpen()
      expect(afterResolve.some((r) => r.requestId === requestId)).toBe(false)
    }).pipe(Effect.provide(storageLive)),
  )

  const pendingId = (exit: Exit.Exit<unknown, unknown>) => {
    if (Exit.isSuccess(exit)) return Effect.die(new Error("expected the call to park"))
    const error = Cause.squash(exit.cause)
    if (!Schema.is(InteractionPendingError)(error)) return Effect.die(error)
    return Effect.succeed(error.requestId)
  }

  it.live("the first answer to a request wins; a different later answer is refused", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: callbacksFor(is),
      })
      const sessionId = SessionId.make("s-first-wins")
      const branchId = BranchId.make("b-first-wins")
      yield* ensureStorageParents({ sessionId, branchId })
      const requestId = yield* pendingId(
        yield* Effect.exit(
          asCall(interaction, { sessionId, branchId })(
            interaction.present({ text: "Run it?" }, { sessionId, branchId }),
          ),
        ),
      )
      yield* interaction.storeResolution({ sessionId, branchId }, requestId, {
        approved: false,
        notes: "no",
      })
      const conflict = yield* Effect.flip(
        interaction.storeResolution({ sessionId, branchId }, requestId, {
          approved: true,
          notes: "yes",
        }),
      )
      expect(conflict._tag).toBe("InteractionDecisionConflictError")
      // The same answer again is accepted: a retried reply is not an error.
      yield* interaction.storeResolution({ sessionId, branchId }, requestId, {
        approved: false,
        notes: "no",
      })
      const stored = yield* is.listOpen({ sessionId, branchId })
      expect(stored.map((record) => record.decisionJson)).toEqual([
        `{"approved":false,"notes":"no"}`,
      ])
      const result = yield* asCall(interaction, { sessionId, branchId })(
        interaction.present({ text: "Run it?" }, { sessionId, branchId }),
      )
      expect(result).toEqual({ approved: false, notes: "no" })
    }).pipe(Effect.provide(storageLive)),
  )

  it.live("two answers at once: one is kept, the other is refused", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: callbacksFor(is),
      })
      const sessionId = SessionId.make("s-race")
      const branchId = BranchId.make("b-race")
      yield* ensureStorageParents({ sessionId, branchId })
      const requestId = yield* pendingId(
        yield* Effect.exit(
          asCall(interaction, { sessionId, branchId })(
            interaction.present({ text: "Run it?" }, { sessionId, branchId }),
          ),
        ),
      )
      const exits = yield* Effect.all(
        [
          Effect.exit(
            interaction.storeResolution({ sessionId, branchId }, requestId, { approved: false }),
          ),
          Effect.exit(
            interaction.storeResolution({ sessionId, branchId }, requestId, { approved: true }),
          ),
        ],
        { concurrency: "unbounded" },
      )
      expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
      // The decline was sent first; the approval wins only when the decline lost.
      const winner = Exit.isFailure(exits[0])
      const result = yield* asCall(interaction, { sessionId, branchId })(
        interaction.present({ text: "Run it?" }, { sessionId, branchId }),
      )
      expect(result.approved).toBe(winner)
    }).pipe(Effect.provide(storageLive)),
  )

  it.live("storage keeps the first answer when another service instance answers later", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const sessionId = SessionId.make("s-two-services")
      const branchId = BranchId.make("b-two-services")
      yield* ensureStorageParents({ sessionId, branchId })
      const first = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: callbacksFor(is),
      })
      const requestId = yield* pendingId(
        yield* Effect.exit(
          asCall(first, { sessionId, branchId })(
            first.present({ text: "Run it?" }, { sessionId, branchId }),
          ),
        ),
      )
      // The second instance loads the request before any answer, so only
      // storage knows that an answer came.
      const second = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: callbacksFor(is),
      })
      for (const record of yield* is.listOpen({ sessionId, branchId }))
        yield* second.rehydrate(record)
      yield* first.storeResolution({ sessionId, branchId }, requestId, { approved: false })
      const conflict = yield* Effect.flip(
        second.storeResolution({ sessionId, branchId }, requestId, { approved: true }),
      )
      expect(conflict._tag).toBe("InteractionDecisionConflictError")
      const stored = yield* is.listOpen({ sessionId, branchId })
      expect(stored.map((record) => record.decisionJson)).toEqual([`{"approved":false}`])
    }).pipe(Effect.provide(storageLive)),
  )

  it.live("a call that asks two questions takes both answers on its third run", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const storage = callbacksFor(is)
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage,
      })
      const branch = { sessionId: SessionId.make("s-twice"), branchId: BranchId.make("b-twice") }
      yield* ensureStorageParents(branch)
      const run = asCall(
        interaction,
        branch,
      )(
        Effect.gen(function* () {
          const one = yield* interaction.present({ text: "Q1" }, branch)
          const two = yield* interaction.present({ text: "Q2" }, branch)
          return `${String(one.notes)}/${String(two.notes)}`
        }),
      ).pipe(Effect.exit)
      const first = yield* pendingId(yield* run)
      yield* interaction.storeResolution(branch, first, { approved: true, notes: "one" })
      const second = yield* pendingId(yield* run)
      yield* interaction.storeResolution(branch, second, { approved: true, notes: "two" })
      const third = yield* run.pipe(Effect.timeoutOption("2 seconds"))
      expect(Option.map(third, (exit) => Exit.isSuccess(exit) && exit.value)).toEqual(
        Option.some("one/two"),
      )
      // The call ended, so the answers it kept are no longer open.
      expect(yield* is.listOpen(branch)).toEqual([])
    }).pipe(Effect.provide(storageLive)),
  )

  it.live("an answer is not given to a changed question", () =>
    Effect.gen(function* () {
      const storage = callbacksFor(yield* InteractionStorage)
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage,
      })
      const branch = { sessionId: SessionId.make("s-change"), branchId: BranchId.make("b-change") }
      yield* ensureStorageParents(branch)
      const ask = (text: string) =>
        asCall(interaction, branch)(interaction.present({ text }, branch)).pipe(Effect.exit)
      const first = yield* pendingId(yield* ask("Delete a.txt?"))
      yield* interaction.storeResolution(branch, first, { approved: true })
      const second = yield* pendingId(yield* ask("Delete b.txt?"))
      expect(second).not.toBe(first)
      expect(yield* shownRequest(interaction, branch)).toEqual(Option.some(second))
    }).pipe(Effect.provide(storageLive)),
  )

  it.live("an ask outside a tool call is refused and stores nothing", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: callbacksFor(is),
      })
      const branch = { sessionId: SessionId.make("s-owner"), branchId: BranchId.make("b-owner") }
      yield* ensureStorageParents(branch)
      const error = yield* Effect.flip(interaction.present({ text: "Approve?" }, branch))
      expect(error._tag).toBe("InteractionOwnerMissingError")
      expect(yield* is.listOpen(branch)).toEqual([])
    }).pipe(Effect.provide(storageLive)),
  )

  it.live("a call whose kept answer no longer fits asks again in its own queued place", () =>
    Effect.gen(function* () {
      const storage = callbacksFor(yield* InteractionStorage)
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage,
      })
      const branch = { sessionId: SessionId.make("s-own"), branchId: BranchId.make("b-own") }
      yield* ensureStorageParents(branch)
      const a = ToolCallId.make("call-a")
      const b = ToolCallId.make("call-b")
      const step = interaction.beginStep(branch, [a, b])
      const runA = (first: string, between: Effect.Effect<void> = Effect.void) =>
        interaction.ownCall(
          branch,
          a,
        )(
          Effect.gen(function* () {
            yield* interaction.present({ text: first }, branch)
            yield* between
            return yield* interaction.present({ text: "A2" }, branch)
          }),
        )
      const runB = interaction.ownCall(branch, b)(interaction.present({ text: "B1" }, branch))
      // Run 1: A asks its first question and parks.
      yield* step
      const x = yield* pendingId(yield* runA("A1").pipe(Effect.exit))
      yield* interaction.storeResolution(branch, x, { approved: true })
      // Run 2: A takes and keeps its first answer; B asks next; A then
      // queues its second ask behind B's question.
      yield* step
      const gate = yield* Deferred.make<void>()
      const secondRun = yield* runA("A1", Deferred.await(gate)).pipe(Effect.exit, Effect.forkChild)
      const y = yield* pendingId(yield* runB.pipe(Effect.exit))
      yield* Deferred.completeWith(gate, Effect.void)
      expect(yield* pendingId(yield* Fiber.join(secondRun))).toBe(y)
      yield* interaction.storeResolution(branch, y, { approved: true })
      // Run 3: B takes its answer. A's first question changed, so its kept
      // answer goes; the queued place it meets is its own, not another call's.
      yield* step
      expect(Exit.isSuccess(yield* runB.pipe(Effect.exit))).toBe(true)
      const third = yield* runA("A1 changed").pipe(Effect.exit, Effect.timeoutOption("2 seconds"))
      expect(Option.isSome(third)).toBe(true)
      if (Option.isNone(third)) return
      const z = yield* pendingId(third.value)
      expect(yield* shownRequest(interaction, branch)).toEqual(Option.some(z))
    }).pipe(Effect.provide(storageLive)),
  )

  it.live("a request left open by an ended turn is settled when a new step asks", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const branch = { sessionId: SessionId.make("s-stale"), branchId: BranchId.make("b-stale") }
      yield* ensureStorageParents(branch)
      const before = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: callbacksFor(is),
      })
      const stale = yield* pendingId(
        yield* asCall(
          before,
          branch,
          "old-call",
        )(before.present({ text: "Old?" }, branch)).pipe(Effect.exit),
      )
      // The process stops before the turn settles its request.
      const dismissed: InteractionRequestId[] = []
      const after = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: (requestId) => Effect.sync(() => dismissed.push(requestId)),
        storage: callbacksFor(is),
      })
      for (const record of yield* is.listOpen(branch)) yield* after.rehydrate(record)
      const fresh = yield* pendingId(
        yield* asCall(
          after,
          branch,
          "new-call",
        )(after.present({ text: "New?" }, branch)).pipe(Effect.exit),
      )
      expect(fresh).not.toBe(stale)
      expect(dismissed).toEqual([stale])
      expect((yield* is.listOpen(branch)).map((record) => record.requestId)).toEqual([fresh])
    }).pipe(Effect.provide(storageLive)),
  )

  it.live("every answer to a request that closed without one is refused", () =>
    Effect.gen(function* () {
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: callbacksFor(yield* InteractionStorage),
      })
      const branch = { sessionId: SessionId.make("s-late"), branchId: BranchId.make("b-late") }
      yield* ensureStorageParents(branch)
      const closed = yield* pendingId(
        yield* asCall(
          interaction,
          branch,
        )(interaction.present({ text: "Go?" }, branch)).pipe(Effect.exit),
      )
      yield* interaction.endTurn(branch)
      // Neither reply is the first answer: nothing would take it.
      const yes = yield* Effect.flip(
        interaction.storeResolution(branch, closed, { approved: true }),
      )
      const no = yield* Effect.flip(
        interaction.storeResolution(branch, closed, { approved: false }),
      )
      expect(yes._tag).toBe("InteractionRequestMismatchError")
      expect(no._tag).toBe("InteractionRequestMismatchError")
      expect(yield* interaction.answered(closed)).toBe(false)
    }).pipe(Effect.provide(storageLive)),
  )

  it.live("a retried reply after its call took the answer succeeds and changes nothing", () =>
    Effect.gen(function* () {
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: () => Effect.void,
        storage: callbacksFor(yield* InteractionStorage),
      })
      const branch = { sessionId: SessionId.make("s-retry"), branchId: BranchId.make("b-retry") }
      yield* ensureStorageParents(branch)
      const run = asCall(interaction, branch)
      const requestId = yield* pendingId(
        yield* run(interaction.present({ text: "Go?" }, branch)).pipe(Effect.exit),
      )
      expect(yield* interaction.storeResolution(branch, requestId, { approved: true })).toBe(true)
      // The step runs again and its call takes the answer: the branch shows no request.
      expect((yield* run(interaction.present({ text: "Go?" }, branch))).approved).toBe(true)
      expect(yield* shownRequest(interaction, branch)).toEqual(Option.none())
      expect(yield* interaction.storeResolution(branch, requestId, { approved: true })).toBe(false)
      const changed = yield* Effect.flip(
        interaction.storeResolution(branch, requestId, { approved: false }),
      )
      expect(changed._tag).toBe("InteractionDecisionConflictError")
      // Another branch cannot answer it.
      const other = { ...branch, branchId: BranchId.make("b-retry-other") }
      const fresh = yield* pendingId(
        yield* run(interaction.present({ text: "Again?" }, branch)).pipe(Effect.exit),
      )
      const misaddressed = yield* Effect.flip(
        interaction.storeResolution(other, fresh, { approved: true }),
      )
      expect(misaddressed._tag).toBe("InteractionRequestMismatchError")
      expect(yield* interaction.answered(fresh)).toBe(false)
      // Nor did it store an answer: the branch's own reply is the first.
      expect(yield* interaction.storeResolution(branch, fresh, { approved: false })).toBe(true)
      // Answered and not yet taken, it is still refused elsewhere, and the
      // refusal does not read out its answer as a retry.
      const answeredElsewhere = yield* Effect.flip(
        interaction.storeResolution(other, fresh, { approved: false }),
      )
      expect(answeredElsewhere._tag).toBe("InteractionRequestMismatchError")
    }).pipe(Effect.provide(storageLive)),
  )

  it.live("ending the turn settles its open request and closes the dialog", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const dismissed: InteractionRequestId[] = []
      const interaction = yield* makeInteractionService({
        onPresent: () => Effect.void,
        onDismiss: (requestId) => Effect.sync(() => dismissed.push(requestId)),
        storage: callbacksFor(is),
      })
      const branch = { sessionId: SessionId.make("s-end"), branchId: BranchId.make("b-end") }
      yield* ensureStorageParents(branch)
      const open = yield* pendingId(
        yield* asCall(
          interaction,
          branch,
        )(interaction.present({ text: "Go?" }, branch)).pipe(Effect.exit),
      )
      yield* interaction.endTurn(branch)
      expect(dismissed).toEqual([open])
      expect(yield* shownRequest(interaction, branch)).toEqual(Option.none())
      expect(yield* is.listOpen(branch)).toEqual([])
    }).pipe(Effect.provide(storageLive)),
  )

  /**
   * An ask by an inner call of a dispatching tool on `branch`, stored in
   * `is`; `taken` records what its receipt took.
   */
  const askOwned =
    (
      interaction: InteractionService,
      is: InteractionStorage["Service"],
      branch: { readonly sessionId: SessionId; readonly branchId: BranchId },
      taken: Array<InteractionRequestId>,
      resumeRequestId: Option.Option<InteractionRequestId> = Option.none(),
    ) =>
    (text: string) =>
      interaction.present({ text }, branch).pipe(
        Effect.provideService(CurrentInteractionOwner, {
          ...branch,
          persist: (record) => persistInteraction(is, record),
          resumeRequestId: Effect.succeed(resumeRequestId),
          take: (requestId) => Effect.sync(() => void taken.push(requestId)),
        }),
      )

  it.live("a dispatching owner's inner calls wait for their answers in place, one at a time", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const presented = yield* Queue.unbounded<InteractionRequestId>()
      const interaction = yield* makeInteractionService({
        onPresent: (requestId) => Queue.offer(presented, requestId),
        onDismiss: () => Effect.void,
        storage: callbacksFor(is),
      })
      const branch = { sessionId: SessionId.make("s-inner"), branchId: BranchId.make("b-inner") }
      yield* ensureStorageParents(branch)
      const taken: Array<InteractionRequestId> = []
      const inner = askOwned(interaction, is, branch, taken)
      const both = yield* asCall(
        interaction,
        branch,
      )(Effect.all([inner("First?"), inner("Second?")], { concurrency: 2 })).pipe(Effect.forkChild)
      const first = yield* Queue.take(presented)
      // The second inner call waits for the slot; it does not refuse or park.
      expect(yield* shownRequest(interaction, branch)).toEqual(Option.some(first))
      yield* interaction.storeResolution(branch, first, { approved: true, notes: "one" })
      const second = yield* Queue.take(presented)
      expect(second).not.toBe(first)
      yield* interaction.storeResolution(branch, second, { approved: false, notes: "two" })
      const answers = yield* Fiber.join(both).pipe(Effect.timeout("2 seconds"))
      expect(answers.map((answer) => answer.notes)).toEqual(["one", "two"])
      expect(taken).toEqual([first, second])
      expect(yield* is.listOpen(branch)).toEqual([])
    }).pipe(Effect.provide(storageLive)),
  )

  it.live(
    "an inner call waiting in place gets the first answer; a different later one is refused",
    () =>
      Effect.gen(function* () {
        const is = yield* InteractionStorage
        const presented = yield* Queue.unbounded<InteractionRequestId>()
        const interaction = yield* makeInteractionService({
          onPresent: (requestId) => Queue.offer(presented, requestId),
          onDismiss: () => Effect.void,
          storage: callbacksFor(is),
        })
        const branch = {
          sessionId: SessionId.make("s-in-place"),
          branchId: BranchId.make("b-in-place"),
        }
        yield* ensureStorageParents(branch)
        const taken: Array<InteractionRequestId> = []
        const waiting = yield* asCall(
          interaction,
          branch,
        )(askOwned(interaction, is, branch, taken)("Delete it?")).pipe(Effect.forkChild)
        const requestId = yield* Queue.take(presented)
        yield* interaction.storeResolution(branch, requestId, { approved: false })
        // Whether or not the waiting call took the first answer yet, the second
        // reply cannot change it.
        const conflict = yield* Effect.flip(
          interaction.storeResolution(branch, requestId, { approved: true }),
        )
        expect(conflict._tag).toBe("InteractionDecisionConflictError")
        const answer = yield* Fiber.join(waiting).pipe(Effect.timeout("2 seconds"))
        expect(answer.approved).toBe(false)
        expect(taken).toEqual([requestId])
      }).pipe(Effect.provide(storageLive)),
  )

  it.live("a dispatching owner does not take an answer to a changed question", () =>
    Effect.gen(function* () {
      const is = yield* InteractionStorage
      const presented = yield* Queue.unbounded<InteractionRequestId>()
      const interaction = yield* makeInteractionService({
        onPresent: (requestId) => Queue.offer(presented, requestId),
        onDismiss: () => Effect.void,
        storage: callbacksFor(is),
      })
      const branch = { sessionId: SessionId.make("s-owned"), branchId: BranchId.make("b-owned") }
      yield* ensureStorageParents(branch)
      const taken: Array<InteractionRequestId> = []
      const ask = (text: string, resume: Option.Option<InteractionRequestId>) =>
        asCall(
          interaction,
          branch,
        )(askOwned(interaction, is, branch, taken, resume)(text)).pipe(Effect.forkChild)
      // The owner stops while its call waits, as a crash would stop it.
      const stopped = yield* ask("Delete a.txt?", Option.none())
      const first = yield* Queue.take(presented)
      yield* Fiber.interrupt(stopped)
      yield* interaction.storeResolution(branch, first, { approved: true })
      const resumed = yield* ask("Delete b.txt?", Option.some(first))
      const second = yield* Queue.take(presented)
      expect(second).not.toBe(first)
      expect(yield* shownRequest(interaction, branch)).toEqual(Option.some(second))
      yield* interaction.storeResolution(branch, second, { approved: true, notes: "b" })
      expect((yield* Fiber.join(resumed).pipe(Effect.timeout("2 seconds"))).notes).toBe("b")
      expect(taken).toEqual([second])
    }).pipe(Effect.provide(storageLive)),
  )
})
