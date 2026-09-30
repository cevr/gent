/**
 * The Promise edge of the MCP extension: the SDK's transports take a `fetch`
 * function, and `mcp.ts` answers each request with an Effect. This module
 * turns that Effect into the Promise the SDK awaits.
 */

import { type Context, Effect, Option } from "effect"

/** The fetch shape the MCP SDK's HTTP transports take. */
export type SdkFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

/**
 * A fetch function for an SDK transport that runs `answer` with `services`.
 * A failure rejects the Promise with the failure itself, so the SDK hands it
 * back to the caller unchanged.
 */
export const sdkFetch =
  <E, R>(
    services: Context.Context<R>,
    answer: (url: string | URL, init: Option.Option<RequestInit>) => Effect.Effect<Response, E, R>,
  ): SdkFetch =>
  (url, init) =>
    Effect.runPromiseWith(services)(answer(url, Option.fromUndefinedOr(init)))
