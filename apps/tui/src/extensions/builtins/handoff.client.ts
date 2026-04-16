import { defineInteractionRenderer } from "@gent/core/domain/extension-client.js"
import { HandoffPackage } from "@gent/extensions/handoff-package.js"
import { HandoffRenderer } from "../../components/interaction-renderers/handoff"

export default HandoffPackage.tui((ctx) => ({
  interactionRenderers: [defineInteractionRenderer(HandoffRenderer, "handoff")],
  commands: [
    {
      id: "handoff.trigger",
      title: "Handoff",
      description: "Distill context into new session",
      category: "Handoff",
      slash: "handoff",
      onSelect: () =>
        ctx.sendMessage(
          "Please create a handoff by distilling the current context into a concise summary. Use the handoff tool with the distilled context. Include: current task status, key decisions made, relevant file paths, open questions, and any state that needs to carry over to the new session.",
        ),
    },
  ],
}))
