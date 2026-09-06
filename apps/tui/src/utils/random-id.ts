import { Effect, Random } from "effect"

const bytes = Array.from({ length: 16 }, (_, index) => index)

export const randomId = Effect.forEach(bytes, () => Random.nextIntBetween(0, 255)).pipe(
  Effect.map((values) => {
    const hex = values.map((value, index) => {
      if (index === 6) return ((value & 0x0f) | 0x40).toString(16).padStart(2, "0")
      if (index === 8) return ((value & 0x3f) | 0x80).toString(16).padStart(2, "0")
      return value.toString(16).padStart(2, "0")
    })
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
  }),
)
