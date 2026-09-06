/**
 * Durable per-cwd resource graph actor.
 *
 * Encore owns delivery and per-entity serialization. The actor reads the
 * JSON-safe desired projection and delegates live work to one host adapter.
 * It never stores a Layer, Scope, Context, or service instance.
 *
 * @module
 */

import { Cause, Context, Effect, Exit, Layer, Option, Predicate, Schema } from "effect"
import { ShardingConfig } from "effect/unstable/cluster"
import { Actor } from "effect-encore"
import {
  ResourceGraphDesiredReceipt,
  ResourceGraphFailure,
} from "../../../domain/resource-graph-state.js"
import type {
  CanonicalCwd,
  ResourceGraphSnapshot,
  ResourceGraphStatus,
} from "../../../domain/resource-graph-state.js"
import { RequestId } from "../../../domain/ids.js"
import { CurrentWorkspaceId, type WorkspaceId } from "../../../server/workspace-rpc.js"
import {
  ResourceGraphStorage,
  type ResourceGraphAdmission,
} from "../../../storage/resource-graph-storage.js"

/** One phase in durable graph command handling. */
export const ResourceGraphCommandPhase = Schema.Literals([
  "route",
  "load",
  "stale",
  "prepare",
  "validate",
  "apply",
  "storage",
])
export type ResourceGraphCommandPhase = typeof ResourceGraphCommandPhase.Type

/** A graph command could not complete. The durable status records apply failures. */
export class ResourceGraphCommandError extends Schema.TaggedError<ResourceGraphCommandError>()(
  "ResourceGraphCommandError",
  {
    phase: ResourceGraphCommandPhase,
    message: Schema.String,
  },
) {}

/** Failure returned by the live desired-snapshot adapter. */
export const ResourceGraphApplyPhase = Schema.Literals(["prepare", "validate", "apply"])
export type ResourceGraphApplyPhase = typeof ResourceGraphApplyPhase.Type

export class ResourceGraphApplyError extends Schema.TaggedError<ResourceGraphApplyError>()(
  "ResourceGraphApplyError",
  {
    phase: ResourceGraphApplyPhase,
    message: Schema.String,
  },
) {}

/** Runtime-only prepared work. Durable rows contain only `snapshot`. */
export interface ResourceGraphDesiredApplication {
  readonly receipt: ResourceGraphDesiredReceipt
  readonly snapshot: ResourceGraphSnapshot
}

export interface ResourceGraphPrepared {
  readonly request: ResourceGraphDesiredApplication
}

/**
 * Required live adapter for one resource graph owner.
 *
 * The adapter resolves declarations from its single live cache owner. The
 * prepared value stays in memory for one command and is never serialized.
 */
export interface ResourceGraphDesiredApplierService {
  readonly prepare: (
    request: ResourceGraphDesiredApplication,
  ) => Effect.Effect<ResourceGraphPrepared, ResourceGraphApplyError>
  readonly validate: (
    prepared: ResourceGraphPrepared,
  ) => Effect.Effect<void, ResourceGraphApplyError>
  readonly applyDesired: (
    prepared: ResourceGraphPrepared,
    admit: () => Effect.Effect<void, ResourceGraphApplyError>,
  ) => Effect.Effect<void, ResourceGraphApplyError>
}

export class ResourceGraphDesiredApplier extends Context.Service<
  ResourceGraphDesiredApplier,
  ResourceGraphDesiredApplierService
>()(
  "@gent/core/src/runtime/extensions/resource-host/resource-graph-entity/ResourceGraphDesiredApplier",
) {}

const ResourceGraphApplyPayload = Schema.Struct({
  ...ResourceGraphDesiredReceipt.fields,
})
type ResourceGraphApplyPayload = typeof ResourceGraphApplyPayload.Type

/** An explicit restart recovery dispatch. The key is intentionally process-local. */
export const ResourceGraphRecoveryPayload = Schema.Struct({
  ...ResourceGraphDesiredReceipt.fields,
  recoveryId: RequestId,
})
export type ResourceGraphRecoveryPayload = typeof ResourceGraphRecoveryPayload.Type

/** Stable entity identity for one workspace and canonical cwd. */
export const resourceGraphEntityId = (workspaceId: WorkspaceId, cwd: CanonicalCwd): string =>
  `resource-graph/${encodeURIComponent(workspaceId)}/${encodeURIComponent(cwd)}`

const commandPrimaryKey = (payload: ResourceGraphApplyPayload): string =>
  `command/${encodeURIComponent(payload.commandId)}/${String(payload.desiredSequence)}`

const recoveryPrimaryKey = (payload: ResourceGraphRecoveryPayload): string =>
  `recovery/${encodeURIComponent(payload.recoveryId)}/${String(payload.desiredSequence)}`

/**
 * Durable graph commands. `ApplyDesired` is stable per accepted command.
 * `RecoverDesired` is a separate explicit path so a prior terminal command
 * cannot suppress reacquisition after a process restart.
 */
export const ResourceGraph = Actor.fromEntity("ResourceGraph", {
  ApplyDesired: {
    payload: ResourceGraphApplyPayload,
    success: Schema.Void,
    error: ResourceGraphCommandError,
    persisted: true,
    id: (payload: ResourceGraphApplyPayload) => ({
      entityId: resourceGraphEntityId(payload.workspaceId, payload.cwd),
      primaryKey: commandPrimaryKey(payload),
    }),
  },
  RecoverDesired: {
    payload: ResourceGraphRecoveryPayload,
    success: Schema.Void,
    error: ResourceGraphCommandError,
    persisted: true,
    id: (payload: ResourceGraphRecoveryPayload) => ({
      entityId: resourceGraphEntityId(payload.workspaceId, payload.cwd),
      primaryKey: recoveryPrimaryKey(payload),
    }),
  },
})

const commandError = (
  phase: ResourceGraphCommandPhase,
  message: string,
): ResourceGraphCommandError => new ResourceGraphCommandError({ phase, message })

const causeMessage = (cause: Cause.Cause<unknown>): string => Cause.pretty(cause)

const receiptFor = (payload: ResourceGraphApplyPayload | ResourceGraphRecoveryPayload) =>
  ResourceGraphDesiredReceipt.make({
    workspaceId: payload.workspaceId,
    cwd: payload.cwd,
    commandId: payload.commandId,
    desiredRevision: payload.desiredRevision,
    desiredSequence: payload.desiredSequence,
  })

const sameReceipt = (left: ResourceGraphStatus, right: ResourceGraphDesiredReceipt): boolean =>
  left.desiredRevision === right.desiredRevision &&
  left.desiredSequence === right.desiredSequence &&
  left.commandId === right.commandId

const errorText = (error: Cause.YieldableError): string => error.message

const receiptStatus = (
  receipt: ResourceGraphDesiredReceipt,
  snapshot: ResourceGraphSnapshot,
): ResourceGraphDesiredApplication => ({ receipt, snapshot })

/** Build one serialized graph entity handler set. */
export const buildResourceGraphEntityHandlers = Effect.gen(function* () {
  const storage = yield* ResourceGraphStorage
  const applier = yield* ResourceGraphDesiredApplier
  const address = yield* Actor.CurrentAddress

  const provideWorkspace = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    workspaceId: WorkspaceId,
  ): Effect.Effect<A, E, R> => effect.pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))

  const failAfterApplying = (
    receipt: ResourceGraphDesiredReceipt,
    phase: ResourceGraphCommandPhase,
    message: string,
    admission: Option.Option<ResourceGraphAdmission>,
  ): Effect.Effect<void, ResourceGraphCommandError> =>
    Effect.gen(function* () {
      if (Option.isSome(admission)) {
        yield* provideWorkspace(storage.discardAdmission(admission.value), receipt.workspaceId)
      }
      const status = yield* provideWorkspace(
        storage.get({ workspaceId: receipt.workspaceId, cwd: receipt.cwd }),
        receipt.workspaceId,
      ).pipe(
        Effect.mapError((error) =>
          commandError("load", `Failed to load graph status after failure: ${errorText(error)}`),
        ),
      )
      if (Predicate.isUndefined(status)) {
        return yield* commandError("load", "Graph desired state disappeared after failure")
      }
      // A newer desired row owns the durable failure projection. Do not let a
      // stale command fail that row or force a retry of its own actor message.
      if (!sameReceipt(status, receipt)) {
        if (Option.isNone(admission)) return yield* commandError(phase, message)
        return
      }
      yield* provideWorkspace(
        storage.recordFailed({
          ...receipt,
          failure: ResourceGraphFailure.make({ message: `${phase}: ${message}` }),
        }),
        receipt.workspaceId,
      ).pipe(
        Effect.mapError((error) =>
          commandError("storage", `Failed to record graph failure: ${errorText(error)}`),
        ),
      )
      return yield* commandError(phase, message)
    })

  const applyReceipt = (
    payload: ResourceGraphApplyPayload | ResourceGraphRecoveryPayload,
  ): Effect.Effect<void, ResourceGraphCommandError> => {
    const receipt = receiptFor(payload)
    if (address.entityId !== resourceGraphEntityId(receipt.workspaceId, receipt.cwd)) {
      return Effect.fail(commandError("route", "Graph command entity key does not match payload"))
    }

    return Effect.gen(function* () {
      const status = yield* provideWorkspace(
        storage.get({ workspaceId: receipt.workspaceId, cwd: receipt.cwd }),
        receipt.workspaceId,
      ).pipe(
        Effect.mapError((error) =>
          commandError("load", `Failed to load graph status: ${errorText(error)}`),
        ),
      )
      if (Predicate.isUndefined(status)) {
        return yield* commandError("load", "Graph desired state is missing")
      }
      if (!sameReceipt(status, receipt)) {
        return yield* commandError(
          "stale",
          "Graph command was superseded by a newer desired sequence",
        )
      }

      yield* provideWorkspace(storage.recordApplying(receipt), receipt.workspaceId).pipe(
        Effect.mapError((error) =>
          commandError(
            "stale",
            `Graph command could not enter applying state: ${errorText(error)}`,
          ),
        ),
      )

      const prepared = yield* applier
        .prepare(receiptStatus(receipt, status.snapshot))
        .pipe(Effect.provideService(CurrentWorkspaceId, receipt.workspaceId), Effect.exit)
      if (Exit.isFailure(prepared)) {
        return yield* failAfterApplying(
          receipt,
          "prepare",
          causeMessage(prepared.cause),
          Option.none(),
        )
      }
      const validated = yield* applier
        .validate(prepared.value)
        .pipe(Effect.provideService(CurrentWorkspaceId, receipt.workspaceId), Effect.exit)
      if (Exit.isFailure(validated)) {
        return yield* failAfterApplying(
          receipt,
          "validate",
          causeMessage(validated.cause),
          Option.none(),
        )
      }

      // A newer desired command can be accepted while declaration loading or
      // validation runs. Recheck immediately before live mutation so a late
      // command is rejected before it enters the host.
      const currentBeforeApply = yield* provideWorkspace(
        storage.get({ workspaceId: receipt.workspaceId, cwd: receipt.cwd }),
        receipt.workspaceId,
      ).pipe(
        Effect.mapError((error) =>
          commandError("load", `Failed to recheck graph status: ${errorText(error)}`),
        ),
      )
      if (Predicate.isUndefined(currentBeforeApply) || !sameReceipt(currentBeforeApply, receipt)) {
        return yield* commandError("stale", "Graph command was superseded before live application")
      }

      // The host adapter must invoke this callback at its own serialized
      // transition boundary. A command admitted there may finish even when a
      // newer desired row arrives while the host performs replacement.
      let admission: Option.Option<ResourceGraphAdmission> = Option.none()
      const admit = (): Effect.Effect<void, ResourceGraphApplyError> =>
        provideWorkspace(storage.admit(receipt), receipt.workspaceId).pipe(
          Effect.mapError(
            (error) =>
              new ResourceGraphApplyError({
                phase: "apply",
                message: `Failed to admit graph application: ${errorText(error)}`,
              }),
          ),
          Effect.tap((proof) =>
            Effect.sync(() => {
              admission = Option.some(proof)
            }),
          ),
          Effect.asVoid,
        )

      const applied = yield* applier
        .applyDesired(prepared.value, admit)
        .pipe(Effect.provideService(CurrentWorkspaceId, receipt.workspaceId), Effect.exit)
      if (Exit.isFailure(applied)) {
        return yield* failAfterApplying(receipt, "apply", causeMessage(applied.cause), admission)
      }

      if (Option.isNone(admission)) {
        return yield* failAfterApplying(
          receipt,
          "apply",
          "Live adapter completed without host admission",
          Option.none(),
        )
      }
      yield* provideWorkspace(
        storage.recordAppliedAdmission(admission.value),
        receipt.workspaceId,
      ).pipe(
        Effect.mapError((error) =>
          commandError("storage", `Failed to record graph application: ${errorText(error)}`),
        ),
      )
    })
  }

  return {
    ApplyDesired: ({ operation }: { readonly operation: ResourceGraphApplyPayload }) =>
      applyReceipt(operation),
    RecoverDesired: ({ operation }: { readonly operation: ResourceGraphRecoveryPayload }) =>
      applyReceipt(operation),
  }
})

/** Production actor layer. One mailbox lane owns one cwd graph key. */
export const ResourceGraphActorLive = Layer.unwrap(
  Actor.provideLayerBuildContext(buildResourceGraphEntityHandlers).pipe(
    Effect.map((build) => Actor.toLayer(ResourceGraph, build, { concurrency: 1 })),
  ),
)

/** Test actor layer with the same single-lane handler policy. */
export const ResourceGraphActorTest = Layer.unwrap(
  Actor.provideLayerBuildContext(buildResourceGraphEntityHandlers).pipe(
    Effect.map((build) =>
      Actor.toTestLayer(ResourceGraph, build, { concurrency: 1 }).pipe(
        Layer.provide(ShardingConfig.layerDefaults),
      ),
    ),
  ),
)
