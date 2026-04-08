/**
 * Example: Stateful extension that counts completed turns.
 *
 * Uses a closure counter incremented on turn.after, injected via prompt.system.
 */
import { extension } from "@gent/core/extensions/api"

export default extension("turn-counter", ({ ext }) => {
  let turns = 0
  return ext
    .on("turn.after", (_input, next) => {
      turns++
      return next(_input)
    })
    .on("prompt.system", (input, next) =>
      next({ ...input, basePrompt: input.basePrompt + `\nThis is turn ${turns + 1}.` }),
    )
})
