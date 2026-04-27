import { Cause, Effect, Schema } from "effect"
import type { ExtensionScope, LoadedExtension, ExtensionRef } from "../../../domain/extension.js"
import { ExtensionId } from "../../../domain/ids.js"
/** Local FSM-machine alias — kept until B4 deletes MachineEngine + the FSM
 *  spawn path. Public `Resource.machine` type was removed in W10-PhaseB/B3. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- transitional alias for unreachable FSM spawn map
export type AnyResourceMachine = any
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

export interface ActorEntry {
  readonly ref: ExtensionRef
  readonly actor?: AnyResourceMachine
}

export interface ActorSpawnSpec {
  readonly extensionId: ExtensionId
  readonly scope: ExtensionScope
  readonly actor: AnyResourceMachine
}

/**
 * Routing entry for an actor-only extension (no `Resource.machine`,
 * uses the `actors:` contribution bucket). `MachineEngine` consults
 * this map when `findEntry` returns no FSM-backed `ActorEntry` and
 * falls back to `ActorEngine` discovery via the `serviceKey` —
 * that's how ExtensionMessages reach a Behavior-backed state-holder
 * without an FSM dispatch path.
 *
 * `serviceKey` is the same handle the Behavior registers with the
 * Receptionist at spawn-time, so callers always see whichever live
 * actor the host spawned (profile-scoped today; per-session can be
 * layered in later by adding a session-scoped Receptionist surface).
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

export interface CollectedMachineProtocol {
  readonly spawnSpecs: ReadonlyArray<ActorSpawnSpec>
  readonly spawnByExtension: ReadonlyMap<string, ActorSpawnSpec>
  /** Routes for actor-only extensions, keyed by extension id. Built from
   *  the `actors:` bucket of extensions that do NOT also contribute an
   *  FSM (FSM wins by precedence — actor-only is a lower-rank fallback). */
  readonly actorRoutes: ReadonlyMap<string, ActorBackedRoute>
  /** Scopes that were shadowed out by a higher-precedence extension of the
   *  same id. Debug-logged at engine init; useful for diagnosing "why isn't
   *  my override running?". Does not affect dispatch. */
  readonly shadowedScopesByExtension: ReadonlyMap<string, ReadonlyArray<ExtensionScope>>
  readonly protocols: MachineProtocol
}

/** `Resource.machine` was deleted in W10-PhaseB/B3 — every extension is
 *  actor-only now. The FSM-supervised path in MachineEngine becomes
 *  unreachable; this helper exists only until B4 deletes MachineEngine
 *  entirely. */
export const extractMachine = (_ext: LoadedExtension): AnyResourceMachine | undefined => undefined

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

  decodeMailboxReply<M extends AnyExtensionRequestMessage>(
    result: unknown | ExtensionProtocolError,
  ): Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError> {
    if (Schema.is(ExtensionProtocolError)(result)) return Effect.fail(result)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- protocol adapter narrows schema-checked wire shape
    return Effect.succeed(result as ExtractExtensionReply<M>)
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

/** Routing table for actor-only extensions. Walks each extension's
 *  `actors:` bucket and picks the first behavior whose `serviceKey` is
 *  declared — that's the handle MachineEngine uses to find a live
 *  ActorRef via the Receptionist. Extensions that already contribute an
 *  FSM (`Resource.machine`) are skipped: FSM dispatch is the higher-
 *  precedence path, and the routing-table fallback only fires when no
 *  FSM entry exists for the requested extension id.
 *
 *  Picking only ONE behavior per extension is intentional: an extension
 *  can declare multiple actors for internal decomposition, but the
 *  ExtensionMessage surface is per-extension, so exactly one behavior
 *  owns the protocol-handling role. Authors mark it by declaring its
 *  `serviceKey`. Behaviors without a `serviceKey` are private workers
 *  discoverable only by their declaring extension. */
const collectActorRoutes = (
  extensions: ReadonlyArray<LoadedExtension>,
): Map<string, ActorBackedRoute> => {
  const actorRoutes = new Map<string, ActorBackedRoute>()
  for (const ext of extensions) {
    if (extractMachine(ext) !== undefined) continue

    // Source 1: explicit `actorRoute` — declared when the protocol
    // actor is spawned outside `actors:` (e.g. in `Resource.start` so
    // services can be captured into closure). The actor itself is
    // invisible to the static contribution scan, so the extension
    // points at the serviceKey directly.
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

    // Source 2: `actors:` bucket — the host owns spawn lifecycle, the
    // route is read off the first behavior with a `serviceKey`.
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

/** Resolve `(extensionId) → machine + protocol` by scope precedence
 *  (`builtin < user < project`). Two extensions sharing an id at different
 *  scopes are NOT spawned as separate actors — the highest-scope entry wins
 *  the actor + its protocol bundle, and lower-scope shadows are dropped
 *  (with a debug log). This matches how capabilities/drivers/agents resolve
 *  in `registry.ts`; without it, both actors spawn and dispatch finds the
 *  builtin (first match) while decode runs against the project protocol. */
export const collectMachineProtocol = (
  extensions: ReadonlyArray<LoadedExtension>,
): CollectedMachineProtocol => {
  // Pick one winner per extensionId, respecting scope precedence. Iteration
  // order of the input is not trusted — we resolve explicitly.
  const winnerByExtension = new Map<string, LoadedExtension>()
  const shadowedByExtension = new Map<string, ExtensionScope[]>()
  for (const ext of extensions) {
    if (extractMachine(ext) === undefined) continue
    const current = winnerByExtension.get(ext.manifest.id)
    if (current === undefined) {
      winnerByExtension.set(ext.manifest.id, ext)
      continue
    }
    const incomingRank = SCOPE_PRECEDENCE[ext.scope]
    const currentRank = SCOPE_PRECEDENCE[current.scope]
    if (incomingRank > currentRank) {
      const shadows = shadowedByExtension.get(ext.manifest.id) ?? []
      winnerByExtension.set(ext.manifest.id, ext)
      shadowedByExtension.set(ext.manifest.id, [...shadows, current.scope])
    } else {
      const shadows = shadowedByExtension.get(ext.manifest.id) ?? []
      shadowedByExtension.set(ext.manifest.id, [...shadows, ext.scope])
    }
  }

  const spawnSpecs: ActorSpawnSpec[] = []
  const spawnByExtension = new Map<string, ActorSpawnSpec>()
  const protocolMap = new Map<string, Map<string, AnyExtensionMessageDefinition>>()
  for (const ext of winnerByExtension.values()) {
    const actor = extractMachine(ext)
    if (actor === undefined) continue
    const spec: ActorSpawnSpec = {
      extensionId: ext.manifest.id,
      scope: ext.scope,
      actor,
    }
    spawnSpecs.push(spec)
    spawnByExtension.set(ext.manifest.id, spec)

    const allDefs =
      actor.protocols !== undefined ? listExtensionProtocolDefinitions(actor.protocols) : []
    for (const definition of allDefs) {
      const byTag = protocolMap.get(definition.extensionId) ?? new Map()
      byTag.set(definition._tag, definition)
      protocolMap.set(definition.extensionId, byTag)
    }
  }

  // Actor-only extensions declare protocols on the contributions bucket
  // because they have no FSM `actor:` field to carry them. Source those
  // here so dispatch decoding (`MachineProtocol.decodeCommand` /
  // `decodeRequest`) finds the definition regardless of which primitive
  // owns the state. Iteration walks `extensions` (not `winnerByExtension`)
  // because actor-only extensions never made it into the winner map —
  // that map is keyed off `extractMachine`. Scope precedence still
  // applies: a higher-scope FSM that also declares a protocol entry
  // shadows the actor-only registration. `byTag.has` enforces that.
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

  const actorRoutes = collectActorRoutes(extensions)

  return {
    spawnSpecs,
    spawnByExtension,
    actorRoutes,
    shadowedScopesByExtension: shadowedByExtension,
    protocols: new MachineProtocol({
      get: (extensionId, tag) => protocolMap.get(extensionId)?.get(tag),
    }),
  }
}
