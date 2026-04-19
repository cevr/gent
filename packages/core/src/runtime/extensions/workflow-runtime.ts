import { Context, Effect, Exit, Layer, Scope } from "effect"
import type { AgentEvent } from "../../domain/event.js"
import type {
  ExtensionActorStatusInfo,
  ExtensionReduceContext,
  LoadedExtension,
} from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtensionProtocolError,
  ExtractExtensionReply,
} from "../../domain/extension-protocol.js"
import { makeMachineEngine } from "./resource-host/machine-engine.js"
import { ExtensionTurnControl } from "./turn-control.js"

export interface WorkflowRuntimeService {
  /**
   * Publish an event to all workflow actors for the session.
   *
   * Returns the list of extensionIds whose machine actually transitioned.
   * EventPublisher uses this to emit `ExtensionStateChanged` pulses ONLY
   * for extensions with real news — not blanket per-event broadcasts.
   */
  readonly publish: (
    event: AgentEvent,
    ctx: ExtensionReduceContext,
  ) => Effect.Effect<ReadonlyArray<string>>
  readonly send: (
    sessionId: SessionId,
    message: AnyExtensionCommandMessage,
    branchId?: BranchId,
  ) => Effect.Effect<void, ExtensionProtocolError>
  readonly ask: <M extends AnyExtensionRequestMessage>(
    sessionId: SessionId,
    message: M,
    branchId?: BranchId,
  ) => Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError>
  readonly getActorStatuses: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<ExtensionActorStatusInfo>>
  readonly terminateAll: (sessionId: SessionId) => Effect.Effect<void>
}

export class WorkflowRuntime extends Context.Service<WorkflowRuntime, WorkflowRuntimeService>()(
  "@gent/core/src/runtime/extensions/workflow-runtime/WorkflowRuntime",
) {
  static fromExtensions = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<WorkflowRuntime, never, ExtensionTurnControl> =>
    Layer.effect(
      WorkflowRuntime,
      Effect.acquireRelease(makeMachineEngine(extensions), ({ runtimeScope }) =>
        Scope.close(runtimeScope, Exit.void),
      ).pipe(Effect.map(({ service }) => service)),
    )

  static Live = (
    extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<WorkflowRuntime, never, ExtensionTurnControl> =>
    WorkflowRuntime.fromExtensions(extensions)

  static Test = (): Layer.Layer<WorkflowRuntime> =>
    WorkflowRuntime.fromExtensions([]).pipe(Layer.provide(ExtensionTurnControl.Test()))
}
