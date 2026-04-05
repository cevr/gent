import { extension } from "./api.js"

/**
 * Legacy extension — interaction handlers are now provided by ApprovalService.
 * Kept as empty stub so BuiltinExtensions array doesn't break.
 * Delete in cleanup batch.
 */
export const InteractionHandlersExtension = extension("@gent/interaction-handlers", (_ext) => {
  // No-op — handlers removed. ApprovalService provides all interaction handling now.
})
