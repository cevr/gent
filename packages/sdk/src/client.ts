import { Effect, Layer } from "effect"
import type { Scope } from "effect"
import { RpcClient, RpcTest, RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import {
  GentRpcs,
  type GentRpcClient,
  type GentRpcClientError,
  type GentRpcsClient,
} from "@gent/core/server/rpcs.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import {
  ConnectionState,
  GentConnectionError,
  type GentLifecycle,
  type SteerCommand,
  type Session,
  type Branch,
  type BranchTreeNode,
  type SessionSnapshot,
  type SessionRuntime,
  type SessionTreeNode,
  type CreateSessionResult,
  type ExtensionHealth,
  type ExtensionHealthIssue,
  type ExtensionHealthSnapshot,
} from "@gent/core/server/transport-contract.js"
import type { AuthProviderInfo, AuthAuthorization, AuthMethod } from "@gent/core/domain/auth.js"
import type { PermissionRule } from "@gent/core/domain/permission.js"
import type { SessionId, BranchId, MessageId } from "@gent/core/domain/ids.js"
import type {
  Message,
  MessagePart,
  ProjectedMessage,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  ToolInteraction,
} from "@gent/core/domain/message.js"
import {
  messagePartsImages,
  messagePartsReasoning,
  messagePartsText,
} from "@gent/core/domain/message-part-projection.js"
import type { QueueEntryInfo, QueueSnapshot } from "@gent/core/domain/queue.js"
import {
  makeNamespacedClient,
  type GentNamespacedClient,
  type GentRuntime,
} from "./namespaced-client.js"
import {
  resolveServer,
  getOwnedInternal,
  state as stateFactories,
  provider as providerFactories,
  type GentServer,
  type GentServerOptions,
  type StateSpec,
  type ProviderSpec,
} from "./server.js"

export type {
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  PermissionRule,
  AuthProviderInfo,
  AuthAuthorization,
  AuthMethod,
  Message,
  SessionId,
  BranchId,
  MessageId,
  QueueEntryInfo,
  QueueSnapshot,
  ProjectedMessage,
  ToolInteraction,
}
export type {
  GentLifecycle,
  SteerCommand,
  Session,
  Branch,
  BranchTreeNode,
  SessionSnapshot,
  SessionRuntime,
  SessionTreeNode,
  CreateSessionResult,
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
}
export { ConnectionState, GentConnectionError }
export type { GentNamespacedClient, GentRuntime }
export type { GentServer, GentServerOptions, StateSpec, ProviderSpec }

// Re-export RPC types. SDK clients can fail with both server-declared RPC errors
// and transport-level RpcClientError values from the Effect RPC client.
export type { GentRpcClient, GentRpcClientError, GentRpcsClient }
export type GentRpcError = GentRpcClientError

// ---------------------------------------------------------------------------
// Utility functions (unchanged)
// ---------------------------------------------------------------------------

export function extractText(parts: readonly MessagePart[]): string {
  return messagePartsText(parts)
}

export function extractReasoning(parts: readonly MessagePart[]): string {
  return messagePartsReasoning(parts)
}

export interface ImageInfo {
  mediaType: string
}

export function extractImages(parts: readonly MessagePart[]): ImageInfo[] {
  return messagePartsImages(parts).map((image) => ({ mediaType: image.mediaType }))
}

// ---------------------------------------------------------------------------
// Internal: build runtime from captured services + lifecycle
// ---------------------------------------------------------------------------
//
// `makeRuntime` lives in `runtime-boundary.ts` — that module owns the
// Effect→Promise edge for `GentRuntime.run`.

import { makeGentRuntime as makeRuntime } from "./runtime-boundary.js"

// ---------------------------------------------------------------------------
// Static lifecycle for non-supervised connections
// ---------------------------------------------------------------------------

const staticLifecycle = (state: ConnectionState): GentLifecycle => ({
  getState: () => state,
  subscribe: (listener) => {
    listener(state)
    return () => {}
  },
  restart: Effect.fail(
    new GentConnectionError({ message: "restart not supported on this transport" }),
  ),
  waitForReady: Effect.void,
})

// ---------------------------------------------------------------------------
// WebSocket transport (internal)
// ---------------------------------------------------------------------------

const toWsUrl = (httpUrl: string): string => httpUrl.replace(/^http(s?):\/\//, "ws$1://")

const WsTransport = (url: string): Layer.Layer<RpcClient.Protocol> =>
  RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(
      Socket.layerWebSocket(toWsUrl(url)).pipe(
        Layer.tapCause((cause) =>
          Effect.logWarning("ws.client.error").pipe(
            Effect.annotateLogs({ url, error: String(cause) }),
          ),
        ),
      ),
    ),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
  )

// ---------------------------------------------------------------------------
// RPC client assembly (internal)
// ---------------------------------------------------------------------------

const makeRpcClient: Effect.Effect<GentRpcClient, never, RpcClient.Protocol | Scope.Scope> =
  RpcClient.make(GentRpcs)

// ---------------------------------------------------------------------------
// Gent — unified client constructors
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Layer with no requirements should infer the empty service context
type LayerContext<T> = T extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
export type RpcHandlersContext = LayerContext<typeof RpcHandlersLive>

export interface GentClientBundle<Services = Scope.Scope> {
  readonly client: GentNamespacedClient
  readonly runtime: GentRuntime<Services>
}

// ---------------------------------------------------------------------------
// Internal: WS connect with reconnection via ConnectionHooks
// ---------------------------------------------------------------------------

/** Connect via WS with lifecycle driven by RPC protocol's ConnectionHooks.
 *  The Effect RPC protocol handles WS reconnection internally — we observe
 *  connect/disconnect via hooks and project onto GentLifecycle. */
const connectWs = (
  url: string,
): Effect.Effect<GentClientBundle<Scope.Scope>, GentConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    let generation = 0
    let currentState: ConnectionState = ConnectionState.Connecting.make({})
    const listeners = new Set<(state: ConnectionState) => void>()

    const emit = (state: ConnectionState) => {
      currentState = state
      for (const listener of listeners) listener(state)
    }

    const hooksLayer = Layer.succeed(RpcClient.ConnectionHooks, {
      onConnect: Effect.sync(() => {
        emit(ConnectionState.Connected.make({ generation }))
      }),
      onDisconnect: Effect.sync(() => {
        generation++
        emit(ConnectionState.Reconnecting.make({ attempt: generation, generation }))
      }),
    })

    const transport = yield* Layer.buildWithScope(
      WsTransport(url).pipe(Layer.provide(hooksLayer)),
      scope,
    )
    const rpcClient = yield* makeRpcClient.pipe(Effect.provide(transport))
    const services = yield* Effect.context<Scope.Scope>()

    const lifecycle: GentLifecycle = {
      getState: () => currentState,
      subscribe: (listener) => {
        listeners.add(listener)
        listener(currentState)
        return () => {
          listeners.delete(listener)
        }
      },
      restart: Effect.fail(
        new GentConnectionError({
          message: "restart not supported — WS transport reconnects automatically",
        }),
      ),
      waitForReady: Effect.callback<void>((resume, signal) => {
        if (currentState._tag === "connected") {
          resume(Effect.void)
          return
        }
        const unsubscribe = lifecycle.subscribe((state) => {
          if (state._tag !== "connected") return
          unsubscribe()
          resume(Effect.void)
        })
        signal.addEventListener(
          "abort",
          () => {
            unsubscribe()
          },
          { once: true },
        )
        return Effect.sync(unsubscribe)
      }),
    }

    return {
      client: makeNamespacedClient(rpcClient),
      runtime: makeRuntime(services, lifecycle),
    }
  })

// ---------------------------------------------------------------------------
// Gent — public API
// ---------------------------------------------------------------------------

export const Gent = {
  /** In-process client for tests and embedding. */
  test: <E, R>(
    handlersLayer: Layer.Layer<RpcHandlersContext, E, R>,
  ): Effect.Effect<GentClientBundle<R | Scope.Scope>, E, R | Scope.Scope> =>
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provide(RpcHandlersLive, handlersLayer))
      const rpcClient = yield* RpcTest.makeClient(GentRpcs).pipe(Effect.provide(context))
      const services = yield* Effect.context<R | Scope.Scope>()
      return {
        client: makeNamespacedClient(rpcClient),
        runtime: makeRuntime(
          services,
          staticLifecycle(ConnectionState.Connected.make({ generation: 0 })),
        ),
      }
    }),

  /** Composable state spec factories. */
  state: stateFactories,

  /** Composable provider spec factories. */
  provider: providerFactories,

  /** Resolve or start a server. Returns a server handle with a URL. */
  server: (
    options: GentServerOptions,
  ): Effect.Effect<GentServer, GentConnectionError, Scope.Scope> => resolveServer(options),

  /** Connect to a server. Owned servers use direct RPC; attached servers or RPC URLs use WS. */
  client: (
    serverOrUrl: GentServer | string,
  ): Effect.Effect<GentClientBundle<Scope.Scope>, GentConnectionError, Scope.Scope> =>
    Effect.gen(function* () {
      if (typeof serverOrUrl === "string") {
        return yield* connectWs(serverOrUrl)
      }

      switch (serverOrUrl._tag) {
        case "owned": {
          // Direct in-process RPC — zero network
          const internal = getOwnedInternal(serverOrUrl)
          if (internal === undefined) {
            return yield* new GentConnectionError({
              message: "owned server internal state missing",
            })
          }
          const rpcClient = yield* RpcTest.makeClient(GentRpcs).pipe(
            Effect.provide(internal.handlerContext),
          )
          const services = yield* Effect.context<Scope.Scope>()
          return {
            client: makeNamespacedClient(rpcClient),
            runtime: makeRuntime(
              services,
              staticLifecycle(ConnectionState.Connected.make({ generation: 0 })),
            ),
          }
        }
        case "attached":
          return yield* connectWs(serverOrUrl.url)
      }
    }),
} as const
