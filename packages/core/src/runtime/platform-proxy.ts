/**
 * Platform proxy — wraps Effect FileSystem into a Promise-returning Proxy.
 *
 * Every method call on the proxy intercepts the Effect return value and
 * runs it through the provided runner, returning a Promise instead.
 * Path is already sync — passed through as-is.
 */

import { Effect, type FileSystem } from "effect"
import type { AsyncFileSystem } from "../domain/extension-client.js"

/** Wrap an Effect FileSystem into an AsyncFileSystem via Proxy. */
export const makeAsyncFs = (
  fs: FileSystem.FileSystem,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
): AsyncFileSystem =>
  new Proxy(fs, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        const result = value.apply(target, args)
        // If the result is an Effect (has [Symbol] from Effect), run it
        if (result !== null && typeof result === "object" && Effect.isEffect(result)) {
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — dynamic proxy, types erased at runtime
          return run(result as Effect.Effect<unknown, unknown>)
        }
        return result
      }
    },
  }) as unknown as AsyncFileSystem
