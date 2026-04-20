/**
 * RuntimeComposer — typed builder for composition-root layers.
 *
 * Replaces the hand-maintained 14-item `Context.omit(...)` list in
 * `agent-runner.ts` with a single source of truth: the list of services the
 * composer `.own(...)`s drives both the parent-omit set and the merge
 * precedence. Adding a new ephemeral-local service requires updating one
 * place; the omit-list drift bug class becomes structural.
 *
 * The composer is the only sanctioned way to construct an
 * {@link EphemeralProfile}. Callers that want to forge a profile via raw
 * `Layer.succeedContext` would also need to forge an `EphemeralScope` brand,
 * which lint rule `gent/brand-constructor-callers` fences to a single file.
 *
 * The `parent: ServerProfile` argument is a type-level proof-of-origin; the
 * composer requires a server-scoped parent to construct an ephemeral child.
 * Cross-scope composition (cwd → ephemeral, ephemeral → ephemeral) does not
 * type-check because the brand types do not unify.
 *
 * Generics: the builder accumulates the service-identifier union of all
 * `.own(...)` and `.merge(...)` calls into the built layer's `Provides`
 * channel. A consumer that requires a service NOT in that union fails to
 * type-check at the `Effect.provide(layer)` call site — exactly the bite
 * the omit-list workaround was emulating informally.
 *
 * Usage:
 *
 * ```ts
 * const ephemeral = RuntimeComposer
 *   .ephemeral({ parent: parentProfile, parentServices })
 *   .own(ownService(Storage, storageLayer), ownService(EventStore, esLayer))
 *   .merge(extensionLayers)
 *   .build()                              // EphemeralProfile + typed Layer
 * ```
 *
 * @module
 */

import { Context, Layer } from "effect"
import { brandEphemeralScope, type EphemeralProfile, type ServerProfile } from "./scope-brands.js"
import { Storage } from "../storage/sqlite-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { EventStorage } from "../storage/event-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import { ExtensionStateStorage } from "../storage/extension-state-storage.js"
import { BaseEventStore, EventStore } from "../domain/event.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { ApprovalService } from "./approval-service.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { ResourceManager } from "./resource-manager.js"
import { ToolRunner } from "./agent/tool-runner.js"
import { AgentLoop } from "./agent/agent-loop.js"

/**
 * A typed handle to a service-layer pair. Pairs a `Context.Key` with the
 * `Layer` that produces it, so the composer can compute the parent-omit set
 * (from the key) and the merge order (from the layer).
 *
 * Helper: `ownService(Tag, layer)` produces an `OwnedService` value.
 */
export interface OwnedService<I, S, E, R> {
  readonly tag: Context.Key<I, S>
  readonly layer: Layer.Layer<I, E, R>
}

/**
 * Pair a `Context.Key` with the layer that provides it.
 *
 * The pair is the unit the composer's `.own(...)` consumes. Callers do not
 * touch the brand directly — the composer threads it through.
 */
export const ownService = <I, S, E, R>(
  tag: Context.Key<I, S>,
  layer: Layer.Layer<I, E, R>,
): OwnedService<I, S, E, R> => ({ tag, layer })

/** Inputs to `RuntimeComposer.ephemeral`. */
export interface EphemeralComposerInputs {
  /** Type-level proof: parent must be a server-scoped profile. */
  readonly parent: ServerProfile
  /** Parent's resolved service map, captured via `Effect.context()` at the runner site. */
  readonly parentServices: Context.Context<never>
}

// ── Internal opaque layer alias ───────────────────────────────────────────
// At the composer's storage layer (the array of accumulated layers), we
// erase R/E to a single shape so heterogeneous layers can be held together.
// The build() output recovers the user-visible `Provides` union via the
// builder's type parameter; only the internal store uses `unknown` here.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpaqueLayer = Layer.Layer<any, any, any>

/**
 * Builder produced by {@link RuntimeComposer.ephemeral}. Each `.own(...)`
 * widens the accumulated `Provides` union; `.build()` returns a layer typed
 * `Layer<Provides, never, never>`.
 */
/** Extract the `Provides` (Identifier) channel from each `OwnedService` in a tuple. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProvidesOf<Services extends ReadonlyArray<OwnedService<any, any, any, any>>> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof Services]: Services[K] extends OwnedService<infer I, any, any, any> ? I : never
}[number]

/**
 * Named override fields for `.withOverrides(...)`. Each field maps to one
 * or more Context.Service Tags that the compositor omits from the parent.
 *
 * The Tag-set mapping lives in `OVERRIDE_TAG_SETS` — callers only provide
 * layers, the compositor derives the omit list. This is what makes the
 * sub-Tag problem structural: adding a Storage sub-Tag requires updating
 * ONE mapping, not every callsite that constructs an ephemeral layer.
 */
export interface EphemeralOverrides {
  /** In-memory storage for ephemeral child. Omits Storage + all 6 sub-Tags. */
  readonly storage?: OpaqueLayer
  /** Event store for ephemeral child. Omits EventStore + BaseEventStore. */
  readonly eventStore?: OpaqueLayer
  /** Event publisher wired to local bus. Omits EventPublisher. */
  readonly eventPublisher?: OpaqueLayer
  /** Approval service (typically auto-resolve for child agents). Omits ApprovalService. */
  readonly approval?: OpaqueLayer
  /** Prompt presenter wired to local approval. Omits PromptPresenter. */
  readonly promptPresenter?: OpaqueLayer
  /** Resource manager (named semaphores). Omits ResourceManager. */
  readonly resourceManager?: OpaqueLayer
  /** Tool runner wired to local deps. Omits ToolRunner. */
  readonly toolRunner?: OpaqueLayer
  /** Agent loop wired to local deps. Omits AgentLoop. */
  readonly loop?: OpaqueLayer
}

/**
 * Union of all service identifiers that `withOverrides` can contribute.
 * Used to widen the builder's `Provides` channel so consumers that
 * yield overridden services have their `R` channel correctly satisfied.
 */
type EphemeralOverrideProvides =
  | Storage
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | EventStorage
  | RelationshipStorage
  | ExtensionStateStorage
  | EventStore
  | BaseEventStore
  | EventPublisher
  | ApprovalService
  | PromptPresenter
  | ResourceManager
  | ToolRunner
  | AgentLoop

/**
 * Maps each override field to the complete set of Tags it should omit from
 * the parent context. This is the single source of truth for sub-Tag
 * awareness — the compositor derives the omit set from this mapping.
 */
const OVERRIDE_TAG_SETS: Record<
  keyof EphemeralOverrides,
  ReadonlyArray<Context.Key<unknown, unknown>>
> = {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  storage: [
    Storage,
    SessionStorage,
    BranchStorage,
    MessageStorage,
    EventStorage,
    RelationshipStorage,
    ExtensionStateStorage,
  ] as unknown as ReadonlyArray<Context.Key<unknown, unknown>>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  eventStore: [EventStore, BaseEventStore] as unknown as ReadonlyArray<
    Context.Key<unknown, unknown>
  >,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  eventPublisher: [EventPublisher] as unknown as ReadonlyArray<Context.Key<unknown, unknown>>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  approval: [ApprovalService] as unknown as ReadonlyArray<Context.Key<unknown, unknown>>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  promptPresenter: [PromptPresenter] as unknown as ReadonlyArray<Context.Key<unknown, unknown>>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  resourceManager: [ResourceManager] as unknown as ReadonlyArray<Context.Key<unknown, unknown>>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  toolRunner: [ToolRunner] as unknown as ReadonlyArray<Context.Key<unknown, unknown>>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  loop: [AgentLoop] as unknown as ReadonlyArray<Context.Key<unknown, unknown>>,
}

export interface EphemeralComposerBuilder<Provides> {
  /**
   * Claim one or more services as ephemeral-local. Each entry contributes
   * both an omit-from-parent key and an override layer; the built layer's
   * `Provides` channel widens with the union of every owned identifier.
   *
   * R/E channels of the owned layers are erased at the composer boundary;
   * any unresolved requirements are satisfied by the parent context at
   * provide time. Authors should `Layer.provide`-resolve obvious deps
   * before owning, but the composer does not structurally enforce that the
   * requirement channel is fully discharged (doing so would force every
   * parent-supplied dep into the composer's signature, which defeats the
   * "single source of truth" purpose).
   */
  readonly own: <
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Services extends ReadonlyArray<OwnedService<any, any, any, any>>,
  >(
    ...services: Services
  ) => EphemeralComposerBuilder<Provides | ProvidesOf<Services>>

  /**
   * Add a Layer that contributes services not pinned to a single key (e.g.
   * `extensionLayers`, which fans out into many service identifiers).
   *
   * The new identifiers join the `Provides` union but are NOT added to the
   * parent-omit set — `.merge(...)` is for layers whose parent presence is
   * benign (or whose Layer-level merge order already wins). Use `.own(...)`
   * for keys whose parent instance must be stripped.
   *
   * R/E channels of the merged layer are erased at the composer boundary;
   * any unresolved requirements are satisfied by the parent context at
   * provide time.
   */
  readonly merge: <I, E, R>(layer: Layer.Layer<I, E, R>) => EphemeralComposerBuilder<Provides | I>

  /**
   * Declare ephemeral-local overrides by named field. Each field maps to a
   * layer AND the complete set of Tags to omit from the parent — including
   * sub-Tags (e.g., `storage` omits `Storage` + all 6 sub-Tag services).
   *
   * This is the high-level API; `.own(...)` is low-level. Use
   * `.withOverrides(...)` for standard ephemeral child construction.
   *
   * Widens `Provides` with ALL override Tags so downstream consumers that
   * yield overridden services have their `R` channel correctly satisfied.
   */
  readonly withOverrides: (
    overrides: EphemeralOverrides,
  ) => EphemeralComposerBuilder<Provides | EphemeralOverrideProvides>

  /**
   * Build the merged `Layer` and produce an {@link EphemeralProfile} handle.
   *
   * `Layer.fresh` is applied so the parent's `MemoMap` cannot replay
   * already-built parent layers when the child re-requests them.
   */
  readonly build: () => {
    readonly profile: EphemeralProfile
    readonly layer: Layer.Layer<Provides, never, never>
  }
}

// ── Internal state (R/E erased) ───────────────────────────────────────────

interface EphemeralComposerState {
  readonly parent: ServerProfile
  readonly parentServices: Context.Context<never>
  readonly ownedKeys: ReadonlyArray<Context.Key<unknown, unknown>>
  readonly ownedLayers: ReadonlyArray<OpaqueLayer>
  readonly mergedLayers: ReadonlyArray<OpaqueLayer>
}

const omitContext = (
  ctx: Context.Context<never>,
  keys: ReadonlyArray<Context.Key<unknown, unknown>>,
): Context.Context<never> => {
  if (keys.length === 0) return ctx
  // `Context.omit` is variadic over keys; we trampoline the spread to keep
  // the runtime call simple and the type assertion narrow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  return Context.omit(...(keys as Array<any>))(ctx) as Context.Context<never>
}

const makeBuilder = <Provides>(state: EphemeralComposerState): EphemeralComposerBuilder<Provides> =>
  ({
    own: (...services) => {
      const newKeys: ReadonlyArray<Context.Key<unknown, unknown>> = [
        ...state.ownedKeys,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        ...services.map((s) => s.tag as Context.Key<unknown, unknown>),
      ]
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — composer R/E erased
      const newLayers: ReadonlyArray<OpaqueLayer> = [
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off — composer R/E erased
        ...state.ownedLayers,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        ...services.map((s) => s.layer as OpaqueLayer),
      ]
      return makeBuilder({
        ...state,
        ownedKeys: newKeys,
        ownedLayers: newLayers,
      })
    },
    merge: (layer) =>
      makeBuilder({
        ...state,
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off — composer R/E erased
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        mergedLayers: [...state.mergedLayers, layer as OpaqueLayer],
      }),
    withOverrides: (overrides) => {
      const extraKeys: Context.Key<unknown, unknown>[] = []
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — composer R/E erased
      const extraLayers: OpaqueLayer[] = []
      const addOverride = (field: keyof EphemeralOverrides) => {
        const layer = overrides[field]
        if (layer === undefined) return
        extraKeys.push(...OVERRIDE_TAG_SETS[field])
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off — composer R/E erased
        extraLayers.push(layer)
      }
      addOverride("storage")
      addOverride("eventStore")
      addOverride("eventPublisher")
      addOverride("approval")
      addOverride("promptPresenter")
      addOverride("resourceManager")
      addOverride("toolRunner")
      addOverride("loop")
      return makeBuilder({
        ...state,
        ownedKeys: [...state.ownedKeys, ...extraKeys],
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off — composer R/E erased
        ownedLayers: [...state.ownedLayers, ...extraLayers],
      })
    },
    build: () => {
      const { parent, parentServices, ownedKeys, ownedLayers, mergedLayers } = state
      // Strip owned keys AND `Layer.CurrentMemoMap` from the parent's
      // forwarded context. Owned-key omission keeps the parent's *resolved
      // service instances* from bleeding through when the child re-requests
      // them; MemoMap omission keeps the parent's memoised layer-build
      // results from being replayed (the parent's `EventPublisherLive`
      // layer object is `===` to the child's, so its build is in the parent
      // memo). `Layer.fresh` below is defense-in-depth for the same memo.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const memoKey = Layer.CurrentMemoMap as unknown as Context.Key<unknown, unknown>
      const omittedParentLayer = Layer.succeedContext(
        omitContext(parentServices, [...ownedKeys, memoKey]),
      )

      // Merge order (last wins on tag conflict):
      //   parent (without owned keys) → merged → owned overrides
      // The cast to OpaqueLayer is the documented composer boundary; the
      // user-visible `Provides` union is recovered by the builder type
      // parameter and applied at the final return.
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — composer R/E erased
      const allLayers: ReadonlyArray<OpaqueLayer> = [
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        omittedParentLayer as unknown as OpaqueLayer,
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off — composer R/E erased
        ...mergedLayers,
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off — composer R/E erased
        ...ownedLayers,
      ]
      const merged: OpaqueLayer =
        allLayers.length === 1
          ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            allLayers[0]!
          : Layer.mergeAll(
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              allLayers[0]!,
              ...allLayers.slice(1),
            )

      // Wrap in `Layer.fresh` so the parent's MemoMap cannot return memoised
      // parent-built layers when the child re-requests them. Cast to the
      // builder's accumulated `Provides` channel — the composer guarantees
      // every owned/merged service identifier is in the layer.
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — composer recovers Provides at this boundary
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const layer = Layer.fresh(merged) as Layer.Layer<Provides, never, never>

      // The profile is a data carrier; the live `Scope.Scope` for the
      // ephemeral run is acquired by `Effect.scoped` at the runner site.
      const profile = brandEphemeralScope({
        cwd: parent.cwd,
        resolved: parent.resolved,
      })
      return { profile, layer }
    },
  }) as EphemeralComposerBuilder<Provides>

/**
 * Composition-root builders, keyed by the scope they produce.
 *
 * Today only `.ephemeral(...)` is implemented (the C1 target). Server and
 * cwd composition roots stay on direct construction in their respective
 * files (`server/dependencies.ts`, `runtime/session-profile.ts`); their
 * brands attach via `brandServerScope` / `brandCwdScope` (lint-fenced).
 */
export const RuntimeComposer = {
  ephemeral: (inputs: EphemeralComposerInputs): EphemeralComposerBuilder<never> =>
    makeBuilder({
      parent: inputs.parent,
      parentServices: inputs.parentServices,
      ownedKeys: [],
      ownedLayers: [],
      mergedLayers: [],
    }),
}
