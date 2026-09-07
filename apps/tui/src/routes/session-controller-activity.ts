import { DateTime, Option } from "effect"
import type { Array as Arr } from "effect"

const THINKING_WORDS = [
  "thinking",
  "pondering",
  "reasoning",
  "analyzing",
  "processing",
  "evaluating",
  "reflecting",
  "deliberating",
  "considering",
  "contemplating",
  "mulling",
  "deducing",
  "inferring",
  "examining",
  "synthesizing",
  "assessing",
  "ruminating",
] satisfies Arr.NonEmptyReadonlyArray<string>

export const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

export const pickThinkingWord = (random: number): string => {
  const word = THINKING_WORDS[Math.floor(random * THINKING_WORDS.length)]
  return Option.getOrElse(Option.fromNullishOr(word), () => THINKING_WORDS[0])
}
