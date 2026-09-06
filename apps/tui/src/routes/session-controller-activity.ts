import { DateTime, Option } from "effect"
import type { Array as Arr } from "effect"

export interface ActivityDecor {
  readonly spinner: {
    readonly frames: readonly string[]
    readonly multiplier: number
  }
  readonly word: string
}

// Each spinner has frames and a tick multiplier (ticks per frame at 60ms base).
// multiplier 1 = 60ms/frame, 2 = 120ms/frame, etc.
const SPINNERS = [
  { frames: ["·", "•", "*", "⁑", "⁂"], multiplier: 2 },
  { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], multiplier: 1 },
  {
    frames: ["⠁⠂⠄⡀", "⠂⠄⡀⢀", "⠄⡀⢀⠠", "⡀⢀⠠⠐", "⢀⠠⠐⠈", "⠠⠐⠈⠁", "⠐⠈⠁⠂", "⠈⠁⠂⠄"],
    multiplier: 2,
  },
  { frames: ["⠉⠉", "⠓⠓", "⠦⠦", "⣄⣄", "⠦⠦", "⠓⠓"], multiplier: 2 },
  { frames: ["⠃", "⠉", "⠘", "⠰", "⢠", "⣀", "⡄", "⠆"], multiplier: 2 },
  { frames: ["⣀⣀", "⣤⣤", "⣶⣶", "⣿⣿", "⣿⣿", "⣶⣶", "⣤⣤", "⣀⣀", "⠀⠀"], multiplier: 2 },
  { frames: ["⢕⢕", "⡪⡪", "⢊⠔", "⡡⢊"], multiplier: 4 },
  {
    frames: ["⠀⠀⠀", "⠂⠂⠂", "⠌⠌⠌", "⡑⡑⡑", "⢕⢕⢕", "⣫⣫⣫", "⣿⣿⣿", "⣫⣫⣫", "⢕⢕⢕", "⡑⡑⡑", "⠌⠌⠌", "⠂⠂⠂"],
    multiplier: 2,
  },
] satisfies Arr.NonEmptyReadonlyArray<ActivityDecor["spinner"]>

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

const pickRandom = <T>(arr: Arr.NonEmptyReadonlyArray<T>, random: number): T => {
  const item = arr[Math.floor(random * arr.length)]
  return Option.getOrElse(Option.fromNullishOr(item), () => arr[0])
}

export const defaultActivityDecor = (): ActivityDecor => ({
  spinner: SPINNERS[0],
  word: "thinking",
})

export const pickActivityDecor = (input: {
  readonly spinnerRandom: number
  readonly wordRandom: number
}): ActivityDecor => ({
  spinner: pickRandom(SPINNERS, input.spinnerRandom),
  word: pickRandom(THINKING_WORDS, input.wordRandom),
})
