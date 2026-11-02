/** The process environment for a test's scope: what a spawned command inherits. */
import { Effect, Option } from "effect"

/**
 * Set `name` in the process environment to `next` (unset on none); the value
 * it held. The environment is the boundary under test: gent's git and machine
 * commands inherit it, as they inherit the user's.
 */
const swapEnv = (name: string, next: Option.Option<string>) => {
  // oxlint-disable-next-line effect/noGlobals -- the process environment is what a spawned command inherits, and the only way a global git config reaches git.
  const env = process.env
  const previous = Option.fromUndefinedOr(env[name])
  if (Option.isSome(next)) env[name] = next.value
  else delete env[name]
  return previous
}

/** `name` set in the process environment for the scope. */
export const scopedEnv = (name: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => swapEnv(name, Option.some(value))),
    (previous) => Effect.sync(() => swapEnv(name, previous)),
  )
