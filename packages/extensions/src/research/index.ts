import { Effect, Schema } from "effect"
import {
  AgentName,
  CapabilityError,
  ExtensionContext,
  ExtensionId,
  ModelId,
  action,
  defineAgent,
  defineExtension,
} from "@gent/core/extensions/api"
import { ResearchTool } from "./research-tool.js"

const RESEARCH_EXTENSION_ID = ExtensionId.make("@gent/research")

const ARCHITECT_PROMPT = `
Architect agent. Design implementation approach.
- Enumerate structure, tradeoffs, and risks.
- Reference specific files and interfaces.
- No code changes — read-only analysis.
- Plans batched by commit — each batch is one shippable unit.
- Each batch: Goal, Why, Justification (principle names), Files, Changes, Verification.
- No addendums — plans must be cohesive, not main + appendix.
- Use the principles tool to ground justifications.
- End with a sequenced implementation plan.
`.trim()

export const architect = defineAgent({
  name: AgentName.make("architect"),
  description: "Designs implementation approaches",
  model: ModelId.make("anthropic/claude-opus-4-6"),
  allowedTools: ["grep", "glob", "read", "memory_search", "websearch", "webfetch"],
  systemPromptAddendum: ARCHITECT_PROMPT,
})

export const ResearchExtension = defineExtension({
  id: RESEARCH_EXTENSION_ID,
  actions: [
    action({
      id: "research-command",
      name: "Research",
      description: "Research external repositories",
      surface: "slash",
      slash: { trigger: "research" },
      category: "Tools",
      input: Schema.String,
      output: Schema.Void,
      execute: (input: string) =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          yield* ctx.Session.queueFollowUp({
            sourceId: "research-command",
            content:
              input.trim().length > 0
                ? `Use the research tool: ${input.trim()}`
                : "Use the research tool to understand how an external library or framework works. Ask me which repo to research.",
          })
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CapabilityError({
                extensionId: RESEARCH_EXTENSION_ID,
                capabilityId: "research-command",
                reason: cause.message,
              }),
          ),
        ),
    }),
  ],
  tools: [ResearchTool],
  agents: [architect],
})
