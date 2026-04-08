import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { BUILTIN_TOOL_RENDERERS } from "../../components/tool-renderers/index"

export default ExtensionPackage.tui("@gent/tools", (ctx) => ({
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
      id: "tools.counsel",
      title: "Counsel",
      description: "Get a cross-vendor second opinion",
      category: "Tools",
      slash: "counsel",
      onSelect: () =>
        ctx.sendMessage(
          "Use the counsel tool in standard mode to get a second opinion on the current approach.",
        ),
      onSlash: (args) =>
        ctx.sendMessage(
          args.trim().length > 0
            ? `Use the counsel tool: ${args.trim()}`
            : "Use the counsel tool in standard mode to get a second opinion on the current approach.",
        ),
    },
    {
      id: "tools.research",
      title: "Research",
      description: "Research external repositories",
      category: "Tools",
      slash: "research",
      onSelect: () =>
        ctx.sendMessage(
          "Use the research tool to understand how an external library or framework works. Ask me which repo to research.",
        ),
      onSlash: (args) =>
        ctx.sendMessage(
          args.trim().length > 0
            ? `Use the research tool: ${args.trim()}`
            : "Use the research tool to understand how an external library or framework works. Ask me which repo to research.",
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
}))
