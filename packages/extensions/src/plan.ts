/**
 * Plan extension — tool-only (no actor).
 *
 * The PlanTool orchestrates adversarial multi-agent planning cycles.
 * Plan artifacts are persisted via the @gent/artifacts extension.
 */

import { Effect, Schema } from "effect"
import {
  action,
  CapabilityError,
  defineExtension,
  ExtensionSession,
  ExtensionId,
} from "@gent/core/extensions/api"
import { PlanTool } from "./plan-tool.js"

export { PlanTool, PlanParams } from "./plan-tool.js"

export const PLAN_EXTENSION_ID = ExtensionId.make("@gent/plan")

const planPrompt = (input: string) =>
  input.trim().length > 0
    ? `Use the plan tool to create an implementation plan for: ${input.trim()}`
    : "Use the artifact_read tool with sourceTool 'plan' to show the current plan. If no plan exists, say so."

const auditPrompt = (input: string) =>
  input.trim().length > 0
    ? `Use the audit tool to audit: ${input.trim()}`
    : "Use the audit tool to audit the current changes. Detects concerns, audits in parallel, synthesizes findings, and applies fixes."

const PlanAction = action({
  id: "plan-command",
  name: "Plan",
  description: "Create an adversarial implementation plan",
  surface: "slash",
  slash: { trigger: "plan" },
  category: "Workflow",
  keybind: "ctrl+shift+p",
  input: Schema.String,
  output: Schema.Void,
  execute: (input: string) =>
    Effect.gen(function* () {
      const session = yield* ExtensionSession
      yield* session.queueFollowUp({ sourceId: "plan-command", content: planPrompt(input) })
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityError({
            extensionId: PLAN_EXTENSION_ID,
            capabilityId: "plan-command",
            reason: cause.message,
          }),
      ),
    ),
})

const AuditAction = action({
  id: "audit-command",
  name: "Audit",
  description: "Detect, audit, fix code issues",
  surface: "slash",
  slash: { trigger: "audit" },
  category: "Workflow",
  input: Schema.String,
  output: Schema.Void,
  execute: (input: string) =>
    Effect.gen(function* () {
      const session = yield* ExtensionSession
      yield* session.queueFollowUp({ sourceId: "audit-command", content: auditPrompt(input) })
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityError({
            extensionId: PLAN_EXTENSION_ID,
            capabilityId: "audit-command",
            reason: cause.message,
          }),
      ),
    ),
})

export const PlanExtension = defineExtension({
  id: PLAN_EXTENSION_ID,
  actions: [PlanAction, AuditAction],
  tools: [PlanTool],
})
