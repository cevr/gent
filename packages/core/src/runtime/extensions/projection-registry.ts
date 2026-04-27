/**
 * ProjectionRegistry — evaluates `ProjectionContribution[]` on demand.
 *
 * Projections are flat; there is no per-event reduction step. The registry
 * exposes one evaluator (`evaluateTurn`) for prompt/policy contributions,
 * plus a `query(extensionId, projectionId, ctx)` for direct lookup.
 *
 * UI projection is gone — client widgets read state via the extension's
 * typed `client.extension.request(...)` and refetch on `ExtensionStateChanged`
 * pulses (see `event-publisher.ts`).
 *
 * Failure isolation: a failing projection logs and is skipped. Other projections
 * continue.
 *
 * Scope precedence is provided by the caller — `compileProjections` accepts an
 * already-sorted array and preserves order, so later-scope projections appear
 * later in the result lists.
 *
 * @module
 */
import { Effect } from "effect"
import type { ServiceKey } from "../../domain/actor.js"
import type { LoadedExtension, ToolPolicyFragment } from "../../domain/extension.js"
import type { ExtensionId } from "../../domain/ids.js"
import type {
  AnyProjectionContribution,
  ProjectionContext,
  ProjectionTurnContext,
} from "../../domain/projection.js"
import type { PromptSection } from "../../domain/prompt.js"
import { ActorEngine } from "./actor-engine.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"
import { sealErasedEffect } from "./effect-membrane.js"
import { Receptionist } from "./receptionist.js"

interface RegisteredProjection {
  readonly extensionId: ExtensionId
  readonly projection: AnyProjectionContribution
}

interface RegisteredActorRoute {
  readonly extensionId: ExtensionId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ServiceKey<M> is contravariant; storage erases M
  readonly serviceKey: ServiceKey<any>
}

/** Turn evaluation result — prompt + policy fragments produced for the active turn. */
export interface ProjectionTurnEvaluation {
  readonly promptSections: ReadonlyArray<PromptSection>
  readonly policyFragments: ReadonlyArray<ToolPolicyFragment>
}

export interface CompiledProjections {
  readonly entries: ReadonlyArray<RegisteredProjection>
  /** Evaluate turn-bearing projections (turn required). Used during prompt assembly
   *  to derive prompt sections + tool policy fragments.
   *
   *  Also samples each registered actor's `behavior.view(state)` via
   *  `ActorEngine.peekView` and folds the resulting `prompt` + `toolPolicy`
   *  into the same aggregate, with the same id-keyed dedup semantics. */
  readonly evaluateTurn: (
    ctx: ProjectionTurnContext,
  ) => Effect.Effect<ProjectionTurnEvaluation, never, ActorEngine | Receptionist>
  /**
   * Run a single projection by `extensionId/projectionId` — returns the raw value.
   * If multiple registrations share the same id (across scopes), the highest-precedence
   * one (project > user > builtin) wins.
   */
  readonly query: (
    extensionId: ExtensionId,
    projectionId: string,
    ctx: ProjectionContext,
  ) => Effect.Effect<unknown | undefined>
}

const sortedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const collectProjections = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<RegisteredProjection> => {
  const sorted = sortedExtensions(extensions)
  const entries: RegisteredProjection[] = []
  for (const ext of sorted) {
    for (const projection of ext.contributions.projections ?? []) {
      if (projection === undefined) continue
      entries.push({ extensionId: ext.manifest.id, projection })
    }
  }
  return entries
}

// Collect actor routes — one per extension that declares either an explicit
// `actorRoute` or an `actors:` bucket entry whose Behavior carries a
// `serviceKey`. Scope-sorted so later-scope actors' view contributions
// override earlier ones with the same prompt-section id (matches projection
// dedup semantics).
const collectActorRoutes = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<RegisteredActorRoute> => {
  const sorted = sortedExtensions(extensions)
  const routes: RegisteredActorRoute[] = []
  for (const ext of sorted) {
    const explicit = ext.contributions.actorRoute
    if (explicit !== undefined) {
      routes.push({ extensionId: ext.manifest.id, serviceKey: explicit })
      continue
    }
    for (const behavior of ext.contributions.actors ?? []) {
      if (behavior.serviceKey === undefined) continue
      routes.push({ extensionId: ext.manifest.id, serviceKey: behavior.serviceKey })
    }
  }
  return routes
}

/** Compile registered projections into an evaluator. */
export const compileProjections = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledProjections => {
  const entries = collectProjections(extensions)
  const actorRoutes = collectActorRoutes(extensions)

  const runOne = (
    entry: RegisteredProjection,
    ctx: ProjectionContext,
  ): Effect.Effect<unknown | undefined> =>
    sealErasedEffect(() => entry.projection.query(ctx), {
      onFailure: (error) =>
        Effect.logWarning("extension.projection.query.failed").pipe(
          Effect.annotateLogs({
            extensionId: entry.extensionId,
            projectionId: entry.projection.id,
            error: String(error),
          }),
          Effect.as(undefined),
        ),
      onDefect: (defect) =>
        Effect.logWarning("extension.projection.query.defect").pipe(
          Effect.annotateLogs({
            extensionId: entry.extensionId,
            projectionId: entry.projection.id,
            defect: String(defect),
          }),
          Effect.as(undefined),
        ),
    })

  // Pre-partition entries by surface to avoid running queries for projections
  // that won't contribute to the requested context.
  const turnBearing = entries.filter(
    (e) => e.projection.prompt !== undefined || e.projection.policy !== undefined,
  )

  const evaluateTurn: CompiledProjections["evaluateTurn"] = (ctx) =>
    Effect.gen(function* () {
      // Id-keyed dedup matches the legacy `promptSection` map semantics —
      // higher-scope projection's section with the same id shadows a
      // lower-scope one. Entries are scope-sorted at
      // `collectProjections`, so last write wins.
      const sectionsById = new Map<string, PromptSection>()
      const policyFragments: ToolPolicyFragment[] = []
      for (const entry of turnBearing) {
        const value = yield* runOne(entry, ctx)
        if (value === undefined) continue
        const promptFn = entry.projection.prompt
        if (promptFn !== undefined) {
          const sectionsExit = yield* Effect.exit(Effect.sync(() => promptFn(value)))
          if (sectionsExit._tag === "Success") {
            for (const section of sectionsExit.value) sectionsById.set(section.id, section)
          } else {
            yield* Effect.logWarning("extension.projection.prompt.failed").pipe(
              Effect.annotateLogs({
                extensionId: entry.extensionId,
                projectionId: entry.projection.id,
              }),
            )
          }
        }
        const policyFn = entry.projection.policy
        if (policyFn !== undefined) {
          const policyExit = yield* Effect.exit(Effect.sync(() => policyFn(value, ctx)))
          if (policyExit._tag === "Success") {
            policyFragments.push(policyExit.value)
          } else {
            yield* Effect.logWarning("extension.projection.policy.failed").pipe(
              Effect.annotateLogs({
                extensionId: entry.extensionId,
                projectionId: entry.projection.id,
              }),
            )
          }
        }
      }
      // Actor view walk — `Behavior.view(state)` contributes prompt
      // sections + tool policy fragments alongside `ProjectionContribution`.
      // Per-actor failures are swallowed (logged) so a single bad view
      // can't break the turn.
      if (actorRoutes.length > 0) {
        const engine = yield* ActorEngine
        const receptionist = yield* Receptionist
        for (const route of actorRoutes) {
          const refsExit = yield* Effect.exit(receptionist.find(route.serviceKey))
          if (refsExit._tag === "Failure") {
            yield* Effect.logWarning("extension.actor-view.find.failed").pipe(
              Effect.annotateLogs({ extensionId: route.extensionId }),
            )
            continue
          }
          for (const ref of refsExit.value) {
            const viewExit = yield* Effect.exit(engine.peekView(ref))
            if (viewExit._tag === "Failure") {
              yield* Effect.logWarning("extension.actor-view.peek.failed").pipe(
                Effect.annotateLogs({ extensionId: route.extensionId }),
              )
              continue
            }
            const view = viewExit.value
            if (view === undefined) continue
            if (view.prompt !== undefined) {
              for (const section of view.prompt) sectionsById.set(section.id, section)
            }
            if (view.toolPolicy !== undefined) {
              policyFragments.push(view.toolPolicy)
            }
          }
        }
      }
      return { promptSections: [...sectionsById.values()], policyFragments }
    })

  const query: CompiledProjections["query"] = (extensionId, projectionId, ctx) =>
    Effect.gen(function* () {
      // Entries are scope-sorted (builtin → user → project) — iterate in reverse
      // so the highest-precedence registration wins.
      let entry: RegisteredProjection | undefined
      for (let i = entries.length - 1; i >= 0; i--) {
        const candidate = entries[i]
        if (
          candidate !== undefined &&
          candidate.extensionId === extensionId &&
          candidate.projection.id === projectionId
        ) {
          entry = candidate
          break
        }
      }
      if (entry === undefined) return undefined
      return yield* runOne(entry, ctx)
    })

  return { entries, evaluateTurn, query }
}
