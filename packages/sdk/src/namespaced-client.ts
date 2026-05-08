import { Stream, type Effect, type Fiber } from "effect"
import { RpcClient } from "effect/unstable/rpc"
import { Headers } from "effect/unstable/http"
import { GentRpcs, type GentRpcClient } from "@gent/core-internal/server/rpcs.js"
import { ConnectionState } from "@gent/core-internal/server/transport-contract.js"
import type {
  GentConnectionError,
  GentLifecycle,
} from "@gent/core-internal/server/transport-contract.js"

// ---------------------------------------------------------------------------
// Namespaced client — typed nested view over the flat RPC transport
// ---------------------------------------------------------------------------

/**
 * Extract all unique namespace prefixes from a union of dotted string keys.
 * E.g. "session.create" | "branch.list" → "session" | "branch"
 */
type Namespaces<K extends string> = K extends `${infer NS}.${string}` ? NS : never

/**
 * Given a namespace prefix and a flat client, extract the methods under that namespace.
 * "session" + { "session.create": fn, "session.list": fn, "branch.list": fn }
 * → { create: fn, list: fn }
 */
type NamespaceMethods<NS extends string, T> = {
  [K in keyof T as K extends `${NS}.${infer Method}` ? Method : never]: T[K]
}

/**
 * Restructure a flat dotted-key client into nested namespaces.
 * { "session.create": fn, "branch.list": fn } → { session: { create: fn }, branch: { list: fn } }
 */
export type NamespacedClient<T> = {
  readonly [NS in Namespaces<Extract<keyof T, string>>]: Readonly<NamespaceMethods<NS, T>>
}

export type GentNamespacedClient = NamespacedClient<GentRpcClient>
type RpcMethod = (
  ...args: ReadonlyArray<never>
) => Effect.Effect<never, never, never> | Stream.Stream<never, never, never>

// ---------------------------------------------------------------------------
// GentRuntime — execution surface for the caller
// ---------------------------------------------------------------------------

export interface GentRuntime<Services = unknown> {
  /** Fire-and-forget — run an effect without awaiting result */
  readonly cast: <A, E, R extends Services>(effect: Effect.Effect<A, E, R>) => void
  /** Fork with a handle — caller can join/interrupt */
  readonly fork: <A, E, R extends Services>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
  /** Await result as a Promise */
  readonly run: <A, E, R extends Services>(effect: Effect.Effect<A, E, R>) => Promise<A>
  /** Connection lifecycle */
  readonly lifecycle: GentLifecycle
}

export type { GentConnectionError, GentLifecycle }
export { ConnectionState }

// ---------------------------------------------------------------------------
// Adapter factory — builds a GentNamespacedClient from the flat RPC transport
// ---------------------------------------------------------------------------

const rpcKeys = (): ReadonlyArray<string> => [...GentRpcs.requests.keys()]

const splitRpcKey = (key: string) => {
  const separator = key.indexOf(".")
  return separator === -1
    ? { namespace: key, method: undefined }
    : { namespace: key.slice(0, separator), method: key.slice(separator + 1) }
}

const namespaceMethods = (namespace: string): ReadonlyArray<string> =>
  rpcKeys().flatMap((key) => {
    const parsed = splitRpcKey(key)
    return parsed.namespace === namespace && parsed.method !== undefined ? [parsed.method] : []
  })

const makeNamespace = (flat: GentRpcClient, namespace: string, headers?: Headers.Input) => {
  const methods = namespaceMethods(namespace)
  return new Proxy(Object.create(null), {
    get: (_target, property) => {
      if (typeof property !== "string") return undefined
      const method = Reflect.get(flat, `${namespace}.${property}`)
      if (headers === undefined || typeof method !== "function") return method
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Runtime key comes from GentRpcs.requests; wrapping preserves the underlying RPC method shape.
      const call = method as RpcMethod
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The proxy returns the same callable contract with CurrentHeaders attached around the returned Effect or Stream.
      return ((...args: ReadonlyArray<never>) => {
        const result = call(...args)
        return Stream.isStream(result)
          ? Stream.updateService(
              result,
              RpcClient.CurrentHeaders,
              Headers.merge(Headers.fromInput(headers)),
            )
          : RpcClient.withHeaders(result, headers)
      }) as typeof method
    },
    has: (_target, property) => typeof property === "string" && methods.includes(property),
    ownKeys: () => methods,
    getOwnPropertyDescriptor: (_target, property) =>
      typeof property === "string" && methods.includes(property)
        ? { enumerable: true, configurable: true }
        : undefined,
  })
}

export const makeNamespacedClient = (
  flat: GentRpcClient,
  headers?: Headers.Input,
): GentNamespacedClient => {
  const namespaceCache = new Map<string, object>()
  const namespaces = [
    ...new Set(
      rpcKeys().flatMap((key) => {
        const { namespace } = splitRpcKey(key)
        return namespace === "" ? [] : [namespace]
      }),
    ),
  ]
  return new Proxy(Object.create(null), {
    get: (_target, property) => {
      if (typeof property !== "string" || !namespaces.includes(property)) return undefined
      const existing = namespaceCache.get(property)
      if (existing !== undefined) return existing
      const created = makeNamespace(flat, property, headers)
      namespaceCache.set(property, created)
      return created
    },
    has: (_target, property) => typeof property === "string" && namespaces.includes(property),
    ownKeys: () => namespaces,
    getOwnPropertyDescriptor: (_target, property) =>
      typeof property === "string" && namespaces.includes(property)
        ? { enumerable: true, configurable: true }
        : undefined,
  })
}
