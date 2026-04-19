/**
 * Boundary helper for {@link useSessionFeed}.
 *
 * The session-feed hook subscribes to server events on the Solid signal lane;
 * a few event handlers need to fire-and-forget Effects (today: a backfill
 * RPC after a `MessageReceived` from another client). The Promise edge for
 * that backfill lives here per `gent/no-runpromise-outside-boundary`.
 *
 * Each export NAMES a specific external seam — there's no generic
 * `runAnyEffect(...)` trampoline, because that would let any non-boundary
 * file create new Promise edges by laundering through this module.
 */

import { Effect } from "effect"
import type { GentNamespacedClient, MessageInfoReadonly } from "@gent/sdk"
import type { BranchId } from "@gent/core/domain/ids.js"

/**
 * Backfill the message list for `branchId` after a remote `MessageReceived`
 * event arrives on the feed. The RPC runs through `Effect.runPromise`;
 * results are handed to `apply` only if `isCurrent()` returns true (so a
 * stale fetch from a previous identity is dropped).
 *
 * Failures are swallowed (`Effect.catchEager`) — message-list backfill is a
 * best-effort UX nicety; on transport failure the next event will trigger
 * another fetch.
 */
export const backfillBranchMessages = (params: {
  client: GentNamespacedClient
  branchId: BranchId
  isCurrent: () => boolean
  apply: (msgs: readonly MessageInfoReadonly[]) => void
}): void => {
  void Effect.runPromise(
    params.client.message.list({ branchId: params.branchId }).pipe(
      Effect.tap((msgs) =>
        Effect.sync(() => {
          if (!params.isCurrent()) return
          params.apply(msgs)
        }),
      ),
      Effect.catchEager(() => Effect.void),
    ),
  )
}
