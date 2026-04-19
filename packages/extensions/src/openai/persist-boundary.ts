/**
 * Boundary helper for {@link buildOAuthLoader}.
 *
 * The OpenAI SDK invokes our token loader as a Promise-returning function;
 * after refreshing tokens we persist via `ProviderAuthInfo.persist`, an
 * `Effect<void>` produced by the auth store. Crossing back into
 * Promise-land happens here.
 *
 * Per `gent/no-runpromise-outside-boundary`, that call lives in this
 * boundary module. The export NAMES the specific external seam — there is
 * no generic `runAnyEffect` trampoline.
 */

import { Effect } from "effect"
import type { ProviderAuthInfo } from "@gent/core/extensions/api"

type PersistFn = NonNullable<ProviderAuthInfo["persist"]>

/**
 * Persist refreshed OAuth credentials back to the AuthStore. Failures are
 * logged and swallowed (loaders return the new credentials regardless —
 * the next call will retry persistence).
 */
export const persistRefreshedOpenAICredentials = async (
  persist: PersistFn,
  credentials: Parameters<PersistFn>[0],
): Promise<void> => {
  try {
    await Effect.runPromise(persist(credentials))
  } catch (e) {
    console.warn("[openai] failed to persist refreshed OAuth tokens:", e)
  }
}
