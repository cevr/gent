/**
 * Builtin interaction renderers for all 4 interaction types.
 */

import { interactionRendererContribution } from "@gent/core/domain/extension-client.js"
import { InteractionToolsPackage } from "@gent/extensions/interaction-tools-package.js"
import { PromptRenderer } from "../../components/interaction-renderers/prompt"
import { AskUserRenderer } from "../../components/interaction-renderers/ask-user"

export default InteractionToolsPackage.tui(() => [
  interactionRendererContribution(PromptRenderer), // default fallback
  interactionRendererContribution(PromptRenderer, "prompt"),
  interactionRendererContribution(AskUserRenderer, "ask-user"),
])
