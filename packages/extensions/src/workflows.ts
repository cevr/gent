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

const planRecipe = (input: string, outputPath: string) => {
  if (input.length === 0) {
    return `Read the saved plan at ${outputPath} and show it. This path is on the session server. If it is missing or unreadable, report that fact. Do not create a replacement or infer a plan from another branch. Do not depend on kernel bindings.`
  }
  return [
    `Plan: ${input}`,
    "Inspect the relevant sources. Produce a scoped implementation plan with commit steps, risks, and verification. Do not implement it yet.",
    "Use independent child work only when it adds value. Keep intermediate results in cell bindings or files.",
    `Save the final plan at ${outputPath} with the write tool and atomic: true. This canonical path is on the session server. Confirm the write succeeded and show the path. If the user requests another destination, export a separate copy after the canonical save; an export failure must not undo it.`,
    "End the save cell before requesting approval with prompt in a separate cell. Read the saved plan for approval. Obtain approval before code changes. If the worker is lost, inspect the saved file or write receipt; do not repeat a write or child run merely to recover context.",
  ].join("\n")
}

const reviewRecipe = (input: string, outputPath: string) =>
  [
    `Review: ${input || "the most recent changes (git diff)"}`,
    "Read the relevant sources. Report actionable findings with file, line, severity, explanation, and a proposed fix. State when no findings remain. Do not edit source files.",
    "Use an independent child review when it adds value. Keep intermediate results in cell bindings or files.",
    `Write only the final report to ${outputPath} with the write tool and atomic: true. Confirm the save succeeded, then show the findings and server file path.`,
  ].join("\n")

const auditRecipe = (input: string, outputPath: string) =>
  [
    `Audit: ${input || "the current changes (git diff --name-only)"}`,
    "Inspect the relevant sources for material concerns. Report findings with file, line, severity, and evidence. Do not edit source files.",
    "Delegate independent concerns only when it adds value. Keep intermediate results in cell bindings or files.",
    `Write only the final report to ${outputPath} with the write tool and atomic: true. Confirm the save succeeded, then show the findings and server file path. Use prompt mode 'present' if a separate notice helps; it requires no approval.`,
  ].join("\n")

const counselRecipe = (input: string) =>
  `Get a second opinion on ${input || "the current approach"}: delegate a self-contained question with the approach, alternatives, and tradeoffs. Use a different model with overrides.modelId when one is available. Report the opinion verbatim, then your response.`

const researchRecipe = (input: string) => {
  if (input.length === 0) {
    return "Ask which repository and question to research."
  }
  return [
    `Research: ${input}`,
    "Use primary sources. Read the repositories skill when external source code is needed. Use native Git or package commands through bash and record exact revisions. Delegate independent reading only when it adds value. Keep intermediate results in cell bindings or files.",
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
  readonly recipe: (input: string, outputPath: string) => string
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
        const outputPath = ctx.Files.resolve(
          ctx.cwd,
          ".gent",
          "results",
          encodeURIComponent(ctx.sessionId),
          encodeURIComponent(ctx.branchId),
          `${params.slash.trigger}.md`,
        )
        const quotedPath = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
          outputPath,
        )
        yield* ctx.Session.queueFollowUp({
          sourceId: `${params.id}:${yield* ctx.Process.randomId}`,
          content: params.recipe(input.trim(), quotedPath),
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
