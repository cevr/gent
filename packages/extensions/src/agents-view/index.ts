/**
 * Agents view — the server half.
 *
 * Per the third rule, the view is an extension of the loop, not core code and
 * not app code. This half contributes one `request` capability returning the
 * reconciled agent rows; the client half renders them.
 *
 * The wire contract lives in `./protocol.js` and the reconciliation in
 * `./projection.js`, so the correctness is tested without a terminal.
 *
 * @module
 */

import { Effect } from "effect"
import { defineExtension, ExtensionHost } from "@gent/core/extensions/api"
import { AGENTS_VIEW_EXTENSION_ID, AgentsViewRpc } from "./protocol.js"

export const AgentsViewExtension = defineExtension({
  id: AGENTS_VIEW_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("request", AgentsViewRpc.ListAgents)
  }),
})
