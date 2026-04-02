import { extension } from "./api.js"
import { PromptHandler } from "../domain/interaction-handlers.js"
import { AskUserHandler } from "../tools/ask-user.js"

export const InteractionHandlersExtension = extension("@gent/interaction-handlers", (ext) => {
  ext.interactionHandler({ type: "prompt" as const, layer: PromptHandler.Live })
  ext.interactionHandler({ type: "ask-user" as const, layer: AskUserHandler.Live })
})
