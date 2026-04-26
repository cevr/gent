import { Context, Effect, Layer } from "effect"
import type { PlatformError } from "effect"
import type { SessionId, BranchId } from "./ids"
import type { EventStoreError } from "./event"
import type { InteractionPendingError } from "./interaction-request"

// PromptPresenter — reusable presentation service for delegate tools
// Extracts review/confirm/present from PromptTool so tools can present
// without tool-calls-tool.
//
// The Tag + interface live here in domain. The Live layer is in
// `runtime/prompt-presenter-live.ts` because it depends on runtime
// services (ApprovalService, RuntimePlatform).

export interface PromptPresenterService {
  readonly present: (params: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    title?: string
  }) => Effect.Effect<void, EventStoreError | InteractionPendingError>

  readonly confirm: (params: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    title?: string
  }) => Effect.Effect<"yes" | "no", EventStoreError | InteractionPendingError>

  readonly review: (params: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    title?: string
    fileNameSeed: string
  }) => Effect.Effect<
    { decision: "yes" | "no" | "edit"; path: string; content?: string },
    EventStoreError | PlatformError.PlatformError | InteractionPendingError
  >
}

export class PromptPresenter extends Context.Service<PromptPresenter, PromptPresenterService>()(
  "@gent/core/src/domain/prompt-presenter/PromptPresenter",
) {
  static Test = (
    confirmDecisions: ReadonlyArray<"yes" | "no"> = ["yes"],
    reviewDecisions: ReadonlyArray<"yes" | "no" | "edit"> = ["yes"],
  ): Layer.Layer<PromptPresenter> => {
    let confirmIdx = 0
    let reviewIdx = 0
    return Layer.succeed(PromptPresenter, {
      present: () => Effect.void,
      confirm: () => Effect.succeed(confirmDecisions[confirmIdx++] ?? "yes"),
      review: () =>
        Effect.succeed({
          decision: reviewDecisions[reviewIdx++] ?? "yes",
          path: "/tmp/test-prompt.md",
        }),
    })
  }
}
