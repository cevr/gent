/** Current UI activity for terminal integrations. No event replay or private state mirror. */
import { Context, Layer, Schema } from "effect"
import { SessionId } from "@gent/core/extensions/api"

export const ClientActivitySnapshot = Schema.Struct({
  sessionId: Schema.optional(SessionId),
  state: Schema.Literals(["idle", "working", "blocked", "unknown"]),
})
export type ClientActivitySnapshot = typeof ClientActivitySnapshot.Type

/**
 * Absence has one encoding: a surface with nothing to report reports
 * `"unknown"`. A reader never re-tests a decision the composition root made.
 */
export class ClientActivity extends Context.Service<
  ClientActivity,
  { readonly snapshot: () => ClientActivitySnapshot }
>()("@gent/tui/src/extensions/client-activity/ClientActivity") {}

const unknownActivity = (): ClientActivitySnapshot => ({ state: "unknown" })

export const makeClientActivityLayer = (snapshot: () => ClientActivitySnapshot = unknownActivity) =>
  Layer.succeed(ClientActivity, ClientActivity.of({ snapshot }))
