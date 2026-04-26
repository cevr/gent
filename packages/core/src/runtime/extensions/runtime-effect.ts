import { Schema } from "effect"
import { MessageMetadata } from "../../domain/message.js"
import { ExtensionEffectSchema } from "../../domain/extension.js"

export const QueueFollowUpEffect = Schema.TaggedStruct("QueueFollowUp", {
  content: Schema.String,
  metadata: Schema.optional(MessageMetadata),
})

export const InterjectEffect = Schema.TaggedStruct("Interject", {
  content: Schema.String,
})

export const RuntimeExtensionEffectSchema = Schema.Union([
  QueueFollowUpEffect,
  InterjectEffect,
  ExtensionEffectSchema,
])

export type RuntimeExtensionEffect = typeof RuntimeExtensionEffectSchema.Type
