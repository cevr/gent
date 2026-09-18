import { Context, type Effect } from "effect"
import type { SessionDepthLimitError } from "./agent.js"
import type { EventStoreError } from "./event.js"
import type { BranchId, SessionId } from "./ids.js"
import type { InvalidStateError, NotFoundError, StorageError } from "./errors.js"
import type { SessionRuntimeError } from "../runtime/session-runtime.js"
import type {
  CreateBranchInput,
  CreateSessionInput,
  ForkBranchInput,
  SessionSettings,
  SwitchBranchInput,
  UpdateSessionSettingsInput,
} from "../server/transport-contract.js"

type SessionMutationError =
  | StorageError
  | EventStoreError
  | InvalidStateError
  | NotFoundError
  | SessionDepthLimitError

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
  /** Replace the session's settings; the reply is what was stored. */
  readonly updateSettings: (
    input: UpdateSessionSettingsInput,
  ) => Effect.Effect<SessionSettings, SessionMutationError>
}

export class SessionMutations extends Context.Service<SessionMutations, SessionMutationsService>()(
  "@gent/core/src/domain/session-mutations/SessionMutations",
) {}
