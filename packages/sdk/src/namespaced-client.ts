import { Option, Stream, type Effect, type Fiber } from "effect"
import { RpcClient } from "effect/unstable/rpc"
import { Headers } from "effect/unstable/http"
import { GentRpcs, type GentRpcClient } from "@gent/core-internal/server/rpcs.js"
import type { GentLifecycle } from "@gent/core-internal/server/transport-contract.js"

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

// ---------------------------------------------------------------------------
// Adapter factory — builds a GentNamespacedClient from the flat RPC transport
// ---------------------------------------------------------------------------

const rpcKeys = (): ReadonlyArray<string> => [...GentRpcs.requests.keys()]

const splitRpcKey = (key: string) => {
  const separator = key.indexOf(".")
  if (separator === -1) return { namespace: key, method: Option.none<string>() }
  return {
    namespace: key.slice(0, separator),
    method: Option.some(key.slice(separator + 1)),
  }
}

const namespaceMethods = (namespace: string): ReadonlyArray<string> =>
  rpcKeys().flatMap((key) => {
    const parsed = splitRpcKey(key)
    if (parsed.namespace === namespace && Option.isSome(parsed.method)) {
      return [parsed.method.value]
    }
    return []
  })

const makeNamespace = (flat: GentRpcClient, namespace: string, headers?: Headers.Input) => {
  const methods = namespaceMethods(namespace)
  const headersOption = Option.fromNullishOr(headers)
  const absent = Option.getOrUndefined(Option.none())
  return new Proxy(Object.create(null), {
    get: (_target, property) => {
      if (typeof property !== "string") return absent
      const method = Reflect.get(flat, `${namespace}.${property}`)
      if (Option.isNone(headersOption) || typeof method !== "function") return method
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Runtime key comes from GentRpcs.requests; wrapping preserves the underlying RPC method shape.
      const call = method as RpcMethod
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The proxy returns the same callable contract with CurrentHeaders attached around the returned Effect or Stream.
      return ((...args: ReadonlyArray<never>) => {
        const result = call(...args)
        if (Stream.isStream(result)) {
          return Stream.updateService(
            result,
            RpcClient.CurrentHeaders,
            Headers.merge(Headers.fromInput(headersOption.value)),
          )
        }
        return RpcClient.withHeaders(result, headersOption.value)
      }) as typeof method
    },
    has: (_target, property) => typeof property === "string" && methods.includes(property),
    ownKeys: () => methods,
    getOwnPropertyDescriptor: (_target, property) => {
      if (typeof property === "string" && methods.includes(property)) {
        return { enumerable: true, configurable: true }
      }
      return absent
    },
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
        if (namespace === "") return []
        return [namespace]
      }),
    ),
  ]
  const absent = Option.getOrUndefined(Option.none())
  return new Proxy(Object.create(null), {
    get: (_target, property) => {
      if (typeof property !== "string" || !namespaces.includes(property)) return absent
      const existing = Option.fromNullishOr(namespaceCache.get(property))
      if (Option.isSome(existing)) return existing.value
      const created = makeNamespace(flat, property, headers)
      namespaceCache.set(property, created)
      return created
    },
    has: (_target, property) => typeof property === "string" && namespaces.includes(property),
    ownKeys: () => namespaces,
    getOwnPropertyDescriptor: (_target, property) => {
      if (typeof property === "string" && namespaces.includes(property)) {
        return { enumerable: true, configurable: true }
      }
      return absent
    },
  })
}
