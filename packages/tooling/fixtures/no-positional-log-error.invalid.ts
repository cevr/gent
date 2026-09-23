import { Effect } from "effect"

declare const error: unknown

export const warned = Effect.logWarning("request failed", error)
export const logged = Effect.logError("request failed", error, "retrying")
