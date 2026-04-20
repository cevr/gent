/**
 * BranchStorage — focused service for branch CRUD + message counting.
 *
 * Split from the `Storage` god-interface (B11.7).
 */

import type { Effect } from "effect"
import { Context, Layer } from "effect"
import type { Branch } from "../domain/message.js"
import type { SessionId, BranchId } from "../domain/ids.js"
import type { StorageError } from "./sqlite-storage.js"

export interface BranchStorageService {
  readonly createBranch: (branch: Branch) => Effect.Effect<Branch, StorageError>
  readonly getBranch: (id: BranchId) => Effect.Effect<Branch | undefined, StorageError>
  readonly listBranches: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Branch>, StorageError>
  readonly deleteBranch: (id: BranchId) => Effect.Effect<void, StorageError>
  readonly updateBranchSummary: (
    branchId: BranchId,
    summary: string,
  ) => Effect.Effect<void, StorageError>
  readonly countMessages: (branchId: BranchId) => Effect.Effect<number, StorageError>
  readonly countMessagesByBranches: (
    branchIds: readonly BranchId[],
  ) => Effect.Effect<ReadonlyMap<BranchId, number>, StorageError>
}

export class BranchStorage extends Context.Service<BranchStorage, BranchStorageService>()(
  "@gent/core/src/storage/branch-storage/BranchStorage",
) {
  static fromStorage = (s: BranchStorageService): Layer.Layer<BranchStorage> =>
    Layer.succeed(BranchStorage, s)
}
