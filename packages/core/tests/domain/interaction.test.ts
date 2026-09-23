import { describe, expect, it } from "effect-bun-test"
import { Cause, Clock, Effect, Exit, Layer, Option, Schema } from "effect"
import {
  InteractionStorage,
  type InteractionStorageService,
  SqliteStorage,
} from "../../src/storage/storage"
import { ensureStorageParents } from "../../src/test-utils/harness"
import { EventStoreError } from "../../src/domain/event"
import {
  InteractionPendingError,
  type InteractionRequestRecord,
  type InteractionService,
  type InteractionStorageConfig,
  makeInteractionService,
} from "../../src/domain/interaction"
import { BranchId, InteractionRequestId, SessionId, ToolCallId } from "../../src/domain/ids"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { CurrentWorkspaceId } from "../../src/server/workspace-rpc"

// ── interaction-request.test ────────────────────────────────────────────────

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
  requestId: InteractionRequestId,
  decisionJson: string,
) =>
  is.decide(requestId, decisionJson).pipe(
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

// ============================================================================
// Interaction Request — cold interaction mechanics
// ============================================================================
describe("Interaction Request", () => {
  const storageLive = Layer.mergeAll(
    SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(GentPlatform.Test())),
    GentPlatform.Test(),
  )
  const callbacksFor = (is: InteractionStorage["Service"]): InteractionStorageConfig => ({
    persist: (record) => persistInteraction(is, record),
    decide: (requestId, decisionJson) => decideInteraction(is, requestId, decisionJson),
    resolve: (requestId) => is.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
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
      const pending = yield* is.listPending()
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
      const before = yield* is.listPending()
      expect(before.some((r) => r.requestId === InteractionRequestId.make("req-manual-1"))).toBe(
        true,
      )
      // Resolve it
      yield* is.resolve(InteractionRequestId.make("req-manual-1"))
      // Verify it's no longer pending
      const after = yield* is.listPending()
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
        .listPending()
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
      const pendingB = yield* is
        .listPending()
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))

      expect(pendingA.map((record) => record.requestId)).toEqual([first.requestId])
      expect(pendingB.map((record) => record.requestId)).toEqual([second.requestId])

      yield* is
        .resolve(second.requestId)
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
      const stillPendingB = yield* is
        .listPending()
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))
      expect(stillPendingB.map((record) => record.requestId)).toEqual([second.requestId])

      yield* is
        .resolve(second.requestId)
        .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))
      const resolvedB = yield* is
        .listPending()
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
      const pending = yield* is.listPending({ sessionId, branchId })
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
      const [ownedRow] = yield* is.listPending(owned)
      const [legacyRow] = yield* is.listPending(legacy)
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
      expect(yield* interaction.pendingRequestId({ sessionId, branchId })).toBeUndefined()
      const pending = yield* is.listPending({ sessionId, branchId })
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
      yield* interaction.storeResolution(error.requestId, { approved: true })
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
      yield* interaction.storeResolution(requestId, { approved: true, notes: "yes" })
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
      const pending = yield* is.listPending()
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
      yield* service2.storeResolution(requestId, { approved: true, notes: "ship it" })
      // Tool re-calls present() — should find the stored resolution
      const result = yield* asCall(service2, { sessionId, branchId })(
        service2.present({ text: "Approve deployment?" }, { sessionId, branchId }),
      )
      expect(result.approved).toBe(true)
      expect(result.notes).toBe("ship it")
      // Verify resolved in storage
      const afterResolve = yield* is.listPending()
      expect(afterResolve.some((r) => r.requestId === requestId)).toBe(false)
    }).pipe(Effect.provide(storageLive)),
  )

  const pendingId = (exit: Exit.Exit<unknown, unknown>) => {
    if (Exit.isSuccess(exit)) return Effect.die(new Error("expected the call to park"))
    const error = Cause.squash(exit.cause)
    if (!Schema.is(InteractionPendingError)(error)) return Effect.die(error)
    return Effect.succeed(error.requestId)
  }

  it.live("a call that asks two questions takes both answers on its third run", () =>
    Effect.gen(function* () {
      const storage = callbacksFor(yield* InteractionStorage)
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
      yield* interaction.storeResolution(first, { approved: true, notes: "one" })
      const second = yield* pendingId(yield* run)
      yield* interaction.storeResolution(second, { approved: true, notes: "two" })
      const third = yield* run.pipe(Effect.timeoutOption("2 seconds"))
      expect(Option.map(third, (exit) => Exit.isSuccess(exit) && exit.value)).toEqual(
        Option.some("one/two"),
      )
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
      yield* interaction.storeResolution(first, { approved: true })
      const second = yield* pendingId(yield* ask("Delete b.txt?"))
      expect(second).not.toBe(first)
      expect(yield* interaction.pendingRequestId(branch)).toBe(second)
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
      expect(yield* is.listPending(branch)).toEqual([])
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
      expect(yield* interaction.pendingRequestId(branch)).toBeUndefined()
      expect(yield* is.listPending(branch)).toEqual([])
    }).pipe(Effect.provide(storageLive)),
  )
})
