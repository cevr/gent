/**
 * Builtin tool and interaction renderers for the TUI.
 */
import { Effect } from "effect"
import {
  defineClientExtension,
  clientContributions,
  clientCommandContribution,
  interactionRendererContribution,
  rendererContribution,
} from "../client-facets.js"
import { BUILTIN_TOOL_RENDERERS } from "../../components/tool-renderers/index"
import { PromptRenderer } from "../../components/interaction-renderers/prompt"
import { AskUserRenderer } from "../../components/interaction-renderers/ask-user"
import { ClientShell } from "../client-services"

export const builtinTools = defineClientExtension("@gent/tools", {
  setup: Effect.gen(function* () {
    const shell = yield* ClientShell
    return clientContributions(
      ...BUILTIN_TOOL_RENDERERS.map((entry) =>
        rendererContribution(entry.toolNames, entry.component, { headless: entry.headless }),
      ),
      clientCommandContribution({
        id: "tools.loop",
        title: "Loop",
        description: "Iterate until condition met",
        category: "Tools",
        slash: "loop",
        onSelect: () =>
          shell.sendMessage(
            "Use the loop tool to iterate on the current task until complete or a condition is met.",
          ),
        onSlash: (args) => {
          const trimmed = args.trim()
          if (trimmed.length > 0) {
            shell.sendMessage(`Use the loop tool: ${trimmed}`)
            return
          }
          shell.sendMessage(
            "Use the loop tool to iterate on the current task until complete or a condition is met.",
          )
        },
      }),
    )
  }),
})

export const builtinInteractions = defineClientExtension("@gent/interaction-tools", {
  setup: Effect.succeed(
    clientContributions(
      interactionRendererContribution(PromptRenderer),
      interactionRendererContribution(PromptRenderer, "prompt"),
      interactionRendererContribution(AskUserRenderer, "ask-user"),
    ),
  ),
})
