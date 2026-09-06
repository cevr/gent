import { Effect, Option } from "effect"
import { useContext, type Context } from "solid-js"

/** Read a required provider at the synchronous Solid runtime boundary. */
export function useRequiredContext<A>(context: Context<A>, message: string): NonNullable<A> {
  return Option.getOrElse(Option.fromNullishOr(useContext(context)), () =>
    Effect.runSync(Effect.die(new Error(message))),
  )
}
