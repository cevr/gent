/**
 * TUI-side `ClientTransport` — typed transport surface for client extensions.
 *
 * Core can't declare this with typed payloads because TUI extension transport
 * runs above the SDK. The TUI shell owns the raw SDK client/runtime and
 * publishes only typed extension request/session/event helpers here.
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
 *       const result = yield* requestExtension(ref(MyRpc.List), {})
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

import { Context, Effect, Layer, Option, Schema } from "effect"
import type { GentClientRpcError, GentNamespacedClient, GentRuntime } from "@gent/sdk"
import type { CapabilityRef } from "@gent/core/extensions/api"
import type { BranchId, EventEnvelope, Message, Session, SessionId } from "@gent/core/protocol"

type ActiveExtensionSession = { readonly sessionId: SessionId; readonly branchId: BranchId }

/**
 * Per-loop detail, for one loop at a time.
 *
 * Enumerating every loop must not fan out into N snapshot reads, so listings
 * carry identity and liveness only and a client asks for this separately —
 * for the row a reader is actually looking at. Every field is optional
 * because a session that has never streamed has no model and no cost yet.
 */
export interface ExtensionAgentDetail {
  /** Runtime state tag, e.g. `"Idle"` / `"Running"`. */
  readonly status: Option.Option<string>
  readonly model: Option.Option<string>
  readonly turns: number
  readonly costUsd: number
  readonly durationMs: number
  /** Messages the last projection left out of the model's view; 0 before a turn has run. */
  readonly omittedMessages: number
}

export interface ClientTransportDefinition {
  /** Active (sessionId, branchId) — absent before a session is mounted. */
  // eslint-disable-next-line effect/noNullish -- extension transport preserves an absent active session.
  readonly currentSession: () => ActiveExtensionSession | undefined
  readonly request: <Input, Output>(
    ref: CapabilityRef<Input, Output>,
    input: Input,
    activeSession?: ActiveExtensionSession,
  ) => Effect.Effect<
    Output,
    NoActiveSessionError | ClientTransportRequestError | ClientTransportReplyDecodeError
  >
  /** Subscribe to `ExtensionStateChanged` pulses from the active session.
   *  Returns an unsubscribe function. Multiple subscribers receive each
   *  pulse independently. Widgets use this to invalidate cached state
   *  when their server-side extension publishes a state change. */
  readonly onExtensionStateChanged: (
    cb: (pulse: { sessionId: SessionId; branchId: BranchId; extensionId: string }) => void,
  ) => () => void
  /** Subscribe to every event for the active session/branch. */
  readonly onSessionEvent: (cb: (envelope: EventEnvelope) => void) => () => void
  /**
   * Read live detail for one loop, by explicit key rather than the active
   * session: the caller is asking about a row, which is usually not the
   * session the shell is on.
   */
  readonly agentDetail: (
    key: ActiveExtensionSession,
  ) => Effect.Effect<ExtensionAgentDetail, ClientTransportRequestError>
  /** Delete a session and its descendants; their loops stop and their rows go. */
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, ClientTransportRequestError>
  /** Every stored session, with its parent links. */
  readonly listSessions: Effect.Effect<ReadonlyArray<Session>, ClientTransportRequestError>
  /** Every durable message on one branch, in order. */
  readonly listMessages: (
    branchId: BranchId,
  ) => Effect.Effect<ReadonlyArray<Message>, ClientTransportRequestError>
}

export interface ClientShellTransportDefinition {
  readonly client: GentNamespacedClient
  readonly runtime: GentRuntime
  /** Active (sessionId, branchId) — absent before a session is mounted. */
  // eslint-disable-next-line effect/noNullish -- extension transport preserves an absent active session.
  readonly currentSession: () => ActiveExtensionSession | undefined
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

export class ClientTransport extends Context.Service<ClientTransport, ClientTransportDefinition>()(
  "@gent/tui/src/extensions/client-transport/ClientTransport",
) {}

/**
 * Build a Layer providing `ClientTransport` from a connected `useClient()`
 * result. The input carries shell authority; the provided service does not.
 */
export const makeClientTransportLayer = (
  payload: ClientShellTransportDefinition,
): Layer.Layer<ClientTransport> => {
  const transport: ClientTransportDefinition = {
    currentSession: payload.currentSession,
    request: <Input, Output>(
      ref: CapabilityRef<Input, Output>,
      input: Input,
      activeSession?: ActiveExtensionSession,
    ) => requestExtensionAt(payload, ref, input, activeSession),
    onExtensionStateChanged: payload.onExtensionStateChanged,
    onSessionEvent: payload.onSessionEvent,
    agentDetail: (key) => agentDetailAt(payload, key),
    deleteSession: (sessionId) => deleteSessionAt(payload, sessionId),
    listSessions: shellRead(payload, "session.list", (client) => client.session.list()),
    listMessages: (branchId) =>
      shellRead(payload, "message.list", (client) => client.message.list({ branchId })),
  }
  return Layer.succeed(ClientTransport, transport)
}

// ── request helper ────────────────────────────────────────────────────────

export class NoActiveSessionError extends Schema.TaggedError<NoActiveSessionError>()(
  "NoActiveSessionError",
  {},
) {}

export class ClientTransportRequestError extends Schema.TaggedError<ClientTransportRequestError>()(
  "ClientTransportRequestError",
  {
    extensionId: Schema.String,
    tag: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class ClientTransportReplyDecodeError extends Schema.TaggedError<ClientTransportReplyDecodeError>()(
  "ClientTransportReplyDecodeError",
  {
    extensionId: Schema.String,
    tag: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const currentOrActiveSession = (
  transport: ClientShellTransportDefinition,
  activeSession?: ActiveExtensionSession,
): Effect.Effect<ActiveExtensionSession, NoActiveSessionError> => {
  const session = Option.orElse(Option.fromNullishOr(activeSession), () =>
    Option.fromNullishOr(transport.currentSession()),
  )
  if (Option.isNone(session)) return Effect.fail(new NoActiveSessionError())
  return Effect.succeed(session.value)
}

const requestExtensionAt = <Input, Output>(
  transport: ClientShellTransportDefinition,
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
    return yield* Schema.decodeUnknownEffect(ref.output)(reply).pipe(
      Effect.mapError(
        (cause) =>
          new ClientTransportReplyDecodeError({
            extensionId: ref.extensionId,
            tag: ref.capabilityId,
            message: `reply decode failed: ${String(cause)}`,
            cause,
          }),
      ),
    )
  })

/**
 * Narrow the session snapshot down to the fields a per-loop detail line shows.
 *
 * The snapshot also carries the full projected message list; a detail line has
 * no use for it, so the extension surface never sees it.
 */
const deleteSessionAt = (
  transport: ClientShellTransportDefinition,
  sessionId: SessionId,
): Effect.Effect<void, ClientTransportRequestError> =>
  Effect.tryPromise({
    try: () => transport.runtime.run(transport.client.session.delete({ sessionId })),
    catch: (cause) =>
      new ClientTransportRequestError({
        extensionId: "@gent/tui/client-transport",
        tag: "session.delete",
        message: `session delete failed: ${String(cause)}`,
        cause,
      }),
  }).pipe(Effect.asVoid)

/** One shell RPC read, with its failure named by the RPC it came from. */
const shellRead = <A>(
  transport: ClientShellTransportDefinition,
  tag: string,
  read: (client: GentNamespacedClient) => Effect.Effect<A, GentClientRpcError>,
): Effect.Effect<A, ClientTransportRequestError> =>
  Effect.tryPromise({
    try: () => transport.runtime.run(read(transport.client)),
    catch: (cause) =>
      new ClientTransportRequestError({
        extensionId: "@gent/tui/client-transport",
        tag,
        message: `${tag} failed: ${String(cause)}`,
        cause,
      }),
  })

const agentDetailAt = (
  transport: ClientShellTransportDefinition,
  key: ActiveExtensionSession,
): Effect.Effect<ExtensionAgentDetail, ClientTransportRequestError> =>
  Effect.tryPromise({
    try: () =>
      transport.runtime.run(
        transport.client.session.getSnapshot({
          sessionId: key.sessionId,
          branchId: key.branchId,
        }),
      ),
    catch: (cause) =>
      new ClientTransportRequestError({
        extensionId: "@gent/tui/client-transport",
        tag: "session.getSnapshot",
        message: `agent detail failed: ${String(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.map((snapshot) => ({
      status: Option.some(snapshot.runtime._tag),
      model: Option.some(snapshot.resolvedModelId),
      turns: snapshot.metrics.turns,
      costUsd: snapshot.metrics.costUsd,
      durationMs: snapshot.metrics.durationMs,
      omittedMessages: Option.fromUndefinedOr(snapshot.metrics.context).pipe(
        Option.map((context) => context.omittedMessages),
        Option.getOrElse(() => 0),
      ),
    })),
  )

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
  transport: ClientTransportDefinition,
  activeSession?: ActiveExtensionSession,
): Effect.Effect<
  Output,
  NoActiveSessionError | ClientTransportRequestError | ClientTransportReplyDecodeError,
  never
>
export function requestExtension<Input, Output>(
  ref: CapabilityRef<Input, Output>,
  input: Input,
  transport?: ClientTransportDefinition,
  activeSession?: ActiveExtensionSession,
) {
  const transportOption = Option.fromNullishOr(transport)
  if (Option.isSome(transportOption)) {
    return transportOption.value.request(ref, input, activeSession)
  }
  return Effect.gen(function* () {
    const service = yield* ClientTransport
    return yield* service.request(ref, input)
  })
}
