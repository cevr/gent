/** Current UI activity for terminal integrations. No event replay or private state mirror. */
import { Context, Layer, Option, Schema } from "effect"
import { SessionId } from "@gent/core/extensions/api"

export const ClientActivitySnapshot = Schema.Struct({
  sessionId: Schema.optional(SessionId),
  state: Schema.Literals(["idle", "working", "blocked", "unknown"]),
})
export type ClientActivitySnapshot = typeof ClientActivitySnapshot.Type

export class ClientActivity extends Context.Service<
  ClientActivity,
  { readonly snapshot: Option.Option<() => ClientActivitySnapshot> }
>()("@gent/tui/src/extensions/client-activity/ClientActivity") {}

export const makeClientActivityLayer = (snapshot?: () => ClientActivitySnapshot) =>
  Layer.succeed(ClientActivity, ClientActivity.of({ snapshot: Option.fromUndefinedOr(snapshot) }))
