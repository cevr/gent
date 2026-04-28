import type { Effect, Fiber } from "effect"
import type { GentRpcClient } from "@gent/core/server/rpcs.js"
import type {
  GentConnectionError,
  GentLifecycle,
  ConnectionState,
} from "@gent/core/server/transport-contract.js"

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

export type { GentConnectionError, GentLifecycle, ConnectionState }

// ---------------------------------------------------------------------------
// Adapter factory — builds a GentNamespacedClient from the flat RPC transport
// ---------------------------------------------------------------------------

export const makeNamespacedClient = (flat: GentRpcClient): GentNamespacedClient =>
  ({
    actor: {
      sendUserMessage: flat["actor.sendUserMessage"],
      sendToolResult: flat["actor.sendToolResult"],
      invokeTool: flat["actor.invokeTool"],
      interrupt: flat["actor.interrupt"],
      getState: flat["actor.getState"],
      getMetrics: flat["actor.getMetrics"],
    },
    auth: {
      listProviders: flat["auth.listProviders"],
      setKey: flat["auth.setKey"],
      deleteKey: flat["auth.deleteKey"],
      listMethods: flat["auth.listMethods"],
      authorize: flat["auth.authorize"],
      callback: flat["auth.callback"],
    },
    branch: {
      list: flat["branch.list"],
      create: flat["branch.create"],
      getTree: flat["branch.getTree"],
      switch: flat["branch.switch"],
      fork: flat["branch.fork"],
    },
    driver: {
      list: flat["driver.list"],
      set: flat["driver.set"],
      clear: flat["driver.clear"],
    },
    extension: {
      request: flat["extension.request"],
      listStatus: flat["extension.listStatus"],
      listSlashCommands: flat["extension.listSlashCommands"],
    },
    interaction: {
      respondInteraction: flat["interaction.respondInteraction"],
    },
    message: {
      send: flat["message.send"],
      list: flat["message.list"],
    },
    model: {
      list: flat["model.list"],
    },
    permission: {
      listRules: flat["permission.listRules"],
      deleteRule: flat["permission.deleteRule"],
    },
    queue: {
      drain: flat["queue.drain"],
      get: flat["queue.get"],
    },
    server: {
      status: flat["server.status"],
    },
    session: {
      create: flat["session.create"],
      list: flat["session.list"],
      get: flat["session.get"],
      delete: flat["session.delete"],
      getChildren: flat["session.getChildren"],
      getTree: flat["session.getTree"],
      getSnapshot: flat["session.getSnapshot"],
      updateReasoningLevel: flat["session.updateReasoningLevel"],
      events: flat["session.events"],
      watchRuntime: flat["session.watchRuntime"],
    },
    steer: {
      command: flat["steer.command"],
    },
  }) satisfies GentNamespacedClient
