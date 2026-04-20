import { Effect } from "effect"
import {
  defineClientExtension,
  clientCommandContribution,
  interactionRendererContribution,
} from "@gent/core/domain/extension-client.js"
import { HandoffRenderer } from "../../components/interaction-renderers/handoff"
import { ClientShell } from "../client-services"

export default defineClientExtension("@gent/handoff", {
  setup: Effect.gen(function* () {
    const shell = yield* ClientShell
    return [
      interactionRendererContribution(HandoffRenderer, "handoff"),
      clientCommandContribution({
        id: "handoff.trigger",
        title: "Handoff",
        description: "Distill context into new session",
        category: "Handoff",
        slash: "handoff",
        onSelect: () =>
          shell.sendMessage(
            "Please create a handoff by distilling the current context into a concise summary. Use the handoff tool with the distilled context. Include: current task status, key decisions made, relevant file paths, open questions, and any state that needs to carry over to the new session.",
          ),
      }),
    ]
  }),
})
