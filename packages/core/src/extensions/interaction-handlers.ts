import { Effect } from "effect"
import { defineExtension } from "../domain/extension.js"
import { PermissionHandler, PromptHandler } from "../domain/interaction-handlers.js"
import { AskUserHandler } from "../tools/ask-user.js"

export const InteractionHandlersExtension = defineExtension({
  manifest: { id: "@gent/interaction-handlers" },
  setup: () =>
    Effect.succeed({
      interactionHandlers: [
        { type: "permission" as const, layer: PermissionHandler.Live },
        { type: "prompt" as const, layer: PromptHandler.Live },
        { type: "ask-user" as const, layer: AskUserHandler.Live },
      ],
    }),
})
