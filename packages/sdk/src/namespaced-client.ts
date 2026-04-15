import type { Effect, Fiber } from "effect"
import type { RpcClient, RpcGroup } from "effect/unstable/rpc"
import type { GentRpcs } from "@gent/core/server/rpcs.js"
import type {
  GentConnectionError,
  GentLifecycle,
  ConnectionState,
} from "@gent/core/server/transport-contract.js"

// ---------------------------------------------------------------------------
// Flat RPC client (what RpcClient.make returns)
// ---------------------------------------------------------------------------

type FlatRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof GentRpcs>>

// ---------------------------------------------------------------------------
// Namespaced client — splits "namespace.method" keys into nested access
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

export type GentNamespacedClient = NamespacedClient<FlatRpcClient>

// ---------------------------------------------------------------------------
// GentRuntime — execution surface for the caller
// ---------------------------------------------------------------------------

export interface GentRuntime {
  /** Fire-and-forget — run an effect without awaiting result */
  readonly cast: <A, E, R>(effect: Effect.Effect<A, E, R>) => void
  /** Fork with a handle — caller can join/interrupt */
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
  /** Await result as a Promise */
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
  /** Connection lifecycle */
  readonly lifecycle: GentLifecycle
}

export type { GentConnectionError, GentLifecycle, ConnectionState }

// ---------------------------------------------------------------------------
// Proxy factory — builds a GentNamespacedClient from a flat RPC client
// ---------------------------------------------------------------------------

export function makeNamespacedClient(flat: FlatRpcClient): GentNamespacedClient {
  const cache = new Map<string, Record<string, unknown>>()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return new Proxy({} as GentNamespacedClient, {
    get(_target, ns: string) {
      const cached = cache.get(ns)
      if (cached !== undefined) return cached

      const prefix = `${ns}.`
      const methods: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, method: string) {
            const key = `${prefix}${method}`
            return (flat as Record<string, unknown>)[key]
          },
        },
      )
      cache.set(ns, methods)
      return methods
    },
  })
}
