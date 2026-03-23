import { Effect, Layer, ServiceMap } from "effect"
import type { BranchId, SessionId } from "../domain/ids.js"
import type { QueueSnapshot } from "../domain/queue.js"
import type { SteerCommand } from "../runtime/agent/agent-loop.js"
import { GentCore, type GentCoreError } from "./core.js"
import type {
  CreateBranchInput,
  CreateBranchOutput,
  CreateSessionInput,
  CreateSessionResult,
  ForkBranchInput,
  SendMessageInput,
  SwitchBranchInput,
  UpdateSessionBypassInput,
  UpdateSessionBypassResult,
  UpdateSessionReasoningLevelInput,
  UpdateSessionReasoningLevelResult,
} from "./transport-contract.js"

export interface SessionCommandsService {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<CreateSessionResult, GentCoreError>
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, GentCoreError>
  readonly createBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<CreateBranchOutput, GentCoreError>
  readonly switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, GentCoreError>
  readonly forkBranch: (input: ForkBranchInput) => Effect.Effect<CreateBranchOutput, GentCoreError>
  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<void, GentCoreError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void, GentCoreError>
  readonly drainQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, GentCoreError>
  readonly updateSessionBypass: (
    input: UpdateSessionBypassInput,
  ) => Effect.Effect<UpdateSessionBypassResult, GentCoreError>
  readonly updateSessionReasoningLevel: (
    input: UpdateSessionReasoningLevelInput,
  ) => Effect.Effect<UpdateSessionReasoningLevelResult, GentCoreError>
}

export class SessionCommands extends ServiceMap.Service<SessionCommands, SessionCommandsService>()(
  "@gent/core/src/server/session-commands/SessionCommands",
) {
  static Live = Layer.effect(
    SessionCommands,
    Effect.gen(function* () {
      const core = yield* GentCore
      return {
        createSession: core.createSession,
        deleteSession: core.deleteSession,
        createBranch: core.createBranch,
        switchBranch: core.switchBranch,
        forkBranch: core.forkBranch,
        sendMessage: core.sendMessage,
        steer: core.steer,
        drainQueuedMessages: core.drainQueuedMessages,
        updateSessionBypass: core.updateSessionBypass,
        updateSessionReasoningLevel: core.updateSessionReasoningLevel,
      } satisfies SessionCommandsService
    }),
  )
}
