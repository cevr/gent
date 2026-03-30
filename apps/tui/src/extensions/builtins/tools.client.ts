import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { BUILTIN_TOOL_RENDERERS } from "../../components/tool-renderers/index"

export default defineClientExtension({
  id: "@gent/tools",
  setup: (ctx) => ({
    tools: BUILTIN_TOOL_RENDERERS,
    commands: [
      {
        id: "tools.counsel",
        title: "Counsel",
        description: "Opposite-vendor peer review",
        category: "Tools",
        slash: "counsel",
        onSelect: () =>
          ctx.sendMessage(
            "Use the counsel tool to get a peer review from the opposite vendor model. Review the most recent changes or topic of discussion. Focus on correctness, edge cases, and architectural issues.",
          ),
        onSlash: (args) =>
          ctx.sendMessage(
            args.trim().length > 0
              ? `Use the counsel tool with this prompt: ${args.trim()}`
              : "Use the counsel tool to get a peer review from the opposite vendor model. Review the most recent changes or topic of discussion. Focus on correctness, edge cases, and architectural issues.",
          ),
      },
      {
        id: "tools.handoff",
        title: "Handoff",
        description: "Distill context into new session",
        category: "Tools",
        slash: "handoff",
        onSelect: () =>
          ctx.sendMessage(
            "Please create a handoff by distilling the current context into a concise summary. Use the handoff tool with the distilled context. Include: current task status, key decisions made, relevant file paths, open questions, and any state that needs to carry over to the new session.",
          ),
      },
      {
        id: "tools.loop",
        title: "Loop",
        description: "Iterate until condition met",
        category: "Tools",
        slash: "loop",
        onSelect: () =>
          ctx.sendMessage(
            "Use the loop tool to iterate on the current task until complete or a condition is met.",
          ),
        onSlash: (args) =>
          ctx.sendMessage(
            args.trim().length > 0
              ? `Use the loop tool: ${args.trim()}`
              : "Use the loop tool to iterate on the current task until complete or a condition is met.",
          ),
      },
    ],
  }),
})
