/**
 * ProjectionRegistry — evaluates `ProjectionContribution[]` on demand.
 *
 * Projections are flat; there is no per-event reduction step. Two evaluators
 * partition projections by surface so each path only runs queries that can
 * contribute to it:
 *   - `evaluateUi(ctx)`   — runs `ui`-bearing projections, returns `uiSnapshots`
 *   - `evaluateTurn(ctx)` — runs `prompt`/`policy`-bearing projections, returns
 *                           `promptSections` + `policyFragments`
 *
 * Failure isolation: a failing projection logs and is skipped. Other projections
 * continue. Mirrors the actor pattern's `runSupervised` resilience but without
 * the lifecycle complexity.
 *
 * Scope precedence is provided by the caller — `compileProjections` accepts an
 * already-sorted array and preserves order, so later-scope projections appear
 * later in the result lists.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import { ExtensionUiSnapshot } from "../../domain/event.js"
import type { LoadedExtension, ToolPolicyFragment } from "../../domain/extension.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type {
  AnyProjectionContribution,
  ProjectionContext,
  ProjectionTurnContext,
  ProjectionUiContext,
} from "../../domain/projection.js"
import type { PromptSection } from "../../domain/prompt.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

interface RegisteredProjection {
  readonly extensionId: string
  readonly projection: AnyProjectionContribution
}

/** UI-only evaluation result — only ui snapshots; prompt/policy require a turn. */
export interface ProjectionUiEvaluation {
  readonly uiSnapshots: ReadonlyArray<ExtensionUiSnapshot>
}

/** Turn evaluation result — prompt + policy fragments produced for the active turn. */
export interface ProjectionTurnEvaluation {
  readonly promptSections: ReadonlyArray<PromptSection>
  readonly policyFragments: ReadonlyArray<ToolPolicyFragment>
}

export interface CompiledProjections {
  readonly entries: ReadonlyArray<RegisteredProjection>
  /** Demoted ui surfaces — extensions that contributed more than one ui-bearing projection,
   *  or contributed both `actor.snapshot` and a `projection.ui`. */
  readonly uiCollisions: ReadonlyArray<{
    readonly extensionId: string
    readonly projectionId: string
    readonly reason: "duplicate-projection-ui" | "actor-snapshot-owns-ui"
  }>
  /** Evaluate UI-bearing projections (no turn). Used by event-publisher to emit
   *  `ExtensionUiSnapshot`s. Projections without a `ui` surface are skipped. */
  readonly evaluateUi: (ctx: ProjectionUiContext) => Effect.Effect<ProjectionUiEvaluation>
  /** Evaluate turn-bearing projections (turn required). Used during prompt assembly
   *  to derive prompt sections + tool policy fragments. UI surfaces are not
   *  emitted from this path (event-publisher owns UI). */
  readonly evaluateTurn: (ctx: ProjectionTurnContext) => Effect.Effect<ProjectionTurnEvaluation>
  /**
   * Run a single projection by `extensionId/projectionId` — returns the raw value.
   * If multiple registrations share the same id (across scopes), the highest-precedence
   * one (project > user > builtin) wins.
   */
  readonly query: (
    extensionId: string,
    projectionId: string,
    ctx: ProjectionContext,
  ) => Effect.Effect<unknown | undefined>
}

const sortedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

interface CollisionEntry {
  readonly extensionId: string
  readonly projectionId: string
  readonly reason: "duplicate-projection-ui" | "actor-snapshot-owns-ui"
}

interface CollectionResult {
  readonly entries: ReadonlyArray<RegisteredProjection>
  readonly uiCollisions: ReadonlyArray<CollisionEntry>
}

interface UiOwner {
  readonly projectionId: string
  readonly extensionIndex: number
  readonly projectionIndex: number
}

/** Identify the single (extensionIndex, projectionIndex) that owns the UI surface
 *  per extensionId, walking sorted extensions in highest-precedence-first order.
 *  Extensions with `actor.snapshot` are excluded — actor.snapshot owns UI for them. */
const findUiOwners = (
  sorted: ReadonlyArray<LoadedExtension>,
  extensionsWithActorSnapshot: ReadonlySet<string>,
): ReadonlyMap<string, UiOwner> => {
  const uiOwner = new Map<string, UiOwner>()
  for (let i = sorted.length - 1; i >= 0; i--) {
    const ext = sorted[i]
    if (ext === undefined) continue
    if (uiOwner.has(ext.manifest.id)) continue
    if (extensionsWithActorSnapshot.has(ext.manifest.id)) continue
    const projections = ext.setup.projections ?? []
    for (let pi = 0; pi < projections.length; pi++) {
      const projection = projections[pi]
      if (projection?.ui !== undefined) {
        uiOwner.set(ext.manifest.id, {
          projectionId: projection.id,
          extensionIndex: i,
          projectionIndex: pi,
        })
        break
      }
    }
  }
  return uiOwner
}

/** Classify a single projection: keep, demote (and record collision), or drop entirely.
 *  Pure decision: returns the entry to push and the optional collision to record. */
const classifyProjection = (
  ext: LoadedExtension,
  projection: AnyProjectionContribution,
  ei: number,
  pi: number,
  extensionsWithActorSnapshot: ReadonlySet<string>,
  uiOwner: ReadonlyMap<string, UiOwner>,
): { entry: RegisteredProjection; collision?: CollisionEntry } => {
  if (projection.ui === undefined) {
    return { entry: { extensionId: ext.manifest.id, projection } }
  }
  if (extensionsWithActorSnapshot.has(ext.manifest.id)) {
    return {
      entry: { extensionId: ext.manifest.id, projection: { ...projection, ui: undefined } },
      collision: {
        extensionId: ext.manifest.id,
        projectionId: projection.id,
        reason: "actor-snapshot-owns-ui",
      },
    }
  }
  const owner = uiOwner.get(ext.manifest.id)
  const isOwner = owner !== undefined && owner.extensionIndex === ei && owner.projectionIndex === pi
  if (!isOwner) {
    return {
      entry: { extensionId: ext.manifest.id, projection: { ...projection, ui: undefined } },
      collision: {
        extensionId: ext.manifest.id,
        projectionId: projection.id,
        reason: "duplicate-projection-ui",
      },
    }
  }
  return { entry: { extensionId: ext.manifest.id, projection } }
}

const collectProjections = (extensions: ReadonlyArray<LoadedExtension>): CollectionResult => {
  // UI ownership rule (enforced structurally at compile time):
  //
  //   "One extensionId owns at most one UI snapshot identity per cycle."
  //
  // ExtensionUiSnapshot is keyed only by extensionId. Two sources can produce
  // a UI snapshot for an extension: (1) `actor.snapshot` (emitted by the actor
  // runtime on state change), and (2) `projection.ui` (evaluated by the
  // event-publisher each cycle). If both exist, the snapshot identity flickers
  // between actor-derived and projection-derived models depending on which
  // path produced the latest event — strictly worse than a single duplicate.
  //
  // Resolution: actor.snapshot wins. If an extension has actor.snapshot AND
  // any projection.ui, demote the projection.ui (record collision; strip ui).
  // Reason: actor.snapshot is the older surface with persistence semantics;
  // ripping it out is the actor's job (Commits 4/5/6/8), not the projection
  // registry's. Projections that need to coexist with an actor today should
  // omit `.ui` and surface state through prompt/policy until the actor goes.
  //
  // Among multiple projection.ui entries for the same extension (no actor),
  // the highest-precedence first-declared wins; later ones are demoted.

  const sorted = sortedExtensions(extensions)
  const extensionsWithActorSnapshot = new Set<string>()
  for (const ext of sorted) {
    if (ext.setup.actor?.snapshot !== undefined) {
      extensionsWithActorSnapshot.add(ext.manifest.id)
    }
  }
  const uiOwner = findUiOwners(sorted, extensionsWithActorSnapshot)

  const entries: RegisteredProjection[] = []
  const uiCollisions: CollisionEntry[] = []
  for (let ei = 0; ei < sorted.length; ei++) {
    const ext = sorted[ei]
    if (ext === undefined) continue
    const projections = ext.setup.projections ?? []
    for (let pi = 0; pi < projections.length; pi++) {
      const projection = projections[pi]
      if (projection === undefined) continue
      const { entry, collision } = classifyProjection(
        ext,
        projection,
        ei,
        pi,
        extensionsWithActorSnapshot,
        uiOwner,
      )
      entries.push(entry)
      if (collision !== undefined) uiCollisions.push(collision)
    }
  }
  return { entries, uiCollisions }
}

/** Compile registered projections into an evaluator. */
export const compileProjections = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledProjections => {
  const { entries, uiCollisions } = collectProjections(extensions)
  // Surface collisions via console at compile time — one structured line per
  // demoted projection. Avoids requiring an Effect at registration boundary.
  for (const collision of uiCollisions) {
    const reason =
      collision.reason === "actor-snapshot-owns-ui"
        ? `extension already declares an actor.snapshot; actor.snapshot owns the UI surface for an extension. Drop the projection.ui or remove the actor.snapshot.`
        : `extension already has a UI-bearing projection; only one projection.ui per extension is allowed.`
    // eslint-disable-next-line no-console
    console.warn(
      `[gent] projection ui collision: extension "${collision.extensionId}" — demoting projection "${collision.projectionId}" (ui surface dropped). Reason: ${reason}`,
    )
  }

  const runOne = (
    entry: RegisteredProjection,
    ctx: ProjectionContext,
  ): Effect.Effect<unknown | undefined> =>
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — projection R/E erased at registry boundary
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    (entry.projection.query(ctx) as Effect.Effect<unknown, unknown>).pipe(
      Effect.catchEager((error) =>
        Effect.logWarning("extension.projection.query.failed").pipe(
          Effect.annotateLogs({
            extensionId: entry.extensionId,
            projectionId: entry.projection.id,
            error: String(error),
          }),
          Effect.as(undefined),
        ),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("extension.projection.query.defect").pipe(
          Effect.annotateLogs({
            extensionId: entry.extensionId,
            projectionId: entry.projection.id,
            defect: String(defect),
          }),
          Effect.as(undefined),
        ),
      ),
    )

  const projectUi = (
    entry: RegisteredProjection,
    value: unknown,
    sessionId: SessionId,
    branchId: BranchId,
  ): Effect.Effect<ExtensionUiSnapshot | undefined> =>
    Effect.gen(function* () {
      const ui = entry.projection.ui
      if (ui === undefined) return undefined
      const projectedExit = yield* Effect.exit(Effect.sync(() => ui.project(value)))
      if (projectedExit._tag === "Failure") {
        yield* Effect.logWarning("extension.projection.ui.project.failed").pipe(
          Effect.annotateLogs({
            extensionId: entry.extensionId,
            projectionId: entry.projection.id,
          }),
        )
        return undefined
      }
      let model: unknown = projectedExit.value
      if (ui.schema !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const decoded = yield* Schema.decodeUnknownEffect(ui.schema as Schema.Any)(model).pipe(
          Effect.catchEager(() =>
            Effect.logWarning("extension.projection.ui.schema.failed").pipe(
              Effect.annotateLogs({
                extensionId: entry.extensionId,
                projectionId: entry.projection.id,
              }),
              Effect.as(undefined),
            ),
          ),
        )
        if (decoded === undefined) return undefined
        model = decoded
      }
      return new ExtensionUiSnapshot({
        sessionId,
        branchId,
        extensionId: entry.extensionId,
        epoch: 0,
        model,
      })
    })

  // Pre-partition entries by surface to avoid running queries for projections
  // that won't contribute to the requested context. UI-only entries (event
  // path) skip prompt/policy entries; turn-only entries (prompt assembly path)
  // skip ui-only entries.
  const uiBearing = entries.filter((e) => e.projection.ui !== undefined)
  const turnBearing = entries.filter(
    (e) => e.projection.prompt !== undefined || e.projection.policy !== undefined,
  )

  const evaluateUi: CompiledProjections["evaluateUi"] = (ctx) =>
    Effect.gen(function* () {
      const uiSnapshots: ExtensionUiSnapshot[] = []
      for (const entry of uiBearing) {
        const value = yield* runOne(entry, ctx)
        if (value === undefined) continue
        const snap = yield* projectUi(entry, value, ctx.sessionId, ctx.branchId)
        if (snap !== undefined) uiSnapshots.push(snap)
      }
      return { uiSnapshots }
    })

  const evaluateTurn: CompiledProjections["evaluateTurn"] = (ctx) =>
    Effect.gen(function* () {
      const promptSections: PromptSection[] = []
      const policyFragments: ToolPolicyFragment[] = []
      for (const entry of turnBearing) {
        const value = yield* runOne(entry, ctx)
        if (value === undefined) continue
        const promptFn = entry.projection.prompt
        if (promptFn !== undefined) {
          const sectionsExit = yield* Effect.exit(Effect.sync(() => promptFn(value)))
          if (sectionsExit._tag === "Success") {
            promptSections.push(...sectionsExit.value)
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
      return { promptSections, policyFragments }
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

  return { entries, uiCollisions, evaluateUi, evaluateTurn, query }
}
