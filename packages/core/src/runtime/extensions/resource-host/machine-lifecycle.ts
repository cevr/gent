import { Cause, Deferred, Effect, Ref, Semaphore } from "effect"
import type { Scope } from "effect"
import { ExtensionActorStatusInfo, type ExtensionRef } from "../../../domain/extension.js"
import type { BranchId, SessionId } from "../../../domain/ids.js"
import type { ExtensionProtocolError } from "../../../domain/extension-protocol.js"
import { spawnMachineExtensionRef } from "../spawn-machine-ref.js"
import type { ExtensionTurnControlService } from "../turn-control.js"
import { ExtensionTurnControl } from "../turn-control.js"
import { getProtocolFailure, type ActorEntry, type ActorSpawnSpec } from "./machine-protocol.js"

type ActorSlot =
  | { readonly _tag: "ready"; readonly entries: ActorEntry[] }
  | { readonly _tag: "pending"; readonly gate: Deferred.Deferred<ActorEntry[]> }

const ACTOR_RESTART_LIMIT = 1

export interface MachineLifecycle {
  readonly getOrSpawnActors: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ActorEntry[]>
  readonly runSupervised: <A>(
    sessionId: SessionId,
    branchId: BranchId | undefined,
    entry: ActorEntry,
    operation: string,
    run: (ref: ExtensionRef) => Effect.Effect<A, ExtensionProtocolError>,
  ) => Effect.Effect<
    | { readonly _tag: "success"; readonly value: A }
    | { readonly _tag: "protocol"; readonly error: ExtensionProtocolError }
    | { readonly _tag: "terminal"; readonly error: string }
  >
  readonly getActorStatuses: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<ExtensionActorStatusInfo>>
  readonly terminateActors: (sessionId: SessionId) => Effect.Effect<void>
}

export const makeMachineLifecycle = (params: {
  readonly runtimeScope: Scope.Closeable
  readonly spawnSpecs: ReadonlyArray<ActorSpawnSpec>
  readonly spawnByExtension: ReadonlyMap<string, ActorSpawnSpec>
  readonly turnControl: ExtensionTurnControlService
}): Effect.Effect<MachineLifecycle, never> =>
  Effect.gen(function* () {
    const actorsRef = yield* Ref.make<Map<SessionId, ActorSlot>>(new Map())
    const actorStatusesRef = yield* Ref.make<Map<SessionId, Map<string, ExtensionActorStatusInfo>>>(
      new Map(),
    )
    const spawnSemaphore = yield* Semaphore.make(1)

    const formatCause = (cause: Cause.Cause<unknown>) => String(Cause.squash(cause))

    const setActorStatus = (status: ExtensionActorStatusInfo) =>
      Ref.update(actorStatusesRef, (current) => {
        const next = new Map(current)
        const byExtension = new Map(next.get(status.sessionId) ?? new Map())
        byExtension.set(status.extensionId, status)
        next.set(status.sessionId, byExtension)
        return next
      })

    const stopActor = (entry: ActorEntry) => Effect.exit(entry.ref.stop).pipe(Effect.asVoid)

    const getActorStatus = (sessionId: SessionId, extensionId: string) =>
      Ref.get(actorStatusesRef).pipe(
        Effect.map((current) => current.get(sessionId)?.get(extensionId)),
      )

    const replaceReadyEntry = (
      sessionId: SessionId,
      extensionId: string,
      nextEntry: ActorEntry | undefined,
    ) =>
      Ref.update(actorsRef, (current) => {
        const slot = current.get(sessionId)
        if (slot === undefined || slot._tag !== "ready") return current

        const existingIndex = slot.entries.findIndex((entry) => entry.ref.id === extensionId)
        let entries = slot.entries
        if (existingIndex === -1) {
          if (nextEntry !== undefined) entries = [...slot.entries, nextEntry]
        } else if (nextEntry === undefined) {
          entries = slot.entries.filter((entry) => entry.ref.id !== extensionId)
        } else {
          entries = slot.entries.map((entry, index) =>
            index === existingIndex ? nextEntry : entry,
          )
        }

        const next = new Map(current)
        next.set(sessionId, { _tag: "ready", entries })
        return next
      })

    const markActorFailed = (
      extensionId: string,
      sessionId: SessionId,
      branchId: BranchId | undefined,
      error: string,
      failurePhase: "start" | "runtime",
      restartCount: number,
    ) =>
      setActorStatus(
        ExtensionActorStatusInfo.cases.failed.make({
          extensionId,
          sessionId,
          branchId,
          error,
          failurePhase,
          ...(restartCount > 0 ? { restartCount } : {}),
        }),
      )

    const spawnActorEntry = (
      spec: ActorSpawnSpec,
      sessionId: SessionId,
      branchId: BranchId | undefined,
      lifecycleStatus: "starting" | "restarting",
      failurePhase: "start" | "runtime",
      restartCount: number,
    ): Effect.Effect<ActorEntry | undefined> =>
      Effect.gen(function* () {
        yield* setActorStatus(
          lifecycleStatus === "starting"
            ? ExtensionActorStatusInfo.cases.starting.make({
                extensionId: spec.extensionId,
                sessionId,
                branchId,
              })
            : ExtensionActorStatusInfo.cases.restarting.make({
                extensionId: spec.extensionId,
                sessionId,
                branchId,
                restartCount,
              }),
        )

        const spawnExit = yield* Effect.exit(
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- actor R is erased at registration
          spawnMachineExtensionRef(spec.extensionId, spec.actor, {
            sessionId,
            branchId,
          }).pipe(Effect.provideService(ExtensionTurnControl, params.turnControl)) as Effect.Effect<
            ExtensionRef,
            never,
            never
          >,
        )

        if (spawnExit._tag === "Failure") {
          const error = formatCause(spawnExit.cause)
          yield* markActorFailed(
            spec.extensionId,
            sessionId,
            branchId,
            error,
            failurePhase,
            restartCount,
          )
          yield* Effect.logWarning("extension.start.failed").pipe(
            Effect.annotateLogs({ extensionId: spec.extensionId, error }),
          )
          return undefined
        }

        const startExit = yield* Effect.exit(spawnExit.value.start)
        if (startExit._tag === "Failure") {
          const error = formatCause(startExit.cause)
          yield* stopActor({ ref: spawnExit.value, actor: spec.actor })
          yield* markActorFailed(
            spec.extensionId,
            sessionId,
            branchId,
            error,
            failurePhase,
            restartCount,
          )
          yield* Effect.logWarning("extension.start.failed").pipe(
            Effect.annotateLogs({ extensionId: spec.extensionId, error }),
          )
          return undefined
        }

        yield* setActorStatus(
          ExtensionActorStatusInfo.cases.running.make({
            extensionId: spec.extensionId,
            sessionId,
            branchId,
            ...(restartCount > 0 ? { restartCount } : {}),
          }),
        )
        yield* Effect.logDebug("extension.actor.spawned").pipe(
          Effect.annotateLogs({
            extensionId: spec.extensionId,
            sessionId,
            lifecycleStatus,
            restartCount,
          }),
        )
        return { ref: spawnExit.value, actor: spec.actor }
      })

    const restartActor = (
      sessionId: SessionId,
      branchId: BranchId | undefined,
      entry: ActorEntry,
      error: string,
    ): Effect.Effect<ActorEntry | undefined> =>
      Effect.gen(function* () {
        const currentStatus = yield* getActorStatus(sessionId, entry.ref.id)
        const currentRestartCount =
          currentStatus !== undefined && "restartCount" in currentStatus
            ? (currentStatus.restartCount ?? 0)
            : 0
        const actorBranchId = branchId ?? currentStatus?.branchId
        yield* stopActor(entry)

        if (currentRestartCount >= ACTOR_RESTART_LIMIT) {
          yield* replaceReadyEntry(sessionId, entry.ref.id, undefined)
          yield* markActorFailed(
            entry.ref.id,
            sessionId,
            actorBranchId,
            error,
            "runtime",
            currentRestartCount,
          )
          return undefined
        }

        const spec = params.spawnByExtension.get(entry.ref.id)
        if (spec === undefined) {
          yield* replaceReadyEntry(sessionId, entry.ref.id, undefined)
          yield* markActorFailed(
            entry.ref.id,
            sessionId,
            actorBranchId,
            `extension "${entry.ref.id}" cannot be restarted: spawn spec missing`,
            "runtime",
            currentRestartCount,
          )
          return undefined
        }

        const restarted = yield* spawnActorEntry(
          spec,
          sessionId,
          actorBranchId,
          "restarting",
          "runtime",
          currentRestartCount + 1,
        )
        yield* replaceReadyEntry(sessionId, entry.ref.id, restarted)
        return restarted
      })

    const getOrSpawnActors: MachineLifecycle["getOrSpawnActors"] = (sessionId, branchId) =>
      Effect.withSpan("MachineEngine.spawnWorkflows")(
        Effect.gen(function* () {
          const result = yield* spawnSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const existing = (yield* Ref.get(actorsRef)).get(sessionId)
              if (existing !== undefined) return existing
              const gate = yield* Deferred.make<ActorEntry[]>()
              const slot: ActorSlot = { _tag: "pending", gate }
              yield* Ref.update(actorsRef, (current) => {
                const next = new Map(current)
                next.set(sessionId, slot)
                return next
              })
              return { _tag: "owner" as const, gate }
            }),
          )

          if ("entries" in result && result._tag === "ready") return result.entries
          if ("gate" in result && result._tag === "pending") {
            return yield* Deferred.await(result.gate)
          }

          const gate = result.gate
          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              const entries: ActorEntry[] = []
              for (const spec of params.spawnSpecs) {
                const entry = yield* spawnActorEntry(
                  spec,
                  sessionId,
                  branchId,
                  "starting",
                  "start",
                  0,
                )
                if (entry !== undefined) entries.push(entry)
              }
              return entries
            }),
          )

          const entries =
            exit._tag === "Success"
              ? exit.value
              : yield* Effect.logWarning("extension.spawn.session.failed").pipe(
                  Effect.annotateLogs({
                    sessionId,
                    error: formatCause(exit.cause),
                  }),
                  Effect.as([] as ActorEntry[]),
                )

          yield* Ref.update(actorsRef, (current) => {
            const next = new Map(current)
            next.set(sessionId, { _tag: "ready", entries })
            return next
          })
          yield* Effect.logDebug("extension.actors.session.ready").pipe(
            Effect.annotateLogs({
              sessionId,
              requested: params.spawnSpecs.length,
              spawned: entries.length,
              spawnedIds: entries.map((entry) => entry.ref.id).join(", "),
              failedIds: params.spawnSpecs
                .filter((spec) => !entries.some((entry) => entry.ref.id === spec.extensionId))
                .map((spec) => spec.extensionId)
                .join(", "),
            }),
          )
          yield* Deferred.succeed(gate, entries)
          return entries
        }),
      ) as Effect.Effect<ActorEntry[]>

    const runSupervised: MachineLifecycle["runSupervised"] = (
      sessionId,
      branchId,
      entry,
      operation,
      run,
    ) =>
      Effect.gen(function* () {
        let current = entry
        while (true) {
          const exit = yield* Effect.exit(run(current.ref))
          if (exit._tag === "Success") {
            return { _tag: "success", value: exit.value } as const
          }

          const protocol = getProtocolFailure(exit.cause)
          if (protocol !== undefined) {
            return { _tag: "protocol", error: protocol } as const
          }

          const error = formatCause(exit.cause)
          yield* Effect.logWarning("extension.actor.runtime.failed").pipe(
            Effect.annotateLogs({
              extensionId: current.ref.id,
              sessionId,
              branchId,
              operation,
              error,
            }),
          )
          const restarted = yield* restartActor(sessionId, branchId, current, error)
          if (restarted === undefined) {
            return { _tag: "terminal", error } as const
          }
          current = restarted
        }
      })

    const getActorStatuses: MachineLifecycle["getActorStatuses"] = (sessionId) =>
      Ref.get(actorStatusesRef).pipe(
        Effect.map((current) => [...(current.get(sessionId) ?? new Map()).values()]),
      )

    const terminateActors: MachineLifecycle["terminateActors"] = (sessionId) =>
      Effect.gen(function* () {
        const slot = (yield* Ref.get(actorsRef)).get(sessionId)
        if (slot !== undefined && slot._tag === "ready") {
          for (const entry of slot.entries) {
            yield* stopActor(entry)
          }
        }

        yield* Ref.update(actorsRef, (current) => {
          const next = new Map(current)
          next.delete(sessionId)
          return next
        })
        yield* Ref.update(actorStatusesRef, (current) => {
          const next = new Map(current)
          next.delete(sessionId)
          return next
        })
      })

    return {
      getOrSpawnActors,
      runSupervised,
      getActorStatuses,
      terminateActors,
    }
  })
