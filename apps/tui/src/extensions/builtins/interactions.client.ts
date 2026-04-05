/**
 * Builtin interaction renderers for all 4 interaction types.
 * Registers via defineInteractionRenderer for type-safe tag–component coupling.
 */

import {
  defineClientExtension,
  defineInteractionRenderer,
} from "@gent/core/domain/extension-client.js"
import { PromptRenderer } from "../../components/interaction-renderers/prompt"
import { AskUserRenderer } from "../../components/interaction-renderers/ask-user"

export default defineClientExtension({
  id: "@gent/interactions",
  setup: () => ({
    interactionRenderers: [
      defineInteractionRenderer(PromptRenderer),
      defineInteractionRenderer(AskUserRenderer, "ask_user"),
    ],
  }),
})
