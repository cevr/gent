/**
 * EventStorage — focused service for agent event persistence + queries.
 *
 * Split from the `Storage` god-interface ().
 */

import type { Effect } from "effect"
import { Context, Layer } from "effect"
import type { AgentEvent, EventEnvelope } from "../domain/event.js"
import type { SessionId, BranchId } from "../domain/ids.js"
import type { StorageError } from "./sqlite-storage.js"

export interface EventStorageService {
  readonly appendEvent: (
    event: AgentEvent,
    options?: { traceId?: string },
  ) => Effect.Effect<EventEnvelope, StorageError>
  readonly listEvents: (params: {
    sessionId: SessionId
    branchId?: BranchId
    afterId?: number
  }) => Effect.Effect<ReadonlyArray<EventEnvelope>, StorageError>
  readonly getLatestEventId: (params: {
    sessionId: SessionId
    branchId?: BranchId
  }) => Effect.Effect<number | undefined, StorageError>
  readonly getLatestEventTag: (params: {
    sessionId: SessionId
    branchId: BranchId
    tags: ReadonlyArray<string>
  }) => Effect.Effect<string | undefined, StorageError>
  readonly getLatestEvent: (params: {
    sessionId: SessionId
    branchId: BranchId
    tags: ReadonlyArray<string>
  }) => Effect.Effect<AgentEvent | undefined, StorageError>
}

export class EventStorage extends Context.Service<EventStorage, EventStorageService>()(
  "@gent/core/src/storage/event-storage/EventStorage",
) {
  static fromStorage = (s: EventStorageService): Layer.Layer<EventStorage> =>
    Layer.succeed(EventStorage, s)
}
