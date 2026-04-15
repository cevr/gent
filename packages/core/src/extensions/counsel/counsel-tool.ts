import { Effect, Schema } from "effect"
import { defineAgent, defineTool, type ToolContext } from "../api.js"

const COUNSEL_DEEP_PROMPT = `
You are providing a thorough second opinion. Read widely, explore adjacent code,
and challenge assumptions. Cite specific file paths and line numbers for every claim.
Think adversarially — what could go wrong? What was missed? What alternatives exist?
Structure your response clearly with sections. Be direct and opinionated.
`.trim()

const COUNSEL_STANDARD_PROMPT = `
You are providing a focused second opinion. Be concise and direct.
Answer the specific question asked. Cite file paths when referencing code.
If you disagree with the current approach, say so and explain why.
`.trim()

const counselAgent = defineAgent({
  name: "counsel-worker",
  persistence: "ephemeral",
})

export const CounselParams = Schema.Struct({
  prompt: Schema.String.annotate({
    description: "The question, task, or topic to get a second opinion on",
  }),
  mode: Schema.optional(
    Schema.Literals(["deep", "standard"]).annotate({
      description:
        "deep: thorough analysis with read-only tools and high reasoning. standard: quick focused opinion (default: standard)",
    }),
  ),
  context: Schema.optional(
    Schema.String.annotate({
      description: "Additional context to include (e.g. relevant code, prior decisions)",
    }),
  ),
})

const buildCounselPrompt = (prompt: string, context?: string) =>
  [
    prompt,
    ...(context !== undefined && context.trim() !== "" ? ["", "## Context", context] : []),
  ].join("\n")

export const CounselTool = defineTool({
  name: "counsel",
  concurrency: "parallel" as const,
  description:
    "Get a cross-vendor second opinion. Deep mode for thorough analysis with exploration tools. Standard mode for quick focused opinions.",
  promptSnippet: "Cross-vendor second opinion",
  promptGuidelines: [
    "Use when unsure about an approach, before committing to a design",
    "deep mode: architecture decisions, complex refactors, plan review",
    "standard mode: quick sanity checks, per-batch verification",
    "Include relevant context — the counsel agent has no conversation history",
  ],
  params: CounselParams,
  execute: Effect.fn("CounselTool.execute")(function* (params, ctx: ToolContext) {
    const mode = params.mode ?? "standard"
    const [, modelB] = yield* ctx.agent.resolveDualModelPair()

    const isDeep = mode === "deep"
    const prompt = buildCounselPrompt(params.prompt, params.context)

    const result = yield* ctx.agent.run({
      agent: counselAgent,
      prompt,
      toolCallId: ctx.toolCallId,
      overrides: {
        modelId: modelB,
        reasoningEffort: isDeep ? "high" : "medium",
        systemPromptAddendum: isDeep ? COUNSEL_DEEP_PROMPT : COUNSEL_STANDARD_PROMPT,
        ...(isDeep
          ? {
              allowedTools: [
                "grep",
                "glob",
                "read",
                "memory_search",
                "websearch",
                "webfetch",
              ] as const,
            }
          : { allowedTools: ["grep", "glob", "read", "memory_search"] as const }),
      },
    })

    if (result._tag === "error") {
      return { error: result.error }
    }

    return { mode, response: result.text }
  }),
})
