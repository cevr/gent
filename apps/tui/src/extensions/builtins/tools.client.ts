import { defineClientExtension } from "@gent/core/domain/extension-client.js"
import { BUILTIN_TOOL_RENDERERS } from "../../components/tool-renderers/index"

export default defineClientExtension({
  id: "@gent/tools",
  setup: (ctx) => ({
    tools: BUILTIN_TOOL_RENDERERS,
    commands: [
      {
        id: "tools.review",
        title: "Review",
        description: "Run adversarial dual-model code review",
        category: "Tools",
        slash: "review",
        onSelect: () =>
          ctx.sendMessage(
            "Use the review tool in report mode on the most recent changes. Focus on correctness, edge cases, and architectural issues.",
          ),
        onSlash: (args) =>
          ctx.sendMessage(
            args.trim().length > 0
              ? `Use the review tool in report mode: ${args.trim()}`
              : "Use the review tool in report mode on the most recent changes. Focus on correctness, edge cases, and architectural issues.",
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
