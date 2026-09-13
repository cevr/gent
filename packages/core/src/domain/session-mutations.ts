import { Context, type Effect } from "effect"
import type { ReasoningEffort } from "./agent.js"
import type { EventStoreError } from "./event.js"
import type { BranchId, SessionId } from "./ids.js"
import type { InvalidStateError, NotFoundError } from "./business-errors.js"
import type { StorageError } from "./storage-error.js"
import type { SessionRuntimeError } from "../runtime/session-runtime.js"
import type {
  CreateBranchInput,
  CreateSessionInput,
  ForkBranchInput,
  SwitchBranchInput,
} from "../server/transport-contract.js"

type SessionMutationError = StorageError | EventStoreError | InvalidStateError | NotFoundError

export interface SessionMutationsService {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<
    { sessionId: SessionId; branchId: BranchId; name: string },
    SessionMutationError | SessionRuntimeError
  >
  readonly renameSession: (input: {
    readonly sessionId: SessionId
    readonly name: string
  }) => Effect.Effect<{ renamed: boolean; name?: string }, SessionMutationError>
  readonly createSessionBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<{ branchId: BranchId }, SessionMutationError>
  readonly forkSessionBranch: (
    input: ForkBranchInput,
  ) => Effect.Effect<{ branchId: BranchId }, SessionMutationError>
  readonly switchActiveBranch: (
    input: SwitchBranchInput,
  ) => Effect.Effect<void, SessionMutationError>
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, SessionMutationError>
  readonly updateReasoningLevel: (input: {
    readonly sessionId: SessionId
    // oxlint-disable-next-line effect/noNullish -- RPC-facing mutation input preserves an omitted reasoning level.
    readonly reasoningLevel: ReasoningEffort | undefined
  }) => Effect.Effect<
    {
      // oxlint-disable-next-line effect/noNullish -- RPC-facing mutation output preserves an omitted reasoning level.
      reasoningLevel: ReasoningEffort | undefined
    },
    SessionMutationError
  >
}

export class SessionMutations extends Context.Service<SessionMutations, SessionMutationsService>()(
  "@gent/core/src/domain/session-mutations/SessionMutations",
) {}
