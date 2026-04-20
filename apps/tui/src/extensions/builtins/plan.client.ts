import { Effect } from "effect"
import {
  defineClientExtension,
  clientCommandContribution,
} from "@gent/core/domain/extension-client.js"
import { ClientShell } from "../client-services"

export default defineClientExtension("@gent/plan", {
  setup: Effect.gen(function* () {
    const shell = yield* ClientShell
    return [
      clientCommandContribution({
        id: "plan.create",
        title: "Plan",
        description: "Create an adversarial implementation plan",
        category: "Workflow",
        keybind: "ctrl+shift+p",
        slash: "plan",
        onSelect: () =>
          shell.sendMessage(
            "Use the plan tool to create an implementation plan for the current task.",
          ),
        onSlash: (args) =>
          shell.sendMessage(
            args.trim().length > 0
              ? `Use the plan tool to create an implementation plan for: ${args.trim()}`
              : "Use the artifact_read tool with sourceTool 'plan' to show the current plan. If no plan exists, say so.",
          ),
      }),
      clientCommandContribution({
        id: "plan.audit",
        title: "Audit",
        description: "Detect, audit, fix code issues",
        category: "Workflow",
        slash: "audit",
        onSelect: () =>
          shell.sendMessage(
            "Use the audit tool to audit the current changes. Detects concerns, audits in parallel, synthesizes findings, and applies fixes.",
          ),
        onSlash: (args) =>
          shell.sendMessage(
            args.trim().length > 0
              ? `Use the audit tool to audit: ${args.trim()}`
              : "Use the audit tool to audit the current changes. Detects concerns, audits in parallel, synthesizes findings, and applies fixes.",
          ),
      }),
    ]
  }),
})
