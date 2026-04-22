/**
 * Builtin interaction renderers for all 4 interaction types.
 */

import { Effect } from "effect"
import { defineClientExtension, interactionRendererContribution } from "../client-facets.js"
import { PromptRenderer } from "../../components/interaction-renderers/prompt"
import { AskUserRenderer } from "../../components/interaction-renderers/ask-user"

export default defineClientExtension("@gent/interaction-tools", {
  setup: Effect.succeed([
    interactionRendererContribution(PromptRenderer), // default fallback
    interactionRendererContribution(PromptRenderer, "prompt"),
    interactionRendererContribution(AskUserRenderer, "ask-user"),
  ]),
})
