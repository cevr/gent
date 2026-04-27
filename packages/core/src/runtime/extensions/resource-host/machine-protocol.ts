import { Cause, Effect, Schema } from "effect"
import type { ExtensionScope, LoadedExtension } from "../../../domain/extension.js"
import { ExtensionId } from "../../../domain/ids.js"
import type { ServiceKey } from "../../../domain/actor.js"
import { SCOPE_PRECEDENCE } from "../disabled.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionMessageDefinition,
  AnyExtensionRequestDefinition,
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
} from "../../../domain/extension-protocol.js"
import {
  ExtensionProtocolError,
  isExtensionRequestDefinition,
  listExtensionProtocolDefinitions,
} from "../../../domain/extension-protocol.js"

/**
 * Routing entry for an actor-backed extension. The engine consults
 * this map to find the live `ActorRef` via the Receptionist using the
 * `serviceKey` declared on the Behavior or via the `actorRoute`
 * contribution. Every loaded extension that exposes an `ExtensionMessage`
 * surface MUST have an entry here — this is the only dispatch path now
 * that `Resource.machine` is gone.
 */
export interface ActorBackedRoute {
  readonly extensionId: ExtensionId
  readonly scope: ExtensionScope
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- routing table erases the message-shape phantom
  readonly serviceKey: ServiceKey<any>
}

interface ExtensionProtocolRegistry {
  readonly get: (extensionId: string, tag: string) => AnyExtensionMessageDefinition | undefined
}

export interface CollectedExtensionProtocol {
  /** Routes for every actor-backed extension, keyed by extension id. */
  readonly actorRoutes: ReadonlyMap<string, ActorBackedRoute>
  readonly protocols: MachineProtocol
}

export const protocolError = (
  extensionId: string,
  tag: string,
  phase: "command" | "request" | "reply",
  message: string,
) =>
  new ExtensionProtocolError({
    extensionId: ExtensionId.make(extensionId),
    tag,
    phase,
    message,
  })

export const getProtocolFailure = (
  cause: Cause.Cause<unknown>,
): ExtensionProtocolError | undefined => {
  const failure = cause.reasons.find(Cause.isFailReason)
  return failure !== undefined && Schema.is(ExtensionProtocolError)(failure.error)
    ? failure.error
    : undefined
}

export class MachineProtocol {
  readonly #registry: ExtensionProtocolRegistry

  constructor(registry: ExtensionProtocolRegistry) {
    this.#registry = registry
  }

  get(extensionId: string, tag: string): AnyExtensionMessageDefinition | undefined {
    return this.#registry.get(extensionId, tag)
  }

  decodeCommand(
    message: AnyExtensionCommandMessage,
  ): Effect.Effect<AnyExtensionCommandMessage, ExtensionProtocolError> {
    return this.#decodeMessage(message, "command")
  }

  decodeRequest<M extends AnyExtensionRequestMessage>(
    message: M,
  ): Effect.Effect<M, ExtensionProtocolError> {
    return this.#decodeMessage(message, "request")
  }

  requireRequestDefinition(
    extensionId: string,
    tag: string,
  ): Effect.Effect<AnyExtensionRequestDefinition, ExtensionProtocolError> {
    const definition = this.get(extensionId, tag)
    if (definition !== undefined && isExtensionRequestDefinition(definition)) {
      return Effect.succeed(definition)
    }
    return Effect.fail(
      protocolError(
        extensionId,
        tag,
        "request",
        `extension "${extensionId}" request "${tag}" is not registered`,
      ),
    )
  }

  decodeReply<A>(
    extensionId: string,
    tag: string,
    schema: Schema.Codec<A, unknown, never, never>,
    value: unknown,
  ): Effect.Effect<A, ExtensionProtocolError> {
    return Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.catchIf(Schema.isSchemaError, () =>
        Schema.encodeUnknownEffect(schema)(value).pipe(
          Effect.flatMap((encoded) => Schema.decodeUnknownEffect(schema)(encoded)),
        ),
      ),
      Effect.mapError((error) => protocolError(extensionId, tag, "reply", error.message)),
    )
  }

  decodeRequestReply<M extends AnyExtensionRequestMessage>(
    message: M,
    schema: Schema.Codec<unknown, unknown, never, never>,
    value: unknown,
  ): Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError> {
    return this.decodeReply(message.extensionId, message._tag, schema, value).pipe(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
      Effect.map((reply) => reply as ExtractExtensionReply<M>),
    )
  }

  #decodeMessage<M extends AnyExtensionCommandMessage | AnyExtensionRequestMessage>(
    message: M,
    expectedKind: "command" | "request",
  ): Effect.Effect<M, ExtensionProtocolError> {
    const registry = this.#registry
    return Effect.gen(function* () {
      const definition = registry.get(message.extensionId, message._tag)
      if (definition === undefined) {
        return yield* protocolError(
          message.extensionId,
          message._tag,
          expectedKind,
          `extension "${message.extensionId}" has no protocol definition for "${message._tag}"`,
        )
      }
      const actualKind = isExtensionRequestDefinition(definition) ? "request" : "command"
      if (actualKind !== expectedKind) {
        return yield* protocolError(
          message.extensionId,
          message._tag,
          expectedKind,
          `extension "${message.extensionId}" message "${message._tag}" is registered as a ${actualKind}, not a ${expectedKind}`,
        )
      }
      return yield* Schema.decodeUnknownEffect(definition.schema)(message).pipe(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
        Effect.map((value) => value as M),
        Effect.mapError((error) =>
          protocolError(message.extensionId, message._tag, expectedKind, error.message),
        ),
      )
    })
  }
}

/**
 * Build the actor-route table. Picks the highest-precedence
 * `(scope, behavior)` per extension id, sourcing from either the
 * explicit `actorRoute` contribution (for actors spawned outside the
 * static `actors:` bucket — e.g. from `Resource.start`) or the first
 * `actors:` behavior with a `serviceKey`.
 *
 * Picking only ONE behavior per extension is intentional: an extension
 * can declare multiple actors for internal decomposition, but the
 * ExtensionMessage surface is per-extension, so exactly one behavior
 * owns the protocol-handling role. Behaviors without a `serviceKey`
 * are private workers discoverable only by their declaring extension.
 */
const collectActorRoutes = (
  extensions: ReadonlyArray<LoadedExtension>,
): Map<string, ActorBackedRoute> => {
  const actorRoutes = new Map<string, ActorBackedRoute>()
  for (const ext of extensions) {
    const explicit = ext.contributions.actorRoute
    if (explicit !== undefined) {
      const existing = actorRoutes.get(ext.manifest.id)
      if (
        existing === undefined ||
        SCOPE_PRECEDENCE[ext.scope] > SCOPE_PRECEDENCE[existing.scope]
      ) {
        actorRoutes.set(ext.manifest.id, {
          extensionId: ext.manifest.id,
          scope: ext.scope,
          serviceKey: explicit,
        })
      }
      continue
    }

    const behaviors = ext.contributions.actors ?? []
    for (const b of behaviors) {
      if (b.serviceKey === undefined) continue
      const existing = actorRoutes.get(ext.manifest.id)
      if (
        existing === undefined ||
        SCOPE_PRECEDENCE[ext.scope] > SCOPE_PRECEDENCE[existing.scope]
      ) {
        actorRoutes.set(ext.manifest.id, {
          extensionId: ext.manifest.id,
          scope: ext.scope,
          serviceKey: b.serviceKey,
        })
      }
      break
    }
  }
  return actorRoutes
}

/**
 * Walk all loaded extensions and assemble (a) the actor-route table
 * (live `serviceKey` per extension id) and (b) the protocol registry
 * for ExtensionMessage decode. Replaces the FSM-aware
 * `collectMachineProtocol` after `Resource.machine` was deleted in
 * W10-PhaseB/B3.
 */
export const collectExtensionProtocol = (
  extensions: ReadonlyArray<LoadedExtension>,
): CollectedExtensionProtocol => {
  const protocolMap = new Map<string, Map<string, AnyExtensionMessageDefinition>>()
  for (const ext of extensions) {
    const protocols = ext.contributions.protocols
    if (protocols === undefined) continue
    const allDefs = listExtensionProtocolDefinitions(protocols)
    for (const definition of allDefs) {
      const byTag = protocolMap.get(definition.extensionId) ?? new Map()
      if (!byTag.has(definition._tag)) {
        byTag.set(definition._tag, definition)
        protocolMap.set(definition.extensionId, byTag)
      }
    }
  }

  return {
    actorRoutes: collectActorRoutes(extensions),
    protocols: new MachineProtocol({
      get: (extensionId, tag) => protocolMap.get(extensionId)?.get(tag),
    }),
  }
}
