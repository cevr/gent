/**
 * Durable resource graph command application service.
 *
 * Desired state and Encore delivery commit in one transaction. Recovery is an
 * explicit dispatch path because a terminal command reply must not suppress a
 * fresh live acquisition after process restart.
 *
 * @module
 */

import { Context, Effect, Exit, Layer, Option, Predicate, Schema } from "effect"
import { Client, type ClientSendError } from "effect-encore"
import type {
  ResourceGraphCommandConflictError,
  ResourceGraphDesiredReceipt,
  ResourceGraphDesiredCommand,
  ResourceGraphExpectedRevisionError,
  ResourceGraphKey,
  ResourceGraphStatus,
} from "../../../domain/resource-graph-state.js"
import { RequestId } from "../../../domain/ids.js"
import { StorageError } from "../../../domain/storage-error.js"
import { GentPlatform } from "../../gent-platform.js"
import { CurrentWorkspaceId } from "../../../server/workspace-rpc.js"
import { ResourceGraphStorage } from "../../../storage/resource-graph-storage.js"
import { ResourceGraph, ResourceGraphRecoveryPayload } from "./resource-graph-entity.js"

/** A durable owner is unavailable until its saved graph can be reacquired. */
export class ResourceGraphOwnerUnavailableError extends Schema.TaggedError<ResourceGraphOwnerUnavailableError>()(
  "ResourceGraphOwnerUnavailableError",
  {
    workspaceId: Schema.String,
    cwd: Schema.String,
    state: Schema.Literals(["pending", "applying", "failed"]),
    message: Schema.String,
  },
) {}

/** Encore dispatch seam. Production uses the live actor operation handles. */
export interface ResourceGraphDispatchService {
  readonly sendDesired: (
    receipt: ResourceGraphDesiredReceipt,
  ) => Effect.Effect<void, ClientSendError>
  readonly sendRecovery: (
    request: ResourceGraphRecoveryPayload,
  ) => Effect.Effect<void, ClientSendError>
  /** Deliver recovery and wait for the live owner to reacquire its scope. */
  readonly sendRecoveryAndAwait: (
    request: ResourceGraphRecoveryPayload,
  ) => Effect.Effect<void, StorageError>
}

export class ResourceGraphDispatch extends Context.Service<
  ResourceGraphDispatch,
  ResourceGraphDispatchService
>()(
  "@gent/core/src/runtime/extensions/resource-host/resource-graph-command/ResourceGraphDispatch",
) {
  static Live: Layer.Layer<ResourceGraphDispatch, never, Client> = Layer.effect(
    ResourceGraphDispatch,
    Effect.gen(function* () {
      const client = yield* Client
      const sendDesired = (receipt: ResourceGraphDesiredReceipt) =>
        ResourceGraph.ApplyDesired.send(receipt).pipe(
          Effect.provideService(Client, client),
          Effect.asVoid,
        )
      const sendRecovery = (request: ResourceGraphRecoveryPayload) =>
        ResourceGraph.RecoverDesired.send(request).pipe(
          Effect.provideService(Client, client),
          Effect.asVoid,
        )
      const sendRecoveryAndAwait = (request: ResourceGraphRecoveryPayload) =>
        ResourceGraph.RecoverDesired.sendAndAwait(request, { timeout: "30 seconds" }).pipe(
          Effect.provideService(Client, client),
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new StorageError({
                message: `Resource graph recovery did not complete: ${String(cause)}`,
                cause,
              }),
          ),
        )
      return ResourceGraphDispatch.of({ sendDesired, sendRecovery, sendRecoveryAndAwait })
    }),
  )
}

type ResourceGraphSubmitError =
  | StorageError
  | ResourceGraphCommandConflictError
  | ResourceGraphExpectedRevisionError
  | ClientSendError

export type ResourceGraphRecoveryError = StorageError | ClientSendError

/** Result for one owner during process-start recovery. */
export interface ResourceGraphRecoveryOutcome {
  readonly request: ResourceGraphRecoveryPayload
  readonly applying: boolean
  readonly settled: boolean
  readonly status: Option.Option<ResourceGraphStatus>
  readonly error: Option.Option<string>
}

/** Recovery results used to gate the launch profile without hiding other owners. */
export interface ResourceGraphRecoveryReport {
  readonly requests: ReadonlyArray<ResourceGraphRecoveryPayload>
  readonly outcomes: ReadonlyArray<ResourceGraphRecoveryOutcome>
}

export interface ResourceGraphCommandServiceApi {
  /** Record and dispatch one desired graph without waiting for application. */
  readonly submit: (
    command: ResourceGraphDesiredCommand,
  ) => Effect.Effect<ResourceGraphDesiredReceipt, ResourceGraphSubmitError>
  /** Re-dispatch every durable owner with a fresh process-local recovery key. */
  readonly recover: (
    workspaceId: ResourceGraphKey["workspaceId"],
  ) => Effect.Effect<ReadonlyArray<ResourceGraphRecoveryPayload>, ResourceGraphRecoveryError>
  /** Re-dispatch every durable graph owner across all persisted workspaces. */
  readonly recoverAll: Effect.Effect<
    ReadonlyArray<ResourceGraphRecoveryPayload>,
    ResourceGraphRecoveryError
  >
  /** Recover every durable owner and wait for each live scope to settle. */
  readonly recoverAllAndAwaitReport: Effect.Effect<
    ResourceGraphRecoveryReport,
    ResourceGraphRecoveryError
  >
  readonly recoverAllAndAwait: Effect.Effect<
    ReadonlyArray<ResourceGraphRecoveryPayload>,
    ResourceGraphRecoveryError
  >
}

/**
 * Command owner for durable resource graph desired state.
 *
 * `ResourceGraphDesiredApplierService` is intentionally referenced here so a
 * live host can be supplied by the single cache owner during composition. The
 * command service does not provide a fake adapter.
 */
export class ResourceGraphCommandService extends Context.Service<
  ResourceGraphCommandService,
  ResourceGraphCommandServiceApi
>()(
  "@gent/core/src/runtime/extensions/resource-host/resource-graph-command/ResourceGraphCommandService",
) {
  static Live = Layer.effect(
    ResourceGraphCommandService,
    Effect.gen(function* () {
      const storage = yield* ResourceGraphStorage
      const dispatch = yield* ResourceGraphDispatch
      const client = yield* Client
      const platform = yield* GentPlatform

      const submit = (command: ResourceGraphDesiredCommand) =>
        Effect.gen(function* () {
          const receipt = yield* storage.recordDesired(command)
          yield* dispatch.sendDesired(receipt)
          return receipt
        }).pipe(client.withTransaction)

      const recover = (workspaceId: ResourceGraphKey["workspaceId"]) =>
        recoverForWorkspace(workspaceId, dispatch.sendRecovery)

      const recoverForWorkspace = (
        workspaceId: ResourceGraphKey["workspaceId"],
        send: (
          request: ResourceGraphRecoveryPayload,
        ) => Effect.Effect<void, ResourceGraphRecoveryError>,
      ) =>
        Effect.gen(function* () {
          const keys = yield* storage.listAll(workspaceId)
          const requests: Array<ResourceGraphRecoveryPayload> = []
          for (const key of keys) {
            const status = yield* storage.get(key)
            if (Predicate.isUndefined(status)) continue
            const recoveryId = RequestId.make(yield* platform.randomId)
            const request = ResourceGraphRecoveryPayload.make({
              workspaceId: status.workspaceId,
              cwd: status.cwd,
              commandId: status.commandId,
              desiredRevision: status.desiredRevision,
              desiredSequence: status.desiredSequence,
              recoveryId,
            })
            yield* send(request)
            requests.push(request)
          }
          return requests
        })

      const recoverAll = Effect.gen(function* () {
        const workspaces = yield* storage.listWorkspaces
        const requests: Array<ResourceGraphRecoveryPayload> = []
        for (const workspaceId of workspaces) {
          const recovered = yield* recover(workspaceId).pipe(
            Effect.provideService(CurrentWorkspaceId, workspaceId),
          )
          requests.push(...recovered)
        }
        return requests
      })

      const recoverAllAndAwaitReport = Effect.gen(function* () {
        const workspaces = yield* storage.listWorkspaces
        const requests: Array<ResourceGraphRecoveryPayload> = []
        const outcomes: Array<ResourceGraphRecoveryOutcome> = []
        const recoverAndObserve = (request: ResourceGraphRecoveryPayload) =>
          Effect.gen(function* () {
            const applying = yield* storage
              .recordApplying({
                workspaceId: request.workspaceId,
                cwd: request.cwd,
                desiredRevision: request.desiredRevision,
                desiredSequence: request.desiredSequence,
              })
              .pipe(Effect.exit)
            const applyingReady = Exit.isSuccess(applying)
            let error = Option.none<string>()
            if (Exit.isFailure(applying)) {
              const applyingError = String(applying.cause)
              error = Option.some(applyingError)
              yield* Effect.logWarning(
                "Resource graph recovery could not mark owner applying",
              ).pipe(
                Effect.annotateLogs({
                  cwd: String(request.cwd),
                  workspaceId: String(request.workspaceId),
                  error: applyingError,
                }),
              )
            }

            const settled = yield* dispatch.sendRecoveryAndAwait(request).pipe(Effect.exit)
            const settledReady = Exit.isSuccess(settled)
            if (Exit.isFailure(settled)) {
              if (Option.isNone(error)) error = Option.some(String(settled.cause))
              yield* Effect.logWarning("Resource graph recovery did not settle").pipe(
                Effect.annotateLogs({
                  cwd: String(request.cwd),
                  workspaceId: String(request.workspaceId),
                  error: String(settled.cause),
                }),
              )
            }

            const statusExit = yield* storage
              .get({ workspaceId: request.workspaceId, cwd: request.cwd })
              .pipe(Effect.exit)
            let status = Option.none<ResourceGraphStatus>()
            if (Exit.isSuccess(statusExit)) {
              status = Option.fromUndefinedOr(statusExit.value)
            } else {
              if (Option.isNone(error)) error = Option.some(String(statusExit.cause))
              yield* Effect.logWarning("Resource graph recovery status was not readable").pipe(
                Effect.annotateLogs({
                  cwd: String(request.cwd),
                  workspaceId: String(request.workspaceId),
                  error: String(statusExit.cause),
                }),
              )
            }
            outcomes.push({
              request,
              applying: applyingReady,
              settled: settledReady,
              status,
              error,
            })
          })
        for (const workspaceId of workspaces) {
          const recovered = yield* recoverForWorkspace(workspaceId, recoverAndObserve).pipe(
            Effect.provideService(CurrentWorkspaceId, workspaceId),
          )
          requests.push(...recovered)
        }
        if (requests.length > 0) {
          let applied = 0
          let failed = 0
          let pending = 0
          for (const outcome of outcomes) {
            if (Option.isSome(outcome.status) && outcome.status.value.state === "failed") {
              failed++
            } else if (
              Option.isNone(outcome.error) &&
              outcome.applying &&
              outcome.settled &&
              Option.isSome(outcome.status) &&
              outcome.status.value.state === "applied"
            ) {
              applied++
            } else {
              pending++
            }
          }
          yield* Effect.log(
            `Resource graph recovery: ${applied} applied, ${failed} failed, ${pending} pending`,
          )
        }
        return { requests, outcomes } satisfies ResourceGraphRecoveryReport
      })

      const recoverAllAndAwait = recoverAllAndAwaitReport.pipe(
        Effect.map((report) => report.requests),
      )

      return ResourceGraphCommandService.of({
        submit,
        recover,
        recoverAll,
        recoverAllAndAwaitReport,
        recoverAllAndAwait,
      })
    }),
  )
}
