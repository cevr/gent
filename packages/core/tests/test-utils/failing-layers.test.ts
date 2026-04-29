import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Stream, type Exit } from "effect"
import { EventStore, EventStoreError, SessionStarted } from "@gent/core/domain/event"
import { BranchId, InteractionRequestId, SessionId } from "@gent/core/domain/ids"
import {
  FailingCheckpointStorage,
  FailingEventStore,
  FailingInteractionStorage,
  FailingStorage,
} from "@gent/core/test-utils"
import { ActorPersistenceStorage } from "@gent/core/storage/actor-persistence-storage"
import { CheckpointStorage } from "@gent/core/storage/checkpoint-storage"
import { InteractionStorage } from "@gent/core/storage/interaction-storage"
import { Storage, StorageError } from "@gent/core/storage/sqlite-storage"
import type { AgentLoopCheckpointRecord } from "../../src/runtime/agent/agent-loop.checkpoint"

const sessionId = SessionId.make("session-failing-layers")
const branchId = BranchId.make("branch-failing-layers")

const checkpointRecord: AgentLoopCheckpointRecord = {
  sessionId,
  branchId,
  version: 1,
  stateTag: "Idle",
  stateJson: JSON.stringify({ state: { _tag: "Idle" }, queue: { queued: [] } }),
  updatedAt: 1,
}

const expectError = (
  exit: Exit.Exit<unknown, unknown>,
  errorClass: new (...args: never[]) => Error,
  message: string,
) => {
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") {
    const error = Cause.findErrorOption(exit.cause)
    expect(Option.isSome(error)).toBe(true)
    if (Option.isSome(error)) {
      expect(error.value).toBeInstanceOf(errorClass)
      if (error.value instanceof Error) {
        expect(error.value.message).toBe(message)
      }
    }
  }
}

describe("failing test layers", () => {
  it.live("storage faults selected operations across focused tags and preserves others", () =>
    Effect.gen(function* () {
      const actorStorage = yield* ActorPersistenceStorage

      const failed = yield* Effect.exit(
        actorStorage.saveActorState({
          profileId: "profile-a",
          persistenceKey: "state-a",
          stateJson: "{}",
        }),
      )
      expectError(failed, StorageError, "storage boom")

      const missing = yield* actorStorage.loadActorState({
        profileId: "profile-a",
        persistenceKey: "state-a",
      })
      expect(missing).toBeUndefined()
    }).pipe(
      Effect.provide(
        Layer.provide(
          FailingStorage({ operations: ["saveActorState"], message: "storage boom" }),
          Storage.Test(),
        ),
      ),
    ),
  )

  it.live("event store faults selected operations and preserves others", () =>
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const event = SessionStarted.make({ sessionId, branchId })

      const failed = yield* Effect.exit(eventStore.append(event))
      expectError(failed, EventStoreError, "event boom")

      yield* eventStore.publish(event)
      const events = yield* eventStore
        .subscribe({ sessionId })
        .pipe(Stream.take(1), Stream.runCollect)
      expect(events.length).toBe(1)
    }).pipe(
      Effect.provide(
        Layer.provide(
          FailingEventStore({ operations: ["append"], message: "event boom" }),
          EventStore.Memory,
        ),
      ),
    ),
  )

  it.live("checkpoint storage faults selected operations and preserves others", () =>
    Effect.gen(function* () {
      const checkpoints = yield* CheckpointStorage

      const failed = yield* Effect.exit(checkpoints.upsert(checkpointRecord))
      expectError(failed, StorageError, "checkpoint boom")

      const listed = yield* checkpoints.list()
      expect(listed).toEqual([])
    }).pipe(
      Effect.provide(
        Layer.provide(
          FailingCheckpointStorage({ operations: ["upsert"], message: "checkpoint boom" }),
          Storage.TestWithSql(),
        ),
      ),
    ),
  )

  it.live("interaction storage faults selected operations and preserves others", () =>
    Effect.gen(function* () {
      const interactions = yield* InteractionStorage
      const requestId = InteractionRequestId.make("interaction-failing-layers")

      const failed = yield* Effect.exit(
        interactions.persist({
          requestId,
          type: "approval",
          sessionId,
          branchId,
          paramsJson: "{}",
          status: "pending",
          createdAt: 1,
        }),
      )
      expectError(failed, StorageError, "interaction boom")

      const pending = yield* interactions.listPending({ sessionId, branchId })
      expect(pending).toEqual([])
    }).pipe(
      Effect.provide(
        Layer.provide(
          FailingInteractionStorage({ operations: ["persist"], message: "interaction boom" }),
          Storage.TestWithSql(),
        ),
      ),
    ),
  )
})
