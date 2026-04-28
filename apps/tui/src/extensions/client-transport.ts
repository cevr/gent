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
import type { EventEnvelope } from "@gent/core/domain/event.js"
import type { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { CapabilityRef } from "@gent/core/extensions/api"

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
  /** Subscribe to every event for the active session/branch. */
  readonly onSessionEvent: (cb: (envelope: EventEnvelope) => void) => () => void
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

// ── request helper ────────────────────────────────────────────────────────

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

type ActiveExtensionSession = { readonly sessionId: SessionId; readonly branchId: BranchId }

const currentOrActiveSession = (
  transport: ClientTransportShape,
  activeSession?: ActiveExtensionSession,
): Effect.Effect<ActiveExtensionSession, NoActiveSessionError> => {
  const session = activeSession ?? transport.currentSession()
  return session === undefined ? Effect.fail(new NoActiveSessionError()) : Effect.succeed(session)
}

const requestExtensionAt = <Input, Output>(
  transport: ClientTransportShape,
  ref: CapabilityRef<Input, Output>,
  input: Input,
  activeSession?: ActiveExtensionSession,
): Effect.Effect<
  Output,
  NoActiveSessionError | ClientTransportRequestError | ClientTransportReplyDecodeError,
  never
> =>
  Effect.gen(function* () {
    const session = yield* currentOrActiveSession(transport, activeSession)
    const reply = yield* Effect.tryPromise({
      try: () =>
        transport.runtime.run(
          transport.client.extension.request({
            sessionId: session.sessionId,
            extensionId: ref.extensionId,
            capabilityId: ref.capabilityId,
            intent: ref.intent,
            input,
            branchId: session.branchId,
          }),
        ),
      catch: (cause) =>
        new ClientTransportRequestError({
          extensionId: ref.extensionId,
          tag: ref.capabilityId,
          message: `request failed: ${String(cause)}`,
          cause,
        }),
    })
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(ref.output)(reply),
      catch: (cause) =>
        new ClientTransportReplyDecodeError({
          extensionId: ref.extensionId,
          tag: ref.capabilityId,
          message: `reply decode failed: ${String(cause)}`,
          cause,
        }),
    })
  })

export function requestExtension<Input, Output>(
  ref: CapabilityRef<Input, Output>,
  input: Input,
): Effect.Effect<
  Output,
  NoActiveSessionError | ClientTransportRequestError | ClientTransportReplyDecodeError,
  ClientTransport
>
export function requestExtension<Input, Output>(
  ref: CapabilityRef<Input, Output>,
  input: Input,
  transport: ClientTransportShape,
  activeSession?: ActiveExtensionSession,
): Effect.Effect<
  Output,
  NoActiveSessionError | ClientTransportRequestError | ClientTransportReplyDecodeError,
  never
>
export function requestExtension<Input, Output>(
  ref: CapabilityRef<Input, Output>,
  input: Input,
  transport?: ClientTransportShape,
  activeSession?: ActiveExtensionSession,
) {
  if (transport !== undefined) return requestExtensionAt(transport, ref, input, activeSession)
  return Effect.gen(function* () {
    const service = yield* ClientTransport
    return yield* requestExtensionAt(service, ref, input)
  })
}
