import { Effect, Layer, ServiceMap } from "effect"
import { GentCore, type GentCoreError } from "./core.js"
import type {
  RespondHandoffInput,
  RespondHandoffResult,
  RespondPermissionInput,
  RespondPromptInput,
} from "./transport-contract.js"

export interface InteractionCommandsService {
  readonly respondPermission: (input: RespondPermissionInput) => Effect.Effect<void, GentCoreError>
  readonly respondPrompt: (input: RespondPromptInput) => Effect.Effect<void, GentCoreError>
  readonly respondHandoff: (
    input: RespondHandoffInput,
  ) => Effect.Effect<RespondHandoffResult, GentCoreError>
}

export class InteractionCommands extends ServiceMap.Service<
  InteractionCommands,
  InteractionCommandsService
>()("@gent/core/src/server/interaction-commands/InteractionCommands") {
  static Live = Layer.effect(
    InteractionCommands,
    Effect.gen(function* () {
      const core = yield* GentCore
      return {
        respondPermission: core.respondPermission,
        respondPrompt: core.respondPrompt,
        respondHandoff: core.respondHandoff,
      } satisfies InteractionCommandsService
    }),
  )
}
