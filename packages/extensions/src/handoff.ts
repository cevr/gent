import { Effect, Schema } from "effect"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  request,
  tool,
} from "@gent/core/extensions/api"

const EXTENSION_ID = ExtensionId.make("@gent/handoff")

const HandoffParams = Schema.Struct({
  context: Schema.String.annotate({
    description:
      "Distilled context for the new session. Include: current task, key decisions, relevant files, open questions, and any state that needs to carry over. This becomes the initial prompt.",
  }),
  reason: Schema.optionalKey(
    Schema.String.annotate({
      description: "Why handoff is needed (e.g. context window filling up)",
    }),
  ),
})

const HandoffResult = Schema.Struct({
  handoff: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  parentSessionId: Schema.optional(Schema.String),
})

export const HandoffTool = tool({
  id: "handoff",
  description:
    "Create a new session with distilled context from the current one. Use when context is getting large and you want to continue with a clean slate while preserving key information. Blocks until the user confirms.",
  promptSnippet: "Transfer context to a new session",
  promptGuidelines: [
    "ONLY use when context is getting large and you need a clean slate",
    "Include all essential context — the new session starts fresh",
  ],
  params: HandoffParams,
  output: HandoffResult,
  execute: Effect.fn("HandoffTool.execute")(function* (params: typeof HandoffParams.Type) {
    const ctx = yield* ExtensionContext
    const summary = params.context

    const interaction = ctx.Interaction
    const decision = yield* interaction.approve({
      text: summary,
      metadata: { type: "handoff", reason: params.reason },
    })

    if (!decision.approved) {
      return {
        handoff: false,
        reason: "User rejected handoff",
      }
    }

    return {
      handoff: true,
      summary,
      reason: params.reason,
      parentSessionId: ctx.sessionId,
    }
  }),
})

const HandoffCommand = request({
  id: "handoff-command",
  description: "Distill context into new session",
  slash: {
    trigger: "handoff",
    name: "Handoff",
    description: "Distill context into new session",
  },
  input: Schema.String,
  output: Schema.Void,
  execute: (_input: string) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      yield* ctx.Session.queueFollowUp({
        sourceId: "handoff-command",
        content:
          "Please create a handoff by distilling the current context into a concise summary. Use the handoff tool with the distilled context. Include: current task status, key decisions made, relevant file paths, open questions, and any state that needs to carry over to the new session.",
      })
    }),
})

export const HandoffExtension = defineExtension({
  id: EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    // Context pressure is the runtime's job: it compacts automatically and the
    // transcript shows the record. Handoff stays an explicit user action.
    yield* host.register("request", HandoffCommand)
    yield* host.register("tool", HandoffTool)
  }),
})
