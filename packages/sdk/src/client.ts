import { Effect, Layer, Match, Option, Predicate } from "effect"
import type { Context, Scope } from "effect"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import type { Headers } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import {
  ConnectionState,
  GentConnectionError,
  GentRpcs,
  type GentLifecycle,
  type GentNamespacedClient,
  type GentRpcClient,
  makeNamespacedClient,
} from "@gent/core/protocol"
import {
  makeInProcessClient,
  RpcHandlersLive,
  WORKSPACE_ID_HEADER,
  workspaceHeadersForCwd,
} from "@gent/core/host"
import {
  awaitServerShutdown,
  resolveServer,
  getOwnedInternal,
  state as stateFactories,
  provider as providerFactories,
  type GentServer,
  type GentServerOptions,
} from "./server.js"
// `runtime-boundary.ts` owns the Effect→Promise edge for `GentRuntime.run`.
import { makeGentRuntime as makeRuntime, type GentRuntime } from "./runtime-boundary.js"

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
// In-process transport (internal)
// ---------------------------------------------------------------------------

/** A client that calls the handlers directly, with no socket in between. */
const inProcessBundle = <Services>(
  handlerContext: Context.Context<Layer.Success<typeof RpcHandlersLive>>,
  headers: Headers.Input,
): Effect.Effect<GentClientBundle<Services>, never, Services | Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* makeInProcessClient(handlerContext, headers)
    const services = yield* Effect.context<Services>()
    return {
      client,
      runtime: makeRuntime(
        services,
        staticLifecycle(ConnectionState.cases.Connected.make({ generation: 0 })),
      ),
    }
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

type RpcHandlersContext = Layer.Services<typeof RpcHandlersLive>

export interface GentClientBundle<Services = Scope.Scope> {
  readonly client: GentNamespacedClient
  readonly runtime: GentRuntime<Services>
}

interface GentClientOptions {
  readonly cwd?: string
}

// ---------------------------------------------------------------------------
// Internal: WS connect with reconnection via ConnectionHooks
// ---------------------------------------------------------------------------

/** Connect via WS with lifecycle driven by RPC protocol's ConnectionHooks.
 *  The Effect RPC protocol handles WS reconnection internally — we observe
 *  connect/disconnect via hooks and project onto GentLifecycle. */
const connectWs = (
  url: string,
  headers = workspaceHeadersForCwd(process.cwd()),
): Effect.Effect<GentClientBundle<Scope.Scope>, GentConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    let generation = 0
    let currentState: ConnectionState = ConnectionState.cases.Connecting.make({})
    const listeners = new Set<(state: ConnectionState) => void>()

    const emit = (state: ConnectionState) => {
      currentState = state
      for (const listener of listeners) listener(state)
    }

    const hooksLayer = Layer.succeed(RpcClient.ConnectionHooks, {
      onConnect: Effect.sync(() => {
        emit(ConnectionState.cases.Connected.make({ generation }))
      }),
      onDisconnect: Effect.sync(() => {
        generation++
        emit(ConnectionState.cases.Reconnecting.make({ attempt: generation, generation }))
      }),
    })

    const transport = yield* Layer.buildWithScope(
      WsTransport(url).pipe(Layer.provide(hooksLayer)),
      scope,
    )
    // oxlint-disable-next-line effect/noInlineProvide -- the connection factory owns its scoped transport
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
        if (currentState._tag === "Connected") {
          resume(Effect.void)
          return
        }
        const unsubscribe = lifecycle.subscribe((state) => {
          if (state._tag !== "Connected") return
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
      client: makeNamespacedClient(rpcClient, headers),
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
      return yield* inProcessBundle<R | Scope.Scope>(context, workspaceHeadersForCwd(process.cwd()))
    }),

  /** Composable state spec factories. */
  state: stateFactories,

  /** Composable provider spec factories. */
  provider: providerFactories,

  /** Resolve or start a server. Returns a server handle with a URL. */
  server: (
    options: GentServerOptions,
  ): Effect.Effect<GentServer, GentConnectionError, Scope.Scope> => resolveServer(options),

  /**
   * Block until the server stops. A server started with `idleShutdown`
   * returns after its idle window; every other server blocks forever.
   */
  awaitShutdown: (server: GentServer): Effect.Effect<void> => awaitServerShutdown(server),

  /** Connect to a server. Owned servers use direct RPC; attached servers or RPC URLs use WS. */
  client: (
    serverOrUrl: GentServer | string,
    options?: GentClientOptions,
  ): Effect.Effect<GentClientBundle<Scope.Scope>, GentConnectionError, Scope.Scope> =>
    Effect.gen(function* () {
      if (Predicate.isString(serverOrUrl)) {
        const cwd = Option.fromNullishOr(options?.cwd).pipe(Option.getOrElse(() => process.cwd()))
        return yield* connectWs(serverOrUrl, workspaceHeadersForCwd(cwd))
      }

      return yield* Match.value(serverOrUrl).pipe(
        Match.tagsExhaustive({
          Owned: (ownedServer) =>
            Effect.gen(function* () {
              const internal = yield* Effect.fromOption(getOwnedInternal(ownedServer)).pipe(
                Effect.mapError(
                  () => new GentConnectionError({ message: "owned server internal state missing" }),
                ),
              )
              // Idle shutdown counts clients, and an in-process one opens no
              // socket for the transport tracker to see. Registering here keeps
              // the server alive for as long as this client's scope is open.
              yield* internal.trackInProcessClient
              const headers = Option.fromNullishOr(options?.cwd).pipe(
                Option.match({
                  onNone: () => internal.headers,
                  onSome: workspaceHeadersForCwd,
                }),
              )
              return yield* inProcessBundle<Scope.Scope>(internal.handlerContext, headers)
            }),
          Attached: (attachedServer) =>
            connectWs(attachedServer.url, {
              [WORKSPACE_ID_HEADER]: attachedServer.workspaceId,
            }),
        }),
      )
    }),
}
