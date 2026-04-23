/**
 * TUI-side `ClientTransport` — typed transport surface for client extensions.
 *
 * Core can't declare this with typed payloads because `GentNamespacedClient`
 * + `GentRuntime` are SDK types and `@gent/core` is upstream of `@gent/sdk`.
 * The TUI shell publishes the typed tag here; client extensions yield this
 * tag to reach the typed transport in their Effect-typed setups.
 *
 * Usage from a client extension:
 *
 *   ```ts
 *   import { Effect } from "effect"
 *   import { ClientTransport } from "../client-transport"
 *
 *   export default defineClientExtension("@gent/x", {
 *     id: "@gent/x",
 *     setup: Effect.gen(function* () {
 *       const { client } = yield* ClientTransport
 *       const result = yield* client.session.list()
 *       return [...]
 *     }),
 *   })
 *   ```
 *
 * The TUI's `ExtensionUIProvider` constructs a per-render `ManagedRuntime`
 * that includes `BunFileSystem | BunPath | ClientTransport.Live(payload)`,
 * passes it to `loadTuiExtensions`, and the loader's `invokeSetup` runs
 * each Effect-typed setup against it.
 */

import { Context, Effect, Layer, Schema } from "effect"
import type { GentNamespacedClient, GentRuntime } from "@gent/sdk"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import {
  type AnyExtensionRequestMessage,
  type ExtractExtensionReply,
  getExtensionReplyDecoder,
} from "@gent/core/domain/extension-protocol.js"

export interface ClientTransportShape {
  readonly client: GentNamespacedClient
  readonly runtime: GentRuntime
  /** Active (sessionId, branchId) — `undefined` before a session is mounted. */
  readonly currentSession: () => { sessionId: SessionId; branchId: BranchId } | undefined
  /** Subscribe to `ExtensionStateChanged` pulses from the active session.
   *  Returns an unsubscribe function. Multiple subscribers receive each
   *  pulse independently. Widgets use this to invalidate cached state
   *  when their server-side extension publishes a state change. */
  readonly onExtensionStateChanged: (
    cb: (pulse: { sessionId: SessionId; branchId: BranchId; extensionId: string }) => void,
  ) => () => void
}

export class ClientTransport extends Context.Service<ClientTransport, ClientTransportShape>()(
  "@gent/tui/src/extensions/client-transport/ClientTransport",
) {}

/**
 * Build a Layer providing `ClientTransport` from a connected `useClient()`
 * result. Called once inside `ExtensionUIProvider` per provider mount; the
 * layer is then merged into the per-provider `ManagedRuntime`.
 */
export const makeClientTransportLayer = (
  payload: ClientTransportShape,
): Layer.Layer<ClientTransport> => Layer.succeed(ClientTransport, payload)

// ── ask helper ────────────────────────────────────────────────────────────

/**
 * Effect-typed mirror of the legacy `ctx.ask(message)`. Sends to the active
 * session captured by `ClientTransport.currentSession()`, decodes the reply
 * via `getExtensionReplyDecoder`, and fails with a tagged error if no
 * session is active.
 *
 * The legacy `ctx.ask` returns a Promise and throws when there's no active
 * session. The Effect-typed surface fails with a typed `NoActiveSessionError`
 * instead — autocomplete `items` callers can `Effect.catchTag(...)` or
 * surface the error to the user.
 */
export class NoActiveSessionError extends Schema.TaggedErrorClass<NoActiveSessionError>()(
  "NoActiveSessionError",
  {},
) {}

export class ClientTransportRequestError extends Schema.TaggedErrorClass<ClientTransportRequestError>()(
  "ClientTransportRequestError",
  {
    extensionId: Schema.String,
    tag: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class ClientTransportReplyDecodeError extends Schema.TaggedErrorClass<ClientTransportReplyDecodeError>()(
  "ClientTransportReplyDecodeError",
  {
    extensionId: Schema.String,
    tag: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const askExtension = <M extends AnyExtensionRequestMessage>(
  message: M,
): Effect.Effect<
  ExtractExtensionReply<M>,
  NoActiveSessionError | ClientTransportRequestError | ClientTransportReplyDecodeError,
  ClientTransport
> =>
  Effect.gen(function* () {
    const transport = yield* ClientTransport
    const session = transport.currentSession()
    if (session === undefined) {
      return yield* new NoActiveSessionError()
    }
    const reply = yield* transport.client.extension
      .ask({
        sessionId: session.sessionId,
        message,
        branchId: session.branchId,
      })
      .pipe(
        Effect.catchEager((cause) =>
          Effect.fail(
            new ClientTransportRequestError({
              extensionId: message.extensionId,
              tag: message._tag,
              message: `request failed: ${String(cause)}`,
              cause,
            }),
          ),
        ),
      )
    const decoder = getExtensionReplyDecoder(message)
    if (decoder === undefined) {
      return yield* new ClientTransportReplyDecodeError({
        extensionId: message.extensionId,
        tag: message._tag,
        message: "missing reply decoder for request message",
        cause: message,
      })
    }
    return yield* Schema.decodeUnknownEffect(decoder)(reply).pipe(
      Effect.mapError(
        (cause) =>
          new ClientTransportReplyDecodeError({
            extensionId: message.extensionId,
            tag: message._tag,
            message: `reply decode failed: ${String(cause)}`,
            cause,
          }),
      ),
    )
  })
