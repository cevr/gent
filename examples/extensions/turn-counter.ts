/**
 * Example: Stateful extension using promptSections to inject turn count.
 *
 * Tracks turn count via a prompt.system hook that increments a closure counter.
 */
import { extension } from "@gent/core/extensions/api"

export default extension("turn-counter", ({ ext }) => {
  let turns = 0
  return ext.on("prompt.system", (input, next) => {
    turns++
    return next({ ...input, basePrompt: input.basePrompt + `\nThis is turn ${turns}.` })
  })
})
