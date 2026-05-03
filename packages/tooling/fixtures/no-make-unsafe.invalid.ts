// EXPECTED: rule `gent/no-make-unsafe` fires for unsafe constructors.
import { DateTime, Ref } from "effect"

export const date = DateTime.makeUnsafe(0)
export const ref = Ref.makeUnsafe(0)

const namespace = {
  makeUnsafe: (_value: string) => "unsafe",
}

export const local = namespace.makeUnsafe("value")
