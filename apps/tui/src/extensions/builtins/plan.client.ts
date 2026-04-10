import { PlanPackage } from "@gent/core/extensions/plan-package.js"

export default PlanPackage.tui((ctx) => ({
  commands: [
    {
      id: "plan.create",
      title: "Plan",
      description: "Create an adversarial implementation plan",
      category: "Workflow",
      keybind: "ctrl+shift+p",
      slash: "plan",
      onSelect: () =>
        ctx.sendMessage("Use the plan tool to create an implementation plan for the current task."),
      onSlash: (args) =>
        ctx.sendMessage(
          args.trim().length > 0
            ? `Use the plan tool to create an implementation plan for: ${args.trim()}`
            : "Use the artifact_read tool with sourceTool 'plan' to show the current plan. If no plan exists, say so.",
        ),
    },
    {
      id: "plan.audit",
      title: "Audit",
      description: "Detect, audit, fix code issues",
      category: "Workflow",
      slash: "audit",
      onSelect: () =>
        ctx.sendMessage(
          "Use the audit tool to audit the current changes. Detects concerns, audits in parallel, synthesizes findings, and applies fixes.",
        ),
      onSlash: (args) =>
        ctx.sendMessage(
          args.trim().length > 0
            ? `Use the audit tool to audit: ${args.trim()}`
            : "Use the audit tool to audit the current changes. Detects concerns, audits in parallel, synthesizes findings, and applies fixes.",
        ),
    },
  ],
}))
