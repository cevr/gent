import { Effect, Schema } from "effect"
import {
  CapabilityError,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  request,
} from "@gent/core/extensions/api"
import { HandoffTool } from "./handoff-tool.js"

const EXTENSION_ID = ExtensionId.make("@gent/handoff")

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
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CapabilityError({
            extensionId: EXTENSION_ID,
            capabilityId: "handoff-command",
            reason: cause.message,
          }),
      ),
    ),
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
