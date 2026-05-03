// EXPECTED: rule `gent/no-make-unsafe` does NOT fire for safe constructors.
import { DateTime, Ref } from "effect"

export const date = DateTime.make(0)
export const ref = Ref.make(0)
