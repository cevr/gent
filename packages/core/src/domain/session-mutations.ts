import { Context, type Effect } from "effect"
import type { EventStoreError } from "./event.js"
import type { BranchId, MessageId, SessionId } from "./ids.js"
import type { StorageError } from "../storage/sqlite-storage.js"

export type SessionMutationError = StorageError | EventStoreError

export interface SessionMutationsService {
  readonly renameSession: (input: {
    readonly sessionId: SessionId
    readonly name: string
  }) => Effect.Effect<{ renamed: boolean; name?: string }, SessionMutationError>
  readonly createSessionBranch: (input: {
    readonly sessionId: SessionId
    readonly parentBranchId?: BranchId
    readonly name?: string
  }) => Effect.Effect<{ branchId: BranchId }, SessionMutationError>
  readonly forkSessionBranch: (input: {
    readonly sessionId: SessionId
    readonly fromBranchId: BranchId
    readonly atMessageId: MessageId
    readonly name?: string
  }) => Effect.Effect<{ branchId: BranchId }, SessionMutationError>
  readonly switchActiveBranch: (input: {
    readonly sessionId: SessionId
    readonly fromBranchId: BranchId
    readonly toBranchId: BranchId
  }) => Effect.Effect<void, SessionMutationError>
  readonly createChildSession: (input: {
    readonly parentSessionId: SessionId
    readonly parentBranchId: BranchId
    readonly name?: string
    readonly cwd?: string
  }) => Effect.Effect<{ sessionId: SessionId; branchId: BranchId }, SessionMutationError>
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, SessionMutationError>
  readonly deleteBranch: (input: {
    readonly sessionId: SessionId
    readonly currentBranchId: BranchId
    readonly branchId: BranchId
  }) => Effect.Effect<void, StorageError>
  readonly deleteMessages: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly afterMessageId?: MessageId
  }) => Effect.Effect<void, StorageError>
}

export class SessionMutations extends Context.Service<SessionMutations, SessionMutationsService>()(
  "@gent/core/src/domain/session-mutations/SessionMutations",
) {}
