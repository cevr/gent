import type { MessageMetadata } from "../../domain/message.js"
import type { ExtensionEffect } from "../../domain/extension.js"

export type RuntimeExtensionEffect =
  | {
      readonly _tag: "QueueFollowUp"
      readonly content: string
      readonly metadata?: MessageMetadata
    }
  | { readonly _tag: "Interject"; readonly content: string }
  | ExtensionEffect
