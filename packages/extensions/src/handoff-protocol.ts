import { Schema } from "effect"
import { ExtensionMessage } from "@gent/core/extensions/api"

export const HANDOFF_EXTENSION_ID = "@gent/handoff"

export const HandoffProtocol = {
  Suppress: ExtensionMessage.command(HANDOFF_EXTENSION_ID, "Suppress", {
    count: Schema.Number,
  }),
  /** Read the current cooldown counter. Used by the handoff interceptor's
   *  self-read so it can avoid the workflow's lack of UI snapshot — workflows
   *  declare effects, projections derive views, and neither owns ad-hoc
   *  cross-call state reads (per `composability-not-flags`). */
  GetCooldown: ExtensionMessage.reply(HANDOFF_EXTENSION_ID, "GetCooldown", {}, Schema.Number),
}
