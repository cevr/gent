import { Effect, Layer, Stream } from "effect"
import { EventStore, EventStoreError, type EventStoreService } from "../domain/event.js"
import { StorageError } from "../domain/storage-error.js"
import { CheckpointStorage, type CheckpointStorageService } from "../storage/checkpoint-storage.js"
import {
  InteractionStorage,
  type InteractionStorageService,
} from "../storage/interaction-storage.js"

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
