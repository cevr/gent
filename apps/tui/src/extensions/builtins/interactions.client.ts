/**
 * Builtin interaction renderers for all 4 interaction types.
 */

import { interactionRendererContribution } from "@gent/core/domain/extension-client.js"
import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { PromptRenderer } from "../../components/interaction-renderers/prompt"
import { AskUserRenderer } from "../../components/interaction-renderers/ask-user"

export default ExtensionPackage.tui("@gent/interaction-tools", () => [
  interactionRendererContribution(PromptRenderer), // default fallback
  interactionRendererContribution(PromptRenderer, "prompt"),
  interactionRendererContribution(AskUserRenderer, "ask-user"),
])
