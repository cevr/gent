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
  GentConnectionError,
  type ConnectionState,
  type GentLifecycle,
  type MessageInfoReadonly,
  type SteerCommand,
  type SessionInfo,
  type BranchInfo,
  type BranchTreeNode,
  type SessionSnapshot,
  type SessionRuntime,
  type SessionTreeNode,
  type CreateSessionResult,
  type ExtensionHealthSnapshot,
} from "@gent/core/server/transport-contract.js"
import { stringifyOutput, summarizeOutput } from "@gent/core/domain/tool-output.js"
import type { AuthProviderInfo } from "@gent/core/domain/auth-guard.js"
import type { PermissionRule } from "@gent/core/domain/permission.js"
import type { AuthAuthorization, AuthMethod } from "@gent/core/domain/auth-method.js"
import type { SessionId, BranchId, MessageId } from "@gent/core/domain/ids.js"
import type {
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
} from "@gent/core/domain/message.js"
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
  SessionId,
  BranchId,
  MessageId,
  QueueEntryInfo,
  QueueSnapshot,
}
export type {
  GentLifecycle,
  ConnectionState,
  MessageInfoReadonly,
  SteerCommand,
  SessionInfo,
  BranchInfo,
  BranchTreeNode,
  SessionSnapshot,
  SessionRuntime,
  SessionTreeNode,
  CreateSessionResult,
  ExtensionHealthSnapshot,
}
export { GentConnectionError }
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
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("")
}

export function extractReasoning(parts: readonly MessagePart[]): string {
  return parts
    .filter((p): p is ReasoningPart => p.type === "reasoning")
    .map((p) => p.text)
    .join("")
}

export interface ImageInfo {
  mediaType: string
}

export function extractImages(parts: readonly MessagePart[]): ImageInfo[] {
  return parts
    .filter((p): p is ImagePart => p.type === "image")
    .map((p) => ({ mediaType: p.mediaType ?? "image" }))
}

type ImagePart = { type: "image"; image: string; mediaType?: string }

export interface ExtractedToolCall {
  id: string
  toolName: string
  status: "running" | "completed" | "error"
  input: unknown | undefined
  summary: string | undefined
  output: string | undefined
}

export function extractToolCalls(parts: readonly MessagePart[]): ExtractedToolCall[] {
  return parts
    .filter((p): p is ToolCallPart => p.type === "tool-call")
    .map((tc) => ({
      id: tc.toolCallId,
      toolName: tc.toolName,
      status: "completed" as const,
      input: tc.input,
      summary: undefined,
      output: undefined,
    }))
}

export function buildToolResultMap(
  messages: readonly MessageInfoReadonly[],
): Map<string, { summary: string; output: string; isError: boolean }> {
  const resultMap = new Map<string, { summary: string; output: string; isError: boolean }>()

  for (const msg of messages) {
    if (msg.role === "tool") {
      for (const part of msg.parts) {
        if (part.type === "tool-result") {
          const result = part as ToolResultPart
          resultMap.set(result.toolCallId, {
            summary: summarizeOutput(result.output),
            output: stringifyOutput(result.output.value),
            isError: result.output.type === "error-json",
          })
        }
      }
    }
  }

  return resultMap
}

export function extractToolCallsWithResults(
  parts: readonly MessagePart[],
  resultMap: Map<string, { summary: string; output: string; isError: boolean }>,
): ExtractedToolCall[] {
  return parts
    .filter((p): p is ToolCallPart => p.type === "tool-call")
    .map((tc) => {
      const result = resultMap.get(tc.toolCallId)
      let status: ExtractedToolCall["status"] = "running"
      if (result !== undefined) status = result.isError ? "error" : "completed"
      return {
        id: tc.toolCallId,
        toolName: tc.toolName,
        status,
        input: tc.input,
        summary: result?.summary,
        output: result?.output,
      }
    })
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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
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
    let currentState: ConnectionState = { _tag: "connecting" }
    const listeners = new Set<(state: ConnectionState) => void>()

    const emit = (state: ConnectionState) => {
      currentState = state
      for (const listener of listeners) listener(state)
    }

    const hooksLayer = Layer.succeed(RpcClient.ConnectionHooks, {
      onConnect: Effect.sync(() => {
        emit({ _tag: "connected", generation })
      }),
      onDisconnect: Effect.sync(() => {
        generation++
        emit({ _tag: "reconnecting", attempt: generation, generation })
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
      waitForReady: Effect.promise<void>((signal) => {
        if (currentState._tag === "connected") {
          return Promise.resolve()
        }
        return new Promise<void>((resolve) => {
          const unsubscribe = lifecycle.subscribe((state) => {
            if (state._tag !== "connected") return
            unsubscribe()
            resolve()
          })
          signal.addEventListener(
            "abort",
            () => {
              unsubscribe()
            },
            { once: true },
          )
        })
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
        runtime: makeRuntime(services, staticLifecycle({ _tag: "connected", generation: 0 })),
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
            runtime: makeRuntime(services, staticLifecycle({ _tag: "connected", generation: 0 })),
          }
        }
        case "attached":
          return yield* connectWs(serverOrUrl.url)
      }
    }),
} as const
