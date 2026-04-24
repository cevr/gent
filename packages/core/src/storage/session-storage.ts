/**
 * SessionStorage — focused service for session CRUD.
 *
 * Split from the `Storage` god-interface (B11.7). Each consumer yields
 * only the narrow Tag it needs; the full SQLite implementation provides
 * all sub-Tags through `Storage.LiveWithSql` / `Storage.MemoryWithSql`.
 */

import type { Effect } from "effect"
import { Context, Layer } from "effect"
import type { Session } from "../domain/message.js"
import type { SessionId, BranchId } from "../domain/ids.js"
import type { StorageError } from "./sqlite-storage.js"

export interface SessionStorageService {
  readonly createSession: (session: Session) => Effect.Effect<Session, StorageError>
  readonly getSession: (id: SessionId) => Effect.Effect<Session | undefined, StorageError>
  readonly getLastSessionByCwd: (cwd: string) => Effect.Effect<Session | undefined, StorageError>
  readonly listSessions: () => Effect.Effect<ReadonlyArray<Session>, StorageError>
  readonly listFirstBranches: () => Effect.Effect<
    ReadonlyArray<{ sessionId: SessionId; branchId: BranchId | undefined }>,
    StorageError
  >
  readonly updateSession: (session: Session) => Effect.Effect<Session, StorageError>
  /**
   * Deletes the session and every descendant, returning the full set of
   * session ids the cascade actually removed. Callers use the returned set
   * (not a pre-read tree snapshot) to clean in-memory runtime state, so a
   * child created between pre-collect and the durable tx is still cleaned.
   */
  readonly deleteSession: (id: SessionId) => Effect.Effect<ReadonlyArray<SessionId>, StorageError>
}

export class SessionStorage extends Context.Service<SessionStorage, SessionStorageService>()(
  "@gent/core/src/storage/session-storage/SessionStorage",
) {
  static fromStorage = (s: SessionStorageService): Layer.Layer<SessionStorage> =>
    Layer.succeed(SessionStorage, s)
}
