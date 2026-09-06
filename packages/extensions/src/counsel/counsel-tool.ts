import { Effect, Option, Schema } from "effect"
import {
  AgentDefinition,
  AgentName,
  CapabilityError,
  ExtensionContext,
  ExtensionId,
  defineExtension,
  makeRunSpec,
  request,
  resolveDualModelPair,
  tool,
} from "@gent/core/extensions/api"

const COUNSEL_EXTENSION_ID = ExtensionId.make("@gent/counsel")

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

const counselAgent = AgentDefinition.make({
  name: AgentName.make("counsel-worker"),
})

export const CounselParams = Schema.Struct({
  prompt: Schema.String.annotate({
    description: "The question, task, or topic to get a second opinion on",
  }),
  mode: Schema.optionalKey(
    Schema.Literals(["deep", "standard"]).annotate({
      description:
        "deep: thorough analysis with read-only tools and high reasoning. standard: quick focused opinion (default: standard)",
    }),
  ),
  context: Schema.optionalKey(
    Schema.String.annotate({
      description: "Additional context to include (e.g. relevant code, prior decisions)",
    }),
  ),
})

export const CounselResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literals(["deep", "standard"])),
  response: Schema.optional(Schema.String),
})

const buildCounselPrompt = (prompt: string, context?: string) => {
  const parts = [prompt]
  const contextOption = Option.fromNullishOr(context).pipe(
    Option.filter((value) => value.trim() !== ""),
  )
  if (Option.isSome(contextOption)) {
    parts.push("", "## Context", contextOption.value)
  }
  return parts.join("\n")
}

export const CounselTool = tool({
  id: "counsel",
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
  output: CounselResult,
  execute: Effect.fn("CounselTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const mode = params.mode ?? "standard"
    const agent = ctx.Agent
    const agents = yield* agent.listAgents
    const [, modelB] = yield* resolveDualModelPair(agents)

    const isDeep = mode === "deep"
    const prompt = buildCounselPrompt(params.prompt, params.context)
    let reasoningEffort: "high" | "medium" = "medium"
    let systemPromptAddendum = COUNSEL_STANDARD_PROMPT
    let allowedTools = ["grep", "glob", "read", "memory_search"]
    if (isDeep) {
      reasoningEffort = "high"
      systemPromptAddendum = COUNSEL_DEEP_PROMPT
      allowedTools = ["grep", "glob", "read", "memory_search", "websearch", "webfetch"]
    }

    const result = yield* agent.run({
      agent: counselAgent,
      prompt,
      runSpec: makeRunSpec({
        persistence: "ephemeral",
        parentToolCallId: ctx.toolCallId,
        overrides: {
          modelId: modelB,
          reasoningEffort,
          systemPromptAddendum,
          allowedTools,
        },
      }),
    })

    if (result._tag === "error") {
      return { error: result.error }
    }

    return { mode, response: result.text }
  }),
})

export const CounselExtension = defineExtension({
  id: COUNSEL_EXTENSION_ID,
  requests: [
    request({
      id: "counsel-command",
      description: "Get a cross-vendor second opinion",
      slash: {
        trigger: "counsel",
        name: "Counsel",
        description: "Get a cross-vendor second opinion",
        category: "Tools",
      },
      input: Schema.String,
      output: Schema.Void,
      execute: (input: string) =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          let content =
            "Use the counsel tool in standard mode to get a second opinion on the current approach."
          if (input.trim().length > 0) {
            content = `Use the counsel tool: ${input.trim()}`
          }
          yield* ctx.Session.queueFollowUp({
            sourceId: "counsel-command",
            content,
          })
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CapabilityError({
                extensionId: COUNSEL_EXTENSION_ID,
                capabilityId: "counsel-command",
                reason: cause.message,
              }),
          ),
        ),
    }),
  ],
  tools: [CounselTool],
})
