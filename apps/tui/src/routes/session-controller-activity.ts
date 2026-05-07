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
] as const

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
] as const

export const currentMillis = () => performance.timeOrigin + performance.now()

const pickRandom = <T>(arr: readonly T[], random: number): T => {
  const item = arr[Math.floor(random * arr.length)]
  if (item === undefined) throw new Error("pickRandom: empty array")
  return item
}

export const defaultActivityDecor = (): ActivityDecor => ({
  spinner: SPINNERS[0] ?? { frames: ["·"], multiplier: 1 },
  word: "thinking",
})

export const pickActivityDecor = (input: {
  readonly spinnerRandom: number
  readonly wordRandom: number
}): ActivityDecor => ({
  spinner: pickRandom(SPINNERS, input.spinnerRandom),
  word: pickRandom(THINKING_WORDS, input.wordRandom),
})
