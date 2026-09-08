/**
 * Workflow commands as recipes. Each slash command queues a prompt that
 * uses the kernel and host tools without a fixed child-agent sequence.
 * No orchestration code lives here; the model runs the recipe.
 */

import { Effect, Schema } from "effect"
import {
  CapabilityError,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  request,
} from "@gent/core/extensions/api"

export const WORKFLOWS_EXTENSION_ID = ExtensionId.make("@gent/workflows")

const planRecipe = (input: string) => {
  if (input.length === 0) {
    return "Use artifact_read with sourceTool 'plan' to show the current plan. If no plan exists, say so."
  }
  return [
    `Plan: ${input}`,
    "Inspect the relevant sources. Produce a scoped implementation plan with commit steps, risks, and verification. Do not implement it yet.",
    "Use independent child work only when it adds value. Keep intermediate results in cell bindings or files.",
    "Save the final plan with artifact_save (sourceTool 'plan', label 'Plan: <topic>'). End that cell before requesting approval with prompt in a separate cell. Obtain approval before code changes.",
  ].join("\n")
}

const reviewRecipe = (input: string) =>
  [
    `Review: ${input || "the most recent changes (git diff)"}`,
    "Read the relevant sources. Report actionable findings with file, line, severity, explanation, and a proposed fix. State when no findings remain. Do not edit files.",
    "Use an independent child review when it adds value. Keep intermediate results in cell bindings or files.",
    "Save the final report with artifact_save (sourceTool 'review') and show the findings.",
  ].join("\n")

const auditRecipe = (input: string) =>
  [
    `Audit: ${input || "the current changes (git diff --name-only)"}`,
    "Inspect the relevant sources for material concerns. Report findings with file, line, severity, and evidence. Do not edit files.",
    "Delegate independent concerns only when it adds value. Keep intermediate results in cell bindings or files.",
    "Save the final report with artifact_save (sourceTool 'audit') and show the findings. Use prompt mode 'present' if a separate notice helps; it requires no approval.",
  ].join("\n")

const counselRecipe = (input: string) =>
  `Get a second opinion on ${input || "the current approach"}: delegate a self-contained question with the approach, alternatives, and tradeoffs. Use a different model with overrides.modelId when one is available. Report the opinion verbatim, then your response.`

const researchRecipe = (input: string) => {
  if (input.length === 0) {
    return "Ask which repository and question to research."
  }
  return [
    `Research: ${input}`,
    "Use primary sources. Use repo to fetch external repository sources when needed. Delegate independent reading only when it adds value. Keep intermediate results in cell bindings or files.",
    "Answer with citations to the sources you read. Separate observed behavior from inference and state any gaps.",
  ].join("\n")
}

const command = (params: {
  readonly id: string
  readonly slash: {
    readonly trigger: string
    readonly name: string
    readonly description: string
    readonly category: string
    readonly keybind?: string
  }
  readonly recipe: (input: string) => string
}) =>
  request({
    id: params.id,
    description: params.slash.description,
    slash: params.slash,
    input: Schema.String,
    output: Schema.Void,
    execute: (input: string) =>
      Effect.gen(function* () {
        const ctx = yield* ExtensionContext
        yield* ctx.Session.queueFollowUp({
          sourceId: params.id,
          content: params.recipe(input.trim()),
        })
      }).pipe(
        Effect.mapError(
          (cause) =>
            new CapabilityError({
              extensionId: WORKFLOWS_EXTENSION_ID,
              capabilityId: params.id,
              reason: cause.message,
            }),
        ),
      ),
  })

const WorkflowCommands = [
  command({
    id: "plan-command",
    slash: {
      trigger: "plan",
      name: "Plan",
      description: "Create an implementation plan",
      category: "Workflow",
      keybind: "ctrl+shift+p",
    },
    recipe: planRecipe,
  }),
  command({
    id: "audit-command",
    slash: {
      trigger: "audit",
      name: "Audit",
      description: "Detect, audit, and report code issues",
      category: "Workflow",
    },
    recipe: auditRecipe,
  }),
  command({
    id: "review-command",
    slash: {
      trigger: "review",
      name: "Review",
      description: "Review code and report findings",
      category: "Tools",
    },
    recipe: reviewRecipe,
  }),
  command({
    id: "counsel-command",
    slash: {
      trigger: "counsel",
      name: "Counsel",
      description: "Get an independent second opinion",
      category: "Tools",
    },
    recipe: counselRecipe,
  }),
  command({
    id: "research-command",
    slash: {
      trigger: "research",
      name: "Research",
      description: "Research external repositories",
      category: "Tools",
    },
    recipe: researchRecipe,
  }),
]

export const WorkflowsExtension = defineExtension({
  id: WORKFLOWS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("request", ...WorkflowCommands)
  }),
})
