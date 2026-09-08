/**
 * Workflow commands as recipes. Each slash command queues a prompt that
 * composes existing host tools (delegate, artifacts, prompt) from a cell.
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

const trimmed = (input: string) => input.trim()

const planRecipe = (input: string) => {
  if (trimmed(input).length === 0) {
    return "Use artifact_read with sourceTool 'plan' to show the current plan. If no plan exists, say so."
  }
  return [
    `Create an adversarial implementation plan for: ${trimmed(input)}`,
    "Recipe, run from one cell:",
    "1. Delegate two independent plans with Promise.all. Give the second child a different model with overrides.modelId when one is available.",
    "2. Delegate a cross-review of each plan to a fresh child, passing the plan text in the prompt.",
    "3. Delegate a synthesis with both plans and both reviews. One cohesive plan, batched by commit.",
    "4. Save it with artifact_save (sourceTool 'plan', label 'Plan: <topic>').",
    "5. Present it with the prompt tool for approval before any code changes.",
  ].join("\n")
}

const reviewRecipe = (input: string) => {
  let scope = "the most recent changes (git diff)"
  if (trimmed(input).length > 0) scope = trimmed(input)
  return [
    `Run an adversarial code review of ${scope}.`,
    "Recipe, run from one cell:",
    "1. Delegate two independent read-only reviews with Promise.all (overrides.allowedTools: read, grep, glob). Ask for a JSON array of comments (file, line, severity, type, text, fix).",
    "2. Delegate a critique of each review to a fresh child.",
    "3. Synthesize one comment list and a severity summary (critical, high, medium, low).",
    "4. Save it with artifact_save (sourceTool 'review'). Report the comments; do not apply fixes unless asked.",
  ].join("\n")
}

const auditRecipe = (input: string) => {
  let scope = "the current changes (git diff --name-only)"
  if (trimmed(input).length > 0) scope = trimmed(input)
  return [
    `Audit ${scope}.`,
    "Recipe, run from one cell:",
    "1. Delegate concern detection: up to 5 concern categories for these paths.",
    "2. For each concern, delegate two independent audits with Promise.all. Every finding must cite file and line.",
    "3. Delegate a synthesis: findings with file, description, severity (critical, warning, suggestion).",
    "4. Save it with artifact_save (sourceTool 'audit') and present the findings with the prompt tool.",
  ].join("\n")
}

const counselRecipe = (input: string) => {
  let question = "the current approach"
  if (trimmed(input).length > 0) question = trimmed(input)
  return `Get a second opinion on ${question}: delegate to a child with overrides.modelId set to a different model when one is available, and a self-contained prompt that states the approach, the alternatives, and the tradeoffs. Report the opinion verbatim, then your response to it.`
}

const researchRecipe = (input: string) => {
  if (trimmed(input).length === 0) {
    return "Research an external repository: ask me which repo (owner/repo, owner/repo@tag, or npm:package) and what question to answer, then use the repo tool to fetch it and delegate the reading to a child."
  }
  return `Research: ${trimmed(input)}. Use the repo tool to fetch each repository, delegate one focused read-only reading per repository with Promise.all (at most 5), then synthesize a comparative answer with citations to files.`
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
        yield* ctx.Session.queueFollowUp({ sourceId: params.id, content: params.recipe(input) })
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
      description: "Create an adversarial implementation plan",
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
      description: "Run adversarial dual-model code review",
      category: "Tools",
    },
    recipe: reviewRecipe,
  }),
  command({
    id: "counsel-command",
    slash: {
      trigger: "counsel",
      name: "Counsel",
      description: "Get a cross-vendor second opinion",
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
