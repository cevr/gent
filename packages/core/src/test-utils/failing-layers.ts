import { Effect, Layer, Stream } from "effect"
import { EventStore, EventStoreError, type EventStoreService } from "../domain/event.js"
import { StorageError } from "../domain/storage-error.js"
import { ActorPersistenceStorage } from "../storage/actor-persistence-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { CheckpointStorage, type CheckpointStorageService } from "../storage/checkpoint-storage.js"
import { EventStorage } from "../storage/event-storage.js"
import {
  InteractionStorage,
  type InteractionStorageService,
} from "../storage/interaction-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { Storage, type StorageService } from "../storage/sqlite-storage.js"

export type StorageOperation = keyof StorageService
export type EventStoreOperation = keyof EventStoreService
export type CheckpointStorageOperation = keyof CheckpointStorageService
export type InteractionStorageOperation = keyof InteractionStorageService

export interface FailingLayerOptions<Operation extends string> {
  readonly operations: ReadonlySet<Operation> | ReadonlyArray<Operation>
  readonly message?: string
}

const operationSet = <Operation extends string>(
  operations: ReadonlySet<Operation> | ReadonlyArray<Operation>,
): ReadonlySet<Operation> => (operations instanceof Set ? operations : new Set(operations))

const storageFailure = <A>(message: string): Effect.Effect<A, StorageError> =>
  Effect.fail(new StorageError({ message }))

const eventStoreFailure = <A>(message: string): Effect.Effect<A, EventStoreError> =>
  Effect.fail(new EventStoreError({ message }))

const shouldFail =
  <Operation extends string>(operations: ReadonlySet<Operation>) =>
  (operation: Operation): boolean =>
    operations.has(operation)

const storageMessage = (message: string | undefined, operation: StorageOperation): string =>
  message ?? `Injected storage failure: ${operation}`

const checkpointMessage = (
  message: string | undefined,
  operation: CheckpointStorageOperation,
): string => message ?? `Injected checkpoint storage failure: ${operation}`

const interactionMessage = (
  message: string | undefined,
  operation: InteractionStorageOperation,
): string => message ?? `Injected interaction storage failure: ${operation}`

const eventStoreMessage = (message: string | undefined, operation: EventStoreOperation): string =>
  message ?? `Injected event store failure: ${operation}`

const makeFailingStorageService = (
  base: StorageService,
  options: FailingLayerOptions<StorageOperation>,
): StorageService => {
  const fails = shouldFail(operationSet(options.operations))

  return {
    withTransaction: (effect) =>
      fails("withTransaction")
        ? storageFailure(storageMessage(options.message, "withTransaction"))
        : base.withTransaction(effect),
    createSession: (session) =>
      fails("createSession")
        ? storageFailure(storageMessage(options.message, "createSession"))
        : base.createSession(session),
    getSession: (id) =>
      fails("getSession")
        ? storageFailure(storageMessage(options.message, "getSession"))
        : base.getSession(id),
    getLastSessionByCwd: (cwd) =>
      fails("getLastSessionByCwd")
        ? storageFailure(storageMessage(options.message, "getLastSessionByCwd"))
        : base.getLastSessionByCwd(cwd),
    listSessions: () =>
      fails("listSessions")
        ? storageFailure(storageMessage(options.message, "listSessions"))
        : base.listSessions(),
    listFirstBranches: () =>
      fails("listFirstBranches")
        ? storageFailure(storageMessage(options.message, "listFirstBranches"))
        : base.listFirstBranches(),
    updateSession: (session) =>
      fails("updateSession")
        ? storageFailure(storageMessage(options.message, "updateSession"))
        : base.updateSession(session),
    deleteSession: (id) =>
      fails("deleteSession")
        ? storageFailure(storageMessage(options.message, "deleteSession"))
        : base.deleteSession(id),
    createBranch: (branch) =>
      fails("createBranch")
        ? storageFailure(storageMessage(options.message, "createBranch"))
        : base.createBranch(branch),
    getBranch: (id) =>
      fails("getBranch")
        ? storageFailure(storageMessage(options.message, "getBranch"))
        : base.getBranch(id),
    listBranches: (sessionId) =>
      fails("listBranches")
        ? storageFailure(storageMessage(options.message, "listBranches"))
        : base.listBranches(sessionId),
    deleteBranch: (id) =>
      fails("deleteBranch")
        ? storageFailure(storageMessage(options.message, "deleteBranch"))
        : base.deleteBranch(id),
    updateBranchSummary: (branchId, summary) =>
      fails("updateBranchSummary")
        ? storageFailure(storageMessage(options.message, "updateBranchSummary"))
        : base.updateBranchSummary(branchId, summary),
    countMessages: (branchId) =>
      fails("countMessages")
        ? storageFailure(storageMessage(options.message, "countMessages"))
        : base.countMessages(branchId),
    countMessagesByBranches: (branchIds) =>
      fails("countMessagesByBranches")
        ? storageFailure(storageMessage(options.message, "countMessagesByBranches"))
        : base.countMessagesByBranches(branchIds),
    createMessage: (message) =>
      fails("createMessage")
        ? storageFailure(storageMessage(options.message, "createMessage"))
        : base.createMessage(message),
    createMessageIfAbsent: (message) =>
      fails("createMessageIfAbsent")
        ? storageFailure(storageMessage(options.message, "createMessageIfAbsent"))
        : base.createMessageIfAbsent(message),
    getMessage: (id) =>
      fails("getMessage")
        ? storageFailure(storageMessage(options.message, "getMessage"))
        : base.getMessage(id),
    listMessages: (branchId) =>
      fails("listMessages")
        ? storageFailure(storageMessage(options.message, "listMessages"))
        : base.listMessages(branchId),
    deleteMessages: (branchId, afterMessageId) =>
      fails("deleteMessages")
        ? storageFailure(storageMessage(options.message, "deleteMessages"))
        : base.deleteMessages(branchId, afterMessageId),
    updateMessageTurnDuration: (messageId, durationMs) =>
      fails("updateMessageTurnDuration")
        ? storageFailure(storageMessage(options.message, "updateMessageTurnDuration"))
        : base.updateMessageTurnDuration(messageId, durationMs),
    appendEvent: (event, appendOptions) =>
      fails("appendEvent")
        ? storageFailure(storageMessage(options.message, "appendEvent"))
        : base.appendEvent(event, appendOptions),
    listEvents: (params) =>
      fails("listEvents")
        ? storageFailure(storageMessage(options.message, "listEvents"))
        : base.listEvents(params),
    getLatestEventId: (params) =>
      fails("getLatestEventId")
        ? storageFailure(storageMessage(options.message, "getLatestEventId"))
        : base.getLatestEventId(params),
    getLatestEventTag: (params) =>
      fails("getLatestEventTag")
        ? storageFailure(storageMessage(options.message, "getLatestEventTag"))
        : base.getLatestEventTag(params),
    getLatestEvent: (params) =>
      fails("getLatestEvent")
        ? storageFailure(storageMessage(options.message, "getLatestEvent"))
        : base.getLatestEvent(params),
    getChildSessions: (parentSessionId) =>
      fails("getChildSessions")
        ? storageFailure(storageMessage(options.message, "getChildSessions"))
        : base.getChildSessions(parentSessionId),
    getSessionAncestors: (sessionId) =>
      fails("getSessionAncestors")
        ? storageFailure(storageMessage(options.message, "getSessionAncestors"))
        : base.getSessionAncestors(sessionId),
    getSessionDetail: (sessionId) =>
      fails("getSessionDetail")
        ? storageFailure(storageMessage(options.message, "getSessionDetail"))
        : base.getSessionDetail(sessionId),
    saveActorState: (params) =>
      fails("saveActorState")
        ? storageFailure(storageMessage(options.message, "saveActorState"))
        : base.saveActorState(params),
    loadActorState: (params) =>
      fails("loadActorState")
        ? storageFailure(storageMessage(options.message, "loadActorState"))
        : base.loadActorState(params),
    listActorStatesForProfile: (profileId) =>
      fails("listActorStatesForProfile")
        ? storageFailure(storageMessage(options.message, "listActorStatesForProfile"))
        : base.listActorStatesForProfile(profileId),
    deleteActorStatesForProfile: (profileId) =>
      fails("deleteActorStatesForProfile")
        ? storageFailure(storageMessage(options.message, "deleteActorStatesForProfile"))
        : base.deleteActorStatesForProfile(profileId),
  }
}

export const FailingStorage = (
  options: FailingLayerOptions<StorageOperation>,
): Layer.Layer<
  | Storage
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | ActorPersistenceStorage,
  never,
  Storage
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const service = makeFailingStorageService(yield* Storage, options)
      return Layer.mergeAll(
        Layer.succeed(Storage, service),
        SessionStorage.fromStorage(service),
        BranchStorage.fromStorage(service),
        MessageStorage.fromStorage(service),
        EventStorage.fromStorage(service),
        RelationshipStorage.fromStorage(service),
        ActorPersistenceStorage.fromStorage(service),
      )
    }),
  )

export const FailingCheckpointStorage = (
  options: FailingLayerOptions<CheckpointStorageOperation>,
): Layer.Layer<CheckpointStorage, never, CheckpointStorage> =>
  Layer.effect(
    CheckpointStorage,
    Effect.gen(function* () {
      const base = yield* CheckpointStorage
      const fails = shouldFail(operationSet(options.operations))

      const service: CheckpointStorageService = {
        upsert: (record) =>
          fails("upsert")
            ? storageFailure(checkpointMessage(options.message, "upsert"))
            : base.upsert(record),
        get: (input) =>
          fails("get")
            ? storageFailure(checkpointMessage(options.message, "get"))
            : base.get(input),
        list: () =>
          fails("list") ? storageFailure(checkpointMessage(options.message, "list")) : base.list(),
        remove: (input) =>
          fails("remove")
            ? storageFailure(checkpointMessage(options.message, "remove"))
            : base.remove(input),
      }

      return service
    }),
  )

export const FailingInteractionStorage = (
  options: FailingLayerOptions<InteractionStorageOperation>,
): Layer.Layer<InteractionStorage, never, InteractionStorage> =>
  Layer.effect(
    InteractionStorage,
    Effect.gen(function* () {
      const base = yield* InteractionStorage
      const fails = shouldFail(operationSet(options.operations))

      const service: InteractionStorageService = {
        persist: (record) =>
          fails("persist")
            ? storageFailure(interactionMessage(options.message, "persist"))
            : base.persist(record),
        resolve: (requestId) =>
          fails("resolve")
            ? storageFailure(interactionMessage(options.message, "resolve"))
            : base.resolve(requestId),
        listPending: (scope) =>
          fails("listPending")
            ? storageFailure(interactionMessage(options.message, "listPending"))
            : base.listPending(scope),
        deletePending: (sessionId, branchId) =>
          fails("deletePending")
            ? storageFailure(interactionMessage(options.message, "deletePending"))
            : base.deletePending(sessionId, branchId),
      }

      return service
    }),
  )

export const FailingEventStore = (
  options: FailingLayerOptions<EventStoreOperation>,
): Layer.Layer<EventStore, never, EventStore> =>
  Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const base = yield* EventStore
      const fails = shouldFail(operationSet(options.operations))

      const service: EventStoreService = {
        append: (event) =>
          fails("append")
            ? eventStoreFailure(eventStoreMessage(options.message, "append"))
            : base.append(event),
        broadcast: (envelope) =>
          fails("broadcast")
            ? Effect.die(eventStoreMessage(options.message, "broadcast"))
            : base.broadcast(envelope),
        publish: (event) =>
          fails("publish")
            ? eventStoreFailure(eventStoreMessage(options.message, "publish"))
            : base.publish(event),
        subscribe: (params) =>
          fails("subscribe")
            ? Stream.fail(
                new EventStoreError({ message: eventStoreMessage(options.message, "subscribe") }),
              )
            : base.subscribe(params),
        removeSession: (sessionId) =>
          fails("removeSession")
            ? Effect.die(eventStoreMessage(options.message, "removeSession"))
            : base.removeSession(sessionId),
      }

      return service
    }),
  )
