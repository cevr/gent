/**
 * RelationshipStorage — focused service for session tree / relationship queries.
 *
 * Split from the `Storage` god-interface.
 */

import type { Effect } from "effect"
import { Context, Layer } from "effect"
import type { Session, Branch, Message } from "../domain/message.js"
import type { SessionId } from "../domain/ids.js"
import type { StorageError } from "./sqlite-storage.js"

export interface RelationshipStorageService {
  readonly getChildSessions: (
    parentSessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  readonly getSessionAncestors: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, StorageError>

  /** Returns branches + messages within a single session (not cross-session tree) */
  readonly getSessionDetail: (sessionId: SessionId) => Effect.Effect<
    {
      session: Session
      branches: ReadonlyArray<{
        branch: Branch
        messages: ReadonlyArray<Message>
      }>
    },
    StorageError
  >
}

export class RelationshipStorage extends Context.Service<
  RelationshipStorage,
  RelationshipStorageService
>()("@gent/core/src/storage/relationship-storage/RelationshipStorage") {
  static fromStorage = (s: RelationshipStorageService): Layer.Layer<RelationshipStorage> =>
    Layer.succeed(RelationshipStorage, s)
}
